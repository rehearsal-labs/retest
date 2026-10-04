import type { AppBuild, AppStateReading, DispatchedCommand, DispatchedRequest, Gesture, InputDispatch, NativeKind, NativeSession, ResetPolicy } from '../browser/contract.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { FieldRead } from './input.ts'
import type { InputRecordDraft, NativeInputKind, NativePort, TreeLook } from './actionability.ts'
import type { AlertAnswer, AlertReading } from './alerts.ts'
import type { NativeAssertionResult, NativeCheckRecord, NativeLook } from './assertions.ts'
import type { KeyboardState } from './keyboard.ts'
import type { NativeTools } from './processes.ts'
import type { CaptureSource, NativeAppSession, NativeCapture, NativeReference, ProcessReading, UnknownOutcome } from './session.ts'
import type { ExecutorAnswer, ExecutorClient, ExecutorSession, Rect, RequestBounds } from './webdriver-client.ts'
import { Deadline } from '../protocol/deadline.ts'
import { failureSchema } from '../protocol/failures.ts'
import { describeLocator } from '../protocol/locator.ts'
import { parse } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { waitUntilActionable } from './actionability.ts'
import { answerAlert, readAlert } from './alerts.ts'
import { pollNative, observeTree } from './assertions.ts'
import { clickOnce, performAction } from './input.ts'
import { dismissFirstRunCard, dismissKeyboard, readKeyboard, waitForKeyboard } from './keyboard.ts'
import { locate, parseNativeTree } from './locators.ts'
import { coveringWindows, windowsOnScreen } from './macos-app.ts'
import { listProcesses } from './processes.ts'
import { redactNativeFailure } from './output.ts'
import { NativeError, SerialLane } from './session.ts'
import { ExecutorElements, inputDispatch } from './webdriver-client.ts'

// The interaction half of a native session. It wraps a `NativeAppSession`, which owns the app's lifecycle, its scoped
// and redacted tree, its references and its cancel, and adds what a test does with the app: find elements, act on
// them once, and check what they show. Every request, the forwarded lifecycle ones included, runs one at a time in this
// session's own lane, so the runner can hand it over as the contract's native session. Input that may have gone and
// got no answer is kept in a ledger beside the session's own, reconciled against the app's processes and never sent
// again.

/** A command a native session runs: an action on an element, or a look at a locator's elements. */
export type NativeCommand =
  | { readonly kind: 'tap' | 'click'; readonly locator: LocatorRecipe }
  | { readonly kind: 'fill'; readonly locator: LocatorRecipe; readonly value: string; readonly secret?: string }
  | { readonly kind: 'press'; readonly locator?: LocatorRecipe; readonly key: string }
  | { readonly kind: 'scroll'; readonly locator?: LocatorRecipe; readonly x: number; readonly y: number }
  | { readonly kind: 'observe'; readonly locator: LocatorRecipe }

/** What an interaction session is opened with. */
export type NativeInteractionOptions = {
  readonly session: NativeAppSession
  /** The client of the executor the session runs on, and the executor session the session's runtime opened. */
  readonly client: ExecutorClient
  readonly executor: ExecutorSession
  /** The same redaction the session's trees pass through, for text Retest reads outside the tree, such as a system alert's. */
  readonly redact: (text: string) => string
  /** The app's processes as the operating system shows them, read without the executor, for reconciling unknown input. */
  readonly processes: (bounds: RequestBounds) => Promise<ProcessReading>
  /** On macOS, the tools that read the window server's list of windows, for the check that nothing lies over an element. */
  readonly tools?: NativeTools
}

/** One request of input that went, or may have gone: its kind, route, how far it got, and the launch and look it acted on. */
export type InputRecord = {
  readonly id: string
  readonly kind: NativeInputKind
  readonly route: string
  readonly input: InputDispatch
  readonly generation: number
  readonly observationId: string
  readonly at: string
  readonly failure?: Failure
  /**
   * For typing a fill sent: how the field read back. `matched` is the text itself, `length_matched` a secure field's
   * bullets as many as the characters typed, and `not_exposed` a field that shows nothing of what it holds, as a macOS
   * secure field does, so nothing could be read back.
   */
  readonly readBack?: ReadBack
}

/** How a fill's field read back, as `InputRecord.readBack` says. */
export type ReadBack = 'matched' | 'length_matched' | 'not_exposed'

/** Input whose outcome is unknown, with the app's processes as reconciliation read them. */
export type UnknownInput = InputRecord & { readonly reconciled?: ProcessReading }

/** Every request whose outcome is unknown: the session's lifecycle requests and this session's input. */
export type NativeUnknownOutcome = { readonly source: 'lifecycle'; readonly outcome: UnknownOutcome } | { readonly source: 'input'; readonly outcome: UnknownInput }

/** An element resolved on the executor: the look it came from and the executor's id for it, good only while that look is current. */
export type ResolvedElement = { readonly reference: NativeReference; readonly executorElement: string; readonly description: string }

/** Something told of each input request right before it goes. */
export type InputListener = (sending: { readonly kind: NativeInputKind; readonly route: string; readonly reference: NativeReference }) => void

// The pointer's own window: the window server lists it over everything, and it never takes a click.
const pointerLayer = 2147483630
// macOS lays this overlay over the whole screen, at layer 1000, while Automation Mode is on, which is whenever the
// runner drives the desktop. Clicks pass through it: on this Mac every click the runner sent landed with it in place.
const automationModeOverlay = '/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI'

/**
 * A native session's finds, actions and checks over a `NativeAppSession`. Each request is bounded by its `timeoutMs`
 * and never throws for an app or platform problem: the answer carries the failure and how far the input got.
 */
export class NativeInteractionSession implements NativeSession<NativeCommand> {
  readonly sessionId: string
  readonly platform: NativeKind
  readonly #session: NativeAppSession
  readonly #options: NativeInteractionOptions
  readonly #elements: ExecutorElements
  readonly #lane = new SerialLane()
  readonly #cancel = new AbortController()
  readonly #inputs: InputRecord[] = []
  readonly #unknown: UnknownInput[] = []
  #pending: InputRecord | undefined
  #inputCount = 0
  readonly #listeners = new Set<InputListener>()
  readonly #port: NativePort

  constructor(options: NativeInteractionOptions) {
    const platform = options.session.execution.platform
    if (platform === 'macos' && options.tools === undefined) throw new TypeError('A macOS interaction session needs the tools that read the window server, to check that nothing lies over an element.')
    this.#session = options.session
    this.#options = options
    this.sessionId = options.session.sessionId
    this.platform = platform
    this.#elements = new ExecutorElements(options.client, options.executor)
    this.#port = this.#makePort()
  }

  get resetPolicy(): ResetPolicy {
    return this.#session.resetPolicy
  }

  /** The lifecycle session this one wraps. */
  get session(): NativeAppSession {
    return this.#session
  }

  /** Every input request that went or may have gone, oldest first. */
  get inputs(): readonly InputRecord[] {
    return [...this.#inputs]
  }

  /** Every request whose outcome is unknown, the session's lifecycle requests first, with their reconciliation once it ran. */
  get unknownOutcomes(): readonly NativeUnknownOutcome[] {
    return [...this.#session.unknownOutcomes.map((outcome) => ({ source: 'lifecycle' as const, outcome })), ...this.#unknown.map((outcome) => ({ source: 'input' as const, outcome }))]
  }

  /** Tells `listener` of each input request right before it goes. Returns a function that removes the listener. */
  onInput(listener: InputListener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  install(build: AppBuild, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#forward(timeoutMs, signal, (remaining, combined) => this.#session.install(build, remaining, combined))
  }

  launch(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#forward(timeoutMs, signal, (remaining, combined) => this.#session.launch(remaining, combined))
  }

  activate(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#forward(timeoutMs, signal, (remaining, combined) => this.#session.activate(remaining, combined))
  }

  terminate(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#forward(timeoutMs, signal, (remaining, combined) => this.#session.terminate(remaining, combined))
  }

  async appState(timeoutMs: number, signal?: AbortSignal): Promise<AppStateReading> {
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return { ok: false, failure: turn.failure }
    try {
      return await this.#session.appState(turn.deadline.commandTimeoutMs, turn.signal)
    } finally {
      turn.release()
    }
  }

  /** A PNG of what the session shows, as the session captures it, in its turn. Sends no input. Rejects with a `NativeError`. */
  async screenshot(timeoutMs: number): Promise<Uint8Array> {
    const taken = await this.capture(timeoutMs)
    if (!taken.ok) throw new NativeError(taken.failure)
    return taken.capture.png
  }

  /** A capture from a named source, as the session takes it, in its turn. Sends no input. */
  async capture(timeoutMs: number, options: { readonly source?: CaptureSource } = {}): Promise<{ readonly ok: true; readonly capture: NativeCapture } | { readonly ok: false; readonly failure: Failure }> {
    const turn = await this.#turn(timeoutMs, undefined)
    if (!turn.ok) return turn
    try {
      return await this.#session.capture(turn.deadline.commandTimeoutMs, { ...options, signal: turn.signal })
    } finally {
      turn.release()
    }
  }

  /**
   * Runs one command: an action, sent once once its element is ready, or a look at a locator's elements. The answer says
   * how far the input got.
   */
  async dispatch(command: NativeCommand, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedCommand> {
    if (command.kind === 'observe') {
      const looked = await this.observe(command.locator, timeoutMs, signal)
      if (!looked.ok) return { result: { ok: false, failure: looked.failure }, input: 'not_sent' }
      const result: CommandResult = { ok: true, kind: 'observe', observation: looked.look.observation, observationId: looked.look.reference.observationId, sessionId: this.sessionId }
      return { result, input: 'not_sent' }
    }
    const action = command.kind === 'fill' ? { kind: 'fill' as const, locator: command.locator, text: command.value, ...(command.secret === undefined ? {} : { secret: command.secret }) } : command
    const done = await this.#act(timeoutMs, signal, (deadline, combined) => performAction(this.#port, action, deadline, combined))
    return { result: done.result.ok ? { ok: true, kind: command.kind } : { ok: false, failure: done.result.failure }, input: done.input }
  }

  /**
   * A tap or swipe, sent once, on an app with a touch screen. A tap needs an element: Retest taps no point it did not
   * find. A macOS app refuses both, as `click` and `scroll` are its input.
   */
  gesture(gesture: Gesture, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    if (gesture.kind === 'swipe') {
      const swipe = { kind: 'swipe' as const, direction: gesture.direction, ...(gesture.locator === undefined ? {} : { locator: gesture.locator }) }
      return this.#act(timeoutMs, signal, (deadline, combined) => performAction(this.#port, swipe, deadline, combined))
    }
    const locator = gesture.locator
    if (locator === undefined) return Promise.resolve({ result: { ok: false, failure: { class: 'unsupported', message: 'A tap needs an element to tap. Retest taps no point it did not find.', details: { inputSent: 'not_sent' } } }, input: 'not_sent' })
    return this.#act(timeoutMs, signal, (deadline, combined) => performAction(this.#port, { kind: 'tap', locator }, deadline, combined))
  }

  /** One look at a locator's elements in the scoped tree. Sends no input. */
  async observe(locator: LocatorRecipe, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly look: NativeLook } | { readonly ok: false; readonly failure: Failure }> {
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return turn
    try {
      return await this.#look(locator, turn.deadline.commandTimeoutMs, turn.signal)
    } finally {
      turn.release()
    }
  }

  /**
   * Looks at a locator's elements until the check passes or `timeoutMs` passes, as `pollNative` looks, each look its
   * own turn so other requests may go between looks. Sends no input.
   */
  async expect(locator: LocatorRecipe, record: NativeCheckRecord, timeoutMs: number, signal?: AbortSignal): Promise<NativeAssertionResult> {
    const combined = signal === undefined ? this.#cancel.signal : AbortSignal.any([signal, this.#cancel.signal])
    return pollNative({ recipe: locator, record, timeoutMs, platform: this.platform, signal: combined, look: (lookMs) => this.observe(locator, lookMs, combined) })
  }

  /** Resolves the one element a locator names on the executor, once it is ready for input. Sends no input. */
  async resolve(locator: LocatorRecipe, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly element: ResolvedElement } | { readonly ok: false; readonly failure: Failure }> {
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return turn
    try {
      const ready = await waitUntilActionable(this.#port, locator, { verb: 'resolve', enabled: false }, turn.deadline, turn.signal)
      if (!ready.ok) return ready
      return { ok: true, element: { reference: ready.target.reference, executorElement: ready.target.executorElement, description: describeLocator(locator) } }
    } finally {
      turn.release()
    }
  }

  /**
   * Clicks or taps an element resolved earlier, once, while the look it came from is current. A reference from another
   * launch, session or session object is refused, as the session refuses it, and nothing is sent.
   */
  pressResolved(element: ResolvedElement, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    const kind = this.platform === 'macos' ? 'click' : 'tap'
    return this.#act(timeoutMs, signal, async (deadline, combined) => {
      const sent = await clickOnce(this.#port, element, kind, `${kind === 'tap' ? 'Tapping' : 'Clicking'} ${element.description}`, deadline, combined)
      return sent.ok ? { result: { ok: true }, input: 'sent' } : { result: { ok: false, failure: sent.failure }, input: sent.input }
    })
  }

  /** Where the software keyboard stands, once. Sends no input. */
  keyboardState(timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly state: KeyboardState } | { readonly ok: false; readonly failure: Failure }> {
    return this.#read(timeoutMs, signal, (deadline, combined) => readKeyboard(this.#port, deadline, combined))
  }

  /** Waits for the software keyboard to come up. Sends no input. */
  waitForKeyboard(timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly state: KeyboardState } | { readonly ok: false; readonly failure: Failure }> {
    return this.#read(timeoutMs, signal, (deadline, combined) => waitForKeyboard(this.#port, deadline, combined))
  }

  /** Dismisses the keyboard through its return key, once, as `dismissKeyboard` does. */
  dismissKeyboard(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#act(timeoutMs, signal, (deadline, combined) => dismissKeyboard(this.#port, deadline, combined))
  }

  /** Dismisses the keyboard's first-run card about sliding to type through its own button, once, when it shows. */
  dismissFirstRunCard(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#act(timeoutMs, signal, (deadline, combined) => dismissFirstRunCard(this.#port, deadline, combined))
  }

  /** The alert in front, as `readAlert` reads it. Sends no input. */
  readAlert(timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly alert: AlertReading } | { readonly ok: false; readonly failure: Failure }> {
    return this.#read(timeoutMs, signal, (deadline, combined) => readAlert(this.#port, deadline, combined, this.#options.redact))
  }

  /** Presses one named button of the alert in front, once, as `answerAlert` does. */
  answerAlert(answer: AlertAnswer, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#act(timeoutMs, signal, (deadline, combined) => answerAlert(this.#port, answer, deadline, combined, this.#options.redact))
  }

  /** Why a reference cannot be used here, as the session refuses it, or undefined while it is current. */
  checkReference(reference: NativeReference): Failure | undefined {
    return this.#session.checkReference(reference)
  }

  /** Stops the session: nothing more is sent, and input in flight is given up, never taken back. */
  cancel(reason: Failure): void {
    if (!this.#cancel.signal.aborted) this.#cancel.abort(reason)
    this.#session.cancel(reason)
  }

  /**
   * Reads, through the operating system, whether the app runs, once for every request whose outcome is unknown, and
   * keeps the reading beside each: the session's lifecycle requests and this session's input. Sends nothing to the app,
   * so it runs after a cancel or a loss. It does not say what the input did.
   */
  async reconcile(timeoutMs: number): Promise<readonly NativeUnknownOutcome[]> {
    await this.#session.reconcile(timeoutMs)
    const open = this.#unknown.filter((entry) => entry.reconciled === undefined)
    if (open.length > 0) {
      const reading = await this.#options.processes({ timeoutMs: Math.max(1, Math.min(maxTimeout, Math.floor(timeoutMs))) })
      for (const entry of open) {
        const index = this.#unknown.findIndex((current) => current.id === entry.id)
        const current = this.#unknown[index]
        if (current !== undefined) this.#unknown[index] = { ...current, reconciled: reading }
      }
    }
    return this.unknownOutcomes
  }

  /** Disposes the session: stops what is in flight, then ends the app and the executor session as the session does. */
  async dispose(timeoutMs: number): Promise<void> {
    if (!this.#cancel.signal.aborted) this.#cancel.abort({ class: 'interrupted', message: 'The session was disposed.' })
    const deadline = new Deadline(timeoutMs)
    const turn = await this.#lane.acquire(undefined, deadline.commandTimeoutMs)
    try {
      await this.#session.dispose(deadline.commandTimeoutMs)
      if (!turn.ok) throw new NativeError({ class: 'cleanup_failed', message: 'Native input did not settle before disposal. Its outcome remains unknown.' })
    } finally {
      if (turn.ok) turn.release()
    }
  }

  async #look(locator: LocatorRecipe, timeoutMs: number, signal: AbortSignal): Promise<{ readonly ok: true; readonly look: NativeLook } | { readonly ok: false; readonly failure: Failure }> {
    const read = await this.#port.readTree(timeoutMs, signal)
    if (!read.ok) return read
    const observed = observeTree(read.tree, locator)
    if (!observed.ok) return observed
    return { ok: true, look: { observation: observed.observation, matches: observed.matches, reference: read.reference, tree: read.tree } }
  }

  async #forward(timeoutMs: number, signal: AbortSignal | undefined, work: (remainingMs: number, signal: AbortSignal) => Promise<DispatchedRequest>): Promise<DispatchedRequest> {
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return { result: { ok: false, failure: turn.failure }, input: 'not_sent' }
    try {
      return await work(turn.deadline.commandTimeoutMs, turn.signal)
    } finally {
      turn.release()
    }
  }

  async #act(timeoutMs: number, signal: AbortSignal | undefined, work: (deadline: Deadline, signal: AbortSignal) => Promise<DispatchedRequest>): Promise<DispatchedRequest> {
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return { result: { ok: false, failure: { ...turn.failure, details: { ...turn.failure.details, inputSent: 'not_sent' } } }, input: 'not_sent' }
    try {
      const sent = await work(turn.deadline, turn.signal)
      return sent.result.ok ? sent : { ...sent, result: { ok: false, failure: redactNativeFailure(sent.result.failure, this.#options.redact) } }
    } finally {
      turn.release()
    }
  }

  async #read<T>(timeoutMs: number, signal: AbortSignal | undefined, work: (deadline: Deadline, signal: AbortSignal) => Promise<T>): Promise<T | { readonly ok: false; readonly failure: Failure }> {
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return turn
    try {
      return await work(turn.deadline, turn.signal)
    } finally {
      turn.release()
    }
  }

  async #turn(timeoutMs: number, signal: AbortSignal | undefined): Promise<{ readonly ok: true; readonly deadline: Deadline; readonly signal: AbortSignal; release(): void } | { readonly ok: false; readonly failure: Failure }> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout) return { ok: false, failure: { class: 'usage', message: `A native request takes a whole number of milliseconds from 1 to ${maxTimeout}, not ${String(timeoutMs)}.` } }
    const refusal = this.#refusal(signal)
    if (refusal !== undefined) return { ok: false, failure: refusal }
    const deadline = new Deadline(timeoutMs)
    const combined = signal === undefined ? this.#cancel.signal : AbortSignal.any([signal, this.#cancel.signal])
    const turn = await this.#lane.acquire(combined, timeoutMs)
    if (!turn.ok) return { ok: false, failure: turn.reason === 'stopped' ? stopFailure(combined.reason, 'not_sent') : { class: 'timeout', message: `The request waited ${timeoutMs} ms for the one before it and did not go.` } }
    const late = this.#refusal(signal)
    if (late !== undefined) {
      turn.release()
      return { ok: false, failure: late }
    }
    return { ok: true, deadline, signal: combined, release: turn.release }
  }

  #refusal(signal: AbortSignal | undefined): Failure | undefined {
    if (this.#cancel.signal.aborted) return stopFailure(this.#cancel.signal.reason, 'not_sent')
    if (signal?.aborted === true) return stopFailure(signal.reason, 'not_sent')
    return undefined
  }

  #makePort(): NativePort {
    const session = this.#session
    const options = this.#options
    return {
      platform: this.platform,
      sessionId: this.sessionId,
      elements: this.#elements,
      executor: options.executor,
      readTree: (timeoutMs, signal) => this.#readTree(timeoutMs, signal),
      readField: (locator, timeoutMs, signal) => this.#readField(locator, timeoutMs, signal),
      frontProblem: (frame, window, bounds) => this.#frontProblem(frame, window, bounds),
      checkReference: (reference) => session.checkReference(reference),
      recordInput: (record) => this.#record(record),
      aboutToSend: (kind, route, reference) => this.#tell(kind, route, reference),
      noteReadBack: (readBack) => this.#noteReadBack(readBack),
      readFailure: (answer, what, signal, acting) => this.#failureOf(answer, what, signal, acting === true),
    }
  }

  // A tree the session could not read, such as one with no window yet just after a launch, is said as such, so a wait
  // can look again; a lost session, a stop or a timeout is not.
  async #readTree(timeoutMs: number, signal: AbortSignal): Promise<TreeLook> {
    const read = await this.#session.readSource(timeoutMs, signal)
    if (!read.ok) return read.failure.class === 'not_actionable' ? { ok: false, failure: { ...read.failure, details: { ...read.failure.details, check: 'tree' } } } : read
    const parsed = parseNativeTree(read.tree.source.xml, this.platform)
    if (!parsed.ok) return { ok: false, failure: { class: 'not_actionable', message: `Retest could not read the app's tree: ${parsed.problem}` } }
    return { ok: true, tree: parsed.tree, reference: read.tree.reference }
  }

  async #readField(locator: LocatorRecipe, timeoutMs: number, signal: AbortSignal): Promise<FieldRead> {
    const read = await this.#session.readFieldSource(locator, timeoutMs, signal)
    if (!read.ok) return read.failure.class === 'not_actionable' ? { ok: false, failure: { ...read.failure, details: { ...read.failure.details, check: 'tree' } } } : read
    const parsed = parseNativeTree(read.tree.source.xml, this.platform)
    if (!parsed.ok) return { ok: false, failure: { class: 'not_actionable', message: 'The filled field tree could not be read.' } }
    const found = locate(parsed.tree, locator)
    if (!found.ok) return found
    const [element, ...others] = found.matches
    if (element === undefined || others.length > 0) return { ok: false, failure: { class: 'not_actionable', message: 'The fill read-back needs exactly one field.' } }
    return { ok: true, value: read.value, element, reference: read.tree.reference }
  }

  // On macOS a click lands on whatever window lies at its point, so the app must be in front and no window of another
  // process may lie over the element's centre. The runner's `hittable` does not show it: an element under another app's
  // floating window read as hittable here. The pointer's window and Automation Mode's overlay take no click.
  async #frontProblem(frame: Rect, window: Rect | undefined, bounds: RequestBounds): Promise<string | undefined> {
    const tools = this.#options.tools
    if (this.platform !== 'macos' || tools === undefined) return undefined
    const state = await this.#session.appState(bounds.timeoutMs, bounds.signal)
    if (!state.ok) return `Retest could not read whether the app is in front: ${state.failure.message}`
    if (state.state !== 'foreground') return 'the app is not in front'
    if (window === undefined) return 'the app has no window frame in its tree'
    const windows = await windowsOnScreen(tools, bounds)
    if (typeof windows === 'string') return `Retest could not read which windows are on screen (${windows})`
    const listed = await listProcesses(tools, bounds.timeoutMs).catch(() => undefined)
    if (listed === undefined) return 'Retest could not read the processes behind the windows on screen'
    const dock = listed.filter((entry) => entry.command.endsWith('/Dock.app/Contents/MacOS/Dock')).map((entry) => entry.pid)
    const overlay = listed.filter((entry) => entry.command === automationModeOverlay).map((entry) => entry.pid)
    const screen = await this.#options.executor.windowRect(bounds)
    if (screen.status !== 'answered') return `Retest could not read the main screen's frame (${screen.status === 'refused' ? screen.error : screen.message})`
    const covering = coveringWindows(windows, { pids: this.#session.processIds, frame: window }, { screen: screen.value, dockPids: dock })
    if (!covering.ok) return covering.problem
    const over = covering.windows.filter((entry) => entry.layer !== pointerLayer && !overlay.includes(entry.pid) && holdsCentre(entry, frame))
    if (over.length === 0) return undefined
    return `${over.length} window(s) of other processes lie over it (layer ${[...new Set(over.map((entry) => entry.layer))].join(', ')})`
  }

  #tell(kind: NativeInputKind, route: string, reference: NativeReference): void {
    const record: InputRecord = { id: `i${++this.#inputCount}`, kind, route, input: 'unknown', generation: reference.generation, observationId: reference.observationId, at: new Date().toISOString(), failure: { class: 'outcome_unknown', message: 'The native input request is in flight. Its effect is not yet known.' } }
    this.#pending = record
    this.#inputs.push(record)
    this.#unknown.push(record)
    for (const listener of this.#listeners) listener({ kind, route, reference })
  }

  #record(draft: InputRecordDraft): void {
    const pending = this.#pending
    if (pending === undefined) throw new NativeError({ class: 'usage', message: 'Native input completed without a dispatch record.' })
    this.#pending = undefined
    const index = this.#inputs.findIndex((entry) => entry.id === pending.id)
    const unknownIndex = this.#unknown.findIndex((entry) => entry.id === pending.id)
    const reconciled = this.#unknown[unknownIndex]?.reconciled
    if (draft.input === 'not_sent') {
      this.#inputs.splice(index, 1)
      if (unknownIndex >= 0) this.#unknown.splice(unknownIndex, 1)
      return
    }
    const { failure: _pendingFailure, ...base } = pending
    const record: InputRecord = { ...base, input: draft.input, ...(draft.failure === undefined ? {} : { failure: redactNativeFailure(draft.failure, this.#options.redact) }) }
    this.#inputs[index] = record
    if (draft.input === 'unknown') this.#unknown[unknownIndex] = { ...record, ...(reconciled === undefined ? {} : { reconciled }) }
    else if (unknownIndex >= 0) this.#unknown.splice(unknownIndex, 1)
  }

  // The read-back belongs to the fill's typing, the last keys this session sent.
  #noteReadBack(readBack: ReadBack): void {
    const index = this.#inputs.findLastIndex((record) => record.kind === 'keys')
    const record = this.#inputs[index]
    if (record !== undefined) this.#inputs[index] = { ...record, readBack }
  }

  #failureOf(answer: Exclude<ExecutorAnswer<unknown>, { readonly status: 'answered' }>, what: string, signal: AbortSignal, acting: boolean): Failure {
    return redactNativeFailure(this.#rawFailureOf(answer, what, signal, acting), this.#options.redact)
  }

  #rawFailureOf(answer: Exclude<ExecutorAnswer<unknown>, { readonly status: 'answered' }>, what: string, signal: AbortSignal, acting: boolean): Failure {
    const input = acting ? inputDispatch(answer) : 'not_sent'
    const mayHave = input === 'unknown' ? ' It may have taken effect; Retest does not send it again.' : ''
    if (answer.status === 'not_sent') {
      if (answer.reason === 'stopped') return stopFailure(signal.reason, 'not_sent')
      if (answer.reason === 'timeout') return { class: 'timeout', message: `${what} ran out of time before it was sent.` }
      if (answer.reason === 'wrong_executor') return { class: 'usage', message: `${what}: ${answer.message}` }
      return this.#lose(`${what}: ${answer.message}`)
    }
    if (answer.status === 'refused') {
      if (answer.error === 'invalid session id') return this.#lose(`${what}: the executor no longer knows this session (${answer.message}).`)
      return { class: input === 'unknown' ? 'outcome_unknown' : 'not_actionable', message: `${what}: the executor answered ${answer.error}: ${answer.message}.${mayHave}`, details: { executorError: answer.error } }
    }
    if (answer.reason === 'stopped') return stopFailure(signal.reason, input)
    if (answer.reason === 'timeout') return { class: 'timeout', message: `${what}: ${answer.message}${mayHave}` }
    if (answer.reason === 'connection_lost') return { ...this.#lose(`${what}: ${answer.message}${mayHave}`), class: acting ? 'outcome_unknown' : 'session_lost' }
    return { class: acting ? 'outcome_unknown' : 'not_actionable', message: `${what}: ${answer.message}${mayHave}` }
  }

  // The executor is gone or no longer knows the session: the session is lost, so nothing more is sent on it.
  #lose(message: string): Failure {
    const failure: Failure = { class: 'session_lost', message: this.#options.redact(message) }
    this.#session.markLost(failure)
    return failure
  }
}

// A click lands at the element's centre, its hit point, so a window over a corner of it takes no click.
function holdsCentre(window: Rect, frame: Rect): boolean {
  const x = frame.x + frame.width / 2
  const y = frame.y + frame.height / 2
  return x >= window.x && x < window.x + window.width && y >= window.y && y < window.y + window.height
}

// A stop takes its class from the signal's reason when that is a failure, and counts as a timeout otherwise, as the
// session contract says.
function stopFailure(reason: unknown, input: InputDispatch): Failure {
  const parsed = parse(failureSchema, reason)
  const cause: Failure = parsed.ok ? parsed.value : { class: 'timeout', message: 'The time for the request ran out.' }
  const said = input === 'not_sent' ? 'Retest stopped before it sent the request.' : 'The request had gone; it is not taken back, so it may have taken effect.'
  return { class: cause.class, message: `${cause.message} ${said}`, details: { ...cause.details, inputSent: input } }
}
