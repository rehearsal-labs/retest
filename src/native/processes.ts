import type { ChildProcess } from 'node:child_process'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { ProcessOwnershipSystem } from '../shared/process-ownership.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, openSync, rmSync, writeSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { readMetadataProcess } from '../shared/metadata-process.ts'
import { OwnedProcessGroup } from '../shared/process-ownership.ts'
import { NativeOutputLines } from './output.ts'

// Each launched native process has an ownership ledger. Descendants are recorded only through verified launch
// ancestry; every signal rechecks their exact command and start reading. Unknown group members are never signaled.

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
 * aborts, freshly verified recorded pids receive SIGTERM and then SIGKILL. Unknown survivors fail cleanup.
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
    void group.end(terminationGraceMs).then(async () => {
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
    await group.end(terminationGraceMs)
    const cleanupProblems = [...new Set([...group.problems, ...outputProblems])]
    const code = exit.code === 0 && (ending !== undefined || cleanupProblems.length > 0) ? 1 : exit.code
    return { ...exit, code, stdout: output.stdout.slice(0, outputLimit), stderr: output.stderr.slice(0, outputLimit), timedOut: ending === 'timeout', stopped: ending === 'stop', started, cleanupProblems }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    group.release()
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

/**
 * A long-running process this run started, such as the xcodebuild that hosts an executor, as the leader of a process
 * group of its own with its output in a log file. An exit hook ends only freshly verified recorded pids.
 */
export class OwnedProcess {
  readonly pid: number
  readonly logFile: string
  /** Settles after the process output closes and its temporary folders are deleted. */
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
    const removeNow = (): void => {
      if (this.#group.remains) return
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
        this.#group.release()
        void this.#group.whenGone().then(() => Promise.all((options.temporaryFolders ?? []).map((folder) => rm(folder, { recursive: true, force: true })))).catch((error: unknown) => {
          this.#problems.push(`Could not delete the executor's temporary output: ${redact(errorMessage(error))}`)
        }).then(() => {
          process.off('exit', removeNow)
          resolve({ code, signal })
        })
      })
    })
  }

  /** Whether recorded or unowned processes may remain; a failed reading keeps this true. */
  get processesRemain(): boolean {
    return this.#group.remains
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
    return done ? [...new Set([...this.#group.problems, ...this.#problems])] : [...new Set([...this.#group.problems, ...this.#problems, 'The native executor processes or output pipes remain; temporary output deletion is not confirmed.'])]
  }

  /**
   * Waits up to `graceMs` for the process to exit, then sends SIGTERM and SIGKILL only to freshly verified recorded
   * pids. Unknown survivors remain held. A second call waits for the first cleanup and its failures.
   */
  stop(graceMs: number): Promise<string[]> {
    this.#stopping ??= this.#stop(graceMs)
    return this.#stopping
  }

  async #stop(graceMs: number): Promise<string[]> {
    await this.waitForExit(graceMs)
    await this.#group.end(terminationGraceMs)
    const outputProblems = await this.finishOutput(1000)
    this.#group.release()
    return [...new Set([...this.#group.problems, ...outputProblems, ...this.#problems])]
  }
}

/** Owns only a launched process and descendants whose launch ancestry was observed while still verified. */
class GroupGuard {
  readonly #child: ChildProcess
  readonly #owner: OwnedProcessGroup | undefined
  readonly #initialProblems: readonly string[]
  readonly #problems = new Set<string>()
  readonly #identityRefusals = new Set<string>()
  readonly #lastResort: () => void
  #tracking: ReturnType<typeof setInterval> | undefined
  #hooked = false
  #ending: Promise<void> | undefined
  #gone: Promise<void> | undefined
  #exited = false
  #outputClosed = false

  constructor(child: ChildProcess, system?: ProcessOwnershipSystem) {
    this.#child = child
    this.#owner = child.pid === undefined ? undefined : new OwnedProcessGroup(child.pid, process.pid, system)
    this.#initialProblems = this.#owner?.capture() ?? []
    this.#exited = child.exitCode !== null || child.signalCode !== null
    child.once('exit', () => { this.#exited = true; this.release() })
    child.once('close', () => { this.#outputClosed = true; this.release() })
    this.#lastResort = () => {
      // The helper reads host metadata synchronously and never signals an unrecorded pid or a numeric group.
      this.#owner?.signalNow('SIGKILL')
    }
    if (this.#owner !== undefined) {
      process.on('exit', this.#lastResort)
      this.#hooked = true
    }
  }

  /** Long-running executors retain observed descendants before they can leave their launch ancestry. */
  trackDescendants(): void {
    if (this.#owner === undefined || this.#tracking !== undefined) return
    this.#tracking = setInterval(() => { this.#capture(); this.release() }, 100)
    this.#tracking.unref()
  }

  #capture(): void {
    for (const problem of this.#owner?.capture() ?? []) this.#problems.add(problem)
  }

  get remains(): boolean {
    return this.#owner?.remains() ?? false
  }

  get problems(): string[] {
    const free = this.#exited && this.#outputClosed && !this.remains
    const initial = this.#owner?.initialProcessAbsent === true && free ? [] : this.#initialProblems
    // A skipped signal is settled only by confirmed exit, closed output and a fresh proof that every process is
    // gone. Failed readings and failed signals remain failures even after that proof.
    return [...new Set([...initial, ...this.#problems, ...(this.#owner?.readProblems ?? []), ...(free ? [] : this.#identityRefusals)])]
  }

  #signal(signal: NodeJS.Signals): void {
    const report = this.#owner?.signalReport(signal)
    for (const problem of report?.problems ?? []) this.#problems.add(problem)
    for (const refusal of report?.identityRefusals ?? []) this.#identityRefusals.add(refusal)
  }

  /** Ends freshly verified recorded pids only; an unrecorded survivor keeps cleanup failed and the exit hook. */
  end(graceMs: number): Promise<void> {
    this.#ending ??= this.#end(graceMs)
    return this.#ending
  }

  async #end(graceMs: number): Promise<void> {
    const owner = this.#owner
    if (owner === undefined) return
    if (!this.remains) { this.release(); return }
    this.#signal('SIGTERM')
    if (!(await groupEnds(owner, new Deadline(graceMs)))) {
      this.#signal('SIGKILL')
      if (!(await groupEnds(owner, new Deadline(1000)))) this.#problems.add(`Recorded or unowned processes of native launch ${this.#child.pid} could not be confirmed stopped.`)
    }
    this.release()
  }

  /** Output and temporary folders are not free until no recorded or unknown process remains. */
  whenGone(): Promise<void> {
    this.#gone ??= (async () => {
      while (this.remains) {
        this.#capture()
        await sleep(pollMs, undefined, { ref: false })
      }
      this.release()
    })()
    return this.#gone
  }

  /** Takes the exit hook and watcher away only after a successful host reading proves the launch is free. */
  release(): void {
    if (!this.#hooked || !this.#exited || this.remains) return
    process.off('exit', this.#lastResort)
    clearInterval(this.#tracking)
    this.#hooked = false
  }
}

async function groupEnds(owner: OwnedProcessGroup, deadline: Deadline): Promise<boolean> {
  while (owner.remains()) {
    if (deadline.expired) return false
    await sleep(Math.min(pollMs, deadline.remainingMs))
  }
  return true
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

/** One process as `ps` lists it: its id and its command line. */
export type ListedProcess = { readonly pid: number; readonly command: string }

/**
 * Every process of this user's session as `ps` lists it, with its whole command line.
 *
 * @example (await listProcesses(systemTools, 5000)).some(({ command }) => command.includes('/Devices/'))
 */
export async function listProcesses(tools: NativeTools, timeoutMs: number): Promise<ListedProcess[]> {
  const result = await runCommand(tools.ps, ['-axww', '-o', 'pid=,args='], { timeoutMs, hiddenVariables: tools.hiddenVariables })
  if (result.code !== 0) throw new Error(describeCommand('ps', result))
  const listed: ListedProcess[] = []
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const [, pid, command] = match ?? []
    const id = Number(pid)
    if (pid === undefined || command === undefined || command.trim() === '' || !Number.isSafeInteger(id) || id < 0) throw new Error('ps returned an unreadable process entry.')
    if (id !== process.pid) listed.push({ pid: id, command })
  }
  return listed
}

/** A process this run started and recorded: its pid and its exact command line, as `ps` showed it. */
export type RecordedProcess = { readonly pid: number; readonly command: string }

/** What `ps` shows of one pid: a process with its command line, no process, or nothing it could read. */
export type ProcessPresence = { readonly state: 'present'; readonly command: string } | { readonly state: 'absent' } | { readonly state: 'unreadable'; readonly problem: string }

/**
 * What runs under one pid now, as `ps` shows it. A reading that timed out, or failed for another reason than the pid
 * being free, is unreadable, never taken for a process that is gone.
 *
 * @example await commandOf(systemTools, 4242) // { state: 'present', command: '/…/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner' }
 */
export async function commandOf(tools: NativeTools, pid: number, timeoutMs = 10_000): Promise<ProcessPresence> {
  const result = await runCommand(tools.ps, ['-ww', '-o', 'args=', '-p', String(pid)], { timeoutMs, hiddenVariables: tools.hiddenVariables })
  const command = result.stdout.trim()
  if (result.code === 0 && !result.timedOut && !result.stopped && command.length > 0) return { state: 'present', command }
  // ps answers 1 and prints nothing, not even to stderr, when no process has the pid.
  if (result.code === 1 && command.length === 0 && result.stderr.trim().length === 0 && result.cleanupProblems.length === 0 && !result.timedOut && !result.stopped) return { state: 'absent' }
  return { state: 'unreadable', problem: describeCommand('ps', result) }
}

/**
 * Ends one recorded process, and only while its command line is still the recorded one: checked before the SIGTERM,
 * and again before the SIGKILL that follows after `graceMs`, so a pid freed and given to another process meanwhile is
 * left alone. `gone`: no process had the pid; `other`: another process has it now; `unreadable`: `ps` could not say.
 *
 * @example await endRecorded(systemTools, runnerApp, 5000) // 'ended'
 */
export async function endRecorded(tools: NativeTools, record: RecordedProcess, graceMs: number): Promise<EndOutcome> {
  if (!Number.isSafeInteger(record.pid) || record.pid < 2 || typeof record.command !== 'string' || record.command.trim().length === 0) return { unreadable: 'The recorded process needs a valid positive pid and a nonempty command.' }
  try {
    const first = await commandOf(tools, record.pid)
    if (first.state === 'absent') return 'gone'
    if (first.state === 'unreadable') return { unreadable: first.problem }
    if (first.command !== record.command) return 'other'
    const terminated = signalProcess(record.pid, 'SIGTERM')
    if (terminated === 'gone') return 'ended'
    if (terminated !== 'sent') return { signalFailed: terminated.problem }
    const deadline = new Deadline(graceMs)
    while (processExists(record.pid) && !deadline.expired) await sleep(Math.min(pollMs, deadline.remainingMs))
    const second = await commandOf(tools, record.pid)
    if (second.state === 'absent') return 'ended'
    if (second.state === 'unreadable') return { unreadable: second.problem }
    if (second.command !== record.command) return 'ended'
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
 * Kills each recorded process at once, and only while its command line is still the recorded one, so a pid that ended
 * and was given to another process is left alone. `ps` runs without the hidden variables, as every tool does. Meant
 * for an exit hook, which needs synchronous ownership readings.
 *
 * @example process.on('exit', () => killRecordedNow(runnerApps, tools))
 */
export function killRecordedNow(records: Iterable<RecordedProcess>, tools: Pick<NativeTools, 'ps' | 'hiddenVariables'>): void {
  for (const record of records) {
    try {
      if (!Number.isSafeInteger(record.pid) || record.pid < 2 || typeof record.command !== 'string' || record.command.trim().length === 0) continue
      const shown = readMetadataProcess({
        command: tools.ps, args: ['-ww', '-o', 'args=', '-p', String(record.pid)],
        environment: childEnvironment(undefined, tools.hiddenVariables),
      })
      if (shown.trim() === record.command) process.kill(record.pid, 'SIGKILL')
    } catch {
      // Gone already, or never ours to signal; throwing here would replace the exit code Retest chose.
    }
  }
}
