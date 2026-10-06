import type { Deadline } from '../protocol/deadline.ts'
import { setTimeout as sleep } from 'node:timers/promises'

/** A retry pause capped at the exact deadline. An early capped timer must wake again before the final read. */
export async function waitBeforeRead(deadline: Deadline, pauseMs: number, signal: AbortSignal | undefined = deadline.signal): Promise<void> {
  const left = deadline.waitToEndMs
  const pause = Math.min(pauseMs, left)
  if (pause > 0) await sleep(pause, undefined, { signal })
  if (pause > 0 && pause === left) await waitUntilDeadline(deadline, signal)
}

/** Waits through the deadline on its own clock, rechecking after early or maximum-delay timers. */
export async function waitUntilDeadline(deadline: Deadline, signal: AbortSignal | undefined = deadline.signal): Promise<void> {
  while (!deadline.reached) await sleep(deadline.waitToEndMs, undefined, { signal })
}
