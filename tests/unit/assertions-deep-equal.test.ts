import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { firstDifference } from '../../src/assertions/deep-equal.ts'

const equal = (actual: unknown, expected: unknown): void => assert.equal(firstDifference(actual, expected), undefined)

describe('firstDifference', () => {
  test('compares primitives with Object.is', () => {
    equal(Number.NaN, Number.NaN)
    equal('a', 'a')
    assert.equal(firstDifference(0, -0), '')
    assert.equal(firstDifference('1', 1), '')
    assert.equal(firstDifference(null, undefined), '')
  })

  test('compares arrays item by item, a missing item reading as undefined', () => {
    equal([1, [2, 3]], [1, [2, 3]])
    assert.equal(firstDifference([1, 2], [1, 2, 3]), '.length')
    assert.equal(firstDifference([1, [2, 3]], [1, [2, 4]]), '[1][1]')
    equal(Array.from({ length: 2 }), [undefined, undefined])
    assert.equal(firstDifference([], {}), '', 'an array is not a plain object')
  })

  test('compares plain objects by their own keys, a key set to undefined counting', () => {
    equal({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })
    equal(Object.assign(Object.create(null), { a: 1 }), { a: 1 })
    assert.equal(firstDifference({ a: 1, b: undefined }, { a: 1 }), '.b')
    assert.equal(firstDifference({ a: 1 }, { a: 1, b: undefined }), '.b')
    assert.equal(firstDifference({ items: [{ title: 'a' }] }, { items: [{ title: 'b' }] }), '.items[0].title')
    assert.equal(firstDifference({ 'task-title': 'a' }, { 'task-title': 'b' }), '["task-title"]')
  })

  test('compares dates by their time', () => {
    equal(new Date('2026-09-30T10:00:00Z'), new Date('2026-09-30T10:00:00.000Z'))
    equal(new Date('not a date'), new Date('not a date either'))
    assert.equal(firstDifference({ at: new Date(1) }, { at: new Date(2) }), '.at')
    assert.equal(firstDifference(new Date(1), 1), '')
  })

  test('compares maps by key, then value, and sets by member', () => {
    const key = { id: 1 }
    equal(new Map<unknown, unknown>([['a', { x: 1 }], [key, 2]]), new Map<unknown, unknown>([[key, 2], ['a', { x: 1 }]]))
    assert.equal(firstDifference(new Map([['a', 1]]), new Map([['a', 1], ['b', 2]])), '.size')
    assert.equal(firstDifference(new Map([['a', 1]]), new Map([['b', 1]])), ".get('a')")
    assert.equal(firstDifference(new Map([['a', { x: 1 }]]), new Map([['a', { x: 2 }]])), ".get('a').x")
    assert.equal(firstDifference(new Map([[{ id: 1 }, 1]]), new Map([[{ id: 1 }, 1]])), '.get({ id: 1 })', 'object keys are found by identity')
    equal(new Set([1, 'a', { x: 1 }]), new Set([{ x: 1 }, 'a', 1]))
    assert.equal(firstDifference(new Set([1]), new Set([1, 2])), '.size')
    assert.equal(firstDifference(new Set([{ x: 1 }, { x: 1 }]), new Set([{ x: 1 }, { y: 2 }])), '', 'each member needs its own partner')
  })

  test('any other object must be the same object', () => {
    class Task {
      title = 'a'
    }
    const task = new Task()
    equal(task, task)
    assert.equal(firstDifference(new Task(), new Task()), '')
    assert.equal(firstDifference(/a/, /a/), '')
    assert.equal(firstDifference(() => 1, () => 1), '')
  })

  test('ends on cycles', () => {
    type Node = { name: string; next?: Node }
    const first: Node = { name: 'a' }
    first.next = first
    const second: Node = { name: 'a' }
    second.next = second
    equal(first, second)
    assert.equal(firstDifference(first, { name: 'a', next: { name: 'b', next: first } }), '.next.name')
  })
})
