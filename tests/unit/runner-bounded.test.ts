import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { bounded, whenStopped } from '../../src/runner/bounded.ts'

// A run's stop settles only if the run is stopped, and every wait of every test races it. A wait that is over keeps
// nothing on it: neither the result it ended with nor its timer stays alive for the rest of the run.

setFlagsFromString('--expose-gc')
const gc: unknown = runInNewContext('gc')

function collect(): void {
  if (typeof gc !== 'function') throw new Error('No collector: v8 would not expose gc.')
  gc()
  gc()
}

// Fifty waits that each end with a result of their own, and a weak reference to each result. The waits run in a
// function of their own, so nothing of its frame holds a result once it returns.
async function waitsThatEnded(stop: Promise<void>): Promise<WeakRef<object>[]> {
  const results: WeakRef<object>[] = []
  for (let index = 0; index < 50; index += 1) {
    const value = { page: `page ${index}`, held: new Array<number>(1000).fill(index) }
    results.push(new WeakRef(value))
    const ended = await bounded(Promise.resolve(value), 1000, stop)
    assert.equal(ended.status, 'done')
  }
  return results
}

describe('waiting within a budget or until the run stops', () => {
  test('a wait that ended keeps nothing alive on a stop that has not come', async () => {
    const stop = Promise.withResolvers<void>()
    const results = await waitsThatEnded(stop.promise)
    // Each wait's own clean-up runs a few microtasks after it ends.
    await new Promise<void>((resolve) => setImmediate(resolve))
    collect()
    const alive = results.filter((result) => result.deref() !== undefined).length
    assert.equal(alive, 0, `${alive} of 50 results stayed alive after their waits ended`)
    stop.resolve()
  })

  test('waits still running end as stopped, in the order they began, and an ended one is left alone', async () => {
    const stop = Promise.withResolvers<void>()
    const order: string[] = []
    const first = bounded(new Promise<never>(() => undefined), 60_000, stop.promise).then((ended) => order.push(`first ${ended.status}`))
    const done = bounded(Promise.resolve('value'), 60_000, stop.promise).then((ended) => order.push(`done ${ended.status}`))
    const second = bounded(new Promise<never>(() => undefined), 60_000, stop.promise).then((ended) => order.push(`second ${ended.status}`))
    await done
    stop.resolve()
    await Promise.all([first, second])
    assert.deepEqual(order, ['done done', 'first stopped', 'second stopped'])
  })

  test('a wait that begins once the stop came is told in a later microtask, not at once', async () => {
    const stop = Promise.withResolvers<void>()
    stop.resolve()
    await stop.promise
    const told: string[] = []
    whenStopped(stop.promise, () => told.push('early'))
    await Promise.resolve()
    whenStopped(stop.promise, () => told.push('late'))
    assert.deepEqual(told, ['early'])
    await Promise.resolve()
    assert.deepEqual(told, ['early', 'late'])
  })

  test('a wait that left before the stop came is not told', async () => {
    const stop = Promise.withResolvers<void>()
    const told: string[] = []
    const leave = whenStopped(stop.promise, () => told.push('left'))
    whenStopped(stop.promise, () => told.push('stayed'))
    leave()
    stop.resolve()
    await stop.promise
    await Promise.resolve()
    assert.deepEqual(told, ['stayed'])
  })
})
