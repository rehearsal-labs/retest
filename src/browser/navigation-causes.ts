import type { NavigationCause } from '../protocol/page-facts.ts'

/**
 * What started a navigation of the main frame, and the token of the command whose input or `goto` started it, when
 * one did and its caller gave it a token.
 */
export type NavigationStart = { cause: NavigationCause; commandToken?: number }

/** A command at work in the page, by the token its caller gave it. */
type Working = { commandToken: number | undefined }

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
 * delivered; `'goto'` when a `goto` started it; and `'page'` otherwise. An action's and a goto's carry the token of
 * their command, however late they commit. A request the browser never started is forgotten when a document
 * commits or the frame stops loading, so it lends its cause to no later navigation to the same address.
 */
export class NavigationCauses {
  readonly #delivering: Working[] = []
  readonly #opening: Working[] = []
  #requested: { url: string; start: NavigationStart } | undefined
  readonly #started = new Map<string, NavigationStart>()

  /**
   * Runs `work`, which delivers the input of the command `commandToken` names and then calls into the page.
   * Navigations the page requests meanwhile are the action's.
   */
  delivering<T>(commandToken: number | undefined, work: () => Promise<T>): Promise<T> {
    return during(this.#delivering, { commandToken }, work)
  }

  /**
   * Runs `work`, which opens an address for the `goto` `commandToken` names, or reloads the page or moves through its
   * history for a `reload`, `goBack` or `goForward`. A navigation it starts that the page did not request is that
   * command's, cause `goto`.
   */
  opening<T>(commandToken: number | undefined, work: () => Promise<T>): Promise<T> {
    return during(this.#opening, { commandToken }, work)
  }

  /** The page asked for a navigation of the main frame in its own tab. */
  requested(url: string): void {
    this.#requested = { url, start: startOf('action', this.#delivering) ?? { cause: 'page' } }
  }

  /** The browser began a navigation of the main frame that replaces its document when it commits. */
  started(url: string, loaderId: string): void {
    const requested = this.#requested
    this.#requested = undefined
    this.#started.set(loaderId, requested !== undefined && requested.url === url ? requested.start : this.#unannounced())
  }

  /**
   * `Page.navigate` answered with the loader it started. It is the goto's whatever else was said about it, so a
   * page that asks for the same address at that moment cannot pass the goto off as its own.
   */
  opened(loaderId: string): void {
    this.#started.set(loaderId, startOf('goto', this.#opening) ?? { cause: 'goto' })
  }

  /** A new document committed. Returns what started it; one nothing announced is the goto's while one opens. */
  committed(loaderId: string): NavigationStart {
    const start = this.#started.get(loaderId) ?? this.#unannounced()
    this.#started.clear()
    this.#requested = undefined
    return start
  }

  /** The main frame stopped loading: a request the browser has not started by now never will be. */
  stoppedLoading(): void {
    this.#requested = undefined
  }

  /**
   * The page moved to a new path within its document: the command's while `goBack` or `goForward` moves through the
   * history, which `goto` never does, since a goto to a new path opens a document.
   */
  movedWithinDocument(): NavigationStart {
    return startOf('goto', this.#opening) ?? startOf('action', this.#delivering) ?? { cause: 'page' }
  }

  #unannounced(): NavigationStart {
    return startOf('goto', this.#opening) ?? { cause: 'page' }
  }
}

// Commands at work in one page come one at a time, so the latest is the one the browser acts for.
async function during<T>(working: Working[], entry: Working, work: () => Promise<T>): Promise<T> {
  working.push(entry)
  try {
    return await work()
  } finally {
    working.splice(working.indexOf(entry), 1)
  }
}

function startOf(cause: NavigationCause, working: readonly Working[]): NavigationStart | undefined {
  const latest = working.at(-1)
  if (latest === undefined) return undefined
  return latest.commandToken === undefined ? { cause } : { cause, commandToken: latest.commandToken }
}
