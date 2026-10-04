import type { NativeRuntime, NativeRuntimeIdentity, ResetPolicy } from '../browser/contract.ts'
import type { Failure } from '../protocol/failures.ts'
import type { DesktopLock } from './desktop-lock.ts'
import type { ExecutorBuild, NativePinSet } from './executors.ts'
import type { AppBundle, NativeExecutionIdentity, OperatingSystem } from './identity.ts'
import type { NativeTools, RecordedProcess } from './processes.ts'
import type { AppProcessReading, CaptureSource, DriverAnswer, LaunchSpec, NativeAppDriver, NativeSessionOptions } from './session.ts'
import type { ScopedSource } from './source-scope.ts'
import type { ExecutorAppState, ExecutorSession, Rect, RequestBounds } from './webdriver-client.ts'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { defaultDesktopLock, takeDesktopLock } from './desktop-lock.ts'
import { freePort, isListening, startExecutor, watchExecutor } from './executor-process.ts'
import { checkXcode, nativePins } from './executors.ts'
import { appNames, nativeExecutionIdentity, readAppBundle, readMacosVersion, runtimeIdentity } from './identity.ts'
import { cropPng, decodePng, encodePng } from './png.ts'
import type { ListedProcess } from './processes.ts'
import { commandOf, describeCommand, endProblem, endRecorded, killRecordedNow, listProcesses, runCommand } from './processes.ts'
import { macosResetPolicy } from './reset-policy.ts'
import { NativeAppSession, NativeError, SerialLane } from './session.ts'
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
  readonly #runnerApps: readonly RecordedProcess[]
  readonly #lock: DesktopLock
  readonly #lastResort: () => void
  readonly #stopWatch: () => void
  #lost: string | undefined
  #closing: Promise<void> | undefined

  /**
   * Starts the runner: checks Xcode against the tested set and that Automation Mode will not ask anyone, refuses when a
   * macOS runner already runs on this Mac, then starts it on a port of its own, bound to 127.0.0.1.
   */
  static async start(options: MacosDesktopOptions): Promise<{ readonly ok: true; readonly desktop: MacosDesktop } | { readonly ok: false; readonly failure: Failure }> {
    options = { ...options, tools: { ...options.tools, hiddenVariables: options.hiddenVariables ?? options.tools.hiddenVariables, redact: options.redact ?? options.tools.redact } }
    const pins = options.pins ?? nativePins
    const deadline = new Deadline(options.timeoutMs)
    if (process.platform !== 'darwin') return refused('macOS apps need a Mac.')
    if (options.build.executor !== 'mac2') return refused(`The macOS desktop needs a build of the macOS runner, not ${options.build.executor}.`)
    if (openDesktop !== undefined) return refused('This process already runs the macOS runner for this desktop; native work on one desktop goes through that runner, one session at a time.')
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

  static async #start(options: MacosDesktopOptions, pins: NativePinSet, deadline: Deadline): Promise<{ readonly ok: true; readonly desktop: MacosDesktop } | { readonly ok: false; readonly failure: Failure }> {
    const xcode = await checkXcode(options.tools, pins.toolchain, options.signal)
    if (xcode !== undefined) return { ok: false, failure: xcode }
    const automation = await automationModeProblem(options.tools, options.signal)
    if (automation !== undefined) return { ok: false, failure: automation }
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
    // A start that could not end what it recorded keeps the lock, which names those processes for the next start.
    const fail = async (failure: Failure, folder?: string, leftRunning: readonly RecordedProcess[] = []): Promise<{ readonly ok: false; readonly failure: Failure }> => {
      if (folder !== undefined) await rm(folder, { recursive: true, force: true })
      if (leftRunning.length > 0) return { ok: false, failure }
      process.off('exit', exitHook)
      await lock.release()
      return { ok: false, failure }
    }
    try {
      // After the lock, a runner still running is not one a Retest process recorded, so it is refused by name.
      const others = (await listProcesses(options.tools, 10_000)).filter((entry) => entry.command.includes(runnerExecutable))
      if (others.length > 0) return await fail({ class: 'setup_failed', message: `A macOS runner Retest cannot recognise as its own runs on this Mac (pid ${others.map((entry) => entry.pid).join(', ')}), so something else drives the desktop. Retest never stops a runner it did not start.` })
      const os = await readMacosVersion(options.tools, options.signal)
      if (os === undefined) return await fail({ class: 'setup_failed', message: 'Retest could not read the macOS version with sw_vers.' })
      const folder = await mkdtemp(join(tmpdir(), 'retest-macos-'))
      const port = options.port ?? (await freePort())
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
    if (!runner.ok) return await fail(runner.failure, folder, runner.leftRunning)
    process.off('exit', exitHook)
    return { ok: true, desktop: new MacosDesktop({ options, runner, port, os, folder, runnerApps: runner.runnerApps, lock }) }
    } catch (error) {
      return await fail({ class: 'setup_failed', message: `Starting the macOS runner failed: ${errorMessage(error)}` })
    }
  }

  private constructor(parts: { readonly options: MacosDesktopOptions; readonly runner: Awaited<ReturnType<typeof startExecutor>> & { readonly ok: true }; readonly port: number; readonly os: OperatingSystem; readonly folder: string; readonly runnerApps: readonly RecordedProcess[]; readonly lock: DesktopLock }) {
    this.#options = parts.options
    this.build = parts.options.build
    this.#runner = parts.runner
    this.port = parts.port
    this.os = parts.os
    this.#folder = parts.folder
    this.#runnerApps = parts.runnerApps
    this.#lock = parts.lock
    // When the Retest process exits without closing the desktop, the runner app goes with it and the desktop is let go;
    // xcodebuild's recorded processes have their own verified exit hook. A SIGKILL of the Retest process runs neither: the next start
    // recognises what is left by the lock.
    this.#lastResort = () => {
      killRecordedNow(parts.runnerApps, parts.options.tools)
      parts.lock.releaseNow()
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

  /** The executor processes this desktop recorded at startup, with their exact command lines. */
  get executorProcesses(): readonly RecordedProcess[] {
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
  readonly #release: () => void
  #released = false

  constructor(parts: { readonly runtime: MacosAppRuntime; readonly tools: NativeTools; readonly executor: ExecutorSession; readonly release: () => void }) {
    this.bundle = parts.runtime.bundle
    this.identity = parts.runtime.execution
    this.resetPolicy = parts.runtime.resetPolicy
    this.runtimeProcessIds = parts.runtime.desktop.processIds
    this.#tools = parts.tools
    this.#executor = parts.executor
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

  // The runner captures the whole main display, and a cut of it holds whatever lies over the window. So the capture is
  // taken only while the app is in front and no window of another process lies over its window, as the window server
  // lists them right before the screenshot and again right after it, unchanged; otherwise it fails, saying so. The
  // Dock's own surface spans the screen and is not counted: its icons can still show in a window that reaches into the
  // Dock. Nor is the full-screen Automation Mode window of the system owner during an open runner session: the measured
  // TaskDesk region matched with and without the runner (see `png.ts`). The window's rounded corners and translucency show what lies
  // behind it.
  async capture(_source: CaptureSource, bounds: RequestBounds): Promise<DriverAnswer<Uint8Array>> {
    const deadline = new Deadline(bounds.timeoutMs)
    const part = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
    const state = await this.#executor.appState({ path: this.bundle.appPath }, part())
    if (state.status !== 'answered') return state
    if (state.value !== 4) return failedCapture('The app is not in front, so windows of other apps may lie over its window. Retest captures the window only while the app is in front.')
    const tree = await this.source(part())
    if (tree.status !== 'answered') return tree
    const window = tree.value.window
    if (window === undefined) return failedCapture('The app has no window to capture.')
    const screen = await this.#executor.windowRect(part())
    if (screen.status !== 'answered') return screen
    const before = await windowsOnScreen(this.#tools, part())
    const covered = await this.#coverage(before, window, screen.value, part())
    if (covered !== undefined) return failedCapture(covered)
    const display = await this.#executor.screenshot(part())
    if (display.status !== 'answered') return display
    const after = await windowsOnScreen(this.#tools, part())
    if (typeof after === 'string') return failedCapture(`Retest could not read which windows were on screen after the display was captured (${after}), so it cannot tell whether another window is in the capture. Retest captured nothing.`)
    if (JSON.stringify(after) !== JSON.stringify(before)) return failedCapture('The windows on screen changed while the display was captured, so another window may be in the capture. Retest captured nothing.')
    try {
      const image = decodePng(display.value)
      const scale = image.width / screen.value.width
      if (!Number.isInteger(scale) || Math.round(screen.value.height * scale) !== image.height) return failedCapture(`The display capture is ${image.width}x${image.height}, not the ${screen.value.width}x${screen.value.height}-point main screen at a whole scale.`)
      const area = { x: Math.round((window.x - screen.value.x) * scale), y: Math.round((window.y - screen.value.y) * scale), width: Math.round(window.width * scale), height: Math.round(window.height * scale) }
      if (area.x < 0 || area.y < 0 || area.x + area.width > image.width || area.y + area.height > image.height) return failedCapture('The app\'s window is not wholly on the main display, so Retest cannot cut it from the capture.')
      return { status: 'answered', value: encodePng(cropPng(image, area)), durationMs: display.durationMs }
    } catch (error) {
      return failedCapture(`The display capture could not be cut to the window: ${errorMessage(error)}`)
    }
  }

  source(bounds: RequestBounds): Promise<DriverAnswer<ScopedSource>> {
    return this.#executor.ownedSource({ platform: 'macos', bundleId: this.bundle.bundleId, appNames: appNames(this.bundle) }, bounds)
  }

  // Why a capture of the window would hold another process's pixels, or undefined when nothing lies over it.
  async #coverage(windows: ScreenWindow[] | string, window: Rect, screen: Rect, bounds: RequestBounds): Promise<string | undefined> {
    if (typeof windows === 'string') return `Retest could not read which windows are on screen (${windows}), so it captured nothing.`
    const listed = await listProcesses(this.#tools, bounds.timeoutMs).catch(() => undefined)
    if (listed === undefined) return 'Retest could not read the processes behind the windows on screen, so it captured nothing.'
    const app = await macosAppProcesses(this.#tools, this.bundle.bundleId, bounds)
    if (!app.ok) return `Retest could not read the app's processes (${app.problem}), so it captured nothing.`
    const own = app.processes.map((entry) => entry.pid)
    const dock = listed.filter((entry) => entry.command.endsWith('/Dock.app/Contents/MacOS/Dock')).map((entry) => entry.pid)
    // Only an open runner session may pass over the system's Automation Mode window. Its owner is checked by the
    // exact system executable, never by the window's layer or a title supplied by an application.
    const overlay = !this.#released && this.#executor.ended === undefined ? automationOverlayPids(listed) : []
    const covering = coveringWindows(windows, { pids: own, frame: window }, { screen, dockPids: dock, automationOverlayPids: overlay })
    if (!covering.ok) return covering.problem
    if (covering.windows.length === 0) return undefined
    const layers = [...new Set(covering.windows.map((entry) => entry.layer))].join(', ')
    return `${covering.windows.length} window(s) of other processes lie over the app's window (layer ${layers}), so a capture would hold their pixels. Retest captures the window only when nothing lies over it.`
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
 * command lines; `listed` counts the apps it lists, including one whose process was gone before it could be read.
 *
 * @example await macosAppProcesses(systemTools, 'com.apple.TextEdit', { timeoutMs: 10_000 }) // { ok: true, listed: 1, processes: [{ pid: 4242, command: '/System/Applications/TextEdit.app/Contents/MacOS/TextEdit' }] }
 */
export async function macosAppProcesses(tools: NativeTools, bundleId: string, bounds: RequestBounds): Promise<{ readonly ok: true; readonly listed: number; readonly processes: readonly RecordedProcess[] } | { readonly ok: false; readonly problem: string }> {
  const found = await runCommand(tools.lsappinfo, ['find', `bundleid=${bundleId}`], { ...bounds, hiddenVariables: tools.hiddenVariables })
  if (found.code !== 0) return { ok: false, problem: describeCommand('lsappinfo find', found) }
  const applications = [...found.stdout.matchAll(/ASN:(0x[0-9a-f]+-0x[0-9a-f]+)/gi)].map((match) => match[1] ?? '')
  const processes: RecordedProcess[] = []
  for (const application of applications) {
    const info = await runCommand(tools.lsappinfo, ['info', '-only', 'pid,bundleid', `ASN:${application}:`], { ...bounds, hiddenVariables: tools.hiddenVariables })
    if (info.code !== 0) return { ok: false, problem: describeCommand('lsappinfo info', info) }
    // An app that quit since the listing prints nothing; one whose number another app took names another bundle.
    if (/bundleID="([^"]*)"/.exec(info.stdout)?.[1] !== bundleId) continue
    const pid = Number(/\bpid = (\d+)/.exec(info.stdout)?.[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    const presence = await commandOf(tools, pid)
    if (presence.state === 'unreadable') return { ok: false, problem: presence.problem }
    if (presence.state === 'present') processes.push({ pid, command: presence.command })
  }
  return { ok: true, listed: applications.length, processes }
}

/** A window as the window server lists it: its owner's pid, its layer and its frame in points. */
export type ScreenWindow = { readonly pid: number; readonly layer: number; readonly x: number; readonly y: number; readonly width: number; readonly height: number }

// Asks the window server, through JavaScript for Automation, for the windows on screen front to back: owner, layer and
// frame only, never a title. Reading this list needs no permission and raises no prompt.
const windowListScript = [
  "ObjC.import('CoreGraphics')",
  'const list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID))',
  'const out = []',
  'for (let index = 0; index < list.count; index += 1) {',
  '  const window = list.objectAtIndex(index)',
  "  const frame = window.objectForKey('kCGWindowBounds')",
  "  out.push([ObjC.unwrap(window.objectForKey('kCGWindowOwnerPID')), ObjC.unwrap(window.objectForKey('kCGWindowLayer')), ObjC.unwrap(frame.objectForKey('X')), ObjC.unwrap(frame.objectForKey('Y')), ObjC.unwrap(frame.objectForKey('Width')), ObjC.unwrap(frame.objectForKey('Height'))])",
  '}',
  'JSON.stringify(out)',
].join('\n')

/**
 * The windows on screen, front to back, as the window server lists them, or why they could not be read.
 *
 * @example await windowsOnScreen(systemTools, { timeoutMs: 5000 }) // [{ pid: 601, layer: 24, x: 0, y: 0, width: 1728, height: 33 }, …]
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
    if (!Array.isArray(entry) || entry.length !== 6 || !entry.every((value) => typeof value === 'number')) return 'a window entry is not six numbers'
    const [pid = 0, layer = 0, x = 0, y = 0, width = 0, height = 0] = entry
    windows.push({ pid, layer, x, y, width, height })
  }
  return windows
}

/**
 * The processes that show macOS's Automation Mode overlay, found by their exact executable path.
 *
 * @example automationOverlayPids(await listProcesses(systemTools, 10_000)) // [74449]
 */
export function automationOverlayPids(listed: readonly ListedProcess[]): number[] {
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

function failedCapture(message: string): DriverAnswer<Uint8Array> {
  return { status: 'failed', input: 'not_sent', failure: { class: 'not_actionable', message } }
}

function refused(message: string): { readonly ok: false; readonly failure: Failure } {
  return { ok: false, failure: { class: 'setup_failed', message } }
}
