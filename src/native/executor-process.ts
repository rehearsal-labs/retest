import type { Failure } from '../protocol/failures.ts'
import type { ExecutorBuild, ExecutorName } from './executors.ts'
import type { NativeTools, RecordedProcess } from './processes.ts'
import type { RequestBounds } from './webdriver-client.ts'
import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { nativePins } from './executors.ts'
import { commandOf, endProblem, endRecorded, killRecordedNow, listProcesses, OwnedProcess, processExists, runCommand } from './processes.ts'
import { ExecutorClient } from './webdriver-client.ts'

// Starting an executor: xcodebuild runs the pinned build's test run file against a destination, and the executor's
// one test serves HTTP until it is told to stop. Its port and interface reach the test runner through xcodebuild's
// TEST_RUNNER_ prefix, which sets them in the runner's environment over the empty values the build left in the file.

/** What starting an executor needs. */
export type StartExecutorOptions = {
  readonly executor: ExecutorName
  readonly build: ExecutorBuild
  readonly destination: string
  readonly port: number
  /** More `TEST_RUNNER_` variables, such as the interface to bind. */
  readonly environment: Readonly<Record<string, string>>
  readonly logFile: string
  readonly redact?: ((text: string) => string) | undefined
  /** Kept for callers; execution output uses a separate owned temporary folder and is deleted. */
  readonly resultFolder: string
  readonly tools: NativeTools
  readonly bounds: RequestBounds
  /**
   * Whether a process's command line is a runner app of this executor. macOS or the simulator launches the runner app,
   * outside xcodebuild's process group and with launchd for a parent, so it is found by its command line.
   */
  readonly isRunnerApp: (command: string) => boolean
  /**
   * How a runner app is tied to this start. `listening-port`: it is the one that appeared during the start and
   * listens on the start's port, as the macOS runner shares its executable with any other start of the same build.
   * `command`: its command line alone ties it, as an iOS runner's lies under the start's own simulator.
   */
  readonly tie: 'listening-port' | 'command'
  /**
   * Told the processes this start recorded as its own each time one is recorded, so a lock can name them; and, as
   * `untied`, a runner app that appeared during the start and is not tied to it yet, so a start that dies before the
   * tie leaves that pid named too.
   */
  readonly onProcesses?: ((processes: StartedProcesses) => void) | undefined
}

/** The processes a start has recorded so far. */
export type StartedProcesses = { readonly xcodebuild: RecordedProcess; readonly runnerApps: readonly RecordedProcess[]; readonly untied: readonly RecordedProcess[] }

// The ports the executors serve on when told nothing, which another tool driving the same executor would use too.
const executorDefaultPorts: readonly number[] = Object.values(nativePins.executors).map((pin) => pin.defaultPort)

/** A failed start: why, and the processes it recorded as its own and could not end. */
export type FailedStart = { readonly ok: false; readonly failure: Failure; readonly leftRunning: readonly RecordedProcess[] }

/** A line of xcodebuild's output that explains why an executor did not start. */
type KnownFailure = { readonly pattern: RegExp; readonly message: string }

const knownFailures: readonly KnownFailure[] = [
  {
    pattern: /Timed out while enabling automation mode/i,
    message: 'macOS asked an administrator to enable UI automation and nobody answered. On a Mac nobody watches, run `sudo automationmodetool enable-automationmode-without-authentication` once.',
  },
  { pattern: /is not installed\. Please download and install the platform|No available simulator runtimes/i, message: 'The simulator runtime is not installed. Install it with xcodebuild -downloadPlatform iOS.' },
  { pattern: /Unable to find a destination matching/i, message: 'xcodebuild cannot run the executor on that destination.' },
  { pattern: /\*\* TEST EXECUTE FAILED \*\*/, message: 'xcodebuild ended the executor before it served requests.' },
]

/**
 * Starts an executor and waits until it answers `/status` as ready. Only a runner app that appears during the start
 * can be this start's, and more than one refuses the start by name; the one tied to it, as `tie` says, is recorded
 * with its command line. When xcodebuild exits first, prints a line that explains a failed start, runs out of time, is
 * stopped or a process reading fails, only recorded and freshly verified executor processes are ended and the failure names
 * the log and anything left. While the start runs, the recorded runner app is killed if the Retest process exits.
 *
 * @example await startExecutor({ executor: 'mac2', build, destination: 'platform=macOS,arch=arm64', port, environment: {}, logFile, resultFolder, tools, bounds, isRunnerApp, tie: 'listening-port' })
 */
export async function startExecutor(options: StartExecutorOptions): Promise<{ readonly ok: true; readonly process: OwnedProcess; readonly os: string | undefined; readonly xcodebuild: RecordedProcess; readonly runnerApps: readonly RecordedProcess[] } | FailedStart> {
  const deadline = new Deadline(options.bounds.timeoutMs)
  if (executorDefaultPorts.includes(options.port)) return refusedStart(`Port ${options.port} is an executor's default port, which another tool driving the same executor would use; Retest runs an executor only on a port of its own.`)
  if (await isListening('127.0.0.1', options.port)) return refusedStart(`Something already listens on 127.0.0.1:${options.port}, the port the executor was to use.`)
  const before = await runnerAppsNow(options)
  if (typeof before === 'string') return refusedStart(before)
  const folder = await mkdtemp(join(tmpdir(), 'retest-executor-'))
  const args = ['test-without-building', '-xctestrun', options.build.xctestrun, '-destination', options.destination, '-resultBundlePath', join(folder, 'result.xcresult'), '-derivedDataPath', join(folder, 'derived'), '-disableAutomaticPackageResolution']
  let runner: OwnedProcess
  try {
    runner = await OwnedProcess.start({ command: options.tools.xcodebuild, args, logFile: options.logFile, environment: { ...options.environment, TEST_RUNNER_USE_PORT: String(options.port) }, hiddenVariables: options.tools.hiddenVariables, redact: options.redact ?? options.tools.redact, temporaryFolders: [folder] })
  } catch (error) {
    await rm(folder, { recursive: true, force: true })
    return refusedStart(`xcodebuild could not start the executor: ${errorMessage(error)}`)
  }
  const client = new ExecutorClient({ executor: options.executor, host: '127.0.0.1', port: options.port })
  const claimed = new Map<number, RecordedProcess>()
  const lastResort = (): void => killRecordedNow(claimed.values(), options.tools)
  process.on('exit', lastResort)
  // Telling the caller can fail, as writing a lock record can; the start then stops what it started.
  let toldFailure: string | undefined
  let untiedTold: readonly RecordedProcess[] = []
  const tell = (processes: Omit<StartedProcesses, 'untied'>, untied: readonly RecordedProcess[] = untiedTold): void => {
    untiedTold = untied
    try {
      options.onProcesses?.({ ...processes, untied })
    } catch (error) {
      toldFailure ??= errorMessage(error)
    }
  }
  const giveUp = async (failure: Failure, appeared: readonly RecordedProcess[] = [], xcodebuildRecord?: RecordedProcess): Promise<FailedStart> => {
    const problems = await runner.stop(0)
    const leftRunning: RecordedProcess[] = []
    if (runner.processesRemain && xcodebuildRecord !== undefined) leftRunning.push(xcodebuildRecord)
    for (const entry of claimed.values()) {
      const problem = endProblem(entry, await endRecorded(options.tools, entry, 5000))
      if (problem === undefined) continue
      problems.push(`The runner app: ${problem}`)
      leftRunning.push(entry)
    }
    problems.push(...(await runner.finishOutput(5000)))
    for (const entry of appeared) if (!claimed.has(entry.pid)) {
      try {
        if (!processExists(entry.pid)) continue
        problems.push(`A runner app (pid ${entry.pid}) appeared that Retest could not tie to this start; it was not ended.`)
      } catch (error) {
        problems.push(`Retest could not read whether untied runner pid ${entry.pid} remains: ${errorMessage(error)}`)
      }
      leftRunning.push(entry)
    }
    process.off('exit', lastResort)
    return { ok: false, failure: { ...failure, message: `${failure.message} The executor log is ${options.logFile}.`, ...(problems.length === 0 ? {} : { details: { also: `cleanup_failed: ${problems.join(' ')}` } }) }, leftRunning }
  }
  const xcodebuildCommand = await commandOf(options.tools, runner.pid)
  if (xcodebuildCommand.state !== 'present') return giveUp({ class: 'setup_failed', message: `Retest could not record xcodebuild's command line (${xcodebuildCommand.state === 'unreadable' ? xcodebuildCommand.problem : 'it was already gone'}).` })
  const xcodebuild: RecordedProcess = { pid: runner.pid, command: xcodebuildCommand.command }
  tell({ xcodebuild, runnerApps: [] })
  if (toldFailure !== undefined) return giveUp({ class: 'setup_failed', message: `Retest could not record the executor's processes: ${toldFailure}` }, [], xcodebuild)
  const claim = (entry: RecordedProcess): void => {
    if (claimed.has(entry.pid)) return
    claimed.set(entry.pid, entry)
    tell({ xcodebuild, runnerApps: [...claimed.values()] })
  }
  for (;;) {
    const now = await runnerAppsNow(options)
    if (typeof now === 'string') return giveUp({ class: 'setup_failed', message: now }, [], xcodebuild)
    const appeared = now.filter((entry) => !before.some((earlier) => earlier.pid === entry.pid))
    const untied = options.tie === 'listening-port' ? appeared.filter((entry) => !claimed.has(entry.pid)) : []
    if (untied.length !== untiedTold.length || untied.some((entry, index) => untiedTold[index]?.pid !== entry.pid)) tell({ xcodebuild, runnerApps: [...claimed.values()] }, untied)
    if (appeared.length > 1) return giveUp({ class: 'setup_failed', message: `${appeared.length} runner apps (pid ${appeared.map((entry) => entry.pid).join(', ')}) appeared during this start, so Retest cannot tell which one is its own.` }, appeared, xcodebuild)
    if (options.tie === 'command') for (const entry of appeared) claim(entry)
    if (toldFailure !== undefined) return giveUp({ class: 'setup_failed', message: `Retest could not record the executor's processes: ${toldFailure}` }, appeared, xcodebuild)
    const known = await knownFailure(options.logFile)
    if (known !== undefined) return giveUp({ class: 'setup_failed', message: `${known.message} (${known.line})` }, appeared, xcodebuild)
    const exit = runner.exit
    if (exit !== undefined) return giveUp({ class: 'setup_failed', message: `xcodebuild ended with ${exit.signal === null ? `exit code ${exit.code ?? 'unknown'}` : `signal ${exit.signal}`} before the executor answered.` }, appeared, xcodebuild)
    if (options.bounds.signal?.aborted === true) return giveUp({ class: 'interrupted', message: 'Starting the executor was stopped.' }, appeared, xcodebuild)
    if (deadline.expired) return giveUp({ class: 'setup_failed', message: `The executor did not answer /status within ${options.bounds.timeoutMs} ms.` }, appeared, xcodebuild)
    const status = await client.status({ timeoutMs: Math.min(2000, deadline.commandTimeoutMs), signal: options.bounds.signal })
    if (status.status === 'answered' && status.value.ready) {
      if (options.tie === 'listening-port') {
        const listener = await listenerOf(options.tools, options.port)
        const served = appeared.find((entry) => entry.pid === listener)
        if (served === undefined) return giveUp({ class: 'setup_failed', message: `The process serving 127.0.0.1:${options.port} is not a runner app that appeared during this start.` }, appeared, xcodebuild)
        claimed.set(served.pid, served)
        tell({ xcodebuild, runnerApps: [...claimed.values()] }, [])
        if (toldFailure !== undefined) return giveUp({ class: 'setup_failed', message: `Retest could not record the executor's processes: ${toldFailure}` }, appeared, xcodebuild)
      } else if (claimed.size !== 1) {
        return giveUp({ class: 'setup_failed', message: 'No runner app appeared where this start runs it, so the executor answering is not tied to this start.' }, appeared, xcodebuild)
      }
      process.off('exit', lastResort)
      return { ok: true, process: runner, os: status.value.os, xcodebuild, runnerApps: [...claimed.values()] }
    }
    await sleep(Math.min(250, deadline.remainingMs))
  }
}

async function runnerAppsNow(options: StartExecutorOptions): Promise<RecordedProcess[] | string> {
  try {
    return (await listProcesses(options.tools, 10_000)).filter((entry) => options.isRunnerApp(entry.command))
  } catch (error) {
    return `Retest could not read the processes running (${errorMessage(error)}), so it cannot tell which runner app is this start's.`
  }
}

// The pid listening on a port of 127.0.0.1, as lsof names it in its field output (`p<pid>`).
async function listenerOf(tools: NativeTools, port: number): Promise<number | undefined> {
  const result = await runCommand(tools.lsof, ['-nP', `-iTCP@127.0.0.1:${port}`, '-sTCP:LISTEN', '-Fp'], { timeoutMs: 10_000, hiddenVariables: tools.hiddenVariables })
  const pids = result.stdout.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1)))
  return pids.length === 1 ? pids[0] : undefined
}

function refusedStart(message: string): FailedStart {
  return { ok: false, failure: { class: 'setup_failed', message }, leftRunning: [] }
}

/**
 * A port on 127.0.0.1 nothing listens on now. Another process may take it before it is used, which the executor's start
 * then reports.
 *
 * @example await freePort() // 53127
 */
export async function freePort(): Promise<number> {
  for (;;) {
    const port = await systemPort()
    if (!executorDefaultPorts.includes(port)) return port
  }
}

async function systemPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (address === null || typeof address === 'string') throw new Error('The system gave no port.')
  return address.port
}

/**
 * Whether something accepts TCP connections on the address.
 *
 * @example await isListening('127.0.0.1', 8100) // false
 */
export function isListening(host: string, port: number): Promise<boolean> {
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

// Reads the end of the log only: xcodebuild's output grows while the executor runs.
async function knownFailure(logFile: string): Promise<{ readonly message: string; readonly line: string } | undefined> {
  let text = ''
  try {
    const handle = await open(logFile, 'r')
    try {
      const { size } = await handle.stat()
      const length = Math.min(size, 64 * 1024)
      const buffer = Buffer.alloc(length)
      await handle.read(buffer, 0, length, size - length)
      text = buffer.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return undefined
  }
  for (const failure of knownFailures) {
    const line = text.split('\n').find((candidate) => failure.pattern.test(candidate))
    if (line !== undefined) return { message: failure.message, line: line.trim().slice(0, 300) }
  }
  return undefined
}


/**
 * Watches the processes an executor runs as and calls `lost` once when any of them is gone. xcodebuild can take tens of
 * seconds to notice that its runner app died, so the runner app's own pid is watched beside it. Returns a function that
 * stops the watch.
 *
 * @example const stop = watchExecutor([runner.pid, ...runnerAppPids], (pid) => lose(`pid ${pid} ended`))
 */
export function watchExecutor(pids: readonly number[], lost: (pid: number, problem?: string) => void): () => void {
  const timer = setInterval(() => {
    for (const pid of pids) {
      try {
        if (processExists(pid)) continue
        clearInterval(timer)
        lost(pid)
      } catch (error) {
        clearInterval(timer)
        lost(pid, `Retest could not read whether runner pid ${pid} remains: ${errorMessage(error)}`)
      }
      return
    }
  }, 500)
  timer.unref()
  return () => clearInterval(timer)
}


/**
 * Holds a port on every interface until `close`, refusing every connection it gets. WebDriverAgent starts its screen
 * stream on every interface whatever interface its HTTP server is given; holding the stream's port while the executor
 * starts makes that listener fail, and WebDriverAgent serves on without it. Nothing is served on the port meanwhile.
 *
 * @example const held = await holdPort(port); try { await startExecutor(options) } finally { await held.close() }
 */
export async function holdPort(port: number): Promise<{ close(): Promise<void> }> {
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // `::` without ipv6Only takes the port for IPv4 and IPv6 alike.
    server.listen({ port, host: '::', ipv6Only: false }, resolve)
  })
  return { close: () => new Promise((resolve) => server.close(() => resolve())) }
}

/**
 * Whether WebDriverAgent's log says its screen stream did not start, as it logs when its port is taken.
 *
 * @example await screenStreamRefused(logFile) // true
 */
export async function screenStreamRefused(logFile: string): Promise<boolean> {
  const text = await readFile(logFile, 'utf8').catch(() => '')
  return text.includes('Cannot init screenshots broadcaster service')
}
