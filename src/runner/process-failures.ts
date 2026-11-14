import type { Failure } from '../protocol/failures.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { BodyReport } from './running-test.ts'
import type { ClosedProcess } from './test-file-process.ts'
import { failure, withAlso } from '../protocol/failures.ts'
import { describeExit } from '../shared/process-exit.ts'
import { abortGraceMs } from './running-test.ts'
import { endedCleanly } from './test-file-process.ts'

/**
 * Why the tests after this one cannot run in the file's process: it timed out, and code from it may still
 * be running there, or the process ended during it, or Retest killed it then.
 */
export function laterTestsReason(name: string, report: BodyReport): Failure | undefined {
  const test = JSON.stringify(name)
  if (report.timedOut) {
    return failure('timeout', `Not run: ${test} timed out, and Retest ended the process for this file because code from that test may still be running.`)
  }
  if (report.processEnded === undefined && report.processKilled !== true) return undefined
  const message = `Not run: the process for this file ended during ${test}, and Retest does not rerun tests in a new one.`
  return failure(report.failure?.class ?? 'test_error', message)
}

/**
 * Why a test cannot run: the file's process ended before its body started, as on a stray error after the
 * previous test.
 *
 * @example endedBeforeTest({ code: 1, signal: null }).message // 'Not run: the process for this file ended before this test could run (exit code 1).'
 */
export function endedBeforeTest(exit: ProcessExit): Failure {
  return failure('test_error', `Not run: the process for this file ended before this test could run (${describeExit(exit)}).`)
}

export type FileProcessEnd = {
  file: string
  /** How the process ended once Retest was done with it and asked it to close. */
  closed: ClosedProcess
  /** Errors the process reported while no test was running. */
  errors: readonly Failure[]
  /** Retest killed it: after a timeout, a message it could not read or an interrupt, or when it did not close. */
  killed: boolean
  /** A test's result already says how the process ended. */
  exitRecorded: boolean
}

/**
 * The failure of a file whose process failed outside its tests: every error it reported while no test
 * was running, or else an ending that Retest did not cause, no test result explains and that did not come after
 * the process said it had finished.
 *
 * @example fileProcessFailure({ file, closed: { exit: { code: 3, signal: null }, forced: false, finished: false }, errors: [], killed: false, exitRecorded: false })
 */
export function fileProcessFailure(end: FileProcessEnd): Failure | undefined {
  const reported = reportedErrors(end.file, end.errors)
  const [first, ...rest] = reported.length > 0 ? reported : unexplainedEnding(end)
  return first === undefined ? undefined : withAlso(first, rest)
}

/**
 * The line a file's process log keeps when its process ended badly after it said it had finished, which fails
 * nothing; undefined for every other ending.
 *
 * @example endedAfterFinishing({ file, closed: { exit: { code: 3, signal: null }, forced: false, finished: true }, errors: [], killed: false, exitRecorded: false }) // 'The process ended with exit code 3 after it had finished its work. No test was running, so nothing fails.'
 */
export function endedAfterFinishing(end: FileProcessEnd): string | undefined {
  const { closed } = end
  if (!closed.finished || closed.forced || end.killed || end.exitRecorded || endedCleanly(closed.exit)) return undefined
  if (fileProcessFailure(end) !== undefined) return undefined
  return `The process ended with ${describeExit(closed.exit)} after it had finished its work. No test was running, so nothing fails.`
}

/** Errors a file's process reported while no test was running, as failures of that file. */
export function reportedErrors(file: string, errors: readonly Failure[]): Failure[] {
  return errors.map((error) => failure('test_error', `${file} threw an error while no test was running: ${error.message}`, error.location))
}

function unexplainedEnding({ file, closed, killed, exitRecorded }: FileProcessEnd): Failure[] {
  if (exitRecorded) return []
  if (closed.forced) {
    const message = `The process for ${file} did not close within ${abortGraceMs} ms of being asked to, so Retest ended it.`
    return [failure('test_error', message)]
  }
  if (killed || endedCleanly(closed.exit)) return []
  // `finished` counts only after Retest asked the process to close, once every test had reported and the work the
  // process had queued had run. How it ends after that, as when Node fails while the process exits on Windows, can
  // change no result, so it fails nothing.
  if (closed.finished) return []
  return [failure('test_error', `The process for ${file} ended with ${describeExit(closed.exit)} while no test was running.`)]
}
