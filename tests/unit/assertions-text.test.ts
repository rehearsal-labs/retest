import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatValue } from '../../src/api/format-value.ts'
import { quoteText, shorten } from '../../src/assertions/format.ts'
import { textCheck, visibleCheck } from '../../src/assertions/locator-checks.ts'
import { pollDelay } from '../../src/assertions/poll-locator.ts'
import { normalizeText, textComparison } from '../../src/assertions/text.ts'

describe('text comparison', () => {
  test('trims both ends and reads each run of spaces or line breaks as one space', () => {
    assert.equal(normalizeText('  Release\n\t  checklist \r\n'), 'Release checklist')
    assert.equal(normalizeText('a  b'), 'a b')
    assert.equal(normalizeText(''), '')
    assert.equal(normalizeText(' \n '), '')
  })

  test('changes nothing else: case, punctuation and inner characters count', () => {
    assert.notEqual(normalizeText('Release Checklist'), normalizeText('Release checklist'))
    assert.notEqual(normalizeText('Release checklist.'), normalizeText('Release checklist'))
    assert.notEqual(normalizeText('Releasechecklist'), normalizeText('Release checklist'))
    assert.equal(normalizeText('Saving…'), 'Saving…')
  })

  test('the rule is written out for every result', () => {
    assert.equal(textComparison, 'whole text, ends trimmed, each run of spaces or line breaks read as one space')
  })
})

describe('locator checks', () => {
  const one = (text: string | null, visible = true): { count: number; visible: boolean | null; text: string | null } => ({
    count: 1,
    visible,
    text,
  })

  test('toHaveText needs exactly one element whose whole text matches', () => {
    const check = textCheck('Release checklist')
    assert.equal(check.passes(one('\n Release   checklist ')), true)
    assert.equal(check.passes(one('Release checklist!')), false)
    assert.equal(check.passes(one('Release')), false, 'no substring match')
    assert.equal(check.passes({ count: 2, visible: null, text: null }), false)
    assert.equal(check.passes({ count: 0, visible: null, text: null }), false)
    assert.equal(check.comparison, textComparison)
    assert.equal(
      check.mismatch(one('Draft'), "getByTestId('saved-task')"),
      `getByTestId('saved-task') has text "Draft", expected "Release checklist". Compared ${textComparison}.`,
    )
  })

  test('an empty expected text matches an element with no text', () => {
    assert.equal(textCheck('').passes(one('  ')), true)
  })

  test('toBeVisible needs exactly one visible element', () => {
    const check = visibleCheck()
    assert.equal(check.passes(one('x')), true)
    assert.equal(check.passes(one('x', false)), false)
    assert.equal(check.passes({ count: 2, visible: null, text: null }), false)
    assert.equal(check.actual(one('x', false)), 'hidden')
    assert.equal(check.actual({ count: 0, visible: null, text: null }), null)
  })
})

describe('polling', () => {
  test('looks at once, then backs off to twice a second', () => {
    assert.deepEqual(
      [0, 1, 2, 3, 4, 5, 50].map(pollDelay),
      [0, 50, 100, 250, 500, 500, 500],
    )
  })
})

describe('message formatting', () => {
  test('long values are cut for messages', () => {
    assert.equal(quoteText('short'), '"short"')
    assert.equal(quoteText('x'.repeat(300)), `"${'x'.repeat(200)}"…`)
    assert.equal(shorten('y'.repeat(201)), `${'y'.repeat(200)}…`)
    assert.equal(formatValue('text'), "'text'")
    assert.equal(formatValue({ a: [1, 2] }), '{ a: [ 1, 2 ] }')
  })
})
