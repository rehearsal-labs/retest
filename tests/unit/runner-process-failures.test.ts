import type { FileProcessEnd } from '../../src/runner/process-failures.ts'
import type { ClosedProcess } from '../../src/runner/test-file-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { failure } from '../../src/protocol/failures.ts'
import { endedAfterFinishing, fileProcessFailure, reportedErrors } from '../../src/runner/process-failures.ts'

const file = 'a.retest.ts'
const clean: FileProcessEnd = { file, closed: { exit: { code: 0, signal: null }, forced: false, finished: true }, errors: [], killed: false, exitRecorded: false }
const late = failure('test_error', 'Error: late', { file, line: 4, column: 9 })
const killedExit: ClosedProcess = { exit: { code: null, signal: 'SIGKILL' }, forced: false, finished: false }
const crashedAfterFinishing: ClosedProcess = { exit: { code: 3221226505, signal: null }, forced: false, finished: true }

describe('fileProcessFailure', () => {
  test('a process that closed cleanly after its tests leaves the file without a failure', () => {
    assert.equal(fileProcessFailure(clean), undefined)
  })

  test('every error reported while no test ran fails the file, first one leading, at its own location', () => {
    const second = failure('test_error', 'Error: later')
    const problem = fileProcessFailure({ ...clean, closed: { exit: { code: 1, signal: null }, forced: false, finished: false }, errors: [late, second] })
    assert.deepEqual(problem, {
      class: 'test_error',
      message: 'a.retest.ts threw an error while no test was running: Error: late',
      location: late.location,
      details: { also: 'test_error: a.retest.ts threw an error while no test was running: Error: later' },
    })
  })

  test('a reported error is kept even when a test already records how the process ended', () => {
    assert.equal(fileProcessFailure({ ...clean, errors: [late], exitRecorded: true, killed: true })?.location, late.location)
  })

  test('an exit code or a signal nobody explains fails the file', () => {
    assert.deepEqual(fileProcessFailure({ ...clean, closed: { exit: { code: 3, signal: null }, forced: false, finished: false } }), {
      class: 'test_error',
      message: 'The process for a.retest.ts ended with exit code 3 while no test was running.',
    })
    assert.equal(
      fileProcessFailure({ ...clean, closed: killedExit })?.message,
      'The process for a.retest.ts ended with signal SIGKILL while no test was running.',
    )
  })

  test('a process that did not close when asked, and had not said it had finished, fails the file', () => {
    const forced: FileProcessEnd = { ...clean, closed: { ...killedExit, forced: true }, killed: true }
    assert.deepEqual(fileProcessFailure(forced), {
      class: 'test_error',
      message: 'The process for a.retest.ts did not close within 1000 ms of being asked to, so Retest ended it.',
    })
  })

  test('an ending Retest caused, or a test already records, adds nothing', () => {
    assert.equal(fileProcessFailure({ ...clean, closed: killedExit, killed: true }), undefined)
    assert.equal(fileProcessFailure({ ...clean, closed: { exit: { code: 1, signal: null }, forced: false, finished: false }, exitRecorded: true }), undefined)
  })

  test('a process that ended badly after it said it had finished leaves the file without a failure, whatever the ending', () => {
    assert.equal(fileProcessFailure({ ...clean, closed: crashedAfterFinishing }), undefined)
    assert.equal(fileProcessFailure({ ...clean, closed: { ...killedExit, finished: true } }), undefined)
    assert.equal(fileProcessFailure({ ...clean, closed: { exit: { code: null, signal: 'SIGABRT' }, forced: false, finished: true } }), undefined)
  })

  test('the same ending before the process said it had finished fails the file as it always has', () => {
    assert.deepEqual(fileProcessFailure({ ...clean, closed: { ...crashedAfterFinishing, finished: false } }), {
      class: 'test_error',
      message: 'The process for a.retest.ts ended with exit code 3221226505 while no test was running.',
    })
  })

  test('errors the process reported still fail the file, though it said it had finished', () => {
    const problem = fileProcessFailure({ ...clean, closed: crashedAfterFinishing, errors: [late] })
    assert.deepEqual(problem, { class: 'test_error', message: 'a.retest.ts threw an error while no test was running: Error: late', location: late.location })
  })

  test('a process that said it had finished and then had not exited when Retest ended it leaves the file without a failure', () => {
    const forced: FileProcessEnd = { ...clean, closed: { ...killedExit, forced: true, finished: true }, killed: true }
    assert.equal(fileProcessFailure(forced), undefined)
  })

  test('errors the process reported still fail the file when Retest ended it after it said it had finished', () => {
    const forced: FileProcessEnd = { ...clean, closed: { ...killedExit, forced: true, finished: true }, killed: true, errors: [late] }
    assert.deepEqual(fileProcessFailure(forced), { class: 'test_error', message: 'a.retest.ts threw an error while no test was running: Error: late', location: late.location })
  })
})

describe('endedAfterFinishing', () => {
  test('names how a process ended badly after it said it had finished', () => {
    assert.equal(
      endedAfterFinishing({ ...clean, closed: crashedAfterFinishing }),
      'The process ended with exit code 3221226505 after it had finished its work. No test was running, so nothing fails.',
    )
    assert.equal(
      endedAfterFinishing({ ...clean, closed: { ...killedExit, finished: true } }),
      'The process ended with signal SIGKILL after it had finished its work. No test was running, so nothing fails.',
    )
  })

  test('names a process that had finished and had not exited when Retest ended it', () => {
    assert.equal(
      endedAfterFinishing({ ...clean, closed: { ...killedExit, forced: true, finished: true }, killed: true }),
      'The process had finished its work but had not exited within 1000 ms of being asked to close, so Retest ended it. No test was running, so nothing fails.',
    )
  })

  test('says nothing of a clean ending, an ending before the process said it had finished, or one that fails the file or Retest caused', () => {
    assert.equal(endedAfterFinishing(clean), undefined)
    assert.equal(endedAfterFinishing({ ...clean, closed: { ...crashedAfterFinishing, finished: false } }), undefined)
    assert.equal(endedAfterFinishing({ ...clean, closed: crashedAfterFinishing, errors: [late] }), undefined)
    assert.equal(endedAfterFinishing({ ...clean, closed: { ...killedExit, forced: true, finished: false }, killed: true }), undefined)
    assert.equal(endedAfterFinishing({ ...clean, closed: { ...killedExit, forced: true, finished: true }, killed: true, errors: [late] }), undefined)
    assert.equal(endedAfterFinishing({ ...clean, closed: { ...killedExit, finished: true }, killed: true }), undefined)
    assert.equal(endedAfterFinishing({ ...clean, closed: crashedAfterFinishing, exitRecorded: true }), undefined)
  })
})

describe('reportedErrors', () => {
  test('names the file and keeps each error in order', () => {
    assert.deepEqual(
      reportedErrors(file, [late]).map((problem) => problem.message),
      ['a.retest.ts threw an error while no test was running: Error: late'],
    )
    assert.deepEqual(reportedErrors(file, []), [])
  })
})
