import type { Clock } from '../protocol/deadline.ts'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'

/**
 * What an attempt asks for: the locks its test holds, its place in the run's order, which decides who goes first
 * among those waiting, and the test it runs, which the record of a wait names.
 */
export type LockRequest = { readonly names: readonly string[]; readonly position: number; readonly holder: string }

/** Locks an attempt holds until it lets them go. `heldBy` names the tests that held one of them when it asked. */
export type LockLease = { readonly waitedMs: number; readonly heldBy: readonly string[]; release(): void }

type Waiter = {
  readonly request: LockRequest
  readonly arrival: number
  readonly startedAt: number
  readonly heldBy: readonly string[]
  readonly grant: (lease: LockLease) => void
}

/**
 * The run's shared-state locks. An attempt takes all of its locks at once or none, so no two attempts can each hold
 * what the other waits for. Whenever a lock frees, the waiters are offered their locks in the run's order, the
 * attempt planned first going first; a waiter that cannot have all of its locks yet keeps them from every waiter
 * after it, so a test that holds two locks is never overtaken forever by tests that hold one each. A lock that is
 * free is taken at once, whoever comes later.
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
   * when `stopped` settles first.
   */
  acquire(request: LockRequest, stopped: Promise<void>): Promise<LockLease | undefined> {
    const { promise, resolve } = Promise.withResolvers<LockLease | undefined>()
    const heldBy = [...new Set(request.names.flatMap((name) => this.#held.get(name)?.request.holder ?? []))]
    let lease: LockLease | undefined
    const waiter: Waiter = {
      request,
      arrival: this.#arrivals++,
      startedAt: this.#clock(),
      heldBy,
      grant: (granted) => {
        lease = granted
        resolve(granted)
      },
    }
    this.#waiting.add(waiter)
    this.#offer()
    void stopped.then(() => {
      if (lease !== undefined) return
      this.#waiting.delete(waiter)
      resolve(undefined)
      // Its place no longer keeps anyone from the locks it wanted.
      this.#offer()
    })
    return promise
  }

  /** The test that holds each lock now, by lock. */
  holders(): ReadonlyMap<string, string> {
    return new Map([...this.#held].map(([name, waiter]) => [name, waiter.request.holder]))
  }

  #offer(): void {
    const claimed = new Set<string>()
    for (const waiter of [...this.#waiting].sort(inOrder)) {
      const { names } = waiter.request
      if (names.every((name) => !this.#held.has(name) && !claimed.has(name))) {
        this.#waiting.delete(waiter)
        waiter.grant(this.#take(waiter))
      } else {
        for (const name of names) claimed.add(name)
      }
    }
  }

  #take(waiter: Waiter): LockLease {
    const { names } = waiter.request
    for (const name of names) this.#held.set(name, waiter)
    let released = false
    return {
      waitedMs: elapsedMs(waiter.startedAt, this.#clock),
      heldBy: waiter.heldBy,
      release: () => {
        if (released) return
        released = true
        for (const name of names) if (this.#held.get(name) === waiter) this.#held.delete(name)
        this.#offer()
      },
    }
  }
}

function inOrder(first: Waiter, second: Waiter): number {
  return first.request.position - second.request.position || first.arrival - second.arrival
}
