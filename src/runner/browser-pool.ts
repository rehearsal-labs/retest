import type { LaunchOptions, OwnedBrowser, ProxyOptions, WebRuntimeIdentity } from '../browser/contract.ts'
import type { LoadedApp, LoadedChromiumTarget, LoadedProxy, LoadedTarget } from '../config/loaded.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { TargetInfo } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { BrowserInfo } from '../protocol/result.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Bounded } from './bounded.ts'
import { closeGraceMs, LaunchError, webRuntimeIdentity } from '../browser/contract.ts'
import { emulationFor } from '../config/devices.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { withoutCredentials } from '../protocol/url.ts'
import { bounded } from './bounded.ts'
import { abortGraceMs } from './running-test.ts'
import { targetDriver } from './target-drivers.ts'

/** Starts a browser. The runner passes its setup budget; tests pass a fake. */
export type LaunchBrowser = (options: LaunchOptions, timeoutMs: number) => Promise<OwnedBrowser>

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
}

type Launched = { kind: 'ready'; browser: OwnedBrowser } | { kind: 'unavailable'; failure: Failure; browser?: OwnedBrowser }
type AppTarget = { ok: true; key: string; emulation?: Emulation; proxy?: LoadedProxy } | { ok: false; failure: Failure }

/**
 * The run's browsers. A target runs on the driver it needs, and only Chromium's exists. A run refuses the tests of
 * any other target before it asks the pool; should one still reach it, it fails setup by name and launches nothing.
 * Each distinct target, its executable with its headless setting and emulation, launches once, the first time a test
 * needs it or when the run warms it, and app targets that are the same share it. A proxy belongs to each page's
 * browser context, so targets that differ only by proxy share a browser too. A browser that fails to launch, or is
 * lost, is not launched again: every later test that needs it does not run. App targets are set up one after
 * another, so two that share a browser never launch it twice. A target's tests can be spread over several browsers,
 * each worker keeping to one: one browser serves every context it is given from a single process, which a run on
 * many workers saturates.
 */
export class BrowserPool {
  readonly #options: BrowserPoolOptions
  readonly #launched = new Map<string, Launched>()
  readonly #appTargets = new Map<string, Promise<AppTarget>>()
  readonly #started: StartedTarget[] = []
  readonly #releases: Promise<unknown>[] = []
  // How many browsers each app target's tests are spread over; one where nothing was said.
  readonly #sizes = new Map<string, number>()
  #setups: Promise<unknown> = Promise.resolve()
  #closing: Promise<void> | undefined

  constructor(options: BrowserPoolOptions) {
    this.#options = options
  }

  /** Every app target's browser, in the order they were first used. */
  get started(): readonly StartedTarget[] {
    return this.#started
  }

  /** Whether a browser from this pool is still there. */
  connected(browser: OwnedBrowser): boolean {
    return this.#closing === undefined && [...this.#launched.values()].some((entry) => entry.kind === 'ready' && entry.browser === browser && browser.connected)
  }

  /** Spreads an app target's tests over this many browsers. Said once for it, before it is warmed or asked for. */
  spread(app: LoadedApp, target: LoadedTarget, browsers: number): void {
    if (!Number.isInteger(browsers) || browsers < 1) throw new RangeError(`A target runs in a whole number of browsers from 1, received ${browsers}.`)
    this.#sizes.set(JSON.stringify([app.name, target.name]), browsers)
  }

  #sizeOf(app: LoadedApp, target: LoadedTarget): number {
    return this.#sizes.get(JSON.stringify([app.name, target.name])) ?? 1
  }

  /**
   * Starts setting up an app target now, in every browser its tests are spread over, so they launch while the
   * first test process boots, instead of when the first test asks. `ensure` later waits for the same setup.
   */
  warm(app: LoadedApp, target: LoadedTarget): void {
    for (let instance = 0; instance < this.#sizeOf(app, target); instance += 1) {
      this.#appTarget(app, target, instance).catch(() => {
        // ensure reports the problem to the test that needs the target; nothing waits here.
      })
    }
  }

  /** The target's browser for a worker: each worker keeps to one of the browsers the target's tests are spread over. */
  async ensure(app: LoadedApp, target: LoadedTarget, worker = 0): Promise<Opened<ReadyTarget>> {
    const known = await this.#appTarget(app, target, worker % this.#sizeOf(app, target))
    if (!known.ok) return known
    const launched = this.#launched.get(known.key)
    if (this.#closing !== undefined) return { ok: false, failure: failure('setup_failed', 'The browser was closed.') }
    if (launched?.kind !== 'ready') return { ok: false, failure: launched?.failure ?? failure('setup_failed', 'The browser was closed.') }
    const emulation = known.emulation === undefined ? {} : { emulation: known.emulation }
    const proxy = known.proxy === undefined ? {} : { proxy: known.proxy }
    const runtime = webRuntimeIdentity(launched.browser, 'chromium')
    return { ok: true, value: { browser: launched.browser, runtime, ...emulation, ...proxy } }
  }

  /**
   * Closes every browser within the cleanup budget, and waits for any launch the run gave up on. A setup still queued
   * launches nothing once this is called, and one in flight is waited for, so no browser starts after the close. A
   * second call waits for the first.
   */
  close(): Promise<void> {
    this.#closing ??= this.#closeAll()
    return this.#closing
  }

  async #closeAll(): Promise<void> {
    const { cleanup } = this.#options.timeouts
    await this.#setups
    const browsers = [...this.#launched.values()].flatMap((entry) => (entry.browser === undefined ? [] : [entry.browser]))
    await Promise.all(browsers.map((browser) => bounded(browser.close(cleanup), cleanup + closeGraceMs + abortGraceMs)))
    await bounded(Promise.all(this.#releases), cleanup)
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
    const { target } = driver
    const found = await this.#options.findExecutable(target)
    if (!found.ok) return found
    if (this.#closing !== undefined) return closed()
    const executablePath = found.path
    const headless = this.#options.headless && target.headless
    const key = JSON.stringify([executablePath, headless, target.emulate ?? null, instance])
    const hidden = this.#options.hiddenVariables === undefined ? {} : { hiddenVariables: this.#options.hiddenVariables }
    const launched = this.#launched.get(key) ?? (await this.#launch(key, { executablePath, headless, logFile: this.#options.logFile(app.name, target.name, instance), ...hidden }))
    if (launched.kind !== 'ready') return { ok: false, failure: launched.failure }
    const { browser } = launched
    const emulation = target.emulate === undefined ? undefined : emulationFor(target.emulate, browser.version)
    this.#announce(app, target, browser, emulation, instance)
    return { ok: true, key, ...(emulation === undefined ? {} : { emulation }), ...(target.proxy === undefined ? {} : { proxy: target.proxy }) }
  }

  async #launch(key: string, options: LaunchOptions): Promise<Launched> {
    const { setup, cleanup } = this.#options.timeouts
    const launching = this.#options.launch(options, setup)
    const launched = await bounded(launching, setup + abortGraceMs, this.#options.stopped)
    if (launched.status !== 'done') {
      if (launched.status !== 'failed') this.#releases.push(launching.then((browser) => browser.close(cleanup)).catch(() => undefined))
      const stopped = launched.status === 'stopped' ? this.#options.interruption() : undefined
      const entry: Launched = { kind: 'unavailable', failure: stopped ?? launchFailure(launched, setup) }
      this.#launched.set(key, entry)
      return entry
    }
    const browser = launched.value
    // A browser that finished launching while the pool was closing is closed with the rest, never handed out.
    if (this.#closing !== undefined) {
      this.#releases.push(browser.close(cleanup).catch(() => undefined))
      const entry: Launched = { kind: 'unavailable', failure: this.#options.interruption() ?? failure('setup_failed', 'The browser was closed.') }
      this.#launched.set(key, entry)
      return entry
    }
    const entry: Launched = { kind: 'ready', browser }
    this.#launched.set(key, entry)
    browser.onDisconnect((reason) => this.#lost(key, browser, reason))
    return entry
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

function launchFailure(launched: Exclude<Bounded<OwnedBrowser>, { status: 'done' }>, setupMs: number): Failure {
  if (launched.status === 'failed') {
    const { error } = launched
    return error instanceof LaunchError ? error.failure : failure('setup_failed', `The browser did not start: ${errorMessage(error)}`)
  }
  return failure('setup_failed', `The browser did not start within the ${setupMs} ms setup budget.`)
}
