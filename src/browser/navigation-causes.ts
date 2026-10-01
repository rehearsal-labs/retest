import type { NavigationCause } from '../protocol/page-facts.ts'

/**
 * Tells what started each navigation of the main frame, from the browser's events about it, as fact F12 showed
 * them:
 *
 * - A navigation the page asks for is announced by `Page.frameRequestedNavigation`, then by
 *   `Page.frameStartedNavigating` with the same address, and commits with that loader. `Page.navigate` raises no
 *   request, and answers with the loader it started.
 * - The request for a navigation the page makes while it handles an action's input can reach Retest after the
 *   call that delivered the input has answered, as can the report of a `history.pushState`. Both come before the
 *   answer to a call into the page sent after the input, since the page makes them before it runs that call. So an
 *   action's delivery lasts until such a call has answered: the guard's disarm, or the `select` call itself.
 *
 * A navigation is `'action'` when the page requested it, or moved within its document, while an action was being
 * delivered; `'goto'` when a `goto` started it; and `'page'` otherwise.
 */
export class NavigationCauses {
  #delivering = 0
  #opening = 0
  #requested: { url: string; cause: NavigationCause } | undefined
  readonly #started = new Map<string, NavigationCause>()

  /**
   * Runs `work`, which delivers an action's input and then calls into the page. Navigations the page requests
   * meanwhile are the action's.
   */
  async delivering<T>(work: () => Promise<T>): Promise<T> {
    this.#delivering += 1
    try {
      return await work()
    } finally {
      this.#delivering -= 1
    }
  }

  /** Runs `work`, which opens an address for `goto`. A navigation it starts that the page did not request is the goto's. */
  async opening<T>(work: () => Promise<T>): Promise<T> {
    this.#opening += 1
    try {
      return await work()
    } finally {
      this.#opening -= 1
    }
  }

  /** The page asked for a navigation of the main frame in its own tab. */
  requested(url: string): void {
    this.#requested = { url, cause: this.#delivering > 0 ? 'action' : 'page' }
  }

  /** The browser began a navigation of the main frame that replaces its document when it commits. */
  started(url: string, loaderId: string): void {
    const requested = this.#requested
    this.#requested = undefined
    const cause = requested !== undefined && requested.url === url ? requested.cause : this.#opening > 0 ? 'goto' : 'page'
    this.#started.set(loaderId, cause)
  }

  /**
   * `Page.navigate` answered with the loader it started. It is the goto's whatever else was said about it, so a
   * page that asks for the same address at that moment cannot pass the goto off as its own.
   */
  opened(loaderId: string): void {
    this.#started.set(loaderId, 'goto')
  }

  /** A new document committed. Returns what started it; one nothing announced is the goto's while one opens. */
  committed(loaderId: string): NavigationCause {
    const cause = this.#started.get(loaderId) ?? (this.#opening > 0 ? 'goto' : 'page')
    this.#started.clear()
    return cause
  }

  /** The page moved to a new path within its document, which `goto` never does, since a goto opens a document. */
  movedWithinDocument(): NavigationCause {
    return this.#delivering > 0 ? 'action' : 'page'
  }
}
