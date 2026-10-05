import type { Dispatch } from '../dispatch.ts'
import type { CommandResult } from '../../protocol/commands.ts'
import type { Failure } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { s } from '../../protocol/schema.ts'
import { isWebUrl } from '../../protocol/url.ts'
import { CdpAbortedError, CdpProtocolError, CdpTimeoutError } from '../cdp/errors.ts'
import { readProtocol } from '../cdp-results.ts'
import { connectionEnded } from '../command-failures.ts'
import { originAndPath } from '../page-url.ts'

/**
 * What happened to the main frame, as a WebKit page reads its events: a new document committed with its loader, the
 * current document fired its load event, the frame moved within its document, a navigation was given up without a
 * document (a failed load, a response with no content, a download), or the page stopped answering.
 */
export type FrameEvent =
  | { kind: 'committed'; loaderId: string }
  | { kind: 'loaded'; loaderId: string }
  | { kind: 'within' }
  | { kind: 'given_up'; loaderId: string | undefined; url: string | undefined; error: string }
  | { kind: 'stopped'; reason: string }

/** What navigation needs from a WebKit page. */
export type WebKitNavigationContext = {
  baseUrl: string | undefined
  currentUrl: () => URL | undefined
  /** Main frame events from now on; returns a function that stops listening. */
  onFrameEvent: (listener: (event: FrameEvent) => void) => () => void
  /** Why the page cannot answer now, if it cannot. */
  stopped: () => string | undefined
  /** Sends `Playwright.navigate` for the page as input of the command, and answers with what the browser said. */
  navigate: (url: string, deadline: Deadline, dispatch: Dispatch) => Promise<unknown>
  /** Sends a page target command, `Page.reload`, `Page.goBack` or `Page.goForward`, as input of the command. */
  history: (method: 'Page.reload' | 'Page.goBack' | 'Page.goForward', deadline: Deadline, dispatch: Dispatch) => Promise<'sent' | 'no_entry'>
  /** Hears the loader a `goto` started as soon as the browser names it. */
  opened?: (loaderId: string) => void
}

type Outcome = { kind: 'done' } | { kind: 'timeout' } | { kind: 'stopped'; reason: string }

const navigateSchema = s.object({ loaderId: s.optional(s.string()) })

/**
 * Opens a URL in the main frame and waits for the load event of the document it opened, or of a document that replaced
 * it before it loaded, as a client-side redirect does. A move within the same document is complete once the browser
 * reports it. A navigation the browser gives up fails, naming the address and the browser's own words.
 */
export async function navigate(page: WebKitNavigationContext, url: string, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const target = resolveTarget(url, page.baseUrl)
  if (!target.ok) return target
  const address = target.url
  const watcher = new FrameWatcher(page)
  try {
    let loaderId: string | undefined
    try {
      loaderId = readProtocol(navigateSchema, await page.navigate(address.href, deadline, dispatch), { method: 'Playwright.navigate' }).loaderId
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(address, deadline)
      if (error instanceof CdpProtocolError) return { ok: false, failure: navigationFailed(address, error.protocolMessage) }
      throw error
    }
    if (loaderId !== undefined) page.opened?.(loaderId)
    const outcome = loaderId === undefined ? await watcher.movedWithinDocument(deadline) : await watcher.loaded(loaderId, deadline)
    if (outcome.kind === 'timeout') return notLoaded(address, deadline)
    if (outcome.kind === 'stopped') return { ok: false, failure: connectionEnded(`open ${originAndPath(address)}`, true, outcome.reason) }
    const givenUp = watcher.givenUp
    if (givenUp !== undefined) return { ok: false, failure: navigationFailed(address, givenUp.error) }
    return { ok: true, kind: 'goto', url: originAndPath(page.currentUrl() ?? address) }
  } finally {
    watcher.stop()
  }
}

/** Reloads the main frame's document and waits for the load event of the document that replaces it. */
export async function reload(page: WebKitNavigationContext, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  return opened(page, { method: 'Page.reload', kind: 'reload', verb: 'reload', expected: page.currentUrl() }, deadline, dispatch)
}

/** Which way `traverse` moves through the main frame's history. */
export type Traversal = 'goBack' | 'goForward'

/**
 * Moves the main frame one entry back or forward in its history and waits as `navigate` does. A page with no entry that
 * way fails `not_actionable`: WebKit refuses the move before it navigates, so nothing happened.
 */
export async function traverse(page: WebKitNavigationContext, direction: Traversal, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const back = direction === 'goBack'
  const method = back ? 'Page.goBack' : 'Page.goForward'
  return opened(page, { method, kind: direction, verb: back ? 'go back to' : 'go forward to', expected: undefined }, deadline, dispatch)
}

type Opening = { method: 'Page.reload' | 'Page.goBack' | 'Page.goForward'; kind: 'reload' | Traversal; verb: string; expected: URL | undefined }

async function opened(page: WebKitNavigationContext, { method, kind, verb, expected }: Opening, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const watcher = new FrameWatcher(page)
  try {
    try {
      const sent = await page.history(method, deadline, dispatch)
      if (sent === 'no_entry') {
        const where = kind === 'goBack' ? 'back: the page has no earlier' : 'forward: the page has no later'
        return { ok: false, failure: { class: 'not_actionable', message: `Could not go ${where} entry in its history, so nothing happened.` } }
      }
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(page.currentUrl() ?? expected, deadline)
      throw error
    }
    const outcome = await watcher.settled(deadline)
    if (outcome.kind === 'timeout') return notLoaded(page.currentUrl() ?? expected, deadline)
    const url = page.currentUrl() ?? expected
    const address = url === undefined ? 'the page' : originAndPath(url)
    if (outcome.kind === 'stopped') return { ok: false, failure: connectionEnded(`${verb} ${address}`, true, outcome.reason) }
    const givenUp = watcher.givenUp
    if (givenUp !== undefined) {
      const shown = originAndPath(URL.parse(givenUp.url ?? '') ?? expected ?? new URL('about:blank'))
      const message = `Could not ${verb} ${shown}: the browser sent the request and gave the navigation up without opening a document, as it does for a response with no content or a download. The page stayed on ${address}.`
      return { ok: false, failure: { class: 'not_actionable', message, details: { url: shown, inputSent: true } } }
    }
    return { ok: true, kind, url: address }
  } finally {
    watcher.stop()
  }
}

type Resolved = { ok: true; url: URL } | { ok: false; failure: Failure }

function resolveTarget(url: string, baseUrl: string | undefined): Resolved {
  const target = URL.parse(url) ?? (baseUrl === undefined ? null : URL.parse(url, baseUrl))
  if (target === null) return { ok: false, failure: { class: 'usage', message: unresolvable(url, baseUrl) } }
  if (!isWebUrl(target)) return { ok: false, failure: { class: 'unsupported', message: `goto opens http and https addresses, not ${target.protocol} ones.` } }
  return { ok: true, url: target }
}

function unresolvable(url: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return `goto(${JSON.stringify(url)}) needs a full URL, because no base URL was given.`
  if (!URL.canParse(baseUrl)) return `The base URL ${JSON.stringify(baseUrl)} is not a valid URL.`
  return `goto(${JSON.stringify(url)}) is not a valid URL.`
}

function notLoaded(address: URL | undefined, deadline: Deadline): CommandResult {
  const url = address === undefined ? 'The page' : originAndPath(address)
  const details = address === undefined ? {} : { details: { url } }
  return { ok: false, failure: { class: 'timeout', message: `${url} did not finish loading within ${deadline.budgetMs} ms.`, ...details } }
}

/**
 * The failure for a navigation WebKit gave up, in WebKit's own words. Its words are its own, not Chromium's
 * `net::ERR_` names, and its sentence keeps one full stop.
 *
 * @example navigationFailed(new URL('http://127.0.0.1:1/'), 'Could not connect to the server.').message // 'Could not open http://127.0.0.1:1/: Could not connect to the server.'
 */
export function navigationFailed(address: URL, errorText: string): Failure {
  const url = originAndPath(address)
  return { class: 'not_actionable', message: `Could not open ${url}: ${errorText.replace(/\.$/, '')}.`, details: { url, errorText } }
}

/** Collects the main frame's events from the moment it is made, so none can arrive before Retest listens. */
class FrameWatcher {
  readonly #page: WebKitNavigationContext
  readonly #loaded = new Set<string>()
  // The loader ids of the main frame's documents, in the order they committed since the watcher was made.
  readonly #committed: string[] = []
  readonly #stop: () => void
  #givenUp: { loaderId: string | undefined; url: string | undefined; error: string } | undefined
  #movedWithinDocument = false
  #stoppedReason: string | undefined
  #waiting: { done: () => boolean; settle: (outcome: Outcome) => void } | undefined

  constructor(page: WebKitNavigationContext) {
    this.#page = page
    this.#stop = page.onFrameEvent((event) => this.#hear(event))
  }

  /** A navigation given up since the watcher was made with no document committed after it, if any. */
  get givenUp(): { loaderId: string | undefined; url: string | undefined; error: string } | undefined {
    return this.#givenUp
  }

  /**
   * Waits for the load event of the document `loaderId` names, or of a later document of the main frame, which can only
   * have replaced it, or for that navigation to be given up.
   */
  loaded(loaderId: string, deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => this.#givenUp?.loaderId === loaderId || this.#loaded.has(this.#latest(loaderId)), deadline)
  }

  movedWithinDocument(deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => this.#movedWithinDocument, deadline)
  }

  /** Waits for a move within the document, the latest document committed since the watcher was made to load, or a navigation given up. */
  settled(deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => {
      const latest = this.#committed.at(-1)
      return this.#givenUp !== undefined || this.#movedWithinDocument || (latest !== undefined && this.#loaded.has(latest))
    }, deadline)
  }

  stop(): void {
    this.#stop()
    this.#waiting?.settle({ kind: 'timeout' })
  }

  #hear(event: FrameEvent): void {
    switch (event.kind) {
      case 'committed':
        this.#committed.push(event.loaderId)
        this.#givenUp = undefined
        break
      case 'loaded':
        this.#loaded.add(event.loaderId)
        break
      case 'within':
        this.#movedWithinDocument = true
        break
      case 'given_up':
        this.#givenUp = { loaderId: event.loaderId, url: event.url, error: event.error }
        break
      case 'stopped':
        this.#stoppedReason = event.reason
        this.#waiting?.settle({ kind: 'stopped', reason: event.reason })
        return
    }
    if (this.#waiting?.done() === true) this.#waiting.settle({ kind: 'done' })
  }

  #wait(done: () => boolean, deadline: Deadline): Promise<Outcome> {
    if (done()) return Promise.resolve({ kind: 'done' })
    const stopped = this.#stoppedReason ?? this.#page.stopped()
    if (stopped !== undefined) return Promise.resolve({ kind: 'stopped', reason: stopped })
    const { signal } = deadline
    const aborted = (): CdpAbortedError => new CdpAbortedError({ method: 'Playwright.navigate', sessionId: undefined }, { written: true })
    if (signal?.aborted === true) return Promise.reject(aborted())
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => settle({ kind: 'timeout' }), deadline.remainingMs)
      const abort = (): void => {
        end()
        reject(aborted())
      }
      const end = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        this.#waiting = undefined
      }
      const settle = (outcome: Outcome): void => {
        end()
        resolve(outcome)
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.#waiting = { done, settle }
    })
  }

  #latest(loaderId: string): string {
    return this.#committed.includes(loaderId) ? (this.#committed.at(-1) ?? loaderId) : loaderId
  }
}
