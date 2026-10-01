import type { OptionChoiceRecord } from '../../src/protocol/option-choices.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeOptionChoice, describeOptionChoices, optionChoiceRecordSchema, optionChoicesProblem } from '../../src/protocol/option-choices.ts'
import { parse } from '../../src/protocol/schema.ts'

describe('option choices: what a select names', () => {
  test('an option by its label or by its value, never both and never anything else', () => {
    const records: OptionChoiceRecord[] = [{ label: 'Canada' }, { value: 'ca' }, { label: '' }]
    for (const value of records) assert.deepEqual(parse(optionChoiceRecordSchema, JSON.parse(JSON.stringify(value))), { ok: true, value })
    for (const value of ['Canada', { label: 'Canada', value: 'ca' }, { text: 'Canada' }, { value: 1 }, {}]) {
      assert.equal(parse(optionChoiceRecordSchema, value).ok, false, JSON.stringify(value))
    }
  })

  test('each option is named as a test writes it, and long text is cut short', () => {
    assert.equal(describeOptionChoice({ label: 'Canada' }), "'Canada'")
    assert.equal(describeOptionChoice({ value: 'ca' }), "{ value: 'ca' }")
    assert.equal(describeOptionChoice({ label: "Côte d'Ivoire" }), "'Côte d\\'Ivoire'")
    assert.equal(describeOptionChoice({ value: 'v'.repeat(250) }), `{ value: '${'v'.repeat(200)}…' }`)
  })

  test('one option stands on its own, and any other number is a list', () => {
    assert.equal(describeOptionChoices([{ label: 'Canada' }]), "'Canada'")
    assert.equal(describeOptionChoices([{ value: 'ca' }]), "{ value: 'ca' }")
    assert.equal(describeOptionChoices([{ label: 'Red' }, { value: 'b' }]), "['Red', { value: 'b' }]")
    assert.equal(describeOptionChoices([]), '[]')
  })

  test('both processes refuse a select that names no option, as usage', () => {
    assert.deepEqual(optionChoicesProblem([]), { class: 'usage', message: 'select() needs at least one option, received an empty list.' })
    assert.equal(optionChoicesProblem([{ label: 'Canada' }]), undefined)
    assert.equal(optionChoicesProblem([{ label: 'Red' }, { label: 'Red' }]), undefined)
  })
})
