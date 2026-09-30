import type { LocatorCheck, LocatorCheckRecord } from '../../src/protocol/locator-checks.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  countCheck,
  hiddenCheck,
  locatorCheck,
  locatorCheckRecordSchema,
  textCheck,
  textsCheck,
  valueCheck,
  visibleCheck,
} from '../../src/protocol/locator-checks.ts'
import { parse } from '../../src/protocol/schema.ts'
import { observationOf } from '../support/observation.ts'

const saved = observationOf([{ text: ' Saved\n', visible: true }])
const hiddenSaved = observationOf([{ text: 'Saved', visible: false }])
const nothing = observationOf([])
const two = observationOf([
  { text: 'One', visible: true },
  { text: 'Two', visible: false },
])
const field = observationOf([{ text: '', visible: true }], 'Ada')

function described(check: LocatorCheck): Omit<LocatorCheck, 'passes' | 'actual' | 'mismatch'> {
  const { matcher, expected, comparison, single } = check
  return comparison === undefined ? { matcher, expected, single } : { matcher, expected, comparison, single }
}

describe('locatorCheck', () => {
  test('builds from each record the check the matcher polls with', () => {
    const pairs: [LocatorCheckRecord, LocatorCheck][] = [
      [{ matcher: 'toBeVisible' }, visibleCheck()],
      [{ matcher: 'toBeHidden' }, hiddenCheck()],
      [{ matcher: 'toHaveText', text: 'Saved' }, textCheck('Saved')],
      [{ matcher: 'toHaveText', texts: ['One', 'Two'] }, textsCheck(['One', 'Two'])],
      [{ matcher: 'toHaveCount', count: 2 }, countCheck(2)],
      [{ matcher: 'toHaveValue', value: 'Ada' }, valueCheck('Ada')],
    ]
    for (const [record, direct] of pairs) {
      const built = locatorCheck(record)
      assert.deepEqual(described(built), described(direct), record.matcher)
      for (const observation of [saved, hiddenSaved, nothing, two, field]) {
        assert.equal(built.passes(observation), direct.passes(observation), `${record.matcher} on ${JSON.stringify(observation)}`)
        assert.equal(built.actual(observation), direct.actual(observation))
      }
    }
  })

  test('each matcher passes and fails on the observations its rule names', () => {
    const verdicts = (record: LocatorCheckRecord): boolean[] => [saved, hiddenSaved, nothing, two, field].map((observation) => locatorCheck(record).passes(observation))
    assert.deepEqual(verdicts({ matcher: 'toBeVisible' }), [true, false, false, false, true])
    assert.deepEqual(verdicts({ matcher: 'toBeHidden' }), [false, true, true, false, false])
    assert.deepEqual(verdicts({ matcher: 'toHaveText', text: 'Saved' }), [true, true, false, false, false])
    assert.deepEqual(verdicts({ matcher: 'toHaveText', texts: ['One', 'Two'] }), [false, false, false, true, false])
    assert.deepEqual(verdicts({ matcher: 'toHaveCount', count: 0 }), [false, false, true, false, false])
    assert.deepEqual(verdicts({ matcher: 'toHaveValue', value: 'Ada' }), [false, false, false, false, true])
  })

  test('an expected text longer than an event keeps is judged whole', () => {
    const long = 'x'.repeat(5000)
    assert.equal(locatorCheck({ matcher: 'toHaveText', text: long }).passes(observationOf([{ text: long, visible: true }])), true)
    assert.equal(locatorCheck({ matcher: 'toHaveText', text: long }).passes(observationOf([{ text: long.slice(0, 4096), visible: true }])), false)
  })

  test('page text redacted before the test process saw it is judged as the placeholder it reads', () => {
    const shown = observationOf([{ text: 'Your code is {{code}}', visible: true }])
    assert.equal(locatorCheck({ matcher: 'toHaveText', text: 'Your code is {{code}}' }).passes(shown), true)
    assert.equal(locatorCheck({ matcher: 'toHaveText', text: 'Your code is 481516' }).passes(shown), false)
  })
})

describe('locatorCheckRecordSchema', () => {
  test('takes each matcher with its arguments whole', () => {
    const records: LocatorCheckRecord[] = [
      { matcher: 'toBeVisible' },
      { matcher: 'toBeHidden' },
      { matcher: 'toHaveText', text: 'x'.repeat(10_000) },
      { matcher: 'toHaveText', texts: [] },
      { matcher: 'toHaveText', texts: ['One', 'Two'] },
      { matcher: 'toHaveCount', count: 0 },
      { matcher: 'toHaveValue', value: '' },
    ]
    for (const record of records) assert.deepEqual(parse(locatorCheckRecordSchema, JSON.parse(JSON.stringify(record))), { ok: true, value: record })
  })

  test('refuses value matchers, missing or extra arguments, and counts that are not whole numbers from 0', () => {
    for (const record of [
      { matcher: 'toBe' },
      { matcher: 'toBeVisible', text: 'Saved' },
      { matcher: 'toHaveText' },
      { matcher: 'toHaveText', text: 'One', texts: ['One'] },
      { matcher: 'toHaveText', text: ['One'] },
      { matcher: 'toHaveCount', count: -1 },
      { matcher: 'toHaveCount', count: 1.5 },
      { matcher: 'toHaveValue', value: null },
    ]) {
      assert.equal(parse(locatorCheckRecordSchema, record).ok, false, JSON.stringify(record))
    }
  })
})
