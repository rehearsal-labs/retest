import type { OwnedPage } from '../browser/contract.ts'
import type { OpenedDialog, UnwaitedDialog } from '../browser/dialogs.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { DialogAnswer, DialogAnswered, DialogType } from '../protocol/dialogs.ts'
import type { EventBody } from '../protocol/events.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { ChildMessage, ParentMessage } from '../protocol/messages.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import { smallestBudget } from '../protocol/deadline.ts'
import { dialogTextLimit, unwaitedDialogMessage, withDialogWords } from '../protocol/dialogs.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage, failure, truncateText, withLocation } from '../protocol/failures.ts'
import { NativePageAdapter } from './native-pool.ts'

/**
 * What the parent's handling of a test's dialogs and popups needs of the running test: its pages, its own and the
 * popups it was given, its clock and budgets, the child, its events, the failures it saw for itself, and its redactor.
 */
export type TestHost = {
  readonly testId: string
  readonly attemptId: string
  readonly timeouts: Timeouts
  /** The page an app's commands go to, one of the test's own or a popup it was given. */
  page(app: string): OwnedPage | undefined
  /** Why nothing more may go to the page, once the test was stopped or is over. */
  refusal(): Failure | undefined
  /** Milliseconds the test has left, when its body has begun. */
  remainingMs(): number | undefined
  /** Whether the test is running and not stopped, so its process still takes answers. */
  answerable(): boolean
  /** Whether the test has sent a command to a page yet: a dialog answered before then belongs to no action of it. */
  commandsSent(): boolean
  /** The step the test was in when its latest command arrived. */
  stepId(): string | undefined
  send(message: ParentMessage): void
  emit(body: EventBody): void
  /** Records a failure the parent saw for itself, which fails the test whatever its process claims. */
  observe(problem: Failure): void
  /** Ends the test: its process broke the protocol. */
  violation(problem: string): void
  /** Hides every value the run hides in a text. */
  redact(text: string): string
}

type DialogMessage = Extract<ChildMessage, { type: 'dialog' }>
type Waiting = { readonly stop: AbortController; stoppedByTest: boolean }
type Given = { readonly app: string; readonly pageId: string; readonly type: DialogType; readonly message: string }

/**
 * The parent's side of a test's JavaScript dialogs. A wait arms the app's page at once, before the action the test runs
 * next arrives, and gives the test the dialog when it opens, its text redacted, under an id of the attempt's own. An
 * answer goes to the page that showed the dialog. A dialog nothing waited for is answered by the page, and recorded
 * here: one that opened while no command ran fails the test, and one that opened during a command fails that command,
 * in the words `withDialogText` gives it. A dialog the test was given and left open is dismissed as the body settles.
 * Every dialog that closed is written down as a `dialog` event.
 */
export class TestDialogs {
  readonly #host: TestHost
  readonly #waits = new Map<number, Waiting>()
  readonly #given = new Map<string, Given>()
  #count = 0

  constructor(host: TestHost) {
    this.#host = host
  }

  /** Hears the dialogs an app's page answers itself. Returns a function that stops listening. */
  watch(app: string, page: OwnedPage): () => void {
    return page.onUnwaitedDialog?.((dialog) => this.#unwaited(app, dialog)) ?? (() => undefined)
  }

  receive(message: DialogMessage): void {
    const { request } = message
    if (message.testId !== this.#host.testId || message.attemptId !== this.#host.attemptId) return this.#host.violation('sent a dialog request for an inactive test attempt')
    if (this.#waits.has(message.id)) return this.#host.violation(`sent dialog request ${message.id} again while the first was still waiting`)
    switch (request.kind) {
      case 'wait':
        return this.#wait(message)
      case 'stop':
        return this.#stop(message, request.wait)
      case 'answer':
        return void this.#answer(message, request).catch((error: unknown) => this.#refuse(message.id, failure('setup_failed', `Retest could not answer the dialog: ${errorMessage(error)}`, message.location)))
    }
  }

  /**
   * Dismisses every dialog the test was given and left open, within `timeoutMs`, so its page answers again and the action
   * that opened it can end. Each is written down as dismissed by Retest. Nothing is recorded against the test: its own
   * process names the dialog it left open.
   */
  async settle(timeoutMs: number): Promise<void> {
    const left = [...this.#given.values()]
    this.#given.clear()
    for (const given of left) {
      const answered = await this.#host.page(given.app)?.answerDialog?.(given.pageId, { accept: false }, Math.max(1, timeoutMs))
      if (answered?.ok === true) this.#emit({ app: given.app, type: given.type, message: given.message, answer: 'dismissed', by: 'retest', stepId: undefined, location: undefined })
    }
  }

  #wait(message: DialogMessage): void {
    const { id, app, location } = message
    const refusal = this.#host.refusal()
    if (refusal !== undefined) return this.#reply(id, { kind: 'failed', failure: withLocation(refusal, location) })
    const page = this.#host.page(app)
    if (page === undefined) return this.#host.violation(`sent a dialog request for the app ${JSON.stringify(app)}, which this test does not use`)
    if (page.armDialog === undefined) return this.#refuse(id, failure('unsupported', noDialogs(app, page), location))
    const stop = new AbortController()
    const remaining = this.#host.remainingMs()
    const arming = page.armDialog(remaining === undefined ? message.timeoutMs : Math.max(1, smallestBudget(message.timeoutMs, remaining)), stop.signal)
    if (!arming.ok) return this.#refuse(id, withLocation(arming.failure, location))
    const waiting: Waiting = { stop, stoppedByTest: false }
    this.#waits.set(id, waiting)
    this.#reply(id, { kind: 'armed' })
    void arming.opened.then((wait) => {
      this.#waits.delete(id)
      if (waiting.stoppedByTest) return
      // A dialog that opens once the test is over has nobody to answer it, and would hold the page from its screenshot.
      if (!this.#host.answerable()) return void (wait.ok ? this.#dismissLate(app, page, wait.dialog) : undefined)
      if (!wait.ok) return this.#refuse(id, withLocation(wait.failure, location))
      const { dialog } = wait
      this.#count += 1
      const given = `dialog-${this.#count}`
      this.#given.set(given, { app, pageId: dialog.id, type: dialog.type, message: dialog.message })
      const record = { id: given, type: dialog.type, message: this.#host.redact(dialog.message), defaultValue: this.#host.redact(dialog.defaultValue) }
      this.#reply(id, { kind: 'opened', dialog: record })
    })
  }

  async #dismissLate(app: string, page: OwnedPage, dialog: OpenedDialog): Promise<void> {
    const answered = await page.answerDialog?.(dialog.id, { accept: false }, this.#host.timeouts.cleanup)
    if (answered?.ok === true) this.#emit({ app, type: dialog.type, message: dialog.message, answer: 'dismissed', by: 'retest', stepId: undefined, location: undefined })
  }

  // The action the wait was for failed first, and its own failure fails the test; the wait ends without one.
  #stop(message: DialogMessage, wait: number): void {
    const waiting = this.#waits.get(wait)
    if (waiting !== undefined) {
      waiting.stoppedByTest = true
      waiting.stop.abort(failure('interrupted', 'The action failed before a dialog opened.'))
    }
    this.#reply(message.id, { kind: 'stopped' })
  }

  async #answer(message: DialogMessage, request: Extract<DialogMessage['request'], { kind: 'answer' }>): Promise<void> {
    const { id, location, stepId } = message
    const refusal = this.#host.refusal()
    if (refusal !== undefined) return this.#reply(id, { kind: 'failed', failure: withLocation(refusal, location) })
    const given = this.#given.get(request.dialog)
    if (given === undefined || given.app !== message.app) return this.#host.violation(`answered the dialog ${JSON.stringify(request.dialog)}, which Retest did not give it on ${message.app}`)
    this.#given.delete(request.dialog)
    const page = this.#host.page(given.app)
    const timeoutMs = Math.max(1, smallestBudget(message.timeoutMs, this.#host.remainingMs() ?? message.timeoutMs))
    const reply = { accept: request.accept, ...(request.promptText === undefined ? {} : { promptText: request.promptText }) }
    const answered = (await page?.answerDialog?.(given.pageId, reply, timeoutMs)) ?? { ok: false as const, failure: failure('session_lost', 'The page that showed the dialog is gone.') }
    if (!answered.ok) return this.#refuse(id, withLocation(answered.failure, location))
    const typed = request.accept && request.promptText !== undefined ? { typed: request.promptText.length } : {}
    this.#emit({ app: given.app, type: given.type, message: given.message, answer: request.accept ? 'accepted' : 'dismissed', by: 'test', stepId, location, ...typed })
    if (this.#host.answerable()) this.#reply(id, { kind: 'answered' })
  }

  // A dialog that opened during a command fails that command; one that opened while none ran fails the test here.
  // A dialog answered before the test's first command, as an Electron app's alert at start, is written down and fails
  // nothing: no action of the test opened it, and no change to the test would answer it.
  #unwaited(app: string, dialog: UnwaitedDialog): void {
    this.#emit({ app, type: dialog.type, message: dialog.message, answer: dialog.answered, by: 'retest', stepId: this.#host.stepId(), location: undefined })
    if (dialog.during || !this.#host.answerable() || !this.#host.commandsSent()) return
    const popup = dialog.popup === true
    const message = unwaitedDialogMessage({ type: dialog.type, text: this.#host.redact(dialog.message), answered: dialog.answered, popup })
    this.#host.observe({ ...failure('not_actionable', message), details: { dialog: dialog.type, answered: dialog.answered, ...(popup ? { popup: true } : {}) } })
  }

  /** Stops every wait still running, with `reason`, as the test is stopped or ends; none is answered. */
  stop(reason: Failure): void {
    for (const waiting of this.#waits.values()) {
      waiting.stoppedByTest = true
      waiting.stop.abort(reason)
    }
  }

  #emit({ app, type, message, answer, by, stepId, location, typed }: Written): void {
    const { testId, attemptId } = this.#host
    const text = truncateText(this.#host.redact(message), dialogTextLimit).text
    this.#host.emit({
      type: 'dialog',
      testId,
      attemptId,
      ...(stepId === undefined ? {} : { stepId }),
      session: app,
      sessionId: formatSessionId(attemptId, app),
      dialog: type,
      message: text,
      answer,
      by,
      ...(typed === undefined ? {} : { typed }),
      ...(location === undefined ? {} : { location }),
    })
  }

  // A failure the parent gave a wait or an answer is its own, as an inbox read's is.
  #refuse(id: number, problem: Failure): void {
    if (!this.#host.answerable()) return
    this.#host.observe(problem)
    this.#reply(id, { kind: 'failed', failure: problem })
  }

  #reply(id: number, answer: DialogAnswer): void {
    this.#host.send({ type: 'dialog-result', id, answer })
  }
}

type Written = {
  readonly app: string
  readonly type: DialogType
  readonly message: string
  readonly answer: DialogAnswered
  readonly by: 'test' | 'retest'
  readonly stepId: string | undefined
  readonly location: SourceLocation | undefined
  readonly typed?: number
}

/**
 * A command's answer, with a dialog the page answered while the command ran named in words: the page gives the
 * dialog's text apart, as the page showed it, and only the parent can hide the run's values in it before quoting it.
 * Any other answer is given back as it is.
 *
 * @example withDialogText(result, (text) => redactor.redact(text))
 */
export function withDialogText(result: CommandResult, redact: (text: string) => string): CommandResult {
  if (result.ok) return result
  const failure = withDialogWords(result.failure, redact)
  return failure === result.failure ? result : { ok: false, failure }
}

// A native app shows no JavaScript dialog; any other page without dialogs belongs to an engine that refuses them.
function noDialogs(app: string, page: OwnedPage): string {
  if (page instanceof NativePageAdapter) return `${app} is a native app, which shows no JavaScript dialog. Answer its alerts with page.alert.`
  return `The page of ${app} cannot hand its dialogs to a test.`
}
