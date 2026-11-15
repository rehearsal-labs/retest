import type { EventBody, RetestEvent, TestStatus } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { RunRecord } from '../../src/reporters/run-record.ts'
import { stamp } from './reporters-fixtures.ts'

// A reporter of a running run lets go of each finished test it will not read again, so what it holds does not grow
// with the run's tests; a test the end of the run makes a card for keeps every event.

const location = { file: 'a.retest.ts', line: 1, column: 1 }
const variant = { web: 'chromium' }
const named = { variant, variantKey: 'web=chromium' }

function attempt(testId: string, attemptId: string, status: TestStatus): EventBody[] {
  const scope = { testId, attemptId, ...named }
  return [
    { type: 'test.started', ...scope, name: testId, file: 'a.retest.ts', location },
    { type: 'action.completed', ...scope, command: 'goto', session: 'web', durationMs: 3 },
    { type: 'assertion.passed', ...scope, session: 'web', matcher: 'toBeVisible', locator: { by: 'testId', value: 'saved' }, expected: null, actual: null, attempts: 1, durationMs: 4, judgedBy: 'parent' },
    { type: 'test.finished', ...scope, status, durationMs: 9, assertionCount: 1, ending: { kind: status === 'passed' ? 'passed' : 'skipped' } },
  ]
}

function finished(events: readonly RetestEvent[], testId: string): Extract<RetestEvent, { type: 'test.finished' }> {
  const found = events.find((event): event is Extract<RetestEvent, { type: 'test.finished' }> => event.type === 'test.finished' && event.testId === testId)
  assert.ok(found, `${testId} finished`)
  return found
}

const collected: EventBody = {
  type: 'collection.completed',
  file: 'a.retest.ts',
  tests: ['passes', 'fails', 'again'].map((name) => ({ testId: name, name, location, variants: [variant] })),
}

describe('a record that lets go of finished tests', () => {
  test('keeps nothing of a test that passed once it is released, and keeps its description', () => {
    const events = stamp([collected, ...attempt('passes', 'p1', 'passed')])
    const record = new RunRecord()
    for (const event of events) record.add(event)
    const test = record.test('passes', 'web=chromium')
    assert.equal(test?.events.length, 4)
    record.release(finished(events, 'passes'))
    assert.deepEqual(test?.events, [])
    assert.equal(test?.started, undefined)
    assert.equal(test?.finished, undefined)
    assert.deepEqual([test?.name, test?.variantKey, test?.location], ['passes', 'web=chromium', location])
  })

  test('keeps every event of a test a card is made for', () => {
    for (const status of ['failed', 'error', 'inconclusive'] as const) {
      const events = stamp([collected, ...attempt('fails', 'f1', status)])
      const record = new RunRecord()
      for (const event of events) record.add(event)
      record.release(finished(events, 'fails'))
      const test = record.test('fails', 'web=chromium')
      assert.deepEqual(test?.events.map((event) => event.type), ['test.started', 'action.completed', 'assertion.passed', 'test.finished'], status)
      assert.equal(test?.started?.attemptId, 'f1')
    }
  })

  test('keeps no event that comes for a released test, and leaves none among the strays', () => {
    const scope = { testId: 'passes', attemptId: 'p1' }
    const late: EventBody[] = [
      { type: 'session.released', ...scope, ...named, owner: 'ci', sessions: 1, after: 'contexts_closed' },
      // A retention event names no variant, so the record finds its test by the attempt.
      { type: 'artifact.removed', ...scope, kind: 'recording', path: 'recordings/one.mp4', reason: 'passed_attempt_recording', moment: 'attempt_finished', bytes: 2 },
    ]
    const events = stamp([collected, ...attempt('passes', 'p1', 'passed'), ...late])
    const record = new RunRecord()
    for (const event of events) {
      record.add(event)
      if (event.type === 'test.finished') record.release(event)
    }
    assert.deepEqual(record.test('passes', 'web=chromium')?.events, [])
    assert.deepEqual(record.strays, [])
    assert.equal(record.removals.length, 1)
  })

  test('keeps a later attempt of a released test from its start', () => {
    const events = stamp([collected, ...attempt('again', 'a1', 'passed'), ...attempt('again', 'a2', 'failed')])
    const record = new RunRecord()
    for (const event of events) {
      record.add(event)
      if (event.type === 'test.finished') record.release(event)
    }
    const test = record.test('again', 'web=chromium')
    assert.deepEqual(test?.events.map((event) => [event.type, event.attemptId]), [
      ['test.started', 'a2'],
      ['action.completed', 'a2'],
      ['assertion.passed', 'a2'],
      ['test.finished', 'a2'],
    ])
    assert.equal(test?.finished?.status, 'failed')
  })

  test('a record that is never released keeps every event, as before', () => {
    const events = stamp([collected, ...attempt('passes', 'p1', 'passed')])
    const record = new RunRecord()
    for (const event of events) record.add(event)
    assert.equal(record.test('passes', 'web=chromium')?.events.length, 4)
    assert.equal(record.test('passes', 'web=chromium')?.started?.attemptId, 'p1')
  })
})
