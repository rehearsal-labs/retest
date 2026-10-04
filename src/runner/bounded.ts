import { timerMs } from './timer.ts'

/** How waiting for work within a budget ended. */
export type Bounded<T> =
  | { status: 'done'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'timed_out' }
  | { status: 'stopped' }

/**
 * Waits for work until a budget runs out or `stop` settles. The work keeps running afterwards: a caller
 * that gives up on it must also release whatever it later produces.
 *
 * @example await bounded(page.dispose(1000), 1000)
 */
export function bounded<T>(work: Promise<T>, timeoutMs: number, stop?: Promise<unknown>): Promise<Bounded<T>> {
  const { promise, resolve } = Promise.withResolvers<Bounded<T>>()
  const timer = setTimeout(() => resolve({ status: 'timed_out' }), timerMs(timeoutMs))
  work.then(
    (value) => resolve({ status: 'done', value }),
    (error: unknown) => resolve({ status: 'failed', error }),
  )
  void stop?.then(() => resolve({ status: 'stopped' }))
  return promise.finally(() => clearTimeout(timer))
}
