import type { Observation } from '../protocol/commands.ts'
import type { ChildEvent } from '../protocol/events.ts'
import type { Failure, SourceLocation, TruncatedText } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { TestRun } from '../api/test-run.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { failure, truncateText, withLocation } from '../protocol/failures.ts'
import { describeLocator } from '../protocol/locator.ts'

/** What a locator assertion looks for in each observation. */
export type LocatorCheck = {
  readonly matcher: 'toBeVisible' | 'toHaveText'
  readonly expected: string
  readonly comparison?: string
  passes(observation: Observation): boolean
  actual(observation: Observation): string | null
  /** Why a single matching element did not pass, as a sentence. */
  mismatch(observation: Observation, locator: string): string
}

export type PollOptions = {
  run: TestRun
  stepId: string | undefined
  recipe: LocatorRecipe
  check: LocatorCheck
  location: SourceLocation | undefined
}

// Looks come quickly at first, then settle at twice a second.
const pollDelays = [0, 50, 100, 250, 500]

/** How long to wait before a look, counting from 0 for the first. */
export function pollDelay(attempt: number): number {
  return pollDelays[Math.min(attempt, pollDelays.length - 1)] ?? 0
}

/**
 * Looks at the page until the check passes or the assertion's time runs out. It only ever reads the
 * page: it never repeats the action that came before it. The last look happens at the deadline.
 */
export async function pollLocator(options: PollOptions): Promise<void> {
  const { run, recipe, check, location } = options
  const timeoutMs = run.assertionBudget()
  const startedAt = monotonicClock()
  const deadline = new Deadline(timeoutMs, { startedAt })
  let attempts = 0
  let last: Observation | undefined
  let stopped: Failure | undefined
  for (;;) {
    const delay = smallestBudget(pollDelay(attempts), deadline.remainingMs)
    if (delay > 0) await sleep(delay)
    const result = await run.observe(recipe, deadline.commandTimeoutMs, location)
    attempts++
    if (result.ok && result.kind === 'observe') {
      last = result.observation
      if (check.passes(last)) break
    } else if (!result.ok && !(result.failure.class === 'timeout' && deadline.expired && last !== undefined)) {
      // A look that fails for any reason other than reaching this assertion's own deadline ends it.
      stopped = withLocation(result.failure, location)
      break
    }
    if (deadline.expired) break
  }
  const passed = stopped === undefined && last !== undefined && check.passes(last)
  const fields = {
    testId: run.testId,
    attemptId: run.attemptId,
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    session: 'page',
    matcher: check.matcher,
    locator: recipe,
    expected: truncateText(check.expected),
    actual: last === undefined ? null : nullableText(check.actual(last)),
    ...(check.comparison === undefined ? {} : { comparison: check.comparison }),
    attempts,
    timeoutMs,
    durationMs: elapsedMs(startedAt),
    ...(location === undefined ? {} : { location }),
  }
  run.countAssertion()
  if (passed) {
    run.emit({ type: 'assertion.passed', ...fields })
    return
  }
  const problem = stopped ?? lookedTooLong({ check, recipe, last, attempts, timeoutMs, location })
  const event: ChildEvent = { type: 'assertion.failed', ...fields, failure: problem }
  run.emit(event)
  throw run.fail(problem)
}

type Unmet = {
  check: LocatorCheck
  recipe: LocatorRecipe
  last: Observation | undefined
  attempts: number
  timeoutMs: number
  location: SourceLocation | undefined
}

function lookedTooLong({ check, recipe, last, attempts, timeoutMs, location }: Unmet): Failure {
  const locator = describeLocator(recipe)
  const looked = `Looked ${attempts} ${attempts === 1 ? 'time' : 'times'} in ${timeoutMs} ms.`
  const details = {
    expected: truncateText(check.expected),
    received: last === undefined ? null : nullableText(check.actual(last)),
    attempts,
    timeoutMs,
    ...(check.comparison === undefined ? {} : { comparison: check.comparison }),
  }
  if (last === undefined || last.count === 0) {
    return { ...failure('not_found', `${locator} matched no element. ${looked}`, location), details }
  }
  if (last.count > 1) {
    const message = `${locator} matched ${last.count} elements, and ${check.matcher} needs exactly one. ${looked}`
    return { ...failure('ambiguous', message, location), details }
  }
  return { ...failure('check_failed', `${check.mismatch(last, locator)} ${looked}`, location), details }
}

function nullableText(text: string | null): TruncatedText | null {
  return text === null ? null : truncateText(text)
}

