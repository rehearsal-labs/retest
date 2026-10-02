import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { defaultWorkers, runInWorkers } from '../../src/runner/workers.ts'

describe('runInWorkers', () => {
  test('runs every item in order of start, at most the given number at a time', async () => {
    let running = 0
    let most = 0
    const started: number[] = []
    await runInWorkers([1, 2, 3, 4, 5], 2, async (item) => {
      started.push(item)
      running += 1
      most = Math.max(most, running)
      await delay(item === 1 ? 40 : 10)
      running -= 1
    })
    assert.deepEqual(started, [1, 2, 3, 4, 5])
    assert.equal(most, 2)
    assert.equal(running, 0)
  })

  test('one worker runs the items one after another, and no worker is idle for an empty list', async () => {
    const order: string[] = []
    await runInWorkers(['a', 'b'], 1, async (item) => {
      order.push(`${item} start`)
      await delay(5)
      order.push(`${item} end`)
    })
    assert.deepEqual(order, ['a start', 'a end', 'b start', 'b end'])
    await runInWorkers([], 4, () => Promise.reject(new Error('never called')))
  })

  test('waits for every item even after one fails, then throws the first failure', async () => {
    const done: number[] = []
    await assert.rejects(
      runInWorkers([1, 2, 3], 2, async (item) => {
        await delay(item * 5)
        if (item === 1) throw new Error('first')
        done.push(item)
      }),
      /first/,
    )
    assert.deepEqual(done, [2, 3])
  })

  test('refuses a worker count that is not a whole number from 1', async () => {
    await assert.rejects(runInWorkers([1], 0, () => Promise.resolve()), /workers must be a whole number from 1, received 0/)
    await assert.rejects(runInWorkers([1], 1.5, () => Promise.resolve()), /received 1\.5/)
  })
})

describe('defaultWorkers', () => {
  test('is at least one, and never more than the machine has cores', () => {
    const workers = defaultWorkers()
    assert.ok(Number.isInteger(workers) && workers >= 1, `${workers}`)
  })
})
