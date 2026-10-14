import type { OwnedPage } from '../browser/contract.ts'
import type { RouteRefusal } from '../browser/routes.ts'
import type { Failure } from '../protocol/failures.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { RouteAnswerSummary, RouteReply, RouteRequest } from '../protocol/routes.ts'
import type { TestHost } from './dialogs.ts'
import { originAndPath } from '../browser/page-url.ts'
import { smallestBudget } from '../protocol/deadline.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage, failure, withLocation } from '../protocol/failures.ts'
import { describeRoutePattern, routeRequestProblem, summarizeRouteAnswer } from '../protocol/routes.ts'
import { shorten } from '../protocol/text.ts'
import { NativePageAdapter } from './native-pool.ts'

type RouteMessage = Extract<ChildMessage, { type: 'route' }>

/**
 * The parent's side of a test's routes. A change goes to the app's page, which answers once Chrome holds what the
 * change asks for, so the test's next command meets it; the answer goes back to the test process, and every change,
 * made or refused, is written down as a `route` event. The routes end with the page: a test's own pages close as it
 * ends, and Retest removes nothing before then. A refused change is the parent's own failure, as a refused wait for a
 * file is, which fails the test whatever its process claims; so is a request whose route's answer Chrome refused, which
 * the page failed in its place. A pattern is redacted whole before it is cut, so no part of a secret is left at the cut.
 */
export class TestRoutes {
  readonly #host: TestHost
  readonly #running = new Set<number>()

  constructor(host: TestHost) {
    this.#host = host
  }

  /** Hears each request of an app's page whose route's answer Chrome refused. Returns a function that stops listening. */
  watch(app: string, page: OwnedPage): () => void {
    return page.onRouteRefused?.((refusal) => this.#refused(app, refusal)) ?? (() => undefined)
  }

  receive(message: RouteMessage): void {
    if (message.testId !== this.#host.testId || message.attemptId !== this.#host.attemptId) return this.#host.violation('sent a route for an inactive test attempt')
    if (this.#running.has(message.id)) return this.#host.violation(`sent route ${message.id} again while the first was still running`)
    const page = this.#host.page(message.app)
    if (page === undefined) return this.#host.violation(`sent a route for the app ${JSON.stringify(message.app)}, which this test does not use`)
    this.#running.add(message.id)
    void this.#change(message, page)
      .catch((error: unknown): RouteReply => ({ ok: false, failure: failure('setup_failed', `Retest could not change the routes: ${errorMessage(error)}`) }))
      .then((reply) => {
        this.#running.delete(message.id)
        this.#settle(message, reply)
      })
  }

  async #change({ app, request, timeoutMs, location }: RouteMessage, page: OwnedPage): Promise<RouteReply> {
    const refusal = this.#host.refusal()
    if (refusal !== undefined) return { ok: false, failure: withLocation(refusal, location) }
    const problem = routeRequestProblem(request)
    if (problem !== undefined) return { ok: false, failure: problem }
    const remaining = this.#host.remainingMs()
    const budget = Math.max(1, remaining === undefined ? timeoutMs : smallestBudget(timeoutMs, remaining))
    if (request.kind === 'add') {
      if (page.addRoute === undefined) return { ok: false, failure: noRoutes(app, page) }
      const added = await page.addRoute(request.pattern, request.answer, budget)
      return added.ok ? { ok: true, kind: 'added' } : added
    }
    if (page.removeRoute === undefined) return { ok: false, failure: noRoutes(app, page) }
    const removed = await page.removeRoute(request.pattern, budget)
    if (!removed.ok) return removed
    if (removed.removed === 0) return { ok: false, failure: { ...failure('usage', `page.unroute(${describeRoutePattern(request.pattern)}) matches no route of this page. Pass the pattern the route was added with, as it was written.`), details: { removed: 0 } } }
    return { ok: true, kind: 'removed', removed: removed.removed }
  }

  // A change is written down whether it was made or refused, then answered, its failure redacted, if anyone still waits.
  #settle(message: RouteMessage, reply: RouteReply): void {
    const placed: RouteReply = reply.ok ? reply : { ok: false, failure: withLocation(reply.failure, message.location) }
    this.#emit(message, placed)
    if (!this.#host.answerable()) return
    if (!placed.ok) this.#host.observe(placed.failure)
    this.#host.send({ type: 'route-result', id: message.id, answer: placed.ok ? placed : { ok: false, failure: redacted(placed.failure, this.#host.redact) } })
  }

  #emit({ app, request, stepId, location }: RouteMessage, reply: RouteReply): void {
    const { testId, attemptId } = this.#host
    this.#host.emit({
      type: 'route',
      testId,
      attemptId,
      ...(stepId === undefined ? {} : { stepId }),
      session: app,
      sessionId: formatSessionId(attemptId, app),
      operation: request.kind,
      pattern: this.#written(describeRoutePattern(request.pattern)),
      ...answerOf(request),
      ...(reply.ok && reply.kind === 'removed' ? { removed: reply.removed } : {}),
      ...(location === undefined ? {} : { location }),
      ...(reply.ok ? {} : { failure: redacted(reply.failure, this.#host.redact) }),
    })
  }

  // A request the route matched, whose answer Chrome would not take: the page failed it instead, so the test's own answer
  // never reached the page, and the test fails for it.
  #refused(app: string, { pattern, url, reason }: RouteRefusal): void {
    const { testId, attemptId } = this.#host
    const parsed = URL.parse(url)
    const address = this.#host.redact(parsed === null ? url : originAndPath(parsed))
    const written = this.#written(pattern)
    const problem: Failure = {
      ...failure('setup_failed', this.#host.redact(`Chrome refused the answer page.route(${pattern}) gave a request for ${address}: ${reason}. Retest failed the request in its place, so the page saw a network error.`)),
      details: { url: address },
    }
    this.#host.emit({ type: 'route', testId, attemptId, ...stepOf(this.#host.stepId()), session: app, sessionId: formatSessionId(attemptId, app), operation: 'answer', pattern: written, url: address, failure: problem })
    if (this.#host.answerable()) this.#host.observe(problem)
  }

  // A pattern as an event records it: redacted whole, then cut as messages cut text.
  #written(pattern: string): string {
    return shorten(this.#host.redact(pattern))
  }
}

function stepOf(stepId: string | undefined): { stepId?: string } {
  return stepId === undefined ? {} : { stepId }
}


function answerOf(request: RouteRequest): { answer?: RouteAnswerSummary } {
  return request.kind === 'add' ? { answer: summarizeRouteAnswer(request.answer) } : {}
}

function redacted(problem: Failure, redact: (text: string) => string): Failure {
  return { ...problem, message: redact(problem.message) }
}

// A native app has no network a route can answer for; any other page without routes belongs to an engine that refuses
// them, and says so itself.
function noRoutes(app: string, page: OwnedPage): Failure {
  if (page instanceof NativePageAdapter) return failure('unsupported', `${app} is a native app, and page.route() answers the requests of a web page.`)
  return failure('unsupported', `The page of ${app} cannot answer its requests with routes.`)
}
