import type { TestRun } from '../api/test-run.ts'
import type { Failure, SourceLocation, TruncatedText } from '../protocol/failures.ts'
import type { PageCheck, PageCheckRecord, PageLook } from '../protocol/locator-checks.ts'
import { elapsedMs } from '../protocol/deadline.ts'
import { failure, truncateText } from '../protocol/failures.ts'
import { pageCheck } from '../protocol/locator-checks.ts'
import { lookUntil } from './look-until.ts'
import { assertionTime, lookOf, lookReference } from './poll-locator.ts'
import { reportAssertion } from './report.ts'

export type PagePollOptions = {
  run: TestRun
  stepId: string | undefined
  app: string
  /** The matcher and its arguments, which the parent judges the look the event names with. */
  record: PageCheckRecord
  location: SourceLocation | undefined
  soft: boolean
  /** The matcher's own `timeout`, which may shorten the assertion budget and never lengthens it. */
  timeoutMs?: number | undefined
}

/**
 * Looks at an app's page, its address and title, until the check passes or the assertion's time runs out, as a
 * locator assertion looks. The event names the look its verdict rested on, and carries the check whole.
 */
export async function pollPage(options: PagePollOptions): Promise<void> {
  const { run, app, record, location } = options
  const check = pageCheck(record)
  const timeoutMs = assertionTime(run, options.timeoutMs)
  const looked = await lookUntil<PageLook>({
    run,
    timeoutMs,
    location,
    look: (lookMs, after) => run.observePage(app, lookMs, location, after),
    read: (result) => {
      if (result.kind !== 'observePage') return undefined
      const look = result.baseUrl === undefined ? result.observation : { ...result.observation, baseUrl: result.baseUrl }
      return lookOf(look, result)
    },
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
    expected: truncateText(check.expected),
    actual: last === undefined ? null : nullableText(check.actual(last)),
    comparison: check.comparison,
    attempts,
    timeoutMs,
    durationMs: elapsedMs(looked.startedAt, run.time.now),
    ...(location === undefined ? {} : { location }),
    ...lookReference(looked.last),
    check: record,
  }
  if (passed) return reportAssertion(run, fields, undefined, false)
  if (stopped !== undefined) return reportAssertion(run, fields, stopped, false)
  reportAssertion(run, fields, unmet({ check, last, attempts, timeoutMs, location }), options.soft)
}

type Unmet = { check: PageCheck; last: PageLook | undefined; attempts: number; timeoutMs: number; location: SourceLocation | undefined }

function unmet({ check, last, attempts, timeoutMs, location }: Unmet): Failure {
  const looked = `Looked ${attempts} ${attempts === 1 ? 'time' : 'times'} in ${timeoutMs} ms.`
  if (last === undefined) return failure('timeout', `The page answered no look within ${timeoutMs} ms.`, location)
  const details = { expected: truncateText(check.expected), received: nullableText(check.actual(last)), attempts, timeoutMs, comparison: check.comparison }
  return { ...failure('check_failed', `${check.mismatch(last)} ${looked}`, location), details }
}

function nullableText(text: string | null): TruncatedText | null {
  return text === null ? null : truncateText(text)
}
