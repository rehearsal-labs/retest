import type { PageFacts } from '../../src/protocol/page-facts.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { navigationCauseSchema, pageFactsSchema, pageTitleLimit, readPageTitle, readTitleLimit, recordedTitle } from '../../src/protocol/page-facts.ts'
import { parse } from '../../src/protocol/schema.ts'

describe('readPageTitle: a title as the browser hands it to the parent', () => {
  test('keeps an ordinary title as it is', () => {
    assert.equal(readPageTitle('Checkout · Shop'), 'Checkout · Shop')
    assert.equal(readPageTitle('Größe: 42 — 中文 😀'), 'Größe: 42 — 中文 😀')
  })

  // A title reaches terminals and reports, so nothing in it may move a cursor or start an escape sequence.
  test('removes every control character, C0, DEL and C1 alike, and keeps the rest of the text', () => {
    assert.equal(readPageTitle('Saved\u001b[2J'), 'Saved[2J')
    assert.equal(readPageTitle('a\u0000b\u0007c\u007fd\u0080e\u009bf'), 'abcdef')
    assert.equal(readPageTitle('Line one\nLine two\tend\r'), 'Line oneLine twoend')
  })

  test('trims both ends, after the control characters are gone', () => {
    assert.equal(readPageTitle('   Tasks  '), 'Tasks')
    assert.equal(readPageTitle('\u0007 Tasks \u001b'), 'Tasks')
    assert.equal(readPageTitle(' Tasks '), 'Tasks')
    assert.equal(readPageTitle('Two  spaces   inside'), 'Two  spaces   inside')
  })

  // The parent redacts a title before it cuts it to the length it records, so the browser keeps far more than that.
  test(`keeps a title past the ${pageTitleLimit} code units Retest records, and cuts it only at ${readTitleLimit}, never inside a surrogate pair`, () => {
    assert.equal(readTitleLimit, 4096)
    assert.equal(readPageTitle('x'.repeat(301)), 'x'.repeat(301))
    assert.equal(readPageTitle('x'.repeat(4096)), 'x'.repeat(4096))
    assert.equal(readPageTitle('x'.repeat(5000)), 'x'.repeat(4096))
    assert.equal(readPageTitle(`${'x'.repeat(4095)}😀`), 'x'.repeat(4095))
    assert.equal(readPageTitle(`${'x'.repeat(4094)}😀y`), `${'x'.repeat(4094)}😀`)
    assert.equal(readPageTitle(`${'x'.repeat(4095)} yz`), 'x'.repeat(4095))
    assert.equal(readPageTitle(`\u0007${'x'.repeat(4096)}`), 'x'.repeat(4096))
  })

  test('a title that leaves nothing is none', () => {
    for (const title of ['', '   ', '\u0000\u001b', ' \n\t ']) assert.equal(readPageTitle(title), undefined, JSON.stringify(title))
  })
})

describe('recordedTitle: a title as Retest records it, once the parent has redacted it', () => {
  test('keeps a title of up to the limit as it is', () => {
    assert.equal(recordedTitle('Signed in as {{password}}'), 'Signed in as {{password}}')
    assert.equal(recordedTitle('x'.repeat(300)), 'x'.repeat(300))
  })

  test(`cuts a long title to ${pageTitleLimit} code units, never inside a surrogate pair, and never ends on a space`, () => {
    assert.equal(pageTitleLimit, 300)
    assert.equal(recordedTitle('x'.repeat(301)), 'x'.repeat(300))
    assert.equal(recordedTitle(`${'x'.repeat(299)}😀`), 'x'.repeat(299))
    assert.equal(recordedTitle(`${'x'.repeat(298)}😀y`), `${'x'.repeat(298)}😀`)
    assert.equal(recordedTitle(`${'x'.repeat(299)} yz`), 'x'.repeat(299))
  })
})

describe('page facts and causes as the protocol carries them', () => {
  test('page facts carry an address, and a title only when the page has one', () => {
    const facts: PageFacts[] = [{ url: 'http://127.0.0.1:4173/' }, { url: 'http://127.0.0.1:4173/done', title: 'Done' }]
    for (const value of facts) assert.deepEqual(parse(pageFactsSchema, JSON.parse(JSON.stringify(value))), { ok: true, value })
    assert.equal(parse(pageFactsSchema, { title: 'Done' }).ok, false)
    assert.equal(parse(pageFactsSchema, { url: 'http://127.0.0.1:4173/', title: 'Done', pageUrl: 'x' }).ok, false)
  })

  test('a navigation is started by goto, by an action, or by the page', () => {
    for (const cause of ['goto', 'action', 'page']) assert.equal(parse(navigationCauseSchema, cause).ok, true, cause)
    assert.deepEqual(parse(navigationCauseSchema, 'redirect'), {
      ok: false,
      issues: [{ path: '$', message: 'expected one of "goto", "action", "page", received "redirect"' }],
    })
  })
})
