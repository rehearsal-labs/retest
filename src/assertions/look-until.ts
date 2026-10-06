import type { TestRun } from '../api/test-run.ts'
import type { CommandResult, ObserveAfter } from '../protocol/commands.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import { Deadline, elapsedMs, smallestBudget } from '../protocol/deadline.ts'
import { withLocation } from '../protocol/failures.ts'

/** One look the parent served: what it saw, the id and session it was served with, and the page's change count. */
export type Look<Observed> = {
  observation: Observed
  observationId: string | undefined
  sessionId: string | undefined
  changes: number | undefined
}

export type LookOptions<Observed> = {
  run: TestRun
  timeoutMs: number
  location: SourceLocation | undefined
  /** Sends one look, within `timeoutMs`, first waiting for a change after `after` when given. */
  look(timeoutMs: number, after: ObserveAfter | undefined): Promise<CommandResult>
  /** What a passed answer saw, or undefined for an answer of another kind. */
  read(result: Extract<CommandResult, { ok: true }>): Look<Observed> | undefined
  passes(observation: Observed): boolean
}

/** How the looks went: the last, how many, when they began, and the failure that stopped them, if one did. */
export type Looked<Observed> = { last: Look<Observed> | undefined; attempts: number; startedAt: number; stopped: Failure | undefined }

// Without a change, looks come quickly at first, then settle at twice a second.
const pollDelays = [0, 50, 100, 250, 500]

/** The longest a look waits for the page to change before it looks anyway, counting from 0 for the first look. */
export function pollDelay(attempt: number): number {
  return pollDelays[Math.min(attempt, pollDelays.length - 1)] ?? 0
}

/** The least time between two looks at a page that keeps changing, so a page in constant motion is not read on every frame. */
export const lookFloorMs: number = 50

/**
 * Looks at an app's page until what it sees passes or the time runs out. It only ever reads the page: it never
 * repeats the action that came before it. A page that counts its changes is asked to answer the next look as soon as
 * it has changed again, at most `lookFloorMs` after the last look and at the latest after the poll delay; a page that
 * does not count them is looked at on the poll delays alone. The last look is sent once the deadline is reached on the
 * clock the deadline reads, never while part of a millisecond is left, so a `timeout` of 1500 never gives up at 1499.6.
 * A look that fails for any reason other than reaching the deadline after an earlier look stops the looking with its
 * failure.
 */
export async function lookUntil<Observed>(options: LookOptions<Observed>): Promise<Looked<Observed>> {
  const { run, timeoutMs, location } = options
  const { now, sleep } = run.time
  const startedAt = now()
  const deadline = new Deadline(timeoutMs, { startedAt, clock: now })
  let attempts = 0
  let last: Look<Observed> | undefined
  let lastLookAt = startedAt
  for (;;) {
    // Rounded up, so a wait cut to the deadline ends at it; a timer that fires early leaves time, and the loop waits again.
    const waitToEndMs = deadline.waitToEndMs
    const delay = smallestBudget(pollDelay(attempts), waitToEndMs)
    let after: ObserveAfter | undefined
    const changes = last?.changes
    if (changes === undefined) {
      if (delay > 0) await sleep(delay)
      if (delay > 0 && delay === waitToEndMs) {
        while (!deadline.reached) await sleep(deadline.waitToEndMs)
      }
    } else {
      const pause = Math.min(Math.max(0, lookFloorMs - elapsedMs(lastLookAt, now)), delay)
      if (pause > 0) await sleep(pause)
      if (pause > 0 && pause === waitToEndMs) {
        while (!deadline.reached) await sleep(deadline.waitToEndMs)
      }
      after = { changes, waitMs: delay - pause }
    }
    const result = await options.look(deadline.commandTimeoutMs, after)
    lastLookAt = now()
    attempts++
    const seen = result.ok ? options.read(result) : undefined
    if (seen !== undefined) {
      last = seen
      if (options.passes(seen.observation)) break
      // A look is given the whole milliseconds left, so a timeout after using them all can come with part of one still
      // left: that is the deadline, and the loop looks once more when the end comes.
    } else if (!result.ok && !(result.failure.class === 'timeout' && deadline.expired && last !== undefined)) {
      return { last, attempts, startedAt, stopped: withLocation(result.failure, location) }
    }
    if (deadline.reached) break
  }
  return { last, attempts, startedAt, stopped: undefined }
}
