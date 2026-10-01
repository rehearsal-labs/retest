import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeScrollDelta, scrollProblem } from '../../src/protocol/scroll-delta.ts'

describe('scroll deltas: how far a scroll turns the wheel', () => {
  test('a distance on either axis, in either direction, is a scroll', () => {
    for (const delta of [{ x: 0, y: 600 }, { x: -120, y: 0 }, { x: 0.5, y: -0.5 }, { x: 1e6, y: 1e6 }]) {
      assert.equal(scrollProblem(delta), undefined, JSON.stringify(delta))
    }
  })

  test('both processes refuse no distance at all, as usage', () => {
    const message = 'scroll() takes x and y in CSS pixels, one of them other than 0, received { x: 0, y: 0 }.'
    assert.deepEqual(scrollProblem({ x: 0, y: 0 }), { class: 'usage', message })
    assert.deepEqual(scrollProblem({ x: -0, y: 0 }), { class: 'usage', message })
  })

  test('both processes refuse an axis that is not a finite number, as usage', () => {
    assert.deepEqual(scrollProblem({ x: Number.NaN, y: 600 }), {
      class: 'usage',
      message: 'scroll() takes x and y as finite numbers of CSS pixels, received { x: NaN, y: 600 }.',
    })
    assert.deepEqual(scrollProblem({ x: 0, y: Number.POSITIVE_INFINITY }), {
      class: 'usage',
      message: 'scroll() takes x and y as finite numbers of CSS pixels, received { y: Infinity }.',
    })
  })

  test('a delta is named as a test writes it: the axes that move, or both when neither does', () => {
    assert.equal(describeScrollDelta({ x: 0, y: 600 }), '{ y: 600 }')
    assert.equal(describeScrollDelta({ x: 120, y: 0 }), '{ x: 120 }')
    assert.equal(describeScrollDelta({ x: -40.5, y: 1200 }), '{ x: -40.5, y: 1200 }')
    assert.equal(describeScrollDelta({ x: 0, y: 0 }), '{ x: 0, y: 0 }')
    assert.equal(describeScrollDelta({ x: -0, y: 0 }), '{ x: 0, y: 0 }')
  })
})
