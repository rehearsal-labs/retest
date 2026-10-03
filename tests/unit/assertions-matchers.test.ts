import type { ObservedItem } from '../../src/protocol/commands.ts'
import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { containCheck, equalCheck, matchCheck, sameCheck } from '../../src/assertions/value-checks.ts'
import { expect } from '../../src/index.ts'
import { observedItemLimit } from '../../src/protocol/commands.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { countCheck, hiddenCheck, textsCheck, valueCheck } from '../../src/protocol/locator-checks.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { inProcessRun } from '../support/api/in-process-run.ts'
import { observationOf } from '../support/observation.ts'

const file = 'tests/unit/assertions-matchers.test.ts'
const locator = "getByRole('listitem')"
const shown = (...texts: string[]): ObservedItem[] => texts.map((text) => ({ text, visible: true }))
const hidden = (...texts: string[]): ObservedItem[] => texts.map((text) => ({ text, visible: false }))
const many = (count: number, visible: boolean): ObservedItem[] => Array.from({ length: count }, (_, index) => ({ text: `${index}`, visible }))

/** A page whose every locator matches these items, and whose single field holds `value`. */
function matching(items: readonly ObservedItem[], value: string | null = null): Responder {
  return (command) => {
    if (command.kind === 'observe') return { ok: true, kind: 'observe', observation: observationOf(items, value) }
    return { ok: true, kind: 'click' }
  }
}

describe('locator checks', () => {
  test('toBeHidden passes when nothing matches or nothing that matches is visible', () => {
    const check = hiddenCheck()
    assert.equal(check.passes(observationOf([])), true)
    assert.equal(check.passes(observationOf(hidden('a'))), true)
    assert.equal(check.passes(observationOf(hidden('a', 'b', 'c'))), true)
    assert.equal(check.passes(observationOf(shown('a'))), false)
    assert.equal(check.passes(observationOf([...hidden('a', 'b'), ...shown('c')])), false)
    assert.equal(check.actual(observationOf([])), 'no element')
    assert.equal(check.actual(observationOf(hidden('a'))), 'hidden')
    assert.equal(check.actual(observationOf([...hidden('a'), ...shown('b', 'c')])), '2 of 3 visible')
    assert.equal(check.mismatch(observationOf(shown('a')), locator), `${locator} is visible.`)
    assert.equal(check.mismatch(observationOf([...hidden('a', 'b'), ...shown('c')]), locator), `${locator} matched 3 elements, and 1 of them is visible.`)
  })

  test('toBeHidden cannot pass on more matches than Retest reads, since it cannot see the rest', () => {
    const check = hiddenCheck()
    const past = observationOf(many(observedItemLimit + 1, false))
    assert.equal(past.itemsTruncated, true)
    assert.equal(check.passes(past), false)
    assert.equal(check.mismatch(past, locator), `${locator} matched 101 elements. Retest reads the first 100, so it cannot tell that all are hidden.`)
    assert.equal(check.passes(observationOf(many(observedItemLimit, false))), true)
  })

  test('toHaveText with a list compares every match in order, hidden ones included', () => {
    const check = textsCheck(['One', 'Two'])
    assert.equal(check.passes(observationOf([...shown(' One '), ...hidden('Two\n')])), true)
    assert.equal(check.passes(observationOf(shown('Two', 'One'))), false)
    assert.equal(check.passes(observationOf(shown('One'))), false)
    assert.equal(check.expected, '["One","Two"]')
    assert.equal(check.actual(observationOf(shown('One'))), '["One"]')
    assert.equal(check.mismatch(observationOf(shown('One')), locator), `${locator} matched 1 element, expected 2.`)
    assert.equal(check.mismatch(observationOf([]), locator), `${locator} matched no element, expected 2.`)
    assert.match(check.mismatch(observationOf(shown('One', 'Three')), locator), /^Match 2 of getByRole\('listitem'\) has text "Three", expected "Two"\. Compared whole text/)
    assert.equal(textsCheck([]).passes(observationOf([])), true)
    assert.match(check.comparison ?? '', /^every match in order, each by whole text/)
  })

  test('toHaveText with a list longer than Retest reads cannot pass', () => {
    const texts = many(observedItemLimit + 1, true).map((item) => item.text)
    const check = textsCheck(texts)
    const observation = observationOf(many(observedItemLimit + 1, true))
    assert.equal(check.passes(observation), false)
    assert.equal(check.mismatch(observation, locator), `${locator} matched 101 elements. Retest reads the first 100, so it cannot compare every text.`)
  })

  test('toHaveCount counts every match, visible or not', () => {
    const check = countCheck(2)
    assert.equal(check.passes(observationOf([...shown('a'), ...hidden('b')])), true)
    assert.equal(check.passes(observationOf(shown('a'))), false)
    assert.equal(countCheck(0).passes(observationOf([])), true)
    assert.equal(countCheck(150).passes(observationOf(many(150, true))), true, 'the count is exact past the items Retest reads')
    assert.equal(check.mismatch(observationOf(shown('a', 'b', 'c')), locator), `${locator} matched 3 elements, expected 2.`)
  })

  test('toHaveValue compares the whole value exactly, and says when the match is not a field', () => {
    const check = valueCheck('Release checklist')
    assert.equal(check.passes(observationOf(shown('x'), 'Release checklist')), true)
    assert.equal(check.passes(observationOf(shown('x'), ' Release checklist')), false, 'a value keeps its spaces')
    assert.equal(check.mismatch(observationOf(shown('x'), 'Draft'), "getByLabel('Title')"), `getByLabel('Title') has value "Draft", expected "Release checklist".`)
    assert.equal(check.mismatch(observationOf(shown('x'), null), "getByText('Saved')"), `getByText('Saved') is not a field with a value.`)
  })
})

describe('locator matchers in a test', () => {
  test('each passes, reports its matcher and app, and counts once', async () => {
    const { runPage, events, commands } = inProcessRun(file, matching(hidden('One', 'Two'), null), { apps: ['web'] })
    const verdict = await runPage(async ({ page }) => {
      await expect(page.getByRole('listitem')).toBeHidden()
      await expect(page.getByRole('listitem')).toHaveText(['One', 'Two'])
      await expect(page.getByRole('listitem')).toHaveCount(2)
    })
    assert.equal(verdict.status, 'passed')
    assert.equal(verdict.assertionCount, 3)
    assert.deepEqual(commands.map((command) => command.kind), ['observe', 'observe', 'observe'])
    const passed = events().flatMap((event) => (event.type === 'assertion.passed' ? [[event.matcher, event.session, event.expected?.text]] : []))
    assert.deepEqual(passed, [
      ['toBeHidden', 'web', 'hidden'],
      ['toHaveText', 'web', '["One","Two"]'],
      ['toHaveCount', 'web', '2'],
    ])
  })

  test('a list matcher that does not pass is check_failed, even with no match', async () => {
    const { runPage } = inProcessRun(file, matching([]), { timeouts: { assertion: 80 } })
    const verdict = await runPage(({ page }) => expect(page.getByRole('listitem')).toHaveCount(2))
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.match(verdict.failure?.message ?? '', /^getByRole\('listitem'\) matched no element, expected 2\. Looked \d+ times in 80 ms\.$/)
    assert.deepEqual(verdict.failure?.details?.['received'], truncateText('0'))
  })

  test('toHaveValue needs exactly one match, like toHaveText with one text', async () => {
    const none = await inProcessRun(file, matching([]), { timeouts: { assertion: 60 } }).runPage(({ page }) => expect(page.getByLabel('Title')).toHaveValue('x'))
    assert.equal(none.failure?.class, 'not_found')
    const two = await inProcessRun(file, matching(shown('a', 'b')), { timeouts: { assertion: 60 } }).runPage(({ page }) =>
      expect(page.getByLabel('Title')).toHaveValue('x'),
    )
    assert.equal(two.failure?.class, 'ambiguous')
    assert.match(two.failure?.message ?? '', /matched 2 elements, and toHaveValue needs exactly one/)
    const draft = await inProcessRun(file, matching(shown('a'), 'Draft'), { timeouts: { assertion: 60 } }).runPage(({ page }) =>
      expect(page.getByLabel('Title')).toHaveValue('Release checklist'),
    )
    assert.equal(draft.failure?.class, 'check_failed')
  })

  const misuses: [string, string, unknown, string][] = [
    ['toHaveText with a number', 'toHaveText', 3, 'toHaveText() takes the expected text as a string or a RegExp, or a list of them, received 3.'],
    ['toContainText with a list', 'toContainText', ['x'], "toContainText() takes the text to look for as a string or a RegExp, received [ 'x' ]."],
    ['toHaveCount with text', 'toHaveCount', '2', "toHaveCount() takes a whole number of elements, received '2'."],
    ['toHaveCount below zero', 'toHaveCount', -1, 'toHaveCount() takes a whole number of elements, received -1.'],
    ['toHaveValue with a number', 'toHaveValue', 3, 'toHaveValue() takes the expected value as a string or a RegExp, received 3.'],
    ['toEqual on a locator', 'toEqual', [], 'toEqual is for values. Use toHaveText on a locator.'],
    ['toContain on a locator', 'toContain', 'x', 'toContain is for values. Use toHaveText on a locator.'],
    ['toMatch on a locator', 'toMatch', /x/, 'toMatch is for values. Use toHaveText on a locator.'],
  ]
  for (const [what, matcher, argument, message] of misuses) {
    test(`${what} from JavaScript is a usage failure that looks at nothing`, async () => {
      const { runPage, commands } = inProcessRun(file, matching(shown('x')))
      const verdict = await runPage(({ page }) => callLoosely(expect(page.getByTestId('saved-task')), matcher, [argument]))
      assert.equal(verdict.failure?.class, 'usage')
      assert.equal(verdict.failure?.message, message)
      assert.deepEqual(commands, [])
    })
  }
})

describe('value checks', () => {
  test('toBe compares with Object.is', () => {
    assert.equal(sameCheck(Number.NaN).mismatch(Number.NaN), undefined)
    assert.equal(sameCheck(-0).mismatch(0), 'Expected -0, received 0. toBe compares with Object.is.')
    assert.equal(sameCheck({ a: 1 }).mismatch({ a: 1 }), 'Expected { a: 1 }, received { a: 1 }. toBe compares with Object.is.')
  })

  test('toEqual compares deeply and says where the values first differ', () => {
    assert.equal(equalCheck({ items: [{ title: 'a' }] }).mismatch({ items: [{ title: 'a' }] }), undefined)
    assert.equal(
      equalCheck({ items: [{ title: 'b' }] }).mismatch({ items: [{ title: 'a' }] }),
      "Expected { items: [ { title: 'b' } ] }, received { items: [ { title: 'a' } ] }. They differ at items[0].title.",
    )
    assert.equal(equalCheck(2).mismatch(3), 'Expected 2, received 3.')
    assert.match(equalCheck(1).comparison, /^deep equality: primitives by Object\.is/)
  })

  test('toContain looks in text, case-sensitive, and in an array by SameValueZero', () => {
    assert.equal(containCheck('check').mismatch('Release checklist'), undefined)
    assert.equal(containCheck('Check').mismatch('Release checklist'), `Expected 'Release checklist' to contain 'Check'.`)
    assert.equal(containCheck(Number.NaN).mismatch([1, Number.NaN]), undefined)
    assert.equal(containCheck({ a: 1 }).mismatch([{ a: 1 }]), 'Expected [ { a: 1 } ] to contain { a: 1 }.', 'an item is found by identity, not deeply')
    assert.equal(containCheck('a').mismatch(3), 'Expected a string or an array to look in, received 3.')
    assert.equal(containCheck(3).mismatch('3'), 'Expected an array to look in, received \'3\'.')
  })

  test('toMatch searches anywhere, keeps the pattern flags and leaves its lastIndex alone', () => {
    const pattern = /saved/gi
    pattern.lastIndex = 5
    assert.equal(matchCheck(pattern).mismatch('Task SAVED'), undefined)
    assert.equal(matchCheck(pattern).mismatch('Task SAVED'), undefined, 'a global pattern matches again')
    assert.equal(pattern.lastIndex, 5)
    assert.equal(matchCheck(/^saved$/).mismatch('Saved'), "Expected 'Saved' to match /^saved$/.")
    assert.equal(matchCheck(/x/).mismatch(3), 'Expected text to match /x/, received 3.')
  })
})

describe('value matchers in a test', () => {
  test('each reports its matcher, both values and its comparison, and checks at once', async () => {
    const { runPage, events, commands } = inProcessRun(file, () => undefined)
    const verdict = await runPage(() => {
      expect({ title: 'a', tags: new Set(['smoke']) }).toEqual({ title: 'a', tags: new Set(['smoke']) })
      expect(['smoke', 'slow']).toContain('slow')
      expect('Release checklist').toMatch(/release/i)
      expect([1, 2]).toEqual([1, 3])
    })
    assert.deepEqual(commands, [])
    assert.equal(verdict.assertionCount, 4)
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.equal(verdict.failure?.message, 'Expected [ 1, 3 ], received [ 1, 2 ]. They differ at [1].')
    const reported = events().map((event) => (event.type === 'assertion.passed' || event.type === 'assertion.failed' ? [event.type, event.matcher, event.actual?.text] : []))
    assert.deepEqual(reported, [
      ['assertion.passed', 'toEqual', "{ title: 'a', tags: Set(1) { 'smoke' } }"],
      ['assertion.passed', 'toContain', "[ 'smoke', 'slow' ]"],
      ['assertion.passed', 'toMatch', "'Release checklist'"],
      ['assertion.failed', 'toEqual', '[ 1, 2 ]'],
    ])
  })

  const misuses: [string, unknown, string, unknown, string][] = [
    ['toContain on a number', 3, 'toContain', 3, 'toContain looks in a string or an array, received 3.'],
    ['toContain on text with a number', '3', 'toContain', 3, 'toContain() on a string takes the text to look for, received 3.'],
    ['toMatch on a number', 3, 'toMatch', /3/, 'toMatch is for strings, received 3.'],
    ['toMatch with text', '3', 'toMatch', '3', "toMatch() takes a RegExp such as /saved/i, received '3'."],
    ['toHaveCount on a value', 3, 'toHaveCount', 3, 'toHaveCount is for locators. Use toBe on a value.'],
  ]
  for (const [what, actual, matcher, argument, message] of misuses) {
    test(`${what} from JavaScript is a usage failure`, async () => {
      const verdict = await inProcessRun(file, () => undefined).runPage(() => callLoosely(expect(actual), matcher, [argument]))
      assert.equal(verdict.failure?.class, 'usage')
      assert.equal(verdict.failure?.message, message)
    })
  }
})
