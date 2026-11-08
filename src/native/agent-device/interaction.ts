import type { AppBuild, DispatchedCommand, DispatchedRequest, Gesture, InputDispatch, LaunchSpec } from '../../browser/contract.ts'
import type { FrameSource } from '../../media/capture.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { RecordIdentity } from '../../protocol/identity.ts'
import type { LocatorRecipe } from '../../protocol/locator.ts'
import type { NativeInputKind } from '../actionability.ts'
import type { AlertAnswer } from '../alerts.ts'
import type { NativeLook } from '../assertions.ts'
import type { NativeSecretField } from '../input.ts'
import type { CaptureClearance, InputRecord, NativeCommand, NativeInteraction, NativeUnknownOutcome, SecretEntryObserver, UnknownInput } from '../interaction-session.ts'
import type { KeyboardState } from '../keyboard.ts'
import type { NativeElement, NativeTree } from '../locators.ts'
import type { CaptureSource, NativeCapture, NativeReference, ProcessReading, UnknownOutcome } from '../session.ts'
import type { Rect, RequestBounds } from '../webdriver-client.ts'
import type { AgentDeviceAnswer, AgentDeviceMethod, AgentDevicePort } from './package.ts'
import type { ReadTree } from './tree.ts'
import { waitBeforeRead, waitUntilDeadline } from '../../assertions/wait-before-read.ts'
import { ScreenshotLoopSource } from '../../media/capture.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { failureSchema } from '../../protocol/failures.ts'
import { parseKey } from '../../protocol/keys.ts'
import { describeEmptyStep, describeLocator } from '../../protocol/locator.ts'
import { parse } from '../../protocol/schema.ts'
import { secretPlaceholder } from '../../protocol/secret.ts'
import { quoteText } from '../../protocol/text.ts'
import { maxTimeout } from '../../protocol/timeouts.ts'
import { steadyFrameGapMs, unverifiedSentence } from '../actionability.ts'
import { observeTree } from '../assertions.ts'
import { nativeSecretField, secureFieldPixels } from '../input.ts'
import { coveringKeyboard } from '../keyboard.ts'
import { describeElement, enabledReading, fieldTypes, locate, platformName, valueReading, visibilityReading } from '../locators.ts'
import { redactNativeFailure } from '../output.ts'
import { pngSize } from '../png.ts'
import { NativeError, SerialLane } from '../session.ts'
import { buildTree, readSnapshot } from './tree.ts'

// A native session whose app agent-device drives. Retest keeps everything a test relies on: its locators read the tree
// agent-device's snapshot gives, its actionability decides when an element is ready, its checks judge what the tree
// shows, and its ledger keeps every input that went or may have gone. agent-device only performs one action at a time and
// reads the screen. An action goes to the element Retest found, by the ref agent-device gave it in the very snapshot
// Retest read, pinned to that snapshot's generation, so agent-device refuses it, sending nothing, when the screen has
// moved on since; Retest then looks again. An action agent-device did not prove unsent is never sent again: its outcome
// is unknown, and the session reconciles it against the app's processes as it ends. A secret is typed only into the app
// whose bundle id or package `secretOrigins` names, only when the screen agent-device read belongs to that app, and on
// Android not at all yet.

/** Where agent-device finds the device: an iOS simulator by its id, or an Android emulator or device by its adb serial. */
export type AgentDeviceTarget = { readonly platform: 'ios'; readonly udid: string } | { readonly platform: 'android'; readonly serial: string }

/** A capture of what the device shows, as the runtime takes it. */
export type ScreenCapture = (bounds: RequestBounds) => Promise<{ readonly ok: true; readonly png: Uint8Array; readonly source: CaptureSource } | { readonly ok: false; readonly failure: Failure }>

/** What an agent-device interaction session is opened with. */
export type AgentDeviceInteractionOptions = {
  readonly port: AgentDevicePort
  /** agent-device's own name for the session, which every call carries. */
  readonly session: string
  /** Retest's session id, which every reference this session serves carries. */
  readonly sessionId: string
  readonly platform: 'ios-simulator' | 'android'
  readonly device: AgentDeviceTarget
  /** The bundle id, or the Android package, of the app the runtime installed. */
  readonly bundleId: string
  readonly launch: LaunchSpec
  readonly redact: (text: string) => string
  /** Installs a build on the device, as the runtime does it. */
  readonly install: (build: AppBuild, bounds: RequestBounds) => Promise<DispatchedRequest>
  /** The app's processes, read without agent-device's input, for reconciling unknown outcomes. */
  readonly processes: (bounds: RequestBounds) => Promise<ProcessReading>
  readonly screen: ScreenCapture
  /** Told once when agent-device's runtime is gone, so the runner stops the test. */
  readonly onLost?: (reason: string) => void
}

type Target = { readonly element: NativeElement; readonly tree: NativeTree; readonly ref: string; readonly generation: number | undefined; readonly reference: NativeReference; readonly read: ReadTree; readonly appBundleId: string | undefined }
type Look = { readonly ok: true; readonly read: ReadTree; readonly reference: NativeReference; readonly generation: number | undefined; readonly appBundleId: string | undefined } | { readonly ok: false; readonly failure: Failure }
type Unready = { readonly kind: 'missing'; readonly detail: string } | { readonly kind: 'blocked'; readonly check: string; readonly detail: string } | { readonly kind: 'timeout'; readonly failure: Failure }
type Sent = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly failure: Failure; readonly input: InputDispatch; readonly retry: boolean }
type HeldField = { readonly testId: string | undefined; readonly cleared: (change: CaptureClearance) => void }

// agent-device refuses an action, sending nothing, when the screen moved on since the snapshot whose ref it was given, or
// the element is not where a tap can land yet. Each of these is a reason to look again within the action's time.
const lookAgainReasons: ReadonlySet<string> = new Set(['ref_generation_mismatch', 'ref_frame_expired', 'ref_not_found', 'target_still_moving', 'tap_keyboard_occludes_target', 'target_covered', 'interaction_blocked'])

// A failure agent-device answers only after its input went and it read what the input did, which says the input was sent.
const scrolledReasons: ReadonlySet<string> = new Set(['scroll_no_progress'])
const noReasons: ReadonlySet<string> = new Set()

const firstPauseMs = 20
const maxPauseMs = 200

/** One native session whose app agent-device drives. Each request runs in this session's own lane, one at a time. */
export class AgentDeviceInteraction implements NativeInteraction {
  readonly sessionId: string
  readonly platform: 'ios-simulator' | 'android'
  readonly #options: AgentDeviceInteractionOptions
  readonly #lane = new SerialLane()
  readonly #cancel = new AbortController()
  readonly #instance = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  readonly #inputs: InputRecord[] = []
  readonly #unknown: UnknownInput[] = []
  readonly #lifecycle: UnknownOutcome[] = []
  readonly #held = new Set<HeldField>()
  #pending: InputRecord | undefined
  #inputCount = 0
  #lifecycleCount = 0
  #observations = 0
  #generation = 0
  #open = false
  #lost: Failure | undefined
  #disposed = false
  #nextSecretEntry: SecretEntryObserver | undefined

  constructor(options: AgentDeviceInteractionOptions) {
    this.#options = options
    this.sessionId = options.sessionId
    this.platform = options.platform
  }

  get bundleId(): string {
    return this.#options.bundleId
  }

  /** Every input that went or may have gone, oldest first. */
  get inputs(): readonly InputRecord[] {
    return [...this.#inputs]
  }

  get unknownOutcomes(): readonly NativeUnknownOutcome[] {
    return [...this.#lifecycle.map((outcome) => ({ source: 'lifecycle' as const, outcome })), ...this.#unknown.map((outcome) => ({ source: 'input' as const, outcome }))]
  }

  /** The launch the app is on: 0 before the first. */
  get generation(): number {
    return this.#generation
  }

  install(build: AppBuild, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#lifecycleRequest('install', timeoutMs, signal, async (deadline, combined) => {
      const installed = await this.#options.install(build, { timeoutMs: deadline.commandTimeoutMs, signal: combined })
      return installed
    })
  }

  /** Launches the app afresh with the session's arguments: agent-device's open, with a relaunch. A launch that may have happened is never sent again. */
  launch(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    return this.#lifecycleRequest('launch', timeoutMs, signal, async (deadline, combined) => {
      const options = { app: this.bundleId, relaunch: true, ...(this.#options.launch.arguments.length === 0 ? {} : { launchArgs: [...this.#options.launch.arguments] }) }
      const answer = await this.#call('apps.open', options, deadline, combined)
      const dispatched = this.#requestOf(answer, 'Launching the app', combined)
      if (!dispatched.result.ok) return dispatched
      const opened = answer.status === 'answered' && typeof answer.value === 'object' && answer.value !== null ? Reflect.get(answer.value, 'appBundleId') : undefined
      this.#generation += 1
      this.#open = true
      if (typeof opened === 'string' && opened !== this.bundleId) return { result: { ok: false, failure: { class: 'session_lost', message: this.#redact(`agent-device opened ${opened}, not ${this.bundleId}, so Retest sends nothing more to it.`) } }, input: 'sent' }
      return dispatched
    })
  }

  activate(_timeoutMs: number, _signal?: AbortSignal): Promise<DispatchedRequest> {
    return Promise.resolve(notSent({ class: 'unsupported', message: 'Bringing an app to the front is a macOS session request; agent-device sessions launch the app instead, so Retest sent nothing.' }))
  }

  observe(locator: LocatorRecipe, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly look: NativeLook } | { readonly ok: false; readonly failure: Failure }> {
    return this.#inTurn(timeoutMs, signal, async (deadline, combined) => {
      const looked = await this.#look(deadline, combined)
      if (!looked.ok) {
        if (looked.failure.class === 'timeout') {
          await waitUntilDeadline(deadline, combined).catch(() => undefined)
        }
        return looked
      }
      const observed = observeTree(looked.read.tree, locator)
      if (!observed.ok) return observed
      return { ok: true, look: { observation: observed.observation, matches: observed.matches, reference: looked.reference, tree: looked.read.tree } }
    })
  }

  async dispatch(command: NativeCommand, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedCommand> {
    if (command.kind === 'observe') {
      const looked = await this.observe(command.locator, timeoutMs, signal)
      if (!looked.ok) return { result: { ok: false, failure: looked.failure }, input: 'not_sent' }
      return { result: { ok: true, kind: 'observe', observation: looked.look.observation, observationId: looked.look.reference.observationId, sessionId: this.sessionId }, input: 'not_sent' }
    }
    const observer = command.kind === 'fill' && command.secret !== undefined ? this.#nextSecretEntry : undefined
    if (observer !== undefined) this.#nextSecretEntry = undefined
    const done = await this.#act(timeoutMs, signal, (deadline, combined) => {
      switch (command.kind) {
        case 'tap':
          return this.#tap(command.locator, deadline, combined)
        case 'click':
          return Promise.resolve(notSent({ class: 'unsupported', message: `${platformName(this.platform)} apps take taps. Use tap().` }))
        case 'fill':
          return this.#fill(command.locator, command.value, command.secret, observer, deadline, combined)
        case 'press':
          return this.#press(command.locator, command.key, deadline, combined)
        case 'scroll':
          return this.#scroll(command.locator, command.x, command.y, deadline, combined)
      }
    })
    return { result: done.result.ok ? { ok: true, kind: command.kind } : { ok: false, failure: done.result.failure }, input: done.input }
  }

  gesture(gesture: Gesture, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest> {
    if (gesture.kind === 'swipe') return Promise.resolve(notSent({ class: 'unsupported', message: 'A swipe through agent-device is not built yet, so Retest sent nothing. Use scroll().' }))
    const locator = gesture.locator
    if (locator === undefined) return Promise.resolve(notSent({ class: 'unsupported', message: 'A tap needs an element to tap. Retest taps no point it did not find.' }))
    return this.#act(timeoutMs, signal, (deadline, combined) => this.#tap(locator, deadline, combined))
  }

  waitForKeyboard(_timeoutMs: number, _signal?: AbortSignal): Promise<{ readonly ok: true; readonly state: KeyboardState } | { readonly ok: false; readonly failure: Failure }> {
    return Promise.resolve({ ok: false, failure: notBuilt('keyboard.wait()') })
  }

  dismissKeyboard(_timeoutMs: number, _signal?: AbortSignal): Promise<DispatchedRequest> {
    return Promise.resolve(notSent(notBuilt('keyboard.dismiss()')))
  }

  dismissFirstRunCard(_timeoutMs: number, _signal?: AbortSignal): Promise<DispatchedRequest> {
    return Promise.resolve(notSent(notBuilt('keyboard.dismissFirstRunCard()')))
  }

  answerAlert(answer: AlertAnswer, _timeoutMs: number, _signal?: AbortSignal): Promise<DispatchedRequest> {
    return Promise.resolve(notSent(notBuilt(`alert.${answer.route}()`)))
  }

  /** A capture of the device's screen, as the runtime takes it, in this session's turn. Sends no input. */
  capture(timeoutMs: number): Promise<{ readonly ok: true; readonly capture: NativeCapture } | { readonly ok: false; readonly failure: Failure }> {
    return this.#inTurn(timeoutMs, undefined, async (deadline, combined) => {
      const taken = await this.#options.screen({ timeoutMs: deadline.commandTimeoutMs, signal: combined })
      if (!taken.ok) return { ok: false, failure: redactNativeFailure(taken.failure, this.#options.redact) }
      const size = pngSize(taken.png)
      if (size === undefined) return { ok: false, failure: { class: 'not_actionable', message: `The ${taken.source} capture is not a PNG.` } }
      return { ok: true, capture: { png: taken.png, source: taken.source, ...size, reference: this.#reference(), capturedAt: new Date().toISOString() } }
    })
  }

  async screenshot(timeoutMs: number): Promise<Uint8Array> {
    const taken = await this.capture(timeoutMs)
    if (!taken.ok) throw new NativeError(taken.failure)
    return taken.capture.png
  }

  /** Recording an app agent-device drives is not built: the source says so, sending nothing. */
  frameSource(identity: RecordIdentity): FrameSource {
    const reason = 'Recording an app that agent-device drives is not built yet.'
    return new ScreenshotLoopSource({ name: this.platform === 'android' ? 'executor-screen' : 'simulator-display', identity, unavailable: () => reason, grab: () => Promise.resolve({ ok: false, problem: reason }), grabTimeoutMs: 1000 })
  }

  checkReference(reference: NativeReference): Failure | undefined {
    if (reference.sessionId !== this.sessionId) return { class: 'usage', message: `The reference ${reference.observationId} belongs to session ${reference.sessionId}, not ${this.sessionId}.`, details: { stale: true } }
    if (reference.instance !== this.#instance) return { class: 'usage', message: `The reference ${reference.observationId} belongs to an earlier session of ${this.sessionId}, which served it before this one opened.`, details: { stale: true } }
    if (this.#lost !== undefined || this.#disposed) return { class: 'session_lost', message: `The reference ${reference.observationId} belongs to a session that is ${this.#disposed ? 'disposed' : 'lost'}.`, details: { stale: true } }
    if (this.#cancel.signal.aborted) {
      const stopped = stopFailure(this.#cancel.signal.reason, 'not_sent')
      return { class: stopped.class, message: `The reference ${reference.observationId} belongs to a session that was cancelled: ${stopped.message}`, details: { ...stopped.details, stale: true } }
    }
    if (reference.generation !== this.#generation || !this.#open) return { class: 'not_actionable', message: `The reference ${reference.observationId} is from launch ${reference.generation}; the app is on launch ${this.#generation}${this.#open ? '' : ', which is over'}.`, details: { stale: true, generation: reference.generation, current: this.#generation } }
    return undefined
  }

  prepareSecretEntry(observer: SecretEntryObserver): void {
    this.#nextSecretEntry = observer
  }

  cancel(reason: Failure): void {
    if (!this.#cancel.signal.aborted) this.#cancel.abort(reason)
  }

  /** Reads whether the app runs, once, for every outcome still unknown, and keeps the reading beside each. Sends nothing to the app. */
  async reconcile(timeoutMs: number): Promise<readonly NativeUnknownOutcome[]> {
    const lifecycle = this.#lifecycle.filter((entry) => entry.reconciled === undefined)
    const input = this.#unknown.filter((entry) => entry.reconciled === undefined)
    if (lifecycle.length + input.length === 0) return this.unknownOutcomes
    const reading = await this.#options.processes({ timeoutMs: Math.max(1, Math.min(maxTimeout, Math.floor(timeoutMs))) })
    for (const entry of lifecycle) this.#lifecycle[this.#lifecycle.indexOf(entry)] = { ...entry, reconciled: reading }
    for (const entry of input) this.#unknown[this.#unknown.indexOf(entry)] = { ...entry, reconciled: reading }
    return this.unknownOutcomes
  }

  /**
   * Ends the session: stops what is in flight, then closes the app through agent-device once the lane is free. A close
   * whose outcome is unknown is kept as a lifecycle outcome. Rejects with a `NativeError` when input did not settle.
   */
  async dispose(timeoutMs: number): Promise<void> {
    if (!this.#cancel.signal.aborted) this.#cancel.abort({ class: 'interrupted', message: 'The session was disposed.' })
    const deadline = new Deadline(Math.max(1, Math.min(maxTimeout, Math.floor(timeoutMs))))
    const turn = await this.#lane.acquire(undefined, deadline.commandTimeoutMs)
    try {
      if (this.#disposed) return
      this.#disposed = true
      if (turn.ok && this.#open && this.#lost === undefined) {
        const closed = await this.#call('apps.close', { app: this.bundleId }, deadline, undefined)
        if (closed.status !== 'answered' && !(closed.status === 'refused' || (closed.status === 'stopped' && closed.dispatched === 'no'))) {
          this.#lifecycle.push({ id: `l${++this.#lifecycleCount}`, kind: 'terminate', generation: this.#generation, failure: this.#failureOf(closed, 'Closing the app', undefined, true) })
        }
        this.#open = false
      }
      if (!turn.ok) throw new NativeError({ class: 'cleanup_failed', message: 'Input sent through agent-device did not settle before the session ended. Its outcome remains unknown.' })
    } finally {
      if (turn.ok) turn.release()
    }
  }

  // ---- Looks ----

  // One snapshot, read into a tree. A tree agent-device cut short, or one of another app, is a look that saw nothing
  // usable, so a wait looks again; a lost runtime, a stop or a timeout is not.
  async #look(deadline: Deadline, signal: AbortSignal): Promise<Look> {
    const answer = await this.#call('capture.snapshot', {}, deadline, signal)
    if (answer.status !== 'answered') {
      const failure = this.#failureOf(answer, "Reading the app's screen", signal, false)
      return { ok: false, failure: failure.class === 'not_actionable' ? { ...failure, details: { ...failure.details, check: 'tree' } } : failure }
    }
    const read = readSnapshot(answer.value)
    if (!read.ok) return { ok: false, failure: { class: 'not_actionable', message: read.problem, details: { check: 'tree' } } }
    const { snapshot } = read
    if (snapshot.truncated) return { ok: false, failure: { class: 'not_actionable', message: "agent-device cut the app's tree short, so Retest cannot count what it holds.", details: { check: 'tree' } } }
    if (snapshot.appBundleId !== undefined && snapshot.appBundleId !== this.bundleId) return { ok: false, failure: { class: 'not_actionable', message: this.#redact(`The screen agent-device read belongs to ${snapshot.appBundleId}, not ${this.bundleId}.`), details: { check: 'tree' } } }
    const tree = buildTree(snapshot, this.platform, this.#options.redact)
    this.#clearHeldFields(tree)
    return { ok: true, read: tree, reference: this.#reference(), generation: snapshot.refsGeneration, appBundleId: snapshot.appBundleId }
  }

  #reference(): NativeReference {
    return { sessionId: this.sessionId, generation: this.#generation, instance: this.#instance, observationId: `ad${++this.#observations}` }
  }

  // ---- Actions ----

  // Waits until exactly one element the locator finds is visible, enabled when the action needs it, uncovered, not under
  // the software keyboard, and held still across two looks at least 100 ms apart; then answers with it and the ref of
  // the latest look. More than one match, or a locator the platform cannot read, fails at once.
  async #ready(locator: LocatorRecipe, verb: string, enabled: boolean, deadline: Deadline, signal: AbortSignal): Promise<{ readonly ok: true; readonly target: Target } | { readonly ok: false; readonly failure: Failure }> {
    let last: Unready | undefined
    let still: { readonly key: string; readonly frame: Rect; readonly at: number } | undefined
    const subject = describeLocator(locator)
    for (let attempt = 0; ; attempt += 1) {
      const finalRead = deadline.reached
      const readAt = performance.now()
      const looked = await this.#look(deadline, signal)
      if (!looked.ok) {
        if (looked.failure.class === 'timeout') last ??= { kind: 'timeout', failure: looked.failure }
        else if (looked.failure.details?.['check'] === 'tree') last = { kind: 'blocked', check: 'tree', detail: looked.failure.message }
        else return looked
      } else {
        const { tree } = looked.read
        const located = locate(tree, locator)
        if (!located.ok) return located
        const [element, ...others] = located.matches
        if (others.length > 0) return { ok: false, failure: { class: 'ambiguous', message: `Could not ${verb} ${subject}: it matches ${located.matches.length} elements, and a locator must match exactly one. Retest did not ${verb} any of them.`, details: { count: located.matches.length } } }
        if (element === undefined) {
          const step = located.emptyStep === undefined ? '' : ` ${describeEmptyStep(locator, located.emptyStep)}`
          const unverified = located.unverified === undefined ? '' : ` ${unverifiedSentence(located.unverified, this.platform)}`
          last = { kind: 'missing', detail: `${step}${unverified}` }
          still = undefined
        } else {
          const blocked = this.#blocked(element, looked.read, enabled)
          if (blocked !== undefined) {
            last = blocked
            still = undefined
          } else {
            const frame = element.frame
            const ref = looked.read.refs.get(element)
            const key = elementKey(element)
            if (frame === undefined || ref === undefined) {
              last = { kind: 'blocked', check: 'visible', detail: `agent-device gave ${describeElement(element, tree.platform)} no ${ref === undefined ? 'ref' : 'frame'}` }
              still = undefined
            } else if (still !== undefined && still.key === key && sameFrame(still.frame, frame) && readAt - still.at >= steadyFrameGapMs) {
              return { ok: true, target: { element, tree, ref, generation: looked.generation, reference: looked.reference, read: looked.read, appBundleId: looked.appBundleId } }
            } else {
              if (still !== undefined && still.key === key && !sameFrame(still.frame, frame)) last = { kind: 'blocked', check: 'stable', detail: `its frame moved from ${describeFrame(still.frame)} to ${describeFrame(frame)}` }
              else last ??= { kind: 'blocked', check: 'stable', detail: 'Retest did not see it hold still across two looks' }
              still = { key, frame, at: readAt }
            }
          }
        }
      }
      if (finalRead || signal.aborted) return { ok: false, failure: unreadyFailure(last, verb, subject, deadline) }
      // The second look of a frame counts only the whole gap after the first.
      const gap = still === undefined ? 0 : Math.max(0, steadyFrameGapMs - (performance.now() - still.at))
      await waitBeforeRead(deadline, Math.max(gap, Math.min(firstPauseMs * 2 ** attempt, maxPauseMs)), signal).catch(() => undefined)
      if (signal.aborted) return { ok: false, failure: unreadyFailure(last, verb, subject, deadline) }
    }
  }

  #blocked(element: NativeElement, read: ReadTree, enabled: boolean): Unready | undefined {
    const { tree } = read
    const described = describeElement(element, tree.platform)
    const visible = visibilityReading(element, tree.platform)
    if (visible.kind === 'unreported') return { kind: 'blocked', check: 'visible', detail: `agent-device did not report whether ${described} is visible` }
    if (visible.kind !== 'read' || !visible.value) return { kind: 'blocked', check: 'visible', detail: `${described} is not visible` }
    if (enabled) {
      const reading = enabledReading(element)
      if (reading.kind !== 'read') return { kind: 'blocked', check: 'enabled', detail: `agent-device did not report whether ${described} is enabled` }
      if (!reading.value) return { kind: 'blocked', check: 'enabled', detail: `${described} is disabled` }
    }
    if (read.covered.has(element)) return { kind: 'blocked', check: 'covered', detail: `agent-device reads something else drawn over ${described}` }
    if (coveringKeyboard(tree, element) !== undefined) return { kind: 'blocked', check: 'keyboard', detail: 'the software keyboard covers it; dismiss the keyboard first' }
    return undefined
  }

  async #tap(locator: LocatorRecipe, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
    for (;;) {
      const ready = await this.#ready(locator, 'tap', true, deadline, signal)
      if (!ready.ok) return notSent(ready.failure)
      const sent = await this.#sendOnce('tap', 'interactions.press', { ref: pinned(ready.target) }, ready.target.reference, `Tapping ${describeLocator(locator)}`, deadline, signal)
      if (sent.ok) return { result: { ok: true }, input: 'sent' }
      if (sent.retry && !deadline.reached) continue
      return { result: { ok: false, failure: sent.failure }, input: sent.input }
    }
  }

  async #fill(locator: LocatorRecipe, text: string, secret: string | undefined, observer: SecretEntryObserver | undefined, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
    const subject = describeLocator(locator)
    const shown = secret === undefined ? quoteText(text) : secretPlaceholder(secret)
    if (secret !== undefined && this.platform === 'android') {
      return notSent({ class: 'unsupported', message: `Retest typed no secret into ${subject}: agent-device types Android text through adb, where the text is an argument of a process on this machine and on the device, and a secret never goes in a process argument. Type the secret on iOS, or fill the field with text that is not a secret.` })
    }
    // The capture policy hears of a secret's entry once, just before its first send, and of its end once.
    let begun = false
    const end = (input: InputDispatch, verified: boolean): void => {
      if (begun) observer?.end(input, verified)
    }
    for (;;) {
      const ready = await this.#ready(locator, 'fill', true, deadline, signal)
      if (!ready.ok) {
        end('not_sent', false)
        return notSent(ready.failure)
      }
      const { element } = ready.target
      if (!fieldTypes.has(element.type)) return notSent({ class: 'unsupported', message: `Could not fill ${subject}: it is ${describeElement(element, this.platform)}, and fill takes a text field, a secure field, a search field or a text view.`, details: { field: element.type } })
      if (element.type !== 'TextView' && /[\n\r]/.test(text)) return notSent({ class: 'unsupported', message: `Could not fill ${subject} with ${shown}: it is a ${element.type}, which holds one line. Use a text view for text with \\n or \\r.`, details: { field: element.type } })
      if (secret !== undefined && ready.target.appBundleId !== this.bundleId) {
        end('not_sent', false)
        return notSent({ class: 'not_actionable', message: this.#redact(`Retest typed no secret into ${subject}: agent-device ${ready.target.appBundleId === undefined ? 'did not say which app the screen it read belongs to' : `read a screen of ${ready.target.appBundleId}`}, and a secret goes only into ${this.bundleId}.`), details: { check: 'destination' } })
      }
      const field: NativeSecretField = nativeSecretField(element, this.platform)
      if (observer !== undefined && !begun) {
        begun = true
        observer.begin(field)
      }
      const options = { ref: pinned(ready.target), text, ...(secret === undefined ? {} : { textStdin: true }) }
      const sent = await this.#sendOnce('keys', 'interactions.fill', options, ready.target.reference, `Typing ${shown} into ${subject}`, deadline, signal)
      if (!sent.ok) {
        if (sent.retry && !deadline.reached) continue
        end(sent.input, false)
        return { result: { ok: false, failure: sent.failure }, input: sent.input }
      }
      if (secret !== undefined && observer?.cleared !== undefined && field !== 'secure') this.#held.add({ testId: element.testIds?.verified[0], cleared: observer.cleared })
      const checked = await this.#readBack(locator, text, shown, secret !== undefined, deadline, signal)
      end('sent', checked === undefined)
      if (checked !== undefined) return { result: { ok: false, failure: { ...checked, details: { ...checked.details, inputSent: 'sent' } } }, input: 'sent' }
      return { result: { ok: true }, input: 'sent' }
    }
  }

  // The read-back is the fill's only evidence of what the field holds: a plain field must hold the text, and a secure
  // field one masking character for each character typed. The value is read privately and never reaches a message.
  async #readBack(locator: LocatorRecipe, text: string, shown: string, secret: boolean, deadline: Deadline, signal: AbortSignal): Promise<Failure | undefined> {
    const subject = describeLocator(locator)
    const unverified = (why: string): Failure => ({ class: 'not_actionable', message: `Filled ${subject} with ${shown} once, and ${why}, so Retest could not verify what it holds. The input was sent; Retest typed nothing more.`, details: { check: 'read-back' } })
    for (;;) {
      const finalRead = deadline.reached
      const looked = await this.#look(deadline, signal)
      if (looked.ok) {
        const located = locate(looked.read.tree, locator)
        const [element, ...others] = located.ok ? located.matches : []
        if (element === undefined || others.length > 0) return unverified(element === undefined ? 'the field is gone from the screen' : 'the locator now matches several elements')
        const reading = valueReading(element, this.platform)
        if (reading.kind === 'placeholder') return unverified('the field reads back as its placeholder, which an empty field shows too')
        if (reading.kind !== 'read') return unverified('agent-device reported no value for the field')
        const value = looked.read.rawValues.get(element) ?? ''
        if (element.type === 'SecureTextField') {
          if (secureFieldPixels(value) === 'unmasked') return { class: 'not_actionable', message: `Filled ${subject} with ${shown} once, and the secure field reads back as something other than masking characters, so Retest cannot tell what it holds. It typed nothing more.`, details: { check: 'read-back' } }
          const read = [...value].length
          const expected = [...text].length
          if (read !== expected) return { class: 'not_actionable', message: `Filled ${subject} with ${shown} once, and the secure field shows ${read} character(s) where ${expected} were typed. Retest typed nothing more.`, details: { check: 'read-back' } }
          this.#noteReadBack('length_matched')
          return undefined
        }
        if (value === text) {
          this.#noteReadBack('matched')
          return undefined
        }
        return { class: 'not_actionable', message: secret ? `Filled ${subject} with ${shown} once, and the field reads back as other text. Retest typed nothing more.` : this.#redact(`Filled ${subject} with ${shown} once, and the ${platformName(this.platform)} field reads back as ${quoteText(value)}. Retest typed nothing more.`), details: { check: 'read-back' } }
      }
      if (looked.failure.details?.['check'] !== 'tree' && looked.failure.class !== 'timeout') return looked.failure
      if (finalRead || signal.aborted) return looked.failure
      await waitBeforeRead(deadline, 100, signal).catch(() => undefined)
    }
  }

  // A key goes to whatever holds the keyboard focus. A field without it is tapped once first; any other element is
  // pressed on only while it already holds the focus, since tapping it would press it. Enter and single characters go
  // through agent-device; other keys and chords are refused by name.
  async #press(locator: LocatorRecipe | undefined, written: string, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
    const parsed = parseKey(written)
    if (!parsed.ok) return notSent(parsed.failure)
    const { key } = parsed
    if (key.held.length > 0 || (key.kind === 'named' && key.name !== 'Enter')) return notSent({ class: 'unsupported', message: `press() cannot send ${quoteText(written)} through agent-device: it takes Enter and single characters, with no modifier key.` })
    const send = (reference: NativeReference): Promise<Sent> => key.kind === 'named'
      ? this.#sendOnce('press', 'command.keyboard', { action: 'enter' }, reference, `Pressing ${written}${locator === undefined ? '' : ` on ${describeLocator(locator)}`}`, deadline, signal)
      : this.#sendOnce('press', 'interactions.type', { text: key.character }, reference, `Pressing ${written}${locator === undefined ? '' : ` on ${describeLocator(locator)}`}`, deadline, signal)
    let input: InputDispatch = 'not_sent'
    let reference = this.#reference()
    if (locator !== undefined) {
      const verb = `press ${written} on`
      for (;;) {
        const ready = await this.#ready(locator, verb, true, deadline, signal)
        if (!ready.ok) return notSent(ready.failure)
        reference = ready.target.reference
        if (ready.target.read.focused.has(ready.target.element)) break
        if (!fieldTypes.has(ready.target.element.type)) return notSent({ class: 'unsupported', message: `Could not press a key on ${describeLocator(locator)}: it is ${describeElement(ready.target.element, this.platform)} without the keyboard focus, and Retest gives a native element the focus only by tapping a field. Press the key without a locator, or on the field that should take it.` })
        const tapped = await this.#sendOnce('tap', 'interactions.press', { ref: pinned(ready.target) }, ready.target.reference, `Focusing ${describeLocator(locator)} to press a key on it`, deadline, signal)
        if (!tapped.ok) {
          if (tapped.retry && !deadline.reached) continue
          return { result: { ok: false, failure: tapped.failure }, input: tapped.input }
        }
        input = 'sent'
        const focused = await this.#look(deadline, signal)
        const field = focused.ok ? locate(focused.read.tree, locator) : undefined
        const [element] = field?.ok === true ? field.matches : []
        if (!focused.ok || element === undefined || !focused.read.focused.has(element)) return { result: { ok: false, failure: { class: 'not_actionable', message: `Retest tapped ${describeLocator(locator)} once and could not confirm its keyboard focus, so it sent no key.`, details: { check: 'focused', inputSent: 'sent' } } }, input: 'sent' }
        reference = focused.reference
        break
      }
    }
    const sent = await send(reference)
    if (!sent.ok) return { result: { ok: false, failure: sent.failure }, input: worst(input, sent.input) }
    return { result: { ok: true }, input: 'sent' }
  }

  // One scroll gesture over the app's screen, in one direction: agent-device scrolls the screen, not an element.
  async #scroll(locator: LocatorRecipe | undefined, x: number, y: number, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) return notSent({ class: 'usage', message: `scroll() takes x and y in points, at least one of them not 0, received x ${x} and y ${y}.` })
    if (locator !== undefined) return notSent({ class: 'unsupported', message: `Scrolling ${describeLocator(locator)} through agent-device is not built yet: agent-device scrolls the screen, not one element. Scroll the app with page.scroll().` })
    if (x !== 0 && y !== 0) return notSent({ class: 'unsupported', message: 'A scroll through agent-device moves along one axis. Scroll across and down in two calls.' })
    const direction = y > 0 ? 'down' : y < 0 ? 'up' : x > 0 ? 'right' : 'left'
    const pixels = Math.round(Math.abs(y === 0 ? x : y))
    // agent-device reads the screen before and after its gesture, and answers a gesture that moved nothing with
    // `scroll_no_progress`: the gesture went, and the content was at its end. That is a scroll sent, as a wheel event on
    // a page that cannot scroll is on the web; what the scroll was for is a check's to judge.
    const sent = await this.#sendOnce('scroll', 'interactions.scroll', { direction, pixels }, this.#reference(), `Scrolling the app ${direction} by ${pixels} points`, deadline, signal, scrolledReasons)
    return sent.ok ? { result: { ok: true }, input: 'sent' } : { result: { ok: false, failure: sent.failure }, input: sent.input }
  }

  // Sends one request that acts, once, and records it whenever it may have gone. A request agent-device proved unsent
  // because the screen moved on says so, and the caller may look again; one it did not prove unsent is never sent again.
  async #sendOnce(kind: NativeInputKind, method: AgentDeviceMethod, options: Readonly<Record<string, unknown>>, reference: NativeReference, what: string, deadline: Deadline, signal: AbortSignal, sentWith: ReadonlySet<string> = noReasons): Promise<Sent> {
    const stale = this.checkReference(reference)
    if (stale !== undefined) return { ok: false, failure: { ...stale, details: { ...stale.details, inputSent: 'not_sent' } }, input: 'not_sent', retry: false }
    const route = `agent-device ${method}`
    this.#tell(kind, route, reference)
    const answer = await this.#call(method, options, deadline, signal)
    if (answer.status === 'answered' || (answer.status === 'failed' && answer.reason !== undefined && sentWith.has(answer.reason))) {
      this.#record('sent', undefined)
      return { ok: true, value: answer.status === 'answered' ? answer.value : undefined }
    }
    const input: InputDispatch = answer.status === 'refused' || (answer.status === 'stopped' && answer.dispatched === 'no') ? 'not_sent' : 'unknown'
    const failure = this.#failureOf(answer, what, signal, true)
    const withInput: Failure = { ...failure, details: { ...failure.details, inputSent: input } }
    this.#record(input, withInput)
    const retry = answer.status === 'refused' && answer.reason !== undefined && lookAgainReasons.has(answer.reason)
    return { ok: false, failure: withInput, input, retry }
  }

  #tell(kind: NativeInputKind, route: string, reference: NativeReference): void {
    const record: InputRecord = { id: `i${++this.#inputCount}`, kind, route, input: 'unknown', generation: reference.generation, observationId: reference.observationId, at: new Date().toISOString(), failure: { class: 'outcome_unknown', message: 'The input is in flight through agent-device. Its effect is not yet known.' } }
    this.#pending = record
    this.#inputs.push(record)
    this.#unknown.push(record)
  }

  #record(input: InputDispatch, failure: Failure | undefined): void {
    const pending = this.#pending
    if (pending === undefined) return
    this.#pending = undefined
    const index = this.#inputs.indexOf(pending)
    const unknownIndex = this.#unknown.indexOf(pending)
    if (input === 'not_sent') {
      this.#inputs.splice(index, 1)
      if (unknownIndex >= 0) this.#unknown.splice(unknownIndex, 1)
      return
    }
    const { failure: _inFlight, ...base } = pending
    const record: InputRecord = { ...base, input, ...(failure === undefined ? {} : { failure: redactNativeFailure(failure, this.#options.redact) }) }
    this.#inputs[index] = record
    if (input === 'unknown') this.#unknown[unknownIndex] = record
    else if (unknownIndex >= 0) this.#unknown.splice(unknownIndex, 1)
  }

  #noteReadBack(readBack: 'matched' | 'length_matched'): void {
    const index = this.#inputs.findLastIndex((record) => record.kind === 'keys')
    const record = this.#inputs[index]
    if (record !== undefined) this.#inputs[index] = { ...record, readBack }
  }

  // A field that took a secret while capture was withheld for it clears once it is gone from the screen, or masks or
  // holds nothing while it no longer has the focus. A field with no test id of its own cannot be told gone.
  #clearHeldFields(read: ReadTree): void {
    for (const held of this.#held) {
      const matches = held.testId === undefined ? undefined : read.tree.elements.filter((element) => element.testIds?.verified.includes(held.testId ?? '') === true)
      if (matches === undefined) continue
      const [field, ...others] = matches
      if (field === undefined) {
        this.#held.delete(held)
        held.cleared('gone')
        continue
      }
      if (others.length > 0 || read.focused.has(field)) continue
      const value = read.rawValues.get(field)
      if (value === undefined) continue
      const pixels = field.type === 'SecureTextField' ? secureFieldPixels(value) : value === '' ? 'empty' : 'unmasked'
      if (pixels === 'unmasked') continue
      this.#held.delete(held)
      held.cleared(pixels)
    }
  }

  // ---- Turns and calls ----

  async #lifecycleRequest(kind: UnknownOutcome['kind'], timeoutMs: number, signal: AbortSignal | undefined, work: (deadline: Deadline, signal: AbortSignal) => Promise<DispatchedRequest>): Promise<DispatchedRequest> {
    const done = await this.#act(timeoutMs, signal, work)
    if (done.input === 'unknown' && !done.result.ok) this.#lifecycle.push({ id: `l${++this.#lifecycleCount}`, kind, generation: this.#generation, failure: done.result.failure })
    return done
  }

  async #act(timeoutMs: number, signal: AbortSignal | undefined, work: (deadline: Deadline, signal: AbortSignal) => Promise<DispatchedRequest>): Promise<DispatchedRequest> {
    const turn = await this.#turn(timeoutMs, signal)
    if (!turn.ok) return notSent(turn.failure)
    try {
      const sent = await work(turn.deadline, turn.signal)
      return sent.result.ok ? sent : { ...sent, result: { ok: false, failure: redactNativeFailure(sent.result.failure, this.#options.redact) } }
    } finally {
      turn.release()
    }
  }

  async #inTurn<T>(timeoutMs: number, signal: AbortSignal | undefined, work: (deadline: Deadline, signal: AbortSignal) => Promise<T | { readonly ok: false; readonly failure: Failure }>): Promise<T | { readonly ok: false; readonly failure: Failure }> {
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
    if (this.#lost !== undefined) return this.#lost
    if (this.#disposed) return { class: 'session_lost', message: 'The session has ended, so Retest sends nothing more on it.' }
    if (this.#cancel.signal.aborted) return stopFailure(this.#cancel.signal.reason, 'not_sent')
    if (signal?.aborted === true) return stopFailure(signal.reason, 'not_sent')
    return undefined
  }

  #call(method: AgentDeviceMethod, options: Readonly<Record<string, unknown>>, deadline: Deadline, signal: AbortSignal | undefined): Promise<AgentDeviceAnswer> {
    const device = this.#options.device.platform === 'ios' ? { platform: 'ios', udid: this.#options.device.udid } : { platform: 'android', serial: this.#options.device.serial }
    return this.#options.port.call(method, { ...options, ...device, session: this.#options.session }, { timeoutMs: deadline.commandTimeoutMs, signal })
  }

  // A lifecycle request's answer: done, refused with nothing sent, or a failure whose outcome is unknown.
  #requestOf(answer: AgentDeviceAnswer, what: string, signal: AbortSignal): DispatchedRequest {
    if (answer.status === 'answered') return { result: { ok: true }, input: 'sent' }
    const input: InputDispatch = answer.status === 'refused' || (answer.status === 'stopped' && answer.dispatched === 'no') ? 'not_sent' : 'unknown'
    const failure = this.#failureOf(answer, what, signal, true)
    return { result: { ok: false, failure: { ...failure, details: { ...failure.details, inputSent: input } } }, input }
  }

  // An answer that was not a success, as the session's failure. A read that failed is a look that saw nothing; an act
  // that failed without agent-device's proof that nothing went is an unknown outcome; a runtime gone loses the session.
  #failureOf(answer: Exclude<AgentDeviceAnswer, { readonly status: 'answered' }>, what: string, signal: AbortSignal | undefined, acting: boolean): Failure {
    const mayHave = ' It may have reached the device; Retest does not send it again.'
    switch (answer.status) {
      case 'stopped':
        return stopFailure(signal?.reason, acting ? answer.dispatched === 'no' ? 'not_sent' : 'unknown' : 'not_sent')
      case 'timeout':
        return { class: 'timeout', message: this.#redact(`${what}: ${answer.message}${acting ? mayHave : ''}`) }
      case 'lost':
        return this.#lose(`${what}: ${answer.message}${acting ? mayHave : ''}`, acting)
      case 'refused': {
        const unsupported = answer.code === 'UNSUPPORTED_OPERATION' || answer.code === 'NOT_IMPLEMENTED' || answer.code === 'UNSUPPORTED_PLATFORM'
        const why = `agent-device refused it (${answer.code}${answer.reason === undefined ? '' : `, ${answer.reason}`}): ${answer.message}`
        return { class: unsupported ? 'unsupported' : 'not_actionable', message: this.#redact(`${what}: ${why}. Nothing reached the device.`), details: { agentDeviceCode: answer.code, ...(answer.reason === undefined ? {} : { agentDeviceReason: answer.reason }) } }
      }
      case 'failed': {
        if (answer.code === 'SESSION_NOT_FOUND') return this.#lose(`${what}: agent-device no longer knows this session (${answer.message}).${acting ? mayHave : ''}`, acting)
        const why = `agent-device failed (${answer.code}${answer.reason === undefined ? '' : `, ${answer.reason}`}): ${answer.message}`
        return { class: acting ? 'outcome_unknown' : 'not_actionable', message: this.#redact(`${what}: ${why}.${acting ? mayHave : ''}`), details: { agentDeviceCode: answer.code, ...(answer.reason === undefined ? {} : { agentDeviceReason: answer.reason }) } }
      }
    }
  }

  // agent-device's runtime is gone or no longer knows the session: nothing more is sent on it, and an input that was out
  // has an unknown outcome.
  #lose(message: string, acting: boolean): Failure {
    const failure: Failure = { class: acting ? 'outcome_unknown' : 'session_lost', message: this.#redact(message) }
    if (this.#lost === undefined) {
      this.#lost = { class: 'session_lost', message: failure.message }
      this.#options.onLost?.(failure.message)
    }
    return failure
  }

  #redact(text: string): string {
    return this.#options.redact(text)
  }
}

/** A ref pinned to the snapshot it came from, so agent-device refuses it once the screen has moved on. */
function pinned(target: Target): string {
  return target.generation === undefined ? `@${target.ref}` : `@${target.ref}~s${target.generation}`
}

// What tells one element from another across two looks: its type, its test ids and its label.
function elementKey(element: NativeElement): string {
  return JSON.stringify([element.type, element.testIds?.verified ?? [], element.attributes['label'] ?? ''])
}

// Within half a point is the same frame, as agent-device rounds nothing and a layout settles on fractions.
function sameFrame(first: Rect, second: Rect): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5
  return near(first.x, second.x) && near(first.y, second.y) && near(first.width, second.width) && near(first.height, second.height)
}

function describeFrame(frame: Rect): string {
  return `${frame.x},${frame.y} ${frame.width}x${frame.height}`
}

const becauseOf: Readonly<Record<string, string>> = {
  tree: "Retest could not read the app's tree",
  visible: 'it is not visible',
  enabled: 'it is disabled',
  covered: 'something lies over it',
  keyboard: 'the software keyboard covers it',
  stable: 'it kept moving',
}

function unreadyFailure(last: Unready | undefined, verb: string, subject: string, deadline: Deadline): Failure {
  const waitedMs = deadline.budgetMs
  if (last === undefined) return { class: 'timeout', message: `Could not ${verb} ${subject} within ${waitedMs} ms: Retest got no look at the app in time.`, details: { waitedMs } }
  if (last.kind === 'timeout') return last.failure
  if (last.kind === 'missing') return { class: 'not_found', message: `Could not ${verb} ${subject}: no element matched within ${waitedMs} ms.${last.detail}`, details: { waitedMs } }
  return { class: 'not_actionable', message: `Could not ${verb} ${subject} within ${waitedMs} ms: ${becauseOf[last.check] ?? last.check}: ${last.detail}.`, details: { check: last.check, waitedMs } }
}

function notBuilt(what: string): Failure {
  return { class: 'unsupported', message: `${what} through agent-device is not built yet, so Retest sent nothing.` }
}

function notSent(failure: Failure): DispatchedRequest {
  return { result: { ok: false, failure: { ...failure, details: { ...failure.details, inputSent: 'not_sent' } } }, input: 'not_sent' }
}

function worst(first: InputDispatch, second: InputDispatch): InputDispatch {
  if (first === 'unknown' || second === 'unknown') return 'unknown'
  return first === 'sent' || second === 'sent' ? 'sent' : 'not_sent'
}

// A stop takes its class from the signal's reason when that is a failure, and counts as a timeout otherwise.
function stopFailure(reason: unknown, input: InputDispatch): Failure {
  const parsed = parse(failureSchema, reason)
  const cause: Failure = parsed.ok ? parsed.value : { class: 'timeout', message: 'The time for the request ran out.' }
  const said = input === 'not_sent' ? 'Retest stopped before it sent the request.' : 'The request had gone; it is not taken back, so it may have taken effect.'
  return { class: cause.class, message: `${cause.message} ${said}`, details: { ...cause.details, inputSent: input } }
}
