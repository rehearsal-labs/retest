import type { CdpSession } from './cdp/session.ts'
import type { RequestResult } from './contract.ts'
import type { DialogAnswered, DialogType } from '../protocol/dialogs.ts'
import type { Failure } from '../protocol/failures.ts'
import { Deadline } from '../protocol/deadline.ts'
import { isDialogType, unwaitedDialogMessage, unwaitedDialogSentence } from '../protocol/dialogs.ts'
import { errorMessage, failureSchema } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { readProtocol, sendOptions } from './cdp-results.ts'
import { CdpClosedError, CdpDisconnectedError } from './cdp/errors.ts'
import { Listeners } from './listeners.ts'

/**
 * A JavaScript dialog as the page showed it: the id the page gave it, its kind, its text and a prompt's default, as the
 * page wrote them. Both are page text, which the parent redacts before anything records them.
 */
export type OpenedDialog = { readonly id: string; readonly type: DialogType; readonly message: string; readonly defaultValue: string }

/** A wait for the page's next dialog: the dialog, or why none came. */
export type DialogWait = { readonly ok: true; readonly dialog: OpenedDialog } | { readonly ok: false; readonly failure: Failure }

/** A page armed for its next dialog, with the wait for it; or why it cannot be armed. */
export type DialogArming = { readonly ok: true; readonly opened: Promise<DialogWait> } | { readonly ok: false; readonly failure: Failure }

/** How the test answers a dialog: accepted, with the text a prompt takes, or dismissed. */
export type DialogReply = { readonly accept: boolean; readonly promptText?: string }

/**
 * A dialog Retest answered itself because nothing waited for it, as the page showed it: how Retest answered it, whether
 * a command was running on the page when it opened, and `popup` when a page this page opened while nothing waited for it
 * showed it. A command that was running fails with it; a dialog that opened while none was running is the parent's to
 * report.
 */
export type UnwaitedDialog = { readonly type: DialogType; readonly message: string; readonly answered: DialogAnswered; readonly during: boolean; readonly popup?: true }

/** What dialogs did while a command ran: the first one Retest answered itself, and whether a `beforeunload` kept the page. */
export type DuringCommand = { readonly unwaited: UnwaitedDialog | undefined; readonly kept: boolean }

/** A dialog that closed: its kind, and whether it was accepted. */
export type ClosedDialog = { readonly type: DialogType; readonly accepted: boolean }

// `answering` marks a dialog Retest has asked the browser to close: the command it held may answer before the browser
// says the dialog closed, and must not read as held.
type Open = OpenedDialog & { readonly by: 'test' | 'retest'; answering?: true }
type Waiter = { readonly settle: (wait: DialogWait) => void }

// Every part but the kind is read leniently: a dialog whose event Retest could not read would hold the page for good.
const openingSchema = s.object({ type: s.string(), message: s.optional(s.string()), defaultPrompt: s.optional(s.string()) })
const closedSchema = s.object({ result: s.boolean() })

/**
 * The JavaScript dialogs of one Chromium page. A dialog holds the page until it is answered: the command whose input
 * opened it waits, as Chrome does not answer that input before then. A page armed with `arm` hands its next dialog to
 * the test, which answers it with `answer`. Any other dialog Retest answers at once, dismissing it, or accepting a
 * `beforeunload` so the navigation the test asked for happens, and tells its listeners; a command running meanwhile
 * fails with it, so no dialog is ever answered silently as a pass.
 */
export class PageDialogs {
  readonly #session: CdpSession
  readonly #unwaited: Listeners<UnwaitedDialog>
  readonly #closed: Listeners<ClosedDialog>
  // Every dialog Retest answered itself, in order, so a command can tell which arrived while it ran.
  readonly #answeredByRetest: UnwaitedDialog[] = []
  // How many `beforeunload` dialogs were dismissed, each keeping the page where it was.
  #pagesKept = 0
  #waiter: Waiter | undefined
  #open: Open | undefined
  #opened = 0
  #running = 0
  #lostReason: string | undefined

  constructor(session: CdpSession, onListenerError: (error: unknown) => void) {
    this.#session = session
    this.#unwaited = new Listeners(onListenerError)
    this.#closed = new Listeners(onListenerError)
  }

  /** The kind of the dialog open on the page, while one is. */
  get open(): DialogType | undefined {
    return this.#open?.type
  }

  /** The dialog the test was given and has not answered, which holds the page until it does. */
  get held(): OpenedDialog | undefined {
    const open = this.#open
    return open?.by === 'test' && open.answering !== true ? open : undefined
  }

  /**
   * Arms the page for its next dialog, at once, so a command sent after this call cannot open a dialog Retest would
   * answer itself. The wait settles with that dialog, or fails when `timeoutMs` runs out, when `signal` aborts, with its
   * reason when that is a `Failure`, or when the page goes. One wait at a time.
   */
  arm(timeoutMs: number, signal?: AbortSignal): DialogArming {
    if (this.#lostReason !== undefined) return { ok: false, failure: lost(this.#lostReason) }
    if (this.#waiter !== undefined) return { ok: false, failure: { class: 'usage', message: 'page.dialog() is already waiting for a dialog on this page. Await it before the next one.' } }
    const deadline = new Deadline(timeoutMs, { signal })
    const { promise, resolve } = Promise.withResolvers<DialogWait>()
    const timer = setTimeout(() => settle({ ok: false, failure: { class: 'timeout', message: `No dialog opened within ${deadline.budgetMs} ms.` } }), deadline.waitToEndMs)
    const stop = (): void => settle({ ok: false, failure: stopped(signal?.reason) })
    const waiter: Waiter = { settle: (wait) => settle(wait) }
    const settle = (wait: DialogWait): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (this.#waiter === waiter) this.#waiter = undefined
      resolve(wait)
    }
    this.#waiter = waiter
    if (signal?.aborted === true) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    return { ok: true, opened: promise }
  }

  /**
   * Answers the dialog the test was given, accepting it with a prompt's text or dismissing it, within `timeoutMs`.
   * A dialog that is no longer open, or one the test was not given, fails and nothing is sent.
   */
  async answer(id: string, reply: DialogReply, timeoutMs: number): Promise<RequestResult> {
    const open = this.#open
    if (open === undefined || open.id !== id || open.by !== 'test' || open.answering === true) {
      const message = this.#lostReason === undefined ? 'The dialog is no longer open, so Retest answered nothing.' : `The page is gone, so Retest answered nothing: ${this.#lostReason}.`
      return { ok: false, failure: { class: 'not_actionable', message } }
    }
    if (reply.promptText !== undefined && open.type !== 'prompt') {
      return { ok: false, failure: { class: 'usage', message: `accept() takes text only for a prompt dialog, and this is ${article(open.type)} ${open.type} dialog.` } }
    }
    // Chrome answers a prompt accepted with no text with an empty one; a person who presses OK submits the default.
    const promptText = reply.promptText ?? (reply.accept && open.type === 'prompt' ? open.defaultValue : undefined)
    const params = { accept: reply.accept, ...(promptText === undefined ? {} : { promptText }) }
    open.answering = true
    // Chrome answers the navigation a dismissed beforeunload stopped before it says the dialog closed, so it is counted now.
    if (open.type === 'beforeunload' && !reply.accept) this.#pagesKept += 1
    try {
      await this.#session.send('Page.handleJavaScriptDialog', params, sendOptions(new Deadline(timeoutMs)))
      return { ok: true }
    } catch (error) {
      if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return { ok: false, failure: lost(error.reason) }
      return { ok: false, failure: { class: 'outcome_unknown', message: `Retest asked the browser to answer the ${open.type} dialog, and could not tell whether it did: ${errorMessage(error)}` } }
    }
  }

  /**
   * Takes on the dialogs Retest answered on the page before the page was set up, as an Electron app's first window can
   * show one as it loads. Listeners hear them first, as dialogs nothing waited for that opened while no command ran.
   */
  answeredBefore(dialogs: readonly UnwaitedDialog[]): void {
    this.#answeredByRetest.push(...dialogs)
  }

  /**
   * Hears each dialog Retest answered itself, those before the call first, since a popup runs before whoever waits for
   * it can listen. Returns a function that stops listening.
   */
  onUnwaited(listener: (dialog: UnwaitedDialog) => void): () => void {
    for (const dialog of this.#answeredByRetest) listener(dialog)
    return this.#unwaited.add(listener)
  }

  /**
   * Tells of a dialog Retest answered in a page this page opened while nothing waited for it, as this page's own: a
   * command running here fails with it, and the listeners hear it.
   */
  forward(dialog: UnwaitedDialog): void {
    const told: UnwaitedDialog = { ...dialog, during: this.#running > 0, popup: true }
    this.#answeredByRetest.push(told)
    this.#unwaited.emit(told)
  }

  /** Hears each dialog that closed, however it was answered. Returns a function that stops listening. */
  onClosed(listener: (dialog: ClosedDialog) => void): () => void {
    return this.#closed.add(listener)
  }

  /**
   * Marks a command running on the page. The function it returns marks it over, and says what dialogs did meanwhile:
   * the first Retest answered itself, which the command then fails with, and whether a `beforeunload` dialog was
   * dismissed, which kept the page where it was.
   */
  commandStarted(): () => DuringCommand {
    const from = this.#answeredByRetest.length
    const kept = this.#pagesKept
    this.#running += 1
    return () => {
      this.#running -= 1
      return { unwaited: this.#answeredByRetest[from], kept: this.#pagesKept > kept }
    }
  }

  /** Reads `Page.javascriptDialogOpening`: hands the dialog to the test that waits for it, or answers it at once. */
  opened(params: unknown): void {
    const { type, message = '', defaultPrompt } = readProtocol(openingSchema, params, { method: 'Page.javascriptDialogOpening', sessionId: this.#session.id })
    // A kind this release does not know is handled as an alert is, so the page is never left held.
    const kind: DialogType = isDialogType(type) ? type : 'alert'
    this.#opened += 1
    const dialog = { id: `dialog-${this.#opened}`, type: kind, message, defaultValue: kind === 'prompt' ? (defaultPrompt ?? '') : '' }
    const waiter = this.#waiter
    if (waiter !== undefined) {
      this.#open = { ...dialog, by: 'test' }
      waiter.settle({ ok: true, dialog })
      return
    }
    const accept = kind === 'beforeunload'
    this.#open = { ...dialog, by: 'retest', answering: true }
    const unwaited: UnwaitedDialog = { type: kind, message, answered: accept ? 'accepted' : 'dismissed', during: this.#running > 0 }
    this.#answeredByRetest.push(unwaited)
    this.#session.send('Page.handleJavaScriptDialog', { accept }).catch(() => {
      // A page that went away took its dialog with it; a command waiting on it hears of the loss itself.
    })
    this.#unwaited.emit(unwaited)
  }

  /** Reads `Page.javascriptDialogClosed`. */
  closed(params: unknown): void {
    const open = this.#open
    this.#open = undefined
    if (open === undefined) return
    const { result } = readProtocol(closedSchema, params, { method: 'Page.javascriptDialogClosed', sessionId: this.#session.id })
    this.#closed.emit({ type: open.type, accepted: result })
  }

  /** The page went away: a wait fails with the reason, and no dialog is open any more. */
  lost(reason: string): void {
    this.#lostReason ??= reason
    this.#open = undefined
    this.#waiter?.settle({ ok: false, failure: lost(reason) })
  }
}

/**
 * The failure of a command during which the page opened a dialog nothing waited for, which Retest answered. `command`
 * is the command as a failure names it. The dialog's text is page text: it goes in `details.dialogMessage`, as the page
 * showed it, for the parent to redact and quote, and the message leaves it out.
 *
 * @example unwaitedDialogFailure("click getByTestId('delete')", dialog, true).class // 'not_actionable'
 */
export function unwaitedDialogFailure(command: string, dialog: UnwaitedDialog, inputSent: boolean): Failure {
  const popup = dialog.popup === true ? { popup: true } : {}
  return {
    class: 'not_actionable',
    message: unwaitedDialogMessage({ type: dialog.type, answered: dialog.answered, command, popup: dialog.popup === true }),
    details: { dialog: dialog.type, dialogMessage: dialog.message, answered: dialog.answered, command, ...popup, inputSent },
  }
}

/**
 * A command's own failure, with the dialog Retest answered while it ran named after it: the command's class, message
 * and details stay first, since its outcome is what happened, and the dialog follows in a sentence of its own and in
 * `details`. The dialog's text goes in `details.dialogMessage` for the parent to redact and quote.
 *
 * @example withUnwaitedDialog(timedOut, dialog).class // 'timeout'
 */
export function withUnwaitedDialog(failure: Failure, dialog: UnwaitedDialog): Failure {
  const popup = dialog.popup === true ? { popup: true } : {}
  return {
    ...failure,
    message: `${failure.message} ${unwaitedDialogSentence({ type: dialog.type, answered: dialog.answered, popup: dialog.popup === true })}`,
    details: { ...failure.details, dialog: dialog.type, dialogMessage: dialog.message, answered: dialog.answered, ...popup },
  }
}

/**
 * The failure of a command the page did not follow because a `beforeunload` dialog was dismissed, which keeps the page
 * where it was.
 *
 * @example keptByBeforeunload('open http://127.0.0.1:4173/next', true).class // 'not_actionable'
 */
export function keptByBeforeunload(command: string, inputSent: boolean): Failure {
  return { class: 'not_actionable', message: `Retest could not ${command}: its beforeunload dialog was dismissed, so the page stayed where it was.`, details: { dialog: 'beforeunload', inputSent } }
}

/**
 * A command's own failure of another kind, as a timeout, while a `beforeunload` dialog the test dismissed kept the page:
 * its class and message stay first, and the kept page follows.
 *
 * @example withKeptPage(timedOut).message.endsWith('so the page stayed where it was.') // true
 */
export function withKeptPage(failure: Failure): Failure {
  return { ...failure, message: `${failure.message} Its beforeunload dialog was dismissed, so the page stayed where it was.`, details: { ...failure.details, dialog: 'beforeunload' } }
}

/**
 * The failure of a command that met a dialog the test was given and has not answered, which holds the page: one sent
 * while it holds the page, which sends nothing, or the command whose input opened it and whose time ran out waiting.
 *
 * @example heldByDialog("click getByTestId('save')", 'confirm', false).class // 'not_actionable'
 */
export function heldByDialog(command: string, type: DialogType, inputSent: boolean): Failure {
  if (inputSent) {
    return {
      class: 'timeout',
      message: `Retest began to ${command}, and the ${type} dialog the test was given held the page until the time ran out. Answer it with dialog.accept() or dialog.dismiss().`,
      details: { dialog: type, inputSent: true },
    }
  }
  return {
    class: 'not_actionable',
    message: `Retest could not ${command}: the ${type} dialog the test was given still holds the page. Answer it first with dialog.accept() or dialog.dismiss().`,
    details: { dialog: type, inputSent: false },
  }
}

/**
 * The refusal of `page.dialog()` on a page of an engine that cannot hand its dialogs to a test yet.
 *
 * @example dialogsUnsupported('Firefox').class // 'unsupported'
 */
export function dialogsUnsupported(engine: string): Failure {
  return { class: 'unsupported', message: `Retest hands dialogs to a test on Chrome and Chromium only, and not on ${engine} yet.` }
}

function lost(reason: string): Failure {
  return { class: 'session_lost', message: `The page went away before a dialog was answered: ${reason}.` }
}

// A wait stopped by its test or its caller says why, with the class the reason gives.
function stopped(reason: unknown): Failure {
  const parsed = parse(failureSchema, reason)
  return parsed.ok ? parsed.value : { class: 'interrupted', message: 'Retest stopped waiting for a dialog.' }
}

function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a'
}
