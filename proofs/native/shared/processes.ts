import type { ChildProcess } from 'node:child_process'
import type { JsonObject } from './webdriver.ts'
import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { setTimeout as sleep } from 'node:timers/promises'
import { within } from './deadline.ts'
import { describeError, WebDriverClient } from './webdriver.ts'

/** How a finished process ended. `signal` is set when a signal ended it. */
export type ExitFacts = {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
}

/** What a short command printed and how it ended. */
export type Captured = ExitFacts & {
  readonly stdout: string
  readonly stderr: string
}

/** A line the runner's log can show, and what it means for the person running the proof. */
export type KnownFailure = {
  readonly pattern: RegExp
  readonly explanation: string
  /** True when the machine needs a person (a permission, a download) rather than a code change. */
  readonly blocked: boolean
}

/** A runner that never became ready, with what its log says. */
export class RunnerStartError extends Error {
  readonly explanation: string
  readonly blocked: boolean
  readonly logPath: string

  constructor(details: { readonly message: string; readonly explanation: string; readonly blocked: boolean; readonly logPath: string }) {
    super(details.message)
    this.name = 'RunnerStartError'
    this.explanation = details.explanation
    this.blocked = details.blocked
    this.logPath = details.logPath
  }
}

// How long a process gets to end after SIGTERM before it is sent SIGKILL.
const TERMINATION_GRACE_MS = 10_000

/**
 * Runs a command to its end with all of its output in a log file, never on the terminal. A command still running
 * at the deadline is sent SIGTERM, then SIGKILL after a grace period, and reported with that signal.
 *
 * @example await runLogged('xcodebuild', ['-version'], { logPath: '/tmp/version.log', timeoutMs: 10_000 }) // { exitCode: 0, signal: null }
 */
export async function runLogged(command: string, args: readonly string[], options: { readonly logPath: string; readonly cwd?: string; readonly timeoutMs: number }): Promise<ExitFacts> {
  const log = openSync(options.logPath, 'a')
  try {
    const child = spawn(command, args, { cwd: options.cwd ?? process.cwd(), stdio: ['ignore', log, log] })
    const ended = waitForEnd(child, 'exit')
    return (await within(ended, options.timeoutMs)) ?? (await stopChild(child, ended))
  } finally {
    closeSync(log)
  }
}

/**
 * Runs a short command and keeps what it printed: simctl's JSON, git revisions, process lookups, the system log.
 * It never throws for a non-zero exit; the caller reads `exitCode`. At the deadline the command is sent SIGTERM,
 * then SIGKILL after a grace period.
 *
 * @example (await capture('git', ['rev-parse', 'HEAD'], { cwd: clone })).stdout // 'f38257191fa9…\n'
 */
export async function capture(command: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs?: number } = {}): Promise<Captured> {
  const child = spawn(command, args, { cwd: options.cwd ?? process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk
  })
  child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk
  })
  child.once('error', (error) => {
    stderr += describeError(error)
  })
  const exited = waitForEnd(child, 'exit')
  // 'close' rather than 'exit' on the normal path, so everything the command printed has been read.
  const closed = waitForEnd(child, 'close')
  const finished = await within(closed, options.timeoutMs ?? 30_000)
  if (finished !== undefined) return { ...finished, stdout, stderr }
  const facts = await stopChild(child, exited)
  // A grandchild can keep the pipes open after the command itself was killed; stop reading them.
  child.stdout?.destroy()
  child.stderr?.destroy()
  return { ...facts, stdout, stderr }
}

/**
 * Whether something accepts TCP connections on the address.
 *
 * @example await isListening('127.0.0.1', 10100) // false
 */
export async function isListening(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const finish = (listening: boolean): void => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(1000, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

/**
 * The ids of processes whose executable name is `name` exactly, or whose full command line contains `pattern`.
 *
 * @example await processIds({ name: 'TextEdit' }) // [81234]
 */
export async function processIds(match: { readonly name: string } | { readonly pattern: string }): Promise<number[]> {
  const args = 'name' in match ? ['-x', match.name] : ['-f', match.pattern]
  const result = await capture('pgrep', args)
  // pgrep exits 1 when nothing matches.
  if (result.exitCode === 1) return []
  if (result.exitCode !== 0) throw new Error(`pgrep ${args.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim()}`)
  return result.stdout.split('\n').filter((line) => line.trim().length > 0).map(Number).filter((id) => id !== process.pid)
}

/**
 * Whether a process with this id exists. Signal 0 checks without sending anything.
 *
 * @example isAlive(process.pid) // true
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** What starts a runner: the xcodebuild invocation, where its output goes, and how readiness is judged. */
export type RunnerOptions = {
  readonly args: readonly string[]
  readonly cwd: string
  /** Variables added to this process's environment, such as `USE_PORT`. */
  readonly environment: Readonly<Record<string, string>>
  readonly logPath: string
  readonly client: WebDriverClient
  readonly readyTimeoutMs: number
  readonly knownFailures: readonly KnownFailure[]
}

/**
 * One `xcodebuild test-without-building` process that hosts an XCTest executor. It is the only process this proof
 * signals directly, and only when the executor's own shutdown route did not end it.
 */
export class RunnerProcess {
  readonly logPath: string
  readonly status: JsonObject
  readonly #child: ChildProcess
  readonly #ended: Promise<ExitFacts>
  #exitFacts: ExitFacts | undefined

  private constructor(child: ChildProcess, ended: Promise<ExitFacts>, logPath: string, status: JsonObject) {
    this.#child = child
    this.#ended = ended
    this.logPath = logPath
    this.status = status
    void ended.then((facts) => {
      this.#exitFacts = facts
    })
  }

  /**
   * Starts xcodebuild and waits until the executor answers `/status`. If xcodebuild exits first, a known failure
   * line appears in the log, or the deadline passes, the process is stopped and a RunnerStartError explains why.
   */
  static async start(options: RunnerOptions): Promise<RunnerProcess> {
    const log = openSync(options.logPath, 'a')
    let child: ChildProcess
    try {
      child = spawn('xcodebuild', options.args, { cwd: options.cwd, env: { ...process.env, ...options.environment }, stdio: ['ignore', log, log] })
    } finally {
      closeSync(log)
    }
    const ended = waitForEnd(child, 'exit')
    let exited: ExitFacts | undefined
    void ended.then((facts) => {
      exited = facts
    })
    const deadline = Date.now() + options.readyTimeoutMs
    let lastError = 'no answer yet'
    while (Date.now() < deadline) {
      const failure = await matchKnownFailure(options.logPath, options.knownFailures)
      if (failure !== undefined) {
        await stopChild(child, ended)
        throw new RunnerStartError({ message: `The runner log shows: ${failure.line}`, explanation: failure.explanation, blocked: failure.blocked, logPath: options.logPath })
      }
      if (exited !== undefined) {
        throw new RunnerStartError({ message: `xcodebuild exited with ${describeExit(exited)} before the runner answered`, explanation: 'Read the runner log for the reason.', blocked: false, logPath: options.logPath })
      }
      try {
        const status = await options.client.status(2000)
        if (status['ready'] === true) return new RunnerProcess(child, ended, options.logPath, status)
        lastError = 'status says it is not ready'
      } catch (error) {
        lastError = describeError(error)
      }
      await sleep(500)
    }
    await stopChild(child, ended)
    throw new RunnerStartError({ message: `The runner did not answer /status within ${options.readyTimeoutMs} ms (${lastError})`, explanation: 'Read the runner log for the reason.', blocked: false, logPath: options.logPath })
  }

  /** The process id of xcodebuild. */
  get pid(): number | undefined {
    return this.#child.pid
  }

  /** How xcodebuild ended, or undefined while it runs. */
  get exitFacts(): ExitFacts | undefined {
    return this.#exitFacts
  }

  /**
   * Waits for xcodebuild to end after the executor's shutdown route was called. When it is still running at the
   * deadline it is sent SIGTERM, then SIGKILL; `signalled` says so.
   */
  async waitForEnd(timeoutMs: number): Promise<ExitFacts & { readonly signalled: boolean }> {
    const ended = await within(this.#ended, timeoutMs)
    if (ended !== undefined) return { ...ended, signalled: false }
    return { ...(await stopChild(this.#child, this.#ended)), signalled: true }
  }
}

/**
 * Describes how a process ended, for a step record.
 *
 * @example describeExit({ exitCode: 65, signal: null }) // 'exit code 65'
 */
export function describeExit(facts: ExitFacts): string {
  return facts.signal === null ? `exit code ${String(facts.exitCode)}` : `signal ${facts.signal}`
}

/**
 * The last lines of a log file, for a failure message that points at the cause.
 *
 * @example await logTail('/tmp/runner.log', 5) // '…\n** TEST EXECUTE FAILED **'
 */
export async function logTail(path: string, lines: number): Promise<string> {
  const text = await readFile(path, 'utf8').catch(() => '')
  return text.trimEnd().split('\n').slice(-lines).join('\n')
}

function waitForEnd(child: ChildProcess, event: 'exit' | 'close'): Promise<ExitFacts> {
  return new Promise((resolve) => {
    child.once(event, (exitCode: number | null, signal: NodeJS.Signals | null) => resolve({ exitCode, signal }))
    // A command that cannot start emits only an error; 127 is the shell's code for a missing command.
    child.once('error', () => resolve({ exitCode: child.exitCode ?? 127, signal: null }))
  })
}

async function stopChild(child: ChildProcess, ended: Promise<ExitFacts>): Promise<ExitFacts> {
  if (child.exitCode !== null || child.signalCode !== null) return ended
  child.kill('SIGTERM')
  const afterTerm = await within(ended, TERMINATION_GRACE_MS)
  if (afterTerm !== undefined) return afterTerm
  // SIGKILL cannot be caught, so the exit event follows.
  child.kill('SIGKILL')
  return ended
}

async function matchKnownFailure(logPath: string, failures: readonly KnownFailure[]): Promise<(KnownFailure & { readonly line: string }) | undefined> {
  const text = await readFile(logPath, 'utf8').catch(() => '')
  for (const failure of failures) {
    const line = text.split('\n').find((candidate) => failure.pattern.test(candidate))
    if (line !== undefined) return { ...failure, line: line.trim().slice(0, 300) }
  }
  return undefined
}
