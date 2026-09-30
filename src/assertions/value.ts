import type { Scope } from '../api/context.ts'
import type { SourceLocation } from '../protocol/failures.ts'
import { formatValue } from '../api/format-value.ts'
import { failure, truncateText } from '../protocol/failures.ts'
import { shorten } from './format.ts'

const sameValue = 'Object.is'

/** Checks at once that `actual` is `expected` by `Object.is`, reports it, and throws when it is not. */
export function assertSame(scope: Scope, actual: unknown, expected: unknown, location: SourceLocation | undefined): void {
  const { run, stepId } = scope
  const shown = { expected: formatValue(expected), actual: formatValue(actual) }
  const fields = {
    testId: run.testId,
    attemptId: run.attemptId,
    ...(stepId === undefined ? {} : { stepId }),
    matcher: 'toBe',
    expected: truncateText(shown.expected),
    actual: truncateText(shown.actual),
    comparison: sameValue,
    attempts: 1,
    durationMs: 0,
    ...(location === undefined ? {} : { location }),
  }
  run.countAssertion()
  if (Object.is(actual, expected)) {
    run.emit({ type: 'assertion.passed', ...fields })
    return
  }
  const message = `Expected ${shorten(shown.expected)}, received ${shorten(shown.actual)}. toBe compares with ${sameValue}.`
  const details = { expected: fields.expected, received: fields.actual, comparison: sameValue }
  const problem = { ...failure('check_failed', message, location), details }
  run.emit({ type: 'assertion.failed', ...fields, failure: problem })
  throw run.fail(problem)
}
