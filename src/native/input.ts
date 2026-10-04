import type { DispatchedRequest, InputDispatch, NativeKind } from '../browser/contract.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Key } from '../protocol/keys.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { ActionNeeds, ActionTarget, NativeInputKind, NativePort } from './actionability.ts'
import type { NativeElement, NativeTree } from './locators.ts'
import type { NativeReference } from './session.ts'
import type { ExecutorAnswer, JsonValue, MacKey, Rect, RequestBounds } from './webdriver-client.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { parseKey } from '../protocol/keys.ts'
import { describeLocator } from '../protocol/locator.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { quoteText } from '../protocol/text.ts'
import { readBackIdentity, resolveElement, waitUntilActionable } from './actionability.ts'
import { keyboardOf } from './keyboard.ts'
import { describeElement, fieldTypes, platformName } from './locators.ts'
import { inputDispatch } from './webdriver-client.ts'

// Native input, sent once through the exact routes: one `/element/:id/click` for an iOS tap or a macOS click, the
// macOS runner's `/wda/keys` (each item one XCTest key press with its modifier flags) or WebDriverAgent's `/wda/keys`
// (one synthesized typing of the text given) for keys, and W3C `/actions` with exactly the points given for an iOS
// scroll or swipe; a macOS scroll is the runner's one XCTest scroll over the element. `fill` is Retest's own: one click
// to focus, a clear sent once (macOS: Command-A and Delete; iOS: one backspace and forward delete per character it
// read, since WebDriverAgent's keys take text and no modifier), a read-back that must show the field empty, the text
// sent once, and a read-back of the value. No input is sent twice, and `/value` and `/clear` are never called: both
// executors type, read back and type again inside them.

/** What a native action does: tap, click, fill, press a key, scroll or swipe. */
export type NativeAction =
  | { readonly kind: 'tap' | 'click'; readonly locator: LocatorRecipe }
  | { readonly kind: 'fill'; readonly locator: LocatorRecipe; readonly text: string; readonly secret?: string }
  | { readonly kind: 'press'; readonly locator?: LocatorRecipe; readonly key: string }
  | { readonly kind: 'scroll'; readonly locator?: LocatorRecipe; readonly x: number; readonly y: number }
  | { readonly kind: 'swipe'; readonly locator?: LocatorRecipe; readonly direction: 'up' | 'down' | 'left' | 'right' }

/** XCTest's modifier flags, as the macOS runner's `/wda/keys` takes them. */
export const modifierFlags: Readonly<Record<'Shift' | 'Control' | 'Alt' | 'Meta' | 'ControlOrMeta', number>> = { Shift: 1 << 1, Control: 1 << 2, Alt: 1 << 3, Meta: 1 << 4, ControlOrMeta: 1 << 4 }

/** The XCTest key a named key presses on macOS. */
export const macosNamedKeys: Readonly<Record<string, string>> = {
  Enter: 'XCUIKeyboardKeyReturn',
  Tab: 'XCUIKeyboardKeyTab',
  Escape: 'XCUIKeyboardKeyEscape',
  Backspace: 'XCUIKeyboardKeyDelete',
  Delete: 'XCUIKeyboardKeyForwardDelete',
  Space: 'XCUIKeyboardKeySpace',
  ArrowUp: 'XCUIKeyboardKeyUpArrow',
  ArrowDown: 'XCUIKeyboardKeyDownArrow',
  ArrowLeft: 'XCUIKeyboardKeyLeftArrow',
  ArrowRight: 'XCUIKeyboardKeyRightArrow',
  Home: 'XCUIKeyboardKeyHome',
  End: 'XCUIKeyboardKeyEnd',
  PageUp: 'XCUIKeyboardKeyPageUp',
  PageDown: 'XCUIKeyboardKeyPageDown',
}

/** The text a named key types on iOS, where WebDriverAgent's keys take text; the keys absent here have none. */
export const iosNamedKeys: Readonly<Record<string, string>> = { Enter: '\n', Tab: '\t', Backspace: '\b', Space: ' ' }

/** What macOS's clear sends: Command-A selects the field's text, and Delete removes it. */
export const macosClearKeys: readonly MacKey[] = [{ key: 'a', modifierFlags: modifierFlags.Meta }, 'XCUIKeyboardKeyDelete']

/** What iOS's clear types for each character it read: a backspace, and a forward delete for text after the caret. */
export const iosClearPair = '\b\u007f'

// The masking characters a secure field reads back as: iOS writes U+2022, and AppKit, while the field is being edited,
// U+F79A from its private use area; once editing ends AppKit reads back nothing at all.
const bullet = /^[\u2022\uf79a]*$/u
// How long a fill on iOS looks for the software keyboard after its tap before it types anyway: XCTest types through
// the text input path, which a hardware keyboard takes too.
const keyboardWaitMs = 2000

/**
 * Performs one native action within the deadline: waits for its element as `waitUntilActionable` does, then sends its
 * input once. The answer says how far the input got; a failure after input went says so and nothing is sent again.
 */
export async function performAction(port: NativePort, action: NativeAction, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const platformProblem = actionPlatformProblem(action, port.platform)
  if (platformProblem !== undefined) return notSent(platformProblem)
  switch (action.kind) {
    case 'tap':
    case 'click':
      return tapOrClick(port, action.kind, action.locator, deadline, signal)
    case 'fill':
      return fill(port, action, deadline, signal)
    case 'press':
      return press(port, action, deadline, signal)
    case 'scroll':
      return scroll(port, action, deadline, signal)
    case 'swipe':
      return swipe(port, action, deadline, signal)
  }
}

function actionPlatformProblem(action: NativeAction, platform: NativeKind): Failure | undefined {
  if (action.kind === 'tap' && platform === 'macos') return { class: 'unsupported', message: 'A macOS app has no touch screen. Use click().' }
  if (action.kind === 'click' && platform === 'ios-simulator') return { class: 'unsupported', message: 'An iOS app takes taps. Use tap().' }
  if (action.kind === 'swipe' && platform === 'macos') return { class: 'unsupported', message: 'A macOS app takes no swipe in Retest. Scroll it instead.' }
  if (action.kind === 'scroll' && (!Number.isFinite(action.x) || !Number.isFinite(action.y) || (action.x === 0 && action.y === 0))) {
    return { class: 'usage', message: `scroll() takes x and y in points, at least one of them not 0, received x ${action.x} and y ${action.y}.` }
  }
  return undefined
}

async function tapOrClick(port: NativePort, verb: 'tap' | 'click', locator: LocatorRecipe, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const needs = { verb, enabled: true }
  const ready = await waitUntilActionable(port, locator, needs, deadline, signal)
  if (!ready.ok) return notSent(ready.failure)
  const sent = await clickOnce(port, ready.target, verb, `${verb === 'tap' ? 'Tapping' : 'Clicking'} ${describeLocator(locator)}`, deadline, signal)
  return sent.ok ? { result: { ok: true }, input: 'sent' } : { result: { ok: false, failure: sent.failure }, input: sent.input }
}

/** How one request that sends input went: answered, or the failure with how far it got. */
export type SentInput = { readonly ok: true } | { readonly ok: false; readonly failure: Failure; readonly input: InputDispatch }

/**
 * Clicks or taps a target once through `/element/:id/click`, after checking its observation is still current. Records
 * the request whenever it may have gone.
 */
export function clickOnce(port: NativePort, target: Pick<ActionTarget, 'executorElement' | 'reference'>, kind: NativeInputKind, what: string, deadline: Deadline, signal: AbortSignal): Promise<SentInput> {
  return sendOnce(port, { kind, route: 'POST /session/:session/element/:element/click', reference: target.reference, what }, () => port.executor.click(target.executorElement, bounds(deadline, signal)), signal)
}

/**
 * Clicks one element of a tree the caller has just read, once: resolved exactly on the executor, its identifier read
 * back, its observation current. For the buttons the keyboard and alerts press, which need no wait of their own.
 */
export async function clickTreeElement(port: NativePort, tree: NativeTree, reference: NativeReference, element: NativeElement, kind: NativeInputKind, what: string, deadline: Deadline, signal: AbortSignal): Promise<SentInput> {
  const resolved = await resolveElement(port, tree, element, bounds(deadline, signal), signal)
  if (resolved.kind === 'failed' || resolved.kind === 'refused') return { ok: false, failure: resolved.failure, input: 'not_sent' }
  if (resolved.kind === 'unready') return { ok: false, failure: { class: 'not_actionable', message: `${what}: ${resolved.detail}. Retest pressed nothing.` }, input: 'not_sent' }
  const identity = await readBackIdentity(port, element, resolved.element, bounds(deadline, signal), signal)
  if (identity.kind !== 'ok') return { ok: false, failure: identity.failure, input: 'not_sent' }
  return clickOnce(port, { executorElement: resolved.element, reference }, kind, what, deadline, signal)
}

type SendPlan = { readonly kind: NativeInputKind; readonly route: string; readonly reference: NativeReference; readonly what: string }

// Sends one request that acts, once. A stale observation sends nothing; an answer that did not come back is recorded
// with how far it got, so an unknown outcome reaches the ledger and is never sent again.
async function sendOnce(port: NativePort, plan: SendPlan, send: () => Promise<ExecutorAnswer<JsonValue>>, signal: AbortSignal): Promise<SentInput> {
  const stale = port.checkReference(plan.reference)
  if (stale !== undefined) return { ok: false, failure: { ...stale, details: { ...stale.details, inputSent: 'not_sent' } }, input: 'not_sent' }
  port.aboutToSend(plan.kind, plan.route, plan.reference)
  const answer = await send()
  const input = inputDispatch(answer)
  if (answer.status === 'answered') {
    port.recordInput({ kind: plan.kind, route: plan.route, input, reference: plan.reference })
    return { ok: true }
  }
  const failure = port.readFailure(answer, plan.what, signal, true)
  const withInput: Failure = { ...failure, details: { ...failure.details, inputSent: input } }
  port.recordInput({ kind: plan.kind, route: plan.route, input, reference: plan.reference, failure: withInput })
  return { ok: false, failure: withInput, input }
}

async function fill(port: NativePort, action: Extract<NativeAction, { kind: 'fill' }>, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const verb = port.platform === 'macos' ? 'click' : 'tap'
  const shown = action.secret === undefined ? quoteText(action.text) : secretPlaceholder(action.secret)
  const needs: ActionNeeds = { verb: `fill`, enabled: true }
  const ready = await waitUntilActionable(port, action.locator, needs, deadline, signal)
  if (!ready.ok) return notSent(ready.failure)
  const { element } = ready.target
  const field = fieldProblem(element, action, shown, port.platform)
  if (field !== undefined) return notSent(field)
  const focused = await clickOnce(port, ready.target, verb, `Focusing ${describeLocator(action.locator)} to fill it`, deadline, signal)
  if (!focused.ok) return { result: { ok: false, failure: focused.failure }, input: focused.input }
  if (port.platform === 'ios-simulator') await waitForKeyboardBriefly(port, deadline, signal)
  const before = await readField(port, action.locator, deadline, signal)
  if (!before.ok) return sentFailure(before.failure)
  if (port.platform === 'macos') {
    const focus = await port.elements.elementAttribute(ready.target.executorElement, 'focused', bounds(deadline, signal))
    if (focus.status !== 'answered') return sentFailure(port.readFailure(focus, `Reading whether ${describeLocator(action.locator)} took the keyboard focus`, signal))
    if (focus.value !== 'true' && focus.value !== true) return sentFailure({ class: 'not_actionable', message: `Could not fill ${describeLocator(action.locator)}: Retest clicked it once and it did not take the keyboard focus, so Retest typed nothing.`, details: { check: 'focused' } })
  }
  // A macOS secure field that is not being edited reads as empty whatever it holds, so it is cleared every time, and a
  // read-back that shows nothing is said rather than counted.
  const hidden = port.platform === 'macos' && element.type === 'SecureTextField'
  const length = [...before.value].length
  if (hidden || length > 0) {
    const cleared = await sendClear(port, before.reference, length, `Clearing ${describeLocator(action.locator)}`, deadline, signal)
    if (!cleared.ok) return { result: { ok: false, failure: cleared.failure }, input: worst('sent', cleared.input) }
    const empty = await readField(port, action.locator, deadline, signal)
    if (!empty.ok) return sentFailure(empty.failure)
    if (empty.value !== '') return sentFailure({ class: 'not_actionable', message: `Could not fill ${describeLocator(action.locator)}: after Retest cleared it once, it still holds ${[...empty.value].length} character(s), so Retest typed nothing.`, details: { check: 'cleared' } })
  }
  const typed = await sendText(port, before.reference, action.text, `Typing ${shown} into ${describeLocator(action.locator)}`, deadline, signal)
  if (!typed.ok) return { result: { ok: false, failure: typed.failure }, input: worst('sent', typed.input) }
  const after = await readField(port, action.locator, deadline, signal)
  if (!after.ok) return sentFailure(after.failure)
  if (hidden && after.value === '') {
    port.noteReadBack('not_exposed')
    return { result: { ok: true }, input: 'sent' }
  }
  const mismatch = readBackProblem(after.value, action.text, after.element, action, shown, port.platform)
  if (mismatch !== undefined) return sentFailure(mismatch)
  port.noteReadBack(after.element.type === 'SecureTextField' ? 'length_matched' : 'matched')
  return { result: { ok: true }, input: 'sent' }
}

function fieldProblem(element: NativeElement, action: Extract<NativeAction, { kind: 'fill' }>, shown: string, platform: NativeKind): Failure | undefined {
  if (!fieldTypes.has(element.type)) return { class: 'unsupported', message: `Could not fill ${describeLocator(action.locator)}: it is ${describeElement(element, platform)}, and fill takes a text field, a secure field, a search field or a text view.`, details: { field: element.type } }
  if (element.type !== 'TextView' && /[\n\r]/.test(action.text)) return { class: 'unsupported', message: `Could not fill ${describeLocator(action.locator)} with ${shown}: it is a ${element.type}, which holds one line. Use a text view for text with \\n or \\r.`, details: { field: element.type } }
  return undefined
}

// A read-back of a secure field shows one bullet per character, never the characters, so only the count is compared and
// nothing of what it shows reaches a message.
function readBackProblem(value: string, text: string, element: NativeElement, action: Extract<NativeAction, { kind: 'fill' }>, shown: string, platform: NativeKind): Failure | undefined {
  const locator = describeLocator(action.locator)
  if (element.type === 'SecureTextField') {
    const expected = [...text].length
    const read = [...value].length
    if (bullet.test(value) && read === expected) return undefined
    if (!bullet.test(value)) return { class: 'not_actionable', message: `Filled ${locator} with ${shown} once, and the secure field reads back as something other than bullets, so Retest cannot tell what it holds. It typed nothing more.`, details: { check: 'read-back' } }
    return { class: 'not_actionable', message: `Filled ${locator} with ${shown} once, and the secure field shows ${read} character(s) where ${expected} were typed. Retest typed nothing more.`, details: { check: 'read-back' } }
  }
  if (value === text) return undefined
  if (action.secret !== undefined) return { class: 'not_actionable', message: `Filled ${locator} with ${shown} once, and the field reads back as other text. Retest typed nothing more.`, details: { check: 'read-back' } }
  return { class: 'not_actionable', message: `Filled ${locator} with ${shown} once, and the ${platformName(platform)} field reads back as ${quoteText(value)}. Retest typed nothing more.`, details: { check: 'read-back' } }
}

/** A private fill read-back. The tree remains redacted; this value never leaves the input implementation. */
export type FieldRead = { readonly ok: true; readonly value: string; readonly element: NativeElement; readonly reference: NativeReference } | { readonly ok: false; readonly failure: Failure }

async function readField(port: NativePort, locator: LocatorRecipe, deadline: Deadline, signal: AbortSignal): Promise<FieldRead> {
  for (;;) {
    const read = await port.readField(locator, deadline.commandTimeoutMs, signal)
    if (read.ok || read.failure.details?.['check'] !== 'tree' || deadline.expired || signal.aborted) return read
    await sleep(Math.min(100, deadline.remainingMs), undefined, { signal }).catch(() => undefined)
  }
}

async function waitForKeyboardBriefly(port: NativePort, deadline: Deadline, signal: AbortSignal): Promise<void> {
  const until = performance.now() + Math.min(keyboardWaitMs, deadline.remainingMs)
  while (performance.now() < until && !signal.aborted) {
    const read = await port.readTree(deadline.commandTimeoutMs, signal)
    if (!read.ok || keyboardOf(read.tree) !== undefined) return
    await sleep(100, undefined, { signal }).catch(() => undefined)
  }
}

function sendClear(port: NativePort, reference: NativeReference, characters: number, what: string, deadline: Deadline, signal: AbortSignal): Promise<SentInput> {
  if (port.platform === 'macos') return sendOnce(port, { kind: 'clear', route: 'POST /session/:session/wda/keys', reference, what }, () => port.executor.pressKeys(macosClearKeys, bounds(deadline, signal)), signal)
  return sendOnce(port, { kind: 'clear', route: 'POST /session/:session/wda/keys', reference, what }, () => port.executor.typeText(iosClearPair.repeat(characters), bounds(deadline, signal)), signal)
}

function sendText(port: NativePort, reference: NativeReference, text: string, what: string, deadline: Deadline, signal: AbortSignal): Promise<SentInput> {
  if (port.platform === 'macos') return sendOnce(port, { kind: 'keys', route: 'POST /session/:session/wda/keys', reference, what }, () => port.executor.pressKeys(macosKeysForText(text), bounds(deadline, signal)), signal)
  return sendOnce(port, { kind: 'keys', route: 'POST /session/:session/wda/keys', reference, what }, () => port.executor.typeText(text, bounds(deadline, signal)), signal)
}

// The macOS runner's key presses that type a text: each character its own key, an uppercase letter as its lowercase
// key with Shift, as the runner types a capital, and a line break as Return.
function macosKeysForText(text: string): MacKey[] {
  return [...text].map((character) => {
    if (character === '\n' || character === '\r') return 'XCUIKeyboardKeyReturn'
    const lower = character.toLowerCase()
    return /^\p{Lu}$/u.test(character) && lower !== character ? { key: lower, modifierFlags: modifierFlags.Shift } : character
  })
}

async function press(port: NativePort, action: Extract<NativeAction, { kind: 'press' }>, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const parsed = parseKey(action.key)
  if (!parsed.ok) return notSent(parsed.failure)
  const keys = keysFor(parsed.key, port.platform, action.key)
  if (!keys.ok) return notSent(keys.failure)
  let reference: NativeReference
  let input: InputDispatch = 'not_sent'
  if (action.locator === undefined) {
    const read = await port.readTree(deadline.commandTimeoutMs, signal)
    if (!read.ok) return notSent(read.failure)
    reference = read.reference
  } else {
    const ready = await waitUntilActionable(port, action.locator, { verb: `press ${action.key} on`, enabled: true }, deadline, signal)
    if (!ready.ok) return notSent(ready.failure)
    const focus = await focusForPress(port, ready.target, action.locator, deadline, signal)
    if (!focus.ok) return { result: { ok: false, failure: focus.failure }, input: focus.input }
    input = focus.input
    reference = ready.target.reference
  }
  const what = `Pressing ${action.key}${action.locator === undefined ? '' : ` on ${describeLocator(action.locator)}`}`
  const sent = keys.platform === 'macos'
    ? await sendOnce(port, { kind: 'press', route: 'POST /session/:session/wda/keys', reference, what }, () => port.executor.pressKeys(keys.keys, bounds(deadline, signal)), signal)
    : await sendOnce(port, { kind: 'press', route: 'POST /session/:session/wda/keys', reference, what }, () => port.executor.typeText(keys.text, bounds(deadline, signal)), signal)
  if (!sent.ok) return { result: { ok: false, failure: sent.failure }, input: worst(input, sent.input) }
  return { result: { ok: true }, input: 'sent' }
}

// A key goes to whatever holds the keyboard focus. A field that lacks it is clicked once first; any other element is
// pressed on only while it already holds the focus, since clicking a button to focus it would press the button.
async function focusForPress(port: NativePort, target: ActionTarget, locator: LocatorRecipe, deadline: Deadline, signal: AbortSignal): Promise<{ readonly ok: true; readonly input: InputDispatch } | { readonly ok: false; readonly failure: Failure; readonly input: InputDispatch }> {
  const focus = await port.elements.elementAttribute(target.executorElement, 'focused', bounds(deadline, signal))
  if (focus.status !== 'answered') return { ok: false, failure: port.readFailure(focus, `Reading whether ${describeLocator(locator)} holds the keyboard focus`, signal), input: 'not_sent' }
  if (focus.value === true || focus.value === 'true') return { ok: true, input: 'not_sent' }
  if (!fieldTypes.has(target.element.type)) {
    return { ok: false, failure: { class: 'unsupported', message: `Could not press a key on ${describeLocator(locator)}: it is ${describeElement(target.element, port.platform)} without the keyboard focus, and Retest gives a native element the focus only by clicking a field. Press the key without a locator, or on the field that should take it.` }, input: 'not_sent' }
  }
  const clicked = await clickOnce(port, target, port.platform === 'macos' ? 'click' : 'tap', `Focusing ${describeLocator(locator)} to press a key on it`, deadline, signal)
  if (!clicked.ok) return clicked
  const focused = await port.elements.elementAttribute(target.executorElement, 'focused', bounds(deadline, signal))
  if (focused.status !== 'answered') return { ok: false, failure: port.readFailure(focused, `Reading whether ${describeLocator(locator)} took the keyboard focus`, signal), input: 'sent' }
  if (focused.value !== true && focused.value !== 'true') return { ok: false, failure: { class: 'not_actionable', message: `Retest clicked ${describeLocator(locator)} once and could not confirm its keyboard focus, so it sent no key.`, details: { check: 'focused' } }, input: 'sent' }
  return { ok: true, input: 'sent' }
}

type PlatformKeys = { readonly ok: true; readonly platform: 'macos'; readonly keys: readonly MacKey[] } | { readonly ok: true; readonly platform: 'ios-simulator'; readonly text: string } | { readonly ok: false; readonly failure: Failure }

// What a parsed key sends on a platform: on macOS one runner key press with its modifier flags, on iOS the text the key
// types, for the keys and characters iOS's typing route can send. A chord on iOS is refused by name: WebDriverAgent's
// keys take text, with no modifier.
function keysFor(key: Key, platform: NativeKind, written: string): PlatformKeys {
  if (platform === 'macos') {
    const flags = key.held.reduce((sum, modifier) => sum | modifierFlags[modifier], key.kind === 'character' && key.shift ? modifierFlags.Shift : 0)
    const name = key.kind === 'named' ? macosNamedKeys[key.name] : key.shift ? key.character.toLowerCase() : key.character
    if (name === undefined) return { ok: false, failure: { class: 'unsupported', message: `press() cannot send ${quoteText(written)} to a macOS app.` } }
    return { ok: true, platform, keys: [flags === 0 ? name : { key: name, modifierFlags: flags }] }
  }
  if (key.held.length > 0) return { ok: false, failure: { class: 'unsupported', message: `press() cannot send ${quoteText(written)} to an iOS app: WebDriverAgent's typing route takes text and holds no modifier key.` } }
  if (key.kind === 'character') return { ok: true, platform, text: key.character }
  const text = iosNamedKeys[key.name]
  if (text === undefined) return { ok: false, failure: { class: 'unsupported', message: `press() cannot send ${quoteText(written)} to an iOS app: WebDriverAgent's typing route types text, and ${key.name} types none. It takes Enter, Tab, Backspace, Space and single characters.` } }
  return { ok: true, platform, text }
}

async function scroll(port: NativePort, action: Extract<NativeAction, { kind: 'scroll' }>, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const area = await areaFor(port, action.locator, 'scroll', deadline, signal)
  if (!area.ok) return notSent(area.failure)
  const what = `Scrolling ${action.locator === undefined ? 'the app' : describeLocator(action.locator)} by x ${action.x} and y ${action.y}`
  if (port.platform === 'macos') {
    if (area.executorElement === undefined) return notSent({ class: 'not_actionable', message: `${what}: Retest could not resolve the window to scroll over.` })
    const element = area.executorElement
    // XCTest scrolls by wheel deltas, which move the content the other way from the page offset a test asks for.
    const sent = await sendOnce(port, { kind: 'scroll', route: 'POST /session/:session/wda/element/:element/scroll', reference: area.reference, what }, () => port.elements.scrollElement(element, { x: -action.x, y: -action.y }, bounds(deadline, signal)), signal)
    return sent.ok ? { result: { ok: true }, input: 'sent' } : { result: { ok: false, failure: sent.failure }, input: sent.input }
  }
  const from = centre(area.frame)
  const to = { x: from.x - action.x, y: from.y - action.y }
  if (!inside(to, area.frame)) {
    return notSent({ class: 'usage', message: `${what}: a scroll on iOS is a drag inside the element, and this one would leave it. Scroll by at most ${Math.floor(area.frame.width / 2)} points across and ${Math.floor(area.frame.height / 2)} down or up.` })
  }
  return dragOnce(port, area.reference, { from, to, holdMs: 200 }, 'scroll', what, deadline, signal)
}

async function swipe(port: NativePort, action: Extract<NativeAction, { kind: 'swipe' }>, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const area = await areaFor(port, action.locator, 'swipe', deadline, signal)
  if (!area.ok) return notSent(area.failure)
  const from = centre(area.frame)
  const reach = { up: { x: 0, y: -area.frame.height / 3 }, down: { x: 0, y: area.frame.height / 3 }, left: { x: -area.frame.width / 3, y: 0 }, right: { x: area.frame.width / 3, y: 0 } }[action.direction]
  const to = { x: Math.round(from.x + reach.x), y: Math.round(from.y + reach.y) }
  const what = `Swiping ${action.direction} on ${action.locator === undefined ? 'the app' : describeLocator(action.locator)}`
  return dragOnce(port, area.reference, { from, to, holdMs: 0 }, 'swipe', what, deadline, signal)
}

type Area = { readonly ok: true; readonly frame: Rect; readonly reference: NativeReference; readonly executorElement?: string } | { readonly ok: false; readonly failure: Failure }

// Where a scroll or swipe goes: the element a locator finds, ready as any action's element, or without one the owned
// window on macOS and the app on iOS, from the tree's root.
async function areaFor(port: NativePort, locator: LocatorRecipe | undefined, verb: string, deadline: Deadline, signal: AbortSignal): Promise<Area> {
  if (locator !== undefined) {
    const ready = await waitUntilActionable(port, locator, { verb, enabled: false }, deadline, signal)
    if (!ready.ok) return ready
    return { ok: true, frame: ready.target.frame, reference: ready.target.reference, executorElement: ready.target.executorElement }
  }
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  if (!read.ok) return read
  const root = read.tree.platform === 'ios-simulator' ? (read.tree.root.children.find((child) => child.type === 'Window') ?? read.tree.root) : read.tree.root
  const frame = root.frame
  if (frame === undefined) return { ok: false, failure: { class: 'not_actionable', message: `Could not ${verb} the app: its ${root.type} has no frame in the tree.` } }
  if (port.platform === 'ios-simulator') return { ok: true, frame, reference: read.reference }
  const resolved = await resolveElement(port, read.tree, root, bounds(deadline, signal), signal)
  if (resolved.kind !== 'resolved') return { ok: false, failure: resolved.kind === 'unready' ? { class: 'not_actionable', message: `Could not ${verb} the app: ${resolved.detail}.` } : resolved.failure }
  return { ok: true, frame, reference: read.reference, executorElement: resolved.element }
}

type Drag = { readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number }; readonly holdMs: number }

// The W3C touch actions for one drag through exactly these points: down at `from`, a move to `to` over 600 ms, a hold
// of `holdMs` there so a scroll does not fling on, and up.
function dragActions(drag: Drag): JsonValue[] {
  const steps: JsonValue[] = [
    { type: 'pointerMove', duration: 0, x: drag.from.x, y: drag.from.y },
    { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 600, x: drag.to.x, y: drag.to.y },
    ...(drag.holdMs > 0 ? [{ type: 'pause', duration: drag.holdMs }] : []),
    { type: 'pointerUp', button: 0 },
  ]
  return [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: steps }]
}

async function dragOnce(port: NativePort, reference: NativeReference, drag: Drag, kind: NativeInputKind, what: string, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const sent = await sendOnce(port, { kind, route: 'POST /session/:session/actions', reference, what }, () => port.executor.performActions(dragActions(drag), bounds(deadline, signal)), signal)
  return sent.ok ? { result: { ok: true }, input: 'sent' } : { result: { ok: false, failure: sent.failure }, input: sent.input }
}

function centre(frame: Rect): { readonly x: number; readonly y: number } {
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) }
}

function inside(point: { readonly x: number; readonly y: number }, frame: Rect): boolean {
  return point.x >= frame.x && point.x <= frame.x + frame.width && point.y >= frame.y && point.y <= frame.y + frame.height
}

function bounds(deadline: Deadline, signal: AbortSignal): RequestBounds {
  return { timeoutMs: deadline.commandTimeoutMs, signal }
}

function notSent(failure: Failure): DispatchedRequest {
  return { result: { ok: false, failure: { ...failure, details: { ...failure.details, inputSent: 'not_sent' } } }, input: 'not_sent' }
}

function sentFailure(failure: Failure): DispatchedRequest {
  return { result: { ok: false, failure: { ...failure, details: { ...failure.details, inputSent: 'sent' } } }, input: 'sent' }
}

// The furthest of two dispatch states: unknown over sent over not sent.
function worst(first: InputDispatch, second: InputDispatch): InputDispatch {
  if (first === 'unknown' || second === 'unknown') return 'unknown'
  return first === 'sent' || second === 'sent' ? 'sent' : 'not_sent'
}
