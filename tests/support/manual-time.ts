import type { RunTime } from '../../src/api/run-time.ts'

type Wait = { at: number; order: number; resolve: () => void }

export type ManualTime = RunTime & {
  /** Lets `work` run, moving the clock from one wait's end to the next, until it settles. */
  runUntil<T>(work: Promise<T>): Promise<T>
}

// Work waiting on something other than the clock, such as an answer that comes after a turn, gets this many.
const idleTurns = 10

/**
 * Time that moves only from wait to wait, starting at 0. Waits end in the order of their end times, then of
 * their starts; one whose signal aborts first rejects with the signal's reason and is forgotten.
 *
 * @example const time = manualTime(); await time.runUntil(run.execute(test))
 */
export function manualTime(): ManualTime {
  let now = 0
  let started = 0
  const waits: Wait[] = []
  const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
      if (signal?.aborted === true) return reject(signal.reason)
      const wait = { at: now + ms, order: started++, resolve }
      waits.push(wait)
      signal?.addEventListener(
        'abort',
        () => {
          waits.splice(waits.indexOf(wait), 1)
          reject(signal.reason)
        },
        { once: true },
      )
    })
  const endNext = (): boolean => {
    const [next] = waits.toSorted((first, second) => first.at - second.at || first.order - second.order)
    if (next === undefined) return false
    waits.splice(waits.indexOf(next), 1)
    now = Math.max(now, next.at)
    next.resolve()
    return true
  }
  const runUntil = async <T>(work: Promise<T>): Promise<T> => {
    let settled = false
    const watched = work.finally(() => {
      settled = true
    })
    for (let idle = 0; idle < idleTurns; ) {
      await new Promise((resolve) => setImmediate(resolve))
      if (settled) return watched
      idle = endNext() ? 0 : idle + 1
    }
    throw new Error(`The work did not settle, and nothing waits on the clock at ${now} ms.`)
  }
  return { now: () => now, sleep, runUntil }
}
