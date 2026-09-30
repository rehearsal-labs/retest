type Settle<T> = { resolve: (value: T) => void; reject: (reason: unknown) => void }

const ignore = (): void => {}

/**
 * A promise that knows whether test code awaited it. `await`, `Promise.all`, `.then`, `.catch` and
 * `.finally` all call `then`, which marks it observed and, for a deferred operation, starts it.
 * Retest's own bookkeeping never marks it observed, and an unobserved rejection is not reported as an
 * unhandled one: the runner records every failure itself.
 */
export class Operation<T> extends Promise<T> {
  // Promises derived through `then` are ordinary ones, so only the operation itself is tracked.
  static override get [Symbol.species](): PromiseConstructor {
    return Promise
  }

  readonly #settle: Settle<T>
  #start: (() => void) | undefined
  #observed = false
  #settled = false

  /** `start` runs the first time test code observes the operation; without it the operation is already under way. */
  constructor(start?: () => void) {
    let settle: Settle<T> = { resolve: ignore, reject: ignore }
    super((resolve, reject) => {
      settle = { resolve, reject }
    })
    this.#settle = settle
    this.#start = start
    super.then(undefined, ignore)
  }

  get observed(): boolean {
    return this.#observed
  }

  get settled(): boolean {
    return this.#settled
  }

  get started(): boolean {
    return this.#start === undefined
  }

  resolve(value: T): void {
    if (this.#settled) return
    this.#settled = true
    this.#settle.resolve(value)
  }

  reject(reason: unknown): void {
    if (this.#settled) return
    this.#settled = true
    this.#settle.reject(reason)
  }

  override then<Fulfilled = T, Rejected = never>(
    onFulfilled?: ((value: T) => Fulfilled | PromiseLike<Fulfilled>) | null,
    onRejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null,
  ): Promise<Fulfilled | Rejected> {
    this.#observed = true
    const start = this.#start
    this.#start = undefined
    start?.()
    return super.then(onFulfilled, onRejected)
  }
}

/** Whether a value can be awaited, as a promise can. */
export function isThenable(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'then' in value && typeof value.then === 'function'
}
