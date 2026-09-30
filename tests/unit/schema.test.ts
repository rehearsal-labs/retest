import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { inspect } from 'node:util'
import { parse, s, toJsonSchema, type Issue } from '../../src/protocol/schema.ts'

type AnySchema = Parameters<typeof parse>[0]

function issues(schema: AnySchema, value: unknown): Issue[] {
  const result = parse(schema, value)
  assert.equal(result.ok, false, `expected ${inspect(value)} to be rejected`)
  return result.ok ? [] : result.issues
}

function accepts(schema: AnySchema, value: unknown): void {
  const result = parse(schema, value)
  assert.deepEqual(result, { ok: true, value })
  assert.equal(result.ok && result.value, value)
}

describe('scalars', () => {
  test('string', () => {
    accepts(s.string(), '')
    accepts(s.string(), 'Release checklist')
    assert.deepEqual(issues(s.string(), 1), [{ path: '$', message: 'expected string, received 1' }])
    assert.deepEqual(issues(s.string(), undefined), [{ path: '$', message: 'expected string, received undefined' }])
  })

  test('number accepts finite numbers only', () => {
    accepts(s.number(), 0)
    accepts(s.number(), -1.5)
    assert.deepEqual(issues(s.number(), Number.NaN), [{ path: '$', message: 'expected number, received NaN' }])
    assert.deepEqual(issues(s.number(), Number.POSITIVE_INFINITY), [
      { path: '$', message: 'expected number, received Infinity' },
    ])
    assert.deepEqual(issues(s.number(), '1'), [{ path: '$', message: 'expected number, received "1"' }])
    assert.deepEqual(issues(s.number(), 1n), [{ path: '$', message: 'expected number, received bigint' }])
  })

  test('number with integer and min', () => {
    const count = s.number({ integer: true, min: 1 })
    accepts(count, 1)
    accepts(count, 2 ** 40)
    assert.deepEqual(issues(count, 0), [{ path: '$', message: 'expected integer >= 1, received 0' }])
    assert.deepEqual(issues(count, 1.5), [{ path: '$', message: 'expected integer >= 1, received 1.5' }])
    accepts(s.number({ min: 0 }), 0.25)
    assert.deepEqual(issues(s.number({ min: 0 }), -0.25), [{ path: '$', message: 'expected number >= 0, received -0.25' }])
  })

  test('boolean', () => {
    accepts(s.boolean(), true)
    accepts(s.boolean(), false)
    assert.deepEqual(issues(s.boolean(), 'true'), [{ path: '$', message: 'expected boolean, received "true"' }])
    assert.deepEqual(issues(s.boolean(), 0), [{ path: '$', message: 'expected boolean, received 0' }])
  })

  test('literal compares by value and type', () => {
    accepts(s.literal('saved'), 'saved')
    accepts(s.literal(1), 1)
    accepts(s.literal(null), null)
    accepts(s.literal(false), false)
    assert.deepEqual(issues(s.literal('saved'), 'save'), [{ path: '$', message: 'expected "saved", received "save"' }])
    assert.deepEqual(issues(s.literal(1), '1'), [{ path: '$', message: 'expected 1, received "1"' }])
    assert.deepEqual(issues(s.literal(null), undefined), [{ path: '$', message: 'expected null, received undefined' }])
    assert.deepEqual(issues(s.literal(true), false), [{ path: '$', message: 'expected true, received false' }])
  })

  test('enum', () => {
    const status = s.enum(['passed', 'failed'])
    accepts(status, 'failed')
    assert.deepEqual(issues(status, 'skipped'), [
      { path: '$', message: 'expected one of "passed", "failed", received "skipped"' },
    ])
    assert.deepEqual(issues(s.enum(['only']), 'other'), [{ path: '$', message: 'expected "only", received "other"' }])
    assert.deepEqual(issues(status, 1), [{ path: '$', message: 'expected one of "passed", "failed", received 1' }])
  })

  test('received values are described without echoing long strings', () => {
    assert.deepEqual(issues(s.number(), 'x'.repeat(41)), [{ path: '$', message: 'expected number, received string' }])
    assert.deepEqual(issues(s.string(), Symbol('x')), [{ path: '$', message: 'expected string, received symbol' }])
    assert.deepEqual(issues(s.string(), () => 'x'), [{ path: '$', message: 'expected string, received function' }])
    assert.deepEqual(issues(s.string(), {}), [{ path: '$', message: 'expected string, received object' }])
    assert.deepEqual(issues(s.string(), []), [{ path: '$', message: 'expected string, received array' }])
  })
})

describe('arrays', () => {
  test('checks every item and reports each index', () => {
    const names = s.array(s.string())
    accepts(names, [])
    accepts(names, ['a', 'b'])
    assert.deepEqual(issues(names, ['a', 2, 'c', null]), [
      { path: '$[1]', message: 'expected string, received 2' },
      { path: '$[3]', message: 'expected string, received null' },
    ])
  })

  test('treats holes as undefined', () => {
    const sparse: unknown[] = []
    sparse[1] = 'a'
    assert.deepEqual(issues(s.array(s.string()), sparse), [{ path: '$[0]', message: 'expected string, received undefined' }])
  })

  test('rejects array-like objects', () => {
    assert.deepEqual(issues(s.array(s.string()), { length: 0 }), [{ path: '$', message: 'expected array, received object' }])
    assert.deepEqual(issues(s.array(s.string()), 'ab'), [{ path: '$', message: 'expected array, received "ab"' }])
  })
})

describe('objects', () => {
  const task = s.object({ title: s.string(), note: s.optional(s.string()) })

  test('accepts the exact shape and returns the same value', () => {
    accepts(task, { title: 'a' })
    accepts(task, { title: 'a', note: 'b' })
  })

  test('rejects unknown keys', () => {
    assert.deepEqual(issues(task, { title: 'a', owner: 'Ana' }), [{ path: '$.owner', message: 'unknown key' }])
    assert.deepEqual(issues(task, { title: 'a', toString: 'x' }), [{ path: '$.toString', message: 'unknown key' }])
    assert.deepEqual(issues(task, JSON.parse('{"title":"a","__proto__":{"note":"x"}}')), [
      { path: '$.__proto__', message: 'unknown key' },
    ])
  })

  test('reports missing keys and every other problem at once', () => {
    assert.deepEqual(issues(task, { note: 1, extra: true }), [
      { path: '$.title', message: 'missing required key' },
      { path: '$.note', message: 'expected string, received 1' },
      { path: '$.extra', message: 'unknown key' },
    ])
  })

  test('an optional key that is present must match; undefined does not', () => {
    assert.deepEqual(issues(task, { title: 'a', note: undefined }), [
      { path: '$.note', message: 'expected string, received undefined' },
    ])
  })

  test('accepts only plain objects', () => {
    const bare: Record<string, unknown> = Object.create(null)
    bare['title'] = 'a'
    accepts(task, bare)
    class Task {
      title = 'a'
    }
    for (const value of [new Task(), new Date(), new Map(), [], null, 'a']) {
      assert.equal(issues(task, value).length, 1)
      assert.equal(issues(task, value)[0]?.path, '$')
    }
    assert.deepEqual(issues(task, Object.create({ title: 'a' })), [{ path: '$', message: 'expected object, received object' }])
  })

  test('paths name nested keys and indexes', () => {
    const report = s.object({
      tests: s.array(s.object({ location: s.object({ line: s.number({ integer: true, min: 1 }) }) })),
    })
    assert.deepEqual(issues(report, { tests: [{ location: { line: 1 } }, { location: { line: 0 } }] }), [
      { path: '$.tests[1].location.line', message: 'expected integer >= 1, received 0' },
    ])
  })

  test('an empty shape accepts only an empty object', () => {
    accepts(s.object({}), {})
    assert.deepEqual(issues(s.object({}), { a: 1 }), [{ path: '$.a', message: 'unknown key' }])
  })
})

describe('records', () => {
  const details = s.record(s.number())

  test('checks every value', () => {
    accepts(details, {})
    accepts(details, { a: 1, b: 2 })
    assert.deepEqual(issues(details, { a: 1, b: 'x' }), [{ path: '$.b', message: 'expected number, received "x"' }])
  })

  test('quotes keys that are not identifiers', () => {
    assert.deepEqual(issues(details, { 'two words': 'x', 0: 'y', 'quote"d': 'z' }), [
      { path: '$["0"]', message: 'expected number, received "y"' },
      { path: '$["two words"]', message: 'expected number, received "x"' },
      { path: '$["quote\\"d"]', message: 'expected number, received "z"' },
    ])
  })

  test('rejects arrays and non-plain objects', () => {
    assert.deepEqual(issues(details, [1]), [{ path: '$', message: 'expected object, received array' }])
    assert.deepEqual(issues(details, new Map()), [{ path: '$', message: 'expected object, received object' }])
  })
})

describe('nullable and unions', () => {
  test('nullable accepts null or the inner value', () => {
    const text = s.nullable(s.string())
    accepts(text, null)
    accepts(text, 'a')
    assert.deepEqual(issues(text, 1), [{ path: '$', message: 'expected string or null, received 1' }])
    assert.deepEqual(issues(text, undefined), [{ path: '$', message: 'expected string or null, received undefined' }])
  })

  test('nullable objects report problems inside the object', () => {
    const box = s.nullable(s.object({ size: s.number() }))
    assert.deepEqual(issues(box, { size: 'large' }), [{ path: '$.size', message: 'expected number, received "large"' }])
  })

  test('a value no option can start on gets one message naming every option', () => {
    const value = s.union([s.string(), s.number(), s.boolean(), s.object({})])
    accepts(value, 'a')
    accepts(value, 2)
    assert.deepEqual(issues(value, null), [{ path: '$', message: 'expected string or number or boolean or object, received null' }])
  })

  test('otherwise the option that got deepest wins', () => {
    const result = s.union([
      s.object({ ok: s.literal(true), kind: s.literal('goto'), url: s.string() }),
      s.object({ ok: s.literal(true), kind: s.enum(['fill', 'click']) }),
      s.object({
        ok: s.literal(true),
        kind: s.literal('observe'),
        observation: s.object({ count: s.number({ integer: true, min: 0 }) }),
      }),
      s.object({ ok: s.literal(false), failure: s.object({ message: s.string() }) }),
    ])
    accepts(result, { ok: true, kind: 'click' })
    assert.deepEqual(issues(result, { ok: true, kind: 'observe', observation: { count: -1 } }), [
      { path: '$.observation.count', message: 'expected integer >= 0, received -1' },
    ])
    assert.deepEqual(issues(result, { ok: false }), [{ path: '$.failure', message: 'missing required key' }])
    assert.deepEqual(issues(result, 'ok'), [{ path: '$', message: 'expected object, received "ok"' }])
  })

  test('at equal depth the option whose literals match wins', () => {
    const result = s.union([
      s.object({ ok: s.literal(true), kind: s.literal('goto'), url: s.string() }),
      s.object({ ok: s.literal(true), kind: s.enum(['fill', 'click']) }),
    ])
    assert.deepEqual(issues(result, { ok: true, kind: 'fill', url: '/' }), [{ path: '$.url', message: 'unknown key' }])
    assert.deepEqual(issues(result, { ok: true, kind: 'goto' }), [{ path: '$.url', message: 'missing required key' }])
  })

  test('the first of equally close options wins', () => {
    const value = s.union([s.object({ a: s.string() }), s.object({ b: s.string() })])
    assert.deepEqual(issues(value, {}), [{ path: '$.a', message: 'missing required key' }])
  })
})

describe('discriminated unions', () => {
  const event = s.discriminatedUnion('type', [
    s.object({ type: s.literal('saved'), id: s.number() }),
    s.object({ type: s.literal('failed'), reason: s.string() }),
  ])

  test('checks the option the discriminant names', () => {
    accepts(event, { type: 'saved', id: 1 })
    accepts(event, { type: 'failed', reason: 'offline' })
    assert.deepEqual(issues(event, { type: 'saved', id: '1', reason: 'x' }), [
      { path: '$.id', message: 'expected number, received "1"' },
      { path: '$.reason', message: 'unknown key' },
    ])
  })

  test('names every discriminant when none matches', () => {
    assert.deepEqual(issues(event, { type: 'lost' }), [
      { path: '$.type', message: 'expected one of "saved", "failed", received "lost"' },
    ])
    assert.deepEqual(issues(event, { type: { name: 'saved' } }), [
      { path: '$.type', message: 'expected one of "saved", "failed", received object' },
    ])
    const single = s.discriminatedUnion('by', [s.object({ by: s.literal('testId'), value: s.string() })])
    assert.deepEqual(issues(single, { by: 'role', value: 'x' }), [
      { path: '$.by', message: 'expected "testId", received "role"' },
    ])
  })

  test('reports a missing discriminant and non-objects', () => {
    assert.deepEqual(issues(event, { id: 1 }), [{ path: '$.type', message: 'missing required key' }])
    assert.deepEqual(issues(event, 'saved'), [{ path: '$', message: 'expected object, received "saved"' }])
    assert.deepEqual(issues(event, null), [{ path: '$', message: 'expected object, received null' }])
  })

  test('works nested, with paths through it', () => {
    const log = s.object({ events: s.array(event) })
    assert.deepEqual(issues(log, { events: [{ type: 'saved', id: 1 }, { type: 'failed' }] }), [
      { path: '$.events[1].reason', message: 'missing required key' },
    ])
  })

  test('refuses two options with one discriminant', () => {
    assert.throws(
      () =>
        s.discriminatedUnion('type', [
          s.object({ type: s.literal('saved'), id: s.number() }),
          s.object({ type: s.literal('saved'), name: s.string() }),
        ]),
      { name: 'TypeError', message: 'Two options share type "saved".' },
    )
  })
})

describe('toJsonSchema', () => {
  const draft = 'https://json-schema.org/draft/2020-12/schema'

  test('writes each kind', () => {
    assert.deepEqual(toJsonSchema(s.string()), { $schema: draft, type: 'string' })
    assert.deepEqual(toJsonSchema(s.boolean()), { $schema: draft, type: 'boolean' })
    assert.deepEqual(toJsonSchema(s.number()), { $schema: draft, type: 'number' })
    assert.deepEqual(toJsonSchema(s.number({ integer: true, min: 1 })), { $schema: draft, type: 'integer', minimum: 1 })
    assert.deepEqual(toJsonSchema(s.literal(1)), { $schema: draft, const: 1 })
    assert.deepEqual(toJsonSchema(s.literal(null)), { $schema: draft, const: null })
    assert.deepEqual(toJsonSchema(s.enum(['a', 'b'])), { $schema: draft, type: 'string', enum: ['a', 'b'] })
    assert.deepEqual(toJsonSchema(s.array(s.string())), { $schema: draft, type: 'array', items: { type: 'string' } })
    assert.deepEqual(toJsonSchema(s.record(s.number())), {
      $schema: draft,
      type: 'object',
      additionalProperties: { type: 'number' },
    })
    assert.deepEqual(toJsonSchema(s.nullable(s.string())), {
      $schema: draft,
      anyOf: [{ type: 'string' }, { const: null }],
    })
    assert.deepEqual(toJsonSchema(s.union([s.string(), s.number()])), {
      $schema: draft,
      anyOf: [{ type: 'string' }, { type: 'number' }],
    })
  })

  test('objects are closed and list required keys', () => {
    assert.deepEqual(toJsonSchema(s.object({ title: s.string(), note: s.optional(s.string()) })), {
      $schema: draft,
      type: 'object',
      properties: { title: { type: 'string' }, note: { type: 'string' } },
      additionalProperties: false,
      required: ['title'],
    })
    assert.deepEqual(toJsonSchema(s.object({ note: s.optional(s.string()) })), {
      $schema: draft,
      type: 'object',
      properties: { note: { type: 'string' } },
      additionalProperties: false,
    })
  })

  test('discriminated unions are oneOf their objects, and $schema appears only at the root', () => {
    const schema = toJsonSchema(
      s.discriminatedUnion('type', [
        s.object({ type: s.literal('saved'), at: s.object({ line: s.number() }) }),
        s.object({ type: s.literal('failed') }),
      ]),
    )
    assert.deepEqual(schema, {
      $schema: draft,
      oneOf: [
        {
          type: 'object',
          properties: {
            type: { const: 'saved' },
            at: { type: 'object', properties: { line: { type: 'number' } }, additionalProperties: false, required: ['line'] },
          },
          additionalProperties: false,
          required: ['type', 'at'],
        },
        { type: 'object', properties: { type: { const: 'failed' } }, additionalProperties: false, required: ['type'] },
      ],
    })
    assert.deepEqual(JSON.parse(JSON.stringify(schema)), schema)
  })
})
