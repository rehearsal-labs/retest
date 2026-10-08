import type { Failure } from '../protocol/failures.ts'
import type { ExecutorBuild, ExecutorName } from './executors.ts'
import type { NativeTools, RecordedProcess, StartedProcess } from './processes.ts'
import type { RequestBounds } from './webdriver-client.ts'
import { open, readFile, rm } from 'node:fs/promises'
import { connect, createServer } from 'node:net'
import { join } from 'node:path'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { errorCode } from '../shared/error-code.ts'
import { nativePins } from './executors.ts'
import { commandOf, describeCommand, endProblem, endRecorded, killRecordedNow, listProcesses, OwnedProcess, processExists, runCommand } from './processes.ts'
import { makeOwnedFolder, sweepOwnedFolders } from './temporary-folders.ts'
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

/** The processes a start has recorded so far, each with its command line and start. */
export type StartedProcesses = { readonly xcodebuild: StartedProcess; readonly runnerApps: readonly StartedProcess[]; readonly untied: readonly StartedProcess[] }

// The ports the executors serve on when told nothing, which another tool driving the same executor would use too.
const executorDefaultPorts: readonly number[] = Object.values(nativePins.executors).map((pin) => pin.defaultPort)

/**
 * A failed start: why, and the processes it recorded as its own and could not end. `idle` says the start was refused
 * before xcodebuild was started, so it left nothing running.
 */
export type FailedStart = { readonly ok: false; readonly failure: Failure; readonly leftRunning: readonly RecordedProcess[]; readonly idle?: true }

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
 * Starts an executor and waits until it answers `/status` as ready. First it deletes the run folders that Retest
 * processes now gone left in the temporary folder; one it cannot delete refuses the start. Only a runner app that appears during the start
 * can be this start's, and more than one refuses the start by name; the one tied to it, as `tie` says, is recorded
 * with its command line. When xcodebuild exits first, prints a line that explains a failed start, runs out of time, is
 * stopped or a process reading fails, only recorded and freshly verified executor processes are ended and the failure names
 * the log and anything left. While the start runs, the recorded runner app is killed if the Retest process exits.
 *
 * @example await startExecutor({ executor: 'mac2', build, destination: 'platform=macOS,arch=arm64', port, environment: {}, logFile, resultFolder, tools, bounds, isRunnerApp, tie: 'listening-port' })
 */
export async function startExecutor(options: StartExecutorOptions): Promise<{ readonly ok: true; readonly process: OwnedProcess; readonly os: string | undefined; readonly xcodebuild: StartedProcess; readonly runnerApps: readonly StartedProcess[] } | FailedStart> {
  const deadline = new Deadline(options.bounds.timeoutMs)
  if (executorDefaultPorts.includes(options.port)) return refusedStart(`Port ${options.port} is an executor's default port, which another tool driving the same executor would use; Retest runs an executor only on a port of its own.`)
  if (await isListening('127.0.0.1', options.port)) return refusedStart(`Something already listens on 127.0.0.1:${options.port}, the port the executor was to use.`)
  const swept = await sweepOwnedFolders(options.tools).catch((error: unknown) => ({ removed: [], kept: 0, problems: [`Retest could not look through the temporary folder for what earlier runs left: ${errorMessage(error)}`] }))
  if (swept.problems.length > 0) return refusedStart(`${swept.problems.join(' ')} Remove it, since it may hold what an earlier run typed.`)
  const before = await runnerAppsNow(options)
  if (typeof before === 'string') return refusedStart(before)
  let folder: string
  try {
    folder = await makeOwnedFolder('retest-executor-', options.tools)
  } catch (error) {
    return refusedStart(`Retest could not make the executor's temporary folder: ${errorMessage(error)}`)
  }
  const args = ['test-without-building', '-xctestrun', options.build.xctestrun, '-destination', options.destination, '-resultBundlePath', join(folder, 'result.xcresult'), '-derivedDataPath', join(folder, 'derived'), '-disableAutomaticPackageResolution']
  const xcodebuildPath = await selectedXcodebuild(options.tools)
  if (typeof xcodebuildPath !== 'string') {
    await rm(folder, { recursive: true, force: true })
    return refusedStart(xcodebuildPath.problem)
  }
  let runner: OwnedProcess
  try {
    runner = await OwnedProcess.start({ command: xcodebuildPath, args, logFile: options.logFile, environment: { ...options.environment, TEST_RUNNER_USE_PORT: String(options.port) }, hiddenVariables: options.tools.hiddenVariables, redact: options.redact ?? options.tools.redact, temporaryFolders: [folder] })
  } catch (error) {
    // The log could not be opened or the spawn failed, so no xcodebuild process exists.
    await rm(folder, { recursive: true, force: true })
    return refusedStart(`xcodebuild could not start the executor: ${errorMessage(error)}`)
  }
  const client = new ExecutorClient({ executor: options.executor, host: '127.0.0.1', port: options.port })
  const claimed = new Map<number, StartedProcess>()
  const lastResort = (): void => killRecordedNow(claimed.values(), options.tools)
  process.on('exit', lastResort)
  // Telling the caller can fail, as writing a lock record can; the start then stops what it started.
  let toldFailure: string | undefined
  let untiedTold: readonly StartedProcess[] = []
  const tell = (processes: Omit<StartedProcesses, 'untied'>, untied: readonly StartedProcess[] = untiedTold): void => {
    untiedTold = untied
    try {
      options.onProcesses?.({ ...processes, untied })
    } catch (error) {
      toldFailure ??= errorMessage(error)
    }
  }
  const giveUp = async (failure: Failure, appeared: readonly StartedProcess[] = [], xcodebuildRecord?: StartedProcess): Promise<FailedStart> => {
    const problems = await runner.stop(0)
    const leftRunning: RecordedProcess[] = []
    if ((await runner.processesRemain()) && xcodebuildRecord !== undefined) leftRunning.push(xcodebuildRecord)
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
  const xcodebuild: StartedProcess = { pid: runner.pid, command: xcodebuildCommand.command, startedAt: xcodebuildCommand.startedAt }
  tell({ xcodebuild, runnerApps: [] })
  if (toldFailure !== undefined) return giveUp({ class: 'setup_failed', message: `Retest could not record the executor's processes: ${toldFailure}` }, [], xcodebuild)
  const claim = (entry: StartedProcess): void => {
    if (claimed.has(entry.pid)) return
    claimed.set(entry.pid, entry)
    tell({ xcodebuild, runnerApps: [...claimed.values()] })
  }
  for (;;) {
    const now = await runnerAppsNow(options)
    if (typeof now === 'string') return giveUp({ class: 'setup_failed', message: now }, [], xcodebuild)
    // A runner app listed before the start, by pid and start, is not this start's.
    const appeared = now.filter((entry) => !before.some((earlier) => earlier.pid === entry.pid && earlier.startedAt === entry.startedAt))
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
    const finalRead = deadline.reached
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
    if (finalRead) return giveUp({ class: 'setup_failed', message: `The executor did not answer /status within ${options.bounds.timeoutMs} ms.` }, appeared, xcodebuild)
    await waitBeforeRead(deadline, 250)
  }
}

/** Where xcode-select puts its shim, which execs the selected Xcode's own tool under the same pid. */
export const xcodebuildShim = '/usr/bin/xcodebuild'

/**
 * The xcodebuild a start runs. The shim at /usr/bin/xcodebuild execs the selected Xcode's own xcodebuild under the
 * same pid, so `ps` shows another command line a moment after the start, and a record taken before it would not match
 * the process any more; the selected tool is run directly, as `xcrun --find` names it. Any other path is run as given.
 *
 * @example await selectedXcodebuild(systemTools) // '/Applications/Xcode.app/Contents/Developer/usr/bin/xcodebuild'
 */
export async function selectedXcodebuild(tools: NativeTools): Promise<string | { readonly problem: string }> {
  if (tools.xcodebuild !== xcodebuildShim) return tools.xcodebuild
  const found = await runCommand(tools.xcrun, ['--find', 'xcodebuild'], { timeoutMs: 30_000, hiddenVariables: tools.hiddenVariables })
  const path = found.stdout.trim()
  if (found.code !== 0 || !path.startsWith('/') || path.includes('\n')) return { problem: `Retest could not find the selected Xcode's xcodebuild: ${describeCommand('xcrun --find xcodebuild', found)}` }
  return path
}

async function runnerAppsNow(options: StartExecutorOptions): Promise<StartedProcess[] | string> {
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

// Every refusal through here comes before xcodebuild is started.
function refusedStart(message: string): FailedStart {
  return { ok: false, failure: { class: 'setup_failed', message }, leftRunning: [], idle: true }
}

/**
 * A port nothing holds now on either loopback address, 127.0.0.1 or ::1, below the system's ephemeral range. The
 * executor serves on localhost and binds without reusing a port, so a socket on either address that holds the port,
 * even a connected one, fails its start. A Node listener reuses addresses and cannot see a connected socket's port,
 * so the port is drawn from below the range connected sockets take theirs from, and both addresses are probed for a
 * listener. Another process may take it before it is used, which the executor's start then reports.
 *
 * @example await freePort() // 31127
 */
export async function freePort(): Promise<number> {
  for (let tries = 0; tries < 200; tries += 1) {
    const port = lowestPort + Math.floor(Math.random() * (firstEphemeralPort - lowestPort))
    if (!executorDefaultPorts.includes(port) && (await freeOnLoopback(port))) return port
  }
  throw new Error(`Retest found no free port from ${lowestPort} to ${firstEphemeralPort - 1} on 127.0.0.1 and ::1 in 200 tries.`)
}

// macOS gives connected sockets their ports from 49152 up (net.inet.ip.portrange.first); the draw stays below that.
const firstEphemeralPort = 49152
const lowestPort = 20000

/**
 * Whether nothing listens on `port` at 127.0.0.1 or ::1, as a listener of Retest's own finds by taking it on each in
 * turn and letting it go again. A host without IPv6 has no ::1 for anything to hold.
 *
 * @example await freeOnLoopback(31127) // true
 */
export async function freeOnLoopback(port: number): Promise<boolean> {
  for (const host of ['127.0.0.1', '::1']) {
    const server = createServer()
    const taken = await new Promise<boolean>((resolve, reject) => {
      server.once('error', (error) => {
        const code = errorCode(error)
        if (code === 'EADDRINUSE') resolve(true)
        else if (host === '::1' && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) resolve(false)
        else reject(error)
      })
      server.listen({ port, host }, () => resolve(false))
    })
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
    if (taken) return false
  }
  return true
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
