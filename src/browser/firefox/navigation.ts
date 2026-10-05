import type { CdpSession } from '../cdp/session.ts'
import type { Dispatch } from '../dispatch.ts'
import type { CommandResult } from '../../protocol/commands.ts'
import type { Failure } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { parse, s } from '../../protocol/schema.ts'
import { isWebUrl } from '../../protocol/url.ts'
import { CdpAbortedError, CdpProtocolError, CdpTimeoutError } from '../cdp/errors.ts'
import { readProtocol } from '../cdp-results.ts'
import { connectionEnded } from '../command-failures.ts'
import { originAndPath } from '../page-url.ts'

/**
 * What navigation needs from a Firefox page: the session its commands are counted through, its browsing context, its
 * base URL, its address as last committed, a watcher of its navigation events from now on, a reading of the document's
 * own address for a move within it, and `opened`, which hears the navigation a command started as soon as Firefox
 * names it.
 */
export type FirefoxNavigationContext = {
  session: CdpSession
  context: string
  baseUrl: string | undefined
  currentUrl: () => URL | undefined
  watch: () => NavigationWatcher
  movedWithin: () => Promise<void>
  opened?: (navigation: string) => void
}

type Outcome = { kind: 'done' } | { kind: 'timeout' } | { kind: 'stopped'; reason: string }

const startedSchema = s.object({ navigation: s.nullable(s.string()), url: s.string() })

// What Firefox answers a navigation it refused at once, such as one to a blocked port: an error that names the reason
// in its own words, which is all of it Retest keeps.
const refusedNavigation = /^unknown error: ([A-Za-z]+)$/

/**
 * Opens a URL in the tab and waits for the `load` event of the document it returned, or of a document that replaced it
 * before it loaded, as a client-side redirect does. A move to another fragment of the document is complete once
 * Firefox reports it. A navigation Firefox answers with its error page fails, naming Firefox's reason, once that page
 * is shown, so a screenshot can show it. One whose response opens no document, no content or a download, fails at
 * once, as a reload or a move through the history onto one does.
 */
export async function navigate(page: FirefoxNavigationContext, url: string, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const target = resolveTarget(url, page.baseUrl)
  if (!target.ok) return target
  const address = target.url
  const watcher = page.watch()
  try {
    let started: { navigation: string | null; url: string } | { refused: string }
    try {
      started = await dispatch.attempt(async (attempt) => {
        try {
          const answer = await attempt.send(page.session, 'browsingContext.navigate', { context: page.context, url: address.href, wait: 'none' }, deadline)
          return readProtocol(startedSchema, answer, { method: 'browsingContext.navigate', sessionId: page.session.id })
        } catch (error) {
          const refused = error instanceof CdpProtocolError ? refusedNavigation.exec(error.protocolMessage)?.[1] : undefined
          if (refused === undefined) throw error
          return { refused }
        }
      }, () => true)
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(address, deadline)
      throw error
    }
    if ('refused' in started) {
      // Firefox shows its error page as a document of its own; waiting for it lets a screenshot show it.
      await watcher.errorPage(new Deadline(Math.min(errorPageWaitMs, deadline.remainingMs), deadline.signal === undefined ? {} : { signal: deadline.signal }))
      return { ok: false, failure: navigationFailed(address, started.refused) }
    }
    if (started.navigation !== null) page.opened?.(started.navigation)
    const outcome = await watcher.loaded(started.navigation, deadline)
    if (outcome.kind === 'timeout') return notLoaded(address, deadline)
    if (outcome.kind === 'stopped') return { ok: false, failure: connectionEnded(`open ${originAndPath(address)}`, true, outcome.reason) }
    const abandoned = watcher.abandoned
    if (abandoned !== undefined) {
      const current = page.currentUrl()
      return { ok: false, failure: gaveUp('open', abandoned, current === undefined ? 'the page' : originAndPath(current)) }
    }
    const unreachable = watcher.unreachable
    if (unreachable !== undefined) return { ok: false, failure: navigationFailed(address, unreachable) }
    return { ok: true, kind: 'goto', url: originAndPath(page.currentUrl() ?? address) }
  } finally {
    watcher.stop()
  }
}

/** Reloads the tab's document and waits for the `load` event of the document that replaces it. */
export async function reload(page: FirefoxNavigationContext, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const current = page.currentUrl()
  const watcher = page.watch()
  try {
    try {
      const answer = await dispatch.send(page.session, 'browsingContext.reload', { context: page.context, wait: 'none' }, deadline)
      const started = parse(startedSchema, answer)
      if (started.ok && started.value.navigation !== null) page.opened?.(started.value.navigation)
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(current, deadline)
      throw error
    }
    return await opened(page, watcher, { kind: 'reload', verb: 'reload', expected: current }, deadline)
  } finally {
    watcher.stop()
  }
}

/** Which way `traverse` moves through the tab's history. */
export type Traversal = 'goBack' | 'goForward'

/**
 * Moves the tab one entry back or forward in its history and waits as `navigate` does: for the `load` event of the
 * document it opens, or for a move within the document. Firefox keeps no page in its back-forward cache under Retest,
 * so a document is always loaded again. A tab with no entry that way fails `not_actionable` and sends nothing: Firefox
 * refuses the command without moving.
 */
export async function traverse(page: FirefoxNavigationContext, direction: Traversal, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
  const back = direction === 'goBack'
  const watcher = page.watch()
  try {
    let moved: boolean
    try {
      moved = await dispatch.attempt(async (attempt) => {
        try {
          await attempt.send(page.session, 'browsingContext.traverseHistory', { context: page.context, delta: back ? -1 : 1 }, deadline)
          return true
        } catch (error) {
          if (error instanceof CdpProtocolError && error.protocolMessage === 'no such history entry') return false
          throw error
        }
      }, (answer) => answer)
    } catch (error) {
      if (error instanceof CdpTimeoutError) return notLoaded(page.currentUrl(), deadline)
      throw error
    }
    if (!moved) {
      const where = back ? 'back: the page has no earlier' : 'forward: the page has no later'
      return { ok: false, failure: { class: 'not_actionable', message: `Could not go ${where} entry in its history, so Retest sent nothing.` } }
    }
    // Firefox answers a move through the history once its document has committed, and tells no event for a move
    // within the document, so a move that started no navigation stayed in it.
    if (!watcher.startedAny) {
      await page.movedWithin()
      const url = page.currentUrl()
      return { ok: true, kind: direction, url: url === undefined ? 'the page' : originAndPath(url) }
    }
    return await opened(page, watcher, { kind: direction, verb: back ? 'go back to' : 'go forward to', expected: page.currentUrl() }, deadline)
  } finally {
    watcher.stop()
  }
}

type Opening = { kind: 'reload' | Traversal; verb: string; expected: URL | undefined }

async function opened(page: FirefoxNavigationContext, watcher: NavigationWatcher, { kind, verb, expected }: Opening, deadline: Deadline): Promise<CommandResult> {
  const outcome = await watcher.settled(deadline)
  if (outcome.kind === 'timeout') return notLoaded(page.currentUrl() ?? expected, deadline)
  const url = page.currentUrl() ?? expected
  const address = url === undefined ? 'the page' : originAndPath(url)
  if (outcome.kind === 'stopped') return { ok: false, failure: connectionEnded(`${verb} ${address}`, true, outcome.reason) }
  const abandoned = watcher.abandoned
  if (abandoned !== undefined) return { ok: false, failure: gaveUp(verb, abandoned, address) }
  const unreachable = watcher.unreachable
  if (unreachable !== undefined) return { ok: false, failure: { class: 'not_actionable', message: `Could not ${verb} ${address}: Firefox showed its error page instead, ${unreachable}.`, details: { url: address, errorText: unreachable } } }
  return { ok: true, kind, url: address }
}

// The words Chromium's driver uses for a navigation the browser gave up, which mean the same here.
function gaveUp(verb: string, asked: string, stayed: string): Failure {
  const shown = originAndPath(URL.parse(asked) ?? new URL('about:blank'))
  const message = `Could not ${verb} ${shown}: the browser sent the request and gave the navigation up without opening a document, as it does for a response with no content or a download. The page stayed on ${stayed}.`
  return { class: 'not_actionable', message, details: { url: shown, inputSent: true } }
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

function navigationFailed(address: URL, errorText: string): Failure {
  const url = originAndPath(address)
  return { class: 'not_actionable', message: `Could not open ${url}: ${errorText}.`, details: { url, errorText } }
}

// How long a refused navigation waits for Firefox's error page to show before it answers.
const errorPageWaitMs = 1000

/**
 * The reason Firefox's error page names in its address, such as `connectionFailure` in
 * `about:neterror?e=connectionFailure&u=…`, or undefined for any other page.
 *
 * @example errorPageReason('about:neterror?e=dnsNotFound&u=http%3A//nowhere.invalid/') // 'dnsNotFound'
 */
export function errorPageReason(url: string): string | undefined {
  if (!url.startsWith('about:neterror') && !url.startsWith('about:certerror')) return undefined
  return URL.parse(url)?.searchParams.get('e') ?? 'the page could not be reached'
}

/**
 * Collects the tab's navigation events from the moment it is made, so none can arrive before Retest listens. The page
 * hands it each event it reads: a navigation Firefox started, a document committing (the document of a navigation, or
 * one no navigation announced), a document's content loaded at an address, its load, a navigation Firefox gave up, a
 * move within the document, and the page becoming unable to answer.
 */
export class NavigationWatcher {
  readonly #started: string[] = []
  readonly #committed: string[] = []
  readonly #loaded = new Set<string>()
  readonly #failed = new Set<string>()
  readonly #errorPages = new Map<string, string>()
  readonly #abandoned = new Map<string, string>()
  readonly #onStop: () => void
  #moved = false
  #waiting: { done: () => boolean; settle: (outcome: Outcome) => void } | undefined
  #stopReason: string | undefined

  constructor(onStop: () => void) {
    this.#onStop = onStop
  }

  /** True once a navigation of the whole document started since the watcher was made. */
  get startedAny(): boolean {
    return this.#started.length > 0
  }

  /**
   * The address the latest navigation started since the watcher was made asked for, when its response opened no
   * document and none committed after it: the browser gave it up, and the page stayed where it was.
   */
  get abandoned(): string | undefined {
    const latest = this.#started.at(-1)
    if (latest === undefined || this.#committed.includes(latest)) return undefined
    return this.#abandoned.get(latest)
  }

  /** Firefox's reason for the error page the latest document committed since the watcher was made is, if it is one. */
  get unreachable(): string | undefined {
    const latest = this.#committed.at(-1)
    return latest === undefined ? undefined : this.#errorPages.get(latest)
  }

  /** Firefox started a navigation of the whole document. */
  onStarted(navigation: string): void {
    this.#started.push(navigation)
    this.#check()
  }

  /** A document committed: the document of `navigation`, or one with an id the page gave it. */
  onCommitted(navigation: string): void {
    this.#committed.push(navigation)
    this.#check()
  }

  /** A document's content loaded at `url`, which for Firefox's error page names the reason. */
  onContentLoaded(navigation: string, url: string): void {
    const reason = errorPageReason(url)
    if (reason !== undefined) this.#errorPages.set(navigation, reason)
    this.#check()
  }

  onLoaded(navigation: string): void {
    this.#loaded.add(navigation)
    this.#check()
  }

  /** The response of `navigation` opened no document, no content or a download, at `url`: the browser gave it up. */
  onAbandoned(navigation: string, url: string): void {
    this.#abandoned.set(navigation, url)
    this.#check()
  }

  /** Firefox gave a navigation up, as it does one a later navigation replaced. */
  onFailed(navigation: string): void {
    this.#failed.add(navigation)
    this.#check()
  }

  onMovedWithinDocument(): void {
    this.#moved = true
    this.#check()
  }

  /** The page closed, was lost, or a prompt holds it: every wait ends at once with the reason. */
  onStopped(reason: string): void {
    this.#stopReason ??= reason
    this.#waiting?.settle({ kind: 'stopped', reason })
  }

  /**
   * Waits for the `load` event of the document of `navigation`, or of a later document that replaced it, or for
   * Firefox's error page shown in its place; a navigation with no id, as to a fragment of the document, waits for the
   * move within it.
   */
  loaded(navigation: string | null, deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => {
      if (this.#moved && (navigation === null || !this.#started.includes(navigation))) return true
      if (navigation !== null && this.#abandoned.has(navigation) && this.abandoned !== undefined) return true
      const latest = this.#latestAfter(navigation)
      return latest !== undefined && (this.#loaded.has(latest) || this.#errorPages.has(latest))
    }, deadline)
  }

  /** Waits for the latest document committed since the watcher was made to load or show an error, or for a move within it. */
  settled(deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => {
      if (this.#moved && this.#started.length === 0) return true
      if (this.abandoned !== undefined) return true
      const latest = this.#committed.at(-1)
      return latest !== undefined && (this.#loaded.has(latest) || this.#errorPages.has(latest))
    }, deadline)
  }

  /** Waits for an error page to commit and show, for a navigation Firefox refused at once; the time it may take is short. */
  errorPage(deadline: Deadline): Promise<Outcome> {
    return this.#wait(() => {
      const latest = this.#committed.at(-1)
      return latest !== undefined && this.#errorPages.has(latest)
    }, deadline)
  }

  stop(): void {
    this.#waiting?.settle({ kind: 'timeout' })
    this.#onStop()
  }

  // The latest document committed since the navigation began: once the navigation's own document committed, or it was
  // given up for another, a later document can only have replaced it.
  #latestAfter(navigation: string | null): string | undefined {
    if (navigation === null) return this.#committed.at(-1)
    const index = this.#started.indexOf(navigation)
    const replaced = this.#committed.includes(navigation) || this.#failed.has(navigation) || index === -1
    if (!replaced) return undefined
    const latest = this.#committed.at(-1)
    if (latest === navigation) return latest
    const later = index === -1 ? this.#committed : this.#committed.filter((committed) => this.#started.indexOf(committed) > index || !this.#started.includes(committed))
    return later.at(-1) ?? (this.#committed.includes(navigation) ? navigation : undefined)
  }

  #wait(done: () => boolean, deadline: Deadline): Promise<Outcome> {
    if (done()) return Promise.resolve({ kind: 'done' })
    if (this.#stopReason !== undefined) return Promise.resolve({ kind: 'stopped', reason: this.#stopReason })
    const { signal } = deadline
    const aborted = (): CdpAbortedError => new CdpAbortedError({ method: 'browsingContext.navigate', sessionId: undefined }, { written: true })
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

  #check(): void {
    if (this.#waiting?.done()) this.#waiting.settle({ kind: 'done' })
  }
}
