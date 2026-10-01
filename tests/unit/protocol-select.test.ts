import type { RetestEvent } from '../../src/protocol/events.ts'
import type { ParseResult } from '../../src/protocol/schema.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { selectCommandProblem } from '../../src/protocol/option-choices.ts'
import { parse } from '../../src/protocol/schema.ts'

const selected: RetestEvent = {
  schemaVersion: 1,
  runId: 'run-1',
  sequence: 3,
  time: '2026-10-01T09:15:00.000Z',
  elapsedMs: 120,
  origin: 'parent',
  type: 'action.completed',
  testId: 'tests/sign-up.retest.ts > picks a country',
  attemptId: 'attempt-1',
  session: 'page',
  command: 'select',
  locator: { by: 'label', text: 'Country' },
  choices: [{ label: 'Canada' }],
  multiple: true,
  changed: true,
  input: 'script',
  durationMs: 15,
}

describe('a select command, as the parent checks it', () => {
  test('one option, or any number of options passed as a list, reaches the page', () => {
    assert.equal(selectCommandProblem({ choices: [{ label: 'Canada' }] }), undefined)
    assert.equal(selectCommandProblem({ choices: [{ value: 'ca' }], multiple: true }), undefined)
    assert.equal(selectCommandProblem({ choices: [{ label: 'Red' }, { value: 'b' }, { label: 'Red' }], multiple: true }), undefined)
  })

  test('several options that were not a list are usage, with a plain message', () => {
    assert.deepEqual(selectCommandProblem({ choices: [{ label: 'Red' }, { label: 'Blue' }] }), {
      class: 'usage',
      message: 'select() received 2 options that were not a list. Several options need a list.',
    })
  })

  test('an empty list is usage, as optionChoicesProblem says, list or not', () => {
    const empty = { class: 'usage', message: 'select() needs at least one option, received an empty list.' }
    assert.deepEqual(selectCommandProblem({ choices: [] }), empty)
    assert.deepEqual(selectCommandProblem({ choices: [], multiple: true }), empty)
  })
})

describe('a select action event', () => {
  test('says the test passed a list, even a list of one, only as true, and survives a JSON round trip', () => {
    assert.deepEqual(parse(retestEventSchema, JSON.parse(JSON.stringify(selected))), { ok: true, value: selected })
    for (const multiple of [false, 'true', 1]) {
      const parsed: ParseResult<RetestEvent> = parse(retestEventSchema, { ...selected, multiple })
      assert.equal(parsed.ok, false, JSON.stringify(multiple))
      assert.deepEqual(parsed.ok ? [] : parsed.issues.map((issue) => issue.path), ['$.multiple'])
    }
  })
})
