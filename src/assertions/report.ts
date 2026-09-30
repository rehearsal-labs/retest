import type { TestRun } from '../api/test-run.ts'
import type { ChildEvent } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'

/** What an assertion event says, apart from its type and failure. */
export type AssertionFields = Omit<Extract<ChildEvent, { type: 'assertion.passed' }>, 'type' | 'soft'>

/**
 * Counts an assertion and reports how it went. A failure is thrown into the test, unless the assertion is
 * soft: then it is recorded, marked soft in its event, and the test goes on.
 */
export function reportAssertion(run: TestRun, fields: AssertionFields, problem: Failure | undefined, soft: boolean): void {
  run.countAssertion()
  if (problem === undefined) return run.emit({ type: 'assertion.passed', ...fields })
  run.emit({ type: 'assertion.failed', ...fields, ...(soft ? { soft: true } : {}), failure: problem })
  if (soft) return run.record(problem)
  throw run.fail(problem)
}
