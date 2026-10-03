import type { Counts, ExitCode, RunStatus, TestStatus } from '../protocol/events.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { FileResult } from '../protocol/result.ts'
import type { StopReason, StopSignal } from './contract.ts'
import { failure, failureSchema, withAlso } from '../protocol/failures.ts'
import { parse } from '../protocol/schema.ts'

// Our own infrastructure, or something the test could not decide, rather than the application failing a check.
const errorClasses: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'session_lost',
  'outcome_unknown',
  'setup_failed',
  'cleanup_failed',
  'unsupported',
  'interrupted',
  'reporting_failed',
  'evaluation_error',
])

/**
 * The status of a test that ran. A cleanup failure alone makes it `error`; with another failure, that
 * failure decides. A required AI check its judge could not decide makes it `inconclusive`.
 *
 * @example testStatus({ class: 'timeout', message: 'The test ran longer than its 3000 ms budget.' }) // 'failed'
 */
export function testStatus(failure: Failure | undefined, cleanupFailures: readonly Failure[] = []): 'passed' | 'failed' | 'error' | 'inconclusive' {
  if (failure === undefined) return cleanupFailures.length === 0 ? 'passed' : 'error'
  if (failure.class === 'evaluation_inconclusive') return 'inconclusive'
  return isOurs(failure) ? 'error' : 'failed'
}

/**
 * Whether a failure is ours, or something the test could not decide, rather than the application failing a check.
 * Such a failure makes a test `error`.
 *
 * @example isOurs({ class: 'session_lost', message: 'The browser was lost.' }) // true
 */
export function isOurs(failure: Failure): boolean {
  return errorClasses.has(failure.class)
}

/** What the runner knows at the end of a run, beyond the results in each file. */
export type RunFacts = {
  /** Why the run was stopped from outside, if it was: the signal, or the `Failure` its caller gave. */
  stoppedBy: StopReason | undefined
  /** What stopped the run before any test could run: a base URL for an app the config lacks, or a selection that matches nothing. */
  runFailures: readonly Failure[]
  /** Events, the result, a test file's output or a reporter that could not take the run's output, in order. */
  outputFailures: readonly Failure[]
  /**
   * Checks the host required that were never made, because test code skipped the test they belong to. Test code
   * cannot waive a host's check, so any of them keeps the run from passing.
   */
  hostFailures?: readonly Failure[]
  files: readonly FileResult[]
}

/** `failure` is the run's own failure, one that no single test explains. */
export type RunOutcome = { status: RunStatus; exitCode: ExitCode; complete: boolean; counts: Counts; failure?: Failure }

/**
 * Decides the run's status and exit code, in this order: 130 or 143 when interrupted, 130 for a `Failure` its
 * caller stopped it with; 2 when nothing trustworthy came out, a host's check among it; 1 when a test failed its checks; 2 when anything
 * else did not finish cleanly, including a file whose process failed outside its tests; otherwise 0.
 *
 * @example runOutcome({ stoppedBy: undefined, runFailures: [], outputFailures: [], files }).exitCode
 */
export function runOutcome(facts: RunFacts): RunOutcome {
  const counts = countTests(facts.files)
  const exitCode = decideExitCode(facts, counts)
  const problem = runFailure(facts, counts)
  const outcome = { status: runStatus(exitCode), exitCode, complete: isComplete(facts), counts }
  return problem === undefined ? outcome : { ...outcome, failure: problem }
}

/** How many tests ended each way. `skipped` is counted only when a test was skipped. */
export function countTests(files: readonly FileResult[]): Counts {
  const counts: Counts = { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 }
  for (const test of files.flatMap((file) => file.tests)) addToCounts(counts, test.status)
  return counts
}

/**
 * Counts one more test that ended with `status`.
 *
 * @example addToCounts(counts, 'skipped') // counts.skipped is 1 more, or 1
 */
export function addToCounts(counts: Counts, status: TestStatus): void {
  if (status === 'not_run') counts.notRun++
  else if (status === 'skipped') counts.skipped = (counts.skipped ?? 0) + 1
  else counts[status]++
}

/**
 * The signal a run was stopped with, from the reason its abort signal carries. Any other reason counts as
 * SIGINT.
 */
export function stopSignalOf(signal: AbortSignal): StopSignal {
  const reason: unknown = signal.reason
  return reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT'
}

/**
 * Why a run was stopped, from the reason its abort signal carries: a `Failure` as it is, SIGTERM, and anything
 * else as SIGINT.
 *
 * @example stopReasonOf(AbortSignal.abort({ class: 'interrupted', message: 'The host ran out of time.' })) // the Failure
 */
export function stopReasonOf(signal: AbortSignal): StopReason {
  const reason = parse(failureSchema, signal.reason)
  return reason.ok ? reason.value : stopSignalOf(signal)
}

/**
 * What a stopped run records as its interruption, in `run.finished` and in each test it stopped: the `Failure` it
 * was stopped with, or what the signal says.
 *
 * @example interruptionOf('SIGTERM') // { class: 'interrupted', message: 'The run was stopped by SIGTERM.' }
 */
export function interruptionOf(reason: StopReason): Failure {
  if (typeof reason !== 'string') return reason
  return failure('interrupted', reason === 'SIGTERM' ? 'The run was stopped by SIGTERM.' : 'The run was interrupted.')
}

/** @example stoppedExitCode('SIGTERM') // 143 */
export function stoppedExitCode(reason: StopReason): 130 | 143 {
  return reason === 'SIGTERM' ? 143 : 130
}

/** The exit code of a command whose run was stopped through `signal`. */
export function interruptedExitCode(signal: AbortSignal): 130 | 143 {
  return stoppedExitCode(stopSignalOf(signal))
}

function decideExitCode(facts: RunFacts, counts: Counts): ExitCode {
  if (facts.stoppedBy !== undefined) return stoppedExitCode(facts.stoppedBy)
  if (testsRan(counts) === 0 || facts.outputFailures.length > 0 || facts.runFailures.length > 0 || (facts.hostFailures?.length ?? 0) > 0) return 2
  if (counts.failed > 0) return 1
  if (counts.error > 0 || counts.notRun > 0 || counts.inconclusive > 0 || hasUnfinishedWork(facts.files)) return 2
  return 0
}

// The Failure the run was stopped with, what stopped the run before its tests, lost output, a file's process that
// failed outside its tests, or the reason no test ran. A run a signal interrupted says so in its status instead.
function runFailure(facts: RunFacts, counts: Counts): Failure | undefined {
  const { stoppedBy } = facts
  const stopped = stoppedBy === undefined || typeof stoppedBy === 'string' ? [] : [stoppedBy]
  const [first, ...rest] = [...stopped, ...facts.runFailures, ...(facts.hostFailures ?? []), ...facts.outputFailures, ...processFailures(facts.files)]
  if (first !== undefined) return withAlso(first, rest)
  if (facts.stoppedBy !== undefined || testsRan(counts) > 0) return undefined
  return whyNothingRan(facts.files)
}

function processFailures(files: readonly FileResult[]): Failure[] {
  return files.flatMap((file) => (file.collection === 'ok' && file.failure !== undefined ? [file.failure] : []))
}

// The first reason in run order: a file that could not be collected, or a test kept from running, such
// as by a browser that did not start. Skipped tests have no failure: the run checked nothing because of them.
function whyNothingRan(files: readonly FileResult[]): Failure {
  const reasons = files.flatMap((file) => [file.failure, ...file.tests.map((test) => test.failure)])
  const reason = reasons.find((found) => found !== undefined)
  if (reason !== undefined) return reason
  const skipped = files.some((file) => file.tests.some((test) => test.status === 'skipped'))
  return failure('usage', skipped ? 'Every selected test is skipped, so no test ran.' : 'No test files were selected, so no test ran.')
}

function testsRan(counts: Counts): number {
  return counts.passed + counts.failed + counts.error + counts.inconclusive
}

// A file that failed collection has a failure too.
function hasUnfinishedWork(files: readonly FileResult[]): boolean {
  return files.some((file) => file.failure !== undefined || file.tests.some((test) => (test.cleanupFailures?.length ?? 0) > 0))
}

function runStatus(exitCode: ExitCode): RunStatus {
  switch (exitCode) {
    case 0:
      return 'passed'
    case 1:
      return 'failed'
    case 2:
      return 'error'
    case 130:
    case 143:
      return 'interrupted'
  }
}

// Complete means every selected test reached a verdict of its own, or was skipped as its file declared, every file
// ended cleanly and every output was kept.
function isComplete(facts: RunFacts): boolean {
  if (facts.stoppedBy !== undefined || facts.outputFailures.length > 0 || facts.runFailures.length > 0 || (facts.hostFailures?.length ?? 0) > 0) return false
  const settled: readonly TestStatus[] = ['passed', 'failed', 'skipped']
  return facts.files.every((file) => file.failure === undefined && file.tests.every((test) => settled.includes(test.status)))
}
