import type { Look } from './look-until.ts'
import type { TestRun } from '../api/test-run.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Failure, SourceLocation, TruncatedText } from '../protocol/failures.ts'
import type { LocatorCheck, LocatorCheckRecord } from '../protocol/locator-checks.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { elapsedMs } from '../protocol/deadline.ts'
import { failure, truncateText } from '../protocol/failures.ts'
import { locatorCheck } from '../protocol/locator-checks.ts'
import { describeEmptyStep, describeLocator } from '../protocol/locator.ts'
import { lookUntil } from './look-until.ts'
import { reportAssertion } from './report.ts'

export { lookFloorMs, pollDelay } from './look-until.ts'

export type PollOptions = {
  run: TestRun
  stepId: string | undefined
  app: string
  recipe: LocatorRecipe
  /** The matcher and its arguments. Each look is judged by the check `locatorCheck` builds from it, as the parent judges. */
  record: LocatorCheckRecord
  location: SourceLocation | undefined
  /** From `expect.soft`: a check that does not pass is recorded, and the test goes on. */
  soft: boolean
  /** The matcher's own `timeout`, which may shorten the assertion budget and never lengthens it. */
  timeoutMs?: number | undefined
}

/**
 * Looks at an app's page until the check passes or the assertion's time runs out, as `lookUntil` looks. The event
 * names the look its `actual` came from, by the id and the session the parent served it with, and carries the check
 * whole, so the parent can judge that look again.
 */
export async function pollLocator(options: PollOptions): Promise<void> {
  const { run, app, recipe, record, location } = options
  const check = locatorCheck(record)
  const timeoutMs = assertionTime(run, options.timeoutMs)
  const looked = await lookUntil<Observation>({
    run,
    timeoutMs,
    location,
    look: (lookMs, after) => run.observe(app, recipe, lookMs, location, after),
    read: (result) => (result.kind === 'observe' ? lookOf(result.observation, result) : undefined),
    passes: check.passes,
  })
  const { stopped, attempts } = looked
  const last = looked.last?.observation
  const passed = stopped === undefined && last !== undefined && check.passes(last)
  const fields = {
    testId: run.testId,
    attemptId: run.attemptId,
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    session: app,
    matcher: check.matcher,
    locator: recipe,
    expected: truncateText(check.expected),
    actual: last === undefined ? null : nullableText(check.actual(last)),
    ...(check.comparison === undefined ? {} : { comparison: check.comparison }),
    attempts,
    timeoutMs,
    durationMs: elapsedMs(looked.startedAt, run.time.now),
    ...(location === undefined ? {} : { location }),
    ...lookReference(looked.last),
    check: record,
  }
  if (passed) return reportAssertion(run, fields, undefined, false)
  // Only the check's own verdict is softened; a page that could not be read stops the test as usual.
  if (stopped !== undefined) return reportAssertion(run, fields, stopped, false)
  reportAssertion(run, fields, lookedTooLong({ check, recipe, last, attempts, timeoutMs, location }), options.soft)
}

/**
 * How long an assertion may look: the assertion budget, or its own `timeout` when that is shorter, within what the
 * test has left.
 *
 * @example assertionTime(run, 2000) // 2000 when the assertion budget is 5000
 */
export function assertionTime(run: TestRun, ownMs: number | undefined): number {
  return run.assertionBudget(ownMs === undefined ? undefined : Math.min(ownMs, run.timeouts.assertion))
}

/** What a passed look's answer carries besides what it saw. */
type Served = { observationId?: string; sessionId?: string; changes?: number }

/** A look as `lookUntil` keeps it, from what the parent answered. */
export function lookOf<Observed>(observation: Observed, served: Served): Look<Observed> {
  return { observation, observationId: served.observationId, sessionId: served.sessionId, changes: served.changes }
}

/** The id and the session of the look an assertion rested on, as its event names them. */
export function lookReference(look: Look<unknown> | undefined): { observationId?: string; sessionId?: string } {
  const id = look?.observationId
  if (id === undefined) return {}
  const session = look?.sessionId
  return session === undefined ? { observationId: id } : { observationId: id, sessionId: session }
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
  if (last === undefined || (check.single && last.count === 0)) {
    const step = last?.emptyStep === undefined ? undefined : describeEmptyStep(recipe, last.emptyStep)
    return { ...failure('not_found', `${locator} matched no element.${step === undefined ? '' : ` ${step}`} ${looked}`, location), details }
  }
  if (check.single && last.count > 1) {
    const message = `${locator} matched ${last.count} elements, and ${check.matcher} needs exactly one. ${looked}`
    return { ...failure('ambiguous', message, location), details }
  }
  return { ...failure('check_failed', `${check.mismatch(last, locator)} ${looked}`, location), details }
}

function nullableText(text: string | null): TruncatedText | null {
  return text === null ? null : truncateText(text)
}
