import assert from 'node:assert/strict'
import { test } from 'node:test'
import { browserContextOptions } from '../../src/browser/browser.ts'

test('a page without a proxy gets a browser context with the machine connection', () => {
  assert.deepEqual(browserContextOptions(undefined), {})
})

test("a page's proxy is its browser context's, with the bypass rules joined as Chrome reads them", () => {
  assert.deepEqual(browserContextOptions({ server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal', 'localhost'] }), {
    proxyServer: 'http://127.0.0.1:8080',
    proxyBypassList: '<-loopback>;*.internal;localhost',
  })
  assert.deepEqual(browserContextOptions({ server: 'socks5://127.0.0.1:1080', bypass: [] }), { proxyServer: 'socks5://127.0.0.1:1080' })
})
