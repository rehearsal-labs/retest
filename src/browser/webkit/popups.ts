import type { PageNavigation, WebSession } from '../contract.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { OpenedPopup, PopupArming, PopupEnd, PopupWait, PopupWaitOptions } from '../popups.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage, failureSchema } from '../../protocol/failures.ts'
import { parse } from '../../protocol/schema.ts'
import { Listeners } from '../listeners.ts'
import { firstNavigation } from '../popups.ts'

// The pages a WebKit page opens. The build announces each with `Playwright.pageProxyCreated`, naming the page that
// opened it in `openerId`, for `window.open`, a link with a target and a form with one alike, and starts its first
// target paused. The browser hands each to its opener's popups at once, before anything of it runs, and sets it up as it
// sets up every page, with the opener's screen and base address, then lets it run. So a test's popup is followed from
// its first document, and an OAuth popup that sends itself on at once has Retest's input guard from its first page.

/** What the popups of a page need of a page it opened. */
export interface PopupPage extends WebSession {
  /** Settles once its first target is set up and running, and rejects if it failed before that. */
  readonly ready: Promise<void>
  /** Settles with how the page ended: closed, while the browser stayed, or lost with the browser. */
  readonly gone: Promise<PopupEnd>
  /** Whether its page ended while the browser stayed. */
  readonly closedInBrowser: boolean
}

/** A wait armed for a popup: how it settles, how it is taken once a popup came, and how long the popup's setup may take. */
type Waiter = { readonly settle: (wait: PopupWait) => void; readonly take: () => void; readonly setupMs: number }

/**
 * The popups of one WebKit page. Armed with `arm`, the page hands the next page it opens to the test, set up as a page of
 * its own in the same browser context, its navigations kept from its first. A page it opens while nothing waits runs on
 * and is kept until this page goes; a later wait takes only a page opened after it began.
 */
export class WebKitPopups {
  readonly #onListenerError: (error: unknown) => void
  // The pages this page opened while nothing waited, kept until they close or this page is disposed.
  readonly #unwaited = new Set<PopupPage>()
  #waiter: Waiter | undefined
  #lostReason: string | undefined

  constructor(onListenerError: (error: unknown) => void) {
    this.#onListenerError = onListenerError
  }

  /**
   * Arms the page for the next page it opens. The wait settles with that page, or fails when its time runs out, when
   * `signal` aborts, or when this page goes. One wait at a time.
   */
  arm({ timeoutMs, setupMs, signal }: PopupWaitOptions): PopupArming {
    if (this.#lostReason !== undefined) return { ok: false, failure: lost(this.#lostReason) }
    if (this.#waiter !== undefined) return { ok: false, failure: { class: 'usage', message: 'page.popup() is already waiting for a page on this page. Await it before the next one.' } }
    const deadline = new Deadline(timeoutMs, { signal })
    const { promise, resolve } = Promise.withResolvers<PopupWait>()
    const timer = setTimeout(() => settle({ ok: false, failure: { class: 'timeout', message: `No page opened within ${deadline.budgetMs} ms.` } }), deadline.waitToEndMs)
    const stop = (): void => settle({ ok: false, failure: stopped(signal?.reason) })
    // A popup that came is set up without the wait's time or signal: it is the test's from then on, whatever happens.
    const take = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (this.#waiter === waiter) this.#waiter = undefined
    }
    const waiter: Waiter = { settle: (wait) => settle(wait), take, setupMs }
    const settle = (wait: PopupWait): void => {
      take()
      resolve(wait)
    }
    this.#waiter = waiter
    if (signal?.aborted === true) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    return { ok: true, opened: promise }
  }

  /**
   * This page opened `page`, which the browser holds before its first document: the wait armed takes it, and otherwise
   * it is kept as a page nothing waited for. Called at once, so its navigations are heard from its first.
   */
  opened(page: PopupPage): void {
    if (this.#lostReason !== undefined) return
    const waiter = this.#waiter
    if (waiter === undefined) {
      this.#unwaited.add(page)
      void page.gone.then(() => this.#unwaited.delete(page))
      return
    }
    waiter.take()
    const told: PageNavigation[] = []
    const heard = new Listeners<PageNavigation>(this.#onListenerError)
    page.onNavigation((navigation) => {
      told.push(navigation)
      heard.emit(navigation)
    })
    const follow = (listener: (navigation: PageNavigation) => void): (() => void) => {
      for (const navigation of told) listener(navigation)
      return heard.add(listener)
    }
    void this.#setUp(page, waiter, follow)
  }

  /** This page went away: a wait fails with the reason, and the pages it opens from now on are not kept. */
  lost(reason: string): void {
    this.#lostReason ??= reason
    this.#waiter?.settle({ ok: false, failure: lost(reason) })
  }

  /** Closes the pages this page opened while nothing waited, within the deadline, as this page is disposed. */
  async disposeUnwaited(deadline: Deadline): Promise<void> {
    const pages = [...this.#unwaited]
    this.#unwaited.clear()
    await Promise.all(pages.map((page) => page.dispose(deadline.commandTimeoutMs).catch(() => undefined)))
  }

  // A popup that could not be set up in time fails the wait with why; its page runs on, let go by its own setup.
  async #setUp(page: PopupPage, waiter: Waiter, follow: OpenedPopup['follow']): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`it was not ready within ${waiter.setupMs} ms`)), waiter.setupMs)
    })
    try {
      await Promise.race([page.ready, late])
      const popup: OpenedPopup = { page, follow, first: (timeoutMs) => firstNavigation(follow, page.gone, timeoutMs), gone: page.gone, closed: () => page.closedInBrowser }
      waiter.settle({ ok: true, popup })
    } catch (error) {
      waiter.settle({ ok: false, failure: { class: 'setup_failed', message: `The page opened a new page, and Retest could not set it up: ${errorMessage(error)}` } })
    } finally {
      clearTimeout(timer)
    }
  }
}

function lost(reason: string): Failure {
  return { class: 'session_lost', message: `The page went away before it opened another page: ${reason}.` }
}

// A wait stopped by its test or its caller says why, with the class the reason gives.
function stopped(reason: unknown): Failure {
  const parsed = parse(failureSchema, reason)
  return parsed.ok ? parsed.value : { class: 'interrupted', message: 'Retest stopped waiting for a page to open.' }
}
