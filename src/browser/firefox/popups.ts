import type { BidiClient } from './bidi-client.ts'
import type { PageNavigation, WebSession } from '../contract.ts'
import type { OpenedPopup, PopupArming, PopupEnd, PopupWait, PopupWaitOptions } from '../popups.ts'
import type { Failure } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { failureSchema } from '../../protocol/failures.ts'
import { parse, s } from '../../protocol/schema.ts'
import { Listeners } from '../listeners.ts'
import { readBidi } from './bidi-client.ts'

// The pages a Firefox page opens, by `window.open`, a link with a target or a form that posts to a new window. Each is
// a top-level browsing context of its own in the opener's user context, and Firefox names the page that opened it as
// its `originalOpener`. Firefox cannot hold a new page before its first document, as Chrome can; instead every page of
// a user context runs Retest's script before its own scripts, and is followed, from its start: the preload script,
// the subscriptions and the viewport are the user context's, made when its first page opened. So the page Retest
// makes for a popup, the moment Firefox tells of it, hears every navigation from the first, and the popup's first
// document has Retest's input guard as much as any other.

const createdSchema = s.object({ context: s.string(), parent: s.nullable(s.string()), originalOpener: s.optional(s.nullable(s.string())), userContext: s.optional(s.string()), url: s.string() })

// How far a frame is followed up to the page that holds it.
const maxSteps = 8

/** A page of the user context the watch hands each page it opens to. */
export interface FirefoxPopupOpener {
  claim(context: string, url: string): void
}

/**
 * A page Retest made for a popup: a web session, `ended`, which settles with how its browsing context ended, and
 * `closedItself`, whether it ended while the browser stayed.
 */
export type FirefoxPopupPage = WebSession & { readonly ended: Promise<PopupEnd>; readonly closedItself: boolean }

/**
 * The watch for the pages one user context's pages open. Each new top-level browsing context Firefox tells of whose
 * opener is a page of the user context, or a frame inside one, goes to that page. A window Retest opened itself has no
 * opener, and is left as it is.
 */
export class FirefoxPopupWatch {
  readonly #userContext: string
  readonly #openers = new Map<string, FirefoxPopupOpener>()
  // The frame each frame of the user context is inside, so a page a frame opens is its page's.
  readonly #parents = new Map<string, string>()
  readonly #stop: () => void

  constructor(client: BidiClient, userContext: string, onListenerError: (error: unknown) => void) {
    this.#userContext = userContext
    this.#stop = client.on('browsingContext.contextCreated', (params) => {
      try {
        this.#created(params)
      } catch (error) {
        onListenerError(error)
      }
    })
  }

  /** Lets the pages `context` opens reach `opener`, until the function it returns is called. */
  register(context: string, opener: FirefoxPopupOpener): () => void {
    this.#openers.set(context, opener)
    return () => {
      if (this.#openers.get(context) === opener) this.#openers.delete(context)
    }
  }

  /** Stops watching, for a user context that is going. */
  dispose(): void {
    this.#stop()
    this.#openers.clear()
  }

  #created(params: unknown): void {
    const { context, parent, originalOpener, userContext, url } = readBidi(createdSchema, params, 'browsingContext.contextCreated')
    if (userContext !== undefined && userContext !== this.#userContext) return
    if (parent !== null) {
      this.#parents.set(context, parent)
      return
    }
    if (originalOpener === undefined || originalOpener === null) return
    let opener = originalOpener
    for (let step = 0; step < maxSteps; step += 1) {
      const above = this.#parents.get(opener)
      if (above === undefined) break
      opener = above
    }
    this.#openers.get(opener)?.claim(context, url)
  }
}

/** What a page's popups need: the watch, the page's own browsing context, and a way to make a popup's page. */
export type FirefoxPagePopupsOptions = {
  readonly watch: FirefoxPopupWatch
  readonly context: string
  /** Makes the page of a popup this page opened, at once, before Firefox tells anything more of it. */
  readonly open: (context: string, url: string) => FirefoxPopupPage
  readonly onListenerError: (error: unknown) => void
}

/** A wait armed for a popup: how it settles, and how it is taken once a popup came. */
type Waiter = { readonly settle: (wait: PopupWait) => void; readonly take: () => void }

/**
 * The popups of one Firefox page. Armed with `arm`, the page hands the next page it opens to the test, as a page of its
 * own in the same user context, its navigations kept from its first. A page it opens while nothing waits gets a page
 * all the same, and is kept, and closed with this page. A later wait takes only a page opened after it began.
 */
export class FirefoxPagePopups implements FirefoxPopupOpener {
  readonly #options: FirefoxPagePopupsOptions
  readonly #unregister: () => void
  // The pages this page opened while nothing waited, kept until this page is disposed.
  readonly #unwaited = new Set<FirefoxPopupPage>()
  #waiter: Waiter | undefined
  #lostReason: string | undefined

  constructor(options: FirefoxPagePopupsOptions) {
    this.#options = options
    this.#unregister = options.watch.register(options.context, this)
  }

  /**
   * Arms the page for the next page it opens. The wait settles with that page, or fails when its time runs out, when
   * `signal` aborts, or when this page goes. One wait at a time.
   */
  arm({ timeoutMs, signal }: PopupWaitOptions): PopupArming {
    if (this.#lostReason !== undefined) return { ok: false, failure: lost(this.#lostReason) }
    if (this.#waiter !== undefined) return { ok: false, failure: { class: 'usage', message: 'page.popup() is already waiting for a page on this page. Await it before the next one.' } }
    const deadline = new Deadline(timeoutMs, { signal })
    const { promise, resolve } = Promise.withResolvers<PopupWait>()
    const timer = setTimeout(() => settle({ ok: false, failure: { class: 'timeout', message: `No page opened within ${deadline.budgetMs} ms.` } }), deadline.waitToEndMs)
    const stop = (): void => settle({ ok: false, failure: stopped(signal?.reason) })
    // A popup that came is the test's from then on, whatever happens to the wait.
    const take = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (this.#waiter === waiter) this.#waiter = undefined
    }
    const waiter: Waiter = { settle: (wait) => settle(wait), take }
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
   * Takes a new page this page opened: for the wait armed, when there is one, and otherwise as a page nothing waited for.
   * Its page is made at once, so it hears everything Firefox tells of it from here on.
   */
  claim(context: string, url: string): void {
    if (this.#lostReason !== undefined) return
    const waiter = this.#waiter
    if (waiter === undefined) {
      const page = this.#options.open(context, url)
      this.#unwaited.add(page)
      void page.ended.then(() => this.#unwaited.delete(page))
      return
    }
    waiter.take()
    const told: PageNavigation[] = []
    const heard = new Listeners<PageNavigation>(this.#options.onListenerError)
    const page = this.#options.open(context, url)
    page.onNavigation((navigation) => {
      told.push(navigation)
      heard.emit(navigation)
    })
    const follow = (listener: (navigation: PageNavigation) => void): (() => void) => {
      for (const navigation of told) listener(navigation)
      return heard.add(listener)
    }
    const popup: OpenedPopup = { page, follow, first: (timeoutMs) => firstNavigation(follow, page.ended, timeoutMs), gone: page.ended, closed: () => page.closedItself }
    waiter.settle({ ok: true, popup })
  }

  /** This page went away: a wait fails with the reason, and the pages it opens from now on are no one's. */
  lost(reason: string): void {
    this.#lostReason ??= reason
    this.#unregister()
    this.#waiter?.settle({ ok: false, failure: lost(reason) })
  }

  /** Closes the pages this page opened while nothing waited, within the deadline, as this page is disposed. */
  async disposeUnwaited(deadline: Deadline): Promise<void> {
    const pages = [...this.#unwaited]
    this.#unwaited.clear()
    await Promise.all(pages.map((page) => page.dispose(deadline.commandTimeoutMs).catch(() => undefined)))
  }
}

// A popup's first navigation, told when it commits, within `timeoutMs`; undefined when none came in time, or the popup
// went first.
async function firstNavigation(follow: OpenedPopup['follow'], gone: Promise<PopupEnd>, timeoutMs: number): Promise<PageNavigation | undefined> {
  const { promise, resolve } = Promise.withResolvers<PageNavigation | undefined>()
  const stop = follow(resolve)
  const timer = setTimeout(() => resolve(undefined), timeoutMs)
  void gone.then(() => resolve(undefined))
  try {
    return await promise
  } finally {
    stop()
    clearTimeout(timer)
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
