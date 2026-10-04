import type { Clock } from '../protocol/deadline.ts'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { maxTimeout } from '../protocol/timeouts.ts'

/**
 * What an attempt asks for: the locks its test holds, its place in the run's order, which decides who goes first
 * among those waiting, and the test it runs, which the record of a wait names. `scope` is the run it belongs to, when
 * several runs share the table: a record names only the holders of its own run.
 */
export type LockRequest = { readonly names: readonly string[]; readonly position: number; readonly holder: string; readonly scope?: string }

/**
 * Locks an attempt holds until it lets them go. `heldBy` names the tests of its own run that held one of them when it
 * asked, and `heldElsewhere` counts the locks it needed that another run's tests held then.
 */
export type LockLease = { readonly waitedMs: number; readonly heldBy: readonly string[]; readonly heldElsewhere?: number; release(): void }

/**
 * How long a waiter may wait for what a lease holds once that lease has expired. While every holder of what it waits
 * for is inside its lease, the wait goes on, since each holder is bound to end; only the time it waits behind an
 * expired lease counts.
 */
export type LockBound = { readonly pastLeaseMs: number }

/** Locks a bounded request holds: they can be given back one at a time, and the lease that holds them can expire. */
export type HeldLocks = LockLease & {
  /** Gives back one of the locks, leaving the others held. A lock already given back is left alone. */
  releaseOne(name: string): void
  /** Marks the holder's lease expired, so a waiter held up by what it still holds starts counting against its bound. */
  expire(): void
}

/**
 * The answer to a bounded request: the locks, or why there are none, holding nothing. `timed_out` waited its bound
 * behind an expired lease; `stopped` was withdrawn when the run stopped. `waitingFor` names the locks that were still
 * held when it gave up, and `heldBy` the tests that held them.
 */
export type LockGrant =
  | { readonly ok: true; readonly lease: HeldLocks }
  | {
      readonly ok: false
      readonly reason: 'timed_out' | 'stopped'
      readonly waitedMs: number
      readonly waitingFor: readonly string[]
      readonly heldBy: readonly string[]
      readonly heldElsewhere: number
    }

/** A request still waiting: the test it runs, its run, and the locks it asked for. */
export type WaitingRequest = { readonly holder: string; readonly scope: string | undefined; readonly names: readonly string[] }

type Holders = { heldBy: string[]; heldElsewhere: number }

type Waiter = {
  readonly request: LockRequest
  readonly arrival: number
  readonly startedAt: number
  readonly holders: Holders
  readonly bound: number | undefined
  readonly settle: (grant: LockGrant) => void
  /** Time already counted against the bound, and since when it is being counted now. */
  idleMs: number
  idleFrom: number | undefined
  timer: NodeJS.Timeout | undefined
  /** Set once the waiter holds its locks and its lease has expired. */
  expired: boolean
}

/**
 * The run's shared-state locks. An attempt takes all of its locks at once or none, so no two attempts can each hold
 * what the other waits for. Whenever a lock frees, the waiters are offered their locks in the run's order, the
 * attempt planned first going first; a waiter that cannot have all of its locks yet keeps them from every waiter
 * after it, so a test that holds two locks is never overtaken forever by tests that hold one each. A lock that is
 * free is taken at once, whoever comes later. A bounded request gives up once it has waited its bound behind leases
 * that expired; a lock is any name, so the runner keeps the desktop, devices and data folders here too.
 *
 * @example const lease = await locks.acquire({ names: ['inbox'], position: 3, holder: testId }, stopped)
 */
export class SharedLocks {
  readonly #clock: Clock
  /** Each lock held now, and the waiter it was granted to. */
  readonly #held = new Map<string, Waiter>()
  readonly #waiting = new Set<Waiter>()
  #arrivals = 0

  constructor(clock: Clock = monotonicClock) {
    this.#clock = clock
  }

  /**
   * Resolves with the lease once every lock in `request` is the attempt's. Resolves with undefined, holding nothing,
   * when `stopped` settles first. It waits as long as that takes.
   */
  async acquire(request: LockRequest, stopped: Promise<void>): Promise<LockLease | undefined> {
    const grant = await this.reserve(request, stopped)
    return grant.ok ? grant.lease : undefined
  }

  /**
   * Resolves with the locks once every one in `request` is the attempt's, or with why not, holding nothing: `stopped`
   * settled first, or the request waited `bound.pastLeaseMs` behind leases that had expired. Without a bound it waits
   * until it is served or stopped.
   */
  reserve(request: LockRequest, stopped: Promise<unknown>, bound?: LockBound): Promise<LockGrant> {
    const { promise, resolve } = Promise.withResolvers<LockGrant>()
    const holders = this.#holdersOf(request.names, request.scope)
    let settled = false
    const waiter: Waiter = {
      request,
      arrival: this.#arrivals++,
      startedAt: this.#clock(),
      holders,
      bound: bound === undefined ? undefined : Math.min(Math.max(0, bound.pastLeaseMs), maxTimeout),
      idleMs: 0,
      idleFrom: undefined,
      timer: undefined,
      expired: false,
      settle: (grant) => {
        if (settled) return
        settled = true
        clearTimeout(waiter.timer)
        this.#waiting.delete(waiter)
        resolve(grant)
      },
    }
    this.#waiting.add(waiter)
    this.#offer()
    void stopped.then(() => {
      if (settled) return
      waiter.settle({ ok: false, reason: 'stopped', waitedMs: elapsedMs(waiter.startedAt, this.#clock), ...this.#blocking(waiter) })
      // Its place no longer keeps anyone from the locks it wanted.
      this.#offer()
    })
    return promise
  }

  /** The test that holds each lock now, by lock. */
  holders(): ReadonlyMap<string, string> {
    return new Map([...this.#held].map(([name, waiter]) => [name, waiter.request.holder]))
  }

  /** How many requests wait now. */
  waiting(): number {
    return this.#waiting.size
  }

  /** Every request waiting now, in the order they asked. */
  waiters(): WaitingRequest[] {
    return [...this.#waiting].sort((first, second) => first.arrival - second.arrival).map(({ request }) => ({ holder: request.holder, scope: request.scope, names: [...request.names] }))
  }

  #offer(): void {
    const claimed = new Set<string>()
    for (const waiter of [...this.#waiting].sort(inOrder)) {
      const { names } = waiter.request
      if (names.every((name) => !this.#held.has(name) && !claimed.has(name))) {
        waiter.settle({ ok: true, lease: this.#take(waiter) })
      } else {
        for (const name of names) claimed.add(name)
      }
    }
    this.#reclock()
  }

  // A bounded waiter's time counts only while something it needs is held by an expired lease and nothing it needs is
  // held by a lease still running. A waiter kept back only by an earlier waiter's claim does not count: that waiter
  // either gets its locks, or gives up within its own bound.
  #reclock(): void {
    const now = this.#clock()
    for (const waiter of this.#waiting) {
      if (waiter.bound === undefined) continue
      const holders = waiter.request.names.flatMap((name) => this.#held.get(name) ?? [])
      const counting = holders.some((holder) => holder.expired) && holders.every((holder) => holder.expired)
      if (counting && waiter.idleFrom === undefined) {
        waiter.idleFrom = now
        waiter.timer = setTimeout(() => this.#giveUp(waiter), Math.max(0, waiter.bound - waiter.idleMs))
      } else if (!counting && waiter.idleFrom !== undefined) {
        waiter.idleMs += now - waiter.idleFrom
        waiter.idleFrom = undefined
        clearTimeout(waiter.timer)
      }
    }
  }

  #giveUp(waiter: Waiter): void {
    if (!this.#waiting.has(waiter)) return
    waiter.settle({ ok: false, reason: 'timed_out', waitedMs: elapsedMs(waiter.startedAt, this.#clock), ...this.#blocking(waiter) })
    this.#offer()
  }

  // The locks a waiter could not have, as held by someone now, and who holds them.
  #blocking(waiter: Waiter): { waitingFor: string[] } & Holders {
    const waitingFor = waiter.request.names.filter((name) => this.#held.has(name))
    return { waitingFor, ...this.#holdersOf(waitingFor, waiter.request.scope) }
  }

  // The tests of the asking run that hold any of the names, and how many of the names other runs hold, whose tests a
  // record of this run never names.
  #holdersOf(names: readonly string[], scope: string | undefined): Holders {
    const holding = names.flatMap((name) => this.#held.get(name)?.request ?? [])
    const own = holding.filter((request) => request.scope === scope)
    return { heldBy: [...new Set(own.map((request) => request.holder))], heldElsewhere: holding.length - own.length }
  }

  #take(waiter: Waiter): HeldLocks {
    const { names } = waiter.request
    for (const name of names) this.#held.set(name, waiter)
    const releaseOne = (name: string): void => {
      if (this.#held.get(name) !== waiter) return
      this.#held.delete(name)
      this.#offer()
    }
    const { heldBy, heldElsewhere } = waiter.holders
    return {
      waitedMs: elapsedMs(waiter.startedAt, this.#clock),
      heldBy,
      ...(heldElsewhere === 0 ? {} : { heldElsewhere }),
      release: () => {
        const mine = names.filter((name) => this.#held.get(name) === waiter)
        if (mine.length === 0) return
        for (const name of mine) this.#held.delete(name)
        this.#offer()
      },
      releaseOne,
      expire: () => {
        if (waiter.expired) return
        waiter.expired = true
        this.#reclock()
      },
    }
  }
}

function inOrder(first: Waiter, second: Waiter): number {
  return first.request.position - second.request.position || first.arrival - second.arrival
}
