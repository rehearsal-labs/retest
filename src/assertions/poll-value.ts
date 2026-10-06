import type { TestRun } from '../api/test-run.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { AssertionFields } from './report.ts'
import type { ValueCheck } from './value-checks.ts'
import { callInScope } from '../api/context.ts'
import { RetestError, thrownMessage } from '../api/failure.ts'
import { formatValue } from '../api/format-value.ts'
import { Deadline, elapsedMs, smallestBudget } from '../protocol/deadline.ts'
import { failure, truncateText } from '../protocol/failures.ts'
import { pollDelay } from './poll-locator.ts'
import { reportAssertion } from './report.ts'

export type ValuePoll = {
  run: TestRun
  stepId: string | undefined
  /** The function `expect.poll` was given. It runs where actions are refused, so it can only read. */
  read: () => unknown
  check: ValueCheck
  location: SourceLocation | undefined
  /** The poll's own budget, or the assertion budget when absent; either way it ends with the test's time. */
  timeoutMs: number | undefined
  /** The waits between looks, the last one repeating; Retest's own schedule when absent. */
  intervals: readonly number[] | undefined
}

type Look = { kind: 'value'; value: unknown } | { kind: 'threw'; error: unknown } | { kind: 'late' }

/**
 * Calls `read` until its value passes the check or the poll's time runs out, and reports the result as one
 * assertion. It repeats only the read, never an action. An error from the read counts as a look that did not
 * pass, except a Retest error, such as an action the read tried, which ends the poll with it.
 */
export async function pollValue(options: ValuePoll): Promise<void> {
  const { run, check, location } = options
  const { now, sleep } = run.time
  const timeoutMs = run.assertionBudget(options.timeoutMs)
  const startedAt = now()
  const deadline = new Deadline(timeoutMs, { startedAt, clock: now })
  let attempts = 0
  let last: Exclude<Look, { kind: 'late' }> | undefined
  for (;;) {
    const waitToEndMs = deadline.waitToEndMs
    const delay = smallestBudget(waitBefore(attempts, options.intervals), waitToEndMs)
    if (delay > 0) await sleep(delay)
    // A timer can fire early. A pause cut to the end must finish before the final read starts.
    if (delay > 0 && delay === waitToEndMs) {
      while (!deadline.reached) await sleep(deadline.waitToEndMs)
    }
    const look = await readOnce(options, deadline)
    attempts++
    if (look.kind === 'late') break
    last = look
    if (look.kind === 'threw' && look.error instanceof RetestError) break
    if (look.kind === 'value' && check.mismatch(look.value) === undefined) break
    if (deadline.reached) break
  }
  const fields: AssertionFields = {
    testId: run.testId,
    attemptId: run.attemptId,
    ...(options.stepId === undefined ? {} : { stepId: options.stepId }),
    matcher: check.matcher,
    expected: truncateText(check.expected),
    actual: last?.kind === 'value' ? truncateText(formatValue(last.value)) : null,
    comparison: check.comparison,
    attempts,
    timeoutMs,
    durationMs: elapsedMs(startedAt, now),
    ...(location === undefined ? {} : { location }),
  }
  if (last?.kind === 'threw' && last.error instanceof RetestError) return stopWith(run, fields, last.error)
  reportAssertion(run, fields, unmet({ check, last, attempts, timeoutMs, location }), false)
}

type Unmet = {
  check: ValueCheck
  last: Exclude<Look, { kind: 'late' }> | undefined
  attempts: number
  timeoutMs: number
  location: SourceLocation | undefined
}

function unmet({ check, last, attempts, timeoutMs, location }: Unmet): Failure | undefined {
  const looked = `Looked ${attempts} ${attempts === 1 ? 'time' : 'times'} in ${timeoutMs} ms.`
  if (last === undefined) {
    return failure('timeout', `The function given to expect.poll() was still running when its ${timeoutMs} ms ran out.`, location)
  }
  if (last.kind === 'threw') {
    return failure('test_error', `The function given to expect.poll() threw on its last look: ${thrownMessage(last.error)}. ${looked}`, location)
  }
  const mismatch = check.mismatch(last.value)
  if (mismatch === undefined) return undefined
  const details = { expected: truncateText(check.expected), received: truncateText(formatValue(last.value)), attempts, timeoutMs, comparison: check.comparison }
  return { ...failure('check_failed', `${mismatch} ${looked}`, location), details }
}

// The error was recorded where it happened, or is recorded now, and reaches the test as it was thrown.
function stopWith(run: TestRun, fields: AssertionFields, error: RetestError): never {
  run.countAssertion()
  run.emit({ type: 'assertion.failed', ...fields, failure: error.failure })
  run.recordThrown(error)
  throw error
}

async function readOnce({ run, stepId, read }: ValuePoll, deadline: Deadline): Promise<Look> {
  const scope = stepId === undefined ? { run, reading: true as const } : { run, stepId, reading: true as const }
  const stop = new AbortController()
  const reading = callInScope(scope, read).then(
    (value): Look => ({ kind: 'value', value }),
    (error: unknown): Look => ({ kind: 'threw', error }),
  )
  const waitForEnd = async (): Promise<void> => {
    do {
      await run.time.sleep(Math.max(1, deadline.waitToEndMs), stop.signal)
    } while (!deadline.reached)
  }
  const late = waitForEnd().then(
    (): Look => ({ kind: 'late' }),
    (): Look => ({ kind: 'late' }),
  )
  try {
    return await Promise.race([reading, late])
  } finally {
    stop.abort()
  }
}

function waitBefore(attempt: number, intervals: readonly number[] | undefined): number {
  if (attempt === 0) return 0
  if (intervals === undefined) return pollDelay(attempt)
  return intervals[Math.min(attempt, intervals.length) - 1] ?? 0
}
