import type { ChildProcess } from 'node:child_process'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { PipeStreams } from './cdp/transport.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { rmSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { errorCode } from '../shared/error-code.ts'
import { onlyUnreaped, procStats } from '../shared/unreaped-group.ts'
import { closeGraceMs, LaunchError } from './contract.ts'

export type StartOptions = {
  executable: string
  args: string[]
  /** A temporary folder that belongs to the process from now on. It is removed when the process stops, or at once if it never starts. */
  profile: string
  /** Receives the browser's stdout and stderr. */
  logFile: string
}

const pollMs = 25

/** A browser process in its own process group, with the temporary profile it owns. */
export class ChromiumProcess {
  readonly pid: number
  readonly profile: string
  /** Chrome reads commands from fd 3 and writes replies to fd 4. */
  readonly pipe: PipeStreams
  /** Settles when the main process exits. */
  readonly exited: Promise<ProcessExit>
  readonly #lastResort: () => void
  #exit: ProcessExit | undefined
  #stopping: Promise<string[]> | undefined

  /**
   * Starts the executable as the leader of a new process group.
   *
   * @example const chromium = await ChromiumProcess.start({ executable, args, profile, logFile })
   */
  static async start(options: StartOptions): Promise<ChromiumProcess> {
    try {
      return await spawnInGroup(options)
    } catch (error) {
      await rm(options.profile, { recursive: true, force: true, maxRetries: 3 }).catch((cleanupError: unknown) => {
        const message = `${errorMessage(error)} Removing the browser profile ${options.profile} also failed: ${errorMessage(cleanupError)}`
        throw new LaunchError(message, { cause: error })
      })
      throw error
    }
  }

  constructor(child: ChildProcess, profile: string, pipe: PipeStreams) {
    const { pid } = child
    if (pid === undefined) throw new TypeError('The browser process has no pid')
    this.pid = pid
    this.profile = profile
    this.pipe = pipe
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.#exit = { code, signal }
        resolve(this.#exit)
      })
    })
    this.#lastResort = () => killAtExit(pid, profile)
    process.on('exit', this.#lastResort)
  }

  /** Resolves with how the process ended, or with undefined if it is still running after `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<ProcessExit | undefined> {
    if (this.#exit !== undefined) return this.#exit
    const timer = new AbortController()
    const expired = sleep(timeoutMs, undefined, { signal: timer.signal }).catch(() => undefined)
    const exit = await Promise.race([this.exited, expired])
    timer.abort()
    return exit
  }

  /**
   * Waits up to `graceMs` for every process in the browser's group to end, kills the group if any is left and
   * waits up to `closeGraceMs` more, then removes the profile. Resolves with what could not be cleaned up.
   */
  stop(graceMs: number): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs)
    return this.#stopping
  }

  // The exit hook is taken away however the stop ends, and put back only while the group is still there, so a host
  // that runs many runs in one process gains no hook for a browser that is gone.
  async #stop(graceMs: number): Promise<string[]> {
    const problems: string[] = []
    try {
      if (!(await this.#ended(new Deadline(graceMs)))) {
        signalGroup(this.pid, 'SIGKILL')
        if (!(await this.#ended(new Deadline(closeGraceMs)))) problems.push(stillThereMessage(this.pid, procStats))
      }
    } catch (error) {
      problems.push(`Could not end process group ${this.pid}: ${errorMessage(error)}`)
    } finally {
      process.off('exit', this.#lastResort)
      if (groupRemains(this.pid)) process.on('exit', this.#lastResort)
    }
    await rm(this.profile, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
      problems.push(`Could not remove the browser profile ${this.profile}: ${errorMessage(error)}`)
    })
    return problems
  }

  // The main process has exited and no process of its group is left.
  async #ended(deadline: Deadline): Promise<boolean> {
    return (await this.waitForExit(deadline.remainingMs)) !== undefined && (await groupEnds(this.pid, deadline))
  }
}

/**
 * What to say of a browser's process group that is still there after SIGKILL. When everything left in it has
 * exited and waits only to be reaped, the fix lies with the process that adopted it, not with the browser.
 *
 * @example stillThereMessage(4242, procStats)
 */
export function stillThereMessage(groupId: number, stats: () => readonly string[]): string {
  const left = `The browser's process group ${groupId} was still there ${closeGraceMs} ms after SIGKILL.`
  if (!onlyUnreaped(groupId, stats)) return left
  return `${left} Its processes have exited, but nothing reaped them. In a container, the first process adopts them and must reap them: start the container with an init, such as docker run --init.`
}

/**
 * Signals every process in a group this run started. Returns false once no process of the group is left.
 *
 * @example signalGroup(browser.pid, 0) // true while any browser process is still there
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, signal)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ESRCH') return false
    // macOS answers EPERM for a group whose last processes have exited but are not yet reaped.
    if (code === 'EPERM') return true
    throw error
  }
}

async function spawnInGroup(options: StartOptions): Promise<ChromiumProcess> {
  const log = await openLog(options.logFile)
  try {
    const child = spawn(options.executable, options.args, {
      detached: true,
      stdio: ['ignore', log.fd, log.fd, 'pipe', 'pipe'],
    })
    await once(child, 'spawn').catch((error: unknown) => {
      throw new LaunchError(`Cannot start ${options.executable}: ${errorMessage(error)}`, { cause: error })
    })
    const [, , , writable, readable] = child.stdio
    if (!(writable instanceof Writable) || !(readable instanceof Readable)) {
      if (child.pid !== undefined) signalGroup(child.pid, 'SIGKILL')
      throw new LaunchError(`Cannot open the debugging pipe to ${options.executable}.`)
    }
    return new ChromiumProcess(child, options.profile, { readable, writable })
  } finally {
    await log.close()
  }
}

async function openLog(logFile: string) {
  try {
    await mkdir(dirname(logFile), { recursive: true })
    return await open(logFile, 'a')
  } catch (error) {
    throw new LaunchError(`Cannot open the browser log ${logFile}: ${errorMessage(error)}`, { cause: error })
  }
}

// A group that cannot be asked about is counted as still there, so its hook stays.
function groupRemains(pgid: number): boolean {
  try {
    return signalGroup(pgid, 0)
  } catch {
    return true
  }
}

async function groupEnds(pgid: number, deadline: Deadline): Promise<boolean> {
  while (signalGroup(pgid, 0)) {
    if (deadline.expired) return false
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
  return true
}

// Runs while the Retest process exits, when a failure can neither be awaited nor reported.
function killAtExit(pgid: number, profile: string): void {
  try {
    signalGroup(pgid, 'SIGKILL')
    rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Throwing here would replace the exit code Retest chose.
  }
}
