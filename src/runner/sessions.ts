import type { Clock } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { failure } from '../protocol/failures.ts'
import { describeValue, isPlainObject } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'

/** The most sessions active at once: for any one owner, and on the whole host. */
export type SessionLimits = { readonly perOwner: number; readonly host: number }

/** Sessions active now: for one owner, and on the whole host. */
export type ActiveSessions = { readonly owner: number; readonly host: number }

/**
 * What an attempt asks for: the owner its sessions count against, how many it needs at once, one for each of its apps,
 * the test it runs, which nothing decides on but a reader of the budget may name, and how long it may wait.
 */
export type SessionRequest = { readonly owner: string; readonly count: number; readonly holder: string; readonly waitMs: number }

/** Sessions an attempt holds until it lets them go: how long it waited, and what was active once they were its. */
export type SessionLease = { readonly waitedMs: number; readonly active: ActiveSessions; release(): void }

/**
 * The answer to a request: a lease, or why there is none, holding nothing. `too_many` is a request no limit could ever
 * grant; `timed_out` waited its whole time; `stopped` was withdrawn when the run stopped. `active` is what the owner
 * and the host held when the answer came.
 */
export type SessionGrant =
  | { readonly ok: true; readonly lease: SessionLease }
  | { readonly ok: false; readonly reason: 'too_many' | 'timed_out' | 'stopped'; readonly waitedMs: number; readonly active: ActiveSessions }

/**
 * A run's place in a session budget. `owner` is the identity the run's sessions count against, a worker or an agent as
 * the host names it; the host vouches for it, and Retest takes it as given. `budget` is shared with every run given the
 * same one. `waitMs` is how long an attempt waits for its sessions before it does not run, the setup budget by default.
 */
export type SessionOptions = { readonly owner: string; readonly budget: SessionBudget; readonly waitMs?: number }

type Waiter = {
  readonly request: SessionRequest
  readonly arrival: number
  readonly startedAt: number
  readonly settle: (grant: SessionGrant) => void
}

/**
 * The browser sessions a host lets run at once, as a budget every run given it draws from. A session is one isolated
 * browser context and its page, not a process. An attempt reserves a session for each of its apps all at once or not
 * at once: it never holds part of what it needs while it waits for the rest. Waiters are served in the order they
 * asked. One that its own owner's limit holds back keeps its place among that owner's waiters and keeps no one else
 * waiting; the first one the host's limit holds back keeps the host's freed sessions for itself, so a request for
 * several is never overtaken forever by requests for one. Every wait is finite, and a stopped run withdraws its own.
 * One budget counts the sessions of the runs in one process; separate processes need separate budgets.
 *
 * @example const budget = new SessionBudget({ perOwner: 4, host: 8 })
 */
export class SessionBudget {
  readonly limits: SessionLimits
  readonly #clock: Clock
  readonly #owners = new Map<string, number>()
  readonly #waiting = new Set<Waiter>()
  readonly #peakOwners = new Map<string, number>()
  #host = 0
  #peakHost = 0
  #arrivals = 0

  /** Throws a `RangeError` for a limit that is not a whole number from 1. */
  constructor(limits: SessionLimits, clock: Clock = monotonicClock) {
    for (const [name, value] of Object.entries({ perOwner: limits.perOwner, host: limits.host })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`The session limit ${name} must be a whole number from 1, received ${describeValue(value)}.`)
    }
    this.limits = Object.freeze({ perOwner: limits.perOwner, host: limits.host })
    this.#clock = clock
  }

  /**
   * Resolves with a lease once every session in `request` is the attempt's, or with why not, holding nothing, when the
   * request could never be granted, its wait runs out, or `stopped` settles first.
   */
  reserve(request: SessionRequest, stopped: Promise<unknown>): Promise<SessionGrant> {
    const { promise, resolve } = Promise.withResolvers<SessionGrant>()
    const startedAt = this.#clock()
    if (request.count > this.limits.perOwner || request.count > this.limits.host) {
      resolve({ ok: false, reason: 'too_many', waitedMs: 0, active: this.#active(request.owner) })
      return promise
    }
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const waiter: Waiter = {
      request,
      arrival: this.#arrivals++,
      startedAt,
      settle: (grant) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#waiting.delete(waiter)
        resolve(grant)
      },
    }
    // A waiter that leaves frees its place, so those behind it are offered what it was keeping.
    const leave = (reason: 'timed_out' | 'stopped'): void => {
      if (settled) return
      waiter.settle({ ok: false, reason, waitedMs: elapsedMs(startedAt, this.#clock), active: this.#active(request.owner) })
      this.#offer()
    }
    this.#waiting.add(waiter)
    this.#offer()
    if (!settled) {
      timer = setTimeout(() => leave('timed_out'), Math.min(request.waitMs, maxTimeout))
      void stopped.then(() => leave('stopped'))
    }
    return promise
  }

  /** The sessions active now, for each owner that holds any and on the whole host, and how many requests wait. */
  snapshot(): { host: number; owners: ReadonlyMap<string, number>; waiting: number } {
    return { host: this.#host, owners: new Map(this.#owners), waiting: this.#waiting.size }
  }

  /** The most sessions ever active at once, on the whole host and for each owner. */
  peak(): { host: number; owners: ReadonlyMap<string, number> } {
    return { host: this.#peakHost, owners: new Map(this.#peakOwners) }
  }

  #active(owner: string): ActiveSessions {
    return { owner: this.#owners.get(owner) ?? 0, host: this.#host }
  }

  #offer(): void {
    let hostFree = this.limits.host - this.#host
    const heldBack = new Set<string>()
    for (const waiter of [...this.#waiting].sort((first, second) => first.arrival - second.arrival)) {
      const { owner, count } = waiter.request
      if (heldBack.has(owner)) continue
      const ownerFree = this.limits.perOwner - (this.#owners.get(owner) ?? 0)
      if (count > ownerFree) {
        heldBack.add(owner)
        continue
      }
      if (count > hostFree) {
        heldBack.add(owner)
        hostFree = 0
        continue
      }
      hostFree -= count
      waiter.settle({ ok: true, lease: this.#take(waiter) })
    }
  }

  #take(waiter: Waiter): SessionLease {
    const { owner, count } = waiter.request
    this.#host += count
    this.#owners.set(owner, (this.#owners.get(owner) ?? 0) + count)
    this.#peakHost = Math.max(this.#peakHost, this.#host)
    this.#peakOwners.set(owner, Math.max(this.#peakOwners.get(owner) ?? 0, this.#owners.get(owner) ?? 0))
    let released = false
    return {
      waitedMs: elapsedMs(waiter.startedAt, this.#clock),
      active: this.#active(owner),
      release: () => {
        if (released) return
        released = true
        this.#host -= count
        const left = (this.#owners.get(owner) ?? count) - count
        if (left > 0) this.#owners.set(owner, left)
        else this.#owners.delete(owner)
        this.#offer()
      },
    }
  }
}

// An owner is a label a host writes, so it is held to what a report line can show.
const longestOwner = 200

/**
 * What is wrong with a `sessions` option, as one usage failure, or undefined when nothing is.
 *
 * @example sessionOptionsProblem({ owner: '', budget })?.class // 'usage'
 */
export function sessionOptionsProblem(value: unknown): Failure | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) return failure('usage', `sessions: expected { owner, budget }, received ${describeValue(value)}.`)
  const problems: string[] = []
  for (const key of Object.keys(value)) if (!['owner', 'budget', 'waitMs'].includes(key) && value[key] !== undefined) problems.push(`sessions.${key}: unknown key`)
  const { owner, budget, waitMs } = value
  if (typeof owner !== 'string' || owner.trim() === '' || owner.length > longestOwner || /[\u0000-\u001f\u007f]/.test(owner)) {
    problems.push(`sessions.owner: expected the owner's name, up to ${longestOwner} characters on one line, received ${describeValue(owner)}`)
  }
  if (!(budget instanceof SessionBudget)) problems.push(`sessions.budget: expected a SessionBudget, received ${describeValue(budget)}`)
  if (waitMs !== undefined && (typeof waitMs !== 'number' || !Number.isInteger(waitMs) || waitMs < 1 || waitMs > maxTimeout)) {
    problems.push(`sessions.waitMs: expected a whole number of milliseconds from 1 to ${maxTimeout}, received ${describeValue(waitMs)}`)
  }
  const [first] = problems
  if (first === undefined) return undefined
  return failure('usage', problems.length === 1 ? first : `The sessions option has ${problems.length} problems:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
}

/**
 * Why an attempt did not get its sessions, as the failure it does not run with.
 *
 * @example sessionRefusal(grant, { owner: 'agent-1', count: 2, holder, waitMs: 5000 }, budget.limits).class // 'setup_failed'
 */
export function sessionRefusal(grant: Extract<SessionGrant, { ok: false }>, request: SessionRequest, limits: SessionLimits): Failure {
  const owner = JSON.stringify(request.owner)
  const needs = `${request.count} ${request.count === 1 ? 'session' : 'sessions'}`
  const details = { owner: request.owner, sessions: request.count, perOwner: limits.perOwner, host: limits.host, ownerActive: grant.active.owner, hostActive: grant.active.host }
  if (grant.reason === 'too_many') {
    const limit = request.count > limits.perOwner ? `the limit of ${limits.perOwner} for each owner` : `the host's limit of ${limits.host}`
    return { ...failure('setup_failed', `Not run: the test needs ${needs} at once, more than ${limit}, so it could never start.`), details }
  }
  const held = `When it gave up, ${owner} held ${grant.active.owner} of ${limits.perOwner} and the host ${grant.active.host} of ${limits.host}.`
  return { ...failure('setup_failed', `Not run: ${needs} for ${owner} did not come free within ${request.waitMs} ms. ${held}`), details: { ...details, waitedMs: grant.waitedMs } }
}
