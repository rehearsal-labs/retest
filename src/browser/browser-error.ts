import type { Failure } from '../protocol/failures.ts'

/** A browser operation outside `execute` that failed. `failure` says how, in the terms a result records. */
export class BrowserError extends Error {
  override readonly name = 'BrowserError'
  readonly failure: Failure

  constructor(failure: Failure, options?: ErrorOptions) {
    super(failure.message, options)
    this.failure = failure
  }
}
