import type { InputDispatch, NativeKind } from '../browser/contract.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { EmptyStep, LocatorRecipe } from '../protocol/locator.ts'
import type { NativeElement, NativeTree, ResolutionPlan, UnverifiedIdentifiers } from './locators.ts'
import type { FieldRead } from './input.ts'
import type { NativeReference } from './session.ts'
import type { ExecutorAnswer, ExecutorElements, ExecutorSession, JsonValue, Rect, RequestBounds } from './webdriver-client.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeEmptyStep, describeLocator } from '../protocol/locator.ts'
import { quoteText } from '../protocol/text.ts'
import { blockingAlert, describeAlert } from './alerts.ts'
import { coveringKeyboard } from './keyboard.ts'
import { describeElement, enabledOf, identifierOf, locate, platformName, predicateFor, resolutionPlan, visibleOf } from './locators.ts'

// Actionability for native apps: an element is acted on only when exactly one element matches in the session's own
// scoped tree, it is visible and, for an action that needs it, enabled, nothing the app shows blocks it (an alert, or on
// iOS the software keyboard over it), the executor resolves that same element with a predicate whose count equals the
// tree's, the identifier reads back from it, two reads of its frame agree, the executor calls it hittable, and on macOS
// the app is in front with no window of another process over it. Looks repeat until the action's deadline, as the web's
// do; an ambiguous match, an unsupported locator or an identifier that reads back wrong fails at once.

/** One look at the scoped tree: the tree parsed, and the reference of the observation it came from. */
export type TreeLook = { readonly ok: true; readonly tree: NativeTree; readonly reference: NativeReference } | { readonly ok: false; readonly failure: Failure }

/** What a request that went, or may have gone, records: its kind, its route, and how far it got. */
export type InputRecordDraft = { readonly kind: NativeInputKind; readonly route: string; readonly input: InputDispatch; readonly reference: NativeReference; readonly failure?: Failure }

/** The kinds of native input Retest sends. */
export type NativeInputKind = 'tap' | 'click' | 'keys' | 'clear' | 'press' | 'scroll' | 'swipe' | 'alert' | 'keyboard'

/**
 * What the interaction layer needs of a session, as `NativeInteractionSession` provides it: the scoped tree, the
 * executor routes, the macOS front check, the reference check, and somewhere to record input.
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
  /** Why a reference can no longer be acted on, as the session refuses it. */
  checkReference(reference: NativeReference): Failure | undefined
  recordInput(record: InputRecordDraft): void
  /** Told right before an input request goes, so listeners hear of it while it is in flight. */
  aboutToSend(kind: NativeInputKind, route: string, reference: NativeReference): void
  /** Notes how the field of the fill just typed read back. */
  noteReadBack(readBack: 'matched' | 'length_matched' | 'not_exposed'): void
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

type Check = 'tree' | 'visible' | 'enabled' | 'alert' | 'keyboard' | 'resolved' | 'stable' | 'hittable' | 'front'

type Unready =
  | { readonly status: 'missing'; readonly emptyStep: EmptyStep | undefined; readonly unverified: UnverifiedIdentifiers | undefined }
  | { readonly status: 'blocked'; readonly check: Check; readonly detail: string }

type Look = { readonly kind: 'settled'; readonly result: { readonly ok: true; readonly target: ActionTarget } | { readonly ok: false; readonly failure: Failure } } | { readonly kind: 'unready'; readonly unready: Unready }

const firstPauseMs = 20
const maxPauseMs = 200

// How far apart in time the two reads of an element's frame are at least: a sheet still sliding in moves within it.
const steadyFrameGapMs = 100

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
 * Looks for the one element a locator names until it passes every check or the deadline passes, then returns it with
 * the executor's id for it. More than one match, a locator the platform cannot read and an identifier that reads back
 * wrong fail at once; anything else waits, with pauses from 20 ms doubling to 200 ms, as the web's actions wait.
 *
 * @example const target = await waitUntilActionable(port, { by: 'testId', value: 'save-task' }, { verb: 'tap', enabled: true }, deadline, signal)
 */
export async function waitUntilActionable(port: NativePort, locator: LocatorRecipe, needs: ActionNeeds, deadline: Deadline, signal: AbortSignal): Promise<{ readonly ok: true; readonly target: ActionTarget } | { readonly ok: false; readonly failure: Failure }> {
  let last: Unready | undefined
  for (let attempt = 0; ; attempt += 1) {
    const looked = await look(port, locator, needs, deadline, signal, last)
    if (looked.kind === 'settled') return looked.result
    last = looked.unready
    if (deadline.expired || signal.aborted) return { ok: false, failure: unreadyFailure(last, locator, needs, deadline, port.platform) }
    await sleep(Math.min(firstPauseMs * 2 ** attempt, maxPauseMs, deadline.remainingMs), undefined, { signal }).catch(() => undefined)
    if (signal.aborted) return { ok: false, failure: unreadyFailure(last, locator, needs, deadline, port.platform) }
  }
}

async function look(port: NativePort, locator: LocatorRecipe, needs: ActionNeeds, deadline: Deadline, signal: AbortSignal, last: Unready | undefined): Promise<Look> {
  const bounds = (): RequestBounds => ({ timeoutMs: deadline.commandTimeoutMs, signal })
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  // The tree holds the first read of the element's frame; the executor's rect, at least the gap later, the second.
  const treeReadAt = performance.now()
  if (!read.ok) return settledReadFailure(read.failure, last, locator, needs, deadline, port.platform)
  const { tree, reference } = read
  const located = locate(tree, locator)
  if (!located.ok) return settled(located.failure)
  const [element, ...others] = located.matches
  if (element === undefined) return { kind: 'unready', unready: { status: 'missing', emptyStep: located.emptyStep, unverified: located.unverified } }
  if (others.length > 0) return settled(ambiguous(located.matches.length, locator, needs))
  const alert = blockingAlert(tree, element)
  if (alert !== undefined) return blocked('alert', `${describeAlert(alert, tree.platform)} is open over it`)
  if (!visibleOf(element, tree)) return blocked('visible', `${describeElement(element, tree.platform)} is not visible`)
  if (needs.enabled && !enabledOf(element)) return blocked('enabled', `${describeElement(element, tree.platform)} is disabled`)
  const keyboard = coveringKeyboard(tree, element)
  if (keyboard !== undefined) return blocked('keyboard', 'the software keyboard covers it; dismiss the keyboard first')
  const frame = element.frame
  if (frame === undefined || frame.width <= 0 || frame.height <= 0) return blocked('visible', `${describeElement(element, tree.platform)} has no frame on screen`)
  const resolved = await resolveElement(port, tree, element, bounds(), signal)
  if (resolved.kind === 'failed') return settledReadFailure(resolved.failure, last, locator, needs, deadline, port.platform)
  if (resolved.kind === 'refused') return settled(resolved.failure)
  if (resolved.kind === 'unready') return blocked('resolved', resolved.detail)
  const executorElement = resolved.element
  const identity = await readBackIdentity(port, element, executorElement, bounds(), signal)
  if (identity.kind === 'failed') return settledReadFailure(identity.failure, last, locator, needs, deadline, port.platform)
  if (identity.kind === 'refused') return settled(identity.failure)
  const pause = steadyFrameGapMs - (performance.now() - treeReadAt)
  if (pause > 0) await sleep(Math.min(pause, deadline.remainingMs), undefined, { signal }).catch(() => undefined)
  const rect = await port.elements.elementRect(executorElement, bounds())
  if (rect.status !== 'answered') return answerUnready(port, rect, `Reading the frame of ${describeElement(element, tree.platform)}`, signal, last, locator, needs, deadline)
  if (!sameFrame(rect.value, frame)) return blocked('stable', `its frame moved from ${describeFrame(frame)} to ${describeFrame(rect.value)}`)
  const hittable = await port.elements.elementAttribute(executorElement, 'hittable', bounds())
  if (hittable.status !== 'answered') return answerUnready(port, hittable, `Reading whether ${describeElement(element, tree.platform)} is hittable`, signal, last, locator, needs, deadline)
  if (!isTrue(hittable.value)) return blocked('hittable', `the executor reports ${describeElement(element, tree.platform)} is not hittable`)
  const front = await port.frontProblem(rect.value, tree.root.frame, bounds())
  // A front check the deadline cut short says less than the look before it.
  if (front !== undefined && deadline.expired && last !== undefined) return settled(unreadyFailure(last, locator, needs, deadline, port.platform))
  if (front !== undefined) return blocked('front', front)
  return settledTarget({ element, tree, reference, executorElement, frame: rect.value })
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

// The deadline ran out during a look, so the look before it is the latest answer there is; any other failure, such as a
// lost session, ends the action at once.
function settledReadFailure(failure: Failure, last: Unready | undefined, locator: LocatorRecipe, needs: ActionNeeds, deadline: Deadline, platform: NativeKind): Look {
  if (failure.class === 'timeout' && last !== undefined) return settled(unreadyFailure(last, locator, needs, deadline, platform))
  // A tree that could not be read, as just after a launch before the app shows a window, is looked at again.
  if (failure.details?.['check'] === 'tree') return blocked('tree', failure.message)
  return settled(failure)
}

async function answerUnready(port: NativePort, answer: Exclude<ExecutorAnswer<unknown>, { readonly status: 'answered' }>, what: string, signal: AbortSignal, last: Unready | undefined, locator: LocatorRecipe, needs: ActionNeeds, deadline: Deadline): Promise<Look> {
  // An element the UI replaced since it was resolved is looked for again.
  if (answer.status === 'refused' && (answer.error === 'stale element reference' || answer.error === 'no such element')) return blocked('resolved', `${what}: the element was replaced while Retest checked it`)
  return settledReadFailure(port.readFailure(answer, what, signal), last, locator, needs, deadline, port.platform)
}

type Resolution =
  | { readonly kind: 'resolved'; readonly element: string }
  | { readonly kind: 'unready'; readonly detail: string }
  | { readonly kind: 'refused'; readonly failure: Failure }
  | { readonly kind: 'failed'; readonly failure: Failure }

/**
 * Asks the executor for the element the tree showed, by the plan `resolutionPlan` makes: its own predicate, or its
 * predicate inside an ancestor the executor resolves first. The executor's count must equal the tree's at each step, or
 * the element is not taken; an element with no plan is refused by name.
 */
export async function resolveElement(port: NativePort, tree: NativeTree, element: NativeElement, bounds: RequestBounds, signal: AbortSignal): Promise<Resolution> {
  const plan = resolutionPlan(tree, element)
  if (plan === undefined) {
    return { kind: 'refused', failure: { class: 'not_actionable', message: `Retest cannot name ${describeElement(element, tree.platform)} to the executor: other elements of its type share its label and none of its ancestors sets it apart. Give it an accessibility identifier.`, details: { check: 'resolved' } } }
  }
  return resolvePlan(port, plan, element, bounds, signal)
}

async function resolvePlan(port: NativePort, plan: ResolutionPlan, element: NativeElement, bounds: RequestBounds, signal: AbortSignal): Promise<Resolution> {
  let within: string | undefined
  if (plan.within !== undefined) {
    const outer = await resolvePlan(port, plan.within, plan.within.element, bounds, signal)
    if (outer.kind !== 'resolved') return outer
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

function sameFrame(first: Rect, second: Rect): boolean {
  const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.5
  return near(first.x, second.x) && near(first.y, second.y) && near(first.width, second.width) && near(first.height, second.height)
}

function describeFrame(frame: Rect): string {
  return `${frame.x},${frame.y} ${frame.width}x${frame.height}`
}

/**
 * Describes an action for a message, as the web's do: the verb and the locator.
 *
 * @example describeNativeAction({ verb: 'tap', enabled: true }, { by: 'testId', value: 'save-task' }) // "tap getByTestId('save-task')"
 */
export function describeNativeAction(needs: ActionNeeds, locator: LocatorRecipe): string {
  return `${needs.verb} ${describeLocator(locator)}`
}

function ambiguous(count: number, locator: LocatorRecipe, needs: ActionNeeds): Failure {
  return {
    class: 'ambiguous',
    message: `Could not ${describeNativeAction(needs, locator)}: it matches ${count} elements, and a locator must match exactly one. Retest did not ${needs.verb} any of them.`,
    details: { count },
  }
}

function unreadyFailure(last: Unready, locator: LocatorRecipe, needs: ActionNeeds, deadline: Deadline, platform: NativeKind): Failure {
  const action = describeNativeAction(needs, locator)
  const waitedMs = deadline.budgetMs
  if (last.status === 'missing') {
    const step = last.emptyStep === undefined ? undefined : describeEmptyStep(locator, last.emptyStep)
    const unverified = last.unverified === undefined ? '' : ` ${unverifiedSentence(last.unverified, platform)}`
    return { class: 'not_found', message: `Could not ${action}: no element matched within ${waitedMs} ms.${step === undefined ? '' : ` ${step}`}${unverified}`, details: { waitedMs } }
  }
  return {
    class: 'not_actionable',
    message: `Could not ${action} within ${waitedMs} ms: ${becauseOf[last.check]}: ${last.detail}.`,
    details: { check: last.check, waitedMs },
  }
}

/**
 * Says why elements whose `name` was the test id did not count, on iOS: WebDriverAgent writes the label there when an
 * element has no identifier, so a `name` equal to the label is not an identifier Retest can read back.
 */
export function unverifiedSentence(unverified: UnverifiedIdentifiers, platform: NativeKind): string {
  const elements = unverified.count === 1 ? '1 element has' : `${unverified.count} elements have`
  return `${elements} ${quoteText(unverified.value)} as both name and label: ${platformName(platform)}'s executor writes the label as the name of an element with no identifier, so Retest cannot read ${quoteText(unverified.value)} back as an identifier. Give the element an identifier that differs from its label.`
}
