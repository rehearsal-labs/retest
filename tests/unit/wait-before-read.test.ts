import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { waitBeforeRead, waitUntilDeadline } from '../../src/assertions/wait-before-read.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { maxTimeout } from '../../src/protocol/timeouts.ts'
import { earlyClock } from './early-waits-clock.ts'

test('a capped retry pause rechecks its own clock after an early timer', async (t) => {
  const clock = earlyClock(t)
  clock.spend(119.5)
  const deadline = new Deadline(120, { startedAt: 0 })
  await clock.run(waitBeforeRead(deadline, 100))
  assert.ok(clock.now() >= 120 && clock.now() < 121)
})

test('the largest rounded-up deadline wait does not overflow into a one-millisecond timer', async (t) => {
  const clock = earlyClock(t)
  clock.spend(1.01)
  const deadline = new Deadline(maxTimeout)
  let done = false
  const stop = new AbortController()
  const waiting = waitUntilDeadline(deadline, stop.signal).then(() => { done = true })
  void waiting.catch(() => undefined)
  try {
    t.mock.timers.tick(1)
    await nextTurn()
    assert.equal(done, false)
    clock.spend(maxTimeout)
    t.mock.timers.tick(maxTimeout)
    await clock.run(waiting)
    assert.equal(done, true)
  } finally {
    stop.abort('test finished')
  }
})

test('cancellation ends a capped pause before a final read can be sent', async (t) => {
  const clock = earlyClock(t)
  const stop = new AbortController()
  setTimeout(() => stop.abort('stopped'), 1)
  await assert.rejects(clock.run(waitBeforeRead(new Deadline(120), 200, stop.signal)), { name: 'AbortError' })
  assert.ok(clock.now() < 120)
})
