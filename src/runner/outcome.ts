import type { Counts, ExitCode, RunStatus } from '../protocol/events.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { FileResult } from '../protocol/result.ts'
import type { StopSignal } from './contract.ts'
import { failure, withAlso } from '../protocol/failures.ts'

// Our own infrastructure, or something the test could not decide, rather than the application failing a check.
const errorClasses: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'session_lost',
  'outcome_unknown',
  'setup_failed',
  'cleanup_failed',
  'unsupported',
  'interrupted',
  'reporting_failed',
])

/**
 * The status of a test that ran. A cleanup failure alone makes it `error`; with another failure, that
 * failure decides.
 *
 * @example testStatus({ class: 'timeout', message: 'The test ran longer than its 3000 ms budget.' }) // 'failed'
 */
export function testStatus(failure: Failure | undefined, cleanupFailures: readonly Failure[] = []): 'passed' | 'failed' | 'error' {
  if (failure === undefined) return cleanupFailures.length === 0 ? 'passed' : 'error'
  return errorClasses.has(failure.class) ? 'error' : 'failed'
}

/** What the runner knows at the end of a run, beyond the results in each file. */
export type RunFacts = {
  /** The signal that stopped the run, if one did. */
  stoppedBy: StopSignal | undefined
  /** What stopped the run before any test could run: a base URL for an app the config lacks, or a selection that matches nothing. */
  runFailures: readonly Failure[]
  /** Events, the result, a test file's output or a reporter that could not take the run's output, in order. */
  outputFailures: readonly Failure[]
  files: readonly FileResult[]
}

/** `failure` is the run's own failure, one that no single test explains. */
export type RunOutcome = { status: RunStatus; exitCode: ExitCode; complete: boolean; counts: Counts; failure?: Failure }

/**
 * Decides the run's status and exit code, in this order: 130 or 143 when interrupted; 2 when nothing
 * trustworthy came out; 1 when a test failed its checks; 2 when anything else did not finish cleanly,
 * including a file whose process failed outside its tests; otherwise 0.
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

export function countTests(files: readonly FileResult[]): Counts {
  const counts: Counts = { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 }
  for (const test of files.flatMap((file) => file.tests)) {
    if (test.status === 'not_run') counts.notRun++
    else counts[test.status]++
  }
  return counts
}

/**
 * The signal a run was stopped with, from the reason its abort signal carries. Any other reason counts as
 * SIGINT.
 */
export function stopSignalOf(signal: AbortSignal): StopSignal {
  const reason: unknown = signal.reason
  return reason === 'SIGTERM' ? 'SIGTERM' : 'SIGINT'
}

/** @example stoppedExitCode('SIGTERM') // 143 */
export function stoppedExitCode(signal: StopSignal): 130 | 143 {
  return signal === 'SIGTERM' ? 143 : 130
}

/** The exit code of a command whose run was stopped through `signal`. */
export function interruptedExitCode(signal: AbortSignal): 130 | 143 {
  return stoppedExitCode(stopSignalOf(signal))
}

function decideExitCode(facts: RunFacts, counts: Counts): ExitCode {
  if (facts.stoppedBy !== undefined) return stoppedExitCode(facts.stoppedBy)
  if (testsRan(counts) === 0 || facts.outputFailures.length > 0 || facts.runFailures.length > 0) return 2
  if (counts.failed > 0) return 1
  if (counts.error > 0 || counts.notRun > 0 || counts.inconclusive > 0 || hasUnfinishedWork(facts.files)) return 2
  return 0
}

// What stopped the run before its tests, lost output, a file's process that failed outside its tests, or the
// reason no test ran. An interrupted run says so in its status instead.
function runFailure(facts: RunFacts, counts: Counts): Failure | undefined {
  const [first, ...rest] = [...facts.runFailures, ...facts.outputFailures, ...processFailures(facts.files)]
  if (first !== undefined) return withAlso(first, rest)
  if (facts.stoppedBy !== undefined || testsRan(counts) > 0) return undefined
  return whyNothingRan(facts.files)
}

function processFailures(files: readonly FileResult[]): Failure[] {
  return files.flatMap((file) => (file.collection === 'ok' && file.failure !== undefined ? [file.failure] : []))
}

// The first reason in run order: a file that could not be collected, or a test kept from running, such
// as by a browser that did not start.
function whyNothingRan(files: readonly FileResult[]): Failure {
  const reasons = files.flatMap((file) => [file.failure, ...file.tests.map((test) => test.failure)])
  return reasons.find((reason) => reason !== undefined) ?? failure('usage', 'No test files were selected, so no test ran.')
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

// Complete means every selected test reached a verdict of its own, every file ended cleanly and every
// output was kept.
function isComplete(facts: RunFacts): boolean {
  if (facts.stoppedBy !== undefined || facts.outputFailures.length > 0 || facts.runFailures.length > 0) return false
  return facts.files.every(
    (file) => file.failure === undefined && file.tests.every((test) => test.status === 'passed' || test.status === 'failed'),
  )
}
