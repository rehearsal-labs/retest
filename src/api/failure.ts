import { failure, type Failure } from '../protocol/failures.ts'
import { formatValue } from './format-value.ts'
import { errorLocation } from './source-location.ts'

/**
 * The error a failed Retest command, assertion or misuse throws into test code. Catching it does not
 * make the test pass: the runner has already recorded the failure.
 */
export class RetestError extends Error {
  override readonly name = 'RetestError'
  readonly failure: Failure

  constructor(failure: Failure) {
    super(failure.message)
    this.failure = failure
  }
}

/**
 * Turns anything a test threw into a failure. Retest's own errors keep their class; everything else is
 * a `test_error` located at the first frame outside Retest.
 *
 * @example failureFrom(new TypeError('x is not a function'), '/work').message // 'TypeError: x is not a function'
 */
export function failureFrom(thrown: unknown, rootDir: string): Failure {
  if (thrown instanceof RetestError) return thrown.failure
  if (thrown instanceof Error) {
    return failure('test_error', `${thrown.name}: ${thrown.message}`, errorLocation(thrown, rootDir))
  }
  return failure('test_error', `The test threw ${formatValue(thrown)}.`)
}

/**
 * A failure thrown by code that an earlier test started, such as its timer, while another test ran or
 * after it. The error's own location stays; the message says where the code may have come from.
 *
 * @example fromEarlierTest(failure, 'leaves a timer behind').message // 'Error: late\nCode from the earlier test "leaves a timer behind" may be the cause; this was thrown at a.retest.ts:5.'
 */
export function fromEarlierTest(problem: Failure, testName: string): Failure {
  const { location } = problem
  const where = location === undefined ? '' : `; this was thrown at ${location.file}:${location.line}`
  return { ...problem, message: `${problem.message}\nCode from the earlier test ${JSON.stringify(testName)} may be the cause${where}.` }
}
