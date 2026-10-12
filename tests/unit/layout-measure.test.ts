import type { LayoutReading, ReadNode, ReadPage, ReadStyle, ReadTarget } from '../../src/browser/layout.ts'
import type { LayoutBox, MeasuredElement } from '../../src/protocol/layout.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { layoutUnmeasured, measureLayout } from '../../src/browser/layout.ts'

// Readings written by hand, as Retest's page function would answer them: the body first, then each element after its
// parent. Every rule a layout look applies is applied here, in Node, to what the page read.

type Spec = { parent?: number; box: [number, number, number, number]; style?: Partial<ReadStyle>; words?: boolean; field?: boolean; overrun?: { across: number; down: number } }

const plain: ReadStyle = { display: 'block', visibility: 'visible', opacity: 1, position: 'static', overflowX: 'visible', overflowY: 'visible', textOverflow: 'clip', lineClamp: 'none' }
const body: Spec = { parent: -1, box: [0, 0, 800, 600] }
const page: ReadPage = { width: 800, height: 600, edge: 800, scrollWidth: 800, rootOverflowX: 'visible', bodyOverflowX: 'visible' }

function node({ parent = 0, box: [left, top, right, bottom], style = {}, words = false, field = false, overrun = { across: 0, down: 0 } }: Spec): ReadNode {
  return { parent, box: { left, top, right, bottom }, style: { ...plain, ...style }, words, field, overrun }
}

function reading(specs: readonly Spec[], targets: readonly ReadTarget[], pageFacts: Partial<ReadPage> = {}): LayoutReading {
  return { nodes: specs.map(node), targets: [...targets], page: { ...page, ...pageFacts } }
}

function one(index: number, inner: number[] = []): ReadTarget {
  return { count: 1, node: index, inner }
}

function element(specs: readonly Spec[], index: number, words = false): MeasuredElement {
  const measured = measureLayout(reading(specs, [one(index, words ? specs.map((_, at) => at).filter((at) => at > index) : [])]), words).targets[0]?.element
  assert.ok(measured !== undefined)
  return measured
}

function box(left: number, top: number, right: number, bottom: number): LayoutBox {
  return { left, top, right, bottom }
}

describe('what counts as shown', () => {
  test('an element at least two pixels each way, with nothing around it undisplayed or faded out, is shown', () => {
    assert.equal(element([body, { box: [10, 10, 12, 12] }], 1).shown, true)
    assert.equal(element([body, { box: [10, 10, 11.9, 40] }], 1).shown, false, 'less than two pixels across')
    assert.equal(element([body, { box: [10, 10, 40, 11.5] }], 1).shown, false, 'less than two pixels down')
  })

  test('display none or an opacity of 0 on it or any element around it, the body included, hides it; its own visibility does too', () => {
    const inside = { parent: 1, box: [0, 0, 100, 20] as const }
    assert.equal(element([body, { box: [0, 0, 100, 20], style: { display: 'none' } }, { ...inside, box: [0, 0, 100, 20] }], 2).shown, false)
    assert.equal(element([body, { box: [0, 0, 100, 20], style: { opacity: 0 } }, { ...inside, box: [0, 0, 100, 20] }], 2).shown, false)
    assert.equal(element([{ ...body, style: { opacity: 0 } }, { box: [0, 0, 100, 20] }], 1).shown, false, 'the body counts')
    assert.equal(element([body, { box: [0, 0, 100, 20], style: { visibility: 'hidden' } }], 1).shown, false)
    assert.equal(element([body, { box: [0, 0, 100, 20], style: { opacity: 0.01 } }], 1).shown, true, 'faint is not faded out')
  })

  test('an element outside the body, or the body itself, is one the look found but cannot measure', () => {
    const look = measureLayout(reading([body], [{ count: 1, node: null, inner: [] }]), true)
    assert.deepEqual(look.targets[0], { count: 1, element: { shown: false, box: box(0, 0, 0, 0), seen: box(0, 0, 0, 0), field: false, cut: null } })
  })

  test('a count other than one carries no element, and none keeps the step that kept nothing', () => {
    const look = measureLayout(reading([body], [{ count: 0, emptyStep: { step: 0, matched: 0 }, node: null, inner: [] }, { count: 3, node: null, inner: [] }]), false)
    assert.deepEqual(look.targets, [{ count: 0, emptyStep: { step: 0, matched: 0 } }, { count: 3 }])
  })
})

describe('the visible box', () => {
  test('every container whose overflow on an axis is not visible cuts the box on that axis, and the body cuts nothing', () => {
    const wide = { parent: 1, box: [0, 0, 300, 50] as [number, number, number, number] }
    assert.deepEqual(element([body, { box: [0, 0, 100, 20], style: { overflowX: 'hidden', overflowY: 'hidden' } }, wide], 2).seen, box(0, 0, 100, 20))
    assert.deepEqual(element([body, { box: [0, 0, 100, 20], style: { overflowX: 'auto' } }, wide], 2).seen, box(0, 0, 100, 50), 'a scrolling container cuts what it hides, on its own axis')
    assert.deepEqual(element([body, { box: [0, 0, 100, 20] }, wide], 2).seen, box(0, 0, 300, 50))
    assert.deepEqual(element([{ ...body, box: [0, 0, 100, 20], style: { overflowX: 'hidden', overflowY: 'hidden' } }, { box: [0, 0, 300, 50] }], 1).seen, box(0, 0, 300, 50))
  })

  test('a fixed element stands on the viewport, and a fixed container cuts what is inside it while nothing above it does', () => {
    const clipping = { box: [0, 0, 100, 20] as [number, number, number, number], style: { overflowX: 'hidden', overflowY: 'hidden' } }
    assert.deepEqual(element([body, clipping, { parent: 1, box: [0, 0, 300, 50], style: { position: 'fixed' } }], 2).seen, box(0, 0, 300, 50))
    const fixedFrame = { parent: 1, box: [0, 0, 200, 40] as [number, number, number, number], style: { position: 'fixed', overflowX: 'hidden', overflowY: 'hidden' } }
    assert.deepEqual(element([body, clipping, fixedFrame, { parent: 2, box: [0, 0, 300, 50] }], 3).seen, box(0, 0, 200, 40))
  })

  test('an element a container hides entirely is not shown', () => {
    const clipping = { box: [0, 0, 100, 20] as [number, number, number, number], style: { overflowX: 'hidden' } }
    assert.equal(element([body, clipping, { parent: 1, box: [150, 0, 250, 20] }], 2).shown, false)
  })
})

describe('words a container cuts off', () => {
  const clipping: Spec = { box: [0, 0, 100, 20], style: { overflowX: 'hidden', overflowY: 'hidden' } }

  test('a container that hides overflow cuts off what its words run past it', () => {
    assert.equal(element([body, clipping, { parent: 1, box: [0, 0, 114, 20], words: true }], 2, true).cut, 14)
    assert.equal(element([body, clipping, { parent: 1, box: [0, -3, 100, 20], words: true }], 2, true).cut, 3, 'down counts as across does')
  })

  test('a container that scrolls, or one that shortens its text with an ellipsis or a line clamp, cuts off nothing', () => {
    const scrolling = { ...clipping, style: { overflowX: 'auto', overflowY: 'auto' } }
    assert.equal(element([body, scrolling, { parent: 1, box: [0, 0, 160, 20], words: true }], 2, true).cut, 0)
    const ellipsis = { ...clipping, style: { ...clipping.style, textOverflow: 'ellipsis' } }
    assert.equal(element([body, ellipsis, { parent: 1, box: [0, 0, 160, 20], words: true }], 2, true).cut, 0)
    const clamped = { ...clipping, style: { ...clipping.style, lineClamp: '2' } }
    assert.equal(element([body, clamped, { parent: 1, box: [0, 0, 100, 60], words: true }], 2, true).cut, 0)
  })

  test('an element that hides its own overflow cuts off its own words by how far they run past its client box', () => {
    const own = { box: [0, 0, 100, 20] as [number, number, number, number], words: true, style: { overflowX: 'hidden' }, overrun: { across: 22, down: 0 } }
    assert.equal(element([body, own], 1, true).cut, 22)
    assert.equal(element([body, { ...own, style: { overflowX: 'hidden', textOverflow: 'ellipsis' } }], 1, true).cut, 0, 'unless it shortens them on purpose')
    assert.equal(element([body, { ...own, style: { overflowX: 'visible' } }], 1, true).cut, 0, 'overflow that shows is not cut')
  })

  test('the cut of an element is the most of its own words and those of the elements inside it that were read', () => {
    const card: Spec = { parent: 1, box: [0, 0, 100, 20] }
    const title: Spec = { parent: 2, box: [0, 0, 130, 20], words: true }
    const note: Spec = { parent: 2, box: [0, 0, 108, 20], words: true }
    assert.equal(element([body, clipping, card, title, note], 2, true).cut, 30)
  })

  test('an element with no words of its own or inside it, or words wholly out of view, has none to cut', () => {
    assert.equal(element([body, clipping, { parent: 1, box: [0, 0, 160, 20] }], 2, true).cut, null)
    assert.equal(element([body, clipping, { parent: 1, box: [0, 0, 160, 20], words: true, style: { visibility: 'hidden' } }], 2, true).cut, null)
    const sliver = { box: [0, 0, 101, 20] as [number, number, number, number], style: { overflowX: 'hidden', overflowY: 'hidden' } }
    assert.equal(element([body, sliver, { parent: 1, box: [100, 0, 300, 20], words: true }], 2, true).shown, false, 'one pixel of it shows')
  })

  test('a look that did not read words carries no cut', () => {
    assert.equal(Object.hasOwn(element([body, clipping, { parent: 1, box: [0, 0, 160, 20], words: true }], 2), 'cut'), false)
  })
})

describe('two elements and the page', () => {
  test('two locators that find one element, or one inside the other, are nested, and two apart are not', () => {
    const specs: Spec[] = [body, { box: [0, 0, 100, 100] }, { parent: 1, box: [0, 0, 50, 50] }, { box: [200, 0, 300, 50] }]
    const nesting = (first: number, second: number) => measureLayout(reading(specs, [one(first), one(second)]), false).nesting
    assert.equal(nesting(1, 1), 'same')
    assert.equal(nesting(1, 2), 'first')
    assert.equal(nesting(2, 1), 'second')
    assert.equal(nesting(2, 3), undefined)
    assert.equal(measureLayout(reading(specs, [one(1)]), false).nesting, undefined, 'one locator has no nesting')
  })

  test("the viewport hides what runs past it when the root hides its overflow, or the body does while the root's is visible", () => {
    const hides = (rootOverflowX: string, bodyOverflowX: string | null) => measureLayout(reading([body], [], { rootOverflowX, bodyOverflowX }), false).hidesSideways
    assert.equal(hides('hidden', 'visible'), true)
    assert.equal(hides('clip', 'visible'), true)
    assert.equal(hides('visible', 'hidden'), true)
    assert.equal(hides('auto', 'hidden'), false, "the root's own overflow is the viewport's once it is not visible")
    assert.equal(hides('visible', null), false)
    assert.equal(hides('visible', 'auto'), false)
  })

  test('the look carries the viewport, the edge and the width of the document as the page read them', () => {
    const look = measureLayout(reading([body], [], { width: 390, height: 844, edge: 375, scrollWidth: 1024 }), false)
    assert.deepEqual({ viewport: look.viewport, edge: look.edge, documentWidth: look.documentWidth }, { viewport: { width: 390, height: 844 }, edge: 375, documentWidth: 1024 })
  })

  test('a reading that lists an element before its parent, or names a place it does not have, is refused', () => {
    assert.throws(() => measureLayout(reading([body, { parent: 1, box: [0, 0, 1, 1] }], []), false), /listed element 1 before its parent 1/)
    assert.throws(() => measureLayout(reading([body], [one(4)]), false), /named element 4 of 1/)
  })
})

test('an engine Retest does not measure layout on yet answers unsupported, naming it', () => {
  assert.deepEqual(layoutUnmeasured('Firefox'), { class: 'unsupported', message: 'Retest measures layout on Chrome and Chromium only, and not on Firefox yet, so it measured nothing.' })
})
