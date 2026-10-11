import type { TestContext } from 'node:test'
import { syncBuiltinESMExports } from 'node:module'
import { setImmediate as nextTurn } from 'node:timers/promises'

/** A monotonic clock and timers advanced explicitly by the test, independently when testing early wakes. */
export type ControlledClock = {
  now(): number
  flush(): Promise<void>
  restore(): void
  advance(milliseconds: number, timerMilliseconds?: number): Promise<void>
}

export function controlledClock(t: TestContext): ControlledClock {
  let now = 0
  const reading = t.mock.method(performance, 'now', () => now)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  syncBuiltinESMExports()
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    reading.mock.restore()
    t.mock.timers.reset()
    syncBuiltinESMExports()
  }
  t.after(restore)
  return {
    now: () => now,
    restore,
    flush: async () => { await nextTurn() },
    async advance(milliseconds, timerMilliseconds = milliseconds) {
      now += milliseconds
      t.mock.timers.tick(timerMilliseconds)
      await nextTurn()
    },
  }
}
