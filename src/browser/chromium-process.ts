import type { ChildProcess } from 'node:child_process'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { PipeStreams } from './cdp/transport.ts'
import type { OutputRedactor } from './contract.ts'
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
import { OwnedProcessGroup } from '../shared/process-ownership.ts'
import { closeGraceMs, LaunchError } from './contract.ts'
import { writeRedactedLog } from './redacted-log.ts'

export type StartOptions = {
  executable: string
  args: string[]
  /**
   * A temporary folder that belongs to the process from now on. It is removed when the process stops, or at once if it
   * never starts. Absent for a process whose folder outlives it, as an Electron app's user-data folder does.
   */
  profile?: string
  /** Receives the browser's stdout and stderr. */
  logFile: string
  /** Environment variables the process must not see. */
  hiddenVariables?: readonly string[]
  /**
   * Rewrites each line of the process's output before it reaches the log, as the run's redactor rewrites text, for a
   * process that prints what the app under test was given, as an Electron app's main process can. Without it the
   * output goes to the log as the process wrote it.
   */
  redact?: (text: string) => string
  /** One redaction stream per output pipe, preserving known values across newline boundaries. */
  redactStream?: () => OutputRedactor
}

const pollMs = 25
const ownedGroups = new Map<number, OwnedProcessGroup>()

/** A launch failure that still has cleanup ownership; callers must wait for `gone` before freeing its folder. */
export class ProcessLaunchError extends LaunchError {
  readonly gone: Promise<void>
  readonly outputSettled: Promise<void>
  constructor(message: string, gone: Promise<void>, options?: ErrorOptions & { failureClass?: 'setup_failed' | 'cleanup_failed' }, outputSettled: Promise<void> = gone) {
    super(message, options)
    this.gone = gone
    this.outputSettled = outputSettled
  }
}

/** A browser process in its own process group, with the temporary profile it owns, if it owns one. */
export class ChromiumProcess {
  readonly pid: number
  readonly profile: string | undefined
  /** Chrome reads commands from fd 3 and writes replies to fd 4. */
  readonly pipe: PipeStreams
  /** Settles when the main process exits. */
  readonly exited: Promise<ProcessExit>
  readonly outputSettled: Promise<void>
  readonly #lastResort: () => void
  readonly #outputClosed: Promise<string[]>
  readonly #cancelOutput: () => void
  readonly #ownership: OwnedProcessGroup
  readonly #ownershipProblems: string[] = []
  #exit: ProcessExit | undefined
  #stopping: Promise<string[]> | undefined
  #gone: Promise<void> | undefined

  /**
   * Starts the executable as the leader of a new process group.
   *
   * @example const chromium = await ChromiumProcess.start({ executable, args, profile, logFile })
   */
  static async start(options: StartOptions): Promise<ChromiumProcess> {
    try {
      return await spawnInGroup(options)
    } catch (error) {
      const { profile } = options
      if (profile === undefined || error instanceof ProcessLaunchError) throw error
      await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch((cleanupError: unknown) => {
        const message = `${errorMessage(error)} Removing the browser profile ${profile} also failed: ${errorMessage(cleanupError)}`
        throw new LaunchError(message, { cause: error })
      })
      throw error
    }
  }

  constructor(child: ChildProcess, profile: string | undefined, pipe: PipeStreams, output: { closed: Promise<string[]>; cancel(): void } = { closed: Promise.resolve([]), cancel: () => undefined }, ownership?: OwnedProcessGroup) {
    const { pid } = child
    if (pid === undefined) throw new TypeError('The browser process has no pid')
    this.pid = pid
    this.profile = profile
    this.pipe = pipe
    this.#outputClosed = output.closed
    this.outputSettled = output.closed.then(() => undefined)
    this.#cancelOutput = output.cancel
    this.#ownership = ownership ?? new OwnedProcessGroup(pid)
    ownedGroups.set(pid, this.#ownership)
    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.#exit = { code, signal }
        resolve(this.#exit)
      })
    })
    this.recordDescendants()
    this.#lastResort = () => killAtExit(this.#ownership, profile)
    process.on('exit', this.#lastResort)
  }

  /**
   * Settles once the main process has exited and no process of its group is left, however it ended. Its polling holds
   * no Retest process open.
   */
  gone(): Promise<void> {
    this.#gone ??= this.#awaitGone()
    return this.#gone
  }

  async #awaitGone(): Promise<void> {
    await this.exited
    this.recordDescendants()
    while (this.#ownership.remains()) await sleep(pollMs, undefined, { ref: false })
    if (ownedGroups.get(this.pid) === this.#ownership) ownedGroups.delete(this.pid)
    await this.#outputClosed
  }

  /** Reads descendants while their launched parent is still present, before asking that parent to quit. */
  recordDescendants(): void {
    for (const problem of this.#ownership.capture()) if (!this.#ownershipProblems.includes(problem)) this.#ownershipProblems.push(problem)
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
   * Waits up to `graceMs` for every process in the browser's group to end, kills only recorded processes if any is left and
   * waits up to `closeGraceMs` more, then removes the profile, if it owns one. Resolves with what could not be
   * cleaned up.
   */
  stop(graceMs: number): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs)
    return this.#stopping
  }

  // The exit hook is taken away however the stop ends, and put back only while the group is still there, so a host
  // that runs many runs in one process gains no hook for a browser that is gone.
  async #stop(graceMs: number): Promise<string[]> {
    this.recordDescendants()
    const problems: string[] = [...this.#ownershipProblems]
    try {
      if (!(await this.#ended(new Deadline(graceMs)))) {
        problems.push(...this.#ownership.signal('SIGKILL'))
        if (!(await this.#ended(new Deadline(closeGraceMs)))) problems.push(stillThereMessage(this.pid, procStats))
      }
    } catch (error) {
      problems.push(`Could not end process group ${this.pid}: ${errorMessage(error)}`)
    } finally {
      process.off('exit', this.#lastResort)
      if (this.#ownership.remains()) process.on('exit', this.#lastResort)
      else if (ownedGroups.get(this.pid) === this.#ownership) ownedGroups.delete(this.pid)
    }
    const output = await outputWithin(this.#outputClosed, closeGraceMs, this.#cancelOutput)
    problems.push(...output)
    const { profile } = this
    if (profile !== undefined && !this.#ownership.remains()) {
      await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
        problems.push(`Could not remove the browser profile ${profile}: ${errorMessage(error)}`)
      })
    }
    return [...new Set([...problems, ...this.#ownership.readProblems])]
  }

  // The main process has exited and no process of its group is left.
  async #ended(deadline: Deadline): Promise<boolean> {
    return (await this.waitForExit(deadline.remainingMs)) !== undefined && (await groupEnds(this.#ownership, deadline))
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
 * Asks about a group, or signals its freshly verified recorded owners. A destructive signal needs this process's
 * launch record; a pid supplied by another process is refused. Returns false once no owned process is left.
 *
 * @example signalGroup(browser.pid, 0) // true while any browser process is still there
 */
export function signalGroup(pgid: number, signal: NodeJS.Signals | 0): boolean {
  if (signal !== 0) {
    const owner = ownedGroups.get(pgid)
    if (owner === undefined) throw new Error(`Process group ${pgid} has no recorded launch ownership in this process, so it was not signaled.`)
    const problems = owner.signal(signal)
    if (problems.length > 0) throw new Error(problems.join(' '))
    return owner.remains()
  }
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    const code = errorCode(error)
    if (code === 'ESRCH') return false
    // macOS answers EPERM for a group whose last processes have exited but are not yet reaped.
    if (code === 'EPERM') return true
    throw error
  }
}

/** Signals a descendant only after this process recorded it beneath the launched browser. */
export function signalRecordedProcess(browserPid: number, pid: number, signal: NodeJS.Signals): void {
  const owner = ownedGroups.get(browserPid)?.groupFor(pid)
  if (owner === undefined) throw new Error(`Process ${pid} has no verified launch ownership beneath browser ${browserPid}, so it was not signaled.`)
  const problems = owner.signal(signal)
  if (problems.length > 0) throw new Error(problems.join(' '))
}

async function spawnInGroup(options: StartOptions): Promise<ChromiumProcess> {
  const { redact, redactStream } = options
  const log = await openLog(options.logFile)
  let logHandedOn = false
  try {
    const hidden = new Set(options.hiddenVariables)
    // Output to redact comes through Retest; any other goes straight to the log.
    const outputMode = redact === undefined && redactStream === undefined ? log.fd : 'pipe'
    const child = spawn(options.executable, options.args, {
      env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !hidden.has(name))),
      detached: true,
      stdio: ['ignore', outputMode, outputMode, 'pipe', 'pipe'],
    })
    await once(child, 'spawn').catch((error: unknown) => {
      throw new LaunchError(`Cannot start ${options.executable}: ${errorMessage(error)}`, { cause: error })
    })
    const ownership = new OwnedProcessGroup(child.pid ?? 0)
    const ownershipProblems = ownership.capture()
    const [, , , writable, readable] = child.stdio
    if (!(writable instanceof Writable) || !(readable instanceof Readable)) {
      const problems = [...ownershipProblems, ...ownership.signal('SIGKILL')]
      const lastResort = (): void => killAtExit(ownership, options.profile)
      process.on('exit', lastResort)
      logHandedOn = true
      await log.close().catch((error: unknown) => problems.push(`Could not close the browser log: ${errorMessage(error)}`))
      const gone = waitForOwnedExit(child, ownership).then(async () => {
        if (options.profile !== undefined) await rm(options.profile, { recursive: true, force: true, maxRetries: 3 })
      }).finally(() => { if (!ownership.remains()) process.off('exit', lastResort) })
      void gone.catch(() => undefined)
      throw new ProcessLaunchError(`Cannot open the debugging pipe to ${options.executable}. ${problems.join(' ')}`, gone, { failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' })
    }
    let output: { closed: Promise<string[]>; cancel(): void } = { closed: Promise.resolve([]), cancel: () => undefined }
    if (redact !== undefined || redactStream !== undefined) {
      const streams = [child.stdout, child.stderr].flatMap((stream) => (stream === null ? [] : [stream]))
      output = writeRedactedLog(streams, log, redact ?? ((text) => text), redactStream)
      logHandedOn = true
    } else output = { closed: waitForOwnedExit(child, ownership).then(() => []), cancel: () => undefined }
    const started = new ChromiumProcess(child, options.profile, { readable, writable }, output, ownership)
    if (redact === undefined && redactStream === undefined) {
      logHandedOn = true
      try {
        await log.close()
      } catch (error) {
        const problems = await started.stop(0)
        throw new ProcessLaunchError(`Could not close the browser log: ${errorMessage(error)} ${problems.join(' ')}`, started.gone(), { cause: error, failureClass: 'cleanup_failed' }, started.outputSettled)
      }
    }
    if (ownershipProblems.length > 0) {
      const problems = await started.stop(0)
      throw new ProcessLaunchError(`Could not record the launched browser's ownership: ${[...ownershipProblems, ...problems].join(' ')}`, started.gone(), { failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' }, started.outputSettled)
    }
    return started
  } finally {
    if (!logHandedOn) await log.close()
  }
}

async function outputWithin(closed: Promise<string[]>, timeoutMs: number, cancel: () => void): Promise<string[]> {
  const timer = new AbortController()
  const expired = sleep(timeoutMs, undefined, { signal: timer.signal }).then(() => {
    cancel()
    return [`The browser's redacted output did not finish writing and closing within ${timeoutMs} ms.`]
  }, () => [])
  const problems = await Promise.race([closed, expired])
  timer.abort()
  return problems
}

async function openLog(logFile: string) {
  try {
    await mkdir(dirname(logFile), { recursive: true })
    return await open(logFile, 'a')
  } catch (error) {
    throw new LaunchError(`Cannot open the browser log ${logFile}: ${errorMessage(error)}`, { cause: error })
  }
}

async function groupEnds(ownership: OwnedProcessGroup, deadline: Deadline): Promise<boolean> {
  while (ownership.remains()) {
    if (deadline.expired) return false
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
  return true
}

// Runs while the Retest process exits, when a failure can neither be awaited nor reported.
function killAtExit(ownership: OwnedProcessGroup, profile: string | undefined): void {
  try {
    ownership.signalNow('SIGKILL')
    if (profile !== undefined && !ownership.remains()) rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Throwing here would replace the exit code Retest chose.
  }
}

async function waitForOwnedExit(child: ChildProcess, ownership: OwnedProcessGroup): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  ownership.capture()
  while (ownership.remains()) await sleep(pollMs, undefined, { ref: false })
}
