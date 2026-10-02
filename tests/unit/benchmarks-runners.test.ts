import type { RunFacts } from '../../benchmarks/phases.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { outcomeFromReport } from '../../benchmarks/runners/playwright.ts'
import { outcomeFromEvents } from '../../benchmarks/runners/retest.ts'

const iso = (ms: number): string => new Date(ms).toISOString()
const run: RunFacts = { startedAt: 1000, endedAt: 5000, code: 0, timedOut: false, timeoutMs: 60_000 }
const expectedPhases = { wall: 4000, startup: 500, tests: 600, teardown: 2900, perTest: 250 }

function events(secondStatus = 'passed'): string {
  return [
    { type: 'run.started', time: iso(1100) },
    { type: 'test.started', time: iso(1500) },
    { type: 'test.finished', time: iso(1800), durationMs: 300, status: 'passed' },
    'not json at all',
    { type: 'test.started', time: iso(1900) },
    { type: 'test.finished', time: iso(2100), durationMs: 200, status: secondStatus },
    { type: 'run.finished', time: iso(2400) },
  ]
    .map((line) => (typeof line === 'string' ? line : JSON.stringify(line)))
    .join('\n')
}

describe('outcomeFromEvents', () => {
  test('bounds the tests phase by the first start and the last finish, and counts the finishes', () => {
    const outcome = outcomeFromEvents(events(), run, 2, 'no events.jsonl')
    assert.equal(outcome.valid, true)
    assert.deepEqual(outcome.phases, expectedPhases)
    assert.equal(outcome.passed, 2)
    assert.equal(outcome.failed, 0)
  })

  test('a finish that did not pass fails the run, whatever the exit code', () => {
    const outcome = outcomeFromEvents(events('failed'), run, 2, 'no events.jsonl')
    assert.equal(outcome.valid, false)
    assert.equal(outcome.reason, '1 failed')
    assert.equal(outcome.phases?.tests, 600)
  })

  test('names the missing file, a run with no tests, and a timeout before anything else', () => {
    assert.equal(outcomeFromEvents(undefined, run, 2, 'no events.jsonl: boom').reason, 'no events.jsonl: boom')
    assert.equal(outcomeFromEvents(JSON.stringify({ type: 'run.started', time: iso(1100) }), run, 2, 'x').reason, 'no test ran')
    assert.equal(outcomeFromEvents(events(), { ...run, timedOut: true, code: null }, 2, 'x').reason, 'timed out after 60000 ms')
  })
})

function report(unexpected = 0): string {
  const result = (ms: number, duration: number) => ({ status: 'passed', duration, startTime: iso(ms) })
  return JSON.stringify({
    stats: { startTime: iso(1200), duration: 1500, expected: 2 - unexpected, unexpected, flaky: 0, skipped: 0 },
    suites: [
      {
        title: 'bench-1.spec.ts',
        specs: [{ title: 'a', tests: [{ results: [result(1500, 300)] }] }],
        suites: [{ title: 'inner', specs: [{ title: 'b', tests: [{ results: [result(1900, 200)] }] }] }],
      },
    ],
  })
}

describe('outcomeFromReport', () => {
  test('reads the counts from stats and the tests phase from every result, nested suites included', () => {
    const outcome = outcomeFromReport(`Running 2 tests\n${report()}`, '', run, 2)
    assert.equal(outcome.valid, true)
    assert.deepEqual(outcome.phases, expectedPhases)
    assert.equal(outcome.passed, 2)
  })

  test('an unexpected result fails the run', () => {
    const outcome = outcomeFromReport(report(1), '', { ...run, code: 1 }, 2)
    assert.equal(outcome.valid, false)
    assert.equal(outcome.reason, 'exit code 1')
    assert.equal(outcome.failed, 1)
  })

  test('names a missing report with the last line of stderr, a report with no tests, and a timeout', () => {
    assert.equal(outcomeFromReport('garbage', 'Error: config not found\n', run, 2).reason, 'no JSON report: Error: config not found')
    assert.equal(outcomeFromReport('', '', run, 2).reason, 'no JSON report: no output')
    assert.equal(outcomeFromReport(JSON.stringify({ stats: {}, suites: [] }), '', run, 2).reason, 'no test ran')
    assert.equal(outcomeFromReport(report(), '', { ...run, timedOut: true }, 2).reason, 'timed out after 60000 ms')
  })
})
