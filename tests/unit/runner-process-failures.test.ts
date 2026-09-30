import type { FileProcessEnd } from '../../src/runner/process-failures.ts'
import type { ClosedProcess } from '../../src/runner/test-file-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { failure } from '../../src/protocol/failures.ts'
import { fileProcessFailure, reportedErrors } from '../../src/runner/process-failures.ts'

const file = 'a.retest.ts'
const clean: FileProcessEnd = { file, closed: { exit: { code: 0, signal: null }, forced: false }, errors: [], killed: false, exitRecorded: false }
const late = failure('test_error', 'Error: late', { file, line: 4, column: 9 })
const killedExit: ClosedProcess = { exit: { code: null, signal: 'SIGKILL' }, forced: false }

describe('fileProcessFailure', () => {
  test('a process that closed cleanly after its tests leaves the file without a failure', () => {
    assert.equal(fileProcessFailure(clean), undefined)
  })

  test('every error reported while no test ran fails the file, first one leading, at its own location', () => {
    const second = failure('test_error', 'Error: later')
    const problem = fileProcessFailure({ ...clean, closed: { exit: { code: 1, signal: null }, forced: false }, errors: [late, second] })
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
    assert.deepEqual(fileProcessFailure({ ...clean, closed: { exit: { code: 3, signal: null }, forced: false } }), {
      class: 'test_error',
      message: 'The process for a.retest.ts ended with exit code 3 while no test was running.',
    })
    assert.equal(
      fileProcessFailure({ ...clean, closed: killedExit })?.message,
      'The process for a.retest.ts ended with signal SIGKILL while no test was running.',
    )
  })

  test('a process that did not close when asked fails the file', () => {
    const forced: FileProcessEnd = { ...clean, closed: { ...killedExit, forced: true }, killed: true }
    assert.match(fileProcessFailure(forced)?.message ?? '', /^The process for a\.retest\.ts did not close within 1000 ms of being asked/)
  })

  test('an ending Retest caused, or a test already records, adds nothing', () => {
    assert.equal(fileProcessFailure({ ...clean, closed: killedExit, killed: true }), undefined)
    assert.equal(fileProcessFailure({ ...clean, closed: { exit: { code: 1, signal: null }, forced: false }, exitRecorded: true }), undefined)
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
