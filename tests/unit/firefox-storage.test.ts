import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { firefoxCookieParam, restoreFirefoxState, storedFirefoxCookie } from '../../src/browser/firefox/storage.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

test('restoring several cookies consumes one deadline rather than giving every cookie a fresh budget', async (t) => {
  const endpoint = await ScriptedBidi.start()
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
  t.after(async () => { client.close(); await endpoint.close() })
  let cookies = 0
  endpoint.on('storage.setCookie', async () => {
    cookies += 1
    if (cookies > 1) return 'silent'
    await new Promise((resolve) => setTimeout(resolve, 80))
    return { result: {} }
  })
  const cookie = { name: 'setting', value: 'value', domain: 'app.test', path: '/', expires: -1, httpOnly: false, secure: false }
  const startedAt = performance.now()
  await assert.rejects(restoreFirefoxState(client, 'user', { cookies: [cookie, { ...cookie, name: 'other' }], origins: [] }, new Deadline(100)))
  assert.ok(performance.now() - startedAt < 150, 'cookie restoration never receives another full command budget')
})

test('a cookie Firefox reports is saved as saved state keeps it: no expiry is a session cookie, and same-site in Chrome spelling', () => {
  assert.deepEqual(storedFirefoxCookie({ name: 'session', value: { type: 'string', value: 'k3' }, domain: 'app.test', path: '/', httpOnly: true, secure: true, sameSite: 'lax' }), {
    name: 'session', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
  })
  assert.deepEqual(storedFirefoxCookie({ name: 'theme', value: { type: 'string', value: 'dark' }, domain: '.app.test', path: '/', expiry: 1791154894, httpOnly: false, secure: false, sameSite: 'none' }), {
    name: 'theme', value: 'dark', domain: '.app.test', path: '/', expires: 1791154894, httpOnly: false, secure: false, sameSite: 'None',
  })
})

test('a cookie Firefox reports as bytes is refused, never saved as something else', () => {
  assert.throws(() => storedFirefoxCookie({ name: 'blob', value: { type: 'base64', value: 'AAE=' }, domain: 'app.test', path: '/', httpOnly: false, secure: false }), (error: unknown) => error instanceof BrowserError && error.failure.class === 'unsupported' && !error.message.includes('AAE='))
})

test('a saved cookie is set again as BiDi takes it, a session cookie without expiry', () => {
  assert.deepEqual(firefoxCookieParam({ name: 'session', value: 'k3', domain: 'app.test', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Strict' }), {
    name: 'session', value: { type: 'string', value: 'k3' }, domain: 'app.test', path: '/', httpOnly: true, secure: true, sameSite: 'strict',
  })
  assert.deepEqual(firefoxCookieParam({ name: 'theme', value: 'dark', domain: '.app.test', path: '/', expires: 1791154894.6, httpOnly: false, secure: false }), {
    name: 'theme', value: { type: 'string', value: 'dark' }, domain: '.app.test', path: '/', httpOnly: false, secure: false, expiry: 1791154894,
  })
})
