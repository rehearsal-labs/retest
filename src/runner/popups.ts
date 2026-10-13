import type { OwnedPage, PageNavigation, WebSession } from '../browser/contract.ts'
import type { OpenedPopup } from '../browser/popups.ts'
import type { CommandResult, PageCommand } from '../protocol/commands.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { PopupAnswer } from '../protocol/popups.ts'
import type { TestHost } from './dialogs.ts'
import type { AppPage } from './test-pages.ts'
import { elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage, failure, withLocation } from '../protocol/failures.ts'
import { formatLine } from '../protocol/location.ts'
import { popupAppName } from '../protocol/popups.ts'
import { NativePageAdapter } from './native-pool.ts'

/**
 * Where the pages a test's pages open become sessions of the attempt: `add` names a popup, after the page that opened it,
 * and gives it a session of its own, and `closed` marks one gone, so it is neither pictured nor disposed again.
 */
export type PopupRegistry = {
  add(opener: string, page: WebSession): { readonly app: string; readonly sessionId: string }
  closed(app: string): void
}

/**
 * How a test's popups reach the running test: a new one is adopted as one of its pages, under its name, with `follow`,
 * which hears its navigations from its first, those told before included.
 */
export type PopupHost = TestHost & { adopt(app: string, page: OwnedPage, follow: OpenedPopup['follow']): void }

type PopupMessage = Extract<ChildMessage, { type: 'popup' }>
type Waiting = { readonly stop: AbortController; stoppedByTest: boolean }
/** A popup the test was given: whether the test closed it, and where; or that it closed without the test. */
type Given = { readonly opened: OpenedPopup; closing?: SourceLocation | undefined; closed?: 'test' | 'page' }

/**
 * The parent's side of the pages a test's pages open. A wait arms the app's page, once the browser holds every new page,
 * and gives the test the next page that page opens: named after its opener, adopted as one of the test's pages, and
 * written down as `popup.opened` once its first document has committed. A popup that closes on its own is written down
 * as `popup.closed`, and a command to it is refused from then on, as is one to a popup the test closed.
 */
export class TestPopups {
  readonly #host: PopupHost
  readonly #registry: PopupRegistry | undefined
  readonly #waits = new Map<number, Waiting>()
  readonly #given = new Map<string, Given>()

  constructor(host: PopupHost, registry: PopupRegistry | undefined) {
    this.#host = host
    this.#registry = registry
  }

  receive(message: PopupMessage): void {
    if (message.testId !== this.#host.testId || message.attemptId !== this.#host.attemptId) return this.#host.violation('sent a popup request for an inactive test attempt')
    if (this.#waits.has(message.id)) return this.#host.violation(`sent popup request ${message.id} again while the first was still waiting`)
    if (message.request.kind === 'stop') return this.#stop(message.id, message.request.wait)
    this.#wait(message).catch((error: unknown) => this.#refuse(message.id, failure('setup_failed', `Retest could not hand over the page this page opened: ${errorMessage(error)}`, message.location)))
  }

  /**
   * Why a command may not go to an app's page: `close()` on one of the test's own pages, which close when the test ends,
   * and any command to a popup that has closed. Undefined for every other command.
   */
  refusal(app: string, command: PageCommand): Failure | undefined {
    const given = this.#given.get(app)
    if (given === undefined) {
      if (command.kind !== 'close') return undefined
      return failure('usage', "close() closes a page the app opened, which page.popup() gave. Retest closes the test's own pages when the test ends.")
    }
    if (given.closed === 'test') return failure('usage', `This page was closed by close()${given.closing === undefined ? '' : ` at ${formatLine(given.closing)}`}, so Retest sent nothing to it.`)
    if (given.closed === 'page') return { ...failure('not_actionable', 'This page closed itself, so Retest sent nothing to it.'), details: { inputSent: false } }
    return undefined
  }

  /**
   * A command's answer, as the test is told it: a popup whose target ended while the browser stayed, before anything was
   * sent to it, which the page tells as a lost page, is told as the refusal a command after its closing gets, since the
   * app closed it. A browser that was lost stays a lost page, and input that may have gone keeps its unknown outcome. Any
   * other answer is given back as it is.
   */
  settled(app: string, result: CommandResult): CommandResult {
    const given = this.#given.get(app)
    if (given === undefined || result.ok || result.failure.class !== 'session_lost' || given.closing !== undefined || !given.opened.closed()) return result
    given.closed ??= 'page'
    return { ok: false, failure: { ...failure('not_actionable', 'This page closed itself, so Retest sent nothing to it.'), details: { inputSent: false } } }
  }

  /**
   * Closes a popup through `close`, which the page runs, and marks it closed by the test once its target has gone,
   * whatever the command answered: a `beforeunload` dialog nothing waited for fails the close and still lets it go.
   */
  async close(app: string, location: SourceLocation | undefined, closing: () => Promise<CommandResult>): Promise<CommandResult> {
    const given = this.#given.get(app)
    if (given !== undefined) given.closing = location
    const result = await closing()
    if (given !== undefined && (result.ok || given.opened.closed())) given.closed = 'test'
    else if (given !== undefined && given.closed === undefined) given.closing = undefined
    return result
  }

  /** Stops every wait still running, with `reason`, as the test is stopped or ends; none is answered. */
  stop(reason: Failure): void {
    for (const waiting of this.#waits.values()) {
      waiting.stoppedByTest = true
      waiting.stop.abort(reason)
    }
  }

  #stop(id: number, wait: number): void {
    const waiting = this.#waits.get(wait)
    if (waiting !== undefined) {
      waiting.stoppedByTest = true
      waiting.stop.abort(failure('interrupted', 'The action failed before a page opened.'))
    }
    this.#reply(id, { kind: 'stopped' })
  }

  async #wait(message: PopupMessage): Promise<void> {
    const { id, app, location } = message
    const refusal = this.#host.refusal()
    if (refusal !== undefined) return this.#reply(id, { kind: 'failed', failure: withLocation(refusal, location) })
    const page = this.#host.page(app)
    if (page === undefined) return this.#host.violation(`sent a popup request for the app ${JSON.stringify(app)}, which this test does not use`)
    if (page.armPopup === undefined || this.#registry === undefined) return this.#refuse(id, failure('unsupported', noPopups(app, page), location))
    const stop = new AbortController()
    const waiting: Waiting = { stop, stoppedByTest: false }
    this.#waits.set(id, waiting)
    const timeoutMs = this.#budget(message.timeoutMs)
    const startedAt = monotonicClock()
    const arming = await page.armPopup({ timeoutMs, setupMs: this.#host.timeouts.setup, signal: stop.signal })
    if (!arming.ok) {
      this.#waits.delete(id)
      return waiting.stoppedByTest ? undefined : this.#refuse(id, withLocation(arming.failure, location))
    }
    if (this.#host.answerable()) this.#reply(id, { kind: 'armed' })
    const wait = await arming.opened
    this.#waits.delete(id)
    if (!wait.ok) return waiting.stoppedByTest ? undefined : this.#refuse(id, withLocation(wait.failure, location))
    // A popup that came once the test was stopped or over is no page of it: it is closed, and nothing is written.
    if (!this.#host.answerable()) return void wait.popup.page.dispose(this.#host.timeouts.cleanup).catch(() => undefined)
    const popup = this.#adopt(app, wait.popup, this.#registry)
    const first = await wait.popup.first(Math.max(1, timeoutMs - elapsedMs(startedAt)))
    if (!this.#host.answerable()) return
    await this.#opened({ message, popup, page: wait.popup.page, first })
    if (this.#host.answerable()) this.#reply(id, { kind: 'opened', popup: { app: popup.app } })
  }

  // The popup is a page of the test from its first navigation, and every dialog it opened is heard, the earliest too.
  #adopt(opener: string, opened: OpenedPopup, registry: PopupRegistry): { app: string; sessionId: string } {
    const popup = registry.add(opener, opened.page)
    const given: Given = { opened }
    this.#given.set(popup.app, given)
    this.#host.adopt(popup.app, opened.page, opened.follow)
    void opened.gone.then((end) => {
      registry.closed(popup.app)
      // A lost browser takes every page with it, which is no popup closing; each command then tells of the loss.
      if (end.kind === 'lost' || given.closed !== undefined) return
      if (given.closing !== undefined) {
        given.closed = 'test'
        return
      }
      given.closed = 'page'
      if (!this.#host.answerable()) return
      const { testId, attemptId } = this.#host
      const step = this.#host.stepId()
      this.#host.emit({ type: 'popup.closed', testId, attemptId, ...(step === undefined ? {} : { stepId: step }), session: popup.app, sessionId: popup.sessionId })
    })
    return popup
  }

  // A popup is opened once its first document commits, with that document's address and title; one that committed none
  // in time stands on the address its frame holds, its first empty document.
  async #opened({ message, popup, page, first }: Opening): Promise<void> {
    const title = first === undefined ? undefined : await first.title
    const url = first?.url ?? page.url ?? 'about:blank'
    const { testId, attemptId } = this.#host
    const { app, location, stepId } = message
    this.#host.emit({
      type: 'popup.opened',
      testId,
      attemptId,
      ...(stepId === undefined ? {} : { stepId }),
      session: app,
      sessionId: formatSessionId(attemptId, app),
      popup: popup.app,
      popupSessionId: popup.sessionId,
      url,
      ...(title === undefined ? {} : { title }),
      ...(location === undefined ? {} : { location }),
    })
  }

  #budget(timeoutMs: number): number {
    const remaining = this.#host.remainingMs()
    return remaining === undefined ? timeoutMs : Math.max(1, smallestBudget(timeoutMs, remaining))
  }

  // A failure the parent gave a wait is its own, as an inbox read's is.
  #refuse(id: number, problem: Failure): void {
    if (!this.#host.answerable()) return
    this.#host.observe(problem)
    this.#reply(id, { kind: 'failed', failure: problem })
  }

  #reply(id: number, answer: PopupAnswer): void {
    this.#host.send({ type: 'popup-result', id, answer })
  }
}

type Opening = { readonly message: PopupMessage; readonly popup: { app: string; sessionId: string }; readonly page: WebSession; readonly first: PageNavigation | undefined }

/**
 * The popups of one attempt, as the run holds them: each a session of the attempt, named after the page that opened it,
 * on that page's browser and target, so its failure screenshot and its disposal follow its opener's. `rooted` tells the
 * run which of the test's own apps each popup comes from, whose capture rules it follows.
 */
export class AttemptPopups implements PopupRegistry {
  readonly #pages: ReadonlyMap<string, AppPage>
  readonly #runId: string
  readonly #rooted: (popup: string, app: string) => void
  readonly #popups = new Map<string, { page: AppPage; root: string; open: boolean }>()

  constructor(options: { pages: readonly AppPage[]; runId: string; rooted: (popup: string, app: string) => void }) {
    this.#pages = new Map(options.pages.map((page) => [page.app, page]))
    this.#runId = options.runId
    this.#rooted = options.rooted
  }

  add(opener: string, page: WebSession): { app: string; sessionId: string } {
    const parent = this.#popups.get(opener)
    const from = parent?.page ?? this.#pages.get(opener)
    if (from === undefined) throw new Error(`Retest was given a page opened by ${opener}, which is not one of the test's pages`)
    const app = popupAppName(opener, new Set([...this.#pages.keys(), ...this.#popups.keys()]))
    const { testId, attemptId } = from.session.owner
    const session = { sessionId: formatSessionId(attemptId, app), owner: { runId: this.#runId, testId, attemptId, app }, runtime: from.session.runtime }
    page.identify?.(session)
    const root = parent?.root ?? opener
    this.#popups.set(app, { page: { app, page, browser: from.browser, touch: from.touch, session, popup: true }, root, open: true })
    this.#rooted(app, root)
    return { app, sessionId: session.sessionId }
  }

  closed(app: string): void {
    const popup = this.#popups.get(app)
    if (popup !== undefined) popup.open = false
  }

  /** Every popup of the attempt, open or closed. */
  all(): AppPage[] {
    return [...this.#popups.values()].map((popup) => popup.page)
  }

  /** The popups still open, newest first, so a popup is closed before the page that opened it. */
  open(): AppPage[] {
    return [...this.#popups.values()].filter((popup) => popup.open).map((popup) => popup.page).reverse()
  }
}

// A native app opens no page of a browser; any other page without popups belongs to an engine that refuses them.
function noPopups(app: string, page: OwnedPage): string {
  if (page instanceof NativePageAdapter) return `${app} is a native app, which opens no browser page.`
  return `The page of ${app} cannot hand a test the pages it opens.`
}
