import type { PageFacts } from '../../src/protocol/page-facts.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cleanTitle, navigationCauseSchema, navigationDocumentSchema, pageFactsSchema, pageTitleLimit, recordedTitle, titleReadLimit } from '../../src/protocol/page-facts.ts'
import { parse } from '../../src/protocol/schema.ts'

// The browser hands a title over as the page has it; the parent cleans it only once it has redacted it, so nothing
// the cleaning removes can keep a value from being found.
describe('cleanTitle: a title as the parent cleans it, after redacting it', () => {
  test('keeps an ordinary title as it is', () => {
    assert.equal(cleanTitle('Checkout · Shop'), 'Checkout · Shop')
    assert.equal(cleanTitle('Größe: 42 — 中文 😀'), 'Größe: 42 — 中文 😀')
  })

  // A title reaches terminals and reports, so nothing in it may move a cursor or start an escape sequence.
  test('removes every control character, C0, DEL and C1 alike, and keeps the rest of the text', () => {
    assert.equal(cleanTitle('Saved\u001b[2J'), 'Saved[2J')
    assert.equal(cleanTitle('a\u0000b\u0007c\u007fd\u0080e\u009bf'), 'abcdef')
    assert.equal(cleanTitle('Line one\nLine two\tend\r'), 'Line oneLine twoend')
  })

  test('trims both ends, after the control characters are gone', () => {
    assert.equal(cleanTitle('   Tasks  '), 'Tasks')
    assert.equal(cleanTitle('\u0007 Tasks \u001b'), 'Tasks')
    assert.equal(cleanTitle('Two  spaces   inside'), 'Two  spaces   inside')
  })

  test('never cuts: the parent cuts a title only once it is redacted and cleaned', () => {
    assert.equal(cleanTitle('x'.repeat(5000)), 'x'.repeat(5000))
    assert.equal(cleanTitle(`${'x'.repeat(4095)} yz`), `${'x'.repeat(4095)} yz`)
  })

  test('a title that leaves nothing is none', () => {
    for (const title of ['', '   ', '\u0000\u001b', ' \n\t ']) assert.equal(cleanTitle(title), undefined, JSON.stringify(title))
  })

  test(`the page hands over at most ${titleReadLimit} code units, far more than the ${pageTitleLimit} Retest records`, () => {
    assert.equal(titleReadLimit, 65_536)
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

  test('a navigation opens a new document, or moves within the one the frame holds', () => {
    for (const document of ['new', 'same']) assert.equal(parse(navigationDocumentSchema, document).ok, true, document)
    assert.equal(parse(navigationDocumentSchema, 'other').ok, false)
  })

  test('a navigation is started by goto, by an action, or by the page', () => {
    for (const cause of ['goto', 'action', 'page']) assert.equal(parse(navigationCauseSchema, cause).ok, true, cause)
    assert.deepEqual(parse(navigationCauseSchema, 'redirect'), {
      ok: false,
      issues: [{ path: '$', message: 'expected one of "goto", "action", "page", received "redirect"' }],
    })
  })
})
