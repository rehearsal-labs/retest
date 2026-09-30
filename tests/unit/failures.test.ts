import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { errorMessage, failure, failureSchema, truncateText, withAlso, withLocation } from '../../src/protocol/failures.ts'
import { parse } from '../../src/protocol/schema.ts'

describe('truncateText', () => {
  test('keeps text within the limit', () => {
    assert.deepEqual(truncateText(''), { text: '', truncated: false, length: 0 })
    assert.deepEqual(truncateText('Release'), { text: 'Release', truncated: false, length: 7 })
    assert.deepEqual(truncateText('abcd', 4), { text: 'abcd', truncated: false, length: 4 })
  })

  test('cuts text over the limit and records the original length', () => {
    assert.deepEqual(truncateText('Release checklist', 7), { text: 'Release', truncated: true, length: 17 })
  })

  test('defaults to 4096 code units', () => {
    const result = truncateText('x'.repeat(5000))
    assert.equal(result.text.length, 4096)
    assert.equal(result.truncated, true)
    assert.equal(result.length, 5000)
  })

  test('never splits a surrogate pair', () => {
    assert.deepEqual(truncateText('😀😀', 3), { text: '😀', truncated: true, length: 4 })
    assert.deepEqual(truncateText('😀a', 2), { text: '😀', truncated: true, length: 3 })
    assert.deepEqual(truncateText('a😀', 2), { text: 'a', truncated: true, length: 3 })
    assert.equal(truncateText('😀'.repeat(3000)).text.isWellFormed(), true)
  })

  test('a limit of zero keeps nothing', () => {
    assert.deepEqual(truncateText('a', 0), { text: '', truncated: true, length: 1 })
    assert.deepEqual(truncateText('', 0), { text: '', truncated: false, length: 0 })
  })

  test('passes a lone surrogate through', () => {
    assert.deepEqual(truncateText('a\ud800b', 2), { text: 'a', truncated: true, length: 3 })
    assert.deepEqual(truncateText('\udc00b', 1), { text: '\udc00', truncated: true, length: 2 })
  })

  test('rejects a limit that is not a whole number from zero', () => {
    for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => truncateText('abc', limit), RangeError)
    }
  })
})

describe('failureSchema', () => {
  test('accepts every detail kind', () => {
    const failure = {
      class: 'check_failed',
      message: 'Expected text "Release checklist", received "Release".',
      location: { file: 'examples/task.retest.ts', line: 7, column: 3 },
      details: { attempts: 3, visible: true, locator: 'getByTestId(\'saved-task\')', page: null, text: truncateText('x', 0) },
    }
    assert.equal(parse(failureSchema, failure).ok, true)
  })

  test('rejects unknown classes, nested details and zero-based locations', () => {
    const base = { class: 'check_failed', message: 'x' }
    assert.equal(parse(failureSchema, { ...base, class: 'flaky' }).ok, false)
    assert.equal(parse(failureSchema, { ...base, details: { list: [1] } }).ok, false)
    assert.equal(parse(failureSchema, { ...base, details: { nested: { a: 1 } } }).ok, false)
    assert.equal(parse(failureSchema, { ...base, location: { file: 'a.retest.ts', line: 0, column: 1 } }).ok, false)
  })
})

describe('building failures', () => {
  test('failure() adds a location only when there is one', () => {
    assert.deepEqual(failure('timeout', 'late'), { class: 'timeout', message: 'late' })
    const at = { file: 'a.ts', line: 1, column: 2 }
    assert.deepEqual(failure('timeout', 'late', at), { class: 'timeout', message: 'late', location: at })
  })

  test('withLocation keeps a failure its own location', () => {
    const own = { file: 'own.ts', line: 1, column: 1 }
    const other = { file: 'other.ts', line: 2, column: 2 }
    assert.deepEqual(withLocation(failure('timeout', 'x', own), other).location, own)
    assert.deepEqual(withLocation(failure('timeout', 'x'), other).location, other)
    assert.equal(withLocation(failure('timeout', 'x'), undefined).location, undefined)
  })

  test('withAlso keeps the first failure and lists the later ones, without repeats', () => {
    const first = failure('check_failed', 'wrong text')
    assert.equal(withAlso(first, []), first)
    assert.equal(withAlso(first, [failure('check_failed', 'wrong text')]), first)
    const combined = withAlso({ ...first, details: { attempts: 3 } }, [failure('timeout', 'late'), failure('not_awaited', 'line 4')])
    assert.deepEqual(combined, {
      class: 'check_failed',
      message: 'wrong text',
      details: { attempts: 3, also: 'timeout: late\nnot_awaited: line 4' },
    })
  })

  test('errorMessage reads anything thrown', () => {
    assert.equal(errorMessage(new Error('boom')), 'boom')
    assert.equal(errorMessage('text'), 'text')
  })
})
