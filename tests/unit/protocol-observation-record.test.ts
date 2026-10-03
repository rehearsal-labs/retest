import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  formatObservationId,
  isObservationId,
  observedItemTextLimit,
  observedRecord,
  observedRecordSchema,
  observedTextLimit,
} from '../../src/protocol/observation-record.ts'
import { parse } from '../../src/protocol/schema.ts'
import { observationOf } from '../support/observation.ts'

describe('observedRecord', () => {
  test('keeps everything a look saw, with its text marked whole', () => {
    const record = observedRecord(observationOf([{ text: 'Saved', visible: true }], 'Ada', { checked: false, enabled: false }))
    assert.deepEqual(record, {
      count: 1,
      visible: true,
      text: { text: 'Saved', truncated: false, length: 5 },
      value: { text: 'Ada', truncated: false, length: 3 },
      checked: false,
      enabled: false,
      items: [{ text: { text: 'Saved', truncated: false, length: 5 }, visible: true }],
      itemsTruncated: false,
    })
    assert.deepEqual(parse(observedRecordSchema, JSON.parse(JSON.stringify(record))), { ok: true, value: record })
  })

  test('names the step of a scoped locator that kept nothing, and reads a record from before looks read states', () => {
    const empty = observedRecord({ ...observationOf([]), emptyStep: { step: 1, matched: 3 } })
    assert.deepEqual(empty.emptyStep, { step: 1, matched: 3 })
    assert.equal(parse(observedRecordSchema, JSON.parse(JSON.stringify(empty))).ok, true)
    const older = { count: 0, visible: null, text: null, value: null, items: [], itemsTruncated: false }
    assert.equal(parse(observedRecordSchema, older).ok, true, 'a run recorded before checked and enabled still reads')
  })

  test('a look with no match, or several, keeps nulls where one element would have said something', () => {
    assert.deepEqual(observedRecord(observationOf([])), { count: 0, visible: null, text: null, value: null, checked: null, enabled: null, items: [], itemsTruncated: false })
    const record = observedRecord(observationOf(Array.from({ length: 101 }, (_, index) => ({ text: `Task ${index}`, visible: true }))))
    assert.equal(record.count, 101)
    assert.equal(record.items.length, 100)
    assert.equal(record.itemsTruncated, true)
    assert.equal(record.text, null)
  })

  test('cuts text and value at 4096 code units and each listed text at 512, never inside a surrogate pair', () => {
    assert.equal(observedTextLimit, 4096)
    assert.equal(observedItemTextLimit, 512)
    const long = 'a'.repeat(4095) + '\u{1F600}' + 'b'.repeat(10)
    const record = observedRecord(observationOf([{ text: long, visible: true }], long))
    assert.deepEqual(record.text, { text: 'a'.repeat(4095), truncated: true, length: long.length })
    assert.deepEqual(record.value, record.text)
    assert.deepEqual(record.items[0]?.text, { text: 'a'.repeat(512), truncated: true, length: long.length })
    const item = 'c'.repeat(511) + '\u{1F600}'
    assert.deepEqual(observedRecord(observationOf([{ text: item, visible: true }, { text: 'x', visible: false }])).items[0]?.text, {
      text: 'c'.repeat(511),
      truncated: true,
      length: 513,
    })
  })

  test('the schema refuses a record that is not what a look saw', () => {
    const record = observedRecord(observationOf([{ text: 'Saved', visible: true }]))
    assert.equal(parse(observedRecordSchema, { ...record, text: 'Saved' }).ok, false)
    assert.equal(parse(observedRecordSchema, { ...record, count: -1 }).ok, false)
    assert.equal(parse(observedRecordSchema, { ...record, items: [{ text: 'Saved', visible: true }] }).ok, false)
    assert.equal(parse(observedRecordSchema, { ...record, html: '<p>Saved</p>' }).ok, false)
  })
})

describe('observation ids', () => {
  test('count from o1 within an attempt', () => {
    assert.deepEqual([1, 2, 13].map(formatObservationId), ['o1', 'o2', 'o13'])
    for (const sequence of [0, -1, 1.5, Number.NaN, 2 ** 53]) assert.throws(() => formatObservationId(sequence), RangeError)
  })

  test('have one shape: o, then a whole number from 1 without leading zeros', () => {
    for (const id of ['o1', 'o9', 'o10', 'o123456']) assert.equal(isObservationId(id), true, id)
    for (const id of ['', 'o', 'o0', 'o01', 'O1', '1', 'o-1', 'o1.5', ' o1', 'o1 ', 'o1\n', 'observation-1', 'oo1']) {
      assert.equal(isObservationId(id), false, JSON.stringify(id))
    }
  })
})
