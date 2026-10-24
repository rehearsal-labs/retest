import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import type { LoadedStart } from '../config/loaded.ts'
import type { Failure } from '../protocol/failures.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { Redactor } from './redactor.ts'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { closeSync, mkdirSync, openSync, statSync, writeSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { dirname } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { closeGraceMs } from '../browser/contract.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { errorMessage, failure, withAlso } from '../protocol/failures.ts'
import { isWebUrl, withoutCredentials } from '../protocol/url.ts'
import { withoutVariables } from '../shared/environment.ts'
import { errorCode } from '../shared/error-code.ts'
import { describeExit } from '../shared/process-exit.ts'
import { OwnedProcessGroup } from '../shared/process-ownership.ts'
import { consolesDetached, holdLaunch, launchOwnership, prepareOwnedLaunch, serverStopSignal } from '../shared/process-system.ts'
import { bounded } from './bounded.ts'

export type AppServerOptions = {
  /** The app the server belongs to, as messages name it. */
  name: string
  start: LoadedStart
  /** The absolute path the server's stdout and stderr go to. */
  logFile: string
  /** Hides secret values in the server's output before it reaches the log. */
  redactor?: Redactor
  /** Stops waiting for the server, and stops the server, when aborted. */
  signal?: AbortSignal
  /** Environment variables the server must not see, such as the ones AI judges' credentials are read from. */
  hiddenVariables?: readonly string[]
}

/**
 * A server `start` made ready. One that was already there, whose port took Retest's connection, is `reused` and never
 * stopped. One Retest `started` has the process id of its shell. `stop` ends only processes whose launch ancestry and
 * exact identity Retest recorded.
 */
export type AppServerHandle =
  | { readonly status: 'reused'; readonly durationMs: number; stop(timeoutMs: number): Promise<void> }
  | { readonly status: 'started'; readonly pid: number; readonly durationMs: number; stop(timeoutMs: number): Promise<void> }

/** Thrown when a server does not become ready. `failure.class` is `setup_failed`, or `interrupted`. */
export class AppServerError extends Error {
  override readonly name = 'AppServerError'
  readonly failure: Failure

  constructor(problem: Failure) {
    super(problem.message)
    this.failure = problem
  }
}

const probeLimitMs = 1000
const pollIntervalMs = 100
const liveServers = new Set<ServerOwnership>()
let exitHookInstalled = false

/**
 * What one look at a server's `ready` address found. `answered`: an HTTP answer came, whatever its status.
 * `accepted`: the port took the connection, so a server is there, but no HTTP answer came. `refused`: the connection
 * was refused, or the host's name resolves to nothing, so no server is there. `unreached`: the connection neither opened
 * nor was refused, or failed in another way first, or the address is not HTTP, so nothing is known.
 */
export type ReadyLook = 'answered' | 'accepted' | 'refused' | 'unreached'

// The errors that say no server is there: nothing listens on the port, or the name is no host's.
const noServerCodes: ReadonlySet<string> = new Set(['ECONNREFUSED', 'ENOTFOUND'])
const wakeGraceMs = 50

/**
 * Asks `url` once with an HTTP GET and says what it found within `timeoutMs`, or before `signal` aborts. What came in
 * while this process was held busy counts, as does a connection asked for just before: a limit that passed while the
 * process was held is judged a moment after it wakes, once those events have been read.
 *
 * @example await lookAtReady('http://127.0.0.1:3000/health', 1000) // 'answered'
 */
export function lookAtReady(url: string, timeoutMs: number, signal?: AbortSignal): Promise<ReadyLook> {
  const target = URL.parse(url)
  if (!isWebUrl(target)) return Promise.resolve('unreached')
  const get = target.protocol === 'https:' ? httpsGet : httpGet
  const { promise, resolve } = Promise.withResolvers<ReadyLook>()
  let connected = false
  const request = get(target, { agent: false, ...(signal === undefined ? {} : { signal }) }, (response) => {
    resolve('answered')
    response.destroy()
  })
  request.on('socket', (socket) => {
    if (!socket.connecting) {
      connected = socket.readyState === 'open'
      return
    }
    socket.once('connect', () => {
      connected = true
    })
  })
  // A timer that came due while the process was held runs before the events that came in meanwhile, and Node sends a
  // connection it was asked for only once the process is free; so a late timer gives the look a moment more.
  const dueAt = monotonicClock() + timeoutMs
  let timer = setTimeout(() => {
    timer = setTimeout(() => request.destroy(), monotonicClock() - dueAt > wakeGraceMs ? wakeGraceMs : 0)
  }, timeoutMs)
  request.on('error', (error) => resolve(connected ? 'accepted' : noServerCodes.has(errorCode(error) ?? '') ? 'refused' : 'unreached'))
  request.on('close', () => resolve(connected ? 'accepted' : 'unreached'))
  return promise.finally(() => clearTimeout(timer))
}

/**
 * Asks `url` once, within `timeoutMs`, whether a server answers there. Any HTTP answer counts, whatever its
 * status; a refused connection, a timeout or anything that is not HTTP does not.
 *
 * @example await probeReady('http://127.0.0.1:3000/health', 1000) // true
 */
export async function probeReady(url: string, timeoutMs: number): Promise<boolean> {
  return (await lookAtReady(url, timeoutMs)) === 'answered'
}

/**
 * Makes an app's server ready within `timeoutMs`. Whether a server is already there is a fact about the connection,
 * not about how soon it answers. When the port at `ready` takes the connection, that server is reused: Retest waits
 * for it to answer within `timeoutMs`, as it waits for one it starts, and one that never answers throws
 * `AppServerError` and is left running. When the connection is refused, or neither opens nor is refused within a
 * second, `command` runs in a shell, as its own process group, with its output in `logFile`, until `ready` answers.
 * A server that exits first, or never answers, is stopped and throws `AppServerError`. The parent's exit also ends
 * every recorded process still running, after checking its exact identity again.
 *
 * @example const server = await startAppServer({ name: 'web', start, logFile }, 60_000); await server.stop(1000)
 */
export async function startAppServer(options: AppServerOptions, timeoutMs: number, dependencies: AppServerDependencies = {}): Promise<AppServerHandle> {
  const interrupted = (): boolean => options.signal?.aborted === true
  const look = dependencies.probe ?? lookAtReady
  const launchServer = dependencies.launch ?? launch
  const startedAt = monotonicClock()
  const deadline = new Deadline(timeoutMs, { startedAt })
  const { name, start } = options
  const ready = withoutCredentials(start.ready)
  const found = await look(start.ready, smallestBudget(probeLimitMs, deadline.commandTimeoutMs), options.signal)
  if (found === 'answered' || found === 'accepted') return reuse({ options, timeoutMs, deadline, startedAt, look, found })
  const server = await launchServer(options)
  for (;;) {
    if (interrupted()) return server.fail(failure('interrupted', `Starting the server for ${name} was interrupted.`))
    if (server.exit !== undefined) {
      return server.fail(failure('setup_failed', `The server for ${name} exited with ${describeExit(server.exit)} before ${ready} answered. Its output is in ${options.logFile}.`))
    }
    if ((await look(start.ready, smallestBudget(probeLimitMs, deadline.commandTimeoutMs))) === 'answered') {
      server.settle()
      return { status: 'started', pid: server.pid, durationMs: elapsedMs(startedAt), stop: (budget) => server.stop(budget) }
    }
    if (deadline.reached) break
    const waitToEndMs = deadline.waitToEndMs
    const pause = smallestBudget(pollIntervalMs, waitToEndMs)
    await sleep(pause)
    if (pause === waitToEndMs) {
      while (!deadline.reached && !interrupted()) await sleep(deadline.waitToEndMs)
    }
  }
  return server.fail(failure('setup_failed', `The server for ${name} did not answer at ${ready} within ${timeoutMs} ms. Its output is in ${options.logFile}.`))
}

type Reuse = {
  options: AppServerOptions
  timeoutMs: number
  deadline: Deadline
  startedAt: number
  look: ReadyLooker
  /** What the first look found: an answer, or a port that took the connection. */
  found: ReadyLook
}

// A server already there is waited for as long as one Retest starts, each look held open for the time left, so a
// server slower than a look's second still answers. Retest started nothing, so it stops nothing, whatever the outcome.
async function reuse({ options, timeoutMs, deadline, startedAt, look, found }: Reuse): Promise<AppServerHandle> {
  const { name, start, signal } = options
  for (let last = found; last !== 'answered'; last = await look(start.ready, deadline.commandTimeoutMs, signal)) {
    await sleep(smallestBudget(pollIntervalMs, deadline.waitToEndMs))
    if (signal?.aborted === true) throw new AppServerError(failure('interrupted', `Waiting for the server for ${name} was interrupted.`))
    if (deadline.reached) {
      const ready = withoutCredentials(start.ready)
      throw new AppServerError(failure('setup_failed', `Something was already listening at ${ready}, so Retest used it as the server for ${name} and started nothing, but it did not answer within ${timeoutMs} ms.`))
    }
  }
  return { status: 'reused', durationMs: elapsedMs(startedAt), stop: async () => undefined }
}

type ReadyLooker = (url: string, timeoutMs: number, signal?: AbortSignal) => Promise<ReadyLook>

/** Internal readiness seams; production uses the owned server and the HTTP look. */
export type AppServerDependencies = {
  readonly probe?: ReadyLooker
  readonly launch?: (options: AppServerOptions) => Promise<Launched>
}

type Launched = {
  readonly pid: number
  readonly exit: ProcessExit | undefined
  /** Records the server again once it answers, when its shell has become the command it ran. */
  settle(): void
  stop(timeoutMs: number): Promise<void>
  /** Stops the server and throws the failure. */
  fail(problem: Failure): Promise<never>
}

/**
 * The server's processes as Retest recorded them. A shell may replace itself with the command it runs, as `sh -c
 * "node server.js"` does, keeping its pid and start under a new command line, and the ownership rule refuses a record
 * whose readable command differs from the process it names. So the launch is recorded at once, which covers a start
 * that fails before the shell runs anything, and recorded once more when the server answers, or is stopped or the
 * parent exits before it did. That second record is taken only while Node has not reaped the child, so its pid cannot
 * yet belong to any other process, and it holds whatever command the shell became.
 */
class ServerOwnership {
  readonly #child: ChildProcess
  readonly #pid: number
  #group: OwnedProcessGroup
  #settled = false

  constructor(child: ChildProcess, pid: number) {
    this.#child = child
    this.#pid = pid
    this.#group = holdLaunch(child)
  }

  get group(): OwnedProcessGroup {
    return this.#group
  }

  // A record that cannot be taken cleanly leaves the launch record in place, with the problems it meets in cleanup.
  settle(): void {
    if (this.#settled) return
    this.#settled = true
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return
    const settled = launchOwnership(this.#pid)
    if (settled.capture().length === 0) this.#group = settled
  }
}

async function launch({ name, start, logFile, redactor, hiddenVariables }: AppServerOptions): Promise<Launched> {
  const folder = checkFolder(name, start.cwd)
  mkdirSync(dirname(logFile), { recursive: true })
  const log = openSync(logFile, 'a')
  const env = withoutVariables(process.env, hiddenVariables)
  let child: ChildProcess
  try {
    prepareOwnedLaunch()
    // windowsHide gives the server, on Windows, a console of its own with no window, which Retest can send Ctrl+C to
    // without reaching its own; Node ignores it elsewhere.
    child = spawn(start.command, { shell: true, cwd: folder, env, detached: consolesDetached, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const problem = failure('setup_failed', `The server for ${name} could not start: ${outputErrorMessage(error, redactor)}`)
    try {
      closeSync(log)
    } catch (closeError) {
      throw new AppServerError(withAlso(problem, [failure('cleanup_failed', `The server's log could not close: ${outputErrorMessage(closeError, redactor)}`)]))
    }
    throw new AppServerError(problem)
  }
  const { pid } = child
  if (pid === undefined) {
    const failed = once(child, 'error')
    let logFailure: Failure | undefined
    try {
      closeSync(log)
    } catch (error) {
      logFailure = failure('cleanup_failed', `The server's log could not close: ${outputErrorMessage(error, redactor)}`)
    }
    const [error] = await failed
    const problem = failure('setup_failed', `The server for ${name} could not start: ${outputErrorMessage(error, redactor)}`)
    throw new AppServerError(logFailure === undefined ? problem : withAlso(problem, [logFailure]))
  }
  const ownership = new ServerOwnership(child, pid)
  const ownershipProblems = ownership.group.capture()
  own(ownership)
  let exit: ProcessExit | undefined
  child.on('exit', (code, signal) => (exit ??= { code, signal }))
  const closed = Promise.allSettled([copyTo(child.stdout, log, redactor), copyTo(child.stderr, log, redactor)]).then((outputs) => {
    const problems = outputs.flatMap((output) => output.status === 'rejected' ? [errorMessage(output.reason)] : [])
    try {
      closeSync(log)
    } catch (error) {
      problems.push(`The server's log could not close: ${outputErrorMessage(error, redactor)}`)
    }
    if (problems.length > 0) throw new Error(problems.join(' '))
  })
  // A server can fail its output before stop is called. Keep that rejection for stop without an unhandled rejection.
  void closed.catch(() => undefined)
  let stopping: Promise<void> | undefined
  const stop = (timeoutMs: number): Promise<void> => {
    stopping ??= (async () => {
      const problems = [...ownershipProblems, ...await stopGroup(ownership, timeoutMs)]
      const output = await bounded(closed, closeGraceMs)
      child.stdout?.destroy()
      child.stderr?.destroy()
      if (output.status === 'timed_out') problems.push("The server's output did not close; cleanup completion is unknown.")
      if (output.status === 'failed') problems.push(`The server's output could not close: ${errorMessage(output.error)}`)
      // A process whose ownership could not be read must not keep the reporting process open indefinitely.
      if (ownership.group.remains()) child.unref()
      problems.push(...ownership.group.readProblems)
      if (problems.length > 0) throw new AppServerError(failure('cleanup_failed', `Retest could not stop the server for ${name}: ${[...new Set(problems)].join(' ')}`))
    })()
    return stopping
  }
  const fail = async (problem: Failure): Promise<never> => {
    try {
      await stop(closeGraceMs)
    } catch (error) {
      const cleanup = error instanceof AppServerError ? error.failure : failure('cleanup_failed', errorMessage(error))
      throw new AppServerError(withAlso(problem, [cleanup]))
    }
    throw new AppServerError(problem)
  }
  if (ownershipProblems.length > 0) return fail(failure('setup_failed', `The server for ${name} started, but Retest could not record its process ownership: ${ownershipProblems.join(' ')}`))
  return {
    pid,
    get exit() {
      return exit
    },
    settle: () => ownership.settle(),
    stop,
    fail,
  }
}

function checkFolder(name: string, cwd: string): string {
  try {
    if (statSync(cwd).isDirectory()) return cwd
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new AppServerError(failure('setup_failed', `Cannot read ${cwd}, the folder the server for ${name} starts in: ${errorMessage(error)}`))
  }
  throw new AppServerError(failure('setup_failed', `The folder the server for ${name} starts in, ${cwd}, does not exist.`))
}

// A stream holds back a tail that may be the start of a secret until it knows, and writes it when it closes.
function copyTo(stream: Readable | null, log: number, redactor: Redactor | undefined): Promise<void> {
  if (stream === null) return Promise.resolve()
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  let redacted: ReturnType<Redactor['stream']> | undefined
  let problem: Error | undefined
  const failOutput = (error: unknown): void => {
    problem ??= new Error(`The server's output could not be saved: ${outputErrorMessage(error, redactor)}`)
    // A failed write or redaction discards pending output, so a partial secret cannot be flushed afterwards.
    try {
      stream.destroy()
    } catch {
      // stop still has a bounded wait for a stream that could not be closed.
    }
  }
  stream.on('data', (text: string) => {
    if (problem !== undefined) return
    try {
      writeSync(log, redacted === undefined ? text : redacted.write(text))
    } catch (error) {
      failOutput(error)
    }
  })
  stream.on('error', failOutput)
  stream.once('close', () => {
    if (problem === undefined && redacted !== undefined) {
      try {
        writeSync(log, redacted.end())
      } catch (error) {
        problem = new Error(`The server's final output could not be saved: ${outputErrorMessage(error, redactor)}`)
      }
    }
    if (problem === undefined) resolve()
    else reject(problem)
  })
  try {
    redacted = redactor?.stream()
    stream.setEncoding('utf8')
  } catch (error) {
    failOutput(error)
  }
  return promise
}

// A failed redactor must never turn a cleanup error containing a known value into an unredacted report.
function outputErrorMessage(error: unknown, redactor: Redactor | undefined): string {
  try {
    const message = errorMessage(error)
    return redactor === undefined ? message : redactor.redact(message)
  } catch {
    return 'The error could not be safely described.'
  }
}

async function stopGroup(server: ServerOwnership, timeoutMs: number): Promise<string[]> {
  server.settle()
  const ownership = server.group
  const problems = ownership.signal(serverStopSignal)
  let gone = await groupGoneWithin(ownership, timeoutMs)
  if (!gone) {
    problems.push(...ownership.signal('SIGKILL'))
    gone = await groupGoneWithin(ownership, closeGraceMs)
  }
  if (gone) liveServers.delete(server)
  else problems.push('Recorded server processes or processes with unknown ownership are still running after cleanup.')
  problems.push(...ownership.readProblems)
  return problems
}

async function groupGoneWithin(ownership: OwnedProcessGroup, timeoutMs: number): Promise<boolean> {
  const deadline = new Deadline(timeoutMs)
  while (ownership.remains()) {
    if (deadline.expired) return false
    await sleep(smallestBudget(20, deadline.remainingMs))
  }
  return true
}

function own(server: ServerOwnership): void {
  liveServers.add(server)
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Runs synchronously as the parent exits, with the same exact identity checks as ordinary cleanup.
  process.on('exit', () => {
    for (const live of liveServers) {
      live.settle()
      live.group.signalNow('SIGKILL')
    }
  })
}
