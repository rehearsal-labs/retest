import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { judge, median, medianPhases, phasesFrom, type Marks, type RunOutcome } from '../../benchmarks/phases.ts'

const marks: Marks = { spawnedAt: 1000, exitedAt: 2500, firstTestStart: 1400, lastTestEnd: 2200, testDurations: [300, 100, 200] }
const passing = { passed: 3, failed: 0, exitCode: 0 }

describe('median', () => {
  test('is null for no values, the value for one, and the middle of an odd count', () => {
    assert.equal(median([]), null)
    assert.equal(median([7]), 7)
    assert.equal(median([3, 1, 2]), 2)
  })

  test('is the mean of the two middle values for an even count', () => {
    assert.equal(median([4, 1, 3, 2]), 2.5)
  })
})

describe('phasesFrom', () => {
  test('splits a run at the first test starting and the last test ending', () => {
    assert.deepEqual(phasesFrom(marks), { wall: 1500, startup: 400, tests: 800, teardown: 300, perTest: 200 })
  })
})

describe('judge', () => {
  test('a run is valid when every expected test passed and the process exited 0', () => {
    const outcome = judge(marks, passing, 3)
    assert.equal(outcome.valid, true)
    assert.equal(outcome.reason, undefined)
    assert.equal(outcome.phases?.wall, 1500)
  })

  test('names the first problem: a given reason, the exit code, failures, a short count, or no timing', () => {
    assert.equal(judge(marks, passing, 3, 'no events.jsonl').reason, 'no events.jsonl')
    assert.equal(judge(marks, { ...passing, exitCode: 1 }, 3).reason, 'exit code 1')
    assert.equal(judge(marks, { ...passing, exitCode: null }, 3).reason, 'exit code unknown')
    assert.equal(judge(marks, { passed: 2, failed: 1, exitCode: 0 }, 3).reason, '1 failed')
    assert.equal(judge(marks, { passed: 2, failed: 0, exitCode: 0 }, 3).reason, '2 of 3 passed')
    assert.equal(judge(undefined, passing, 3).reason, 'no timing read')
  })

  test('keeps the counts and the phases of an invalid run, so the report can show them', () => {
    const outcome = judge(marks, { passed: 2, failed: 1, exitCode: 1 }, 3)
    assert.equal(outcome.valid, false)
    assert.equal(outcome.passed, 2)
    assert.equal(outcome.phases?.tests, 800)
  })
})

describe('medianPhases', () => {
  const run = (wall: number, valid = true): RunOutcome => ({
    phases: { wall, startup: wall / 10, tests: wall / 2, teardown: wall / 5, perTest: wall / 4 },
    passed: 1,
    failed: 0,
    exitCode: 0,
    valid,
  })

  test('reads valid runs alone', () => {
    assert.deepEqual(medianPhases([run(1000), run(3000), run(90_000, false)]), { wall: 2000, startup: 200, tests: 1000, teardown: 400, perTest: 500 })
  })

  test('is null when no run is valid', () => {
    assert.equal(medianPhases([run(1000, false)]), null)
    assert.equal(medianPhases([]), null)
  })
})
