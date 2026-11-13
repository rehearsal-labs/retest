import type { TestRun } from '../api/test-run.ts'
import type { CommandResult, ObserveAfter } from '../protocol/commands.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import { Deadline, elapsedMs, smallestBudget } from '../protocol/deadline.ts'
import { failure, withLocation } from '../protocol/failures.ts'

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
  /**
   * The waits before each look in milliseconds, counting from 0 for the first, the last repeating, for a check whose
   * looks must be spaced, such as a screenshot's. Absent: `pollDelay`'s.
   */
  delays?: readonly number[]
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
 * failure. A page reads nothing while it is opening another document, so a look whose time ran out then stops the
 * looking with a failure that says so, whatever an earlier look read of the document being left.
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
    const delay = smallestBudget(options.delays === undefined ? pollDelay(attempts) : (options.delays[Math.min(attempts, options.delays.length - 1)] ?? 0), waitToEndMs)
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
    } else if (!result.ok) {
      const stopped = lookStopped(result.failure, { expired: deadline.expired, looked: last !== undefined, attempts, timeoutMs, location })
      if (stopped !== undefined) return { last, attempts, startedAt, stopped }
    }
    if (deadline.reached) break
  }
  return { last, attempts, startedAt, stopped: undefined }
}

/** Where the looks stood when one failed: whether the time is up, whether an earlier look read the page, and the check's own. */
type FailedLook = { expired: boolean; looked: boolean; attempts: number; timeoutMs: number; location: SourceLocation | undefined }

// What a failed look stops the looking with, or undefined when the loop looks once more. A look is given the whole
// milliseconds left, so a timeout after using them all can come with part of one still left: that is the deadline, and
// the loop looks once more when the end comes. A look the page could not take because it was still opening another
// document read nothing, so once the time is up it ends the check as that, whatever an earlier look read of the
// document being left.
function lookStopped(problem: Failure, { expired, looked, attempts, timeoutMs, location }: FailedLook): Failure | undefined {
  const opening = openingOf(problem)
  if (opening !== undefined) return expired ? stillOpening(opening, { attempts, timeoutMs, location }) : undefined
  if (problem.class === 'timeout' && expired && looked) return undefined
  return withLocation(problem, location)
}

// The address a page was still opening when a look's time ran out, as a page that read nothing for that reason says it.
function openingOf(problem: Failure): string | undefined {
  const url = problem.details?.['url']
  return problem.class === 'timeout' && problem.details?.['check'] === 'navigation' && typeof url === 'string' ? url : undefined
}

function stillOpening(url: string, { attempts, timeoutMs, location }: Omit<FailedLook, 'expired' | 'looked'>): Failure {
  const message = `The page was still opening ${url} when the check's ${timeoutMs} ms ran out, so the check read nothing.`
  return { ...failure('timeout', message, location), details: { check: 'navigation', url, attempts, timeoutMs } }
}
