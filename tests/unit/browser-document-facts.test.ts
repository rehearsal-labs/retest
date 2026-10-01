import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pageFactsOf } from '../../src/browser/document-facts.ts'

test('page facts keep the origin and path of the address, and the title as readPageTitle cleans it', () => {
  assert.deepEqual(pageFactsOf({ href: 'https://user:pass@app.test/done?order=7#top', title: '  Order\u001b[2J placed ' }), {
    url: 'https://app.test/done',
    title: 'Order[2J placed',
  })
  assert.deepEqual(pageFactsOf({ href: 'about:blank', title: '' }), { url: 'about:blank' })
  assert.deepEqual(pageFactsOf({ href: 'data:text/html,<p>secret</p>', title: '\u0000 \t' }), { url: 'data:' })
})

// The parent cuts a title only after it has redacted it, so the browser hands a long title over whole.
test('a title longer than Retest records reaches the parent whole, up to 4096 code units', () => {
  const title = `${'a'.repeat(305)} hunter2`
  assert.deepEqual(pageFactsOf({ href: 'https://app.test/', title }), { url: 'https://app.test/', title })
  assert.equal(pageFactsOf({ href: 'https://app.test/', title: 'b'.repeat(5000) }).title, 'b'.repeat(4096))
})

test('an address that is not a URL is an error of Retest, not a fact', () => {
  assert.throws(() => pageFactsOf({ href: 'not a url', title: 'x' }), /not a URL/)
})
