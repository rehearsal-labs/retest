import type { CdpSession } from './cdp/session.ts'
import type { Dispatch } from './dispatch.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import { Deadline } from '../protocol/deadline.ts'
import { s, type Schema } from '../protocol/schema.ts'
import { isWebUrl } from '../protocol/url.ts'
import { CdpAbortedError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { connectionEnded } from './command-failures.ts'
import { originAndPath } from './page-url.ts'

/**
 * What navigation needs from a page. `currentUrl` is the main frame's address as the browser last reported it,
 * and `proxyServer` the proxy the page's context sends its requests through, if any. `opened`, when given, hears the
 * loader of the document the navigation started, as soon as the browser names it.
 */
export type NavigationContext = {
  session: CdpSession
  baseUrl: string | undefined
  mainFrameId: () => string
  currentUrl: () => URL | undefined
  proxyServer: string | undefined
  opened?: (loaderId: string) => void
}

// A session that detached or was blocked will never report the load.
type Outcome = { kind: 'done' } | { kind: 'timeout' } | { kind: 'stopped'; reason: string }

// A navigation within the same document has no loaderId.
type Navigation = { loaderId?: string; errorText?: string }

const navigateSchema: Schema<Navigation> = s.object({ loaderId: s.optional(s.string()), errorText: s.optional(s.string()) })
const lifecycleSchema = s.object({ loaderId: s.string(), name: s.string() })
// A document restored from the back-forward cache has loaded already, and a browser error page names the address
// it could not reach.
const committedSchema = s.object({
  frame: s.object({ parentId: s.optional(s.string()), loaderId: s.string(), unreachableUrl: s.optional(s.string()) }),
  type: s.optional(s.string()),
})
const historySchema = s.object({ currentIndex: s.number({ integer: true }), entries: s.array(s.object({ id: s.number({ integer: true }), url: s.string() })) })
const sameDocumentSchema = s.object({ frameId: s.string() })
const startedSchema = s.object({ frameId: s.string(), url: s.string(), navigationType: s.string() })
const stoppedSchema = s.object({ frameId: s.string() })

// Navigations that keep the document. Any other replaces it when it commits, or is given up.
const withinDocument: ReadonlySet<string> = new Set(['sameDocument', 'historySameDocument'])

// The errors Chrome gives a navigation its proxy failed, rather than the site.
const proxyErrors: ReadonlySet<string> = new Set([
  'net::ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_TUNNEL_CONNECTION_FAILED',
  'net::ERR_PROXY_AUTH_UNSUPPORTED',
  'net::ERR_PROXY_CERTIFICATE_INVALID',
  'net::ERR_NO_SUPPORTED_PROXIES',
])

/**
 * Opens a URL in the main frame and waits for the `load` event of the document it returned, or of a document
 * that replaced it before it loaded, as a client-side redirect does. A navigation within the same document is
 * complete once the browser reports it.
 */
export async function navigate(page: NavigationContext, url: string, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const target = resolveTarget(url, page.baseUrl)
  if (!target.ok) return target
  const address = target.url
  const watcher = new NavigationWatcher(page)
  try {
    let started: Navigation
    try {
      const result = await dispatch.send(page.session, 'Page.navigate', { url: address.href }, deadline)
      started = readProtocol(navigateSchema, result, { method: 'Page.navigate', sessionId: page.session.id })
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(address, deadline)
      throw error
    }
    if (started.loaderId !== undefined) page.opened?.(started.loaderId)
    if (started.errorText !== undefined) {
      // The browser shows its error page as a document of its own; waiting for it lets a screenshot show it.
      if (started.loaderId !== undefined) await watcher.loaded(started.loaderId, deadline)
      return { ok: false, failure: navigationFailed(address, started.errorText, page.proxyServer) }
    }
    const outcome =
      started.loaderId === undefined ? await watcher.movedWithinDocument(deadline) : await watcher.loaded(started.loaderId, deadline)
    if (outcome.kind === 'timeout') return notLoaded(address, deadline)
    if (outcome.kind === 'stopped') {
      return { ok: false, failure: connectionEnded(`open ${originAndPath(address)}`, true, outcome.reason) }
    }
    return { ok: true, kind: 'goto', url: originAndPath(page.currentUrl() ?? address) }
  } finally {
    watcher.stop()
  }
}

/**
 * Reloads the main frame's document and waits for the `load` event of the document that replaces it, as `navigate`
 * waits for the one it opens.
 */
export async function reload(page: NavigationContext, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const current = page.currentUrl()
  const watcher = new NavigationWatcher(page)
  try {
    try {
      await dispatch.send(page.session, 'Page.reload', {}, deadline)
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(current, deadline)
      throw error
    }
    return await opened(page, watcher, { kind: 'reload', verb: 'reload', expected: current }, deadline)
  } finally {
    watcher.stop()
  }
}

/** Which way `traverse` moves through the main frame's history. */
export type Traversal = 'goBack' | 'goForward'

/**
 * Moves the main frame one entry back or forward in its history, and waits as `navigate` does: for the `load` event
 * of the document it opens, for a document the browser restored from its back-forward cache, which loaded already,
 * or for a move within the document. A page with no entry that way fails `not_actionable` and sends nothing.
 */
export async function traverse(page: NavigationContext, direction: Traversal, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const history = await request(page.session, 'Page.getNavigationHistory', undefined, historySchema, sendOptions(deadline))
  const back = direction === 'goBack'
  const entry = history.entries[history.currentIndex + (back ? -1 : 1)]
  if (entry === undefined) {
    const where = back ? 'back: the page has no earlier' : 'forward: the page has no later'
    return { ok: false, failure: { class: 'not_actionable', message: `Could not go ${where} entry in its history, so Retest sent nothing.` } }
  }
  const expected = URL.parse(entry.url) ?? undefined
  const watcher = new NavigationWatcher(page)
  try {
    try {
      await dispatch.send(page.session, 'Page.navigateToHistoryEntry', { entryId: entry.id }, deadline)
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(expected, deadline)
      throw error
    }
    return await opened(page, watcher, { kind: direction, verb: back ? 'go back to' : 'go forward to', expected }, deadline)
  } finally {
    watcher.stop()
  }
}

type Opening = { kind: 'reload' | Traversal; verb: string; expected: URL | undefined }

// A document the browser restores from its back-forward cache stops loading just before it commits, as a navigation
// it gives up stops with none, so a move through the history waits this long for that commit before it counts the
// navigation as given up.
const restoreGraceMs = 500

async function opened(page: NavigationContext, watcher: NavigationWatcher, { kind, verb, expected }: Opening, deadline: Deadline): Promise<CommandResult> {
  const settled = await watcher.settled(deadline)
  const outcome = kind !== 'reload' && watcher.abandoned !== undefined ? await watcher.restored(restoreGraceMs, deadline) : settled
  if (outcome.kind === 'timeout') return notLoaded(page.currentUrl() ?? expected, deadline)
  const url = page.currentUrl() ?? expected
  const address = url === undefined ? 'the page' : originAndPath(url)
  if (outcome.kind === 'stopped') return { ok: false, failure: connectionEnded(`${verb} ${address}`, true, outcome.reason) }
  const abandoned = watcher.abandoned
  if (abandoned !== undefined) {
    const shown = originAndPath(URL.parse(abandoned) ?? expected ?? new URL('about:blank'))
    const message = `Could not ${verb} ${shown}: the browser sent the request and gave the navigation up without opening a document, as it does for a response with no content or a download. The page stayed on ${address}.`
    return { ok: false, failure: { class: 'not_actionable', message, details: { url: shown, inputSent: true } } }
  }
  const unreachable = watcher.unreachable
  if (unreachable !== undefined) {
    const shown = originAndPath(URL.parse(unreachable) ?? url ?? new URL('about:blank'))
    return { ok: false, failure: { class: 'not_actionable', message: `Could not ${verb} ${shown}: the browser showed its error page instead.`, details: { url: shown } } }
  }
  return { ok: true, kind, url: address }
}

type Resolved = { ok: true; url: URL } | { ok: false; failure: Failure }

function resolveTarget(url: string, baseUrl: string | undefined): Resolved {
  const target = URL.parse(url) ?? (baseUrl === undefined ? null : URL.parse(url, baseUrl))
  if (target === null) return { ok: false, failure: { class: 'usage', message: unresolvable(url, baseUrl) } }
  if (!isWebUrl(target)) {
    return {
      ok: false,
      failure: { class: 'unsupported', message: `goto opens http and https addresses, not ${target.protocol} ones.` },
    }
  }
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

// A proxy that failed is a problem of the setup, not of the app.
function navigationFailed(address: URL, errorText: string, proxy: string | undefined): Failure {
  const url = originAndPath(address)
  if (proxy === undefined || !proxyErrors.has(errorText)) {
    return { class: 'not_actionable', message: `Could not open ${url}: ${errorText}.`, details: { url, errorText } }
  }
  return {
    class: 'setup_failed',
    message: `Could not open ${url} through the proxy ${proxy}: ${errorText}. The proxy failed, not the app.`,
    details: { url, errorText, proxy },
  }
}

/** Collects the main frame's navigation events from the moment it is made, so none can arrive before Retest listens. */
class NavigationWatcher {
  readonly #session: CdpSession
  readonly #loaded = new Set<string>()
  // The loader ids of the main frame's documents, in the order they committed.
  readonly #committed: string[] = []
  // Documents restored from the back-forward cache, which never load again.
  readonly #restored = new Set<string>()
  #unreachable: string | undefined
  // The address of a navigation of the whole document that began since the watcher was made and has not committed,
  // and of one the browser gave up: the frame stopped loading before it committed, as for a 204 or a download.
  #started: string | undefined
  #abandoned: string | undefined
  readonly #stops: (() => void)[]
  #movedWithinDocument = false
  #waiting: { done: () => boolean; settle: (outcome: Outcome) => void } | undefined

  constructor({ session, mainFrameId }: NavigationContext) {
    this.#session = session
    const stopped = (reason: string): void => this.#waiting?.settle({ kind: 'stopped', reason })
    this.#stops = [
      session.on('Page.lifecycleEvent', (params) => {
        const event = readProtocol(lifecycleSchema, params, this.#source('Page.lifecycleEvent'))
        if (event.name !== 'load') return
        this.#loaded.add(event.loaderId)
        this.#check()
      }),
      session.on('Page.frameNavigated', (params) => {
        const { frame, type } = readProtocol(committedSchema, params, this.#source('Page.frameNavigated'))
        if (frame.parentId !== undefined) return
        this.#committed.push(frame.loaderId)
        if (type === 'BackForwardCacheRestore') this.#restored.add(frame.loaderId)
        this.#unreachable = frame.unreachableUrl
        this.#started = undefined
        this.#abandoned = undefined
        this.#check()
      }),
      session.on('Page.frameStartedNavigating', (params) => {
        const { frameId, url, navigationType } = readProtocol(startedSchema, params, this.#source('Page.frameStartedNavigating'))
        if (frameId === mainFrameId() && !withinDocument.has(navigationType)) this.#started = url
      }),
      session.on('Page.frameStoppedLoading', (params) => {
        const { frameId } = readProtocol(stoppedSchema, params, this.#source('Page.frameStoppedLoading'))
        if (frameId !== mainFrameId() || this.#started === undefined) return
        this.#abandoned = this.#started
        this.#started = undefined
        this.#check()
      }),
      session.on('Page.navigatedWithinDocument', (params) => {
        const { frameId } = readProtocol(sameDocumentSchema, params, this.#source('Page.navigatedWithinDocument'))
        if (frameId !== mainFrameId()) return
        this.#movedWithinDocument = true
        this.#check()
      }),
      session.onDetach(stopped),
      session.onBlock(stopped),
    ]
  }

  /**
   * Waits for the `load` event of the document `loaderId` names. Once that document has committed, a later
   * document of the main frame can only have replaced it, so the load of the latest one counts instead.
   */
  loaded(loaderId: string, deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => this.#loaded.has(this.#latest(loaderId)), deadline)
  }

  /** Waits for the browser to report a navigation within the main frame's document, which comes after its answer. */
  movedWithinDocument(deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => this.#movedWithinDocument, deadline)
  }

  /**
   * Waits for a navigation the watcher did not start itself to settle: a move within the document, the latest
   * document committed since the watcher was made, once it has loaded or was restored from the cache, or a navigation
   * the browser gave up.
   */
  settled(deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => {
      const latest = this.#committed.at(-1)
      return this.#abandoned !== undefined || this.#movedWithinDocument || (latest !== undefined && (this.#loaded.has(latest) || this.#restored.has(latest)))
    }, deadline)
  }

  /** The address of a navigation of the whole document the browser gave up since the watcher was made, if any. */
  get abandoned(): string | undefined {
    return this.#abandoned
  }

  /**
   * Waits up to `graceMs` for a document the browser restores from its back-forward cache to commit after loading
   * stopped, which ends the navigation `abandoned` named. Settles at once when nothing was given up.
   */
  restored(graceMs: number, deadline: Deadline): Promise<Outcome> {
    const grace = new Deadline(Math.min(graceMs, deadline.remainingMs), deadline.signal === undefined ? {} : { signal: deadline.signal })
    return this.#wait(() => {
      const latest = this.#committed.at(-1)
      return this.#abandoned === undefined && latest !== undefined && (this.#loaded.has(latest) || this.#restored.has(latest))
    }, grace).then((outcome) => (outcome.kind === 'timeout' ? { kind: 'done' } : outcome))
  }

  /** The address the latest document committed since the watcher was made could not reach, when it is an error page. */
  get unreachable(): string | undefined {
    return this.#unreachable
  }

  stop(): void {
    for (const stop of this.#stops) stop()
    this.#waiting?.settle({ kind: 'timeout' })
  }

  #wait(done: () => boolean, deadline: Deadline): Promise<Outcome> {
    if (done()) return Promise.resolve({ kind: 'done' })
    const stopped = this.#session.detachReason ?? this.#session.blockReason
    if (stopped !== undefined) return Promise.resolve({ kind: 'stopped', reason: stopped })
    const { signal } = deadline
    const aborted = (): CdpAbortedError => new CdpAbortedError(this.#source('Page.navigate'), { written: true })
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

  #check(): void {
    if (this.#waiting?.done()) this.#waiting.settle({ kind: 'done' })
  }

  #source(method: string): { method: string; sessionId: string } {
    return { method, sessionId: this.#session.id }
  }
}
