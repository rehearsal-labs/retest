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
import { maxTimeout } from '../protocol/timeouts.ts'
import { errorMessage } from '../protocol/failures.ts'
import { errorCode } from '../shared/error-code.ts'
import { onlyUnreaped, procStats } from '../shared/unreaped-group.ts'
import { OwnedProcessGroup, unverifiedMembersProblem } from '../shared/process-ownership.ts'
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

/**
 * Where a browser's output goes once it starts. `closed` settles once nothing more can arrive and the log is closed.
 * `writersRemain` says whether anything may still write to the output, as a pipe not yet at its end says; without it,
 * only `closed` tells.
 */
export type BrowserOutput = {
  readonly closed: Promise<string[]>
  cancel(): void
  writersRemain?(): boolean
}

const pollMs = 25
/**
 * How long a group may hold processes after its main process exited before `gone` reports it rather than wait on. A
 * process Retest did not record is never signaled, so one that hangs would otherwise hold `gone` and every lease behind it.
 */
const exitedGroupLimitMs = 5 * closeGraceMs
// Once nothing can write to the output any more, what is left is Retest's own queued log writes and the log's close.
const ownWritingLimitMs = 10 * closeGraceMs
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
  readonly #output: BrowserOutput
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

  constructor(child: ChildProcess, profile: string | undefined, pipe: PipeStreams, output: BrowserOutput = { closed: Promise.resolve([]), cancel: () => undefined }, ownership?: OwnedProcessGroup) {
    const { pid } = child
    if (pid === undefined) throw new TypeError('The browser process has no pid')
    this.pid = pid
    this.profile = profile
    this.pipe = pipe
    this.#output = output
    this.outputSettled = output.closed.then(() => undefined)
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
   * Settles once the main process has exited and no process of its group is left, however it ended. Rejects, naming the
   * group, when processes are still there `exitedGroupLimitMs` after the main process exited, as one Retest did not
   * record and so never signals can stay. Its polling holds no Retest process open.
   */
  gone(): Promise<void> {
    if (this.#gone === undefined) {
      this.#gone = this.#awaitGone()
      // Marks the rejection handled for a browser nobody waits on; every caller that awaits `gone` still receives it.
      this.#gone.catch(() => undefined)
    }
    return this.#gone
  }

  async #awaitGone(): Promise<void> {
    await this.exited
    const deadline = new Deadline(exitedGroupLimitMs)
    this.#keep(await this.#ownership.captureAsync(deadline))
    if (!(await groupEnds(this.#ownership, deadline, { ref: false }))) {
      throw new Error(`The browser's process group ${this.pid} still had processes ${exitedGroupLimitMs} ms after its main process exited; processes Retest did not record are never signaled.`)
    }
    if (ownedGroups.get(this.pid) === this.#ownership) ownedGroups.delete(this.pid)
    await this.#output.closed
  }

  /**
   * Reads descendants while their launched parent is still present: when the connection drops and before asking the
   * parent to quit. A helper recorded early is still owned after its parent dies.
   */
  recordDescendants(deadline: Deadline = new Deadline(closeGraceMs)): void {
    this.#keep(this.#ownership.capture(deadline))
  }

  /**
   * `recordDescendants` from a reading taken without holding the thread, as after each new page, whose renderer the
   * browser has just started. A process-table reading takes tens of milliseconds, which a page open would otherwise wait.
   */
  recordDescendantsSoon(): void {
    void this.#ownership.captureAsync().then((problems) => this.#keep(problems), () => undefined)
  }

  #keep(problems: readonly string[]): void {
    for (const problem of problems) if (!this.#ownershipProblems.includes(problem)) this.#ownershipProblems.push(problem)
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
   * cleaned up. `deadline` bounds ownership work, including metadata worker startup and queueing; output retains its
   * separate close bound. Without a caller deadline, ownership has the grace and two close graces to reconcile.
   */
  stop(graceMs: number, deadline: Deadline = new Deadline(Math.min(maxTimeout, graceMs + 2 * closeGraceMs))): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs, deadline)
    return this.#stopping
  }

  // The exit hook is taken away however the stop ends, and put back only while the group is still there, so a host
  // that runs many runs in one process gains no hook for a browser that is gone.
  // A process left alone, as one whose launch could not be traced or one whose identity changed, is a failure only while
  // it may still be there: once the main process has exited and a fresh reading shows the group empty, nothing was
  // left behind, as when the main process was killed from outside and its unrecorded helpers then ended on their own.
  // Failed readings and failed signals stay failures after that proof.
  async #stop(graceMs: number, deadline: Deadline): Promise<string[]> {
    this.#keep(await this.#ownership.captureAsync(deadline))
    const problems: string[] = []
    const leftAlone = new Set(this.#ownershipProblems.filter((problem) => !this.#ownership.readProblems.includes(problem)))
    try {
      if (!(await this.#ended(new Deadline(graceMs), deadline))) {
        const report = await this.#ownership.signalReportAsync('SIGKILL', deadline)
        for (const problem of report.problems) {
          if (problem === unverifiedMembersProblem(this.pid)) leftAlone.add(problem)
          else problems.push(problem)
        }
        for (const refusal of report.identityRefusals) leftAlone.add(refusal)
        if (!(await this.#ended(new Deadline(closeGraceMs), deadline))) {
          problems.push(this.#ownership.readProblems.length === 0
            ? stillThereMessage(this.pid, procStats)
            : `Could not confirm that process group ${this.pid} ended within the browser's cleanup bound.`)
        }
      }
    } catch (error) {
      problems.push(`Could not end process group ${this.pid}: ${errorMessage(error)}`)
    }
    // A host can reach its outer cleanup bound and exit while these awaits are pending. Keep its synchronous
    // profile cleanup hook until the profile has been handled, even after the processes themselves are gone.
    try {
      const shownGone = this.#exit !== undefined && !(await this.#ownership.remainsAsync(deadline))
      if (!shownGone) problems.unshift(...leftAlone)
      problems.push(...await outputWithin(this.#output, closeGraceMs))
      const { profile } = this
      if (profile !== undefined && !(await this.#ownership.remainsAsync(deadline))) {
        await rm(profile, { recursive: true, force: true, maxRetries: 3 }).catch((error: unknown) => {
          problems.push(`Could not remove the browser profile ${profile}: ${errorMessage(error)}`)
        })
      }
    } finally {
      // Keep the hook installed during the awaited reading too, so an exiting host can still clean this profile.
      const remains = await this.#ownership.remainsAsync(deadline)
      process.off('exit', this.#lastResort)
      if (remains) process.on('exit', this.#lastResort)
      else if (ownedGroups.get(this.pid) === this.#ownership) ownedGroups.delete(this.pid)
    }
    return [...new Set([...problems, ...this.#ownership.readProblems])]
  }

  // The main process has exited and no process of its group is left.
  async #ended(grace: Deadline, deadline: Deadline): Promise<boolean> {
    return (await this.waitForExit(Math.min(grace.remainingMs, deadline.remainingMs))) !== undefined && (await groupEnds(this.#ownership, grace, { deadline }))
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
    let output: BrowserOutput
    if (redact !== undefined || redactStream !== undefined) {
      const streams = [child.stdout, child.stderr].flatMap((stream) => (stream === null ? [] : [stream]))
      output = {
        ...writeRedactedLog(streams, log, redact ?? ((text) => text), redactStream),
        // A pipe reaches its end only once every process holding its write end, inside the group or not, has let go.
        writersRemain: () => streams.some((stream) => !stream.readableEnded && !stream.destroyed),
      }
      logHandedOn = true
    } else {
      output = {
        closed: waitForOwnedExit(child, ownership).then(() => [], (error: unknown) => [errorMessage(error)]),
        cancel: () => undefined,
        // The output goes straight to the log file, so only the group's own processes write it.
        writersRemain: () => ownership.remains(new Deadline(closeGraceMs)),
      }
    }
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

/**
 * Waits for the output to close. A timer can fire before I/O that is already waiting has been read, when the main thread
 * was busy with other work such as synchronous process readings, so the clock alone is no proof the output is still
 * open: on a busy host every healthy close failed so. When the bound passes, waiting I/O is read first, then the output
 * is judged by whether anything can still write to it. Once nothing can, Retest's own writing gets its own bound.
 */
async function outputWithin(output: BrowserOutput, timeoutMs: number): Promise<string[]> {
  const first = await settledWithin(output.closed, timeoutMs)
  if (first !== undefined) return first
  await ioTurns(2)
  const late = await settledWithin(output.closed, 0)
  if (late !== undefined) return late
  if (output.writersRemain?.() === false) {
    const written = await settledWithin(output.closed, ownWritingLimitMs)
    if (written !== undefined) return written
    output.cancel()
    return [`Retest did not finish writing and closing the browser's log within ${ownWritingLimitMs} ms after its output ended.`]
  }
  output.cancel()
  return [`The browser's redacted output did not finish writing and closing within ${timeoutMs} ms.`]
}

// What `promise` settled with within `timeoutMs`, or undefined. One that settled meanwhile wins over the timer.
async function settledWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let settled: { value: T } | undefined
  void promise.then((value) => { settled = { value } }, () => undefined)
  const timer = new AbortController()
  const expired = sleep(timeoutMs, undefined, { signal: timer.signal }).then(() => undefined, () => undefined)
  const result = await Promise.race([promise.then((value) => ({ value })), expired])
  timer.abort()
  return (result ?? settled)?.value
}

// Lets the event loop read I/O that was already waiting, as a `setImmediate` runs only after that read.
async function ioTurns(count: number): Promise<void> {
  for (let turn = 0; turn < count; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function openLog(logFile: string) {
  try {
    await mkdir(dirname(logFile), { recursive: true })
    return await open(logFile, 'a')
  } catch (error) {
    throw new LaunchError(`Cannot open the browser log ${logFile}: ${errorMessage(error)}`, { cause: error })
  }
}

// A fresh reading is taken before the deadline is asked, so a group that ended while the host was busy reads as ended.
async function groupEnds(ownership: OwnedProcessGroup, grace: Deadline, { ref = true, deadline = grace }: { ref?: boolean; deadline?: Deadline } = {}): Promise<boolean> {
  while (await ownership.remainsAsync(deadline)) {
    if (grace.expired || deadline.reached || deadline.signal?.aborted === true) return false
    await sleep(Math.min(pollMs, grace.remainingMs, deadline.remainingMs), undefined, { ref })
  }
  return true
}

// Runs while the Retest process exits, when a failure can neither be awaited nor reported.
function killAtExit(ownership: OwnedProcessGroup, profile: string | undefined): void {
  try {
    const deadline = new Deadline(closeGraceMs)
    ownership.signalNow('SIGKILL', deadline)
    if (profile !== undefined && groupEndsNow(ownership, deadline)) rmSync(profile, { recursive: true, force: true, maxRetries: 3 })
  } catch {
    // Throwing here would replace the exit code Retest chose.
  }
}

// `groupEnds` for an exit hook, which cannot await. Processes just sent SIGKILL are still exiting when `ps` first reads
// them, so the group is read again, a poll apart, until it is gone or the deadline passes.
function groupEndsNow(ownership: OwnedProcessGroup, deadline: Deadline): boolean {
  const pause = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))
  while (ownership.remains(deadline)) {
    if (deadline.expired) return false
    Atomics.wait(pause, 0, 0, Math.min(pollMs, deadline.remainingMs))
  }
  return true
}

async function waitForOwnedExit(child: ChildProcess, ownership: OwnedProcessGroup): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
  const deadline = new Deadline(exitedGroupLimitMs)
  await ownership.captureAsync(deadline)
  if (!(await groupEnds(ownership, deadline, { ref: false }))) {
    throw new Error(`The browser's process group ${child.pid ?? 'unknown'} still had processes ${exitedGroupLimitMs} ms after its main process exited; processes Retest did not record are never signaled.`)
  }
}
