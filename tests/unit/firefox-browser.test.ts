import type { FirefoxProcessHandle } from '../../src/browser/firefox/browser.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxBrowser, refusedOptions } from '../../src/browser/firefox/browser.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

test('a Firefox page takes a viewport and pixel ratio, and refuses a proxy, touch, mobile layout or user agent by name', () => {
  const viewport = { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, touch: false, isMobile: false }
  assert.equal(refusedOptions({ emulation: viewport }), undefined)
  assert.equal(refusedOptions({ emulation: { ...viewport, deviceScaleFactor: 2.625 } }), undefined)
  assert.equal(refusedOptions({}), undefined)
  const proxied = refusedOptions({ proxy: { server: 'http://127.0.0.1:8080', bypass: [] } })
  assert.equal(proxied?.class, 'unsupported')
  assert.match(proxied?.message ?? '', /ignores the proxy of a user context/)
  const phone = refusedOptions({ emulation: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, touch: true, isMobile: true, userAgent: 'Mozilla/5.0 (Linux; Android 10)' } })
  assert.equal(phone?.class, 'unsupported')
  assert.equal(phone?.message, 'Firefox cannot emulate a touch screen, a mobile layout, another user agent through WebDriver BiDi in the release Retest drives. A Firefox target takes a viewport, and no device.')
})

// Firefox answered `browsingContext.create` with `unknown error` once in a conformance run: a window that may or may
// not exist. The page opening asks for it once, names the failure, and removes the user context, which takes with it
// any window the first request left.
test('a window Firefox could not open fails the page by name, asked for once, and the user context is removed', async (t) => {
  const endpoint = await ScriptedBidi.start()
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
  t.after(async () => {
    client.close()
    await endpoint.close()
  })
  endpoint.on('browser.createUserContext', () => ({ result: { userContext: 'user-context-1' } }))
  endpoint.accept('browser.removeUserContext')
  endpoint.on('browsingContext.create', () => ({ error: 'unknown error', message: 'Error: window went away' }))
  const browser = await openedBrowser(client)
  const failed = await browser.newPage({}, 2000).catch((error: unknown) => error)
  assert.ok(failed instanceof BrowserError)
  assert.equal(failed.failure.class, 'setup_failed')
  assert.equal(failed.failure.message, 'Firefox could not open a window for the page, and answered "unknown error: Error: window went away". Retest did not ask again, so no second window was opened.')
  assert.equal(endpoint.commands('browsingContext.create').length, 1, 'the window is asked for once')
  assert.deepEqual(endpoint.commands('browser.removeUserContext').map((command) => command.params['userContext']), ['user-context-1'])
})

test('a window Firefox never answers for fails the page within its budget, asked for once, and the user context is removed', async (t) => {
  const endpoint = await ScriptedBidi.start()
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 30_000, onDiagnostic: () => {} })
  t.after(async () => {
    client.close()
    await endpoint.close()
  })
  endpoint.on('browser.createUserContext', () => ({ result: { userContext: 'user-context-2' } }))
  endpoint.accept('browser.removeUserContext')
  endpoint.on('browsingContext.create', () => 'silent')
  const browser = await openedBrowser(client)
  const startedAt = performance.now()
  const failed = await browser.newPage({}, 300).catch((error: unknown) => error)
  assert.ok(performance.now() - startedAt < 2000, 'bounded by the page budget, not the connection default')
  assert.ok(failed instanceof BrowserError)
  assert.equal(failed.failure.class, 'setup_failed')
  assert.match(failed.failure.message, /^Firefox did not open a window for the page within the page's command budget\. Retest did not ask again, so no second window was opened\.$/)
  assert.equal(endpoint.commands('browsingContext.create').length, 1)
  await new Promise((resolve) => setTimeout(resolve, 25))
  assert.deepEqual(endpoint.commands('browser.removeUserContext').map((command) => command.params['userContext']), ['user-context-2'])
})

// A process stand-in that never ends: the runtime only reads it here.
async function openedBrowser(client: BidiClient): Promise<FirefoxBrowser> {
  const never = new Promise<never>(() => {})
  const process: FirefoxProcessHandle = { pid: 4242, route: 'spawn', outputSettled: Promise.resolve(), gone: () => never, exited: never, recordDescendants: async () => {}, expectExit: () => {}, stop: async () => [] }
  const facts = { sessionId: 'session', browserName: 'firefox', browserVersion: '133.0.3', buildId: '20241209150345', platformName: 'mac', processId: 4242, profile: '/profile', headless: true, userAgent: 'Mozilla/5.0 Firefox/133.0' }
  return FirefoxBrowser.open({ process, client, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox', facts, onListenerError: () => {} }, new Deadline(2000))
}

test('Firefox close forwards one existing deadline through descendant capture and process cleanup', async (t) => {
  const endpoint = await ScriptedBidi.start()
  endpoint.accept('browser.close')
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
  t.after(async () => { client.close(); await endpoint.close() })
  const seen: (Deadline | undefined)[] = []
  const never = new Promise<never>(() => {})
  const process: FirefoxProcessHandle = {
    pid: 4242, route: 'spawn', outputSettled: Promise.resolve(), gone: () => never, exited: never,
    recordDescendants: async (deadline) => { seen.push(deadline) }, expectExit: () => {},
    stop: async (_graceMs, deadline) => { seen.push(deadline); return [] },
  }
  const facts = { sessionId: 'session', browserName: 'firefox', browserVersion: '133.0.3', buildId: '20241209150345', platformName: 'mac', processId: 4242, profile: '/profile', headless: true, userAgent: 'Mozilla/5.0 Firefox/133.0' }
  const browser = await FirefoxBrowser.open({ process, client, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox', facts, onListenerError: () => {} }, new Deadline(2000))
  await browser.close(500)
  assert.equal(seen.length, 2)
  assert.ok(seen[0] instanceof Deadline)
  assert.equal(seen[0].budgetMs, 500)
  assert.equal(seen[1], seen[0], 'cleanup keeps the original budget rather than starting another')
})
