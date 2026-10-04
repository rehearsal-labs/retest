import type { DispatchedRequest } from '../browser/contract.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { NativePort } from './actionability.ts'
import type { NativeElement, NativeTree } from './locators.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { quoteText } from '../protocol/text.ts'
import { clickTreeElement } from './input.ts'
import { attribute, isWithin, textOf } from './locators.ts'

// The iOS software keyboard. It is part of the app's own tree while it is up, as a `Keyboard` element, so Retest waits
// for it and sees it go in the tree. Retest dismisses it only by pressing its return key, once, where the field's
// return key dismisses it: WebDriverAgent's own dismiss route taps every key it matches by name until the keyboard
// hides, which can be more than one press, so Retest does not use it. On a new simulator the keyboard first shows a card
// about sliding to type; Retest names it and dismisses it through its own Continue button, resolved exactly, never with
// a tap at a point.

// The labels UIKit gives the return key, one for each return key type.
const returnKeyLabels = new Set(['return', 'done', 'go', 'search', 'send', 'next', 'join', 'route', 'continue', 'emergency call', 'google', 'yahoo'])
// The card's text, as iOS 26.5 shows it in English; another language's card is not recognised and stays named as an
// unknown element over the keyboard.
const firstRunCardText = /slide to type|sliding your finger/i
const firstRunCardButton = 'Continue'

/**
 * The software keyboard in the tree, when it is up.
 *
 * @example keyboardOf(tree)?.type // 'Keyboard'
 */
export function keyboardOf(tree: NativeTree): NativeElement | undefined {
  if (tree.platform !== 'ios-simulator') return undefined
  return tree.elements.find((element) => element.type === 'Keyboard' && attribute(element, 'visible') !== 'false' && element.frame !== undefined && element.frame.height > 0)
}

// The bar of predictions and password suggestions iOS shows above the keys, by the name UIKit gives it.
const assistantBarName = 'SystemInputAssistantView'

/**
 * The keyboard, when it lies over the centre of `element`, where a tap lands, and the element is not part of it: the
 * keys, or the bar of suggestions above them.
 */
export function coveringKeyboard(tree: NativeTree, element: NativeElement): NativeElement | undefined {
  const keyboard = keyboardOf(tree)
  const frame = element.frame
  if (keyboard === undefined || frame === undefined || isWithin(element, keyboard)) return undefined
  const bars = tree.elements.filter((each) => attribute(each, 'name') === assistantBarName && attribute(each, 'visible') === 'true')
  if (bars.some((bar) => isWithin(element, bar))) return undefined
  const x = frame.x + frame.width / 2
  const y = frame.y + frame.height / 2
  const covers = (over: NativeElement['frame']): boolean => over !== undefined && x >= over.x && x <= over.x + over.width && y >= over.y && y <= over.y + over.height
  return covers(keyboard.frame) || bars.some((bar) => covers(bar.frame)) ? keyboard : undefined
}

/** The first-run card about sliding to type: its text and its Continue button. */
export type FirstRunCard = { readonly text: string; readonly button: NativeElement }

/**
 * The first-run card about sliding to type, when the tree shows it: a Continue button beside the card's text.
 *
 * @example firstRunCardOf(tree)?.text // 'Speed up your typing by sliding your finger across the letters to compose a word.'
 */
export function firstRunCardOf(tree: NativeTree): FirstRunCard | undefined {
  if (tree.platform !== 'ios-simulator') return undefined
  const texts = tree.elements.filter((element) => element.type === 'StaticText' && firstRunCardText.test(textOf(element, tree.platform) ?? ''))
  for (const text of texts) {
    for (let container = text.parent; container !== undefined; container = container.parent) {
      const buttons = tree.elements.filter((element) => element.type === 'Button' && attribute(element, 'label') === firstRunCardButton && isWithin(element, container))
      const [button, ...others] = buttons
      if (button !== undefined && others.length === 0) return { text: textOf(text, tree.platform) ?? '', button }
      if (buttons.length > 1) break
    }
  }
  return undefined
}

/**
 * The keyboard's return key: the one key or button inside the keyboard whose identifier is `Return`, or whose label is
 * one of UIKit's return key labels. Several, or none, and Retest names that instead of guessing.
 */
export function returnKeyOf(keyboard: NativeElement, tree: NativeTree): { readonly ok: true; readonly key: NativeElement } | { readonly ok: false; readonly problem: string } {
  const keys = tree.elements.filter((element) => (element.type === 'Button' || element.type === 'Key') && isWithin(element, keyboard))
  const named = keys.filter((element) => attribute(element, 'name') === 'Return' || returnKeyLabels.has(attribute(element, 'label').toLowerCase()))
  const [key, ...others] = named
  if (key !== undefined && others.length === 0) return { ok: true, key }
  if (key === undefined) return { ok: false, problem: 'the keyboard has no return key Retest can name' }
  return { ok: false, problem: `the keyboard has ${named.length} keys that could be its return key (${named.map((each) => quoteText(attribute(each, 'label'))).join(', ')})` }
}

/** Where the keyboard stands: up or not, and whether the first-run card shows over it. */
export type KeyboardState = { readonly shown: boolean; readonly firstRunCard: boolean }

/**
 * Waits until the software keyboard is up, within the deadline. Sends no input.
 */
export async function waitForKeyboard(port: NativePort, deadline: Deadline, signal: AbortSignal): Promise<{ readonly ok: true; readonly state: KeyboardState } | { readonly ok: false; readonly failure: Failure }> {
  if (port.platform !== 'ios-simulator') return { ok: false, failure: { class: 'unsupported', message: 'A macOS app has no software keyboard.' } }
  const notUp: Failure = { class: 'not_actionable', message: `The software keyboard did not come up within ${deadline.budgetMs} ms.`, details: { check: 'keyboard', waitedMs: deadline.budgetMs } }
  for (let looks = 0; ; looks += 1) {
    const read = await port.readTree(deadline.commandTimeoutMs, signal)
    // The time ran out during a look, so the look before it is the latest answer there is.
    if (!read.ok) return read.failure.class === 'timeout' && deadline.expired && looks > 0 ? { ok: false, failure: notUp } : read
    if (keyboardOf(read.tree) !== undefined) return { ok: true, state: { shown: true, firstRunCard: firstRunCardOf(read.tree) !== undefined } }
    if (deadline.expired || signal.aborted) return { ok: false, failure: notUp }
    await sleep(Math.min(100, deadline.remainingMs), undefined, { signal }).catch(() => undefined)
  }
}

/** Reads where the keyboard stands, once. Sends no input. */
export async function readKeyboard(port: NativePort, deadline: Deadline, signal: AbortSignal): Promise<{ readonly ok: true; readonly state: KeyboardState } | { readonly ok: false; readonly failure: Failure }> {
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  if (!read.ok) return read
  return { ok: true, state: { shown: keyboardOf(read.tree) !== undefined, firstRunCard: firstRunCardOf(read.tree) !== undefined } }
}

/**
 * Dismisses the first-run card through its Continue button, once, and waits for the card to go. A tree without the
 * card sends nothing and passes.
 */
export async function dismissFirstRunCard(port: NativePort, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  if (!read.ok) return notSent(read.failure)
  const card = firstRunCardOf(read.tree)
  if (card === undefined) return { result: { ok: true }, input: 'not_sent' }
  const what = `Pressing Continue on the keyboard's first-run card about sliding to type`
  const pressed = await clickTreeElement(port, read.tree, read.reference, card.button, 'keyboard', what, deadline, signal)
  if (!pressed.ok) return { result: { ok: false, failure: pressed.failure }, input: pressed.input }
  return waitUntil(port, (tree) => firstRunCardOf(tree) === undefined, "Retest pressed Continue once on the keyboard's first-run card, and the card was still there when the time ran out. It pressed nothing more.", deadline, signal)
}

/**
 * Dismisses the software keyboard by pressing its return key once, after the first-run card if it shows, and waits for
 * the keyboard to go. A keyboard that is not up sends nothing and passes; one that stays after its return key is said,
 * since that field's return key does not dismiss it, and nothing more is pressed.
 */
export async function dismissKeyboard(port: NativePort, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  if (port.platform !== 'ios-simulator') return notSent({ class: 'unsupported', message: 'A macOS app has no software keyboard.' })
  const card = await dismissFirstRunCard(port, deadline, signal)
  if (!card.result.ok) return card
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  if (!read.ok) return { result: { ok: false, failure: read.failure }, input: card.input }
  const keyboard = keyboardOf(read.tree)
  if (keyboard === undefined) return { result: { ok: true }, input: card.input }
  const returnKey = returnKeyOf(keyboard, read.tree)
  if (!returnKey.ok) return { result: { ok: false, failure: { class: 'not_actionable', message: `Retest cannot dismiss the software keyboard: ${returnKey.problem}. It pressed nothing.`, details: { check: 'keyboard', inputSent: card.input } } }, input: card.input }
  const label = attribute(returnKey.key, 'label')
  const pressed = await clickTreeElement(port, read.tree, read.reference, returnKey.key, 'keyboard', `Pressing the keyboard's ${quoteText(label)} key`, deadline, signal)
  if (!pressed.ok) return { result: { ok: false, failure: pressed.failure }, input: pressed.input === 'not_sent' ? card.input : pressed.input }
  return waitUntil(port, (tree) => keyboardOf(tree) === undefined, `Retest pressed the keyboard's ${quoteText(label)} key once, and the keyboard was still up when the time ran out: this field's return key does not dismiss it. It pressed nothing more.`, deadline, signal)
}

async function waitUntil(port: NativePort, done: (tree: NativeTree) => boolean, stayed: string, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const failed: DispatchedRequest = { result: { ok: false, failure: { class: 'not_actionable', message: stayed, details: { check: 'keyboard', inputSent: 'sent' } } }, input: 'sent' }
  for (;;) {
    const read = await port.readTree(deadline.commandTimeoutMs, signal)
    if (!read.ok) return read.failure.class === 'timeout' && deadline.expired ? failed : { result: { ok: false, failure: { ...read.failure, details: { ...read.failure.details, inputSent: 'sent' } } }, input: 'sent' }
    if (done(read.tree)) return { result: { ok: true }, input: 'sent' }
    if (deadline.expired || signal.aborted) return failed
    await sleep(Math.min(100, deadline.remainingMs), undefined, { signal }).catch(() => undefined)
  }
}

function notSent(failure: Failure): DispatchedRequest {
  return { result: { ok: false, failure: { ...failure, details: { ...failure.details, inputSent: 'not_sent' } } }, input: 'not_sent' }
}
