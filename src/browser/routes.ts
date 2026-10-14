import type { CdpSession } from './cdp/session.ts'
import type { RequestResult } from './contract.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { AbortReason, RouteAnswerRecord, RoutePattern } from '../protocol/routes.ts'
import { STATUS_CODES } from 'node:http'
import { errorMessage } from '../protocol/failures.ts'
import { describeRoutePattern, routeMatches, samePattern } from '../protocol/routes.ts'
import { s } from '../protocol/schema.ts'
import { CdpProtocolError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { Listeners } from './listeners.ts'

// Mocked responses on a Chromium page, through the page's own Fetch domain: Chrome holds each request whose address
// matches a pattern Retest gave it, before it is sent, and Retest answers it with the route's response, refuses it with
// the route's error, or lets it go on to the network unchanged, through the context's proxy as any request goes. Only
// the page's session is intercepted: the frames that run in the page's process are covered, and a frame of another site
// and the empty documents `origin-document.ts` serves on a tab of their own are not. A request a service worker answers
// for the page never reaches the page's Fetch domain.

/** How a route's change reached the page: the route is in place, or how many went, or why nothing changed. */
export type RouteRemoval = { readonly ok: true; readonly removed: number } | { readonly ok: false; readonly failure: Failure }

/** A route as a page holds it: what it matches and answers, and how the report names it. */
type Route = { readonly pattern: RoutePattern; readonly answer: RouteAnswerRecord; readonly described: string }

// Chrome's names for the errors a refusal fails a request with.
const errorReasons: Readonly<Record<AbortReason, string>> = {
  aborted: 'Aborted',
  accessdenied: 'AccessDenied',
  addressunreachable: 'AddressUnreachable',
  blockedbyclient: 'BlockedByClient',
  blockedbyresponse: 'BlockedByResponse',
  connectionaborted: 'ConnectionAborted',
  connectionclosed: 'ConnectionClosed',
  connectionfailed: 'ConnectionFailed',
  connectionrefused: 'ConnectionRefused',
  connectionreset: 'ConnectionReset',
  failed: 'Failed',
  internetdisconnected: 'InternetDisconnected',
  namenotresolved: 'NameNotResolved',
  timedout: 'TimedOut',
}

const pausedSchema = s.object({ requestId: s.string(), request: s.object({ url: s.string() }), networkId: s.optional(s.string()) })
// The most request hops a page remembers as answered by a route, for the diagnostics of a page that makes very many.
const rememberedLimit = 10_000
// How long Chrome may take to accept an answer to a held request, which goes to the browser, not the page.
const answerMs = 10_000

/**
 * A request a route matched whose answer Chrome refused: the route's pattern as the test wrote it, the request's
 * address, and Chrome's reason. Retest failed the request in its place, so it was not left held.
 */
export type RouteRefusal = { readonly pattern: string; readonly url: string; readonly reason: string }

/** What a route did to one hop of a request, for the page's diagnostics: its pattern, and Chrome's reason when it refused the route's answer. */
export type RouteMark = { readonly route: string; readonly refused?: string }

type FetchPattern = { urlPattern: string; requestStage: 'Request' }

/**
 * The routes of a page and of the popups it opens, which share them: a route added or removed through any of them
 * applies to all. Later routes answer before earlier ones. A change takes effect once Chrome holds what it asks for,
 * one change at a time.
 */
export class RouteTable {
  #routes: readonly Route[] = []
  readonly #pages = new Set<PageRoutes>()
  #changing: Promise<unknown> = Promise.resolve()

  /** The route that answers a request to `url`: the latest added whose pattern matches it, or none. */
  match(url: string): Route | undefined {
    return this.#routes.findLast((route) => routeMatches(route.pattern, url))
  }

  /** What Chrome is asked to hold for the routes the table holds now. */
  patterns(): FetchPattern[] {
    return patternsOf(this.#routes)
  }

  join(page: PageRoutes): () => void {
    this.#pages.add(page)
    return () => this.#pages.delete(page)
  }

  add(route: Route, from: PageRoutes, deadline: Deadline): Promise<void> {
    return this.#change(() => [...this.#routes, route], from, deadline)
  }

  async remove(pattern: RoutePattern, from: PageRoutes, deadline: Deadline): Promise<number> {
    let removed = 0
    await this.#change(() => {
      const kept = this.#routes.filter((route) => !samePattern(route.pattern, pattern))
      removed = this.#routes.length - kept.length
      return removed === 0 ? undefined : kept
    }, from, deadline)
    return removed
  }

  // The page that made the change answers for it, and the table holds the change only once Chrome holds it there, so a
  // change Chrome did not confirm leaves the routes as they were. Another page that fails to follow has closed or is
  // closing.
  #change(next: () => readonly Route[] | undefined, from: PageRoutes, deadline: Deadline): Promise<void> {
    const changed = this.#changing.then(async () => {
      const routes = next()
      if (routes === undefined) return
      const patterns = patternsOf(routes)
      await from.follow(deadline, patterns)
      this.#routes = routes
      await Promise.all([...this.#pages].filter((page) => page !== from).map((page) => page.follow(deadline, patterns).catch(() => undefined)))
    })
    this.#changing = changed.catch(() => undefined)
    return changed
  }
}

/**
 * One page's half of its routes: it answers each request Chrome holds for it from the table it shares, and asks Chrome
 * to hold what the table asks for. It remembers which hop of which request a route answered, by the id the network
 * events give the request and the hop's address, for the page's diagnostics, and tells of an answer Chrome refused.
 */
export class PageRoutes {
  readonly table: RouteTable
  readonly #session: CdpSession
  // The patterns Chrome was last asked to hold, as text, so a change that asks for the same sends nothing.
  #holding = ''
  readonly #marks = new Map<string, RouteMark>()
  readonly #refusals: Listeners<RouteRefusal>
  readonly #stops: (() => void)[] = []

  constructor(session: CdpSession, table: RouteTable, onListenerError: (error: unknown) => void) {
    this.#session = session
    this.table = table
    this.#refusals = new Listeners(onListenerError)
    this.#stops.push(table.join(this), session.on('Fetch.requestPaused', (params) => this.#paused(params)), session.onDetach(() => this.dispose()))
  }

  /**
   * Asks Chrome to hold what `patterns` name, those of the table's routes unless given, or nothing once there are none.
   * The command goes out as this is called, so a page set up in one pipeline before it runs holds its first request.
   */
  follow(deadline: Deadline, patterns: FetchPattern[] = this.table.patterns()): Promise<void> {
    const holding = JSON.stringify(patterns)
    if (holding === this.#holding) return Promise.resolve()
    const previous = this.#holding
    this.#holding = holding
    const sent = patterns.length === 0 ? request(this.#session, 'Fetch.disable', undefined, s.object({}), sendOptions(deadline)) : request(this.#session, 'Fetch.enable', { patterns }, s.object({}), sendOptions(deadline))
    return sent.then(
      () => undefined,
      (error: unknown) => {
        if (this.#holding === holding) this.#holding = previous
        throw error
      },
    )
  }

  /**
   * Adds a route to the page's table, in place once Chrome holds what it matches, within `timeoutMs`. Its pattern is
   * written whole, as the test wrote it; whoever records it redacts it before cutting it.
   *
   * @example await routes.add('https://example.com/api/tasks', { status: 200, body: '[]' }, deadline)
   */
  async add(pattern: RoutePattern, answer: RouteAnswerRecord, deadline: Deadline): Promise<RequestResult> {
    await this.table.add({ pattern, answer, described: describeRoutePattern(pattern) }, this, deadline)
    return { ok: true }
  }

  /** Removes every route of the table added with `pattern`, and says how many went, once Chrome holds the change. */
  async remove(pattern: RoutePattern, deadline: Deadline): Promise<RouteRemoval> {
    return { ok: true, removed: await this.table.remove(pattern, this, deadline) }
  }

  /** What a route did to the hop of the request the network events name `requestId` that went to `url`, or undefined. */
  answeredBy(requestId: string, url: string): RouteMark | undefined {
    return this.#marks.get(hopKey(requestId, url))
  }

  /** Tells of each request whose route's answer Chrome refused. Returns a function that stops listening. */
  onRefused(listener: (refusal: RouteRefusal) => void): () => void {
    return this.#refusals.add(listener)
  }

  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop()
    this.#refusals.clear()
  }

  // A request Chrome held: answered by the latest route that matches it, or let go on unchanged. Each hop of a redirect
  // is held on its own, under the same network id, so a hop is named by that id and its address.
  #paused(params: unknown): void {
    const { requestId, request: held, networkId } = readProtocol(pausedSchema, params, { method: 'Fetch.requestPaused', sessionId: this.#session.id })
    const route = this.table.match(held.url)
    if (route === undefined) return void this.#send('Fetch.continueRequest', { requestId }).catch(ignore)
    const hop = networkId === undefined ? undefined : hopKey(networkId, held.url)
    if (hop !== undefined) this.#remember(hop, { route: route.described })
    const { answer } = route
    const given = 'abort' in answer ? this.#send('Fetch.failRequest', { requestId, errorReason: errorReasons[answer.abort] }) : this.#send('Fetch.fulfillRequest', fulfilment(requestId, answer))
    given.catch((error: unknown) => this.#refused({ requestId, url: held.url, route, hop, error }))
  }

  // An answer Chrome would not take, as one whose status it has no phrase for, must not leave the request held: the
  // request is failed in its place. A request the page cancelled meanwhile cannot be failed either, and is no refusal.
  async #refused({ requestId, url, route, hop, error }: Refused): Promise<void> {
    try {
      await this.#send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
    } catch {
      return
    }
    const reason = error instanceof CdpProtocolError ? error.protocolMessage : errorMessage(error)
    if (hop !== undefined) this.#remember(hop, { route: route.described, refused: reason })
    this.#refusals.emit({ pattern: route.described, url, reason })
  }

  #send(method: string, params: object): Promise<unknown> {
    return this.#session.send(method, params, { timeoutMs: answerMs })
  }

  #remember(hop: string, mark: RouteMark): void {
    if (!this.#marks.has(hop) && this.#marks.size >= rememberedLimit) {
      const oldest = this.#marks.keys().next().value
      if (oldest !== undefined) this.#marks.delete(oldest)
    }
    this.#marks.set(hop, mark)
  }
}

/** A held request whose route's answer Chrome refused, and the hop the diagnostics know it by. */
type Refused = { requestId: string; url: string; route: Route; hop: string | undefined; error: unknown }

function hopKey(networkId: string, url: string): string {
  return `${networkId} ${url}`
}

function patternsOf(routes: readonly Route[]): FetchPattern[] {
  const held = routes.some((route) => typeof route.pattern !== 'string') ? ['*'] : routes.map((route) => fetchPattern(route.pattern))
  return [...new Set(held)].map((urlPattern) => ({ urlPattern, requestStage: 'Request' }))
}

// Chrome has a phrase of its own for the statuses it knows, and refuses a status it has none for unless it is given
// one, so every answer carries the standard phrase, or `Status 599` for a status with none.
function fulfilment(requestId: string, answer: Exclude<RouteAnswerRecord, { abort: AbortReason }>): object {
  const responseCode = answer.status ?? 200
  return { requestId, responseCode, responsePhrase: STATUS_CODES[responseCode] ?? `Status ${responseCode}`, responseHeaders: headersOf(answer), body: bodyOf(answer) }
}

function ignore(): void {
  // The page closed or cancelled the request; nothing waits for it.
}

/**
 * The refusal an engine without mocked responses gives `page.route()` and `page.unroute()`, naming it. Nothing changes.
 *
 * @example routesRefused('on Firefox').message // 'page.route() is not available on Firefox yet. Retest answers requests on Chrome, Chromium and Edge.'
 */
export function routesRefused(where: string): Failure {
  return { class: 'unsupported', message: `page.route() is not available ${where} yet. Retest answers requests on Chrome, Chromium and Edge.` }
}

/**
 * The pattern Chrome is asked to hold for a route: for a glob, any run of stars becomes Chrome's own wildcard, which
 * crosses a `/` too, so Chrome holds at least what the glob matches and Retest's own match decides; `?` and `\` are
 * Chrome's to escape. A regular expression has no pattern of Chrome's, so every request is held.
 *
 * @example fetchPattern('https://example.com/api/**') // 'https://example.com/api/*'
 */
export function fetchPattern(pattern: RoutePattern): string {
  if (typeof pattern !== 'string') return '*'
  return pattern.replace(/[?\\]/g, '\\$&').replace(/\*+/g, '*')
}

function headersOf(answer: Exclude<RouteAnswerRecord, { abort: AbortReason }>): { name: string; value: string }[] {
  const given = Object.entries(answer.headers ?? {}).filter(([name]) => answer.contentType === undefined || name.toLowerCase() !== 'content-type')
  const typed = answer.contentType === undefined ? [] : [['Content-Type', answer.contentType] as const]
  return [...given, ...typed].map(([name, value]) => ({ name, value }))
}

function bodyOf(answer: Exclude<RouteAnswerRecord, { abort: AbortReason }>): string {
  return answer.base64 ?? Buffer.from(answer.body ?? '', 'utf8').toString('base64')
}
