import type { AppStateReading, BrowserCommand, DispatchedRequest, LaunchSpec, NativeRuntime, NativeRuntimeIdentity, NewPageOptions, OwnedBrowser, OwnedPage, PageNavigation, SessionOwner } from '../browser/contract.ts'
import type { LoadedNativeTarget } from '../config/loaded.ts'
import type { ExecutorBuild, ExecutorName } from '../native/executors.ts'
import type { AppBundle, NativeExecutionIdentity } from '../native/identity.ts'
import type { NativeLook } from '../native/assertions.ts'
import type { NativeInteractionOptions } from '../native/interaction-session.ts'
import type { LoggedNativeLaunch, LoggedNativeLaunchOptions, NativeLogSource } from '../native/logs.ts'
import type { NativeTools } from '../native/processes.ts'
import type { DriverAnswer, NativeAppSession, NativeCapture, NativeLauncher, NativeSessionOptions } from '../native/session.ts'
import type { ExecutorClient, ExecutorSession, RequestBounds } from '../native/webdriver-client.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { NativeStartingState } from '../protocol/execution.ts'
import type { NativeOutcomeRecord } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { PageCommand } from '../protocol/commands.ts'
import type { TextQuery } from '../protocol/host-check.ts'
import type { PageReading } from '../browser/contract.ts'
import type { FrameSource } from '../media/capture.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import type { Opened } from './browser-pool.ts'
import type { HeldApp, ResourceLease } from './resources.ts'
import type { ChildProcess } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { BrowserError } from '../browser/browser-error.ts'
import { endHolder, holdKernelLock } from '../native/desktop-lock.ts'
import { readAppBundle } from '../native/identity.ts'
import { ensureExecutorBuild } from '../native/executors.ts'
import { IosSimulatorRuntime } from '../native/ios-simulator.ts'
import { NativeInteractionSession } from '../native/interaction-session.ts'
import { launchLoggedNativeApp } from '../native/logs.ts'
import { MacosDesktop } from '../native/macos-app.ts'
import { listProcesses, systemTools } from '../native/processes.ts'
import { resetPolicyFor } from '../native/reset-policy.ts'
import { NativeError } from '../native/session.ts'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { sha256Hex } from '../shared/sha256.ts'
import { bounded } from './bounded.ts'

/**
 * A runtime's lifecycle and the identity read from the installed app and executor. Its `openSession` hands over the
 * executor client and session it opened for the app, which the interaction session drives; a runtime that hands none
 * over gets no interaction session.
 */
export type NativePoolRuntime = Omit<NativeRuntime, 'openSession'> & {
  readonly port: number
  readonly execution: NativeExecutionIdentity
  readonly bundle: AppBundle
  openSession(options: NativeSessionOptions, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly session: NativeAppSession; readonly client?: ExecutorClient; readonly executor?: ExecutorSession } | { readonly ok: false; readonly failure: Failure }>
}
export type NativeFactoryContext = { readonly tools: NativeTools; readonly logFolder: string; readonly timeoutMs: number; readonly signal: AbortSignal; readonly redact: (text: string) => string }
export type StartNative = (target: LoadedNativeTarget, context: NativeFactoryContext) => Promise<{ readonly ok: true; readonly value: { readonly runtime: NativePoolRuntime; readonly close: (timeoutMs: number) => Promise<void> } } | { readonly ok: false; readonly failure: Failure; readonly idle?: true; readonly cleaned?: true }>
export type ReadyNativeTarget = { readonly browser: NativeBrowserAdapter; readonly runtime: NativeRuntimeIdentity & { readonly execution: NativeExecutionIdentity }; readonly emulation?: never; readonly proxy?: never }
/** Launches the app with a pipe on its standard output: `launchLoggedNativeApp` unless a test gives a stand-in. */
export type LaunchWithLogs = (options: LoggedNativeLaunchOptions) => Promise<LoggedNativeLaunch>
export type NativePoolOptions = {
  readonly logFolder: (app: string, target: string, attemptId: string) => string
  readonly setupMs: number
  readonly cleanupMs: number
  readonly signal: AbortSignal
  readonly hiddenVariables: readonly string[]
  readonly redact: (text: string) => string
  readonly onLost: (browser: OwnedBrowser, reason: string) => void
  readonly onEnded?: (browser: NativeBrowserAdapter) => void
  readonly start?: StartNative
  readonly interact?: (runtime: NativePoolRuntime, options: NativeSessionOptions, timeoutMs: number, signal: AbortSignal, tools: NativeTools) => Promise<Opened<NativeInteractionSession>>
  readonly launchWithLogs?: LaunchWithLogs
}

/** Native runtimes start only for an acquired lease and end before its resource can be handed on. */
export class NativePool {
  readonly #options: NativePoolOptions
  readonly #freeStarts = new Set<string>()
  readonly #runtimeHolders = new Map<string, string>()
  readonly #free = new Map<string, PromiseWithResolvers<void>>()
  readonly #apps = new Map<string, NativeBrowserAdapter>()
  readonly #starting = new Set<Promise<Opened<ReadyNativeTarget>>>()
  /** Apps whose failed close an attempt already recorded, which the run's end does not report again. */
  readonly #reported = new WeakSet<NativeBrowserAdapter>()
  #closing = false

  constructor(options: NativePoolOptions) { this.#options = options }

  ensure(app: string, target: LoadedNativeTarget, owner: SessionOwner, lease: ResourceLease): Promise<Opened<ReadyNativeTarget>> {
    const work = this.#ensure(app, target, owner, lease)
    this.#starting.add(work)
    void work.finally(() => this.#starting.delete(work)).catch(() => undefined)
    return work
  }

  async #ensure(app: string, target: LoadedNativeTarget, owner: SessionOwner, lease: ResourceLease): Promise<Opened<ReadyNativeTarget>> {
    const kind = target.platform === 'macos' ? 'desktop' : 'device'
    if (lease.attemptId !== owner.attemptId || lease.holder !== owner.testId || !lease.covers.some((part) => part.kind === kind && part.apps.includes(app))) return refused('A native target needs its complete acquired lease before its runtime can start.')
    if (this.#closing || this.#options.signal.aborted) return refused('The native pool is closing.')
    const key = `${owner.attemptId}:${app}`
    if (this.#free.has(key)) return refused('This attempt already opened the native app.')
    const runtimeKey = target.platform === 'macos' ? 'macos' : `${target.device} (${target.runtime})`
    if (this.#runtimeHolders.has(runtimeKey)) return refused('The native resource already has an active runtime. Its session must end before another can open.')
    const hidden = new Set(this.#options.hiddenVariables)
    for (const name of Object.keys(target.environment ?? {})) if (hidden.has(name)) return refused(`The native app cannot receive the hidden variable ${name}.`)
    const free = Promise.withResolvers<void>()
    this.#free.set(key, free)
    this.#runtimeHolders.set(runtimeKey, key)
    void free.promise.then(() => this.#runtimeHolders.delete(runtimeKey))
    const tools: NativeTools = { ...systemTools, hiddenVariables: this.#options.hiddenVariables, redact: this.#options.redact }
    const options: NativeSessionOptions = { owner, launch: { arguments: target.arguments ?? [], environment: target.environment ?? {} }, redact: this.#options.redact }
    let started: Awaited<ReturnType<StartNative>>
    try {
      started = await (this.#options.start ?? startNative)(target, { tools, logFolder: this.#options.logFolder(app, target.name, owner.attemptId), timeoutMs: this.#options.setupMs, signal: this.#options.signal, redact: this.#options.redact })
    } catch (error) {
      // A thrown start supplies no proof that it launched nothing. Keep its release signal unresolved.
      return refused(this.#options.redact(errorMessage(error)))
    }
    if (!started.ok) { if (started.idle === true || started.cleaned === true) { this.#freeStarts.add(key); free.resolve() }; return started }
    const browser = new NativeBrowserAdapter({ ...started.value, target, owner, options, tools, signal: this.#options.signal, interact: this.#options.interact ?? openInteraction, launchWithLogs: this.#options.launchWithLogs ?? launchLoggedNativeApp, cleanupMs: this.#options.cleanupMs })
    // Record ownership before opening a session, so partial setup is also closed at run end.
    this.#apps.set(key, browser)
    void browser.ended.then(() => { free.resolve(); this.#options.onEnded?.(browser) })
    browser.onDisconnect((reason) => this.#options.onLost(browser, reason))
    try {
      await browser.prepare(this.#options.setupMs)
      if (this.#closing || this.#options.signal.aborted) { await browser.close(this.#options.cleanupMs); return refused('The native pool stopped during setup.') }
      return { ok: true, value: { browser, runtime: browser.identity } }
    } catch (error) {
      await browser.close(this.#options.cleanupMs).catch(() => undefined)
      return { ok: false, failure: error instanceof NativeError ? error.failure : { class: 'setup_failed', message: this.#options.redact(errorMessage(error)) } }
    }
  }

  heldApp(attemptId: string, app: string): HeldApp | undefined {
    const key = `${attemptId}:${app}`
    const free = this.#free.get(key)
    if (free === undefined) return undefined
    return { whenFree: async () => {
      const browser = this.#apps.get(key)
      if (browser !== undefined) await browser.close(this.#options.cleanupMs)
      await free.promise
    } }
  }

  held(browser: NativeBrowserAdapter): HeldApp { return { whenFree: () => browser.close(this.#options.cleanupMs).then(() => browser.ended) } }

  /**
   * Closes an app an attempt ran, within `timeoutMs`, and says why it could not, redacted. The attempt records that
   * failure beside its outcome, so the run's end does not count it again; the app's part of the lease stays held, and
   * its expiry is recorded once.
   */
  async closeApp(browser: NativeBrowserAdapter, timeoutMs: number): Promise<string | undefined> {
    try {
      await browser.close(timeoutMs)
      return undefined
    } catch (error) {
      this.#reported.add(browser)
      return this.#options.redact(errorMessage(error))
    }
  }
  connected(browser: OwnedBrowser): boolean { return browser instanceof NativeBrowserAdapter && browser.connected }
  async close(): Promise<Failure[]> {
    this.#closing = true
    await Promise.allSettled(this.#starting)
    const failures: Failure[] = []
    for (const browser of this.#apps.values()) {
      if (this.#reported.has(browser)) continue
      await browser.close(this.#options.cleanupMs).catch((error: unknown) => failures.push({ class: 'cleanup_failed', message: this.#options.redact(errorMessage(error)) }))
    }
    for (const [key] of this.#free) if (!this.#apps.has(key) && !this.#freeStarts.has(key)) failures.push({ class: 'cleanup_failed', message: `Retest could not prove the native start for ${key} ended. Its lease stays held unless the start proved it left no resource in use.` })
    return failures
  }
}

type NativeBrowserOptions = {
  readonly runtime: NativePoolRuntime
  readonly close: (timeoutMs: number) => Promise<void>
  readonly target: LoadedNativeTarget
  readonly owner: SessionOwner
  readonly options: NativeSessionOptions
  readonly tools: NativeTools
  readonly signal: AbortSignal
  readonly cleanupMs: number
  readonly interact: NonNullable<NativePoolOptions['interact']>
  readonly launchWithLogs: LaunchWithLogs
}

type LauncherAnswer = { readonly answer: DriverAnswer<unknown>; readonly processes: readonly LoggedNativeLaunch['process'][] }

/** Compatibility with the runner's internal page holder; no browser capability is supplied to a native app. */
export class NativeBrowserAdapter implements OwnedBrowser {
  readonly #options: NativeBrowserOptions
  readonly #ended = Promise.withResolvers<void>()
  #closing: Promise<void> | undefined
  #page: NativePageAdapter | undefined
  #opened = false
  #logs: NativeLogSource | undefined
  // The launch that kept the app's output, once one was made: it settles to undefined when it recorded nothing to end.
  #logged: Promise<LoggedNativeLaunch | undefined> | undefined
  // The kernel lock on the app's declared network file, held from before its session opens until it closes.
  #networkLock: ChildProcess | undefined
  constructor(options: NativeBrowserOptions) { this.#options = options }
  get page(): NativePageAdapter | undefined { return this.#page }
  get target(): LoadedNativeTarget { return this.#options.target }
  get owner(): SessionOwner { return this.#options.owner }
  get identity(): NativeRuntimeIdentity & { readonly execution: NativeExecutionIdentity } { return { ...this.#options.runtime.identity, execution: this.#options.runtime.execution } }
  get product(): string { return this.#options.runtime.bundle.displayName ?? this.#options.runtime.bundle.name ?? this.#options.runtime.bundle.executable }
  get version(): string { return this.#options.runtime.bundle.version ?? '' }
  get executablePath(): string { return this.#options.runtime.bundle.appPath }
  get pid(): number { return this.identity.processIds[0] ?? 0 }
  get userAgent(): string { return '' }
  get connected(): boolean { return this.#closing === undefined && this.#options.runtime.connected }
  get ended(): Promise<void> { return this.#ended.promise }
  get startingState(): NativeStartingState {
    const policy = resetPolicyFor(this.target.platform)
    return { ...policy.contract, boundary: policy.boundary, ...(this.target.arguments?.includes('-reset') === true ? { appReset: true as const } : {}), notIsolated: [...policy.leftToTheApp, ...policy.notIsolated].map((item) => `${item.state}: ${item.how}`) }
  }
  onDisconnect(listener: (reason: string) => void): () => void { return this.#options.runtime.onDisconnect(listener) }
  /** Whether the app's launch keeps its standard output, as its target declares; it does unless `logs` is 'none'. */
  get keepsStdout(): boolean { return (this.target.diagnostics?.logs ?? 'stdout') === 'stdout' }
  /**
   * The source the app's standard output goes to, given before the app launches. Without one, or for a target that
   * keeps no log, the executor launches the app.
   */
  keepLogs(source: NativeLogSource): void {
    if (this.#opened) throw new NativeError({ class: 'usage', message: "The app's log source came after the app launched." })
    this.#logs = source
  }
  async prepare(timeoutMs: number): Promise<void> {
    await this.#holdNetworkFile()
    const launcher: NativeLauncher = (launch, bounds) => this.#launchWithLogs(launch, bounds)
    const opened = await this.#options.interact(this.#options.runtime, { ...this.#options.options, launcher }, timeoutMs, this.#options.signal, this.#options.tools)
    if (!opened.ok) throw new NativeError(opened.failure)
    this.#page = new NativePageAdapter(opened.value)
    if (this.target.platform === 'ios-simulator') {
      const installed = await opened.value.install({ appPath: this.target.appPath }, timeoutMs, this.#options.signal)
      if (!installed.result.ok) throw new NativeError(installed.result.failure)
    }
  }
  async newPage(options: NewPageOptions, timeoutMs: number): Promise<NativePageAdapter> {
    if (Object.keys(options).length > 0) throw new NativeError({ class: 'unsupported', message: 'A native app has no browser URL, emulation, proxy or saved browser storage.' })
    if (this.#opened || this.#page === undefined || !this.connected) throw new NativeError({ class: 'setup_failed', message: 'The native app session is unavailable or has already been opened.' })
    this.#opened = true
    const deadline = new Deadline(timeoutMs)
    const launched = await this.#page.native.launch(deadline.commandTimeoutMs, this.#options.signal)
    if (!launched.result.ok) throw new NativeError(launched.result.failure)
    // The macOS runner reads and drives only the app its own launch or activation named, and Finder otherwise. An app
    // launched with its output kept is named to it by an activation, which brings it in front as the runner's launch does.
    if (this.target.platform === 'macos' && this.#logged !== undefined) {
      const activated = await this.#page.native.activate(deadline.commandTimeoutMs, this.#options.signal)
      if (!activated.result.ok) throw new NativeError(activated.result.failure)
    }
    return this.#page
  }
  close(timeoutMs: number): Promise<void> { this.#closing ??= this.#close(timeoutMs); return this.#closing }
  async #close(timeoutMs: number): Promise<void> {
    const failures: string[] = []
    const deadline = new Deadline(timeoutMs)
    if (this.#page !== undefined) await this.#page.dispose(deadline.commandTimeoutMs).catch((error: unknown) => failures.push(errorMessage(error)))
    // Once the session has ended the app, the launch that kept its output ends what it recorded and no other process:
    // its app, should the session have left it, and the simulator's console launcher. One that cannot settle keeps the
    // lease held.
    if (this.#logged !== undefined) failures.push(...(await stopLogged(this.#logged, deadline)))
    await this.#options.close(deadline.commandTimeoutMs).catch((error: unknown) => failures.push(errorMessage(error)))
    if (this.#networkLock !== undefined) await endHolder(this.#networkLock).catch((error: unknown) => failures.push(errorMessage(error)))
    // A rejection keeps the lease held. A disconnected pipe is not proof that an app has ended.
    if (failures.length > 0) throw new NativeError({ class: 'cleanup_failed', message: failures.join(' ') })
    this.#ended.resolve()
  }

  // The launch that keeps the app's standard output, for a target that keeps it once the run gave its source. It answers
  // the session as a driver would: answered with the process it recorded; when it threw, a failure whose outcome is
  // unknown, since it may have started the app first; a stop or a timeout while it ran, as unknown. Whatever it settles
  // to later stays in `#logged`, so closing ends what it recorded.
  async #launchWithLogs(launch: LaunchSpec, bounds: RequestBounds): Promise<LauncherAnswer | undefined> {
    const source = this.#logs
    if (source === undefined || !this.keepsStdout) return undefined
    if (this.#logged !== undefined) return { answer: { status: 'failed', input: 'not_sent', failure: { class: 'unsupported', message: "Retest keeps an app's standard output for one launch per session, so it launched nothing." } }, processes: [] }
    const target = this.#logTarget()
    if (target === undefined) return { answer: { status: 'failed', input: 'not_sent', failure: { class: 'setup_failed', message: 'Retest could not tell which simulator the app runs on, so it launched nothing.' } }, processes: [] }
    const startedAt = performance.now()
    const launching = Promise.resolve().then(() => this.#options.launchWithLogs({ source, tools: this.#options.tools, launch, timeoutMs: bounds.timeoutMs, target }))
    this.#logged = launching.then((launched) => launched, () => undefined)
    const settled = await bounded(launching, bounds.timeoutMs + logLaunchGraceMs, stoppedBy(bounds.signal, launching))
    const durationMs = Math.round(performance.now() - startedAt)
    if (settled.status === 'done') return { answer: { status: 'answered', value: null, durationMs }, processes: [settled.value.process] }
    if (settled.status === 'failed') return { answer: { status: 'failed', input: 'unknown', failure: { class: 'outcome_unknown', message: `Launching the app with its standard output kept failed: ${this.#options.options.redact(errorMessage(settled.error))} The launch may have happened.` } }, processes: [] }
    const reason = settled.status === 'stopped' ? 'stopped' : 'timeout'
    return { answer: { status: 'unknown', reason, message: `the launch with the app's standard output kept had not finished after ${durationMs} ms.`, durationMs }, processes: [] }
  }

  // A declared network file is attributed by its client name alone, so two runs reading one file for one client could not
  // tell their records apart. The app holds a kernel lock for the file, which another Retest process, or another run in
  // this one, cannot take meanwhile, and which the system lets go if this process dies. The lock file is Retest's own, in
  // the user's shared cache, named for the file's real path and declared client. Its inode stays after release so a waiter cannot hold a
  // different inode. Run-specific temporary folders cannot provide exclusion across runs.
  async #holdNetworkFile(): Promise<void> {
    const network = this.target.diagnostics?.network
    // Native apps run only on a Mac, where `lockf` is a system tool; off a Mac only a stand-in executor runs one.
    if (network === undefined || process.platform !== 'darwin') return
    const folder = join(homedir(), 'Library', 'Caches', 'retest', 'network-locks')
    await mkdir(folder, { recursive: true })
    const path = join(folder, `${sha256Hex(JSON.stringify([realPathOf(network.path), network.client]))}.lock`)
    const held = await holdKernelLock({ path, tools: this.#options.tools, name: 'lock on the network file' })
    if (!held.ok) {
      const message = held.reason === 'held' ? `Another run reads the network file ${network.path} for its native app, and two runs cannot tell their records apart, so Retest launched nothing.` : held.reason
      throw new NativeError({ class: 'setup_failed', message })
    }
    this.#networkLock = held.holder
  }

  // Where that launch starts the app: at its executable on the Mac, or by bundle id on the session's own simulator.
  #logTarget(): LoggedNativeLaunchOptions['target'] | undefined {
    const { bundle, execution } = this.#options.runtime
    if (this.target.platform === 'macos') return { platform: 'macos', executable: join(bundle.appPath, 'Contents', 'MacOS', bundle.executable) }
    const udid = execution.device?.udid
    return udid === undefined ? undefined : { platform: 'ios-simulator', udid, bundleId: bundle.bundleId, executable: bundle.executable }
  }
}

/** Commands route to the native locator layer; its tree, references, actionability and input ledger remain authoritative. */
export class NativePageAdapter implements OwnedPage {
  readonly native: NativeInteractionSession
  readonly #looks = new WeakMap<object, NativeLook>()
  constructor(native: NativeInteractionSession) { this.native = native }
  get recordedOutcomes(): NativeOutcomeRecord[] {
    return this.native.unknownOutcomes.map(({ source, outcome }) => {
      const reconciled = outcome.reconciled === undefined ? {} : { reconciled: outcome.reconciled.ok ? { running: outcome.reconciled.running, pids: [...outcome.reconciled.pids] } : { problem: outcome.reconciled.problem } }
      return { source, id: outcome.id, kind: outcome.kind, generation: outcome.generation, ...(source === 'input' && 'route' in outcome ? { route: outcome.route, input: outcome.input } : {}), ...(outcome.failure === undefined ? {} : { failure: outcome.failure }), ...reconciled }
    })
  }
  /** The bundle id the installed app names: a native app's only secret destination. */
  get bundleId(): string { return this.native.session.execution.app.bundleId }
  get url(): undefined { return undefined }
  readPage(_queries: readonly TextQuery[], _timeoutMs: number): Promise<PageReading> { return Promise.reject(new BrowserError({ class: 'unsupported', message: 'Native apps have no web page address, title or CSS page queries.' })) }
  get committedUrl(): undefined { return undefined }
  onNavigation(_listener: (navigation: PageNavigation) => void): () => void { return () => undefined }
  captureState(_timeoutMs: number): Promise<StorageState> { return Promise.reject(new BrowserError({ class: 'unsupported', message: 'Native apps cannot save browser storage.' })) }
  lookFor(observation: object): NativeLook | undefined { return this.#looks.get(observation) }
  cancel(reason: Failure): void { this.native.cancel(reason) }
  async execute(command: BrowserCommand | Extract<PageCommand, { kind: 'swipe' | 'nativeKeyboard' | 'nativeAlert' }>, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    if (command.kind === 'observe') {
      const looked = await this.native.observe(command.locator, timeoutMs, signal)
      if (!looked.ok) return looked
      this.#looks.set(looked.look.observation, looked.look)
      return { ok: true, kind: 'observe', observation: looked.look.observation }
    }
    if (command.kind === 'swipe') {
      const dispatched = await this.native.gesture(command, timeoutMs, signal)
      return dispatched.result.ok ? { ok: true, kind: 'swipe' } : dispatched.result
    }
    if (command.kind === 'nativeKeyboard') {
      // The first-run keyboard card is an iOS screen. The types keep it off a macOS page; a caller that reaches it anyway
      // is refused here, before anything is read or pressed.
      if (command.operation === 'dismissFirstRunCard' && this.native.session.execution.platform === 'macos') return unsupported('The first-run keyboard card is an iOS screen, and a macOS app has none, so Retest sent nothing.')
      if (command.operation === 'wait') {
        const read = await this.native.waitForKeyboard(timeoutMs, signal)
        return read.ok ? { ok: true, kind: 'nativeKeyboard' } : read
      }
      const sent = command.operation === 'dismiss' ? await this.native.dismissKeyboard(timeoutMs, signal) : await this.native.dismissFirstRunCard(timeoutMs, signal)
      return sent.result.ok ? { ok: true, kind: 'nativeKeyboard' } : sent.result
    }
    if (command.kind === 'nativeAlert') {
      if (command.button === undefined) return unsupported('An alert action needs the exact button label.')
      const sent = await this.native.answerAlert({ button: command.button, route: command.operation }, timeoutMs, signal)
      return sent.result.ok ? { ok: true, kind: 'nativeAlert' } : sent.result
    }
    if (command.kind === 'fill' || command.kind === 'click' || command.kind === 'tap' || command.kind === 'press' || command.kind === 'scroll') {
      // The parent checks the bundle id before it reads the value; this page checks the fill names its own app too.
      if (command.kind === 'fill' && command.secret !== undefined && command.allowedOrigins?.includes(this.bundleId) !== true) return unsupported(`Retest typed no secret into ${this.bundleId}: a secret reaches a native app only after Retest has checked that secretOrigins names its bundle id.`)
      return (await this.native.dispatch(command, timeoutMs, signal)).result
    }
    return unsupported(`${command.kind} is a web capability and is not available on a native app.`)
  }
  capture(timeoutMs: number): Promise<{ readonly ok: true; readonly capture: NativeCapture } | { readonly ok: false; readonly failure: Failure }> { return this.native.capture(timeoutMs) }
  frameSource(identity: RecordIdentity): FrameSource { return this.native.frameSource(identity) }
  screenshot(timeoutMs: number): Promise<Uint8Array> { return this.native.screenshot(timeoutMs) }
  async dispose(timeoutMs: number): Promise<void> { const deadline = new Deadline(timeoutMs); await this.native.reconcile(deadline.commandTimeoutMs); await this.native.dispose(deadline.commandTimeoutMs) }
}

/** Launch settings are bound when the runtime opens its session; a later launch cannot silently replace them. */
export class BoundNativeInteractionSession extends NativeInteractionSession {
  readonly #launch: LaunchSpec

  constructor(options: NativeInteractionOptions, launch: LaunchSpec) {
    super(options)
    this.#launch = { arguments: [...launch.arguments], environment: { ...launch.environment } }
  }

  override launch(timeoutMs: number, signal?: AbortSignal, spec?: LaunchSpec): Promise<DispatchedRequest> {
    if (spec !== undefined && !sameLaunch(spec, this.#launch)) return Promise.resolve({ result: { ok: false, failure: { class: 'unsupported', message: 'Launch settings are bound when this native session opens. Open another session to change them.' } }, input: 'not_sent' })
    return super.launch(timeoutMs, signal)
  }

  override async appState(timeoutMs: number, signal?: AbortSignal): Promise<AppStateReading> {
    const read = await super.appState(timeoutMs, signal)
    return read.ok ? { ...read, endedUnexpectedly: this.session.appStatus.endedUnexpectedly } : read
  }
}

function sameLaunch(left: LaunchSpec, right: LaunchSpec): boolean {
  if (left.arguments.length !== right.arguments.length || left.arguments.some((value, index) => value !== right.arguments[index])) return false
  const names = Object.keys(left.environment)
  return names.length === Object.keys(right.environment).length && names.every((name) => Object.hasOwn(right.environment, name) && left.environment[name] === right.environment[name])
}

async function openInteraction(runtime: NativePoolRuntime, options: NativeSessionOptions, timeoutMs: number, signal: AbortSignal, tools: NativeTools): Promise<Opened<NativeInteractionSession>> {
  const opened = await runtime.openSession(options, timeoutMs, signal)
  if (!opened.ok) return opened
  // Input, secrets among it, goes only to the executor session the runtime opened for this app. Whatever session the
  // executor names as active could be one Retest did not open, so nothing attaches by asking it.
  const { client, executor } = opened
  if (client === undefined || executor === undefined) {
    await opened.session.dispose(timeoutMs).catch(() => undefined)
    return refused('The native runtime did not hand over the executor session it opened for the app, and Retest attaches to no other.')
  }
  try {
    const session = opened.session
    const interaction = new BoundNativeInteractionSession({ session, client, executor, redact: options.redact, tools, processes: async (bounds) => {
      try { const entries = await listProcesses(tools, bounds.timeoutMs); const pids = entries.filter((entry) => session.processIds.includes(entry.pid)).map((entry) => entry.pid); return { ok: true, running: pids.length > 0, pids } }
      catch (error) { return { ok: false, problem: options.redact(errorMessage(error)) } }
    } }, options.launch)
    return { ok: true, value: interaction }
  } catch (error) {
    await opened.session.dispose(timeoutMs).catch(() => undefined)
    return refused(options.redact(errorMessage(error)))
  }
}

async function startNative(target: LoadedNativeTarget, context: NativeFactoryContext): ReturnType<StartNative> {
  const bundle = await readAppBundle(target.appPath, target.platform, context.tools, context.signal)
  if (!bundle.ok) return { ...bundle, idle: true }
  const cache = join(homedir(), 'Library', 'Caches', 'retest-proofs')
  const executor: ExecutorName = target.platform === 'macos' ? 'mac2' : 'webdriveragent'
  const build = await ensureExecutorBuild({ executor, sources: { webdriveragent: join(cache, 'WebDriverAgent'), mac2: join(cache, 'appium-mac2-driver') }, adoptFrom: [join(cache, 'derived', executor === 'mac2' ? 'mac2' : 'wda-ios')], logFile: join(context.logFolder, `${executor}-build.log`), timeoutMs: context.timeoutMs, signal: context.signal, tools: context.tools })
  if (!build.ok) return { ...build, idle: true }
  return startBuilt(target, context, build.build)
}
/** The runtimes a native start uses once its executor is built: Retest's own, unless a test gives stand-ins. */
export type NativeRuntimeStarters = { readonly ios: typeof IosSimulatorRuntime.start; readonly macos: typeof MacosDesktop.start }

const runtimeStarters: NativeRuntimeStarters = { ios: (options) => IosSimulatorRuntime.start(options), macos: (options) => MacosDesktop.start(options) }

/**
 * Starts the runtime for a target whose executor is built. `idle` means it created nothing; `cleaned` means its recorded
 * runtime was proved removed after a failed start. Both proofs are passed on, so the pool frees the part the attempt
 * holds; any other refusal leaves the part held, since something may remain.
 *
 * @example await startBuilt(target, context, build) // { ok: false, failure, idle: true } when another process holds the desktop
 */
export async function startBuilt(target: LoadedNativeTarget, context: NativeFactoryContext, build: ExecutorBuild, starters: NativeRuntimeStarters = runtimeStarters): ReturnType<StartNative> {
  if (target.platform === 'ios-simulator') {
    if (target.device === undefined || target.runtime === undefined) return { ...refused('An iOS target needs a device type and runtime.'), idle: true }
    const started = await starters.ios({ target: { appPath: target.appPath, device: target.device, runtime: target.runtime }, build, ...context })
    if (!started.ok) return { ok: false, failure: started.failure, ...(started.idle === true ? { idle: true as const } : {}), ...(started.cleaned === true ? { cleaned: true as const } : {}) }
    return { ok: true, value: { runtime: started.runtime, close: (timeoutMs) => started.runtime.close(timeoutMs) } }
  }
  const started = await starters.macos({ build, ...context })
  if (!started.ok) return started.idle === true ? { ok: false, failure: started.failure, idle: true } : { ok: false, failure: started.failure }
  const opened = await started.desktop.openApp(target.appPath, context.signal)
  if (!opened.ok) { await started.desktop.close(context.timeoutMs); return { ...opened, idle: true } }
  return { ok: true, value: { runtime: { get identity() { return opened.runtime.identity }, get execution() { return opened.runtime.execution }, get bundle() { return opened.runtime.bundle }, port: started.desktop.port, get connected() { return opened.runtime.connected }, onDisconnect: (listener) => opened.runtime.onDisconnect(listener), openSession: (options, timeoutMs, signal) => opened.runtime.openSession(options, timeoutMs, signal), close: (timeoutMs) => opened.runtime.close(timeoutMs) }, close: async (timeoutMs) => { await opened.runtime.close(timeoutMs); await started.desktop.close(timeoutMs) } } }
}
// The real path of a file that may not exist yet: its folder's, through every link, with its own name added.
function realPathOf(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute))
    } catch {
      return absolute
    }
  }
}

// How long past its own budget the launch that keeps the app's output is waited for: its process readings each take a
// bounded time of their own.
const logLaunchGraceMs = 1000

// Settles once `signal` aborts. The listener is removed when `work` settles, so a signal that never aborts keeps nothing.
function stoppedBy(signal: AbortSignal | undefined, work: Promise<unknown>): Promise<void> | undefined {
  if (signal === undefined) return undefined
  if (signal.aborted) return Promise.resolve()
  const { promise, resolve } = Promise.withResolvers<void>()
  const onAbort = (): void => resolve()
  signal.addEventListener('abort', onAbort, { once: true })
  void work.then(() => signal.removeEventListener('abort', onAbort), () => signal.removeEventListener('abort', onAbort))
  return promise
}

// Ends what the launch that kept the app's output recorded, within the cleanup budget, saying what could not be ended.
async function stopLogged(logged: Promise<LoggedNativeLaunch | undefined>, deadline: Deadline): Promise<string[]> {
  const launched = await bounded(logged, deadline.commandTimeoutMs)
  if (launched.status !== 'done') return ["The launch that kept the app's standard output had not settled when the session closed, so Retest could not end what it recorded."]
  if (launched.value === undefined) return []
  const stopped = await bounded(launched.value.stop(), deadline.commandTimeoutMs)
  if (stopped.status === 'done') return []
  if (stopped.status === 'failed') return [errorMessage(stopped.error)]
  return [`The app launched with its standard output kept did not end within ${deadline.commandTimeoutMs} ms.`]
}

function refused(message: string): { readonly ok: false; readonly failure: Failure } { return { ok: false, failure: { class: 'setup_failed', message } } }
function unsupported(message: string): { readonly ok: false; readonly failure: Failure } { return { ok: false, failure: { class: 'unsupported', message } } }
