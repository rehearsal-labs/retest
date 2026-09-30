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
import { errorMessage, failure } from '../protocol/failures.ts'
import { isWebUrl, withoutCredentials } from '../protocol/url.ts'
import { errorCode } from '../shared/error-code.ts'
import { describeExit } from '../shared/process-exit.ts'
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
}

/**
 * A server `start` made ready. One that already answered is `reused` and never stopped. One Retest `started` has
 * the process id of its shell, which leads its own process group; `stop` ends that whole group.
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
const liveGroups = new Set<number>()
let exitHookInstalled = false

/**
 * Asks `url` once, within `timeoutMs`, whether a server answers there. Any HTTP answer counts, whatever its
 * status; a refused connection, a timeout or anything that is not HTTP does not.
 *
 * @example await probeReady('http://127.0.0.1:3000/health', 1000) // true
 */
export function probeReady(url: string, timeoutMs: number): Promise<boolean> {
  const target = URL.parse(url)
  if (!isWebUrl(target)) return Promise.resolve(false)
  const get = target.protocol === 'https:' ? httpsGet : httpGet
  const { promise, resolve } = Promise.withResolvers<boolean>()
  const request = get(target, { agent: false }, (response) => {
    resolve(true)
    response.destroy()
  })
  const timer = setTimeout(() => request.destroy(), timeoutMs)
  request.on('error', () => resolve(false))
  request.on('close', () => resolve(false))
  return promise.finally(() => clearTimeout(timer))
}

/**
 * Makes an app's server ready within `timeoutMs`. When `ready` already answers, that server is reused. Otherwise
 * `command` runs in a shell, as its own process group, with its output in `logFile`, until `ready` answers. A
 * server that exits first, or never answers, is stopped and throws `AppServerError`. The parent's exit also ends
 * every group still running, as a last resort.
 *
 * @example const server = await startAppServer({ name: 'web', start, logFile }, 60_000); await server.stop(1000)
 */
export async function startAppServer(options: AppServerOptions, timeoutMs: number): Promise<AppServerHandle> {
  const startedAt = monotonicClock()
  const deadline = new Deadline(timeoutMs, { startedAt })
  const { name, start } = options
  const ready = withoutCredentials(start.ready)
  if (await probeReady(start.ready, smallestBudget(probeLimitMs, deadline.commandTimeoutMs))) {
    return { status: 'reused', durationMs: elapsedMs(startedAt), stop: async () => undefined }
  }
  const server = await launch(options)
  while (!deadline.expired) {
    if (options.signal?.aborted === true) return server.fail(failure('interrupted', `Starting the server for ${name} was interrupted.`))
    if (server.exit !== undefined) {
      return server.fail(failure('setup_failed', `The server for ${name} exited with ${describeExit(server.exit)} before ${ready} answered. Its output is in ${options.logFile}.`))
    }
    if (await probeReady(start.ready, smallestBudget(probeLimitMs, deadline.commandTimeoutMs))) {
      return { status: 'started', pid: server.pid, durationMs: elapsedMs(startedAt), stop: (budget) => server.stop(budget) }
    }
    await sleep(smallestBudget(pollIntervalMs, deadline.remainingMs))
  }
  return server.fail(failure('setup_failed', `The server for ${name} did not answer at ${ready} within ${timeoutMs} ms. Its output is in ${options.logFile}.`))
}

type Launched = {
  readonly pid: number
  readonly exit: ProcessExit | undefined
  stop(timeoutMs: number): Promise<void>
  /** Stops the server and throws the failure. */
  fail(problem: Failure): Promise<never>
}

async function launch({ name, start, logFile, redactor }: AppServerOptions): Promise<Launched> {
  const folder = checkFolder(name, start.cwd)
  mkdirSync(dirname(logFile), { recursive: true })
  const child = spawn(start.command, { shell: true, cwd: folder, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const { pid } = child
  if (pid === undefined) {
    const [error] = await once(child, 'error')
    throw new AppServerError(failure('setup_failed', `The server for ${name} could not start: ${errorMessage(error)}`))
  }
  own(pid)
  const log = openSync(logFile, 'a')
  let exit: ProcessExit | undefined
  child.on('exit', (code, signal) => (exit ??= { code, signal }))
  const closed = Promise.all([copyTo(child.stdout, log, redactor), copyTo(child.stderr, log, redactor)]).then(() => closeSync(log))
  const stop = async (timeoutMs: number): Promise<void> => {
    await stopGroup(pid, timeoutMs)
    // A process that left the group may still hold the output open; the log is closed without it.
    await bounded(closed, closeGraceMs)
    child.stdout?.destroy()
    child.stderr?.destroy()
  }
  const fail = async (problem: Failure): Promise<never> => {
    await stop(closeGraceMs)
    throw new AppServerError(problem)
  }
  return {
    pid,
    get exit() {
      return exit
    },
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
  const redacted = redactor?.stream()
  stream.setEncoding('utf8')
  stream.on('data', (text: string) => writeSync(log, redacted === undefined ? text : redacted.write(text)))
  stream.on('error', (error) => writeSync(log, `Retest could not read the server's output: ${errorMessage(error)}\n`))
  const { promise, resolve } = Promise.withResolvers<void>()
  stream.once('close', () => {
    if (redacted !== undefined) writeSync(log, redacted.end())
    resolve()
  })
  return promise
}

async function stopGroup(pid: number, timeoutMs: number): Promise<void> {
  signalGroup(pid, 'SIGTERM')
  if (!(await groupGoneWithin(pid, timeoutMs))) {
    signalGroup(pid, 'SIGKILL')
    await groupGoneWithin(pid, closeGraceMs)
  }
  liveGroups.delete(pid)
}

async function groupGoneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = new Deadline(timeoutMs)
  while (groupAlive(pid)) {
    if (deadline.expired) return false
    await sleep(smallestBudget(20, deadline.remainingMs))
  }
  return true
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
}

function own(pid: number): void {
  liveGroups.add(pid)
  if (exitHookInstalled) return
  exitHookInstalled = true
  // Runs synchronously as the parent exits, whatever ended it short of SIGKILL.
  process.on('exit', () => {
    for (const group of liveGroups) signalGroup(group, 'SIGKILL')
  })
}
