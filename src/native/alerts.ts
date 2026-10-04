import type { DispatchedRequest, NativeKind } from '../browser/contract.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { NativePort } from './actionability.ts'
import type { NativeElement, NativeTree } from './locators.ts'
import type { NativeReference } from './session.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { quoteText } from '../protocol/text.ts'
import { clickTreeElement } from './input.ts'
import { isWithin, nameOf, textOf } from './locators.ts'
import { inputDispatch } from './webdriver-client.ts'

// Basic app alerts and dialogs. An alert the app shows is part of its own tree: on iOS an `Alert` element, on macOS an
// `Alert`, a `Sheet` or a `Dialog` inside the owned window. An action on anything outside the alert while it is open is
// blocked and fails naming the alert; Retest never taps through one. Answering an alert presses one named button once:
// on iOS through WebDriverAgent's alert routes, after its button list shows exactly one button with that label, and on
// macOS, whose runner has no alert routes, by clicking that button, resolved exactly as any element is.

const alertTypes: Readonly<Record<NativeKind, ReadonlySet<string>>> = { 'ios-simulator': new Set(['Alert']), macos: new Set(['Alert', 'Sheet', 'Dialog']) }

/** An alert in the app's tree: the element, its text, and its buttons in tree order. */
export type NativeAlert = { readonly element: NativeElement; readonly text: string; readonly buttons: readonly NativeElement[] }

/**
 * The alerts the app shows in its scoped tree, outermost first.
 *
 * @example alertsOf(tree)[0]?.text // 'Delete this task?'
 */
export function alertsOf(tree: NativeTree): NativeAlert[] {
  const types = alertTypes[tree.platform]
  const found = tree.elements.filter((element) => types.has(element.type) && !hasAlertAncestor(element, types))
  return found.map((element) => {
    const inside = tree.elements.filter((each) => each !== element && isWithin(each, element))
    const text = inside.filter((each) => each.type === 'StaticText').map((each) => textOf(each, tree.platform) ?? '').filter((each) => each !== '').join('\n')
    return { element, text, buttons: inside.filter((each) => each.type === 'Button') }
  })
}

function hasAlertAncestor(element: NativeElement, types: ReadonlySet<string>): boolean {
  for (let ancestor = element.parent; ancestor !== undefined; ancestor = ancestor.parent) if (types.has(ancestor.type)) return true
  return false
}

/** The alert that blocks an action on `element`: one that is open while the element lies outside it. */
export function blockingAlert(tree: NativeTree, element: NativeElement): NativeAlert | undefined {
  return alertsOf(tree).find((alert) => !isWithin(element, alert.element))
}

/**
 * Names an alert for a message by its type, its first line of text and its buttons.
 *
 * @example describeAlert(alert, 'ios-simulator') // "the Alert \"Delete this task?\" with buttons \"Cancel\", \"Delete\""
 */
export function describeAlert(alert: NativeAlert, platform: NativeKind): string {
  const title = alert.text.split('\n')[0] ?? ''
  const buttons = alert.buttons.map((button) => quoteText(nameOf(button, platform))).join(', ')
  return `the ${alert.element.type}${title === '' ? '' : ` ${quoteText(title)}`}${buttons === '' ? '' : ` with buttons ${buttons}`}`
}

/** An alert as Retest reads it for a test: its text and button labels, from the app's tree or, on iOS, WebDriverAgent's alert routes. */
export type AlertReading = { readonly open: false } | { readonly open: true; readonly source: 'tree' | 'executor'; readonly text: string; readonly buttons: readonly string[] }

/**
 * Reads the alert in front. The app's own alerts come from its tree; on iOS, when the tree holds none, WebDriverAgent's
 * alert routes are asked as well, since a system alert over the app is not part of the app's tree. Sends no input.
 */
export async function readAlert(port: NativePort, deadline: Deadline, signal: AbortSignal, redact: (text: string) => string): Promise<{ readonly ok: true; readonly alert: AlertReading } | { readonly ok: false; readonly failure: Failure }> {
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  if (!read.ok) return read
  const [alert] = alertsOf(read.tree)
  if (alert !== undefined) return { ok: true, alert: { open: true, source: 'tree', text: redact(alert.text), buttons: alert.buttons.map((button) => redact(nameOf(button, read.tree.platform))) } }
  if (port.platform !== 'ios-simulator') return { ok: true, alert: { open: false } }
  const bounds = { timeoutMs: deadline.commandTimeoutMs, signal }
  const text = await port.elements.alertText(bounds)
  if (text.status === 'refused' && text.error === 'no such alert') return { ok: true, alert: { open: false } }
  if (text.status !== 'answered') return { ok: false, failure: port.readFailure(text, "Reading the alert's text", signal) }
  const buttons = await port.elements.alertButtons(bounds)
  if (buttons.status === 'refused' && buttons.error === 'no such alert') return { ok: true, alert: { open: false } }
  if (buttons.status !== 'answered') return { ok: false, failure: port.readFailure(buttons, "Reading the alert's buttons", signal) }
  return { ok: true, alert: { open: true, source: 'executor', text: redact(text.value), buttons: buttons.value.map(redact) } }
}

/** How a test answers an alert: the label of the button to press, and on iOS which of WebDriverAgent's two routes presses it. */
export type AlertAnswer = { readonly button: string; readonly route: 'accept' | 'dismiss' }

/**
 * Presses one named button of the alert in front, once, then waits for the alert to close. Fails without sending
 * anything when no alert is open or no button, or several, carry the label; once the press went, a failure says so and
 * nothing is pressed again.
 */
export async function answerAlert(port: NativePort, answer: AlertAnswer, deadline: Deadline, signal: AbortSignal, redact: (text: string) => string): Promise<DispatchedRequest> {
  const read = await port.readTree(deadline.commandTimeoutMs, signal)
  if (!read.ok) return { result: { ok: false, failure: read.failure }, input: 'not_sent' }
  const [alert] = alertsOf(read.tree)
  if (port.platform === 'macos') return clickAlertButton(port, read.tree, read.reference, alert, answer, deadline, signal)
  return pressThroughAlertRoute(port, read.reference, answer, deadline, signal, redact)
}

async function clickAlertButton(port: NativePort, tree: NativeTree, reference: NativeReference, alert: NativeAlert | undefined, answer: AlertAnswer, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  if (alert === undefined) return refused({ class: 'not_actionable', message: `No alert is open, so Retest pressed no ${quoteText(answer.button)} button.` })
  const matching = alert.buttons.filter((button) => nameOf(button, tree.platform) === answer.button)
  const [button, ...others] = matching
  if (button === undefined || others.length > 0) return refused(buttonCountFailure(matching.length, answer.button, describeAlert(alert, tree.platform)))
  const pressed = await clickTreeElement(port, tree, reference, button, 'alert', `Clicking the ${quoteText(answer.button)} button of ${describeAlert(alert, tree.platform)}`, deadline, signal)
  if (!pressed.ok) return { result: { ok: false, failure: pressed.failure }, input: pressed.input }
  return waitUntilClosed(port, answer, deadline, signal)
}

// The button labels come from WebDriverAgent rather than the session's tree, so they are redacted before a message quotes them.
async function pressThroughAlertRoute(port: NativePort, reference: NativeReference, answer: AlertAnswer, deadline: Deadline, signal: AbortSignal, redact: (text: string) => string): Promise<DispatchedRequest> {
  const bounds = { timeoutMs: deadline.commandTimeoutMs, signal }
  const buttons = await port.elements.alertButtons(bounds)
  if (buttons.status === 'refused' && buttons.error === 'no such alert') return refused({ class: 'not_actionable', message: `No alert is open, so Retest pressed no ${quoteText(answer.button)} button.` })
  if (buttons.status !== 'answered') return refused(port.readFailure(buttons, "Reading the alert's buttons", signal))
  const count = buttons.value.filter((label) => label === answer.button).length
  if (count !== 1) return refused(buttonCountFailure(count, answer.button, `the alert with buttons ${buttons.value.map((label) => quoteText(redact(label))).join(', ')}`))
  const stale = port.checkReference(reference)
  if (stale !== undefined) return refused(stale)
  const route = answer.route === 'accept' ? 'POST /session/:session/alert/accept' : 'POST /session/:session/alert/dismiss'
  port.aboutToSend('alert', route, reference)
  const pressed = answer.route === 'accept' ? await port.elements.acceptAlert(answer.button, bounds) : await port.elements.dismissAlert(answer.button, bounds)
  // The alert routes raise "no such alert" before they tap anything, so that answer sent no input.
  const input = pressed.status === 'refused' && pressed.error === 'no such alert' ? 'not_sent' : inputDispatch(pressed)
  if (pressed.status !== 'answered') {
    const failure = { ...port.readFailure(pressed, `Pressing the alert's ${quoteText(answer.button)} button`, signal), details: { inputSent: input } }
    port.recordInput({ kind: 'alert', route, input, reference, failure })
    return { result: { ok: false, failure }, input }
  }
  port.recordInput({ kind: 'alert', route, input, reference })
  return waitUntilClosed(port, answer, deadline, signal)
}

// Once the press went, the alert is looked at until it has gone; one that stays is said, and pressed no more.
async function waitUntilClosed(port: NativePort, answer: AlertAnswer, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const stayed: DispatchedRequest = { result: { ok: false, failure: { class: 'not_actionable', message: `Retest pressed the ${quoteText(answer.button)} button once, and an alert was still open when the time ran out. It pressed nothing more.`, details: { inputSent: 'sent' } } }, input: 'sent' }
  for (;;) {
    const read = await port.readTree(deadline.commandTimeoutMs, signal)
    if (!read.ok) return read.failure.class === 'timeout' && deadline.expired ? stayed : { result: { ok: false, failure: { ...read.failure, details: { ...read.failure.details, inputSent: 'sent' } } }, input: 'sent' }
    const open = alertsOf(read.tree).length > 0 || (port.platform === 'ios-simulator' && (await executorAlertOpen(port, deadline, signal)))
    if (!open) return { result: { ok: true }, input: 'sent' }
    if (deadline.expired || signal.aborted) return stayed
    await sleep(Math.min(100, deadline.remainingMs), undefined, { signal }).catch(() => undefined)
  }
}

async function executorAlertOpen(port: NativePort, deadline: Deadline, signal: AbortSignal): Promise<boolean> {
  const text = await port.elements.alertText({ timeoutMs: deadline.commandTimeoutMs, signal })
  return text.status === 'answered'
}

function buttonCountFailure(count: number, button: string, alert: string): Failure {
  if (count === 0) return { class: 'not_found', message: `${capitalise(alert)} has no button labelled ${quoteText(button)}, so Retest pressed nothing.` }
  return { class: 'ambiguous', message: `${capitalise(alert)} has ${count} buttons labelled ${quoteText(button)}, and Retest presses only a button it can name alone. It pressed nothing.`, details: { count } }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function refused(failure: Failure): DispatchedRequest {
  return { result: { ok: false, failure: { ...failure, details: { ...failure.details, inputSent: 'not_sent' } } }, input: 'not_sent' }
}

