import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { describeLocator, locatorRecipeSchema } from '../../src/protocol/locator.ts'
import { parse } from '../../src/protocol/schema.ts'

function readBack(description: string): unknown {
  return runInNewContext(description, { getByTestId: (value: unknown) => value })
}

describe('describeLocator', () => {
  test('writes the call that makes the recipe', () => {
    assert.equal(describeLocator({ by: 'testId', value: 'save-task' }), "getByTestId('save-task')")
  })

  test('escapes the value as a JavaScript string', () => {
    assert.equal(describeLocator({ by: 'testId', value: `it's "done"` }), `getByTestId('it\\'s "done"')`)
    assert.equal(describeLocator({ by: 'testId', value: 'a\\b' }), "getByTestId('a\\\\b')")
    assert.equal(describeLocator({ by: 'testId', value: 'line\nbreak' }), "getByTestId('line\\nbreak')")
  })

  test('every value reads back exactly, on one line', () => {
    const values = [
      '',
      "'",
      '"',
      '\\',
      "\\'",
      '\\"',
      '\n\r\t\b\f\v\0',
      '\u0001\u001f\u007f',
      '\u2028\u2029',
      '\ud800',
      '\udc00x',
      '😀 ünïcödé 日本',
      '</script><script>',
      '${injected}',
      "'); alert(1); ('",
    ]
    for (const value of values) {
      const description = describeLocator({ by: 'testId', value })
      assert.equal(readBack(description), value, `round trip of ${JSON.stringify(value)}`)
      assert.doesNotMatch(description, /[\n\r\u2028\u2029]/)
    }
  })
})

describe('locatorRecipeSchema', () => {
  test('accepts a test id recipe and rejects other kinds', () => {
    assert.equal(parse(locatorRecipeSchema, { by: 'testId', value: 'save-task' }).ok, true)
    assert.deepEqual(parse(locatorRecipeSchema, { by: 'role', value: 'button' }), {
      ok: false,
      issues: [{ path: '$.by', message: 'expected "testId", received "role"' }],
    })
    assert.equal(parse(locatorRecipeSchema, { by: 'testId', value: 'x', exact: true }).ok, false)
  })
})
