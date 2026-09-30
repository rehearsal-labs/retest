import type { Scope } from '../api/context.ts'
import type { SourceLocation } from '../protocol/failures.ts'
import type { ValueCheck } from './value-checks.ts'
import { formatValue } from '../api/format-value.ts'
import { failure, truncateText } from '../protocol/failures.ts'
import { reportAssertion } from './report.ts'

export type ValueAssertion = {
  scope: Scope
  check: ValueCheck
  actual: unknown
  location: SourceLocation | undefined
  /** From `expect.soft`: a value that does not pass is recorded, and the test goes on. */
  soft: boolean
}

/** Checks a value at once, reports it, and throws when it does not pass, unless the assertion is soft. */
export function assertValue({ scope, check, actual, location, soft }: ValueAssertion): void {
  const { run, stepId } = scope
  const fields = {
    testId: run.testId,
    attemptId: run.attemptId,
    ...(stepId === undefined ? {} : { stepId }),
    matcher: check.matcher,
    expected: truncateText(check.expected),
    actual: truncateText(formatValue(actual)),
    comparison: check.comparison,
    attempts: 1,
    durationMs: 0,
    ...(location === undefined ? {} : { location }),
  }
  const mismatch = check.mismatch(actual)
  const details = { expected: fields.expected, received: fields.actual, comparison: check.comparison }
  const problem = mismatch === undefined ? undefined : { ...failure('check_failed', mismatch, location), details }
  reportAssertion(run, fields, problem, soft)
}
