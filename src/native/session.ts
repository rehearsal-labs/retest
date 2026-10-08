import type { AppBuild, AppLifecycleCapability, AppState, AppStateReading, DispatchedRequest, InputDispatch, ObservationScope, ResetPolicy, SessionIdentity, SessionOwner } from '../browser/contract.ts'
import type { FrameSource } from '../media/capture.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { AppBundle, NativeExecutionIdentity } from './identity.ts'
import type { RecordedProcess } from './processes.ts'
import type { ScopedSource } from './source-scope.ts'
import type { ExecutorAnswer, ExecutorAppState, RequestBounds } from './webdriver-client.ts'
import { randomBytes } from 'node:crypto'
import { Deadline } from '../protocol/deadline.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { failureSchema } from '../protocol/failures.ts'
import { parse } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { nativeCaptureTargetCheck, nativeFrameSource } from './capture.ts'
import { runtimeIdentity } from './identity.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { locate, parseNativeTree, redactNativeXml, valueOf } from './locators.ts'
import { redactNativeFailure } from './output.ts'
import { pngSize } from './png.ts'
import { recordedIdentity } from './processes.ts'
import { inputDispatch } from './webdriver-client.ts'
import { transientSourceProblem } from './source-scope.ts'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'

// A native session: one app on one simulator or on the Mac, in one attempt. It implements the contract's app lifecycle
// on top of a platform driver, and keeps what the contract asks of every session: its id on everything it hands out,
// one request at a time, a deadline on each, references refused once their launch is over, cancellation that stops new
// work, and a ledger of requests whose outcome is unknown for the runner to reconcile. Locators, input and checks
// build on it.

/** A capture source, named so a capture is never taken for another: the executor's screen, the simulator's display, or the app's own window as the Mac's window server draws it. */
export type CaptureSource = 'executor-screen' | 'simulator-display' | 'window-crop'

/** A driver's answer: the executor's, or a failure Retest found itself, with how far the request got. */
export type DriverAnswer<T> = ExecutorAnswer<T> | { readonly status: 'failed'; readonly failure: Failure; readonly input: InputDispatch }

/** The operating system's own view of the app's processes, read without the executor. */
export type ProcessReading = { readonly ok: true; readonly running: boolean; readonly pids: readonly number[] } | { readonly ok: false; readonly problem: string }

/**
 * A driver's reading of the app's processes, read without the executor: each with its command line, so the session
 * records what it owns and a process is ended only while it is still the one recorded. The command lines stay inside
 * the session; what it reports is the `ProcessReading` without them.
 */
export type AppProcessReading = { readonly ok: true; readonly running: boolean; readonly pids: readonly number[]; readonly processes: readonly RecordedProcess[] } | { readonly ok: false; readonly problem: string }

/** The arguments and environment a launch gives the app. */
export type LaunchSpec = { readonly arguments: readonly string[]; readonly environment: Readonly<Record<string, string>> }

/**
 * What a native session asks of its platform. The iOS simulator runtime and the macOS desktop each give one per
 * session. Every method is bounded by its `bounds` and never throws for an app or platform problem.
 */
export interface NativeAppDriver {
  readonly platform: 'ios-simulator' | 'macos'
  readonly bundle: AppBundle
  readonly identity: NativeExecutionIdentity
  readonly resetPolicy: ResetPolicy
  /** The processes of the runtime the session runs on: the executor's xcodebuild and its runner app. */
  readonly runtimeProcessIds: readonly number[]
  /** The capture sources this platform offers; the first is the session's screenshot. */
  readonly captureSources: readonly CaptureSource[]
  install(build: AppBuild, bounds: RequestBounds): Promise<DriverAnswer<unknown>>
  /** Why a launch must not go now, as the operating system shows it, such as another copy running; undefined when nothing stops it. */
  launchBlocker(bounds: RequestBounds): Promise<Failure | undefined>
  launch(launch: LaunchSpec, bounds: RequestBounds): Promise<DriverAnswer<unknown>>
  activate(bounds: RequestBounds): Promise<DriverAnswer<unknown>>
  terminate(bounds: RequestBounds): Promise<DriverAnswer<boolean>>
  state(bounds: RequestBounds): Promise<DriverAnswer<ExecutorAppState>>
  processState(bounds: RequestBounds): Promise<AppProcessReading>
  capture(source: CaptureSource, bounds: RequestBounds): Promise<DriverAnswer<Uint8Array>>
  /** The tree cut to what the session owns; `redact` runs on menu text before it is hashed. */
  source(bounds: RequestBounds, redact?: (text: string) => string): Promise<DriverAnswer<ScopedSource>>
  /** Ends the app's processes by the operating system, for cleanup after the executor could not; resolves with what is left. */
  forceEnd(processes: readonly RecordedProcess[], bounds: RequestBounds): Promise<string[]>
  /** Ends the executor session; resolves with what could not be ended. */
  endExecutorSession(bounds: RequestBounds): Promise<string[]>
  /** Told once when the session is disposed, so the runtime can let the next session open. */
  released(): void
}

/**
 * A reference to something a session served: its session, the session object that served it, the launch it belongs
 * to, and its own id. `instance` tells two session objects of one attempt and app apart, since they share `sessionId`.
 */
export type NativeReference = ObservationScope & { readonly instance: string; readonly observationId: string }

/** A capture as a session hands it out: the PNG, its named source, its size, its reference and when it came back. */
export type NativeCapture = {
  readonly png: Uint8Array
  readonly source: CaptureSource
  readonly width: number
  readonly height: number
  readonly reference: NativeReference
  readonly capturedAt: string
}

/** A scoped tree as a session hands it out: redacted, with its reference. */
export type NativeSource = { readonly source: ScopedSource; readonly reference: NativeReference }

/**
 * A request whose outcome the session does not know: the processes of the app the operating system showed right after
 * it, and what it showed when it was reconciled.
 */
export type UnknownOutcome = { readonly id: string; readonly kind: LifecycleKind; readonly generation: number; readonly failure: Failure; readonly processesAfter?: ProcessReading; readonly reconciled?: ProcessReading }

/**
 * Where the session's app stands: the launch it is on, whether the session expects it running, and the launches whose
 * app ended without the session terminating it, kept across later launches.
 */
export type AppStatus = { readonly generation: number; readonly expectedRunning: boolean; readonly endedUnexpectedly: boolean; readonly unexpectedEnds: readonly number[] }

/**
 * A launch the session's owner makes in place of the executor's launch route, such as one that keeps the app's
 * standard output: its answer, as a driver gives one, and the app's processes it recorded right after it, each with its
 * command line, which the session takes as its own. The session checks its launch blocker before calling it. A hook
 * that answers undefined leaves the launch to the executor.
 */
export type NativeLauncher = (launch: LaunchSpec, bounds: RequestBounds) => Promise<{ readonly answer: DriverAnswer<unknown>; readonly processes: readonly RecordedProcess[] } | undefined>

/**
 * What a session is opened with. `redact` runs on every text the session hands out, such as a tree, before it leaves.
 * `launcher`, when given, is asked to make each launch.
 */
export type NativeSessionOptions = {
  readonly owner: SessionOwner
  readonly launch: LaunchSpec
  readonly redact: (text: string) => string
  readonly launcher?: NativeLauncher | undefined
}

/** Thrown by a session's screenshot and disposal. The failure says what went wrong. */
export class NativeError extends Error {
  override readonly name = 'NativeError'
  readonly failure: Failure

  constructor(failure: Failure, options?: ErrorOptions) {
    super(failure.message, options)
    this.failure = failure
  }
}

type LifecycleKind = 'install' | 'launch' | 'activate' | 'terminate'

// What each request is called in a failure message.
const requestNames: Readonly<Record<LifecycleKind | 'state' | 'capture' | 'source', string>> = {
  install: 'Installing the app',
  launch: 'Launching the app',
  activate: 'Bringing the app to the front',
  terminate: 'Terminating the app',
  state: "Reading the app's state",
  capture: 'Capturing the screen',
  source: "Reading the app's tree",
}

const states: Readonly<Record<ExecutorAppState, AppState | undefined>> = { 0: undefined, 1: 'not_running', 2: 'background', 3: 'background', 4: 'foreground' }

/**
 * One app's native session. Requests run one at a time in the order they come. Each is bounded by its `timeoutMs` and
 * never throws for an app or platform problem: the answer carries the failure and how far the request got.
 */
export class NativeAppSession implements AppLifecycleCapability {
  readonly sessionId: string
  readonly resetPolicy: ResetPolicy
  readonly #driver: NativeAppDriver
  readonly #options: NativeSessionOptions
  readonly #lane = new SerialLane()
  readonly #cancel = new AbortController()
  readonly #ledger: UnknownOutcome[] = []
  readonly #instance = randomBytes(6).toString('hex')
  // The processes the operating system showed right after a launch of this session, and only those: what the session
  // may terminate or end. A copy the session did not launch is never ended, whatever path ends the app.
  readonly #own = new Map<number, RecordedProcess>()
  readonly #unexpectedEnds: number[] = []
  #requests = 0
  #observations = 0
  #generation = 0
  #generationOpen = false
  #expectRunning = false
  #pids: readonly number[] = []
  // A launch that may have gone whose process its poll window never showed: nothing is claimed for it afterwards, and
  // an app running at dispose is named, not ended.
  #unseenLaunch = false
  #afterLaunch: ProcessReading | undefined
  #lost: Failure | undefined
  #disposing: Promise<void> | undefined

  constructor(driver: NativeAppDriver, options: NativeSessionOptions) {
    this.#driver = driver
    this.#options = options
    this.sessionId = formatSessionId(options.owner.attemptId, options.owner.app)
    this.resetPolicy = driver.resetPolicy
  }

  /** The session's id, who holds it, and what it runs on, as the app's bundle currently names it. */
  get identity(): SessionIdentity {
    return { sessionId: this.sessionId, owner: this.#options.owner, runtime: runtimeIdentity(this.#driver.identity, this.#driver.runtimeProcessIds) }
  }

  /** What results must name about this session's app, operating system and executor. */
  get execution(): NativeExecutionIdentity {
    return this.#driver.identity
  }

  /** Whether the session was cancelled: nothing more is sent, and no reference it handed out is accepted. */
  get cancelled(): boolean {
    return this.#cancel.signal.aborted
  }

  /** Whether the session is over: disposed, or lost with its executor or device. Nothing more is sent. */
  get ended(): boolean {
    return this.#disposing !== undefined || this.#lost !== undefined
  }

  /** Where the app stands. */
  get appStatus(): AppStatus {
    return { generation: this.#generation, expectedRunning: this.#expectRunning, endedUnexpectedly: this.#unexpectedEnds.length > 0, unexpectedEnds: [...this.#unexpectedEnds] }
  }

  /** The processes of the app's current launch, as the operating system showed them after it. */
  get processIds(): readonly number[] {
    return this.#pids
  }

  /** Requests that went and whose outcome is unknown, oldest first, with their reconciliation once it ran. */
  get unknownOutcomes(): readonly UnknownOutcome[] {
    return [...this.#ledger]
  }

  /** Installs a build on the device. A Mac app is never installed: it is launched where it is. */
  install(build: AppBuild, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#act('install', timeoutMs, signal, (bounds) => this.#driver.install(build, bounds))
  }

  /**
   * Launches the app with the session's arguments and environment, as a new launch: it is refused while the app runs,
   * because both executors would bring the running app to the front instead, with none of the arguments. A launch
   * that may have gone starts a new generation, so references from the one before are stale. The app's processes the
   * operating system shows within five seconds of the launch, and never past the request's time, are the session's own,
   * each with its command line; a copy that appears later is never the session's, and disposal names it rather than
   * ending it. A state read before the launch that gets no answer sends nothing. A launcher in the options makes the
   * launch in place of the executor, after the same checks, and the processes it recorded are the session's own too.
   */
  launch(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#act('launch', timeoutMs, signal, async (bounds, deadline) => {
      const state = await this.#stateBefore(bounds)
      if (!state.ok) return state.answer
      if (state.value >= 2) return { status: 'failed', input: 'not_sent', failure: { class: 'not_actionable', message: "The app is already running; terminate it first, so the launch starts a new process with the session's arguments." } }
      // An app the session expected running and finds stopped ended on its own; the fact outlives the next launch.
      if (this.#expectRunning) this.#appEnded()
      const blocker = await this.#driver.launchBlocker({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
      if (blocker !== undefined) return { status: 'failed', input: 'not_sent', failure: bounds.signal?.aborted === true ? stopFailure(bounds.signal.reason, 'not_sent') : blocker }
      const launchBounds = { timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal }
      const hooked = await this.#options.launcher?.(this.#options.launch, launchBounds)
      const launched = hooked?.answer ?? (await this.#driver.launch(this.#options.launch, launchBounds))
      if (launched.status !== 'answered' && inputOf(launched) === 'not_sent') return launched
      // Nothing hands out a reference while the launch runs, since requests take turns.
      this.#generation += 1
      this.#generationOpen = true
      this.#pids = []
      // A launch the owner made names the processes it started, recorded with their command lines right after it.
      if (hooked !== undefined && hooked.processes.length > 0) this.#claim(hooked.processes)
      // Looked for without the request's signal, which a cancel may have stopped, since reading sends nothing to the app,
      // and within the request's own time. The launch blocker showed no copy running just before, so what runs within
      // this window came from this launch; a copy started by someone else within it would be taken for this launch's.
      const window = Math.min(launched.status === 'answered' ? 5000 : 2000, deadline.remainingMs)
      const seen = await this.#claimWithin(window, deadline)
      this.#afterLaunch = withoutCommands(seen)
      if (!(seen.ok && seen.running)) this.#unseenLaunch = true
      if (launched.status !== 'answered') return launched
      if (!seen.ok) return { status: 'failed', input: 'sent', failure: { class: 'outcome_unknown', message: `The executor launched the app, and Retest could not read the app's processes (${seen.problem}), so the session owns none of them.`, details: { generation: this.#generation } } }
      if (!seen.running) return { status: 'failed', input: 'sent', failure: { class: 'session_lost', message: `The executor launched the app, and the app's process was not seen within ${window} ms.`, details: { generation: this.#generation } } }
      return launched
    })
  }

  /** Brings the app to the front. Refused when the app is not running: XCTest would launch it, without the session's arguments. */
  activate(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#act('activate', timeoutMs, signal, async (bounds, deadline) => {
      const state = await this.#stateBefore(bounds)
      if (!state.ok) return state.answer
      if (state.value < 2) return { status: 'failed', input: 'not_sent', failure: this.#notRunning() }
      return this.#driver.activate({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
    })
  }

  /**
   * Terminates the app and checks that its processes are gone. Refused when a copy runs that this session did not
   * launch, since the executors terminate by bundle id or path. Terminating resets none of the app's data.
   */
  terminate(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#act('terminate', timeoutMs, signal, async (bounds, deadline) => {
      const running = await this.#driver.processState(bounds)
      if (!running.ok) return { status: 'failed', input: 'not_sent', failure: bounds.signal?.aborted === true ? stopFailure(bounds.signal.reason, 'not_sent') : { class: 'not_actionable', message: `Retest could not read which copies of the app run, so it terminated nothing: ${running.problem}` } }
      const foreign = running.processes.filter((entry) => !this.#owns(entry)).map((entry) => entry.pid)
      if (foreign.length > 0) return { status: 'failed', input: 'not_sent', failure: this.#foreign(foreign) }
      if (!running.running) {
        if (this.#expectRunning) this.#appEnded()
        this.#generationOpen = false
        return { status: 'answered', value: false, durationMs: 0 }
      }
      const terminated = await this.#driver.terminate({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal })
      if (terminated.status !== 'answered') return terminated
      const gone = await this.#waitUntilGone(deadline, bounds.signal)
      if (!gone.ok) return { status: 'failed', input: 'sent', failure: { class: 'outcome_unknown', message: `The executor answered the terminate, and ${gone.problem}` } }
      this.#expectRunning = false
      this.#generationOpen = false
      return terminated
    })
  }

  /** Where the app is, as the executor reads it. Sends nothing to the app. A launched app found not running is marked as ended without being terminated. */
  async appState(timeoutMs: number, signal?: AbortSignal): Promise<AppStateReading> {
    const read = await this.#read('state', timeoutMs, signal, (bounds) => this.#driver.state(bounds))
    if (!read.ok) return read
    const state = states[read.value]
    if (state === undefined) return { ok: false, failure: { class: 'not_actionable', message: "The executor reports the app's state as unknown." } }
    if (state === 'not_running' && this.#expectRunning) this.#appEnded()
    return { ok: true, state }
  }

  /** A PNG of what the session shows: the device screen on iOS, the app's window on macOS. Sends no input. Rejects with a `NativeError`. */
  async screenshot(timeoutMs: number): Promise<Uint8Array> {
    const taken = await this.capture(timeoutMs)
    if (!taken.ok) throw new NativeError(taken.failure)
    return taken.capture.png
  }

  /** The frame source for this session. Display captures use the driver's own tools and hidden environment rules. */
  frameSource(identity: RecordIdentity): FrameSource { return nativeFrameSource(this, identity, (bounds) => this.#driver.capture('simulator-display', bounds), nativeCaptureTargetCheck(this.#driver, (entry) => this.#pids.includes(entry.pid) && this.#owns(entry))) }

  /** A capture from a named source, the session's first by default, with its reference and when it came back. Sends no input. */
  async capture(timeoutMs: number, options: { readonly source?: CaptureSource; readonly signal?: AbortSignal } = {}): Promise<{ readonly ok: true; readonly capture: NativeCapture } | { readonly ok: false; readonly failure: Failure }> {
    const source = options.source ?? this.#driver.captureSources[0] ?? 'executor-screen'
    if (!this.#driver.captureSources.includes(source)) return { ok: false, failure: { class: 'unsupported', message: `A ${this.#driver.platform} session offers ${this.#driver.captureSources.join(' and ')} captures, not ${source}.` } }
    const read = await this.#read('capture', timeoutMs, options.signal, (bounds) => this.#driver.capture(source, bounds))
    if (!read.ok) return read
    const size = pngSize(read.value)
    if (size === undefined) return { ok: false, failure: { class: 'not_actionable', message: `The ${source} capture is not a PNG.` } }
    return { ok: true, capture: { png: read.value, source, ...size, reference: this.#reference(), capturedAt: new Date().toISOString() } }
  }

  /**
   * The app's tree, cut to what the session owns and redacted, with its reference: the base the next layer's lookups
   * read. Sends no input. A caller deadline preserves its exact end across whole-millisecond command allocations.
   */
  async readSource(timeoutMs: number, signal?: AbortSignal, callerDeadline?: Deadline): Promise<{ readonly ok: true; readonly tree: NativeSource } | { readonly ok: false; readonly failure: Failure }> {
    const read = await this.#read('source', timeoutMs, signal, (bounds, deadline) => this.#source(bounds, deadline), callerDeadline)
    if (!read.ok) return read
    return { ok: true, tree: { source: { ...read.value, xml: redactNativeXml(read.value.xml, this.#options.redact) }, reference: this.#reference() } }
  }

  /** Reads a field for fill verification in the parent. Its raw value is used only by the input implementation. */
  async readFieldSource(locator: LocatorRecipe, timeoutMs: number, signal: AbortSignal): Promise<{ readonly ok: true; readonly value: string; readonly tree: NativeSource } | { readonly ok: false; readonly failure: Failure }> {
    const read = await this.#read('source', timeoutMs, signal, (bounds, deadline) => this.#source(bounds, deadline))
    if (!read.ok) return read
    const parsed = parseNativeTree(read.value.xml, this.execution.platform)
    if (!parsed.ok) return { ok: false, failure: { class: 'not_actionable', message: 'The filled field tree could not be read.' } }
    const found = locate(parsed.tree, locator)
    if (!found.ok) return { ok: false, failure: redactNativeFailure(found.failure, this.#options.redact) }
    const [field, ...others] = found.matches
    if (field === undefined || others.length > 0) return { ok: false, failure: { class: 'not_actionable', message: 'The fill read-back needs exactly one field.' } }
    const value = valueOf(field, this.execution.platform)
    if (value === undefined) return { ok: false, failure: { class: 'not_actionable', message: 'The filled element exposes no field value.' } }
    return { ok: true, value, tree: { source: { ...read.value, xml: redactNativeXml(read.value.xml, this.#options.redact) }, reference: this.#reference() } }
  }

  /**
   * Why a reference cannot be used here, or undefined when it can: a reference of another session, of a launch that is
   * over, or of a session that is lost, disposed or cancelled.
   *
   * @example session.checkReference(capture.reference) // undefined while that launch is current
   */
  checkReference(reference: NativeReference): Failure | undefined {
    if (reference.sessionId !== this.sessionId) return { class: 'usage', message: `The reference ${reference.observationId} belongs to session ${reference.sessionId}, not ${this.sessionId}.`, details: { stale: true } }
    if (reference.instance !== this.#instance) return { class: 'usage', message: `The reference ${reference.observationId} belongs to an earlier session of ${this.sessionId}, which served it before this one opened.`, details: { stale: true } }
    if (this.#disposing !== undefined || this.#lost !== undefined) return { class: 'session_lost', message: `The reference ${reference.observationId} belongs to a session that is ${this.#disposing === undefined ? 'lost' : 'disposed'}.`, details: { stale: true } }
    if (this.#cancel.signal.aborted) {
      const stopped = stopFailure(this.#cancel.signal.reason, 'not_sent')
      return { class: stopped.class, message: `The reference ${reference.observationId} belongs to a session that was cancelled: ${stopped.message}`, details: { ...stopped.details, stale: true } }
    }
    if (reference.generation !== this.#generation || !this.#generationOpen) {
      return { class: 'not_actionable', message: `The reference ${reference.observationId} is from launch ${reference.generation}; the app is on launch ${this.#generation}${this.#generationOpen ? '' : ', which is over'}.`, details: { stale: true, generation: reference.generation, current: this.#generation } }
    }
    return undefined
  }

  /** Stops the session: requests not yet sent are never sent, and those in flight are given up, their input not taken back. */
  cancel(reason: Failure): void {
    if (!this.#cancel.signal.aborted) this.#cancel.abort(reason)
  }

  /** Marks the session lost when its executor or device is gone: nothing more is sent. Called by its runtime. */
  markLost(reason: Failure): void {
    this.#lost ??= redactNativeFailure(reason, this.#options.redact)
  }

  /**
   * Reads, through the operating system and not the executor, whether the app's process runs, once for every request
   * whose outcome is still unknown, and keeps the reading beside each. It sends nothing to the app, so it may run after
   * the session was cancelled or lost. It does not say what the request did: only where the app stood afterwards.
   */
  async reconcile(timeoutMs: number): Promise<readonly UnknownOutcome[]> {
    const open = this.#ledger.filter((entry) => entry.reconciled === undefined)
    if (open.length === 0) return this.unknownOutcomes
    const reading = await this.#driver.processState({ timeoutMs: checkedTimeout(timeoutMs) ?? 1 })
    for (const entry of open) this.#ledger[this.#ledger.indexOf(entry)] = { ...entry, reconciled: withoutCommands(reading) }
    return this.unknownOutcomes
  }

  /**
   * Ends the session within `timeoutMs`: stops what is in flight, terminates the app if this session may have left it
   * running, by the executor and then, only for the processes this launch started, by the operating system, and ends
   * the executor session. Rejects with a `NativeError` naming what could not be cleaned up. A second call waits for the
   * first.
   */
  dispose(timeoutMs: number): Promise<void> {
    this.#disposing ??= this.#dispose(timeoutMs)
    return this.#disposing
  }

  async #dispose(timeoutMs: number): Promise<void> {
    this.cancel({ class: 'interrupted', message: 'The session was disposed.' })
    const deadline = new Deadline(checkedTimeout(timeoutMs) ?? 1)
    const turn = await this.#lane.acquire(undefined, deadline.commandTimeoutMs)
    const problems: string[] = []
    try {
      if (this.#own.size > 0 || this.#unseenLaunch) problems.push(...(await this.#endOwnApp(deadline)))
      if (this.#lost === undefined) problems.push(...(await this.#driver.endExecutorSession({ timeoutMs: Math.min(5000, deadline.commandTimeoutMs) })))
    } finally {
      if (turn.ok) turn.release()
      this.#driver.released()
    }
    if (problems.length > 0) throw new NativeError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  // Ends the processes this session's launches started, and no other: the executor's terminate is used only while every
  // running copy is the session's own, since it terminates by bundle id or path; otherwise the operating system ends
  // the session's own processes by their pids.
  async #endOwnApp(deadline: Deadline): Promise<string[]> {
    const reading = await this.#driver.processState({ timeoutMs: Math.min(5000, deadline.commandTimeoutMs) })
    if (!reading.ok) return [`The app may still be running after the session ended: its processes could not be read (${reading.problem}).`]
    const own = reading.processes.filter((entry) => this.#owns(entry))
    // A launch of this session may have started an app that runs now, unseen within its window and not tied to it: it is
    // left alone and said, never ended and never passed over in silence.
    if (own.length === 0 && this.#unseenLaunch && reading.running) return [`The app runs (pid ${reading.pids.join(', ')}) after a launch of this session whose process the session never saw; it was not ended.`]
    if (own.length === 0) return this.#settled()
    const foreign = reading.pids.length > own.length
    const uncertainTerminate = this.#ledger.some((entry) => entry.kind === 'terminate' && entry.generation === this.#generation)
    if (this.#lost === undefined && !foreign && !uncertainTerminate) {
      const terminated = await this.#driver.terminate({ timeoutMs: Math.min(10_000, deadline.commandTimeoutMs) })
      if (terminated.status === 'answered' && (await this.#waitUntilGone(deadline)).ok) return this.#settled()
    }
    const left = await this.#driver.forceEnd(own, { timeoutMs: deadline.commandTimeoutMs })
    if (left.length === 0) return this.#settled()
    return [`The app may still be running after the session ended: ${left.join(' ')}`]
  }

  #settled(): string[] {
    this.#expectRunning = false
    this.#generationOpen = false
    this.#unseenLaunch = false
    return []
  }

  // Waits until none of the session's own processes runs.
  async #waitUntilGone(deadline: Deadline, signal?: AbortSignal): Promise<{ readonly ok: true } | { readonly ok: false; readonly problem: string }> {
    for (;;) {
      const reading = await this.#driver.processState({ timeoutMs: Math.min(5000, deadline.commandTimeoutMs), signal })
      const own = reading.ok ? reading.processes.filter((entry) => this.#owns(entry)).map((entry) => entry.pid) : []
      if (reading.ok && own.length === 0) return { ok: true }
      if (deadline.expired || signal?.aborted === true) return { ok: false, problem: reading.ok ? `the app's process ${own.join(', ')} is still running.` : `its process could not be read: ${reading.problem}` }
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, deadline.remainingMs)))
    }
  }

  #appEnded(): void {
    if (this.#expectRunning && !this.#unexpectedEnds.includes(this.#generation)) this.#unexpectedEnds.push(this.#generation)
    this.#expectRunning = false
    this.#generationOpen = false
  }

  // Whether a process is one this session recorded as its own, by pid and start and, where `ps` read it, command line.
  // An app shown without its command line while it exits is still its own; one that took a recorded pid is not.
  #owns(entry: RecordedProcess): boolean {
    const record = this.#own.get(entry.pid)
    return record !== undefined && recordedIdentity(record, entry) === 'same'
  }

  // The launch's process is seen within its window: it is the session's own, with its command line, and the session
  // expects it running from now.
  #claim(processes: readonly RecordedProcess[]): void {
    this.#pids = processes.map((entry) => entry.pid)
    for (const entry of processes) this.#own.set(entry.pid, entry)
    this.#unseenLaunch = false
    this.#expectRunning = true
  }

  // Looks for the launch's process every 100 ms for up to `windowMs`, without any request's signal and never past the
  // request's deadline; at least one reading is taken.
  async #claimWithin(windowMs: number, request: Deadline): Promise<AppProcessReading> {
    const window = new Deadline(Math.max(0, Math.floor(windowMs)))
    for (;;) {
      const reading = await this.#driver.processState({ timeoutMs: Math.max(1, Math.min(5000, request.remainingMs)) })
      if (reading.ok && reading.running) {
        this.#claim(reading.processes)
        return reading
      }
      if (window.expired || request.expired) return reading
      await new Promise((resolve) => setTimeout(resolve, Math.min(100, window.remainingMs)))
    }
  }

  #foreign(pids: readonly number[]): Failure {
    return { class: 'not_actionable', message: `A copy of the app this session did not launch runs (pid ${pids.join(', ')}). Retest terminates only what its own launch started.`, details: { foreignProcesses: pids.length } }
  }

  // A read before a request acts that gets no answer is a failed read: nothing of the request was sent.
  async #stateBefore(bounds: RequestBounds): Promise<{ readonly ok: true; readonly value: ExecutorAppState } | { readonly ok: false; readonly answer: DriverAnswer<unknown> }> {
    const state = await this.#driver.state(bounds)
    if (state.status === 'answered') return { ok: true, value: state.value }
    return { ok: false, answer: { status: 'failed', input: 'not_sent', failure: this.#failureOf('state', state, bounds.signal ?? this.#cancel.signal).failure } }
  }

  #notRunning(): Failure {
    if (this.#expectRunning || this.#unexpectedEnds.includes(this.#generation)) {
      this.#appEnded()
      return { class: 'session_lost', message: 'The app is no longer running: it ended without the session terminating it, and may have crashed.', details: { appEnded: true, generation: this.#generation } }
    }
    return { class: 'not_actionable', message: 'The app is not running; launch it first.' }
  }

  #reference(): NativeReference {
    this.#observations += 1
    return { sessionId: this.sessionId, instance: this.#instance, generation: this.#generation, observationId: `o${this.#observations}` }
  }

  // Runs one lifecycle request in its turn and answers as the contract asks, recording an unknown outcome.
  async #act(kind: LifecycleKind, timeoutMs: number, signal: AbortSignal | undefined, work: (bounds: RequestBounds, deadline: Deadline) => Promise<DriverAnswer<unknown>>): Promise<DispatchedRequest> {
    const generation = this.#generation
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return { result: { ok: false, failure: turn.failure }, input: 'not_sent' }
    this.#afterLaunch = undefined
    try {
      const answer = await work({ timeoutMs: turn.deadline.commandTimeoutMs, signal: turn.signal }, turn.deadline)
      if (answer.status === 'answered') return { result: { ok: true }, input: 'sent' }
      const { failure, input } = this.#failureOf(kind, answer, turn.signal)
      this.#requests += 1
      const after = kind === 'launch' ? this.#afterLaunch : undefined
      if (input === 'unknown') this.#ledger.push({ id: `r${this.#requests}`, kind, generation: kind === 'launch' ? this.#generation : generation, failure, ...(after === undefined ? {} : { processesAfter: after }) })
      return { result: { ok: false, failure }, input }
    } finally {
      turn.release()
    }
  }

  async #source(bounds: RequestBounds, deadline: Deadline): Promise<DriverAnswer<ScopedSource>> {
    for (let attempt = 0; ; attempt += 1) {
      const answer = await this.#driver.source({ timeoutMs: deadline.commandTimeoutMs, signal: bounds.signal }, this.#options.redact)
      if (answer.status !== 'unknown' || answer.reason !== 'unreadable' || !transientSourceProblem(answer.message)) return answer
      try {
        await waitBeforeRead(deadline, Math.min(20 * 2 ** attempt, 200), bounds.signal)
      } catch (error) {
        if (bounds.signal?.aborted !== true) throw error
      }
      if (bounds.signal?.aborted === true) return { status: 'not_sent', reason: 'stopped', message: 'Stopped while waiting for the owned app tree.' }
      if (deadline.reached) return answer
    }
  }

  async #read<T>(kind: 'state' | 'capture' | 'source', timeoutMs: number, signal: AbortSignal | undefined, work: (bounds: RequestBounds, deadline: Deadline) => Promise<DriverAnswer<T>>, callerDeadline?: Deadline): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly failure: Failure }> {
    const turn = await this.#turn(timeoutMs, signal, callerDeadline)
    if (!turn.ok) return { ok: false, failure: turn.failure }
    try {
      const answer = await work({ timeoutMs: turn.deadline.commandTimeoutMs, signal: turn.signal }, turn.deadline)
      if (answer.status === 'answered') return { ok: true, value: answer.value }
      return { ok: false, failure: this.#failureOf(kind, answer, turn.signal).failure }
    } finally {
      turn.release()
    }
  }

  async #turn(timeoutMs: number, signal: AbortSignal | undefined, callerDeadline?: Deadline): Promise<{ readonly ok: true; readonly deadline: Deadline; readonly signal: AbortSignal; release(): void } | { readonly ok: false; readonly failure: Failure }> {
    const checked = checkedTimeout(timeoutMs)
    if (checked === undefined) return { ok: false, failure: { class: 'usage', message: `A native request takes a whole number of milliseconds from 1 to ${maxTimeout}, not ${String(timeoutMs)}.` } }
    const refusal = this.#refusal(signal)
    if (refusal !== undefined) return { ok: false, failure: refusal }
    const deadline = callerDeadline ?? new Deadline(checked)
    const combined = signal === undefined ? this.#cancel.signal : AbortSignal.any([signal, this.#cancel.signal])
    const turn = await this.#lane.acquire(combined, checked)
    if (!turn.ok) return { ok: false, failure: turn.reason === 'stopped' ? stopFailure(combined.reason, 'not_sent') : { class: 'timeout', message: `The request waited ${checked} ms for the one before it and did not go.` } }
    // The session may have been lost or disposed while the request waited.
    const late = this.#refusal(signal)
    if (late !== undefined) {
      turn.release()
      return { ok: false, failure: late }
    }
    return { ok: true, deadline, signal: combined, release: turn.release }
  }

  #refusal(signal: AbortSignal | undefined): Failure | undefined {
    if (this.#disposing !== undefined) return { class: 'session_lost', message: 'The session was disposed.' }
    if (this.#lost !== undefined) return { class: 'session_lost', message: `The session is lost: ${this.#lost.message}` }
    if (this.#cancel.signal.aborted) return stopFailure(this.#cancel.signal.reason, 'not_sent')
    if (signal?.aborted === true) return stopFailure(signal.reason, 'not_sent')
    return undefined
  }

  #failureOf(kind: LifecycleKind | 'state' | 'capture' | 'source', answer: Exclude<DriverAnswer<unknown>, { readonly status: 'answered' }>, signal: AbortSignal): { readonly failure: Failure; readonly input: InputDispatch } {
    const read = this.#rawFailureOf(kind, answer, signal)
    return { ...read, failure: redactNativeFailure(read.failure, this.#options.redact) }
  }

  #rawFailureOf(kind: LifecycleKind | 'state' | 'capture' | 'source', answer: Exclude<DriverAnswer<unknown>, { readonly status: 'answered' }>, signal: AbortSignal): { readonly failure: Failure; readonly input: InputDispatch } {
    const name = requestNames[kind]
    const acting = kind === 'install' || kind === 'launch' || kind === 'activate' || kind === 'terminate'
    const input = acting ? inputOf(answer) : 'not_sent'
    const mayHave = input === 'unknown' ? ` The ${kind} may have happened.` : ''
    if (answer.status === 'failed') return { failure: answer.failure, input: acting ? answer.input : 'not_sent' }
    if (answer.status === 'not_sent') {
      if (answer.reason === 'stopped') return { failure: stopFailure(signal.reason, 'not_sent'), input }
      if (answer.reason === 'timeout') return { failure: { class: 'timeout', message: `${name} ran out of time before it was sent.` }, input }
      if (answer.reason === 'wrong_executor') return { failure: { class: 'usage', message: `${name}: ${answer.message}` }, input }
      return { failure: this.#loseSession(`${name}: ${answer.message}`), input }
    }
    if (answer.status === 'refused') {
      if (answer.error === 'invalid session id') return { failure: this.#loseSession(`${name}: the executor no longer knows this session (${answer.message}).`), input }
      const failureClass: FailureClass = input === 'unknown' ? 'outcome_unknown' : 'not_actionable'
      return { failure: { class: failureClass, message: `${name}: the executor answered ${answer.error}: ${answer.message}.${mayHave}`, details: { executorError: answer.error } }, input }
    }
    if (answer.reason === 'stopped') return { failure: stopFailure(signal.reason, acting ? 'unknown' : 'not_sent'), input }
    if (answer.reason === 'timeout') return { failure: { class: 'timeout', message: `${name}: ${answer.message}${mayHave}` }, input }
    if (answer.reason === 'connection_lost') return { failure: { ...this.#loseSession(`${name}: ${answer.message}${mayHave}`), class: acting ? 'outcome_unknown' : 'session_lost' }, input }
    // A tree that does not hold the app's window yet can clear after launch, so a capture says so for its caller.
    const transient = kind === 'capture' && answer.reason === 'unreadable' && transientSourceProblem(answer.message)
    return { failure: { class: acting ? 'outcome_unknown' : 'not_actionable', message: `${name}: ${answer.message}${mayHave}`, ...(transient ? { details: { transient: true } } : {}) }, input }
  }

  #loseSession(message: string): Failure {
    const failure: Failure = { class: 'session_lost', message: this.#options.redact(message) }
    this.#lost ??= failure
    return failure
  }
}

/**
 * A queue that lets one holder through at a time, in the order they asked. A wait is bounded and stops with its signal.
 *
 * @example const turn = await lane.acquire(signal, 5000); if (turn.ok) try { await work() } finally { turn.release() }
 */
export class SerialLane {
  readonly #waiting: (() => void)[] = []
  #held = false

  /** Resolves once it is this caller's turn, or with why not: stopped by `signal`, or `timeoutMs` passed first. */
  acquire(signal: AbortSignal | undefined, timeoutMs: number): Promise<{ readonly ok: true; release(): void } | { readonly ok: false; readonly reason: 'stopped' | 'timed_out' }> {
    if (signal?.aborted === true) return Promise.resolve({ ok: false, reason: 'stopped' })
    const { promise, resolve } = Promise.withResolvers<{ readonly ok: true; release(): void } | { readonly ok: false; readonly reason: 'stopped' | 'timed_out' }>()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      const next = this.#waiting.shift()
      if (next === undefined) this.#held = false
      else next()
    }
    if (!this.#held) {
      this.#held = true
      resolve({ ok: true, release })
      return promise
    }
    let waiting = true
    const grant = (): void => {
      if (!waiting) {
        release()
        return
      }
      finish()
      resolve({ ok: true, release })
    }
    const leave = (reason: 'stopped' | 'timed_out'): void => {
      if (!waiting) return
      finish()
      const index = this.#waiting.indexOf(grant)
      if (index !== -1) this.#waiting.splice(index, 1)
      resolve({ ok: false, reason })
    }
    const onAbort = (): void => leave('stopped')
    const timer = setTimeout(() => leave('timed_out'), Math.max(1, timeoutMs))
    const finish = (): void => {
      waiting = false
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    this.#waiting.push(grant)
    return promise
  }
}

function inputOf(answer: DriverAnswer<unknown>): InputDispatch {
  return answer.status === 'failed' ? answer.input : inputDispatch(answer)
}

function checkedTimeout(timeoutMs: number): number | undefined {
  return Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= maxTimeout ? timeoutMs : undefined
}

// A stop takes its class from the signal's reason when that is a failure, and counts as a timeout otherwise, as the
// session contract says.
function stopFailure(reason: unknown, input: InputDispatch): Failure {
  const parsed = parse(failureSchema, reason)
  const cause: Failure = parsed.ok ? parsed.value : { class: 'timeout', message: 'The time for the request ran out.' }
  const said = input === 'not_sent' ? 'Retest stopped before it sent the request.' : 'The request had gone; it is not taken back, so it may have taken effect.'
  return { class: cause.class, message: `${cause.message} ${said}`, details: { ...cause.details, inputSent: input } }
}

// A reading as the session reports it: which processes ran, without their command lines, which can carry launch
// arguments.
function withoutCommands(reading: AppProcessReading): ProcessReading {
  return reading.ok ? { ok: true, running: reading.running, pids: reading.pids } : reading
}
