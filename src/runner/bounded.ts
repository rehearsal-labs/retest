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
  const leave = stop === undefined ? undefined : whenStopped(stop, () => resolve({ status: 'stopped' }))
  return promise.finally(() => {
    clearTimeout(timer)
    leave?.()
  })
}

type StopWaits = { settled: boolean; readonly waits: Set<() => void> }

// The waits on each stop promise. A promise keeps every reaction attached to it until it settles, and a run's stop
// settles only if the run is stopped, so a reaction for each wait would keep every wait, and the result it ended with,
// for as long as the run lasts. Each stop promise has one reaction instead, and a wait that is over leaves its set.
const stopWaits = new WeakMap<Promise<unknown>, StopWaits>()

/**
 * Calls `stopped` once `stop` settles, unless the function it returns is called first. The waits on one promise are
 * called in the order they began, as reactions of their own would be, and never at once: a wait that begins after
 * `stop` settled is called in a later microtask.
 *
 * @example const leave = whenStopped(run.stopped, () => waiter.settle('stopped')); finished.then(leave)
 */
export function whenStopped(stop: Promise<unknown>, stopped: () => void): () => void {
  const known = stopWaits.get(stop)
  const entry = known ?? { settled: false, waits: new Set<() => void>() }
  if (known === undefined) {
    stopWaits.set(stop, entry)
    void stop.then(tellWaits(entry))
  }
  if (entry.settled) {
    queueMicrotask(stopped)
    return () => undefined
  }
  entry.waits.add(stopped)
  return () => {
    entry.waits.delete(stopped)
  }
}

// The stop's one reaction, made apart from any wait: a closure made beside the first wait would share its scope, and
// keep that wait alive for as long as the stop has not come.
function tellWaits(entry: StopWaits): () => void {
  return () => {
    entry.settled = true
    const waits = [...entry.waits]
    entry.waits.clear()
    for (const wait of waits) wait()
  }
}
