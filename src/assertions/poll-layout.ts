import type { TestRun } from '../api/test-run.ts'
import type { Failure, SourceLocation, TruncatedText } from '../protocol/failures.ts'
import type { LayoutLook } from '../protocol/layout.ts'
import type { LayoutCheck, LayoutCheckRecord } from '../protocol/layout-checks.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { elapsedMs } from '../protocol/deadline.ts'
import { failure, truncateText } from '../protocol/failures.ts'
import { layoutCheck, layoutRequest } from '../protocol/layout-checks.ts'
import { lookUntil } from './look-until.ts'
import { assertionTime, lookOf, lookReference } from './poll-locator.ts'
import { reportAssertion } from './report.ts'

export type LayoutPollOptions = {
  run: TestRun
  stepId: string | undefined
  app: string
  /** The element the matcher was called on; absent for a page matcher. */
  recipe: LocatorRecipe | undefined
  /** The matcher and its arguments, which the parent judges the look the event names with. */
  record: LayoutCheckRecord
  location: SourceLocation | undefined
  soft: boolean
  /** The matcher's own `timeout`, which may shorten the assertion budget and never lengthens it. */
  timeoutMs?: number | undefined
}

/**
 * Measures an app's page until the layout check passes or the assertion's time runs out, as a locator assertion looks:
 * it only reads, and never repeats the action before it. The event names the look its verdict rested on, carries the
 * check whole, and records what that look measured, so the parent can judge it again.
 */
export async function pollLayout(options: LayoutPollOptions): Promise<void> {
  const { run, app, recipe, record, location } = options
  const check = layoutCheck(record)
  const request = layoutRequest(record, recipe)
  const timeoutMs = assertionTime(run, options.timeoutMs)
  const looked = await lookUntil<LayoutLook>({
    run,
    timeoutMs,
    location,
    look: (lookMs, after) => run.observeLayout(app, request, lookMs, location, after),
    read: (result) => (result.kind === 'observeLayout' ? lookOf(result.observation, result) : undefined),
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
    ...(recipe === undefined ? {} : { locator: recipe }),
    expected: truncateText(check.expected),
    actual: last === undefined ? null : nullableText(check.actual(last)),
    comparison: check.comparison,
    attempts,
    timeoutMs,
    durationMs: elapsedMs(looked.startedAt, run.time.now),
    ...(location === undefined ? {} : { location }),
    ...lookReference(looked.last),
    ...(last === undefined ? {} : { layout: check.measured(last) }),
    check: record,
  }
  if (passed) return reportAssertion(run, fields, undefined, false)
  // Only the check's own verdict is softened; a page that could not be read stops the test as usual.
  if (stopped !== undefined) return reportAssertion(run, fields, stopped, false)
  reportAssertion(run, fields, unmet({ check, recipe, last, attempts, timeoutMs, location }), options.soft)
}

type Unmet = { check: LayoutCheck; recipe: LocatorRecipe | undefined; last: LayoutLook | undefined; attempts: number; timeoutMs: number; location: SourceLocation | undefined }

function unmet({ check, recipe, last, attempts, timeoutMs, location }: Unmet): Failure {
  if (last === undefined) return failure('timeout', `The page answered no look within ${timeoutMs} ms.`, location)
  const looked = `Looked ${attempts} ${attempts === 1 ? 'time' : 'times'} in ${timeoutMs} ms.`
  const details = { expected: truncateText(check.expected), received: nullableText(check.actual(last)), attempts, timeoutMs, comparison: check.comparison }
  const reason = check.unmet(last, recipe)
  return { ...failure(reason.class, `${reason.message} ${looked}`, location), details }
}

function nullableText(text: string | null): TruncatedText | null {
  return text === null ? null : truncateText(text)
}
