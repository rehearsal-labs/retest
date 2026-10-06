import type { DispatchedRequest, NativeKind } from '../browser/contract.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { ActionSubject, NativePort } from './actionability.ts'
import type { NativeElement, NativeTree } from './locators.ts'
import type { NativeReference } from './session.ts'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'
import { quoteText } from '../protocol/text.ts'
import { waitUntilActionable } from './actionability.ts'
import { pressSubject } from './input.ts'
import { readTreeSteadily } from './keyboard.ts'
import { isWithin, nameOf, textOf } from './locators.ts'
import { inputDispatch } from './webdriver-client.ts'

// Basic app alerts and dialogs. An alert the app shows is part of its own tree: on iOS an `Alert` element, on macOS an
// `Alert`, a `Sheet` or a `Dialog` inside the owned window. An action on anything outside the alert while it is open is
// blocked and fails naming the alert; Retest never taps through one. Answering an alert presses one named button once,
// after the button passes the checks any element passes before input: on iOS through WebDriverAgent's alert routes,
// after its button list shows exactly one button with that label, and on macOS, whose runner has no alert routes, by
// clicking that button. A system alert on iOS is not in the app's tree, so its button has no frame to check; it is
// pressed once its button list names it alone. Once the press went, the alert counts as closed only when the tree
// shows none and, on iOS, the alert route answers that no alert is open.

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
  const read = await readTreeSteadily(port, deadline, signal)
  if (!read.ok) return read
  const [alert] = alertsOf(read.tree)
  if (alert !== undefined) return { ok: true, alert: { open: true, source: 'tree', text: redact(alert.text), buttons: alert.buttons.map((button) => redact(nameOf(button, read.tree.platform))) } }
  if (port.platform !== 'ios-simulator') return { ok: true, alert: { open: false } }
  const bounds = { timeoutMs: deadline.commandTimeoutMs, signal }
  const text = await port.elements.alertText(bounds)
  if (text.status === 'refused' && text.error === 'no such alert') return { ok: true, alert: { open: false } }
  if (text.status !== 'answered') return { ok: false, failure: port.readFailure(text, "Reading the alert's text", signal) }
  const buttons = await port.elements.alertButtons({ timeoutMs: deadline.commandTimeoutMs, signal })
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
  const read = await readTreeSteadily(port, deadline, signal)
  if (!read.ok) return refused(read.failure)
  const [alert] = alertsOf(read.tree)
  if (port.platform === 'macos') return clickAlertButton(port, alert, answer, deadline, signal)
  return pressThroughAlertRoute(port, read.reference, alert, answer, deadline, signal, redact)
}

// The named button of the alert each fresh tree shows, so the press waits for it as for any element: steady, hittable,
// resolved exactly, and on macOS the app in front with nothing over it.
function alertButtonSubject(answer: AlertAnswer): ActionSubject {
  return {
    describe: `the ${quoteText(answer.button)} button of the alert`,
    pick: (tree) => {
      const [alert] = alertsOf(tree)
      if (alert === undefined) return { kind: 'missing', detail: 'no alert is open any more' }
      const matching = alert.buttons.filter((button) => nameOf(button, tree.platform) === answer.button)
      const [button, ...others] = matching
      if (button === undefined || others.length > 0) return { kind: 'refused', failure: buttonCountFailure(matching.length, answer.button, describeAlert(alert, tree.platform)) }
      return { kind: 'found', element: button }
    },
  }
}

async function clickAlertButton(port: NativePort, alert: NativeAlert | undefined, answer: AlertAnswer, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  if (alert === undefined) return refused({ class: 'not_actionable', message: `No alert is open, so Retest pressed no ${quoteText(answer.button)} button.` })
  const pressed = await pressSubject(port, alertButtonSubject(answer), 'alert', `Clicking the ${quoteText(answer.button)} button of ${describeAlert(alert, port.platform)}`, deadline, signal)
  if (!pressed.ok) return { result: { ok: false, failure: { ...pressed.failure, details: { ...pressed.failure.details, inputSent: pressed.input } } }, input: pressed.input }
  return waitUntilClosed(port, answer, deadline, signal)
}

// The button labels come from WebDriverAgent rather than the session's tree, so they are redacted before a message quotes them.
async function pressThroughAlertRoute(port: NativePort, reference: NativeReference, alert: NativeAlert | undefined, answer: AlertAnswer, deadline: Deadline, signal: AbortSignal, redact: (text: string) => string): Promise<DispatchedRequest> {
  let pressReference = reference
  // An alert of the app's own is in the tree, so its button is checked as any element is before the route presses it.
  if (alert !== undefined) {
    const ready = await waitUntilActionable(port, alertButtonSubject(answer), { verb: 'press', enabled: true }, deadline, signal)
    if (!ready.ok) return refused(ready.failure)
    pressReference = ready.target.reference
  }
  const buttons = await port.elements.alertButtons({ timeoutMs: deadline.commandTimeoutMs, signal })
  if (buttons.status === 'refused' && buttons.error === 'no such alert') return refused({ class: 'not_actionable', message: `No alert is open, so Retest pressed no ${quoteText(answer.button)} button.` })
  if (buttons.status !== 'answered') return refused(port.readFailure(buttons, "Reading the alert's buttons", signal))
  const count = buttons.value.filter((label) => label === answer.button).length
  if (count !== 1) return refused(buttonCountFailure(count, answer.button, `the alert with buttons ${buttons.value.map((label) => quoteText(redact(label))).join(', ')}`))
  const stale = await port.checkReference(pressReference)
  if (stale !== undefined) return refused(stale)
  const route = answer.route === 'accept' ? 'POST /session/:session/alert/accept' : 'POST /session/:session/alert/dismiss'
  const what = `Pressing the alert's ${quoteText(answer.button)} button`
  port.aboutToSend('alert', route, pressReference)
  const bounds = { timeoutMs: deadline.commandTimeoutMs, signal }
  const pressed = answer.route === 'accept' ? await port.elements.acceptAlert(answer.button, bounds) : await port.elements.dismissAlert(answer.button, bounds)
  // The alert routes raise "no such alert" before they tap anything, so that answer sent no input.
  const input = pressed.status === 'refused' && pressed.error === 'no such alert' ? 'not_sent' : inputDispatch(pressed)
  if (pressed.status !== 'answered') {
    const failure = port.readFailure(pressed, what, signal, input !== 'not_sent')
    const withInput: Failure = { ...failure, details: { ...failure.details, inputSent: input } }
    port.recordInput({ kind: 'alert', route, input, reference: pressReference, failure: withInput })
    return { result: { ok: false, failure: withInput }, input }
  }
  port.recordInput({ kind: 'alert', route, input, reference: pressReference })
  return waitUntilClosed(port, answer, deadline, signal)
}

// Once the press went, the alert is looked at until it has gone; one that stays is said, and pressed no more. A tree
// that could not be read is looked at again, and on iOS only the alert route's own "no such alert" says no system
// alert is left: an answer that timed out, lost its connection or could not be read says nothing, so it fails.
async function waitUntilClosed(port: NativePort, answer: AlertAnswer, deadline: Deadline, signal: AbortSignal): Promise<DispatchedRequest> {
  const stayed: DispatchedRequest = { result: { ok: false, failure: { class: 'not_actionable', message: `Retest pressed the ${quoteText(answer.button)} button once, and an alert was still open when the time ran out. It pressed nothing more.`, details: { inputSent: 'sent' } } }, input: 'sent' }
  const sent = (failure: Failure): DispatchedRequest => ({ result: { ok: false, failure: { ...failure, details: { ...failure.details, inputSent: 'sent' } } }, input: 'sent' })
  for (;;) {
    const finalRead = deadline.reached
    const read = await port.readTree(deadline.commandTimeoutMs, signal)
    if (!read.ok && read.failure.details?.['check'] !== 'tree' && read.failure.class !== 'timeout') return sent(read.failure)
    if (read.ok && alertsOf(read.tree).length === 0) {
      if (port.platform !== 'ios-simulator') return { result: { ok: true }, input: 'sent' }
      const executor = await executorAlert(port, deadline, signal)
      if (executor.kind === 'closed') return { result: { ok: true }, input: 'sent' }
      if (executor.kind === 'failed' && executor.failure.class !== 'timeout') return sent(executor.failure)
    }
    if (finalRead || signal.aborted) return stayed
    await waitBeforeRead(deadline, 100, signal).catch(() => undefined)
  }
}

async function executorAlert(port: NativePort, deadline: Deadline, signal: AbortSignal): Promise<{ readonly kind: 'open' | 'closed' } | { readonly kind: 'failed'; readonly failure: Failure }> {
  const text = await port.elements.alertText({ timeoutMs: deadline.commandTimeoutMs, signal })
  if (text.status === 'answered') return { kind: 'open' }
  if (text.status === 'refused' && text.error === 'no such alert') return { kind: 'closed' }
  const failure = port.readFailure(text, 'Reading whether an alert is still open after the press', signal)
  return { kind: 'failed', failure: { ...failure, message: `${failure.message} Retest cannot tell whether the alert closed.` } }
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
