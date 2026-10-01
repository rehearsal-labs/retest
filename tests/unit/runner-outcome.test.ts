import type { Failure } from '../../src/protocol/failures.ts'
import type { FileResult, TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { countTests, interruptedExitCode, interruptionOf, runOutcome, stopReasonOf, stopSignalOf, stoppedExitCode, testStatus } from '../../src/runner/outcome.ts'

const failed = (kind: Failure['class'], message: string = kind): Failure => ({ class: kind, message })

function result(status: TestResult['status'], extra: Partial<TestResult> = {}): TestResult {
  return {
    testId: `a.retest.ts > ${status}`,
    name: status,
    file: 'a.retest.ts',
    location: { file: 'a.retest.ts', line: 1, column: 1 },
    attemptId: 'attempt',
    status,
    durationMs: 1,
    assertionCount: 1,
    evidence: [],
    ...extra,
  }
}

function file(tests: TestResult[], collection: FileResult['collection'] = 'ok', name = 'a.retest.ts'): FileResult {
  return collection === 'ok' ? { file: name, collection, tests } : { file: name, collection, failure: failed('collection_failed', `${name} cannot load`), tests }
}

const facts = { stoppedBy: undefined, runFailures: [], outputFailures: [] }
const lostEvents = failed('reporting_failed', 'Retest could not write events.jsonl: the disk is full')

describe('testStatus', () => {
  test('no failure passes; a cleanup failure alone is an error', () => {
    assert.equal(testStatus(undefined), 'passed')
    assert.equal(testStatus(undefined, [failed('cleanup_failed')]), 'error')
  })

  test('our own problems make an error', () => {
    for (const kind of ['session_lost', 'outcome_unknown', 'setup_failed', 'cleanup_failed', 'unsupported', 'interrupted', 'reporting_failed'] as const) {
      assert.equal(testStatus(failed(kind)), 'error', kind)
    }
  })

  test('every other class is a failed test, timeouts included, whatever cleanup did', () => {
    for (const kind of ['check_failed', 'not_found', 'ambiguous', 'not_actionable', 'timeout', 'test_error', 'no_assertions', 'not_awaited', 'concurrent_commands', 'usage', 'collection_failed'] as const) {
      assert.equal(testStatus(failed(kind)), 'failed', kind)
      assert.equal(testStatus(failed(kind), [failed('cleanup_failed')]), 'failed', `${kind} with a cleanup failure`)
    }
  })
})

describe('runOutcome', () => {
  test('0 when every test passed', () => {
    assert.deepEqual(runOutcome({ ...facts, files: [file([result('passed'), result('passed')])] }), {
      status: 'passed',
      exitCode: 0,
      complete: true,
      counts: { passed: 2, failed: 0, error: 0, notRun: 0, inconclusive: 0 },
    })
  })

  test('130 or 143 first, whatever else happened', () => {
    const files = [file([result('failed'), result('not_run')])]
    const outcome = runOutcome({ stoppedBy: 'SIGINT', runFailures: [], outputFailures: [lostEvents], files })
    assert.equal(outcome.exitCode, 130)
    assert.equal(outcome.status, 'interrupted')
    assert.equal(outcome.complete, false)
    const terminated = runOutcome({ stoppedBy: 'SIGTERM', runFailures: [], outputFailures: [], files: [file([result('passed')])] })
    assert.deepEqual([terminated.exitCode, terminated.status, terminated.complete], [143, 'interrupted', false])
  })

  test('the signal comes from the abort reason, and any other reason counts as SIGINT', () => {
    const stopped = (reason?: unknown): AbortSignal => {
      const controller = new AbortController()
      controller.abort(reason)
      return controller.signal
    }
    assert.equal(stopSignalOf(stopped('SIGTERM')), 'SIGTERM')
    assert.equal(stopSignalOf(stopped('SIGINT')), 'SIGINT')
    assert.equal(stopSignalOf(stopped()), 'SIGINT')
    assert.equal(stopSignalOf(stopped(new Error('SIGTERM'))), 'SIGINT')
    assert.equal(interruptedExitCode(stopped('SIGTERM')), 143)
    assert.equal(interruptedExitCode(stopped()), 130)
  })

  test('a Failure a caller stopped the run with exits 130, and is the run\'s own failure, ahead of anything else', () => {
    const reason = failed('interrupted', 'The host stopped the run: its budget ran out.')
    const files = [file([result('passed'), result('error', { failure: reason }), result('not_run', { failure: reason })])]
    const outcome = runOutcome({ stoppedBy: reason, runFailures: [], outputFailures: [], files })
    assert.deepEqual([outcome.exitCode, outcome.status, outcome.complete, outcome.failure], [130, 'interrupted', false, reason])
    const withLostOutput = runOutcome({ stoppedBy: reason, runFailures: [], outputFailures: [lostEvents], files })
    assert.deepEqual(withLostOutput.failure, { ...reason, details: { also: `reporting_failed: ${lostEvents.message}` } })
    const bySignal = runOutcome({ stoppedBy: 'SIGINT', runFailures: [], outputFailures: [], files })
    assert.equal(bySignal.failure, undefined, 'a signal says so in the status alone')
  })

  test('the reason comes from the abort signal: a Failure as it is, SIGTERM, and anything else as SIGINT', () => {
    const reason = failed('setup_failed', 'The host lost its proxy.')
    assert.deepEqual(stopReasonOf(AbortSignal.abort(reason)), reason)
    assert.equal(stopReasonOf(AbortSignal.abort('SIGTERM')), 'SIGTERM')
    assert.equal(stopReasonOf(AbortSignal.abort()), 'SIGINT')
    assert.equal(stopReasonOf(AbortSignal.abort({ class: 'nonsense', message: 'not a failure' })), 'SIGINT')
    assert.deepEqual(interruptionOf(reason), reason)
    assert.deepEqual(interruptionOf('SIGTERM'), { class: 'interrupted', message: 'The run was stopped by SIGTERM.' })
    assert.deepEqual(interruptionOf('SIGINT'), { class: 'interrupted', message: 'The run was interrupted.' })
    assert.deepEqual([stoppedExitCode(reason), interruptedExitCode(AbortSignal.abort(reason))], [130, 130])
  })

  test('2 when nothing trustworthy came out: no tests, every file failing collection, or nothing run', () => {
    assert.equal(runOutcome({ ...facts, files: [] }).exitCode, 2)
    assert.equal(runOutcome({ ...facts, files: [file([], 'failed'), file([], 'failed')] }).exitCode, 2)
    const launchFailed = runOutcome({ ...facts, files: [file([result('not_run', { failure: failed('setup_failed') })])] })
    assert.equal(launchFailed.exitCode, 2)
    assert.equal(launchFailed.status, 'error')
  })

  test('2 when results could not be written, even with a failed test', () => {
    assert.equal(runOutcome({ stoppedBy: undefined, runFailures: [], outputFailures: [lostEvents], files: [file([result('failed')])] }).exitCode, 2)
    assert.equal(runOutcome({ stoppedBy: undefined, runFailures: [], outputFailures: [lostEvents], files: [file([result('passed')])] }).complete, false)
  })

  test('1 once a test failed its checks, even beside errors, tests that did not run and failed collection', () => {
    const outcome = runOutcome({
      ...facts,
      files: [file([result('failed'), result('error'), result('not_run')]), file([], 'failed')],
    })
    assert.equal(outcome.exitCode, 1)
    assert.equal(outcome.status, 'failed')
    assert.equal(outcome.complete, false)
    assert.deepEqual(outcome.counts, { passed: 0, failed: 1, error: 1, notRun: 1, inconclusive: 0 })
  })

  test('a run of failed tests that all reached a verdict is complete', () => {
    const outcome = runOutcome({ ...facts, files: [file([result('failed'), result('passed')])] })
    assert.equal(outcome.exitCode, 1)
    assert.equal(outcome.complete, true)
  })

  test('2 when no test failed but something did not finish cleanly', () => {
    assert.equal(runOutcome({ ...facts, files: [file([result('passed'), result('error')])] }).exitCode, 2)
    assert.equal(runOutcome({ ...facts, files: [file([result('passed'), result('not_run')])] }).exitCode, 2)
    assert.equal(runOutcome({ ...facts, files: [file([result('passed')]), file([], 'failed')] }).exitCode, 2)
    const cleanup = runOutcome({ ...facts, files: [file([result('passed', { cleanupFailures: [failed('cleanup_failed')] })])] })
    assert.equal(cleanup.exitCode, 2)
    assert.equal(cleanup.status, 'error')
  })

  test('a run with every test passed or failed has no failure of its own', () => {
    assert.equal(runOutcome({ ...facts, files: [file([result('failed'), result('passed')])] }).failure, undefined)
    assert.equal(runOutcome({ ...facts, files: [file([result('error'), result('not_run', { failure: failed('test_error') })])] }).failure, undefined)
  })

  test('with nothing selected, the run fails as a usage error', () => {
    assert.deepEqual(runOutcome({ ...facts, files: [] }).failure, {
      class: 'usage',
      message: 'No test files were selected, so no test ran.',
    })
  })

  test('when no test ran, the run fails with the first reason in run order', () => {
    const uncollected = runOutcome({ ...facts, files: [file([], 'failed', 'a.retest.ts'), file([], 'failed', 'b.retest.ts')] })
    assert.deepEqual(uncollected.failure, failed('collection_failed', 'a.retest.ts cannot load'))
    const launch = failed('setup_failed', 'No browser at /opt/chromium.')
    const notLaunched = runOutcome({
      ...facts,
      files: [file([], 'failed', 'a.retest.ts'), file([result('not_run', { failure: launch }), result('not_run', { failure: launch })], 'ok', 'b.retest.ts')],
    })
    assert.deepEqual(notLaunched.failure, failed('collection_failed', 'a.retest.ts cannot load'))
    assert.deepEqual(runOutcome({ ...facts, files: [file([result('not_run', { failure: launch })])] }).failure, launch)
  })

  test('lost output is the run failure, and a second loss is kept beside the first', () => {
    const lostResult = failed('reporting_failed', 'Retest could not write result.json: the disk is full')
    assert.deepEqual(runOutcome({ ...facts, outputFailures: [lostEvents], files: [file([result('passed')])] }).failure, lostEvents)
    const both = runOutcome({ ...facts, outputFailures: [lostEvents, lostResult], files: [file([result('failed')])] }).failure
    assert.deepEqual(both, { ...lostEvents, details: { also: `reporting_failed: ${lostResult.message}` } })
  })

  test('an interrupted run explains itself by its status, unless output was lost', () => {
    assert.equal(runOutcome({ stoppedBy: 'SIGINT', runFailures: [], outputFailures: [], files: [file([], 'failed')] }).failure, undefined)
    assert.deepEqual(runOutcome({ stoppedBy: 'SIGINT', runFailures: [], outputFailures: [lostEvents], files: [] }).failure, lostEvents)
  })

  test('a file whose process failed outside its tests leaves the run incomplete, and is the run failure', () => {
    const thrown = failed('test_error', 'a.retest.ts threw an error while no test was running: Error: late')
    const passed: FileResult = { ...file([result('passed')]), failure: thrown }
    const outcome = runOutcome({ ...facts, files: [passed] })
    assert.deepEqual(
      [outcome.exitCode, outcome.status, outcome.complete, outcome.failure],
      [2, 'error', false, thrown],
    )
    const failing = runOutcome({ ...facts, files: [{ ...file([result('failed')]), failure: thrown }] })
    assert.deepEqual([failing.exitCode, failing.complete], [1, false], 'a failed check still decides the exit code')
    const withLostOutput = runOutcome({ ...facts, outputFailures: [lostEvents], files: [passed] }).failure
    assert.deepEqual(withLostOutput, { ...lostEvents, details: { also: `test_error: ${thrown.message}` } })
  })

  test('counts every status', () => {
    const files = [file([result('passed'), result('failed'), result('error'), result('not_run'), result('inconclusive')])]
    assert.deepEqual(countTests(files), { passed: 1, failed: 1, error: 1, notRun: 1, inconclusive: 1 })
  })
})
