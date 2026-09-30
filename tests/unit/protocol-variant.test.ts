import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { parse } from '../../src/protocol/schema.ts'
import { variantKey, variantSchema } from '../../src/protocol/variant.ts'

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]]
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]))
}

describe('variantKey', () => {
  test('joins app=target pairs sorted by app name', () => {
    assert.equal(variantKey({ web: 'beta' }), 'web=beta')
    assert.equal(variantKey({ web: 'beta', mobile: 'pixel' }), 'mobile=pixel,web=beta')
    assert.equal(variantKey({}), '')
  })

  test('is the same whatever order the variant lists its apps in', () => {
    const pairs: [string, string][] = [
      ['web', 'beta'],
      ['mobile', 'pixel'],
      ['admin', 'chromium'],
      ['owner', 'edge'],
    ]
    const keys = new Set(permutations(pairs).map((order) => variantKey(Object.fromEntries(order))))
    assert.deepEqual([...keys], ['admin=chromium,mobile=pixel,owner=edge,web=beta'])
  })

  test('sorts by code unit, not by locale, so every machine agrees', () => {
    assert.equal(variantKey({ web: 'a', Web: 'b', _app: 'c', 'app-2': 'd', app: 'e' }), 'Web=b,_app=c,app-2=d,app=e,web=a')
  })

  test('different variants get different keys', () => {
    assert.notEqual(variantKey({ web: 'beta' }), variantKey({ web: 'edge' }))
    assert.notEqual(variantKey({ web: 'beta' }), variantKey({ mobile: 'beta' }))
    assert.notEqual(variantKey({ web: 'beta', mobile: 'pixel' }), variantKey({ web: 'beta' }))
  })

  test('refuses a name with = or , since two variants could then share a key', () => {
    for (const variant of [{ 'a=b': 'c' }, { a: 'b=c' }, { 'a,b': 'c' }, { a: 'b,c' }]) {
      assert.throws(() => variantKey(variant), TypeError, JSON.stringify(variant))
    }
  })
})

describe('variantSchema', () => {
  test('maps app names to target names', () => {
    assert.equal(parse(variantSchema, { web: 'beta', mobile: 'pixel' }).ok, true)
    assert.deepEqual(parse(variantSchema, { web: 1 }), { ok: false, issues: [{ path: '$.web', message: 'expected string, received 1' }] })
    assert.deepEqual(parse(variantSchema, ['web=beta']), { ok: false, issues: [{ path: '$', message: 'expected object, received array' }] })
  })
})
