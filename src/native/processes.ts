import type { ChildProcess } from 'node:child_process'
import type { MetadataProcessOptions } from '../shared/metadata-process.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../shared/process-ownership.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, openSync, rmSync, writeSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { processTableOutputLimit, readMetadataProcess, readMetadataProcessAsync } from '../shared/metadata-process.ts'
import { OwnedProcessGroup, sameProcessIdentity } from '../shared/process-ownership.ts'
import { NativeOutputLines } from './output.ts'

// Each launched native process has an ownership ledger. Descendants are recorded only through verified launch
// ancestry; every signal rechecks their start reading and, where `ps` can read it, their command. Unknown group
// members are never signaled. The readings behind the ledger are taken without blocking the main thread, except in
// an exit hook, which cannot wait.

/**
 * The macOS tools the native driver runs, by name or by path, and the environment variables none of them may see, such
 * as the ones AI judges' credentials are read from. Tests point the tools at fakes.
 */
export type NativeTools = {
  readonly xcrun: string
  readonly xcodebuild: string
  readonly plutil: string
  readonly git: string
  readonly codesign: string
  readonly ps: string
  readonly lsappinfo: string
  readonly swVers: string
  readonly automationModeTool: string
  readonly osascript: string
  readonly screencapture: string
  readonly lsof: string
  readonly lockf: string
  readonly hiddenVariables?: readonly string[] | undefined
  readonly redact?: ((text: string) => string) | undefined
}

/** The tools as macOS installs them. */
export const systemTools: NativeTools = {
  xcrun: '/usr/bin/xcrun',
  xcodebuild: '/usr/bin/xcodebuild',
  plutil: '/usr/bin/plutil',
  git: '/usr/bin/git',
  codesign: '/usr/bin/codesign',
  ps: '/bin/ps',
  lsappinfo: '/usr/bin/lsappinfo',
  swVers: '/usr/bin/sw_vers',
  automationModeTool: '/usr/bin/automationmodetool',
  osascript: '/usr/bin/osascript',
  screencapture: '/usr/sbin/screencapture',
  lsof: '/usr/sbin/lsof',
  lockf: '/usr/bin/lockf',
}

/**
 * How a short command ended: its exit, what it printed, and whether Retest ended it because its time ran out or it
 * was stopped. `stdout` and `stderr` are cut at `outputLimit` characters each.
 */
export type CommandResult = ProcessExit & {
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
  readonly stopped: boolean
  /** False when the command never started: it was stopped first, or it could not be run. */
  readonly started: boolean
  /** Failures to end recorded processes or confirm their output closed. */
  readonly cleanupProblems: readonly string[]
}

/** Where and how a short command runs. */
export type CommandOptions = {
  /** Host process readings and signals; tests supply a stand-in host. */
  readonly ownershipSystem?: ProcessOwnershipSystem
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  readonly cwd?: string | undefined
  /** Added to this process's environment. */
  readonly environment?: Readonly<Record<string, string>> | undefined
  /** Variables of this process the command must not see. */
  readonly hiddenVariables?: readonly string[] | undefined
  readonly redact?: ((text: string) => string) | undefined
  /** How long the command gets to end after SIGTERM before SIGKILL; `terminationGraceMs` unless given. */
  readonly graceMs?: number | undefined
}

/**
 * The environment a tool runs with: this process's, without the hidden variables, without any `TEST_RUNNER_` variable,
 * which xcodebuild would pass on to the executor's runner, and without any `SIMCTL_CHILD_` variable, which simctl would
 * pass on to an app it launches; with `added` on top.
 *
 * @example childEnvironment({ TEST_RUNNER_USE_PORT: '51815' }, ['RETEST_EVALUATION_OPENAI_KEY'])
 */
export function childEnvironment(added: Readonly<Record<string, string>> | undefined, hidden: readonly string[] | undefined): Record<string, string> {
  const hide = new Set(hidden)
  const kept: Record<string, string> = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !hide.has(name) && !name.startsWith('TEST_RUNNER_') && !name.startsWith('SIMCTL_CHILD_')) kept[name] = value
  }
  return { ...kept, ...added }
}

/** How long a group gets to end after SIGTERM before it is sent SIGKILL. */
export const terminationGraceMs = 2000

// simctl's device list is about 100 KB; nothing the driver reads is near this.
const outputLimit = 16 * 1024 * 1024
const pollMs = 25

/**
 * Runs a command to its end in a process group of its own and keeps what it printed. It never throws for a non-zero
 * exit or a command that cannot start (exit 127); the caller reads the result. At the deadline, or once `signal`
 * aborts, freshly verified recorded pids receive SIGTERM and, after the command's grace, SIGKILL. Unknown survivors fail cleanup.
 *
 * @example (await runCommand('/usr/bin/xcodebuild', ['-version'], { timeoutMs: 10_000 })).stdout // 'Xcode 26.5\nBuild version 17F42\n'
 */
export async function runCommand(command: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> {
  if (options.signal?.aborted === true) return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, stopped: true, started: false, cleanupProblems: [] }
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: childEnvironment(options.environment, options.hiddenVariables),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = { stdout: '', stderr: '' }
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    if (output.stdout.length < outputLimit) output.stdout += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    if (output.stderr.length < outputLimit) output.stderr += chunk
  })
  const group = new GroupGuard(child, options.ownershipSystem)
  const graceMs = options.graceMs ?? terminationGraceMs
  let started = false
  child.once('spawn', () => {
    started = true
  })
  let processExit: ProcessExit | undefined
  child.once('exit', (code, signal) => { processExit = { code, signal } })
  const abandoned = Promise.withResolvers<ProcessExit>()
  const outputProblems: string[] = []
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }))
    child.once('error', (error) => {
      output.stderr += errorMessage(error)
      resolve({ code: 127, signal: null })
    })
  })
  let ending: 'timeout' | 'stop' | undefined
  const end = (reason: 'timeout' | 'stop'): void => {
    ending ??= reason
    void group.end(graceMs).then(async () => {
      const outputClosed = await Promise.race([closed.then(() => true), sleep(1000, false)])
      if (!outputClosed) {
        outputProblems.push('The native command output did not confirm closure after cleanup; capture was stopped.')
        child.stdout.destroy()
        child.stderr.destroy()
      }
      abandoned.resolve(processExit ?? { code: null, signal: null })
    })
  }
  const timer = setTimeout(() => end('timeout'), Math.min(maxTimeout, Math.max(1, options.timeoutMs)))
  const onAbort = (): void => end('stop')
  // The first ownership reading ran since the check above; a stand-in host's reading is the caller's code, which may
  // abort the signal before this listener exists.
  whenAborted(options.signal, onAbort)
  try {
    const exit = await Promise.race([closed, abandoned.promise])
    await group.end(graceMs)
    const cleanupProblems = [...new Set([...(await group.problems()), ...outputProblems])]
    const code = exit.code === 0 && (ending !== undefined || cleanupProblems.length > 0) ? 1 : exit.code
    return { ...exit, code, stdout: output.stdout.slice(0, outputLimit), stderr: output.stderr.slice(0, outputLimit), timedOut: ending === 'timeout', stopped: ending === 'stop', started, cleanupProblems }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    await group.release()
  }
}

/** Calls `react` once `signal` aborts, at once when it already has: an abort before the listener was added fires no event. */
function whenAborted(signal: AbortSignal | undefined, react: () => void): void {
  signal?.addEventListener('abort', react, { once: true })
  if (signal?.aborted === true) react()
}

/**
 * The command a result came from and how it ended, for a failure message: its exit, or that Retest ended it.
 *
 * @example describeCommand('xcrun simctl boot', result) // 'xcrun simctl boot ended with exit code 164: Unable to boot device in current state: Booted'
 */
export function describeCommand(name: string, result: CommandResult): string {
  if (result.cleanupProblems.length > 0) return `${name} cleanup_failed: ${result.cleanupProblems.join(' ')}`
  if (result.timedOut) return `${name} did not finish in time and was ended`
  if (result.stopped) return `${name} was stopped`
  const how = result.signal === null ? `exit code ${result.code ?? 'unknown'}` : `signal ${result.signal}`
  const said = result.stderr.trim().split('\n').at(-1)?.slice(0, 300) ?? ''
  return `${name} ended with ${how}${said.length > 0 ? `: ${said}` : ''}`
}

/** What starts a long-running process: its command, where its output goes, and what it adds to the environment. */
export type OwnedProcessOptions = {
  /** Host process readings and signals; tests supply a stand-in host. */
  readonly ownershipSystem?: ProcessOwnershipSystem
  readonly temporaryFolders?: readonly string[]
  readonly command: string
  readonly args: readonly string[]
  readonly logFile: string
  readonly cwd?: string | undefined
  readonly environment?: Readonly<Record<string, string>> | undefined
  readonly hiddenVariables?: readonly string[] | undefined
  readonly redact?: ((text: string) => string) | undefined
}

// How long the temporary folders wait, once the process exited and its output closed, for the rest of its group to go.
// They are deleted then even while unowned or unconfirmed members remain, which are reported, since a result bundle
// can hold what XCTest named its typing activities by.
const temporaryDeletionWaitMs = terminationGraceMs + 1000

/**
 * A long-running process this run started, such as the xcodebuild that hosts an executor, as the leader of a process
 * group of its own with its output in a log file. An exit hook ends only freshly verified recorded pids, and deletes
 * the temporary folders whatever is left.
 */
export class OwnedProcess {
  readonly pid: number
  readonly logFile: string
  /**
   * Settles after the process output closes and its temporary folders are deleted: once the rest of its group is gone,
   * or a short wait later when something of it remains.
   */
  readonly exited: Promise<ProcessExit>
  readonly #group: GroupGuard
  readonly #problems: string[] = []
  readonly #processExited: Promise<ProcessExit>
  #exit: ProcessExit | undefined
  #stopping: Promise<string[]> | undefined

  /** Starts the command; rejects when it cannot start or its log cannot be opened. */
  static async start(options: OwnedProcessOptions): Promise<OwnedProcess> {
    await mkdir(dirname(options.logFile), { recursive: true })
    const log = openSync(options.logFile, 'a', 0o600)
    let child: ChildProcess
    try {
      child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: childEnvironment(options.environment, options.hiddenVariables),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      try { closeSync(log) }
      catch (cleanup) { throw new Error(`${errorMessage(error)} cleanup_failed: Could not close the native log: ${errorMessage(cleanup)}`, { cause: error }) }
      throw error
    }
    const owned = new OwnedProcess(child, options.logFile, log, options)
    try {
      await once(child, 'spawn')
      return owned
    } catch (error) {
      await owned.exited
      throw error
    }
  }

  constructor(child: ChildProcess, logFile: string, log: number, options: OwnedProcessOptions) {
    if (child.pid === undefined) {
      // A failed spawn still emits close, which releases the log below.
      this.pid = 0
    } else this.pid = child.pid
    this.logFile = logFile
    this.#group = new GroupGuard(child, options.ownershipSystem)
    this.#group.trackDescendants()
    const redact = options.redact ?? ((text: string) => text)
    const write = (text: string): void => {
      try { writeSync(log, text) }
      catch (error) {
        this.#problems.push(`Could not write the native process log: ${redact(errorMessage(error))}`)
        void this.#group.end(terminationGraceMs)
      }
    }
    const outputProblem = (problem: string): void => { this.#problems.push(problem) }
    const stdout = new NativeOutputLines(redact, write, outputProblem)
    const stderr = new NativeOutputLines(redact, write, outputProblem)
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => stdout.push(chunk))
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => stderr.push(chunk))
    // Registered after the group's own hook, so the recorded pids are killed first. The folders go whatever remains:
    // what XCTest left in them must not outlive this process.
    const removeNow = (): void => {
      for (const folder of options.temporaryFolders ?? []) {
        try { rmSync(folder, { recursive: true, force: true }) }
        catch (error) { this.#problems.push(`Could not delete the executor's temporary output: ${redact(errorMessage(error))}`) }
      }
    }
    if ((options.temporaryFolders?.length ?? 0) > 0) process.on('exit', removeNow)
    this.#processExited = new Promise((resolve) => {
      child.once('exit', (code, signal) => { this.#exit = { code, signal }; resolve({ code, signal }) })
      child.once('error', () => resolve({ code: 127, signal: null }))
    })
    this.exited = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        stdout.end()
        stderr.end()
        try { closeSync(log) }
        catch (error) { this.#problems.push(`Could not close the native process log: ${redact(errorMessage(error))}`) }
        this.#exit = { code, signal }
        void this.#group.whenGone(temporaryDeletionWaitMs).then(() => Promise.all((options.temporaryFolders ?? []).map((folder) => rm(folder, { recursive: true, force: true, maxRetries: 2 })))).catch((error: unknown) => {
          this.#problems.push(`Could not delete the executor's temporary output: ${redact(errorMessage(error))}`)
        }).then(() => {
          process.off('exit', removeNow)
          resolve({ code, signal })
        })
      })
    })
  }

  /** Whether recorded or unowned processes may remain, from a fresh reading; a failed reading keeps this true. */
  processesRemain(): Promise<boolean> {
    return this.#group.remains()
  }

  /** How the process ended, or undefined while it runs. */
  get exit(): ProcessExit | undefined {
    return this.#exit
  }

  /** Resolves with how the process ended, or undefined when it still runs after `timeoutMs`. */
  async waitForExit(timeoutMs: number): Promise<ProcessExit | undefined> {
    if (this.#exit !== undefined) return this.#exit
    const timer = new AbortController()
    const expired = sleep(Math.max(0, timeoutMs), undefined, { signal: timer.signal }).catch(() => undefined)
    const exit = await Promise.race([this.#processExited, expired])
    timer.abort()
    return exit
  }

  /** Waits for both output pipes to close and temporary executor files to be deleted. */
  async finishOutput(timeoutMs: number): Promise<string[]> {
    const timer = new AbortController()
    const expired = sleep(Math.max(1, timeoutMs), false, { signal: timer.signal }).catch(() => false)
    const done = await Promise.race([this.exited.then(() => true), expired])
    timer.abort()
    const groupProblems = await this.#group.problems()
    return done ? [...new Set([...groupProblems, ...this.#problems])] : [...new Set([...groupProblems, ...this.#problems, 'The native executor processes or output pipes remain; temporary output deletion is not confirmed.'])]
  }

  /**
   * Waits up to `graceMs` for the process to exit, then sends SIGTERM and SIGKILL only to freshly verified recorded
   * pids. An optional cleanup deadline bounds those checks and output settlement, separately from the grace before
   * forcing exit. Unknown survivors remain held. A second call waits for the first cleanup and its failures.
   */
  stop(graceMs: number, deadline?: Deadline): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs, deadline)
    return this.#stopping
  }

  async #stop(graceMs: number, deadline?: Deadline): Promise<string[]> {
    await this.waitForExit(deadline === undefined ? graceMs : Math.min(graceMs, deadline.remainingMs))
    await this.#group.end(terminationGraceMs, deadline)
    const outputProblems = await this.finishOutput(deadline?.commandTimeoutMs ?? 1000)
    await this.#group.release()
    return [...new Set([...(await this.#group.problems()), ...outputProblems, ...this.#problems])]
  }
}

// How often a long-running executor's descendants are looked for between its start and its stop. Each look is a `ps`
// child this process does not wait on, so it costs the main thread only the parsing; a descendant still under its
// launch ancestry at a stop is found by the stop's own reading.
const descendantPollMs = 2000

/** Owns only a launched process and descendants whose launch ancestry was observed while still verified. */
class GroupGuard {
  readonly #child: ChildProcess
  readonly #owner: OwnedProcessGroup | undefined
  // The readings behind the ledger; absent when the caller supplied a stand-in host, which reads for itself.
  readonly #table: ProcessTable | undefined
  readonly #initial: Promise<readonly string[]>
  readonly #problems = new Set<string>()
  readonly #identityRefusals = new Set<string>()
  readonly #lastResort: () => void
  #tracking: ReturnType<typeof setInterval> | undefined
  #looking = false
  #hooked = false
  #ending: Promise<void> | undefined
  // A reading proved no recorded or unowned process remains; the ledger never names these pids again.
  #gone = false
  #exited = false
  #outputClosed = false

  constructor(child: ChildProcess, system?: ProcessOwnershipSystem) {
    this.#child = child
    this.#table = system === undefined ? new ProcessTable() : undefined
    const owner = child.pid === undefined ? undefined : new OwnedProcessGroup(child.pid, process.pid, system ?? this.#table)
    this.#owner = owner
    this.#initial = owner === undefined ? Promise.resolve([]) : this.#reading(() => owner.capture())
    this.#exited = child.exitCode !== null || child.signalCode !== null
    child.once('exit', () => { this.#exited = true; void this.release() })
    child.once('close', () => { this.#outputClosed = true; void this.release() })
    this.#lastResort = () => {
      // An exit hook cannot wait, so this reading blocks; it never signals an unrecorded pid or a numeric group.
      this.#owner?.signalNow('SIGKILL')
    }
    if (this.#owner !== undefined) {
      process.on('exit', this.#lastResort)
      this.#hooked = true
    }
  }

  // Runs one synchronous ownership step on a reading taken for it without blocking. A stand-in host reads itself.
  #reading<T>(work: () => T): Promise<T> {
    return this.#table === undefined ? Promise.resolve(work()) : this.#table.during(work)
  }

  /** Long-running executors retain observed descendants before they can leave their launch ancestry. */
  trackDescendants(): void {
    if (this.#owner === undefined || this.#tracking !== undefined) return
    this.#tracking = setInterval(() => { void this.#look() }, descendantPollMs)
    this.#tracking.unref()
  }

  async #look(): Promise<void> {
    if (this.#looking) return
    this.#looking = true
    try {
      await this.#capture()
      await this.release()
    } finally {
      this.#looking = false
    }
  }

  async #capture(): Promise<void> {
    const owner = this.#owner
    if (owner === undefined || this.#gone) return
    await this.#initial
    for (const problem of await owner.captureAsync()) this.#problems.add(problem)
  }

  /** Whether recorded or unowned processes may remain, from a fresh reading; a failed reading keeps this true. */
  async remains(deadline?: Deadline): Promise<boolean> {
    const owner = this.#owner
    if (owner === undefined || this.#gone) return false
    await this.#initial
    const remains = await owner.remainsAsync(deadline)
    if (!remains) this.#gone = true
    return remains
  }

  async problems(): Promise<string[]> {
    const initialProblems = await this.#initial
    const free = this.#exited && this.#outputClosed && !(await this.remains())
    const initial = this.#owner?.initialProcessAbsent === true && free ? [] : initialProblems
    // A skipped signal is settled only by confirmed exit, closed output and a fresh proof that every process is
    // gone. Failed readings and failed signals remain failures even after that proof.
    return [...new Set([...initial, ...this.#problems, ...(this.#owner?.readProblems ?? []), ...(free ? [] : this.#identityRefusals)])]
  }

  async #signal(signal: NodeJS.Signals, deadline: Deadline): Promise<void> {
    const owner = this.#owner
    if (owner === undefined) return
    const report = await owner.signalReportAsync(signal, deadline)
    for (const problem of report.problems) this.#problems.add(problem)
    for (const refusal of report.identityRefusals) this.#identityRefusals.add(refusal)
  }

  /** Ends freshly verified recorded pids only; an unrecorded survivor keeps cleanup failed and the exit hook. */
  end(graceMs: number, deadline?: Deadline): Promise<void> {
    this.#ending ??= this.#end(graceMs, deadline)
    return this.#ending
  }

  async #end(graceMs: number, caller?: Deadline): Promise<void> {
    if (this.#owner === undefined) return
    const deadline = caller ?? new Deadline(Math.min(maxTimeout, graceMs + 2000))
    if (!(await this.remains(deadline))) { await this.release(); return }
    await this.#signal('SIGTERM', deadline)
    if (!(await this.#endsWithin(new Deadline(graceMs), deadline))) {
      await this.#signal('SIGKILL', deadline)
      if (!(await this.#endsWithin(new Deadline(1000), deadline))) this.#problems.add(`Recorded or unowned processes of native launch ${this.#child.pid} could not be confirmed stopped.`)
    }
    await this.release()
  }

  async #endsWithin(wait: Deadline, deadline: Deadline): Promise<boolean> {
    while (!deadline.reached) {
      if (!(await this.remains(deadline))) return true
      if (wait.reached || deadline.reached) return false
      await sleep(Math.min(pollMs, wait.remainingMs, deadline.remainingMs))
    }
    return false
  }

  /**
   * Resolves true once no recorded or unowned process remains, or false once `timeoutMs` passed first; descendants seen
   * meanwhile are recorded.
   */
  async whenGone(timeoutMs: number): Promise<boolean> {
    const deadline = new Deadline(timeoutMs)
    // This window bounds polling for temporary-output deletion, not a complete ownership query. Each reading has
    // its own bounded metadata query; its real failure remains recorded. A short polling window must not cancel an
    // otherwise valid reading and poison the runtime's longer cleanup budget.
    while (!deadline.expired) {
      if (!(await this.remains())) { await this.release(); return true }
      if (deadline.expired) return false
      await this.#capture()
      if (deadline.expired) return false
      await sleep(Math.min(pollMs, deadline.remainingMs), undefined, { ref: false })
    }
    return false
  }

  /** Takes the exit hook and watcher away only after a successful host reading proves the launch is free. */
  async release(): Promise<void> {
    if (!this.#hooked || !this.#exited) return
    if (await this.remains()) return
    if (!this.#hooked) return
    process.off('exit', this.#lastResort)
    clearInterval(this.#tracking)
    this.#hooked = false
  }
}

const tableColumns = 'pid=,ppid=,pgid=,stat=,lstart=,args='
const tableEnvironment: Readonly<Record<string, string>> = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' }
// The whole table is read under the bound a whole table may need; one pid under the usual one.
const tableQuery: MetadataProcessOptions = { command: '/bin/ps', args: ['-ww', '-axo', tableColumns], environment: tableEnvironment, outputLimit: processTableOutputLimit }

/**
 * Initial capture shares an awaited snapshot with the synchronous first ownership step. Ordinary cleanup awaits
 * both whole-table and individual identity readings under its caller's deadline. Exit hooks remain synchronous.
 */
class ProcessTable implements ProcessOwnershipSystem {
  #held: { readonly processes: readonly OwnedProcessIdentity[] } | { readonly failure: Error } | undefined

  async during<T>(work: () => T): Promise<T> {
    let held: { readonly processes: readonly OwnedProcessIdentity[] } | { readonly failure: Error }
    try {
      held = { processes: await readProcessTable() }
    } catch (error) {
      held = { failure: error instanceof Error ? error : new Error(String(error)) }
    }
    this.#held = held
    try {
      return work()
    } finally {
      this.#held = undefined
    }
  }

  read(deadline?: Deadline): readonly OwnedProcessIdentity[] {
    const held = this.#held
    if (held === undefined) return parseProcessTable(readMetadataProcess({ ...tableQuery, deadline }))
    if ('failure' in held) throw held.failure
    return held.processes
  }

  readAsync(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
    return readProcessTable(deadline)
  }

  // `ps -p` answers 1 with nothing printed when no listed pid exists, as it does when it fails; listing this process too
  // keeps a reading of an absent pid a successful one.
  readProcess(pid: number, deadline?: Deadline): OwnedProcessIdentity | undefined {
    const text = readMetadataProcess({ command: '/bin/ps', args: ['-ww', '-o', tableColumns, '-p', `${pid},${process.pid}`], environment: tableEnvironment, deadline })
    return parseProcessTable(text).find((entry) => entry.pid === pid)
  }

  async readProcessAsync(pid: number, deadline?: Deadline): Promise<OwnedProcessIdentity | undefined> {
    const text = await readMetadataProcessAsync({ command: '/bin/ps', args: ['-ww', '-o', tableColumns, '-p', `${pid},${process.pid}`], environment: tableEnvironment, deadline })
    return parseProcessTable(text).find((entry) => entry.pid === pid)
  }

  signal(pid: number, signal: NodeJS.Signals | 0): void {
    process.kill(pid, signal)
  }
}

/**
 * Every process on the host as the shared ownership rule reads it: pid, parent, group, state, start and command line,
 * through the shared metadata reader without holding the thread.
 *
 * @example (await readProcessTable()).some((entry) => entry.pid === process.pid) // true
 */
export async function readProcessTable(deadline?: Deadline): Promise<readonly OwnedProcessIdentity[]> {
  // The shared worker does not hold the process open and neither does its asynchronous wait, so a process with nothing
  // else pending would end in the middle of a reading, cleanup included; this timer holds it until the answer.
  const holding = setInterval(() => undefined, 1000)
  try {
    return parseProcessTable(await readMetadataProcessAsync({ ...tableQuery, deadline }))
  } finally {
    clearInterval(holding)
  }
}

// The same reading as the shared ownership rule's, with the start's spacing made one, as every native start reading is.
function parseProcessTable(text: string): readonly OwnedProcessIdentity[] {
  const records: OwnedProcessIdentity[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const fields = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(${startPattern})\\s+(.+)$`).exec(line)
    const [, pid, parentPid, groupId, state, startedAt, command] = fields ?? []
    if (pid === undefined || parentPid === undefined || groupId === undefined || state === undefined || startedAt === undefined || command === undefined) throw new Error('The host returned an unreadable process identity.')
    records.push({ pid: Number(pid), parentPid: Number(parentPid), groupId: Number(groupId), startedAt: oneSpaced(startedAt), command, state })
  }
  if (records.length === 0) throw new Error('The host returned no process identities.')
  return records
}

/**
 * Whether a process with this id exists. Signal 0 checks without sending anything.
 *
 * @example processExists(process.pid) // true
 */
export function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // macOS answers EPERM for a process that exists and belongs to someone else.
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return false
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return true
    throw error
  }
}

/**
 * A process this run started and recorded: its pid, its command line and its start, as `ps` showed them. The pid and
 * the start identify it; the command line tells apart a pid reused within the start reading's second. A record made
 * without a start reading is matched by its exact command alone, as before start readings were kept.
 */
export type RecordedProcess = { readonly pid: number; readonly command: string; readonly startedAt?: string }

/** A recorded process with its start reading, as every record the native driver makes carries. */
export type StartedProcess = RecordedProcess & { readonly startedAt: string }

/** One process as `ps` lists it: its id, its command line and its start. */
export type ListedProcess = StartedProcess

// `ps`'s start reading in the C locale, such as `Mon Oct  5 11:18:31 2026`.
const startPattern = '[A-Za-z]{3}\\s+[A-Za-z]{3}\\s+\\d+\\s+\\d{2}:\\d{2}:\\d{2}\\s+\\d{4}'
const startAndCommand = new RegExp(`^(${startPattern})\\s+(.+)$`)
// Start and command readings are taken in the C locale, so the start is in one form whatever the user's language, and
// without the caller's TZ, so `ps` prints it in the system's time zone, as every reading of the process table does: a
// Every start is read in UTC, including commands whose environment otherwise comes from the caller.
const readingEnvironment: Readonly<Record<string, string>> = { LC_ALL: 'C', TZ: 'UTC0' }

function readingHidden(hidden: readonly string[] | undefined): string[] {
  return [...(hidden ?? []), 'TZ']
}

function oneSpaced(start: string): string {
  return start.replace(/\s+/g, ' ')
}

/**
 * Thrown by `listProcesses` when `ps` gave no list. `timedOut` is true when it did not answer in its time, which says
 * nothing of the processes.
 */
export class ProcessListUnread extends Error {
  readonly timedOut: boolean

  constructor(message: string, timedOut: boolean) {
    super(message)
    this.timedOut = timedOut
  }
}

/**
 * Every process of this user's session as `ps` lists it, with its whole command line and its start.
 *
 * @example (await listProcesses(systemTools, 5000)).some(({ command }) => command.includes('/Devices/'))
 */
export async function listProcesses(tools: NativeTools, timeoutMs: number): Promise<ListedProcess[]> {
  const result = await runCommand(tools.ps, ['-axww', '-o', 'pid=,lstart=,args='], { timeoutMs, environment: readingEnvironment, hiddenVariables: readingHidden(tools.hiddenVariables) })
  if (result.code !== 0) throw new ProcessListUnread(describeCommand('ps', result), result.timedOut)
  // A table cut at the output limit can end inside a line, which would read as a process with a shorter command.
  if (result.stdout.length >= outputLimit) throw new Error(`ps listed more than the ${outputLimit} characters Retest reads of one command, so the list may be cut.`)
  const listed: ListedProcess[] = []
  const line = new RegExp(`^\\s*(\\d+)\\s+(${startPattern})\\s+(.*)$`)
  for (const text of result.stdout.split('\n')) {
    if (text.trim() === '') continue
    const [, pid, startedAt, command] = line.exec(text) ?? []
    const id = Number(pid)
    if (pid === undefined || startedAt === undefined || command === undefined || command.trim() === '' || !Number.isSafeInteger(id) || id < 0) throw new Error('ps returned an unreadable process entry.')
    if (id !== process.pid) listed.push({ pid: id, command, startedAt: oneSpaced(startedAt) })
  }
  return listed
}

/** What `ps` shows of one pid: a process with its command line and start, no process, or nothing it could read. */
export type ProcessPresence = { readonly state: 'present'; readonly command: string; readonly startedAt: string } | { readonly state: 'absent' } | { readonly state: 'unreadable'; readonly problem: string }

/**
 * What runs under one pid now, as `ps` shows it. A reading that timed out, or failed for another reason than the pid
 * being free, is unreadable, never taken for a process that is gone.
 *
 * @example await commandOf(systemTools, 4242) // { state: 'present', command: '/…/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner', startedAt: 'Mon Oct 5 11:18:31 2026' }
 */
export async function commandOf(tools: NativeTools, pid: number, timeoutMs = 10_000): Promise<ProcessPresence> {
  const result = await runCommand(tools.ps, ['-ww', '-o', 'lstart=,args=', '-p', String(pid)], { timeoutMs, environment: readingEnvironment, hiddenVariables: readingHidden(tools.hiddenVariables) })
  const text = result.stdout.trim()
  if (result.code === 0 && !result.timedOut && !result.stopped && text.length > 0) {
    const [, startedAt, command] = startAndCommand.exec(text) ?? []
    if (startedAt !== undefined && command !== undefined) return { state: 'present', command, startedAt: oneSpaced(startedAt) }
    return { state: 'unreadable', problem: `ps showed pid ${pid} in a form Retest cannot read.` }
  }
  // ps answers 1 and prints nothing, not even to stderr, when no process has the pid.
  if (result.code === 1 && text.length === 0 && result.stderr.trim().length === 0 && result.cleanupProblems.length === 0 && !result.timedOut && !result.stopped) return { state: 'absent' }
  return { state: 'unreadable', problem: describeCommand('ps', result) }
}

let ownStart: Promise<string> | undefined

/**
 * This process's own start, read once by the system's `ps` whatever `ps` a caller supplies: a stand-in host lists the
 * processes it plays, never the one asking. A reading that fails is tried again next time.
 *
 * @example await readOwnStart(['RETEST_EVALUATION_OPENAI_KEY']) // 'Mon Oct 5 11:18:31 2026'
 */
export function readOwnStart(hiddenVariables?: readonly string[]): Promise<string> {
  const reading = ownStart ?? commandOf({ ...systemTools, hiddenVariables }, process.pid).then((presence) => {
    if (presence.state !== 'present') throw new Error(`Retest could not read its own start (${presence.state === 'unreadable' ? presence.problem : 'ps did not list it'}).`)
    return presence.startedAt
  })
  ownStart = reading
  reading.catch(() => { if (ownStart === reading) ownStart = undefined })
  return reading
}

/**
 * How a fresh reading of a pid stands to a record, by the shared rule: `same` when it is the recorded process, `other`
 * when another process has the pid, `unreadable` when the reading cannot say. With start readings on both, the pid and
 * the start decide and two readable command lines must agree; a command `ps` could not read, as while the process
 * exits, is neither a match nor a difference. A record without a start is matched by its exact command alone, so an
 * unreadable command leaves it undecided.
 *
 * @example recordedIdentity(runnerApp, { pid: runnerApp.pid, command: '(WebDriverAgentRu)', startedAt: runnerApp.startedAt }) // 'same'
 */
export function recordedIdentity(record: RecordedProcess, current: RecordedProcess): 'same' | 'other' | 'unreadable' {
  if (record.pid !== current.pid) return 'other'
  if (record.startedAt !== undefined) {
    if (current.startedAt === undefined) return 'unreadable'
    return sameProcessIdentity(asIdentity(record, record.startedAt), asIdentity(current, current.startedAt)) ? 'same' : 'other'
  }
  if (commandUnreadable(current.command)) return 'unreadable'
  return current.command === record.command ? 'same' : 'other'
}

// The shared rule compares pid, start and command; a parent and a group are not part of who a process is.
function asIdentity(process: RecordedProcess, startedAt: string): OwnedProcessIdentity {
  return { pid: process.pid, parentPid: 0, groupId: 0, startedAt, command: process.command }
}

// Whether `ps` printed the kernel's short name in place of the arguments, as it does while a process exits. The shared
// rule keeps that test to itself: to it, two readings of one birth whose commands are '' and `command` are one process
// only when `command` is such a name, since no readable command line is empty.
function commandUnreadable(command: string): boolean {
  const birth = { pid: 0, parentPid: 0, groupId: 0, startedAt: '' }
  return command !== '' && sameProcessIdentity({ ...birth, command: '' }, { ...birth, command })
}

/**
 * Ends one recorded process, and only while it is still the recorded one by `recordedIdentity`: checked before the
 * SIGTERM, and again before the SIGKILL that follows after `graceMs`, so a pid freed and given to another process
 * meanwhile is left alone. `gone`: no process had the pid; `other`: another process has it now; `unreadable`: `ps`
 * could not say, which includes a process shown without its command line when the record holds no start.
 *
 * @example await endRecorded(systemTools, runnerApp, 5000) // 'ended'
 */
export async function endRecorded(tools: NativeTools, record: RecordedProcess, graceMs: number): Promise<EndOutcome> {
  if (!Number.isSafeInteger(record.pid) || record.pid < 2 || typeof record.command !== 'string' || record.command.trim().length === 0) return { unreadable: 'The recorded process needs a valid positive pid and a nonempty command.' }
  try {
    const first = await commandOf(tools, record.pid)
    if (first.state === 'absent') return 'gone'
    if (first.state === 'unreadable') return { unreadable: first.problem }
    const identity = recordedIdentity(record, { pid: record.pid, command: first.command, startedAt: first.startedAt })
    if (identity === 'other') return 'other'
    if (identity === 'unreadable') return { unreadable: `ps showed pid ${record.pid} without its command line, and the record holds no start to tell it by.` }
    // From here the start reading identifies the process, also for a record made without one.
    const held: StartedProcess = { ...record, startedAt: record.startedAt ?? first.startedAt }
    const terminated = signalProcess(record.pid, 'SIGTERM')
    if (terminated === 'gone') return 'ended'
    if (terminated !== 'sent') return { signalFailed: terminated.problem }
    const deadline = new Deadline(graceMs)
    while (processExists(record.pid) && !deadline.expired) await sleep(Math.min(pollMs, deadline.remainingMs))
    const second = await commandOf(tools, record.pid)
    if (second.state === 'absent') return 'ended'
    if (second.state === 'unreadable') return { unreadable: second.problem }
    if (recordedIdentity(held, { pid: record.pid, command: second.command, startedAt: second.startedAt }) !== 'same') return 'ended'
    const killedSignal = signalProcess(record.pid, 'SIGKILL')
    if (killedSignal === 'gone') return 'ended'
    if (killedSignal !== 'sent') return { signalFailed: killedSignal.problem }
    const killed = new Deadline(1000)
    while (processExists(record.pid) && !killed.expired) await sleep(Math.min(pollMs, killed.remainingMs))
    return processExists(record.pid) ? 'still_running' : 'ended'
  } catch (error) {
    return { unreadable: errorMessage(error) }
  }
}

/** How `endRecorded` ended. */
export type EndOutcome = 'ended' | 'gone' | 'other' | 'still_running' | { readonly unreadable: string } | { readonly signalFailed: string }

/**
 * What `endRecorded` said, as a problem to report, or undefined when nothing of the recorded process is left.
 *
 * @example endProblem(runnerApp, 'still_running') // 'pid 4242 is still running.'
 */
export function endProblem(record: RecordedProcess, outcome: EndOutcome): string | undefined {
  if (outcome === 'ended' || outcome === 'gone' || outcome === 'other') return undefined
  if (outcome === 'still_running') return `pid ${record.pid} is still running.`
  if ('signalFailed' in outcome) return `Retest could not end pid ${record.pid}: ${outcome.signalFailed}`
  return `Retest could not read whether pid ${record.pid} is still running: ${outcome.unreadable}`
}

function signalProcess(pid: number, signal: NodeJS.Signals): 'sent' | 'gone' | { readonly problem: string } {
  if (!Number.isSafeInteger(pid) || pid < 2) return { problem: 'The recorded process pid is not a valid positive pid.' }
  try {
    process.kill(pid, signal)
    return 'sent'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return 'gone'
    return { problem: `${signal} failed: ${errorMessage(error)}` }
  }
}

/** Group presence is refusal evidence only. It never grants authority to signal a group or its members. */
export function groupPresence(pgid: number): 'present' | 'absent' | { readonly unreadable: string } {
  try {
    process.kill(-pgid, 0)
    return 'present'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return 'absent'
    if (error instanceof Error && 'code' in error && error.code === 'EPERM') return 'present'
    return { unreadable: errorMessage(error) }
  }
}

/**
 * Kills each recorded process at once, and only while it is still the recorded one by `recordedIdentity`, so a pid
 * that ended and was given to another process is left alone. `ps` runs without the hidden variables, as every tool
 * does. Meant for an exit hook, which needs synchronous readings.
 *
 * @example process.on('exit', () => killRecordedNow(runnerApps, tools))
 */
export function killRecordedNow(records: Iterable<RecordedProcess>, tools: Pick<NativeTools, 'ps' | 'hiddenVariables'>): void {
  for (const record of records) {
    try {
      if (!Number.isSafeInteger(record.pid) || record.pid < 2 || typeof record.command !== 'string' || record.command.trim().length === 0) continue
      const shown = readMetadataProcess({
        command: tools.ps, args: ['-ww', '-o', 'lstart=,args=', '-p', String(record.pid)],
        environment: { ...childEnvironment(undefined, readingHidden(tools.hiddenVariables)), ...readingEnvironment },
      })
      const [, startedAt, command] = startAndCommand.exec(shown.trim()) ?? []
      if (startedAt === undefined || command === undefined) continue
      if (recordedIdentity(record, { pid: record.pid, command, startedAt: oneSpaced(startedAt) }) === 'same') process.kill(record.pid, 'SIGKILL')
    } catch {
      // Gone already, or never ours to signal; throwing here would replace the exit code Retest chose.
    }
  }
}
