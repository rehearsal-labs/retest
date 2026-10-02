import { availableParallelism } from 'node:os'

/** How many test files run at once unless the run says: half the machine's cores, and at least one. */
export function defaultWorkers(): number {
  return Math.max(1, Math.floor(availableParallelism() / 2))
}

/**
 * How many browsers a target's tests are spread over unless the run says: one for every three workers. One browser
 * serves all its contexts from a single process, which many workers saturate, and a browser for each worker gains
 * nothing more: on seven workers, 200 tests took 27.3 s in one browser, 21.3 in two, 18.9 in three, 20.1 in four
 * and 19.3 in seven (speed plan, S8).
 */
export function defaultBrowsers(workers: number): number {
  return Math.max(1, Math.ceil(workers / 3))
}

/**
 * Runs `work` on every item, at most `workers` at a time, taking items in order as workers free up. `work` is told
 * which worker took the item, counted from 0. Every item is run and waited for, even after one fails; the first
 * failure is thrown once all have settled.
 *
 * @example await runInWorkers(visits, 4, (visit, worker) => runVisit(visit, worker))
 */
export async function runInWorkers<T>(items: readonly T[], workers: number, work: (item: T, worker: number) => Promise<void>): Promise<void> {
  if (!Number.isInteger(workers) || workers < 1) throw new RangeError(`workers must be a whole number from 1, received ${workers}.`)
  let next = 0
  const loop = async (worker: number): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]
      if (item !== undefined) await work(item, worker)
    }
  }
  const settled = await Promise.allSettled(Array.from({ length: Math.min(workers, items.length) }, (_, worker) => loop(worker)))
  const failed = settled.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
  if (failed !== undefined) throw failed.reason
}
