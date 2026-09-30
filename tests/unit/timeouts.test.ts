import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parse } from '../../src/protocol/schema.ts'
import { defaultTimeouts, maxTimeout, parseTimeouts, timeoutsSchema } from '../../src/protocol/timeouts.ts'

function failureMessage(text: string): string {
  const result = parseTimeouts(text)
  assert.equal(result.ok, false, `expected ${JSON.stringify(text)} to be rejected`)
  if (result.ok) return ''
  assert.equal(result.failure.class, 'usage')
  return result.failure.message
}

describe('defaultTimeouts', () => {
  test('match the documented budgets and cannot be changed', () => {
    assert.deepEqual(defaultTimeouts, {
      collection: 10_000,
      setup: 60_000,
      action: 10_000,
      navigation: 30_000,
      assertion: 5_000,
      test: 60_000,
      cleanup: 10_000,
    })
    assert.equal(Object.isFrozen(defaultTimeouts), true)
    assert.equal(parse(timeoutsSchema, defaultTimeouts).ok, true)
  })

  test('the schema wants every budget as a positive whole number', () => {
    assert.equal(parse(timeoutsSchema, { ...defaultTimeouts, action: 0 }).ok, false)
    assert.equal(parse(timeoutsSchema, { ...defaultTimeouts, action: 1.5 }).ok, false)
    assert.equal(parse(timeoutsSchema, { ...defaultTimeouts, retry: 1 }).ok, false)
    const withoutCleanup = { collection: 1, setup: 1, action: 1, navigation: 1, assertion: 1, test: 1 }
    assert.equal(parse(timeoutsSchema, withoutCleanup).ok, false)
  })
})

describe('parseTimeouts', () => {
  test('reads name=milliseconds pairs', () => {
    assert.deepEqual(parseTimeouts('action=500,test=3000'), { ok: true, value: { action: 500, test: 3000 } })
    assert.deepEqual(parseTimeouts(' action = 500 , test=3000 '), { ok: true, value: { action: 500, test: 3000 } })
  })

  test('accepts every timeout name', () => {
    for (const name of Object.keys(defaultTimeouts)) {
      assert.deepEqual(parseTimeouts(`${name}=1`), { ok: true, value: { [name]: 1 } })
    }
  })

  test('accepts the largest delay a timer can hold', () => {
    assert.deepEqual(parseTimeouts(`test=${maxTimeout}`), { ok: true, value: { test: maxTimeout } })
    assert.match(failureMessage(`test=${maxTimeout + 1}`), /from 1 to 2147483647, received "2147483648"/)
  })

  test('names an unknown key and lists the known ones', () => {
    const message = failureMessage('acton=500')
    assert.match(message, /Unknown timeout "acton"/)
    assert.match(message, /collection, setup, action, navigation, assertion, test, cleanup/)
    for (const name of ['constructor', '__proto__', 'toString', 'Action']) {
      assert.match(failureMessage(`${name}=5`), /Unknown timeout/)
    }
  })

  test('names the timeout and the value that is not a whole positive number', () => {
    for (const value of ['fast', '0', '-5', '1.5', '1e3', '0x10', '+5', '', ' ']) {
      const message = failureMessage(`action=${value}`)
      assert.match(message, /The action timeout must be a whole number of milliseconds/)
      assert.ok(message.includes(`received ${JSON.stringify(value.trim())}`), message)
    }
  })

  test('rejects a timeout given twice', () => {
    assert.equal(failureMessage('action=5,test=6,action=7'), 'The action timeout is given twice.')
  })

  test('rejects entries that are not one name and one value', () => {
    const cases = [
      ['', ''],
      ['action', 'action'],
      ['action=5,', ''],
      [',action=5', ''],
      ['action=5=6', 'action=5=6'],
      ['action=5;test=6', 'action=5;test=6'],
    ]
    for (const [text = '', entry] of cases) {
      assert.equal(failureMessage(text), `Write each timeout as name=milliseconds, received ${JSON.stringify(entry)}.`)
    }
  })
})
