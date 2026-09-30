import { maxTimeout } from './timeouts.ts'

/** Milliseconds on a clock that never goes back. */
export type Clock = () => number

/** The host's monotonic clock. */
export const monotonicClock: Clock = () => performance.now()

export type DeadlineOptions = {
  /** When the budget starts, on `clock`. Defaults to now. */
  startedAt?: number
  clock?: Clock
  /** Stops the work early when aborted. */
  signal?: AbortSignal | undefined
}

/**
 * A budget in whole milliseconds, counted from a start time on a monotonic clock. Work that listens to
 * `signal` also stops when it aborts, whatever time is left.
 *
 * @example const deadline = new Deadline(5000, { signal: controller.signal })
 */
export class Deadline {
  readonly budgetMs: number
  readonly signal: AbortSignal | undefined
  readonly #end: number
  readonly #clock: Clock

  constructor(budgetMs: number, options: DeadlineOptions = {}) {
    if (!Number.isInteger(budgetMs) || budgetMs < 0 || budgetMs > maxTimeout) {
      throw new RangeError(`A budget must be a whole number of milliseconds from 0 to ${maxTimeout}, received ${budgetMs}.`)
    }
    const clock = options.clock ?? monotonicClock
    this.budgetMs = budgetMs
    this.signal = options.signal
    this.#clock = clock
    this.#end = (options.startedAt ?? clock()) + budgetMs
  }

  /** Whole milliseconds left, rounded down, never below zero. */
  get remainingMs(): number {
    return Math.max(0, Math.floor(this.#end - this.#clock()))
  }

  /** True once no whole millisecond is left. */
  get expired(): boolean {
    return this.remainingMs === 0
  }

  /** The time left as the timeout of one command, which a timer needs to be at least one millisecond. */
  get commandTimeoutMs(): number {
    return Math.max(1, this.remainingMs)
  }
}

/**
 * The smallest of several budgets, as when a command's own budget meets the time its test has left.
 *
 * @example smallestBudget(10_000, deadline.remainingMs)
 */
export function smallestBudget(first: number, ...others: number[]): number {
  return Math.min(first, ...others)
}

/**
 * Whole milliseconds since `since` on `clock`, never below zero.
 *
 * @example const startedAt = monotonicClock(); await work(); elapsedMs(startedAt)
 */
export function elapsedMs(since: number, clock: Clock = monotonicClock): number {
  return Math.max(0, Math.round(clock() - since))
}
