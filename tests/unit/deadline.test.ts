import type { Clock } from '../../src/protocol/deadline.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../../src/protocol/deadline.ts'
import { maxTimeout } from '../../src/protocol/timeouts.ts'

/** A clock that moves only when told. */
function manualClock(start: number): { clock: Clock; advance(milliseconds: number): void } {
  let now = start
  return {
    clock: () => now,
    advance(milliseconds) {
      now += milliseconds
    },
  }
}

describe('Deadline', () => {
  test('counts its budget from the moment it is made, on the given clock', () => {
    const time = manualClock(100)
    const deadline = new Deadline(1000, { clock: time.clock })
    assert.equal(deadline.budgetMs, 1000)
    assert.equal(deadline.remainingMs, 1000)
    time.advance(400)
    assert.equal(deadline.remainingMs, 600)
    assert.equal(deadline.expired, false)
  })

  test('counts from a start time given in the past', () => {
    const time = manualClock(250)
    const deadline = new Deadline(1000, { startedAt: 0, clock: time.clock })
    assert.equal(deadline.remainingMs, 750)
  })

  test('rounds what is left down to whole milliseconds, and never goes below zero', () => {
    const time = manualClock(0)
    const deadline = new Deadline(10, { clock: time.clock })
    time.advance(0.4)
    assert.equal(deadline.remainingMs, 9)
    time.advance(9.1)
    assert.equal(deadline.remainingMs, 0)
    time.advance(1000)
    assert.equal(deadline.remainingMs, 0)
  })

  test('is expired once no whole millisecond is left', () => {
    const time = manualClock(0)
    const deadline = new Deadline(10, { clock: time.clock })
    time.advance(8.9)
    assert.equal(deadline.expired, false)
    time.advance(0.2)
    assert.equal(deadline.expired, true, 'less than a millisecond is left')
  })

  test('is reached only once the clock reads its end, not while part of a millisecond is left', () => {
    const time = manualClock(0)
    const deadline = new Deadline(10, { clock: time.clock })
    time.advance(9.9)
    assert.equal(deadline.expired, true, 'no whole millisecond is left')
    assert.equal(deadline.reached, false, 'a tenth of one is')
    time.advance(0.1)
    assert.equal(deadline.reached, true)
    time.advance(1000)
    assert.equal(deadline.reached, true)
    assert.equal(new Deadline(0, { clock: manualClock(0).clock }).reached, true, 'a budget of zero is reached from the start')
  })

  test('gives a wait the time left rounded up, so a wait of that long ends at the end or after it', () => {
    const time = manualClock(0)
    const deadline = new Deadline(100, { clock: time.clock })
    assert.equal(deadline.waitToEndMs, 100)
    time.advance(30.4)
    assert.equal(deadline.waitToEndMs, 70)
    assert.equal(deadline.remainingMs, 69)
    time.advance(69.5)
    assert.equal(deadline.waitToEndMs, 1, 'a tenth of a millisecond is waited as a whole one')
    time.advance(0.1)
    assert.equal(deadline.waitToEndMs, 0)
    time.advance(1000)
    assert.equal(deadline.waitToEndMs, 0)
  })

  test('keeps the largest wait within the timer limit even when floating-point subtraction adds a fraction', () => {
    const time = manualClock(1.01)
    const deadline = new Deadline(maxTimeout, { clock: time.clock })
    assert.equal(deadline.waitToEndMs, maxTimeout, 'rounding must not overflow a Node timer into a one-millisecond wait')
    time.advance(maxTimeout)
    assert.equal(deadline.reached, true)
    assert.equal(deadline.waitToEndMs, 0)
  })

  test('gives a command what is left, and at least the one millisecond a timer needs', () => {
    const time = manualClock(0)
    const deadline = new Deadline(500, { clock: time.clock })
    time.advance(120)
    assert.equal(deadline.commandTimeoutMs, 380)
    time.advance(1000)
    assert.equal(deadline.commandTimeoutMs, 1)
  })

  test('a budget of zero is expired from the start', () => {
    const deadline = new Deadline(0, { clock: manualClock(0).clock })
    assert.equal(deadline.expired, true)
    assert.equal(deadline.remainingMs, 0)
    assert.equal(deadline.commandTimeoutMs, 1)
  })

  test('refuses a budget that is not a whole number of milliseconds a timer can hold', () => {
    for (const budgetMs of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, maxTimeout + 1]) {
      assert.throws(() => new Deadline(budgetMs), RangeError, String(budgetMs))
    }
    assert.equal(new Deadline(maxTimeout).budgetMs, maxTimeout)
  })

  test('uses the monotonic clock unless given another', () => {
    const before = monotonicClock()
    const deadline = new Deadline(10_000)
    assert.ok(monotonicClock() >= before)
    assert.ok(deadline.remainingMs <= 10_000 && deadline.remainingMs > 9_000, `${deadline.remainingMs} ms left`)
  })
})

describe('smallestBudget', () => {
  test('is the smallest of the budgets given', () => {
    assert.equal(smallestBudget(5000), 5000)
    assert.equal(smallestBudget(200, 600), 200)
    assert.equal(smallestBudget(5000, 600, 900), 600)
    assert.equal(smallestBudget(5000, 0), 0)
  })

  test('cuts a command budget to what a deadline has left', () => {
    const time = manualClock(0)
    const deadline = new Deadline(1000, { clock: time.clock })
    time.advance(400)
    assert.equal(smallestBudget(200, deadline.remainingMs), 200)
    assert.equal(smallestBudget(5000, deadline.remainingMs), 600)
    time.advance(1600)
    assert.equal(smallestBudget(5000, deadline.remainingMs), 0)
  })
})

describe('elapsedMs', () => {
  test('rounds to whole milliseconds and never goes below zero', () => {
    assert.equal(elapsedMs(10, () => 25.6), 16)
    assert.equal(elapsedMs(10, () => 25.4), 15)
    assert.equal(elapsedMs(10, () => 5), 0)
  })
})
