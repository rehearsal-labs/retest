import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { syncBuiltinESMExports } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { Deadline } from '../../src/protocol/deadline.ts'

/** Timers wake ten times faster than the deadline clock. Reads can spend a fractional millisecond too. */
type EarlyClock = { now(): number; spend(ms?: number): void; restore(): void; run<T>(work: Promise<T>, canTick?: () => boolean, hostTurn?: () => Promise<void>): Promise<T> }

export function earlyClock(t: TestContext, readinessBudgetMs?: number): EarlyClock {
  let now = 0
  const restoreClock: () => void = readinessBudgetMs === undefined
    ? (() => { const reading = t.mock.method(performance, 'now', () => now); return () => reading.mock.restore() })()
    : (() => {
        // Only the readiness deadline uses fake time. Ownership workers keep the host's real clock.
        const reference = new Deadline(readinessBudgetMs, { clock: () => now })
        const realRemaining: ((this: Deadline) => number) | undefined = Object.getOwnPropertyDescriptor(Deadline.prototype, 'remainingMs')?.get
        const realReached: ((this: Deadline) => boolean) | undefined = Object.getOwnPropertyDescriptor(Deadline.prototype, 'reached')?.get
        const realWait: ((this: Deadline) => number) | undefined = Object.getOwnPropertyDescriptor(Deadline.prototype, 'waitToEndMs')?.get
        assert.ok(realRemaining && realReached && realWait, 'the deadline getters are present')
        const remaining = t.mock.getter(Deadline.prototype, 'remainingMs', function (this: Deadline): number {
          return this !== reference && this.budgetMs === readinessBudgetMs ? reference.remainingMs : realRemaining.call(this)
        })
        const reached = t.mock.getter(Deadline.prototype, 'reached', function (this: Deadline): boolean {
          return this !== reference && this.budgetMs === readinessBudgetMs ? reference.reached : realReached.call(this)
        })
        const wait = t.mock.getter(Deadline.prototype, 'waitToEndMs', function (this: Deadline): number {
          return this !== reference && this.budgetMs === readinessBudgetMs ? reference.waitToEndMs : realWait.call(this)
        })
        return () => { remaining.mock.restore(); reached.mock.restore(); wait.mock.restore() }
      })()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); t.mock.timers.reset(); syncBuiltinESMExports() })
  return {
    now: () => now,
    spend: (ms = 0.2) => { now += ms },
    restore: () => { restoreClock(); t.mock.timers.reset(); syncBuiltinESMExports() },
    async run<T>(work: Promise<T>, canTick: () => boolean = () => true, hostTurn?: () => Promise<void>): Promise<T> {
      let done = false
      const watched = work.finally(() => { done = true })
      // Attach before driving time so a deliberate old-code rejection is never unhandled.
      void watched.catch(() => undefined)
      for (let ticks = 0; ticks < 30_000; ticks++) {
        // Protocol stand-ins need several microtask/pipe turns before their command timeout is advanced.
        for (let turn = 0; turn < 12; turn++) await nextTurn()
        // A fixture using real subprocesses can yield to the host without advancing the readiness clock.
        await hostTurn?.()
        if (done) return watched
        if (canTick()) {
          now += 0.1
          t.mock.timers.tick(1)
        }
      }
      assert.fail(`work did not end at ${now} ms`)
    },
  }
}

export function fullBudget(reads: readonly number[], now: number, budget = 120): void {
  assert.ok((reads.at(-1) ?? -1) >= budget, `last read at ${reads.at(-1)}: ${reads.join(', ')}`)
  assert.ok(now < budget + 2, `work ended at ${now} ms`)
}
