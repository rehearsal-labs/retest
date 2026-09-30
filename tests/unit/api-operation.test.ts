import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Operation } from '../../src/api/operation.ts'

describe('Operation', () => {
  test('await marks it observed and passes its value through', async () => {
    const operation = new Operation<number>()
    assert.equal(operation.observed, false)
    operation.resolve(7)
    assert.equal(await operation, 7)
    assert.equal(operation.observed, true)
    assert.equal(operation.settled, true)
  })

  test('Promise.all, .catch and .finally each mark it observed', async () => {
    const all = new Operation<void>()
    const caught = new Operation<void>()
    const finished = new Operation<void>()
    for (const operation of [all, caught, finished]) operation.resolve()
    await Promise.all([all])
    await caught.catch(() => undefined)
    await finished.finally(() => undefined)
    assert.deepEqual([all.observed, caught.observed, finished.observed], [true, true, true])
  })

  test('a deferred operation starts on its first observation, once', async () => {
    let starts = 0
    const operation: Operation<string> = new Operation(() => {
      starts++
      operation.resolve('done')
    })
    assert.equal(operation.started, false)
    await Promise.resolve()
    assert.equal(starts, 0, 'creating it does not start it')
    assert.equal(await operation, 'done')
    await operation
    assert.equal(starts, 1)
    assert.equal(operation.started, true)
  })

  test('void leaves it unobserved and unstarted', async () => {
    let started = false
    const operation = new Operation<void>(() => {
      started = true
    })
    void operation
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(operation.observed, false)
    assert.equal(started, false)
  })

  test('an unobserved rejection is not reported as unhandled', async () => {
    const unhandled: unknown[] = []
    const listener = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', listener)
    try {
      new Operation<void>().reject(new Error('recorded elsewhere'))
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off('unhandledRejection', listener)
    }
  })

  test('settles once; later calls change nothing', async () => {
    const operation = new Operation<string>()
    operation.resolve('first')
    operation.reject(new Error('late'))
    operation.resolve('second')
    assert.equal(await operation, 'first')
  })

  test('promises derived from it are ordinary promises', () => {
    const operation = new Operation<void>()
    const derived = operation.then(() => undefined)
    assert.equal(Object.getPrototypeOf(derived), Promise.prototype)
    operation.resolve()
  })
})
