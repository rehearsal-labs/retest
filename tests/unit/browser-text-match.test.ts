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
