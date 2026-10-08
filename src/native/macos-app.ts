import type { NativeRuntime, NativeRuntimeIdentity, ResetPolicy } from '../browser/contract.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { DesktopLock } from './desktop-lock.ts'
import type { ExecutorBuild, NativePinSet } from './executors.ts'
import type { AppBundle, NativeExecutionIdentity, OperatingSystem } from './identity.ts'
import type { NativeTools, RecordedProcess, StartedProcess } from './processes.ts'
import type { AppProcessReading, CaptureSource, DriverAnswer, LaunchSpec, NativeAppDriver, NativeSessionOptions } from './session.ts'
import type { ScopedSource } from './source-scope.ts'
import type { ExecutorAppState, ExecutorSession, Rect, RequestBounds } from './webdriver-client.ts'
import { rmSync } from 'node:fs'
import { readFile, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { windowImageGraceMs } from './capture.ts'
import { defaultDesktopLock, takeDesktopLock } from './desktop-lock.ts'
import { freePort, isListening, startExecutor, watchExecutor } from './executor-process.ts'
import { checkXcode, nativePins } from './executors.ts'
import { appNames, nativeExecutionIdentity, readAppBundle, readMacosVersion, runtimeIdentity } from './identity.ts'
import { pngSize } from './png.ts'
import type { ListedProcess } from './processes.ts'
import { commandOf, describeCommand, endProblem, endRecorded, killRecordedNow, listProcesses, runCommand } from './processes.ts'
import { macosResetPolicy } from './reset-policy.ts'
import { NativeAppSession, NativeError, SerialLane } from './session.ts'
import { makeOwnedFolder } from './temporary-folders.ts'
import { ExecutorClient } from './webdriver-client.ts'

// The macOS runner on the Mac Retest runs on. A macOS UI test takes the interactive desktop: focus, the pointer and the
// keyboard. So one runner serves the desktop, one session at a time opens on it, and every request of that session
// runs in turn. The app under test is launched at its path, never by its bundle id alone, and Retest touches only the
// process it launched. Its processes are read by bundle id from Launch Services, as XCTest finds a running copy by its
// bundle id wherever that copy was launched from.

/** What starting the desktop's runner needs. */
export type MacosDesktopOptions = {
  /** A macOS runner build for the tested set, from `ensureExecutorBuild`. */
  readonly build: ExecutorBuild
  readonly pins?: NativePinSet | undefined
  readonly tools: NativeTools
  /** Where xcodebuild's output goes. */
  readonly logFolder: string
  readonly redact?: ((text: string) => string) | undefined
  readonly hiddenVariables?: readonly string[] | undefined
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
  /** The runner's port on 127.0.0.1; a free one by default, never the executor's default of 10100. */
  readonly port?: number | undefined
  /** The lock that holds the desktop across processes; `defaultDesktopLock()` by default. */
  readonly desktopLock?: string | undefined
}

const runnerExecutable = 'WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner'
// macOS's own process that shows the Automation Mode overlay while an XCTest runner drives the desktop.
const automationModeUi = '/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI'
// One runner per interactive desktop: this process starts no second one while one is starting or open.
let openDesktop: MacosDesktop | 'starting' | undefined

/**
 * Whether Automation Mode can be enabled without an administrator answering a dialog, from `automationmodetool`. A
 * Mac that would show the dialog fails setup before the runner starts, so no dialog appears.
 *
 * @example await automationModeProblem(systemTools) // undefined on a Mac set up to run unattended
 */
export async function automationModeProblem(tools: NativeTools, signal?: AbortSignal): Promise<Failure | undefined> {
  const result = await runCommand(tools.automationModeTool, [], { timeoutMs: 15_000, signal, hiddenVariables: tools.hiddenVariables })
  const said = `${result.stdout}\n${result.stderr}`
  if (result.code !== 0) return { class: 'setup_failed', message: `Retest could not read whether Automation Mode needs an administrator: ${describeCommand('automationmodetool', result)}.`, details: { automationMode: 'unreadable' } }
  if (/Automation Mode is enabled/i.test(said) || /DOES NOT REQUIRE user authentication/i.test(said)) return undefined
  if (/requires user authentication/i.test(said)) {
    return { class: 'setup_failed', message: 'Enabling Automation Mode on this Mac needs an administrator to answer a dialog. On a Mac that runs tests unattended, run `sudo automationmodetool enable-automationmode-without-authentication` once.', details: { automationMode: 'needs_administrator' } }
  }
  return { class: 'setup_failed', message: 'Retest could not tell from automationmodetool whether Automation Mode needs an administrator.', details: { automationMode: 'unreadable' } }
}

/**
 * The desktop's one macOS runner. Apps open on it one session at a time.
 */
export class MacosDesktop {
  readonly port: number
  readonly os: OperatingSystem
  readonly build: ExecutorBuild
  readonly #options: MacosDesktopOptions
  readonly #runner: Awaited<ReturnType<typeof startExecutor>> & { readonly ok: true }
  readonly #client: ExecutorClient
  readonly #sessions = new SerialLane()
  readonly #open = new Set<NativeAppSession>()
  readonly #listeners = new Set<(reason: string) => void>()
  readonly #folder: string
  readonly #runnerApps: readonly StartedProcess[]
  readonly #lock: DesktopLock
  readonly #lastResort: () => void
  readonly #stopWatch: () => void
  #lost: string | undefined
  #closing: Promise<void> | undefined

  /**
   * Starts the runner: checks Xcode against the tested set and that Automation Mode will not ask anyone, refuses when a
   * macOS runner already runs on this Mac, then starts it on a port of its own, bound to 127.0.0.1. A refusal that
   * comes before the runner was started, with the desktop lock let go again, says it is `idle`.
   */
  static async start(options: MacosDesktopOptions): Promise<{ readonly ok: true; readonly desktop: MacosDesktop } | DesktopRefusal> {
    options = { ...options, tools: { ...options.tools, hiddenVariables: options.hiddenVariables ?? options.tools.hiddenVariables, redact: options.redact ?? options.tools.redact } }
    const pins = options.pins ?? nativePins
    const deadline = new Deadline(options.timeoutMs)
    if (process.platform !== 'darwin') return idle('macOS apps need a Mac.')
    if (options.build.executor !== 'mac2') return idle(`The macOS desktop needs a build of the macOS runner, not ${options.build.executor}.`)
    if (openDesktop !== undefined) return idle('This process already runs the macOS runner for this desktop; native work on one desktop goes through that runner, one session at a time.')
    openDesktop = 'starting'
    let started: Awaited<ReturnType<typeof MacosDesktop.start>> = refused('The desktop did not start.')
    try {
      started = await MacosDesktop.#start(options, pins, deadline)
    } catch (error) {
      started = refused(`Starting the macOS runner failed: ${errorMessage(error)}`)
    } finally {
      openDesktop = started.ok ? started.desktop : undefined
    }
    return started
  }

  static async #start(options: MacosDesktopOptions, pins: NativePinSet, deadline: Deadline): Promise<{ readonly ok: true; readonly desktop: MacosDesktop } | DesktopRefusal> {
    // Both checks run short tools that hold nothing of the desktop.
    const xcode = await checkXcode(options.tools, pins.toolchain, options.signal)
    if (xcode !== undefined) return { ok: false, failure: xcode, idle: true }
    const automation = await automationModeProblem(options.tools, options.signal)
    if (automation !== undefined) return { ok: false, failure: automation, idle: true }
    const runnerPath = join(options.build.products, runnerExecutable)
    const taken = await takeDesktopLock({ path: options.desktopLock ?? defaultDesktopLock(), tools: options.tools })
    if (!taken.ok) return taken
    const lock = taken.lock
    const recorded: { runnerApps: readonly RecordedProcess[] } = { runnerApps: [] }
    const exitHook = (): void => {
      killRecordedNow(recorded.runnerApps, options.tools)
      lock.releaseNow()
    }
    process.on('exit', exitHook)
    // Whether xcodebuild may have been started; until then a refusal that lets the lock go has left nothing behind.
    let launching = false
    // A start that could not end what it recorded keeps the lock, which names those processes for the next start.
    const fail = async (failure: Failure, folder?: string, leftRunning: readonly RecordedProcess[] = [], startIdle = false): Promise<DesktopRefusal> => {
      if (folder !== undefined) await rm(folder, { recursive: true, force: true })
      if (leftRunning.length > 0) return { ok: false, failure }
      process.off('exit', exitHook)
      try {
        await lock.release()
      } catch (error) {
        return { ok: false, failure: { ...failure, details: { ...failure.details, also: `cleanup_failed: ${errorMessage(error)}` } } }
      }
      return startIdle || !launching ? { ok: false, failure, idle: true } : { ok: false, failure }
    }
    try {
      // After the lock, a runner still running is not one a Retest process recorded, so it is refused by name.
      const others = (await listProcesses(options.tools, 10_000)).filter((entry) => entry.command.includes(runnerExecutable))
      if (others.length > 0) return await fail({ class: 'setup_failed', message: `A macOS runner Retest cannot recognise as its own runs on this Mac (pid ${others.map((entry) => entry.pid).join(', ')}), so something else drives the desktop. Retest never stops a runner it did not start.` })
      const os = await readMacosVersion(options.tools, options.signal)
      if (os === undefined) return await fail({ class: 'setup_failed', message: 'Retest could not read the macOS version with sw_vers.' })
      const folder = await makeOwnedFolder('retest-macos-', options.tools)
      const port = options.port ?? (await freePort())
      launching = true
      // startExecutor refuses an executor's default port, which `freePort` never gives.
      const runner = await startExecutor({
      executor: 'mac2',
      build: options.build,
      destination: `platform=macOS,arch=${options.build.architecture}`,
      port,
      environment: { TEST_RUNNER_USE_HOST: '127.0.0.1' },
      logFile: join(options.logFolder, `macos-runner-${process.pid}-${port}.log`),
      resultFolder: folder,
      tools: options.tools,
      bounds: { timeoutMs: deadline.commandTimeoutMs, signal: options.signal },
      isRunnerApp: (command) => command.startsWith(runnerPath),
      tie: 'listening-port',
      onProcesses: (processes) => {
        recorded.runnerApps = processes.runnerApps
        lock.note(processes)
      },
    })
    if (!runner.ok) return await fail(runner.failure, folder, runner.leftRunning, runner.idle === true)
    process.off('exit', exitHook)
    return { ok: true, desktop: new MacosDesktop({ options, runner, port, os, folder, runnerApps: runner.runnerApps, lock }) }
    } catch (error) {
      return await fail({ class: 'setup_failed', message: `Starting the macOS runner failed: ${errorMessage(error)}` })
    }
  }

  private constructor(parts: { readonly options: MacosDesktopOptions; readonly runner: Awaited<ReturnType<typeof startExecutor>> & { readonly ok: true }; readonly port: number; readonly os: OperatingSystem; readonly folder: string; readonly runnerApps: readonly StartedProcess[]; readonly lock: DesktopLock }) {
    this.#options = parts.options
    this.build = parts.options.build
    this.#runner = parts.runner
    this.port = parts.port
    this.os = parts.os
    this.#folder = parts.folder
    this.#runnerApps = parts.runnerApps
    this.#lock = parts.lock
    // When the Retest process exits without closing the desktop, the runner app goes with it and the desktop is let go;
    // xcodebuild's recorded processes have their own verified exit hook. The folder goes too, with any window image a
    // capture wrote and had not yet removed. A SIGKILL of the Retest process runs neither: the next start recognises what
    // is left by the lock, and the next native start deletes the folder by its maker's record.
    this.#lastResort = () => {
      killRecordedNow(parts.runnerApps, parts.options.tools)
      parts.lock.releaseNow()
      try {
        rmSync(parts.folder, { recursive: true, force: true })
      } catch {
        // Throwing here would replace the exit code Retest chose; the next native start's sweep deletes the folder.
      }
    }
    process.on('exit', this.#lastResort)
    this.#client = new ExecutorClient({ executor: 'mac2', host: '127.0.0.1', port: parts.port })
    this.#stopWatch = watchExecutor(parts.runnerApps.map((entry) => entry.pid), (pid, problem) => {
      if (this.#closing === undefined) this.#lose(problem ?? `The macOS runner app (pid ${pid}) ended.`)
    })
    void parts.runner.process.exited.then((exit) => {
      if (this.#closing !== undefined) return
      this.#lose(`The macOS runner's xcodebuild ended (${exit.signal === null ? `exit code ${exit.code ?? 'unknown'}` : `signal ${exit.signal}`}).`)
    })
  }

  /** The processes the runner runs as: xcodebuild, and the runner app macOS launched for it. */
  get processIds(): readonly number[] {
    return [this.#runner.process.pid, ...this.#runnerApps.map((entry) => entry.pid)]
  }

  /** The executor processes this desktop recorded at startup, with their command lines and starts. */
  get executorProcesses(): readonly StartedProcess[] {
    return [this.#runner.xcodebuild, ...this.#runnerApps]
  }

  get connected(): boolean {
    return this.#lost === undefined && this.#closing === undefined
  }

  /** Tells `listener` once when the runner is lost, even when that happened before it was added. */
  onDisconnect(listener: (reason: string) => void): () => void {
    if (this.#lost !== undefined) {
      const reason = this.#lost
      queueMicrotask(() => listener(reason))
      return () => undefined
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** The runtime of one app at `appPath`, read from its bundle. Opening it starts nothing. */
  async openApp(appPath: string, signal?: AbortSignal): Promise<{ readonly ok: true; readonly runtime: MacosAppRuntime } | { readonly ok: false; readonly failure: Failure }> {
    const resolved = await realpath(appPath).catch(() => undefined)
    if (resolved === undefined) return refused(`There is no app at ${appPath}.`)
    const bundle = await readAppBundle(resolved, 'macos', this.#options.tools, signal)
    if (!bundle.ok) return bundle
    const execution = nativeExecutionIdentity({ platform: 'macos', bundle: bundle.bundle, os: this.os, build: this.build })
    return { ok: true, runtime: new MacosAppRuntime(this, bundle.bundle, execution) }
  }

  /**
   * Opens a session of an app on the desktop, once the session before it is disposed: a runner session that launches
   * nothing, and the session that drives the app's lifecycle through it.
   */
  async openSession(runtime: MacosAppRuntime, options: NativeSessionOptions, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly session: NativeAppSession; readonly client: ExecutorClient; readonly executor: ExecutorSession } | { readonly ok: false; readonly failure: Failure }> {
    if (!this.connected) return refused(`The macOS runner is ${this.#lost === undefined ? 'closing' : `lost: ${this.#lost}`}.`)
    const deadline = new Deadline(timeoutMs)
    const turn = await this.#sessions.acquire(signal, timeoutMs)
    if (!turn.ok) return refused(turn.reason === 'stopped' ? 'Opening the session was stopped while another session held the desktop.' : `Another session held the desktop for ${timeoutMs} ms.`)
    const created = await this.#client.createSession({ timeoutMs: deadline.commandTimeoutMs, signal })
    if (created.status !== 'answered') {
      turn.release()
      return refused(`The macOS runner did not open a session: ${created.status === 'refused' ? `${created.error}: ${created.message}` : created.message}`)
    }
    let session: NativeAppSession | undefined
    const driver = new MacosAppDriver({
      runtime,
      tools: this.#options.tools,
      executor: created.value,
      folder: this.#folder,
      recordedPids: () => session?.processIds ?? [],
      release: () => {
        if (session !== undefined) this.#open.delete(session)
        turn.release()
      },
    })
    session = new NativeAppSession(driver, options)
    this.#open.add(session)
    return { ok: true, session, client: this.#client, executor: created.value }
  }

  /**
   * Ends the runner within `timeoutMs`: disposes the open session, asks the runner to stop, ends its process group and
   * the runner app if they stay, and checks that neither is left and the port is closed. Rejects with a `NativeError`
   * naming what is left. A second call waits for the first.
   */
  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<void> {
    this.#stopWatch()
    const deadline = new Deadline(timeoutMs)
    const problems: string[] = []
    try {
      for (const session of this.#open) await session.dispose(Math.min(15_000, deadline.commandTimeoutMs)).catch((error: unknown) => problems.push(errorMessage(error)))
      const runner = this.#runner.process
      // A lost runner has nothing to stop, and its xcodebuild can take tens of seconds to notice, so it is ended at once.
      const lost = this.#lost !== undefined
      if (!lost && runner.exit === undefined) await this.#client.shutdown({ timeoutMs: Math.min(5000, deadline.commandTimeoutMs) })
      problems.push(...(await runner.stop(lost ? 0 : Math.min(30_000, deadline.remainingMs))))
      // Only the runner app this desktop recorded is ended or looked for, and only while its command line is still the one
      // recorded; another start's runner of the same build is not this desktop's.
      for (const entry of this.#runnerApps) {
        const problem = endProblem(entry, await endRecorded(this.#options.tools, entry, 5000))
        if (problem !== undefined) problems.push(`The runner app: ${problem}`)
      }
      problems.push(...(await runner.finishOutput(deadline.commandTimeoutMs)))
      if (await isListening('127.0.0.1', this.port)) problems.push(`Something still listens on 127.0.0.1:${this.port}.`)
      await rm(this.#folder, { recursive: true, force: true }).catch((error: unknown) => problems.push(`Could not remove ${this.#folder}: ${errorMessage(error)}`))
      // A clean close leaves the record naming nothing, so no later start reads one of these pids again.
      if (problems.length === 0) {
        try {
          this.#lock.clear()
        } catch (error) {
          problems.push(`Retest could not clear the desktop record ${this.#lock.recordPath}: ${errorMessage(error)}`)
        }
      }
      if (problems.length === 0) {
        process.off('exit', this.#lastResort)
        await this.#lock.release()
      }
    } finally {
      if (openDesktop === this) openDesktop = undefined
    }
    if (problems.length > 0) throw new NativeError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  #lose(reason: string): void {
    if (this.#lost !== undefined) return
    this.#lost = reason
    for (const session of this.#open) session.markLost({ class: 'session_lost', message: reason })
    for (const listener of this.#listeners) listener(reason)
    this.#listeners.clear()
  }
}

/**
 * One app on the desktop, at its path, as a native runtime: its identity, and sessions opened on the desktop's runner.
 * Closing it disposes its open session; the runner belongs to the desktop.
 */
export class MacosAppRuntime implements NativeRuntime {
  readonly desktop: MacosDesktop
  readonly bundle: AppBundle
  readonly execution: NativeExecutionIdentity
  readonly #sessions = new Set<NativeAppSession>()
  #closing: Promise<void> | undefined

  constructor(desktop: MacosDesktop, bundle: AppBundle, execution: NativeExecutionIdentity) {
    this.desktop = desktop
    this.bundle = bundle
    this.execution = execution
  }

  get identity(): NativeRuntimeIdentity {
    return runtimeIdentity(this.execution, this.desktop.processIds)
  }

  /** The port of this runtime's owned desktop executor. */
  get port(): number {
    return this.desktop.port
  }

  /** The reset policy every session of this app starts under. */
  get resetPolicy(): ResetPolicy {
    return macosResetPolicy.contract
  }

  get connected(): boolean {
    return this.desktop.connected && this.#closing === undefined
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    return this.desktop.onDisconnect(listener)
  }

  /** Opens a session of this app on the desktop's runner, once the desktop is free. */
  async openSession(options: NativeSessionOptions, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly session: NativeAppSession; readonly client: ExecutorClient; readonly executor: ExecutorSession } | { readonly ok: false; readonly failure: Failure }> {
    if (this.#closing !== undefined) return refused('The app runtime is closing.')
    const opened = await this.desktop.openSession(this, options, timeoutMs, signal)
    if (opened.ok) this.#sessions.add(opened.session)
    return opened
  }

  /** Disposes the app's sessions within `timeoutMs`. Rejects with a `NativeError` naming what could not be cleaned up. */
  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<void> {
    const problems: string[] = []
    for (const session of this.#sessions) await session.dispose(timeoutMs).catch((error: unknown) => problems.push(errorMessage(error)))
    if (problems.length > 0) throw new NativeError({ class: 'cleanup_failed', message: problems.join(' ') })
  }
}

/** The driver a session of a macOS app runs on. */
class MacosAppDriver implements NativeAppDriver {
  readonly platform = 'macos' as const
  readonly captureSources: readonly CaptureSource[] = ['window-crop']
  readonly bundle: AppBundle
  readonly identity: NativeExecutionIdentity
  readonly resetPolicy: ResetPolicy
  readonly runtimeProcessIds: readonly number[]
  readonly #tools: NativeTools
  readonly #executor: ExecutorSession
  readonly #folder: string
  readonly #recordedPids: () => readonly number[]
  readonly #release: () => void
  #released = false
  #captures = 0

  constructor(parts: { readonly runtime: MacosAppRuntime; readonly tools: NativeTools; readonly executor: ExecutorSession; readonly folder: string; readonly recordedPids: () => readonly number[]; readonly release: () => void }) {
    this.bundle = parts.runtime.bundle
    this.identity = parts.runtime.execution
    this.resetPolicy = parts.runtime.resetPolicy
    this.runtimeProcessIds = parts.runtime.desktop.processIds
    this.#tools = parts.tools
    this.#executor = parts.executor
    this.#folder = parts.folder
    this.#recordedPids = parts.recordedPids
    this.#release = parts.release
  }

  async install(): Promise<DriverAnswer<unknown>> {
    return { status: 'failed', input: 'not_sent', failure: { class: 'unsupported', message: 'A macOS app is not installed: Retest launches it where it is, at its path.' } }
  }

  // XCTest launches by bundle id behind the path, so a copy running from anywhere would be brought to the front in
  // place of a new launch, and the launch would terminate none of it. Any running copy blocks the launch, and so does
  // a reading that failed: Retest launches only when it saw that nothing runs.
  async launchBlocker(bounds: RequestBounds): Promise<Failure | undefined> {
    const reading = await macosAppProcesses(this.#tools, this.bundle.bundleId, bounds)
    if (!reading.ok) return { class: 'not_actionable', message: `Retest could not read whether a copy of ${this.bundle.bundleId} runs (${reading.problem}), so it launched nothing.` }
    if (reading.listed === 0) return undefined
    const which = reading.processes.length > 0 ? ` (pid ${reading.processes.map((entry) => entry.pid).join(', ')})` : ''
    return { class: 'not_actionable', message: `A copy of ${this.bundle.bundleId} is already running${which}. Retest never terminates a copy it did not start; quit it first.` }
  }

  launch(launch: LaunchSpec, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.launchApp({ target: { path: this.bundle.appPath }, ...launch }, bounds)
  }

  activate(bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.activateApp({ path: this.bundle.appPath }, bounds)
  }

  terminate(bounds: RequestBounds): Promise<DriverAnswer<boolean>> {
    return this.#executor.terminateApp({ path: this.bundle.appPath }, bounds)
  }

  state(bounds: RequestBounds): Promise<DriverAnswer<ExecutorAppState>> {
    return this.#executor.appState({ path: this.bundle.appPath }, bounds)
  }

  async processState(bounds: RequestBounds): Promise<AppProcessReading> {
    const reading = await macosAppProcesses(this.#tools, this.bundle.bundleId, bounds)
    if (!reading.ok) return reading
    return { ok: true, running: reading.processes.length > 0, pids: reading.processes.map((entry) => entry.pid), processes: reading.processes }
  }

  // The window server draws one window from its number, so the image holds the app's own window and none of another
  // window over it, whether the app is in front or not. The window is the one of the session's recorded processes that
  // the window server lists on screen where the app's tree places it, read right before the image and right after it,
  // with the same number and owner both times. A minimised or hidden window is not on screen and is not captured. The
  // image needs Screen Recording for the app Retest runs under, which `screenRecordingAllowed` reads; the runner's
  // display capture never did, as XCTest takes it. The window's rounded corners come back transparent.
  async capture(_source: CaptureSource, bounds: RequestBounds): Promise<DriverAnswer<Uint8Array>> {
    const deadline = new Deadline(bounds.timeoutMs)
    const part = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
    const pids = this.#recordedPids()
    if (pids.length === 0) return failedCapture('The session has recorded no process of the app, so Retest cannot tell which window is the app\'s. Retest captured nothing.')
    const tree = await this.source(part())
    if (tree.status !== 'answered') return tree
    const frame = tree.value.window
    if (frame === undefined) return failedCapture('The app has no window to capture.')
    const late = outOfTime(deadline, 'reading which windows are on screen')
    if (late !== undefined) return late
    const before = appWindow(await windowsOnScreen(this.#tools, part()), pids, frame)
    if (!before.ok) return failedCapture(`${before.problem} Retest captured nothing.`, before.absent === true ? { transient: true } : {})
    const file = join(this.#folder, `window-${++this.#captures}.png`)
    let answer: DriverAnswer<Uint8Array>
    try {
      answer = await this.#windowImage({ window: before.window, pids, frame, file, deadline, signal: bounds.signal })
    } catch (error) {
      answer = failedCapture(`The window's image could not be read: ${errorMessage(error)}`)
    }
    try {
      await rm(file, { force: true })
    } catch (error) {
      answer = failedCapture(`Retest could not remove the window's image ${file}: ${errorMessage(error)}`)
    }
    return answer
  }

  // Asks screencapture for the window's image into `file`, without its shadow or a sound, then reads the window list
  // again and hands over the PNG as it was written, HiDPI pixels and all. No command starts once the deadline is
  // reached, since each one may run its kill grace past the time it is given.
  async #windowImage(asked: { readonly window: ScreenWindow; readonly pids: readonly number[]; readonly frame: Rect; readonly file: string; readonly deadline: Deadline; readonly signal: AbortSignal | undefined }): Promise<DriverAnswer<Uint8Array>> {
    const { window, pids, frame, file, deadline, signal } = asked
    const late = outOfTime(deadline, 'asking for the window\'s image')
    if (late !== undefined) return late
    const started = performance.now()
    const shot = await runCommand(this.#tools.screencapture, ['-l', String(window.number), '-o', '-x', '-t', 'png', file], { timeoutMs: deadline.commandTimeoutMs, signal, hiddenVariables: this.#tools.hiddenVariables, graceMs: windowImageGraceMs })
    const durationMs = Math.round(performance.now() - started)
    if (shot.timedOut) return failedCapture(`macOS gave no image of the app's window in time (${describeCommand('screencapture', shot)}). Retest captured nothing.`, { class: 'timeout' })
    if (shot.stopped) return failedCapture('The capture was stopped while macOS drew the window\'s image. Retest captured nothing.')
    if (shot.code !== 0 || shot.cleanupProblems.length > 0) return failedCapture(`macOS gave no image of the app's window (${describeCommand('screencapture', shot)}). The image needs Screen Recording for ${screenRecordingHolder}: ${screenRecordingGrant}. npx retest doctor checks it.`)
    const lateAfter = outOfTime(deadline, 'reading which windows are on screen after the image')
    if (lateAfter !== undefined) return lateAfter
    const after = appWindow(await windowsOnScreen(this.#tools, { timeoutMs: deadline.commandTimeoutMs, signal }), pids, frame)
    if (!after.ok) return failedCapture(`After the image was taken: ${after.problem} Retest captured nothing.`)
    if (after.window.number !== window.number || after.window.pid !== window.pid) return failedCapture(`The app's window changed while its image was taken (window ${window.number} of pid ${window.pid}, then window ${after.window.number} of pid ${after.window.pid}). Retest captured nothing.`)
    const bytes = new Uint8Array(await readFile(file))
    const size = pngSize(bytes)
    if (size === undefined) return failedCapture('screencapture wrote a file that is not a PNG. Retest captured nothing.')
    const scale = size.width / window.width
    if (!Number.isInteger(scale) || scale < 1 || Math.round(window.height * scale) !== size.height) return failedCapture(`The window's image is ${size.width}x${size.height}, not the ${window.width}x${window.height}-point window at a whole scale. Retest captured nothing.`)
    return { status: 'answered', value: bytes, durationMs }
  }

  source(bounds: RequestBounds, redact?: (text: string) => string): Promise<DriverAnswer<ScopedSource>> {
    return this.#executor.ownedSource({ platform: 'macos', bundleId: this.bundle.bundleId, appNames: appNames(this.bundle), ...(redact === undefined ? {} : { redact }) }, bounds)
  }

  // Each process the session recorded is ended only while its command line is still the recorded one.
  async forceEnd(processes: readonly RecordedProcess[], bounds: RequestBounds): Promise<string[]> {
    const left: string[] = []
    for (const entry of processes) {
      const problem = endProblem(entry, await endRecorded(this.#tools, entry, Math.min(5000, bounds.timeoutMs)))
      if (problem !== undefined) left.push(`${this.bundle.bundleId}: ${problem}`)
    }
    return left
  }

  async endExecutorSession(bounds: RequestBounds): Promise<string[]> {
    const ended = await this.#executor.end(bounds)
    return ended.status === 'answered' || ended.status === 'refused' ? [] : [`The runner session did not end: ${ended.message}`]
  }

  released(): void {
    if (this.#released) return
    this.#released = true
    this.#release()
  }
}

/**
 * The processes of the apps Launch Services lists under a bundle id, wherever each copy was launched from, with their
 * command lines and starts; `listed` counts the apps it lists, including one whose process was gone before it could be
 * read.
 *
 * @example await macosAppProcesses(systemTools, 'com.apple.TextEdit', { timeoutMs: 10_000 }) // { ok: true, listed: 1, processes: [{ pid: 4242, command: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit', startedAt: 'Mon Oct 5 11:18:31 2026' }] }
 */
export async function macosAppProcesses(tools: NativeTools, bundleId: string, bounds: RequestBounds): Promise<{ readonly ok: true; readonly listed: number; readonly processes: readonly StartedProcess[] } | { readonly ok: false; readonly problem: string }> {
  // The readings share the one budget, and none starts once it is spent, since each may run its kill grace past it.
  const deadline = new Deadline(Math.max(0, Math.min(maxTimeout, Math.floor(bounds.timeoutMs))))
  const part = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
  const spent = { ok: false, problem: `Retest used its ${deadline.budgetMs} ms before it had read every process of ${bundleId}.` } as const
  const found = await runCommand(tools.lsappinfo, ['find', `bundleid=${bundleId}`], { ...part(), hiddenVariables: tools.hiddenVariables })
  if (found.code !== 0) return { ok: false, problem: describeCommand('lsappinfo find', found) }
  const applications = [...found.stdout.matchAll(/ASN:(0x[0-9a-f]+-0x[0-9a-f]+)/gi)].map((match) => match[1] ?? '')
  const processes: StartedProcess[] = []
  for (const application of applications) {
    if (deadline.reached) return spent
    const info = await runCommand(tools.lsappinfo, ['info', '-only', 'pid,bundleid', `ASN:${application}:`], { ...part(), hiddenVariables: tools.hiddenVariables })
    if (info.code !== 0) return { ok: false, problem: describeCommand('lsappinfo info', info) }
    // An app that quit since the listing prints nothing; one whose number another app took names another bundle.
    if (/bundleID="([^"]*)"/.exec(info.stdout)?.[1] !== bundleId) continue
    const pid = Number(/\bpid = (\d+)/.exec(info.stdout)?.[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    if (deadline.reached) return spent
    const presence = await commandOf(tools, pid, deadline.commandTimeoutMs)
    if (presence.state === 'unreadable') return { ok: false, problem: presence.problem }
    if (presence.state === 'present') processes.push({ pid, command: presence.command, startedAt: presence.startedAt })
  }
  return { ok: true, listed: applications.length, processes }
}

/** A window as the window server lists it: its owner's pid, its layer, its frame in points and its window number. */
export type ScreenWindow = { readonly pid: number; readonly layer: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly number: number }

// Asks the window server, through JavaScript for Automation, for the windows on screen front to back: owner, layer,
// frame and window number only, never a title. Reading this list needs no permission and raises no prompt.
const windowListScript = [
  "ObjC.import('CoreGraphics')",
  'const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))',
  'const out = []',
  'for (let index = 0; index < list.count; index += 1) {',
  '  const window = list.objectAtIndex(index)',
  "  const frame = window.objectForKey('kCGWindowBounds')",
  "  out.push([ObjC.unwrap(window.objectForKey('kCGWindowOwnerPID')), ObjC.unwrap(window.objectForKey('kCGWindowLayer')), ObjC.unwrap(frame.objectForKey('X')), ObjC.unwrap(frame.objectForKey('Y')), ObjC.unwrap(frame.objectForKey('Width')), ObjC.unwrap(frame.objectForKey('Height')), ObjC.unwrap(window.objectForKey('kCGWindowNumber'))])",
  '}',
  'JSON.stringify(out)',
].join('\n')

/**
 * The windows on screen, front to back, as the window server lists them, or why they could not be read.
 *
 * @example await windowsOnScreen(systemTools, { timeoutMs: 5000 }) // [{ pid: 601, layer: 24, x: 0, y: 0, width: 1728, height: 33, number: 23599 }, …]
 */
export async function windowsOnScreen(tools: NativeTools, bounds: RequestBounds): Promise<ScreenWindow[] | string> {
  const result = await runCommand(tools.osascript, ['-l', 'JavaScript', '-e', windowListScript], { ...bounds, hiddenVariables: tools.hiddenVariables })
  if (result.code !== 0) return describeCommand('osascript', result)
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    return 'the window list is not JSON'
  }
  if (!Array.isArray(parsed)) return 'the window list is not a list'
  const windows: ScreenWindow[] = []
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 7 || !entry.every((value) => typeof value === 'number')) return 'a window entry is not seven numbers'
    const [pid = 0, layer = 0, x = 0, y = 0, width = 0, height = 0, number = 0] = entry
    windows.push({ pid, layer, x, y, width, height, number })
  }
  return windows
}

/**
 * The app's window as the window server lists it on screen: the one window of `pids` whose frame matches the frame the
 * app's tree gives, within a point; or why there is not exactly one, `absent` when there is none, or why the list could
 * not be read.
 *
 * @example appWindow(await windowsOnScreen(systemTools, bounds), [4242], { x: 20, y: 60, width: 700, height: 480 }) // { ok: true, window: { pid: 4242, layer: 0, x: 20, y: 60, width: 700, height: 480, number: 9113 } }
 */
export function appWindow(windows: readonly ScreenWindow[] | string, pids: readonly number[], frame: Rect): { readonly ok: true; readonly window: ScreenWindow } | { readonly ok: false; readonly problem: string; readonly absent?: true } {
  if (typeof windows === 'string') return { ok: false, problem: `Retest could not read which windows are on screen (${windows}).` }
  const near = (first: number, second: number): boolean => Math.abs(first - second) <= 1
  const matching = windows.filter((entry) => pids.includes(entry.pid) && near(entry.x, frame.x) && near(entry.y, frame.y) && near(entry.width, frame.width) && near(entry.height, frame.height))
  const [window, ...others] = matching
  if (window === undefined) return { ok: false, problem: `No window of the app is on screen where its tree places it (${frame.x},${frame.y} ${frame.width}x${frame.height}); a minimised or hidden window, or one on another Space, is not on screen.`, absent: true }
  if (others.length > 0) return { ok: false, problem: `${matching.length} windows of the app are on screen where its tree places it, so Retest cannot tell which one to capture.` }
  return { ok: true, window }
}

/** Who macOS asks for Screen Recording on Retest's behalf, as the capture refusal and `doctor` both name it. */
export const screenRecordingHolder = 'the terminal or agent that runs Retest'

/** Where macOS grants Screen Recording, as the capture refusal and `doctor` both say it. */
export const screenRecordingGrant = 'macOS grants it in System Settings, Privacy & Security, Screen & System Audio Recording, and that app may need a relaunch'

// Asks CoreGraphics through JavaScript for Automation whether this process may record the screen. The preflight raises
// no prompt and takes no picture; macOS answers for the app the process runs under, as it does for screencapture. The
// bridge does not declare the function, so it is bound by name.
const screenRecordingScript = [
  "ObjC.import('CoreGraphics')",
  "ObjC.bindFunction('CGPreflightScreenCaptureAccess', ['bool', []])",
  'JSON.stringify($.CGPreflightScreenCaptureAccess())',
].join('\n')

/**
 * Whether macOS lets the app that runs Retest record the screen, which the capture of a macOS app's window needs, read
 * without a prompt or a capture; or why it could not be read.
 *
 * @example await screenRecordingAllowed(systemTools, { timeoutMs: 10_000 }) // { ok: true, allowed: false }
 */
export async function screenRecordingAllowed(tools: NativeTools, bounds: RequestBounds): Promise<{ readonly ok: true; readonly allowed: boolean } | { readonly ok: false; readonly problem: string }> {
  const result = await runCommand(tools.osascript, ['-l', 'JavaScript', '-e', screenRecordingScript], { ...bounds, hiddenVariables: tools.hiddenVariables })
  if (result.code !== 0 || result.cleanupProblems.length > 0) return { ok: false, problem: describeCommand('osascript', result) }
  const answer = result.stdout.trim()
  if (answer !== 'true' && answer !== 'false') return { ok: false, problem: 'the answer was neither true nor false' }
  return { ok: true, allowed: answer === 'true' }
}

/**
 * The processes that show macOS's Automation Mode overlay, found by their exact executable path.
 *
 * @example automationOverlayPids(await listProcesses(systemTools, 10_000)) // [74449]
 */
export function automationOverlayPids(listed: readonly Pick<ListedProcess, 'pid' | 'command'>[]): number[] {
  return listed.filter((entry) => entry.command === automationModeUi || entry.command.startsWith(`${automationModeUi} `)).map((entry) => entry.pid)
}

/**
 * The windows that lie over the app's window: listed in front of it, owned by another process, and overlapping its
 * frame. The app's window is the first one of its processes whose frame matches the frame its tree gives, within a
 * point. Not counted: the Dock's surface over the whole screen, and the Automation Mode overlay, a window over the
 * whole screen owned by one of `automationOverlayPids`. Any other window of those processes counts, whatever its
 * layer, as does any window over the whole screen of another process. Without `automationOverlayPids` the overlay
 * counts too.
 *
 * @example coveringWindows(windows, { pids: [4242], frame }, { screen, dockPids: [1291], automationOverlayPids: [74449] }) // { ok: true, windows: [] }
 */
export function coveringWindows(windows: readonly ScreenWindow[], app: { readonly pids: readonly number[]; readonly frame: Rect }, desktop: { readonly screen: Rect; readonly dockPids: readonly number[]; readonly automationOverlayPids?: readonly number[] | undefined }): { readonly ok: true; readonly windows: readonly ScreenWindow[] } | { readonly ok: false; readonly problem: string } {
  const near = (first: number, second: number): boolean => Math.abs(first - second) <= 1
  const { frame } = app
  const index = windows.findIndex((entry) => app.pids.includes(entry.pid) && near(entry.x, frame.x) && near(entry.y, frame.y) && near(entry.width, frame.width) && near(entry.height, frame.height))
  if (index === -1) return { ok: false, problem: "The app's window is not on screen where its tree places it, so Retest captured nothing." }
  const fullScreen = (entry: ScreenWindow): boolean => near(entry.x, desktop.screen.x) && near(entry.y, desktop.screen.y) && near(entry.width, desktop.screen.width) && near(entry.height, desktop.screen.height)
  const overlaps = (entry: ScreenWindow): boolean => entry.x < frame.x + frame.width && frame.x < entry.x + entry.width && entry.y < frame.y + frame.height && frame.y < entry.y + entry.height
  const passedOver = (entry: ScreenWindow): boolean => fullScreen(entry) && (desktop.dockPids.includes(entry.pid) || (desktop.automationOverlayPids ?? []).includes(entry.pid))
  const covering = windows.slice(0, index).filter((entry) => !app.pids.includes(entry.pid) && overlaps(entry) && !passedOver(entry))
  return { ok: true, windows: covering }
}

// `transient` marks a window that is not there yet, as just after launch, which a capture that is starting may ask again.
function failedCapture(message: string, kind: { readonly class?: FailureClass; readonly transient?: true } = {}): DriverAnswer<Uint8Array> {
  return { status: 'failed', input: 'not_sent', failure: { class: kind.class ?? 'not_actionable', message, ...(kind.transient === true ? { details: { transient: true } } : {}) } }
}

// A capture whose deadline is reached starts no further command, as each one may run its kill grace past its time.
function outOfTime(deadline: Deadline, step: string): DriverAnswer<Uint8Array> | undefined {
  return deadline.reached ? failedCapture(`The capture used its ${deadline.budgetMs} ms before ${step}. Retest captured nothing.`, { class: 'timeout' }) : undefined
}

/** A refusal to start the desktop's runner. `idle` says the start left nothing running and holds no lock. */
export type DesktopRefusal = { readonly ok: false; readonly failure: Failure; readonly idle?: true }

function refused(message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { class: 'setup_failed', message } }
}

function idle(message: string): DesktopRefusal {
  return { ok: false, failure: { class: 'setup_failed', message }, idle: true }
}
