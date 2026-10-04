import type { LaunchOptions, OwnedBrowser, OutputRedactor, ProxyOptions, WebRuntimeIdentity } from '../browser/contract.ts'
import type { ElectronLaunchOptions, ElectronRuntime } from '../browser/electron.ts'
import type { LoadedApp, LoadedChromiumTarget, LoadedElectronTarget, LoadedProxy, LoadedTarget } from '../config/loaded.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { TargetInfo } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { BrowserInfo } from '../protocol/result.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Bounded } from './bounded.ts'
import { dirname, join } from 'node:path'
import { closeGraceMs, LaunchError, webRuntimeIdentity } from '../browser/contract.ts'
import { ElectronLaunchError, launchElectron } from '../browser/electron.ts'
import { ProcessLaunchError } from '../browser/chromium-process.ts'
import { BrowserError } from '../browser/browser-error.ts'
import { emulationFor } from '../config/devices.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { slug } from '../protocol/run-folder.ts'
import { withoutCredentials } from '../protocol/url.ts'
import { variantKey } from '../protocol/variant.ts'
import { bounded } from './bounded.ts'
import { abortGraceMs } from './running-test.ts'
import { targetDriver } from './target-drivers.ts'
import { timerMs } from './timer.ts'

/** Starts a browser. The runner passes its setup budget; tests pass a fake. */
export type LaunchBrowser = (options: LaunchOptions, timeoutMs: number) => Promise<OwnedBrowser>

/** Starts an Electron app. The runner passes its setup budget; tests pass a fake. */
export type LaunchElectron = (options: ElectronLaunchOptions, timeoutMs: number) => Promise<ElectronRuntime>

/** Finds the executable a Chromium target launches, or says why there is none, naming the paths it tried. */
export type FindExecutable = (target: LoadedChromiumTarget) => Promise<{ ok: true; path: string } | { ok: false; failure: Failure }>

/**
 * An app target ready for pages: its browser and what it is, what its pages emulate, and the proxy each page's
 * browser context sends its requests through.
 */
export type ReadyTarget = { browser: OwnedBrowser; runtime: WebRuntimeIdentity; emulation?: Emulation; proxy?: ProxyOptions }

export type Opened<T> = { ok: true; value: T } | { ok: false; failure: Failure }

/**
 * A browser as an app target first used it. The info names no app or target in milestone 1's mode. When a target's
 * tests are spread over several browsers, the first says how many in `instances`, and each further one its number
 * in `instance`, from 2.
 */
export type StartedTarget = { info: BrowserInfo; userAgent: string; pid: number; instance?: number; instances?: number }

export type BrowserPoolOptions = {
  launch: LaunchBrowser
  findExecutable: FindExecutable
  /** Where a browser writes its stderr, as an absolute path, from the app target that launched it and which of the target's browsers it is, from 0. */
  logFile: (app: string, target: string, instance: number) => string
  /** False shows every browser; true leaves each target's own setting. */
  headless: boolean
  /** Whether events name each browser's app and target, as a run from a config does. */
  named: boolean
  timeouts: Pick<Timeouts, 'setup' | 'cleanup'>
  /** Settles when the run is interrupted, which ends any wait for a launch. */
  stopped: Promise<void>
  interruption: () => Failure | undefined
  /** Told once for each app target, the first time a test uses it. */
  onStarted: (started: StartedTarget) => void
  /** Told when a browser this pool launched goes away while the run still needs it. */
  onLost: (browser: OwnedBrowser, reason: string) => void
  /** Environment variables no browser may see, such as the ones AI judges' credentials are read from. */
  hiddenVariables?: readonly string[]
  /** Starts an Electron app: Retest's own launcher when absent. */
  launchElectron?: LaunchElectron
  /**
   * Rewrites each line an Electron app's log receives, as the run's redactor does, since the app's own output can hold
   * what a test typed into it. Without it the app's output is written as the app printed it.
   */
  redact?: (text: string) => string
  redactStream?: () => OutputRedactor
}

type Launched = { kind: 'ready'; browser: OwnedBrowser } | { kind: 'unavailable'; failure: Failure; browser?: OwnedBrowser }
type AppTarget =
  | { ok: true; key: string; emulation?: Emulation; proxy?: LoadedProxy }
  | { ok: true; key: string; electron: LoadedElectronTarget }
  | { ok: false; failure: Failure }

/**
 * The run's browsers and Electron apps. A target runs on the driver it needs: Chromium's, which also drives Electron
 * apps. A run refuses the tests of any other target before it asks the pool; should one still reach it, it fails setup
 * by name and launches nothing. Each distinct target, its executable with its headless setting and emulation, launches
 * once, the first time a test needs it or when the run warms it, and app targets that are the same share it. A proxy
 * belongs to each page's browser context, so targets that differ only by proxy share a browser too. A browser that
 * fails to launch, or is lost, is not launched again: every later test that needs it does not run. App targets are set
 * up one after another, so two that share a browser never launch it twice. A target's tests can be spread over several
 * browsers, each worker keeping to one: one browser serves every context it is given from a single process, which a
 * run on many workers saturates.
 *
 * An Electron app is launched afresh for each test that asks for it, and quits when the test closes its page. Warming
 * launches none, since a launch takes what the test holding the app's lease holds; its first launch is the target's
 * setup, when the first test asks: an app that fails then is not launched again, as a browser is not. Every later launch serves one test, fails only that test when it fails, and is told as a further browser. An app
 * lost during a test fails that test alone; the next test gets a new launch.
 */
export class BrowserPool {
  readonly #options: BrowserPoolOptions
  readonly #launched = new Map<string, Launched>()
  readonly #appTargets = new Map<string, Promise<AppTarget>>()
  readonly #started: StartedTarget[] = []
  readonly #releases: Promise<unknown>[] = []
  readonly #outputSettlements = new Set<Promise<void>>()
  readonly #cleanupProblems: string[] = []
  readonly #runtimeGone = new Map<OwnedBrowser, Promise<void>>()
  readonly #free = new Map<OwnedBrowser, { promise: Promise<void>; resolve(): void }>()
  // How many browsers each app target's tests are spread over; one where nothing was said.
  readonly #sizes = new Map<string, number>()
  // Each Electron target's launches so far, and the app its first launch left for the first test that asks.
  readonly #launches = new Map<string, number>()
  readonly #spareApps = new Map<string, ElectronRuntime>()
  // Every Electron app the pool launched, closed with the browsers, and the launches still on their way.
  readonly #apps = new Set<OwnedBrowser>()
  readonly #launchingApps = new Set<Promise<unknown>>()
  // A data folder the config named holds one running app at a time, which Chromium does not guard: each launch on it
  // waits for the app before it to go.
  readonly #folders = new Map<string, Promise<void>>()
  #setups: Promise<unknown> = Promise.resolve()
  #closing: Promise<void> | undefined

  constructor(options: BrowserPoolOptions) {
    this.#options = options
  }

  /** Every app target's browser, in the order they were first used. */
  get started(): readonly StartedTarget[] {
    return this.#started
  }

  /** Includes abandoned launches: no browser log can still receive output once these settle. */
  get outputSettlements(): readonly Promise<void>[] {
    return [...this.#outputSettlements]
  }

  /** Pipe loss is no proof of cleanup. Real runtimes supply process/output proof; fakes need a successful close. */
  whenFree(browser: OwnedBrowser): Promise<void> {
    if (browser.gone !== undefined) this.#runtimeGone.set(browser, browser.gone)
    const gone = this.#runtimeGone.get(browser)
    if (gone !== undefined) return gone
    let free = this.#free.get(browser)
    if (free === undefined) {
      free = Promise.withResolvers<void>()
      this.#free.set(browser, free)
    }
    return free.promise
  }

  /**
   * Settles once every Electron app this pool launched on the data folder, or gave up launching there, is gone: the
   * folder is free of this pool's apps. At once for a folder it never launched on.
   */
  folderSettled(folder: string): Promise<void> {
    return this.#folders.get(folder) ?? Promise.resolve()
  }

  /** Whether a browser or an Electron app from this pool is still there. */
  connected(browser: OwnedBrowser): boolean {
    if (this.#closing !== undefined || !browser.connected) return false
    return this.#apps.has(browser) || [...this.#launched.values()].some((entry) => entry.kind === 'ready' && entry.browser === browser)
  }

  /**
   * Spreads an app target's tests over this many browsers. Said once for it, before it is warmed or asked for. An
   * Electron app launches for each test anyway, so its tests are not spread.
   */
  spread(app: LoadedApp, target: LoadedTarget, browsers: number): void {
    if (!Number.isInteger(browsers) || browsers < 1) throw new RangeError(`A target runs in a whole number of browsers from 1, received ${browsers}.`)
    this.#sizes.set(JSON.stringify([app.name, target.name]), browsers)
  }

  #sizeOf(app: LoadedApp, target: LoadedTarget): number {
    if (isElectron(target)) return 1
    return this.#sizes.get(JSON.stringify([app.name, target.name])) ?? 1
  }

  /**
   * Starts setting up an app target now, in every browser its tests are spread over, so they launch while the
   * first test process boots, instead of when the first test asks. `ensure` later waits for the same setup. An Electron
   * target is not warmed: its app runs for one test at a time, and launches only once that test holds what it needs.
   */
  warm(app: LoadedApp, target: LoadedTarget): void {
    if (isElectron(target)) return
    for (let instance = 0; instance < this.#sizeOf(app, target); instance += 1) {
      this.#appTarget(app, target, instance).catch(() => {
        // ensure reports the problem to the test that needs the target; nothing waits here.
      })
    }
  }

  /**
   * The target's browser for a worker: each worker keeps to one of the browsers the target's tests are spread over.
   * For an Electron target, an app of the caller's own: the one the target's setup launched, the first time, and a new
   * launch each time after.
   */
  async ensure(app: LoadedApp, target: LoadedTarget, worker = 0): Promise<Opened<ReadyTarget>> {
    const known = await this.#appTarget(app, target, worker % this.#sizeOf(app, target))
    if (!known.ok) return known
    if ('electron' in known) return this.#electronApp(app, known.electron, known.key)
    const launched = this.#launched.get(known.key)
    if (this.#closing !== undefined) return { ok: false, failure: failure('setup_failed', 'The browser was closed.') }
    if (launched?.kind !== 'ready') return { ok: false, failure: launched?.failure ?? failure('setup_failed', 'The browser was closed.') }
    const emulation = known.emulation === undefined ? {} : { emulation: known.emulation }
    const proxy = known.proxy === undefined ? {} : { proxy: known.proxy }
    const runtime = webRuntimeIdentity(launched.browser, 'chromium')
    return { ok: true, value: { browser: launched.browser, runtime, ...emulation, ...proxy } }
  }

  /**
   * Closes every browser and Electron app within the cleanup budget, and waits for any launch the run gave up on. A
   * setup still queued launches nothing once this is called, and one in flight is waited for, so no browser or app
   * starts after the close. A second call waits for the first.
   */
  close(): Promise<void> {
    this.#closing ??= this.#closeAll()
    return this.#closing
  }

  async #closeAll(): Promise<void> {
    const { cleanup } = this.#options.timeouts
    await this.#setups
    await Promise.allSettled(this.#launchingApps)
    const browsers = [...this.#launched.values()].flatMap((entry) => (entry.browser === undefined ? [] : [entry.browser]))
    const closed = await Promise.all([...browsers, ...this.#apps].map((browser) => bounded(this.#closeBrowser(browser, cleanup), timerMs(cleanup + closeGraceMs + abortGraceMs))))
    for (const ending of closed) {
      if (ending.status === 'failed') this.#cleanupProblems.push(cleanupMessage(ending.error))
      else if (ending.status !== 'done') this.#cleanupProblems.push("A browser or Electron app did not finish cleanup within the run's cleanup budget.")
    }
    const released = await bounded(Promise.all(this.#releases), cleanup)
    if (released.status === 'failed') this.#cleanupProblems.push(cleanupMessage(released.error))
    else if (released.status !== 'done') this.#cleanupProblems.push("An abandoned browser or Electron launch did not finish cleanup within the run's cleanup budget.")
    if (this.#cleanupProblems.length > 0) throw new BrowserError({ class: 'cleanup_failed', message: [...new Set(this.#cleanupProblems)].join(' ') })
  }

  // One setup at a time, in the order they were asked for, each remembered for every later ask.
  #appTarget(app: LoadedApp, target: LoadedTarget, instance: number): Promise<AppTarget> {
    const id = JSON.stringify([app.name, target.name, instance])
    let known = this.#appTargets.get(id)
    if (known === undefined) {
      known = this.#setups.then(() => this.#first(app, target, instance))
      this.#setups = known.catch(() => undefined)
      this.#appTargets.set(id, known)
    }
    return known
  }

  async #first(app: LoadedApp, loaded: LoadedTarget, instance: number): Promise<AppTarget> {
    const closed = (): AppTarget => ({ ok: false, failure: this.#options.interruption() ?? failure('setup_failed', 'The browser was closed.') })
    if (this.#closing !== undefined) return closed()
    const driver = targetDriver(app.name, loaded)
    if (!driver.ok) return driver
    if (driver.driver === 'electron') return this.#firstApp(app, driver.target)
    const { target } = driver
    const found = await this.#options.findExecutable(target)
    if (!found.ok) return found
    if (this.#closing !== undefined) return closed()
    const executablePath = found.path
    const headless = this.#options.headless && target.headless
    const key = JSON.stringify([executablePath, headless, target.emulate ?? null, instance])
    const hidden = this.#options.hiddenVariables === undefined ? {} : { hiddenVariables: this.#options.hiddenVariables }
    const redacting = this.#options.redact === undefined ? {} : { redact: this.#options.redact }
    const streaming = this.#options.redactStream === undefined ? {} : { redactStream: this.#options.redactStream }
    const launched = this.#launched.get(key) ?? (await this.#launch(key, { executablePath, headless, logFile: this.#options.logFile(app.name, target.name, instance), ...hidden, ...redacting, ...streaming }))
    if (launched.kind !== 'ready') return { ok: false, failure: launched.failure }
    const { browser } = launched
    const emulation = target.emulate === undefined ? undefined : emulationFor(target.emulate, browser.version)
    this.#announce(app, target, browser, emulation, instance)
    return { ok: true, key, ...(emulation === undefined ? {} : { emulation }), ...(target.proxy === undefined ? {} : { proxy: target.proxy }) }
  }

  // The target's setup: its first launch, which the first test that asks for the target gets.
  async #firstApp(app: LoadedApp, target: LoadedElectronTarget): Promise<AppTarget> {
    const key = JSON.stringify(['electron', app.name, target.name])
    const launched = await this.#launchApp(app, target, key)
    if (!launched.ok) return launched
    this.#spareApps.set(key, launched.value)
    return { ok: true, key, electron: target }
  }

  async #electronApp(app: LoadedApp, target: LoadedElectronTarget, key: string): Promise<Opened<ReadyTarget>> {
    if (this.#closing !== undefined) return { ok: false, failure: this.#options.interruption() ?? failure('setup_failed', 'The Electron app was closed.') }
    const spare = this.#spareApps.get(key)
    this.#spareApps.delete(key)
    const ready = spare?.connected === true ? { ok: true as const, value: spare } : await this.#launchApp(app, target, key)
    if (!ready.ok) return ready
    return { ok: true, value: { browser: ready.value, runtime: ready.value.identity } }
  }

  #launchApp(app: LoadedApp, target: LoadedElectronTarget, key: string): Promise<Opened<ElectronRuntime>> {
    const launching = this.#startApp(app, target, key)
    const settled = (): void => {
      this.#launchingApps.delete(launching)
    }
    this.#launchingApps.add(launching)
    launching.then(settled, settled)
    return launching
  }

  async #startApp(app: LoadedApp, target: LoadedElectronTarget, key: string): Promise<Opened<ElectronRuntime>> {
    const { setup, cleanup } = this.#options.timeouts
    const closed = (): Opened<ElectronRuntime> => ({ ok: false, failure: this.#options.interruption() ?? failure('setup_failed', 'The Electron app was closed.') })
    const launch = (this.#launches.get(key) ?? 0) + 1
    this.#launches.set(key, launch)
    const logFile = this.#options.logFile(app.name, target.name, 0)
    const { executablePath, appPath, args, userDataDir } = target
    const turn = this.#folderTurn(userDataDir)
    const waited = await bounded(turn.ready, setup, this.#options.stopped)
    if (waited.status !== 'done' || this.#closing !== undefined) {
      turn.pass()
      return waited.status === 'timed_out' && userDataDir !== undefined ? { ok: false, failure: failure('setup_failed', busyFolder(app.name, userDataDir, setup)) } : closed()
    }
    const hidden = this.#options.hiddenVariables === undefined ? {} : { hiddenVariables: this.#options.hiddenVariables }
    const redacting = this.#options.redact === undefined ? {} : { redact: this.#options.redact }
    const streaming = this.#options.redactStream === undefined ? {} : { redactStream: this.#options.redactStream }
    const named = userDataDir === undefined ? {} : { userDataDir }
    const windowsFile = join(launchFolder(logFile, app.name, target.name, launch), 'windows.json')
    const options = { executablePath, appPath, args, ...named, windowsFile, logFile, app: app.name, target: target.name, launch, ...hidden, ...redacting, ...streaming }
    const launching = (this.#options.launchElectron ?? launchElectron)(options, setup)
    this.#trackOutput(launching)
    const launched = await bounded(launching, timerMs(setup + abortGraceMs), this.#options.stopped)
    if (launched.status !== 'done') {
      // A launch given up on may still bring its app up; the folder is handed on only once that app is gone, whether or
      // not quitting it reported a problem.
      const free = launched.status === 'failed'
        ? failedLaunchGone(launched.error)
        : launching.then((started) => this.#closeBrowser(started, cleanup).catch((error: unknown) => this.#cleanupProblems.push(cleanupMessage(error))).then(() => started.gone), (error: unknown) => failedLaunchGone(error))
      this.#releases.push(free.then(turn.pass).catch((error: unknown) => this.#cleanupProblems.push(cleanupMessage(error))))
      const stopped = launched.status === 'stopped' ? this.#options.interruption() : undefined
      return { ok: false, failure: stopped ?? launchFailure(launched, setup, 'The Electron app') }
    }
    const started = launched.value
    this.#runtimeGone.set(started, started.gone)
    // The folder is free once every process of the app is gone, which can be a second after its pipe closed.
    void started.gone.then(turn.pass, (error: unknown) => this.#cleanupProblems.push(cleanupMessage(error)))
    started.onDisconnect((reason) => this.#appLost(started, reason))
    // An app that finished launching while the pool was closing is closed with the rest, never handed out.
    if (this.#closing !== undefined) {
      this.#releases.push(this.#closeBrowser(started, cleanup).catch((error: unknown) => this.#cleanupProblems.push(cleanupMessage(error))))
      return closed()
    }
    this.#apps.add(started)
    this.#announceApp(app, target, started, launch)
    return { ok: true, value: started }
  }

  // A launch's turn at the data folder the config named, after every launch before it on the folder has gone; a
  // launch on a temporary folder of its own has it at once. `pass` hands the folder on, once.
  #folderTurn(folder: string | undefined): { ready: Promise<void>; pass: () => void } {
    if (folder === undefined) return { ready: Promise.resolve(), pass: () => undefined }
    const before = this.#folders.get(folder) ?? Promise.resolve()
    const done = Promise.withResolvers<void>()
    // A launch that gives up still waits for the one before it, so the folder is never handed to two apps at once.
    const passed = before.then(() => done.promise)
    this.#folders.set(folder, passed)
    return { ready: before, pass: () => done.resolve() }
  }

  #appLost(started: ElectronRuntime, reason: string): void {
    if (this.#closing !== undefined || started.closeRequested) return
    this.#options.onLost(started, reason)
  }

  // Each launch is told, so every process an Electron target started is in the events; the result lists the target
  // once, by its first launch.
  #announceApp(app: LoadedApp, target: LoadedElectronTarget, started: ElectronRuntime, launch: number): void {
    const { product, version, userAgent, pid, executablePath, electron } = started
    const described: TargetInfo = { name: target.name, electron: { version: electron.version, chromium: electron.chromium } }
    const named = this.#options.named ? { app: app.name, target: described } : {}
    const announced: StartedTarget = { info: { product, version, executablePath, ...named }, userAgent, pid, ...(launch > 1 ? { instance: launch } : {}) }
    if (launch === 1) this.#started.push(announced)
    this.#options.onStarted(announced)
  }

  async #launch(key: string, options: LaunchOptions): Promise<Launched> {
    const { setup, cleanup } = this.#options.timeouts
    const launching = this.#options.launch(options, setup)
    this.#trackOutput(launching)
    const launched = await bounded(launching, timerMs(setup + abortGraceMs), this.#options.stopped)
    if (launched.status !== 'done') {
      if (launched.status !== 'failed') this.#releases.push(launching.then((browser) => this.#closeBrowser(browser, cleanup), (error: unknown) => failedLaunchGone(error)).catch((error: unknown) => this.#cleanupProblems.push(cleanupMessage(error))))
      else if (launched.error instanceof ProcessLaunchError) this.#releases.push(launched.error.gone.catch((error: unknown) => this.#cleanupProblems.push(cleanupMessage(error))))
      const stopped = launched.status === 'stopped' ? this.#options.interruption() : undefined
      const entry: Launched = { kind: 'unavailable', failure: stopped ?? launchFailure(launched, setup, 'The browser') }
      this.#launched.set(key, entry)
      return entry
    }
    const browser = launched.value
    // A browser that finished launching while the pool was closing is closed with the rest, never handed out.
    if (this.#closing !== undefined) {
      this.#releases.push(this.#closeBrowser(browser, cleanup).catch((error: unknown) => this.#cleanupProblems.push(cleanupMessage(error))))
      const entry: Launched = { kind: 'unavailable', failure: this.#options.interruption() ?? failure('setup_failed', 'The browser was closed.') }
      this.#launched.set(key, entry)
      return entry
    }
    const entry: Launched = { kind: 'ready', browser }
    this.#launched.set(key, entry)
    browser.onDisconnect((reason) => this.#lost(key, browser, reason))
    return entry
  }

  #trackOutput(launching: Promise<OwnedBrowser>): void {
    const settled = launching.then((browser) => browser.outputSettled, (error: unknown) => error instanceof ElectronLaunchError || error instanceof ProcessLaunchError ? error.outputSettled : undefined).then(() => undefined)
    void settled.catch(() => undefined)
    this.#outputSettlements.add(settled)
  }

  async #closeBrowser(browser: OwnedBrowser, timeoutMs: number): Promise<void> {
    this.whenFree(browser)
    await browser.close(timeoutMs)
    await browser.outputSettled
    if (!this.#runtimeGone.has(browser)) this.#free.get(browser)?.resolve()
  }

  #lost(key: string, browser: OwnedBrowser, reason: string): void {
    if (this.#closing !== undefined || this.#launched.get(key)?.kind !== 'ready') return
    const problem = failure('session_lost', `Not run: the browser was lost earlier in this run. ${reason}`)
    this.#launched.set(key, { kind: 'unavailable', failure: problem, browser })
    this.#options.onLost(browser, reason)
  }

  // The run's result lists each app target once, so only its first browser joins `started`; every browser is told.
  #announce(app: LoadedApp, target: LoadedChromiumTarget, browser: OwnedBrowser, emulation: Emulation | undefined, instance: number): void {
    const { product, version, userAgent, pid, executablePath } = browser
    const device = typeof target.emulate === 'string' ? { device: target.emulate } : {}
    const proxy = target.proxy === undefined ? {} : { proxy: recordedProxy(target.proxy) }
    const described: TargetInfo = { name: target.name, ...(emulation === undefined ? {} : { emulation }), ...device, ...proxy }
    const named = this.#options.named ? { app: app.name, target: described } : {}
    const size = this.#sizeOf(app, target)
    const numbered = instance > 0 ? { instance: instance + 1 } : size > 1 ? { instances: size } : {}
    const started: StartedTarget = { info: { product, version, executablePath, ...named }, userAgent, pid, ...numbered }
    if (instance === 0) this.#started.push(started)
    this.#options.onStarted(started)
  }
}

// The proxy's address and bypass rules as events record them; a user name or password never is.
function recordedProxy({ server, bypass }: LoadedProxy): NonNullable<TargetInfo['proxy']> {
  return { server: withoutCredentials(server), ...(bypass.length === 0 ? {} : { bypass: [...bypass] }) }
}

function launchFailure(launched: Exclude<Bounded<OwnedBrowser>, { status: 'done' }>, setupMs: number, subject: string): Failure {
  if (launched.status === 'failed') {
    const { error } = launched
    return error instanceof LaunchError ? error.failure : failure('setup_failed', `${subject} did not start: ${errorMessage(error)}`)
  }
  return failure('setup_failed', `${subject} did not start within the ${setupMs} ms setup budget.`)
}

function isElectron(target: LoadedTarget): target is LoadedElectronTarget {
  return 'browser' in target && target.browser === 'electron'
}

// A browser's log sits in the run folder's `logs`, and each Electron launch keeps its folder beside them, in
// `electron`, with the windows the app opened.
function launchFolder(logFile: string, app: string, target: string, launch: number): string {
  return join(dirname(dirname(logFile)), 'electron', slug(variantKey({ [app]: target })), String(launch))
}

function busyFolder(app: string, folder: string, setupMs: number): string {
  return `Another test's launch of the Electron app ${app} still held its data folder ${folder} after ${setupMs} ms. The folder holds one running app at a time: run the tests that share it one after another, or give each target a folder of its own.`
}

function failedLaunchGone(error: unknown): Promise<void> {
  return error instanceof ElectronLaunchError || error instanceof ProcessLaunchError ? error.gone : Promise.resolve()
}

function cleanupMessage(error: unknown): string {
  return error instanceof BrowserError ? error.failure.message : errorMessage(error)
}
