import type { LayoutLook, LayoutTarget, MeasuredElement } from '../../src/protocol/layout.ts'
import type { LayoutCheckRecord } from '../../src/protocol/layout-checks.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { describeWidth, layoutLimits, roundPixels } from '../../src/protocol/layout.ts'
import { layoutCheck, layoutCheckRecordSchema, layoutRecordSchema, layoutRequest } from '../../src/protocol/layout-checks.ts'
import { checkRecordSchema, decidedByLook, isLayoutCheck, isPageCheck } from '../../src/protocol/locator-checks.ts'
import { parse } from '../../src/protocol/schema.ts'

const save: LocatorRecipe = { by: 'testId', value: 'save' }
const help: LocatorRecipe = { by: 'testId', value: 'help' }
const saveText = "getByTestId('save')"
const helpText = "getByTestId('help')"

function shown(left: number, top: number, right: number, bottom: number, extra: Partial<MeasuredElement> = {}): LayoutTarget {
  const box = { left, top, right, bottom }
  return { count: 1, element: { shown: true, box, seen: box, field: false, ...extra } }
}

function look(targets: LayoutTarget[], extra: Partial<LayoutLook> = {}): LayoutLook {
  return { viewport: { width: 768, height: 1024 }, edge: 768, documentWidth: 768, hidesSideways: false, targets, ...extra }
}

function both(record: LayoutCheckRecord) {
  return { plain: layoutCheck(record), negated: layoutCheck({ ...record, not: true }) }
}

describe('toOverlap', () => {
  const { plain, negated } = both({ matcher: 'toOverlap', other: help })

  test('two elements that share more than 4 by 4 pixels overlap, and the failure names the pixels and the width', () => {
    const overlapping = look([shown(0, 0, 100, 40), shown(68, 8, 200, 40)])
    assert.deepEqual([plain.passes(overlapping), negated.passes(overlapping)], [true, false])
    assert.equal(plain.actual(overlapping), 'share 32 by 32 pixels at 768 pixels wide')
    assert.deepEqual(negated.unmet(overlapping, save), { class: 'check_failed', message: `${saveText} and ${helpText} overlap: they share 32 by 32 pixels at 768 pixels wide.` })
    assert.deepEqual(negated.measured(overlapping), { viewport: { width: 768, height: 1024 }, edge: 768, shared: { across: 32, down: 32 } })
    assert.equal(negated.matcher, 'not.toOverlap')
    assert.equal(plain.expected, `share more than 4 by 4 pixels with ${helpText}`)
    assert.equal(negated.expected, `share no more than 4 pixels across or down with ${helpText}`)
  })

  test('4 pixels either way is not an overlap, and 4.5 both ways is', () => {
    const four = look([shown(0, 0, 100, 40), shown(96, 0, 200, 40)])
    assert.deepEqual([plain.passes(four), negated.passes(four)], [false, true])
    assert.equal(plain.unmet(four, save).message, `${saveText} and ${helpText} share only 4 by 40 pixels at 768 pixels wide, and an overlap is more than 4 pixels each way.`)
    const more = look([shown(0, 0, 100, 40), shown(95.5, 35.5, 200, 80)])
    assert.deepEqual([plain.passes(more), negated.passes(more)], [true, false])
    assert.equal(plain.actual(more), 'share 4.5 by 4.5 pixels at 768 pixels wide')
  })

  test('two elements apart do not touch', () => {
    const apart = look([shown(0, 0, 100, 40), shown(120, 0, 200, 40)])
    assert.deepEqual([plain.passes(apart), negated.passes(apart)], [false, true])
    assert.equal(plain.unmet(apart, save).message, `${saveText} and ${helpText} do not touch at 768 pixels wide.`)
    assert.deepEqual(plain.measured(apart).shared, { across: -20, down: 40 })
  })

  test('a control inside a field never overlaps it, whichever locator finds the field', () => {
    const field = shown(0, 0, 300, 40, { field: true })
    const clear = shown(260, 8, 290, 32)
    const inField = look([field, clear])
    assert.deepEqual([plain.passes(inField), negated.passes(inField)], [false, true])
    assert.equal(plain.unmet(inField, save).message, `${helpText} sits inside the field ${saveText}, and a control inside a field never overlaps it. They share 30 by 24 pixels at 768 pixels wide.`)
    assert.equal(layoutCheck({ matcher: 'toOverlap', other: help, not: true }).passes(look([clear, field])), true)
    const sticking = look([field, shown(280, 8, 320, 32)])
    assert.equal(plain.passes(sticking), true, 'a control that sticks out of the field overlaps it')
  })

  test('an element missing, ambiguous or not shown on either side passes neither way, and says which', () => {
    const missing = look([shown(0, 0, 100, 40), { count: 0 }])
    assert.deepEqual([plain.passes(missing), negated.passes(missing)], [false, false])
    assert.deepEqual(negated.unmet(missing, save), { class: 'not_found', message: `${helpText} matched no element.` })
    const several = look([{ count: 2 }, shown(0, 0, 100, 40)])
    assert.deepEqual(negated.unmet(several, save), { class: 'ambiguous', message: `${saveText} matched 2 elements, and not.toOverlap needs exactly one.` })
    const hidden = look([shown(0, 0, 100, 40), { count: 1, element: { shown: false, box: { left: 0, top: 0, right: 0, bottom: 0 }, seen: { left: 0, top: 0, right: 0, bottom: 0 }, field: false } }])
    assert.deepEqual([plain.passes(hidden), negated.passes(hidden)], [false, false])
    assert.deepEqual(negated.unmet(hidden, save), { class: 'check_failed', message: `${helpText} is not shown, so Retest cannot measure it.` })
    assert.equal(negated.actual(hidden), 'not shown')
    assert.deepEqual(negated.measured(hidden), { viewport: { width: 768, height: 1024 }, edge: 768 })
  })

  test('the step of a scoped locator that kept nothing is named', () => {
    const scoped: LocatorRecipe = { by: 'role', role: 'button', within: [{ by: 'testId', value: 'toolbar' }] }
    const missing = look([{ count: 0, emptyStep: { step: 0, matched: 0 } }, shown(0, 0, 10, 10)])
    assert.equal(plain.unmet(missing, scoped).message, "getByTestId('toolbar').getByRole('button') matched no element. getByTestId('toolbar') matched no element.")
  })

  test('one element, or one inside the other, passes neither way', () => {
    const elements = [shown(0, 0, 100, 40), shown(0, 0, 100, 40)]
    for (const [nesting, message] of [
      ['same', `${saveText} and ${helpText} find the same element, so they cannot overlap. Compare two separate elements.`],
      ['first', `${saveText} holds ${helpText}, so they cannot overlap. Compare two separate elements.`],
      ['second', `${helpText} holds ${saveText}, so they cannot overlap. Compare two separate elements.`],
    ] as const) {
      const nested = look(elements, { nesting })
      assert.deepEqual([plain.passes(nested), negated.passes(nested)], [false, false], nesting)
      assert.deepEqual(negated.unmet(nested, save), { class: 'check_failed', message })
    }
  })
})

describe('toOverflowViewport', () => {
  const { plain, negated } = both({ matcher: 'toOverflowViewport' })
  const at390 = (right: number) => look([shown(300, 0, right, 40)], { viewport: { width: 390, height: 844 }, edge: 390 })

  test('the visible part ending more than a pixel past the edge overflows, named in pixels at the width', () => {
    const past = at390(404)
    assert.deepEqual([plain.passes(past), negated.passes(past)], [true, false])
    assert.deepEqual(negated.unmet(past, save), { class: 'check_failed', message: `${saveText} ends 14 pixels past the right edge at 390 pixels wide.` })
    assert.deepEqual(negated.measured(past), { viewport: { width: 390, height: 844 }, edge: 390, pastEdge: 14 })
  })

  test('a pixel past the edge is rounding and does not count; before the edge is inside', () => {
    assert.deepEqual([plain.passes(at390(391)), negated.passes(at390(391))], [false, true])
    assert.equal(plain.unmet(at390(391), save).message, `${saveText} ends 1 pixel past the right edge at 390 pixels wide, and only more than 1 pixel counts.`)
    assert.equal(plain.passes(at390(391.5)), true)
    assert.equal(plain.unmet(at390(370), save).message, `${saveText} ends 20 pixels before the right edge at 390 pixels wide.`)
    assert.equal(plain.actual(at390(390)), 'ends at the right edge at 390 pixels wide')
  })

  test('the edge is the width without the scrollbar, and the sentence says both', () => {
    const scrollbar = look([shown(300, 0, 385, 40)], { viewport: { width: 390, height: 844 }, edge: 375 })
    assert.equal(plain.passes(scrollbar), true)
    assert.equal(negated.unmet(scrollbar, save).message, `${saveText} ends 10 pixels past the right edge at 390 pixels wide, 375 without the scrollbar.`)
  })

  test('a hidden or missing element passes neither way', () => {
    const missing = look([{ count: 0 }])
    assert.deepEqual([plain.passes(missing), negated.passes(missing)], [false, false])
    assert.equal(negated.unmet(missing, save).class, 'not_found')
  })
})

describe('toHaveClippedText', () => {
  const { plain, negated } = both({ matcher: 'toHaveClippedText' })
  const cut = (amount: number | null) => look([shown(0, 0, 100, 20, { cut: amount })], { viewport: { width: 390, height: 844 }, edge: 390 })

  test('more than 4 pixels cut off is clipped, named in pixels at the width', () => {
    assert.deepEqual([plain.passes(cut(14)), negated.passes(cut(14))], [true, false])
    assert.equal(plain.actual(cut(14)), 'cut 14 pixels at 390 pixels wide')
    assert.deepEqual(negated.unmet(cut(14), save), { class: 'check_failed', message: `A container cuts off 14 pixels of the words in ${saveText} at 390 pixels wide.` })
    assert.deepEqual(negated.measured(cut(14)), { viewport: { width: 390, height: 844 }, edge: 390, cut: 14 })
  })

  test('4 pixels or none is not clipped', () => {
    assert.deepEqual([plain.passes(cut(4)), negated.passes(cut(4))], [false, true])
    assert.equal(plain.unmet(cut(4), save).message, `A container cuts off only 4 pixels of the words in ${saveText} at 390 pixels wide, and only more than 4 pixels counts.`)
    assert.equal(plain.unmet(cut(0), save).message, `No container cuts off the words in ${saveText} at 390 pixels wide.`)
    assert.equal(plain.passes(cut(4.5)), true)
  })

  test('an element that shows no words, or a look that read none, passes neither way', () => {
    assert.deepEqual([plain.passes(cut(null)), negated.passes(cut(null))], [false, false])
    assert.deepEqual(negated.unmet(cut(null), save), { class: 'check_failed', message: `${saveText} shows no words, so Retest cannot tell whether a container cuts them off.` })
    const unread = look([shown(0, 0, 100, 20)])
    assert.deepEqual([plain.passes(unread), negated.passes(unread)], [false, false])
  })
})

describe('toScrollHorizontally', () => {
  const { plain, negated } = both({ matcher: 'toScrollHorizontally' })
  const page = (documentWidth: number, hidesSideways = false) => look([], { viewport: { width: 390, height: 844 }, edge: 390, documentWidth, hidesSideways })

  test('a document more than a pixel wider than the edge scrolls sideways, named in pixels at the width', () => {
    assert.deepEqual([plain.passes(page(1024)), negated.passes(page(1024))], [true, false])
    assert.deepEqual(negated.unmet(page(1024), undefined), { class: 'check_failed', message: 'The page is 1024 pixels wide and scrolls 634 pixels sideways at 390 pixels wide.' })
    assert.deepEqual(negated.measured(page(1024)), { viewport: { width: 390, height: 844 }, edge: 390, documentWidth: 1024 })
    assert.equal(plain.actual(page(1024)), 'document 1024 pixels wide at 390 pixels wide')
  })

  test('a page that fits, is a pixel wider, or hides what runs past the viewport does not scroll', () => {
    assert.deepEqual([plain.passes(page(390)), negated.passes(page(390))], [false, true])
    assert.equal(plain.unmet(page(390), undefined).message, 'The page fits its viewport at 390 pixels wide, so it does not scroll sideways.')
    assert.equal(negated.passes(page(391)), true)
    assert.equal(plain.unmet(page(391), undefined).message, 'The page is 391 pixels wide at 390 pixels wide, and only more than 1 pixel past the edge counts.')
    assert.deepEqual([plain.passes(page(1024, true)), negated.passes(page(1024, true))], [false, true])
    assert.equal(plain.unmet(page(1024, true), undefined).message, 'The page is 1024 pixels wide at 390 pixels wide, but it hides what runs past the viewport, so it does not scroll sideways.')
    assert.equal(plain.actual(page(1024, true)), 'document 1024 pixels wide at 390 pixels wide, overflow hidden')
  })
})

describe('layout check records', () => {
  test('every record, negated or not, has a schema, is a check an assertion carries, and is decided by a look', () => {
    const records: LayoutCheckRecord[] = [
      { matcher: 'toOverlap', other: help },
      { matcher: 'toOverlap', other: help, not: true },
      { matcher: 'toOverflowViewport' },
      { matcher: 'toHaveClippedText', not: true },
      { matcher: 'toScrollHorizontally' },
    ]
    for (const record of records) {
      assert.equal(parse(layoutCheckRecordSchema, record).ok, true, JSON.stringify(record))
      assert.equal(parse(checkRecordSchema, record).ok, true, JSON.stringify(record))
      assert.equal(isLayoutCheck(record), true)
      assert.equal(isPageCheck(record), false)
      assert.equal(decidedByLook(layoutCheck(record).matcher), true)
    }
    assert.equal(parse(layoutCheckRecordSchema, { matcher: 'toOverlap' }).ok, false, 'toOverlap names the other element')
    assert.equal(parse(layoutCheckRecordSchema, { matcher: 'toScrollHorizontally', other: help }).ok, false)
    assert.equal(isLayoutCheck({ matcher: 'toHaveText', text: 'x' }), false)
  })

  test('a check asks for the elements it measures, and words only for toHaveClippedText', () => {
    assert.deepEqual(layoutRequest({ matcher: 'toOverlap', other: help }, save), { locator: save, other: help })
    assert.deepEqual(layoutRequest({ matcher: 'toOverflowViewport', not: true }, save), { locator: save })
    assert.deepEqual(layoutRequest({ matcher: 'toHaveClippedText' }, save), { locator: save, words: true })
    assert.deepEqual(layoutRequest({ matcher: 'toScrollHorizontally' }, save), {})
  })

  test('what a check measured has a schema of its own', () => {
    const measured = layoutCheck({ matcher: 'toOverlap', other: help }).measured(look([shown(0, 0, 100, 40), shown(68, 8, 200, 40)]))
    assert.equal(parse(layoutRecordSchema, measured).ok, true)
  })

  test('the limits are the survey numbers, and pixels are recorded to a tenth', () => {
    assert.deepEqual({ ...layoutLimits }, { overlap: 4, tolerance: 1, clipped: 4, shown: 2, descendants: 200 })
    assert.deepEqual([roundPixels(31.96), roundPixels(4.04), roundPixels(-0.01)], [32, 4, 0])
    assert.equal(describeWidth({ viewport: { width: 390, height: 844 }, edge: 390 }), 'at 390 pixels wide')
  })
})
