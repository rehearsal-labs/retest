import type { StoredCookie } from '../../src/protocol/storage-state.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { cookieParam, readCookies, storedCookie, webOrigin } from '../../src/browser/storage-state.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { scriptedSession } from './browser-fixtures.ts'

const session: StoredCookie = { name: 'session', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' }

// What Chrome reports beside a cookie, which saved state leaves out.
const reported = { size: 8, session: true, priority: 'Medium', sourceScheme: 'Secure', sourcePort: 443 }

test('a cookie keeps only what saved state records', () => {
  assert.deepEqual(storedCookie({ ...session, ...reported }), session)
})

test('a SameSite value Chrome reports that saved state does not know is left out', () => {
  const unset = { name: 'session', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true }
  assert.deepEqual(storedCookie({ ...session, sameSite: 'Unspecified' }), unset)
  assert.deepEqual(storedCookie(unset), unset)
})

test('reading cookies asks for the whole context and leaves out partitioned ones', async () => {
  const partitioned = { ...session, name: 'embedded', partitionKey: { topLevelSite: 'https://other.test', hasCrossSiteAncestor: true } }
  const browser = scriptedSession(() => Promise.resolve({ cookies: [{ ...session, ...reported }, partitioned] }))
  const cookies = await readCookies(browser.session, 'C1', new Deadline(1000))
  assert.deepEqual(cookies, [session])
  assert.deepEqual(browser.sent, [{ method: 'Storage.getCookies', params: { browserContextId: 'C1' } }])
})

test('a host-only cookie is set again through a URL, which keeps it host-only', () => {
  assert.deepEqual(cookieParam(session), {
    name: 'session',
    value: 'k3',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    url: 'https://app.test/',
  })
  const plain = cookieParam({ ...session, secure: false, path: '/account' })
  assert.equal('url' in plain ? plain.url : undefined, 'http://app.test/account')
})

test('a domain cookie is set again through its domain, and a persistent one keeps its expiry', () => {
  const persistent = { ...session, domain: '.app.test', expires: 1_900_000_000.5 }
  const param = cookieParam(persistent)
  assert.equal('url' in param, false)
  assert.deepEqual(param, { name: 'session', value: 'k3', path: '/', httpOnly: true, secure: true, sameSite: 'Lax', domain: '.app.test', expires: 1_900_000_000.5 })
})

test('a session cookie is set again without an expiry', () => {
  assert.equal('expires' in cookieParam(session), false)
})

test('saved state may name only http and https origins, written exactly as an origin', () => {
  assert.equal(webOrigin('http://127.0.0.1:4173'), 'http://127.0.0.1:4173')
  assert.equal(webOrigin('https://app.test'), 'https://app.test')
  for (const origin of ['file:///tmp', 'about:blank', 'not a url', 'https://app.test/', 'https://app.test/path', 'HTTPS://APP.TEST', '']) {
    assert.throws(
      () => webOrigin(origin),
      (error) => error instanceof BrowserError && error.failure.class === 'setup_failed' && error.message.includes(JSON.stringify(origin)),
      origin,
    )
  }
})
