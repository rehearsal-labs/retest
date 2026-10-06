import type { InputDispatch, NativeKind } from '../browser/contract.ts'
import { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { EmptyStep, LocatorRecipe } from '../protocol/locator.ts'
import type { NativeElement, NativeTree, ResolutionPlan, UnverifiedIdentifiers } from './locators.ts'
import type { FieldRead } from './input.ts'
import type { NativeReference } from './session.ts'
import type { ExecutorAnswer, ExecutorElements, ExecutorSession, JsonValue, Rect, RequestBounds } from './webdriver-client.ts'
import { waitBeforeRead, waitUntilDeadline } from '../assertions/wait-before-read.ts'
import { describeEmptyStep, describeLocator } from '../protocol/locator.ts'
import { quoteText } from '../protocol/text.ts'
import { alertsOf, blockingAlert, describeAlert } from './alerts.ts'
import { coveringKeyboard } from './keyboard.ts'
import { describeElement, enabledReading, identifierOf, locate, platformName, predicateFor, resolutionPlan, visibilityReading } from './locators.ts'

// Actionability for native apps: an element is acted on only when exactly one element is picked in the session's own
// scoped tree, it is visible and, for an action that needs it, enabled, nothing the app shows blocks it (an alert, or on
// iOS the software keyboard over it), the executor resolves that same element with a predicate whose count equals the
// tree's, inside the owned window on macOS, the identifiers of it and of any element it is resolved inside read back,
// two reads of its frame at least 100 ms apart agree, the executor calls it hittable, and on macOS the app is in front
// with no window of another process over it. Every input Retest sends on an element passes here first, whether a test's
// locator named it or Retest picked it itself, as a keyboard's return key or an alert's button. Looks repeat until the
// action's deadline, as the web's do; an ambiguous match, an unsupported locator or an identifier that reads back wrong
// fails at once.

/** One look at the scoped tree: the tree parsed, and the reference of the observation it came from. */
export type TreeLook = { readonly ok: true; readonly tree: NativeTree; readonly reference: NativeReference } | { readonly ok: false; readonly failure: Failure }

/** What a request that went, or may have gone, records: its kind, its route, and how far it got. */
export type InputRecordDraft = { readonly kind: NativeInputKind; readonly route: string; readonly input: InputDispatch; readonly reference: NativeReference; readonly failure?: Failure }

/** The kinds of native input Retest sends. */
export type NativeInputKind = 'tap' | 'click' | 'keys' | 'clear' | 'press' | 'scroll' | 'swipe' | 'alert' | 'keyboard'

/**
 * What the interaction layer needs of a session, as `NativeInteractionSession` provides it: the scoped tree, the
 * executor routes, the macOS front checks, the reference check, and somewhere to record input.
 */
export type NativePort = {
  readonly platform: NativeKind
  readonly sessionId: string
  readonly elements: ExecutorElements
  readonly executor: ExecutorSession
  readTree(timeoutMs: number, signal: AbortSignal): Promise<TreeLook>
  readField(locator: LocatorRecipe, timeoutMs: number, signal: AbortSignal): Promise<FieldRead>
  /** Why the app is not in front with nothing of another process over `frame`, on macOS; undefined when it is, and always on iOS. */
  frontProblem(frame: Rect, window: Rect | undefined, bounds: RequestBounds): Promise<string | undefined>
  /** Why keys would not reach the app, on macOS: the app is not in front, or that could not be read. Undefined when they would, and always on iOS. */
  keysProblem(bounds: RequestBounds): Promise<string | undefined>
  /** Why a reference can no longer be acted on: the session refuses it, or the session is stopped, cancelled or lost. */
  checkReference(reference: NativeReference): Promise<Failure | undefined>
  recordInput(record: InputRecordDraft): void
  /** Told right before an input request goes, so listeners hear of it while it is in flight. */
  aboutToSend(kind: NativeInputKind, route: string, reference: NativeReference): void
  /** Notes how the field of the fill just typed read back. */
  noteReadBack(readBack: 'matched' | 'length_matched'): void
  /**
   * Turns an executor answer that did not come back as asked into the session's failure, losing the session when the
   * executor is gone. `acting` marks a request that sends input, whose unanswered outcome is unknown.
   */
  readFailure(answer: Exclude<ExecutorAnswer<unknown>, { readonly status: 'answered' }>, what: string, signal: AbortSignal, acting?: boolean): Failure
}

/** What an action asks of its element besides being found and visible. */
export type ActionNeeds = { readonly verb: string; readonly enabled: boolean }

/** An element ready for input: where it is in the tree, the observation it came from, and the executor's id for it. */
export type ActionTarget = { readonly element: NativeElement; readonly tree: NativeTree; readonly reference: NativeReference; readonly executorElement: string; readonly frame: Rect }

/**
 * What an element picked from a tree is: the one element; none yet, with why when the picker knows; or a refusal that
 * ends the action at once, as for several matches.
 */
export type Picked =
  | { readonly kind: 'found'; readonly element: NativeElement }
  | { readonly kind: 'missing'; readonly emptyStep?: EmptyStep; readonly unverified?: UnverifiedIdentifiers; readonly detail?: string }
  | { readonly kind: 'refused'; readonly failure: Failure }

/**
 * What an action is on: one element of each tree Retest reads, picked by a test's locator or by the code that knows the
 * element, such as a keyboard's return key or an alert's button, and how a message names it.
 */
export type ActionSubject = { readonly describe: string; readonly locator?: LocatorRecipe; pick(tree: NativeTree): Picked }

type Check = 'tree' | 'visible' | 'enabled' | 'alert' | 'keyboard' | 'resolved' | 'stable' | 'hittable' | 'front'

type Unready =
  | { readonly status: 'missing'; readonly emptyStep: EmptyStep | undefined; readonly unverified: UnverifiedIdentifiers | undefined; readonly detail: string | undefined }
  | { readonly status: 'blocked'; readonly check: Check; readonly detail: string }
  | { readonly status: 'timeout'; readonly failure: Failure }

type Look = { readonly kind: 'settled'; readonly result: { readonly ok: true; readonly target: ActionTarget } | { readonly ok: false; readonly failure: Failure } } | { readonly kind: 'unready'; readonly unready: Unready }

const firstPauseMs = 20
const maxPauseMs = 200

/** How far apart in time the two reads of an element's frame are at least: a sheet still sliding in moves within it. */
export const steadyFrameGapMs = 100

const becauseOf: Readonly<Record<Check, string>> = {
  tree: "Retest could not read the app's tree",
  visible: 'it is not visible',
  enabled: 'it is disabled',
  alert: 'an alert blocks it',
  keyboard: 'the software keyboard covers it',
  resolved: 'the executor did not resolve it as the tree showed it',
  stable: 'it kept moving',
  hittable: 'the executor reports it is not hittable',
  front: 'the app is not in front with nothing over it',
}

/**
 * The subject a test's locator names: the one element it matches. Several matches refuse at once as `ambiguous`, and a
 * locator the platform cannot read as its own failure.
 *
 * @example locatorSubject({ by: 'testId', value: 'save-task' }).describe // "getByTestId('save-task')"
 */
export function locatorSubject(locator: LocatorRecipe, verb: string): ActionSubject {
  return {
    describe: describeLocator(locator),
    locator,
    pick: (tree) => {
      const located = locate(tree, locator)
      if (!located.ok) return { kind: 'refused', failure: located.failure }
      const [element, ...others] = located.matches
      if (element === undefined) return { kind: 'missing', ...(located.emptyStep === undefined ? {} : { emptyStep: located.emptyStep }), ...(located.unverified === undefined ? {} : { unverified: located.unverified }) }
      if (others.length > 0) return { kind: 'refused', failure: ambiguous(located.matches.length, describeLocator(locator), verb) }
      return { kind: 'found', element }
    },
  }
}

/**
 * Looks for the one element a subject picks until it passes every check or the deadline passes, then returns it with
 * the executor's id for it. More than one match, a locator the platform cannot read and an identifier that reads back
 * wrong fail at once; anything else waits, with pauses from 20 ms doubling to 200 ms, as the web's actions wait.
 *
 * @example const target = await waitUntilActionable(port, locatorSubject({ by: 'testId', value: 'save-task' }, 'tap'), { verb: 'tap', enabled: true }, deadline, signal)
 */
export async function waitUntilActionable(port: NativePort, subject: ActionSubject, needs: ActionNeeds, deadline: Deadline, signal: AbortSignal): Promise<{ readonly ok: true; readonly target: ActionTarget } | { readonly ok: false; readonly failure: Failure }> {
  let last: Unready | undefined
  for (let attempt = 0; ; attempt += 1) {
    const finalRead = deadline.reached
    const looked = await look(port, subject, needs, deadline, signal, last)
    if (looked.kind === 'settled') return looked.result
    last = looked.unready
    if (finalRead || signal.aborted) return { ok: false, failure: unreadyFailure(last, subject, needs, deadline, port.platform) }
    await waitBeforeRead(deadline, Math.min(firstPauseMs * 2 ** attempt, maxPauseMs), signal).catch(() => undefined)
    if (signal.aborted) return { ok: false, failure: unreadyFailure(last, subject, needs, deadline, port.platform) }
  }
}

async function look(port: NativePort, subject: ActionSubject, needs: ActionNeeds, deadline: Deadline, signal: AbortSignal, last: Unready | undefined): Promise<Look> {
  const bounds = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal })
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  // The tree holds the first read of the element's frame; the executor's rect, at least the gap later, the second.
  const treeReadAt = performance.now()
  if (!read.ok) return settledReadFailure(read.failure, last, subject, needs, deadline, port.platform)
  const { tree, reference } = read
  const picked = subject.pick(tree)
  if (picked.kind === 'refused') return settled(picked.failure)
  if (picked.kind === 'missing') return { kind: 'unready', unready: { status: 'missing', emptyStep: picked.emptyStep, unverified: picked.unverified, detail: picked.detail } }
  const { element } = picked
  const alert = blockingAlert(tree, element)
  if (alert !== undefined) return blocked('alert', `${describeAlert(alert, tree.platform)} is open over it`)
  const visible = visibilityReading(element, tree.platform)
  if (visible.kind === 'unreported') return blocked('visible', `the executor did not report whether ${describeElement(element, tree.platform)} is visible: its tree carries no ${visible.attribute}`)
  if (visible.kind !== 'read' || !visible.value) return blocked('visible', `${describeElement(element, tree.platform)} is not visible`)
  if (needs.enabled) {
    const enabled = enabledReading(element)
    if (enabled.kind !== 'read') return blocked('enabled', `the executor did not report whether ${describeElement(element, tree.platform)} is enabled: its tree carries no enabled`)
    if (!enabled.value) return blocked('enabled', `${describeElement(element, tree.platform)} is disabled`)
  }
  const keyboard = coveringKeyboard(tree, element)
  if (keyboard !== undefined) return blocked('keyboard', 'the software keyboard covers it; dismiss the keyboard first')
  const frame = element.frame
  if (frame === undefined || frame.width <= 0 || frame.height <= 0) return blocked('visible', `${describeElement(element, tree.platform)} has no frame on screen`)
  const resolved = await resolveElement(port, tree, element, bounds(), signal)
  if (resolved.kind === 'failed') return settledReadFailure(resolved.failure, last, subject, needs, deadline, port.platform)
  if (resolved.kind === 'refused') return settled(resolved.failure)
  if (resolved.kind === 'unready') return blocked('resolved', resolved.detail)
  const executorElement = resolved.element
  const identity = await readBackIdentity(port, element, executorElement, bounds(), signal)
  if (identity.kind === 'failed') return settledReadFailure(identity.failure, last, subject, needs, deadline, port.platform)
  if (identity.kind === 'refused') return settled(identity.failure)
  // The second read of the frame is worth something only the whole gap after the first: a frame read sooner can match a
  // sheet still moving. With less time left than the gap, keep looking without accepting a shorter proof,
  // preserving the previous readiness reason when there was one.
  const pause = steadyFrameGapMs - (performance.now() - treeReadAt)
  if (pause > deadline.remainingMs) return last === undefined ? blocked('stable', notSteadyInTime(subject, needs, deadline).message) : { kind: 'unready', unready: last }
  if (pause > 0) await waitUntilDeadline(new Deadline(steadyFrameGapMs, { startedAt: treeReadAt }), signal).catch(() => undefined)
  if (signal.aborted) return settledReadFailure(port.readFailure({ status: 'not_sent', reason: 'stopped', message: 'Stopped before the second read of the frame.' }, `Reading the frame of ${describeElement(element, tree.platform)}`, signal), last, subject, needs, deadline, port.platform)
  const rect = await port.elements.elementRect(executorElement, bounds())
  if (rect.status !== 'answered') return answerUnready(port, rect, `Reading the frame of ${describeElement(element, tree.platform)}`, signal, last, subject, needs, deadline)
  if (!sameFrame(rect.value, frame)) return blocked('stable', `its frame moved from ${describeFrame(frame)} to ${describeFrame(rect.value)}`)
  const hittable = await port.elements.elementAttribute(executorElement, 'hittable', bounds())
  if (hittable.status !== 'answered') return answerUnready(port, hittable, `Reading whether ${describeElement(element, tree.platform)} is hittable`, signal, last, subject, needs, deadline)
  if (!isTrue(hittable.value)) return blocked('hittable', `the executor reports ${describeElement(element, tree.platform)} is not hittable`)
  const front = await port.frontProblem(rect.value, tree.root.frame, bounds())
  // Once this allocation is exhausted, keep the earlier readiness reason and issue the final tree read.
  if (deadline.reached && last !== undefined) return { kind: 'unready', unready: last }
  if (front !== undefined) return blocked('front', front)
  return settledTarget({ element, tree, reference, executorElement, frame: rect.value })
}

/**
 * Input on the app as a whole rather than on one element: a key with no element named, or a scroll or swipe over the
 * app. `point` input lands at the centre of the app's window; `keys` go to whatever holds the focus.
 */
export type AppInput = { readonly verb: string; readonly at: 'point' | 'keys' }

/** The app's window, ready for input: its frame, the observation it came from, and on macOS the executor's id for it. */
export type AppArea = { readonly frame: Rect; readonly reference: NativeReference; readonly executorElement?: string }

type AppLook = { readonly kind: 'settled'; readonly result: { readonly ok: true; readonly area: AppArea } | { readonly ok: false; readonly failure: Failure } } | { readonly kind: 'unready'; readonly unready: Unready }

/**
 * Waits until the app as a whole takes input, as `waitUntilActionable` waits for an element, with the checks that mean
 * something without one: its window has a frame, no alert is open, on iOS the software keyboard is not where a point
 * input lands, two reads of the window's frame at least 100 ms apart agree, and on macOS the app is in front with no
 * window of another process over its window's centre. On macOS the window is resolved on the executor as any element,
 * and for point input must read hittable; on iOS, where the app's windows cannot be told apart by a predicate, the
 * second read of the frame is a second tree.
 *
 * @example const ready = await waitUntilAppReady(port, { verb: 'press Enter in', at: 'keys' }, deadline, signal)
 */
export async function waitUntilAppReady(port: NativePort, input: AppInput, deadline: Deadline, signal: AbortSignal): Promise<{ readonly ok: true; readonly area: AppArea } | { readonly ok: false; readonly failure: Failure }> {
  const subject: ActionSubject = { describe: 'the app', pick: (tree) => ({ kind: 'found', element: appWindow(tree) }) }
  const needs: ActionNeeds = { verb: input.verb, enabled: false }
  let last: Unready | undefined
  for (let attempt = 0; ; attempt += 1) {
    const finalRead = deadline.reached
    const looked = await lookAtApp(port, input, subject, needs, deadline, signal, last)
    if (looked.kind === 'settled') return looked.result
    last = looked.unready
    if (finalRead || signal.aborted) return { ok: false, failure: unreadyFailure(last, subject, needs, deadline, port.platform) }
    await waitBeforeRead(deadline, Math.min(firstPauseMs * 2 ** attempt, maxPauseMs), signal).catch(() => undefined)
    if (signal.aborted) return { ok: false, failure: unreadyFailure(last, subject, needs, deadline, port.platform) }
  }
}

/** The app's window in a scoped tree: on macOS the tree's root, on iOS the first window of the app, or the app. */
export function appWindow(tree: NativeTree): NativeElement {
  if (tree.platform === 'macos') return tree.root
  return tree.root.children.find((child) => child.type === 'Window') ?? tree.root
}

async function lookAtApp(port: NativePort, input: AppInput, subject: ActionSubject, needs: ActionNeeds, deadline: Deadline, signal: AbortSignal, last: Unready | undefined): Promise<AppLook> {
  const bounds = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal })
  const unsettled = (look: Look): AppLook => (look.kind === 'unready' ? look : { kind: 'settled', result: look.result.ok ? { ok: false, failure: { class: 'not_actionable', message: 'Retest picked an element where it looked for the app.' } } : look.result })
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  const treeReadAt = performance.now()
  if (!read.ok) return unsettled(settledReadFailure(read.failure, last, subject, needs, deadline, port.platform))
  const { tree, reference } = read
  const window = appWindow(tree)
  const [alert] = alertsOf(tree)
  if (alert !== undefined) return unsettled(blocked('alert', `${describeAlert(alert, tree.platform)} is open`))
  const frame = window.frame
  if (frame === undefined || frame.width <= 0 || frame.height <= 0) return unsettled(blocked('visible', `the app's ${window.type} has no frame on screen`))
  if (input.at === 'point' && coveringKeyboard(tree, window) !== undefined) return unsettled(blocked('keyboard', 'the software keyboard covers the centre of the app; dismiss the keyboard first'))
  let executorElement: string | undefined
  if (port.platform === 'macos') {
    const resolved = await resolveElement(port, tree, window, bounds(), signal)
    if (resolved.kind === 'failed') return unsettled(settledReadFailure(resolved.failure, last, subject, needs, deadline, port.platform))
    if (resolved.kind === 'refused') return unsettled(settled(resolved.failure))
    if (resolved.kind === 'unready') return unsettled(blocked('resolved', resolved.detail))
    const identity = await readBackIdentity(port, window, resolved.element, bounds(), signal)
    if (identity.kind === 'failed') return unsettled(settledReadFailure(identity.failure, last, subject, needs, deadline, port.platform))
    if (identity.kind === 'refused') return unsettled(settled(identity.failure))
    executorElement = resolved.element
  }
  const pause = steadyFrameGapMs - (performance.now() - treeReadAt)
  if (pause > deadline.remainingMs) return unsettled(last === undefined ? blocked('stable', notSteadyInTime(subject, needs, deadline).message) : { kind: 'unready', unready: last })
  if (pause > 0) await waitUntilDeadline(new Deadline(steadyFrameGapMs, { startedAt: treeReadAt }), signal).catch(() => undefined)
  if (signal.aborted) return unsettled(settledReadFailure(port.readFailure({ status: 'not_sent', reason: 'stopped', message: 'Stopped before the second read of the frame.' }, "Reading the frame of the app's window", signal), last, subject, needs, deadline, port.platform))
  const second = await secondFrame(port, executorElement, bounds(), signal)
  if (second.kind === 'failed') return unsettled(settledReadFailure(second.failure, last, subject, needs, deadline, port.platform))
  if (second.kind === 'unready') return unsettled(blocked(second.check, second.detail))
  if (!sameFrame(second.frame, frame)) return unsettled(blocked('stable', `the app's window moved from ${describeFrame(frame)} to ${describeFrame(second.frame)}`))
  if (executorElement !== undefined && input.at === 'point') {
    const hittable = await port.elements.elementAttribute(executorElement, 'hittable', bounds())
    if (hittable.status !== 'answered') return unsettled(await answerUnready(port, hittable, "Reading whether the app's window is hittable", signal, last, subject, needs, deadline))
    if (!isTrue(hittable.value)) return unsettled(blocked('hittable', "the executor reports the app's window is not hittable"))
  }
  const front = await port.frontProblem(second.frame, second.frame, bounds())
  if (deadline.reached && last !== undefined) return { kind: 'unready', unready: last }
  if (front !== undefined) return unsettled(blocked('front', front))
  return { kind: 'settled', result: { ok: true, area: { frame: second.frame, reference, ...(executorElement === undefined ? {} : { executorElement }) } } }
}

type SecondFrame = { readonly kind: 'read'; readonly frame: Rect } | { readonly kind: 'unready'; readonly check: Check; readonly detail: string } | { readonly kind: 'failed'; readonly failure: Failure }

// The second read of the app window's frame: the executor's rect of the resolved window on macOS, a second tree on iOS.
async function secondFrame(port: NativePort, executorElement: string | undefined, bounds: RequestBounds, signal: AbortSignal): Promise<SecondFrame> {
  if (executorElement !== undefined) {
    const rect = await port.elements.elementRect(executorElement, bounds)
    if (rect.status === 'answered') return { kind: 'read', frame: rect.value }
    if (rect.status === 'refused' && (rect.error === 'stale element reference' || rect.error === 'no such element')) return { kind: 'unready', check: 'resolved', detail: "the app's window was replaced while Retest checked it" }
    return { kind: 'failed', failure: port.readFailure(rect, "Reading the frame of the app's window", signal) }
  }
  const read = await port.readTree(bounds.timeoutMs, signal)
  if (!read.ok) return read.failure.details?.['check'] === 'tree' ? { kind: 'unready', check: 'tree', detail: read.failure.message } : { kind: 'failed', failure: read.failure }
  const frame = appWindow(read.tree).frame
  if (frame === undefined) return { kind: 'unready', check: 'visible', detail: "the app's window has no frame on screen" }
  const [alert] = alertsOf(read.tree)
  if (alert !== undefined) return { kind: 'unready', check: 'alert', detail: `${describeAlert(alert, read.tree.platform)} is open` }
  return { kind: 'read', frame }
}

function settled(failure: Failure): Look {
  return { kind: 'settled', result: { ok: false, failure } }
}

function settledTarget(target: ActionTarget): Look {
  return { kind: 'settled', result: { ok: true, target } }
}

function blocked(check: Check, detail: string): Look {
  return { kind: 'unready', unready: { status: 'blocked', check, detail } }
}

// A timed-out look preserves the last readiness reason and keeps looking through the exact deadline. A lost
// session or another non-time failure ends the action immediately.
function settledReadFailure(failure: Failure, last: Unready | undefined, _subject: ActionSubject, _needs: ActionNeeds, _deadline: Deadline, _platform: NativeKind): Look {
  if (failure.class === 'timeout') return { kind: 'unready', unready: last ?? { status: 'timeout', failure } }
  // A tree that could not be read, as just after a launch before the app shows a window, is looked at again.
  if (failure.details?.['check'] === 'tree') return blocked('tree', failure.message)
  return settled(failure)
}

async function answerUnready(port: NativePort, answer: Exclude<ExecutorAnswer<unknown>, { readonly status: 'answered' }>, what: string, signal: AbortSignal, last: Unready | undefined, subject: ActionSubject, needs: ActionNeeds, deadline: Deadline): Promise<Look> {
  // An element the UI replaced since it was resolved is looked for again.
  if (answer.status === 'refused' && (answer.error === 'stale element reference' || answer.error === 'no such element')) return blocked('resolved', `${what}: the element was replaced while Retest checked it`)
  return settledReadFailure(port.readFailure(answer, what, signal), last, subject, needs, deadline, port.platform)
}

type Resolution =
  | { readonly kind: 'resolved'; readonly element: string }
  | { readonly kind: 'unready'; readonly detail: string }
  | { readonly kind: 'refused'; readonly failure: Failure }
  | { readonly kind: 'failed'; readonly failure: Failure }

/**
 * Asks the executor for the element the tree showed, by the plan `resolutionPlan` makes: its own predicate, or its
 * predicate inside an ancestor the executor resolves first, whose identifier is read back as the element's is. On macOS
 * every lookup runs inside the owned window, the scoped tree's root, so an element of another window or of the menu bar
 * is never taken. The executor's count must equal the tree's at each step, or the element is not taken; an element with
 * no plan is refused by name.
 */
export async function resolveElement(port: NativePort, tree: NativeTree, element: NativeElement, bounds: RequestBounds, signal: AbortSignal): Promise<Resolution> {
  const plan = resolutionPlan(tree, element)
  if (plan === undefined) {
    return { kind: 'refused', failure: { class: 'not_actionable', message: `Retest cannot name ${describeElement(element, tree.platform)} to the executor: other elements of its type share its label and none of its ancestors sets it apart. Give it an accessibility identifier.`, details: { check: 'resolved' } } }
  }
  if (port.platform !== 'macos' || element === tree.root) return resolvePlan(port, plan, element, undefined, bounds, signal)
  const windowPlan = resolutionPlan(tree, tree.root)
  if (windowPlan === undefined) return { kind: 'refused', failure: { class: 'not_actionable', message: `Retest cannot name the app's window to the executor, so it cannot look for ${describeElement(element, tree.platform)} inside it.`, details: { check: 'resolved' } } }
  const window = await resolvePlan(port, windowPlan, tree.root, undefined, bounds, signal)
  if (window.kind !== 'resolved') return window
  const windowIdentity = await readBackIdentity(port, tree.root, window.element, bounds, signal)
  if (windowIdentity.kind !== 'ok') return windowIdentity
  // The scoped tree is the window and what lies in it, so the plan's counts are already counted as the executor counts a
  // search inside the window, the window itself included.
  return resolvePlan(port, plan, element, window.element, bounds, signal)
}

async function resolvePlan(port: NativePort, plan: ResolutionPlan, element: NativeElement, anchor: string | undefined, bounds: RequestBounds, signal: AbortSignal): Promise<Resolution> {
  let within = anchor
  if (plan.within !== undefined) {
    const outer = await resolvePlan(port, plan.within, plan.within.element, anchor, bounds, signal)
    if (outer.kind !== 'resolved') return outer
    // An ancestor is taken on its identifier as the element is, so it is read back the same way before anything is looked for inside it.
    const identity = await readBackIdentity(port, plan.within.element, outer.element, bounds, signal)
    if (identity.kind !== 'ok') return identity
    within = outer.element
  }
  const predicate = predicateFor(plan.keys, port.platform)
  const found = await port.elements.findElements(predicate, within, bounds)
  if (found.status !== 'answered') {
    if (found.status === 'refused' && (found.error === 'stale element reference' || found.error === 'no such element')) return { kind: 'unready', detail: 'the element it lies in was replaced while Retest resolved it' }
    return { kind: 'failed', failure: port.readFailure(found, `Finding ${describeElement(element, port.platform)} on the executor`, signal) }
  }
  const [id, ...others] = found.value
  if (id === undefined || others.length > 0 || found.value.length !== plan.count) {
    return { kind: 'unready', detail: `the executor found ${found.value.length} element(s) for ${quoteText(predicate)} where the tree showed ${plan.count}` }
  }
  return { kind: 'resolved', element: id }
}

type IdentityCheck = { readonly kind: 'ok' } | { readonly kind: 'refused'; readonly failure: Failure } | { readonly kind: 'failed'; readonly failure: Failure }

/**
 * Reads the identifier back from the element the executor resolved, when the tree gave it one: on macOS its
 * `identifier`, on iOS its `name`, which must still differ from its `label`.
 */
export async function readBackIdentity(port: NativePort, element: NativeElement, executorElement: string, bounds: RequestBounds, signal: AbortSignal): Promise<IdentityCheck> {
  const expected = identifierOf(element, port.platform)
  if (expected.kind !== 'verified') return { kind: 'ok' }
  const read = await port.elements.elementAttribute(executorElement, port.platform === 'macos' ? 'identifier' : 'name', bounds)
  if (read.status !== 'answered') return { kind: 'failed', failure: port.readFailure(read, `Reading the identifier of ${describeElement(element, port.platform)} back`, signal) }
  const label = port.platform === 'ios-simulator' ? await port.elements.elementAttribute(executorElement, 'label', bounds) : undefined
  if (label !== undefined && label.status !== 'answered') return { kind: 'failed', failure: port.readFailure(label, `Reading the label of ${describeElement(element, port.platform)}`, signal) }
  const readLabel = label?.status === 'answered' ? label.value : null
  if (read.value === expected.identifier && (readLabel === null || readLabel !== expected.identifier)) return { kind: 'ok' }
  const said = typeof read.value === 'string' ? quoteText(read.value) : String(read.value)
  return {
    kind: 'refused',
    failure: { class: 'not_actionable', message: `The executor resolved an element whose identifier reads back as ${said}, not ${quoteText(expected.identifier)}, so Retest acted on nothing.`, details: { check: 'identifier' } },
  }
}

function isTrue(value: JsonValue): boolean {
  return value === true || value === 'true' || value === 1 || value === '1'
}

// The tree writes frames as the executor rounds them for XML; within half a point is the same frame.
function sameFrame(first: Rect, second: Rect): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5
  return near(first.x, second.x) && near(first.y, second.y) && near(first.width, second.width) && near(first.height, second.height)
}

function describeFrame(frame: Rect): string {
  return `${frame.x},${frame.y} ${frame.width}x${frame.height}`
}

/**
 * Describes an action for a message, as the web's do: the verb and what it is on.
 *
 * @example describeNativeAction({ verb: 'tap', enabled: true }, "getByTestId('save-task')") // "tap getByTestId('save-task')"
 */
export function describeNativeAction(needs: ActionNeeds, subject: string): string {
  return `${needs.verb} ${subject}`
}

function ambiguous(count: number, subject: string, verb: string): Failure {
  return {
    class: 'ambiguous',
    message: `Could not ${verb} ${subject}: it matches ${count} elements, and a locator must match exactly one. Retest did not ${verb} any of them.`,
    details: { count },
  }
}

function notSteadyInTime(subject: ActionSubject, needs: ActionNeeds, deadline: Deadline): Failure {
  return {
    class: 'not_actionable',
    message: `Could not ${describeNativeAction(needs, subject.describe)} within ${deadline.budgetMs} ms: too little time was left to read its frame twice ${steadyFrameGapMs} ms apart, so Retest could not see it hold still and sent nothing.`,
    details: { check: 'stable', waitedMs: deadline.budgetMs },
  }
}

function unreadyFailure(last: Unready, subject: ActionSubject, needs: ActionNeeds, deadline: Deadline, platform: NativeKind): Failure {
  const action = describeNativeAction(needs, subject.describe)
  const waitedMs = deadline.budgetMs
  if (last.status === 'timeout') return last.failure
  if (last.status === 'missing') {
    const step = last.emptyStep === undefined || subject.locator === undefined ? undefined : describeEmptyStep(subject.locator, last.emptyStep)
    const unverified = last.unverified === undefined ? '' : ` ${unverifiedSentence(last.unverified, platform)}`
    const detail = last.detail === undefined ? '' : ` ${capitalise(last.detail)}.`
    return { class: 'not_found', message: `Could not ${action}: no element matched within ${waitedMs} ms.${step === undefined ? '' : ` ${step}`}${unverified}${detail}`, details: { waitedMs } }
  }
  return {
    class: 'not_actionable',
    message: `Could not ${action} within ${waitedMs} ms: ${becauseOf[last.check]}: ${last.detail}.`,
    details: { check: last.check, waitedMs },
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/**
 * Says why elements whose `name` was the test id did not count, on iOS: WebDriverAgent writes the label there when an
 * element has no identifier, so a `name` equal to the label is not an identifier Retest can read back.
 */
export function unverifiedSentence(unverified: UnverifiedIdentifiers, platform: NativeKind): string {
  const elements = unverified.count === 1 ? '1 element has' : `${unverified.count} elements have`
  return `${elements} ${quoteText(unverified.value)} as both name and label: ${platformName(platform)}'s executor writes the label as the name of an element with no identifier, so Retest cannot read ${quoteText(unverified.value)} back as an identifier. Give the element an identifier that differs from its label.`
}
