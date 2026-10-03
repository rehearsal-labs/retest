import assert from 'node:assert/strict'
import { test } from 'node:test'
import { textMatchHelper } from '../../src/browser/page-scripts.ts'
import { matchesText } from '../../src/browser/text-match.ts'

// [text, wanted, exact, matches]
const cases: [string, string, boolean, boolean][] = [
  ['Save', 'Save', true, true],
  ['Save', 'save', true, false],
  ['Save draft', 'Save', true, false],
  ['  Save \n\t draft  ', 'Save draft', true, true],
  ['Save draft', '  Save   draft ', true, true],
  ['Save draft', 'Save draft', true, true],
  ['Save draft', 'save', false, true],
  ['Save draft', 'DRAFT', false, true],
  ['Save  draft', 'e d', false, true],
  ['Save draft', 'Save  draft', false, true],
  ['Save', 'Save draft', false, false],
  ['', '', true, true],
  ['   ', '', true, true],
  ['anything', '', false, true],
  ['anything', '', true, false],
  ['Straße', 'STRASSE', false, false],
  ['Émile', 'émile', false, true],
]

// The page's own copy of the rule, compiled as the isolated world compiles it.
function pageMatches(text: string, wanted: string, exact: boolean): unknown {
  const make: unknown = new Function(`${textMatchHelper}\nreturn textMatcher`)()
  assert.ok(typeof make === 'function')
  const matches: unknown = Reflect.apply(make, undefined, [wanted, exact])
  assert.ok(typeof matches === 'function')
  return Reflect.apply(matches, undefined, [text])
}

test('text matches with the ends trimmed and whitespace collapsed: whole and case-sensitive, or any part in any case', () => {
  for (const [text, wanted, exact, expected] of cases) {
    assert.equal(matchesText(text, wanted, exact), expected, JSON.stringify({ text, wanted, exact }))
  }
})

test('the page applies the same rule to text as Retest applies to accessible names', () => {
  for (const [text, wanted, exact, expected] of cases) {
    assert.equal(pageMatches(text, wanted, exact), expected, JSON.stringify({ text, wanted, exact }))
  }
})

// [text, pattern, flags, matches]: a pattern searches the trimmed text, spaces collapsed, with its own flags.
const patterns: [string, string, string, boolean][] = [
  ['  Save\n draft ', '^Save draft$', '', true],
  ['Save draft', '^save', '', false],
  ['Save draft', '^save', 'i', true],
  ['Saved 12 tasks', '\\d+ tasks', '', true],
  ['Saved', 'Saved', 'g', true],
  ['Émile', 'émile', 'iu', true],
  ['abc', 'b', 'y', false],
]

test('a pattern matches the same in Retest and in the page, and a g or y flag carries no position from one text to the next', () => {
  const make: unknown = new Function(`${textMatchHelper}\nreturn textMatcher`)()
  assert.ok(typeof make === 'function')
  for (const [text, pattern, flags, expected] of patterns) {
    const wanted = { pattern, flags }
    assert.equal(matchesText(text, wanted, true), expected, JSON.stringify({ text, pattern, flags }))
    const matches: unknown = Reflect.apply(make, undefined, [wanted, true])
    assert.ok(typeof matches === 'function')
    assert.equal(Reflect.apply(matches, undefined, [text]), expected, `page: ${JSON.stringify({ text, pattern, flags })}`)
    assert.equal(Reflect.apply(matches, undefined, [text]), expected, `page, again: ${JSON.stringify({ text, pattern, flags })}`)
  }
})
