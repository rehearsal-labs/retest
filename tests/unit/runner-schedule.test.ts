import type { Schedule } from '../../src/runner/schedule.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { variantKey } from '../../src/protocol/variant.ts'
import { attemptKey, scheduleRun } from '../../src/runner/schedule.ts'
import { appWith, configOf, planOf, registered } from '../support/plans.ts'

const config = configOf({ apps: { web: appWith('stable', 'beta') } })

// The plan's files in the order a run passes them: a dependent file before the setup's file.
const plan = planOf(config, {
  'tests/archive.retest.ts': [
    registered('archives', 2, { state: 'signed-in', tags: ['smoke'] }),
    registered('lists', 6),
  ],
  'tests/sign-in.retest.ts': [registered('signed-in', 2, { setup: true })],
})

function visits(schedule: Schedule): string[] {
  return schedule.visits.map((visit) => `${visit.file}: ${visit.attempts.map((attempt) => `${attempt.test.registered.name} ${variantKey(attempt.targets)}`).join(', ')}`)
}

describe('scheduleRun', () => {
  test('setups run first, once per target, then every other test file by file with its runs together', () => {
    const schedule = scheduleRun(plan, {}, true)
    assert.deepEqual(visits(schedule), [
      'tests/sign-in.retest.ts: signed-in web=stable, signed-in web=beta',
      'tests/archive.retest.ts: archives web=stable, archives web=beta, lists web=stable, lists web=beta',
    ])
    assert.equal(schedule.selected, 6)
  })

  test('a setup the selection leaves out still runs, for the targets its dependents use and no others', () => {
    const schedule = scheduleRun(plan, { tags: { kind: 'tag', tag: 'smoke' }, targets: { web: 'beta' } }, true)
    assert.deepEqual(visits(schedule), ['tests/sign-in.retest.ts: signed-in web=beta', 'tests/archive.retest.ts: archives web=beta'])
    assert.equal(schedule.selected, 1)
  })

  test('a setup no selected test needs does not run', () => {
    assert.deepEqual(visits(scheduleRun(plan, { grep: 'lists' }, true)), ['tests/archive.retest.ts: lists web=stable, lists web=beta'])
  })

  test('a setup selected and needed runs once', () => {
    const schedule = scheduleRun(plan, { grep: /signed-in|archives/ }, true)
    const keys = schedule.visits.flatMap((visit) => visit.attempts.map(attemptKey))
    assert.equal(new Set(keys).size, keys.length)
    assert.equal(schedule.visits[0]?.attempts.length, 2)
  })

  test('a setup whose file failed its checks is not scheduled; its dependents still are', () => {
    const broken = planOf(config, {
      'tests/archive.retest.ts': [registered('archives', 2, { state: 'signed-in' })],
      'tests/sign-in.retest.ts': [registered('signed-in', 2, { setup: true }), registered('tagged', 5, { apps: ['nope'] })],
    })
    assert.deepEqual(visits(scheduleRun(broken, {}, true)), ['tests/archive.retest.ts: archives web=stable, archives web=beta'])
  })

  test("milestone 1's attempts have no variant, so the last run's entries match them by test id", () => {
    const single = planOf(configOf({ apps: { page: appWith('page') } }), { 'tests/a.retest.ts': [registered('saves', 2), registered('lists', 4)] })
    const lastFailed = [{ testId: 'tests/a.retest.ts > lists', variantKey: 'page=page', status: 'failed' as const }]
    assert.equal(scheduleRun(single, { lastFailed }, false).selected, 0)
    assert.equal(scheduleRun(single, { lastFailed: [{ testId: 'tests/a.retest.ts > lists', status: 'failed' }] }, false).selected, 1)
  })

  test('nothing selected leaves no visit', () => {
    assert.deepEqual(scheduleRun(plan, { grep: 'nothing like it' }, true), { visits: [], selected: 0 })
  })
})
