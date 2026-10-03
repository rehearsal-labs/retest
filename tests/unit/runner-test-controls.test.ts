import type { RegisteredTest } from '../../src/protocol/messages.ts'
import type { Plan } from '../../src/runner/plan.ts'
import type { Schedule } from '../../src/runner/schedule.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { variantKey } from '../../src/protocol/variant.ts'
import { focusOf, onlyRefusal } from '../../src/runner/focus.ts'
import { collectedTest } from '../../src/runner/plan.ts'
import { collectConfig } from '../../src/runner/run-config.ts'
import { scheduleRun } from '../../src/runner/schedule.ts'
import { emptySelectionFailure } from '../../src/runner/selection.ts'
import { appWith, at, configOf, planOf, registered } from '../support/plans.ts'

const config = configOf({ apps: { web: appWith('stable') }, locks: ['inbox', 'account'] })

function block(name: string, line: number, only?: true, file = 'tests/a.retest.ts'): NonNullable<RegisteredTest['describes']>[number] {
  return { name, location: at(line, file), ...(only === undefined ? {} : { only }) }
}

const inB = 'tests/b.retest.ts'

function kept(plan: Plan): string[] {
  const focus = focusOf(plan)
  const tests = plan.files.flatMap((file) => (file.ok ? file.tests : []))
  return tests.filter((each) => focus?.keeps(each) !== false).map((each) => each.testId)
}

function visits(schedule: Schedule): string[] {
  return schedule.visits.map((visit) => `${visit.file}: ${visit.attempts.map((attempt) => `${attempt.test.registered.name} ${variantKey(attempt.targets)}`).join(', ')}`)
}

describe('focusOf', () => {
  test('no test or block marked only leaves the run as it is', () => {
    const plan = planOf(config, { 'tests/a.retest.ts': [registered('saves', 2), registered('lists', 4)] })
    assert.equal(focusOf(plan), undefined)
  })

  test('test.only keeps the tests it marks in every file, and counts what it left out', () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [registered('saves', 2, { only: true }), registered('lists', 4)],
      'tests/b.retest.ts': [registered('archives', 2, { location: at(2, inB) }), registered('signed-in', 6, { location: at(6, inB), setup: true })],
    })
    assert.deepEqual(kept(plan), ['tests/a.retest.ts > saves'])
    assert.deepEqual(focusOf(plan)?.narrowed, { only: [at(2)], kept: 1, collected: 3 }, 'setups count on neither side')
  })

  test('a block marked only keeps every test inside it, unless something inside is marked only too', () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [
        registered('saves', 3, { describes: [block('tasks', 2, true)] }),
        registered('lists', 4, { describes: [block('tasks', 2, true)] }),
        registered('outside', 7),
      ],
      'tests/b.retest.ts': [
        registered('archives', 3, { location: at(3, inB), describes: [block('archive', 2, true, inB)], only: true }),
        registered('restores', 4, { location: at(4, inB), describes: [block('archive', 2, true, inB)] }),
        registered('bulk', 6, { location: at(6, inB), describes: [block('archive', 2, true, inB), block('bulk', 5, undefined, inB)], only: true }),
      ],
    })
    assert.deepEqual(kept(plan), [
      'tests/a.retest.ts > tasks > saves',
      'tests/a.retest.ts > tasks > lists',
      'tests/b.retest.ts > archive > archives',
      'tests/b.retest.ts > archive > bulk > bulk',
    ])
    const narrowed = focusOf(plan)?.narrowed
    assert.deepEqual(narrowed?.only, [at(2), at(2, inB), at(3, inB), at(6, inB)])
    assert.deepEqual([narrowed?.kept, narrowed?.collected], [4, 6])
  })

  test('a refusal names every place only is written, and ends with the reason it is given', () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [registered('saves', 2, { only: true }), registered('lists', 4, { describes: [block('more', 3, true)] })],
    })
    const narrowed = focusOf(plan)?.narrowed
    assert.ok(narrowed !== undefined)
    const refusal = onlyRefusal(narrowed, 'CI is set: remove test.only, or pass --allow-only to run it anyway.')
    assert.equal(refusal.class, 'usage')
    assert.equal(
      refusal.message,
      'test.only leaves out the rest of the suite, and this run refuses it: tests/a.retest.ts:2, tests/a.retest.ts:3. CI is set: remove test.only, or pass --allow-only to run it anyway.',
    )
    assert.deepEqual(refusal.location, at(2))
  })
})

describe('scheduleRun with marks', () => {
  const marked = planOf(config, {
    'tests/a.retest.ts': [
      registered('saves', 2),
      registered('skipped', 4, { skip: true, state: 'signed-in' }),
      registered('lists', 6),
    ],
    'tests/sign-in.retest.ts': [registered('signed-in', 2, { setup: true })],
  })

  test('a skipped test is chosen but runs in no visit, and its setup does not run for it', () => {
    const schedule = scheduleRun(marked, {}, true)
    assert.deepEqual(visits(schedule), ['tests/sign-in.retest.ts: signed-in web=stable', 'tests/a.retest.ts: saves web=stable, lists web=stable'])
    assert.deepEqual(schedule.skipped.map((attempt) => attempt.test.registered.name), ['skipped'])
    assert.equal(schedule.selected, 4, 'the setup was chosen as a test of its own; the skipped test was chosen too')
  })

  test('a setup only a skipped test needs is not scheduled', () => {
    const schedule = scheduleRun(marked, { grep: 'skipped' }, true)
    assert.deepEqual(visits(schedule), [])
    assert.equal(schedule.selected, 1)
  })

  test('the selection filters apply after test.only, and an empty result names test.only', () => {
    const plan = planOf(config, { 'tests/a.retest.ts': [registered('saves', 2, { only: true }), registered('lists', 4)] })
    const focus = focusOf(plan)
    assert.deepEqual(visits(scheduleRun(plan, {}, true, focus)), ['tests/a.retest.ts: saves web=stable'])
    const empty = scheduleRun(plan, { grep: 'lists' }, true, focus)
    assert.equal(empty.selected, 0)
    assert.equal(emptySelectionFailure({ grep: 'lists' }, focus?.narrowed).message, 'No test matches test.only and --grep "lists".')
  })
})

describe('locks in a plan', () => {
  test('a lock the config declares is kept, and collection lists it', () => {
    const plan = planOf(config, { 'tests/a.retest.ts': [registered('reads mail', 2, { locks: ['inbox', 'account'] })] })
    const [file] = plan.files
    assert.ok(file?.ok)
    const [planned] = file.tests
    assert.ok(planned !== undefined)
    assert.deepEqual(collectedTest(planned, config).locks, ['inbox', 'account'])
  })

  test('a lock the config does not declare fails its file with a usage failure that names the declared ones', () => {
    const plan = planOf(config, { 'tests/a.retest.ts': [registered('reads mail', 2, { locks: ['inbx'] })] })
    const [file] = plan.files
    assert.ok(file !== undefined && !file.ok)
    assert.equal(file.failure.class, 'usage')
    assert.equal(file.failure.message, `"reads mail": It holds the lock "inbx", which the config does not declare. The config's locks are inbox, account.`)
  })

  test('a config with no locks takes none, and says how to declare one', () => {
    const plan = planOf(configOf({ apps: { web: appWith('stable') } }), { 'tests/a.retest.ts': [registered('reads mail', 2, { locks: ['inbox'] })] })
    const [file] = plan.files
    assert.ok(file !== undefined && !file.ok)
    assert.equal(file.failure.message, `"reads mail": It holds the lock "inbox", and the config declares no locks. Add locks: ["inbox"] to the config.`)
  })

  test("milestone 1's mode has no config to declare locks in, so any name is held", () => {
    const plan = planOf(collectConfig(undefined), { 'tests/a.retest.ts': [registered('reads mail', 2, { locks: ['inbox'] })] })
    assert.equal(plan.files[0]?.ok, true)
  })

  test('collection lists skip and only, and a test inside a block marked only as only', () => {
    const plan = planOf(config, {
      'tests/a.retest.ts': [registered('skipped', 2, { skip: true }), registered('inside', 4, { describes: [block('focus', 3, true)] })],
    })
    const [file] = plan.files
    assert.ok(file?.ok)
    assert.deepEqual(
      file.tests.map((each) => collectedTest(each, config)).map(({ name, skip, only }) => [name, skip, only]),
      [
        ['skipped', true, undefined],
        ['inside', undefined, true],
      ],
    )
  })
})
