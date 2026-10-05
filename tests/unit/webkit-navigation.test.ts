import type { FrameEvent, WebKitNavigationContext } from '../../src/browser/webkit/navigation.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { CdpProtocolError } from '../../src/browser/cdp/errors.ts'
import { Dispatch } from '../../src/browser/dispatch.ts'
import { navigate, navigationFailed, reload, traverse } from '../../src/browser/webkit/navigation.ts'
import { Deadline } from '../../src/protocol/deadline.ts'

/** A page whose main frame events a test tells, and whose commands answer as the test says. */
function fakePage(options: { navigate?: () => Promise<unknown>; history?: () => Promise<'sent' | 'no_entry'>; baseUrl?: string } = {}) {
  const listeners = new Set<(event: FrameEvent) => void>()
  let url: URL | undefined
  const opened: string[] = []
  const context: WebKitNavigationContext = {
    baseUrl: options.baseUrl,
    currentUrl: () => url,
    onFrameEvent: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    stopped: () => undefined,
    navigate: () => (options.navigate ?? (async () => ({ loaderId: 'L1' })))(),
    history: () => (options.history ?? (async () => 'sent' as const))(),
    opened: (loaderId) => opened.push(loaderId),
  }
  const tell = async (event: FrameEvent, at?: string) => {
    await nextTurn()
    if (at !== undefined) url = new URL(at)
    for (const listener of [...listeners]) listener(event)
  }
  return { context, tell, opened }
}

test('goto waits for the load of the document its loader committed, and answers with origin and path', { timeout: 10_000 }, async () => {
  const page = fakePage({ baseUrl: 'http://app.test' })
  const result = navigate(page.context, '/tasks?token=secret', new Deadline(2000), new Dispatch())
  await page.tell({ kind: 'committed', loaderId: 'L1' }, 'http://app.test/tasks?token=secret')
  await page.tell({ kind: 'loaded', loaderId: 'L1' })
  assert.deepEqual(await result, { ok: true, kind: 'goto', url: 'http://app.test/tasks' })
  assert.deepEqual(page.opened, ['L1'])
})

test('a document that replaced the one goto opened before it loaded counts once it loads itself', { timeout: 10_000 }, async () => {
  const page = fakePage()
  const result = navigate(page.context, 'http://app.test/start', new Deadline(2000), new Dispatch())
  await page.tell({ kind: 'committed', loaderId: 'L1' }, 'http://app.test/start')
  await page.tell({ kind: 'committed', loaderId: 'L2' }, 'http://app.test/final')
  await page.tell({ kind: 'loaded', loaderId: 'L1' })
  await nextTurn()
  await page.tell({ kind: 'loaded', loaderId: 'L2' })
  assert.deepEqual(await result, { ok: true, kind: 'goto', url: 'http://app.test/final' })
})

test("a navigation WebKit gives up fails with WebKit's own words, one full stop, and the address without its query", { timeout: 10_000 }, async () => {
  const page = fakePage()
  const result = navigate(page.context, 'http://127.0.0.1:1/?token=secret', new Deadline(2000), new Dispatch())
  await page.tell({ kind: 'given_up', loaderId: 'L1', url: 'http://127.0.0.1:1/?token=secret', error: 'Could not connect to the server.' })
  assert.deepEqual(await result, { ok: false, failure: { class: 'not_actionable', message: 'Could not open http://127.0.0.1:1/: Could not connect to the server.', details: { url: 'http://127.0.0.1:1/', errorText: 'Could not connect to the server.' } } })
  assert.deepEqual(navigationFailed(new URL('http://a.test/x'), 'Not allowed to use restricted network port').message, 'Could not open http://a.test/x: Not allowed to use restricted network port.')
})

test("goto to a place in the document is done once the browser reports the move, and Playwright.navigate's refusal is a navigation failure", { timeout: 10_000 }, async () => {
  const page = fakePage({ navigate: async () => ({}) })
  const result = navigate(page.context, 'http://app.test/#details', new Deadline(2000), new Dispatch())
  await page.tell({ kind: 'within' }, 'http://app.test/#details')
  assert.deepEqual(await result, { ok: true, kind: 'goto', url: 'http://app.test/' })
  const refused = fakePage({ navigate: async () => { throw new CdpProtocolError({ method: 'Playwright.navigate', sessionId: undefined }, { code: -32000, message: 'Cannot navigate to invalid URL', data: undefined }) } })
  const failure = await navigate(refused.context, 'http://app.test/', new Deadline(2000), new Dispatch())
  assert.deepEqual(failure, { ok: false, failure: { class: 'not_actionable', message: 'Could not open http://app.test/: Cannot navigate to invalid URL.', details: { url: 'http://app.test/', errorText: 'Cannot navigate to invalid URL' } } })
})

test('a page that never loads times out naming the address, and a page that stops answering ends the wait at once', { timeout: 10_000 }, async () => {
  const page = fakePage()
  const timed = await navigate(page.context, 'http://app.test/hang?q=1', new Deadline(60), new Dispatch())
  assert.deepEqual(timed, { ok: false, failure: { class: 'timeout', message: 'http://app.test/hang did not finish loading within 60 ms.', details: { url: 'http://app.test/hang' } } })
  const held = fakePage()
  const result = navigate(held.context, 'http://app.test/', new Deadline(5000), new Dispatch())
  await held.tell({ kind: 'stopped', reason: 'a JavaScript confirm dialog holds the page' })
  const answer = await result
  assert.equal(answer.ok, false)
  assert.equal(answer.ok ? '' : answer.failure.class, 'outcome_unknown')
})

test('addresses other than http and https, and relative ones with no base URL, are refused before anything is sent', { timeout: 10_000 }, async () => {
  const page = fakePage({ navigate: async () => assert.fail('nothing may be sent') })
  const data = await navigate(page.context, 'data:text/html,hi', new Deadline(1000), new Dispatch())
  assert.deepEqual(data, { ok: false, failure: { class: 'unsupported', message: 'goto opens http and https addresses, not data: ones.' } })
  const relative = await navigate(page.context, '/tasks', new Deadline(1000), new Dispatch())
  assert.deepEqual(relative, { ok: false, failure: { class: 'usage', message: 'goto("/tasks") needs a full URL, because no base URL was given.' } })
})

test('a reload or a move through the history that the browser gives up fails naming the address it was going to, with the request sent', { timeout: 10_000 }, async () => {
  const page = fakePage()
  const result = reload(page.context, new Deadline(2000), new Dispatch())
  await page.tell({ kind: 'given_up', loaderId: 'L9', url: 'http://app.test/flip?for=reload', error: 'Frame load interrupted' })
  assert.deepEqual(await result, {
    ok: false,
    failure: { class: 'not_actionable', message: 'Could not reload http://app.test/flip: the browser sent the request and gave the navigation up without opening a document, as it does for a response with no content or a download. The page stayed on the page.', details: { url: 'http://app.test/flip', inputSent: true } },
  })
  const back = fakePage()
  const moved = traverse(back.context, 'goBack', new Deadline(2000), new Dispatch())
  await back.tell({ kind: 'committed', loaderId: 'L3' }, 'http://app.test/earlier')
  await back.tell({ kind: 'loaded', loaderId: 'L3' })
  assert.deepEqual(await moved, { ok: true, kind: 'goBack', url: 'http://app.test/earlier' })
})

test('a move WebKit refuses for want of an entry changed nothing, and says so', { timeout: 10_000 }, async () => {
  const page = fakePage({ history: async () => 'no_entry' })
  assert.deepEqual(await traverse(page.context, 'goForward', new Deadline(1000), new Dispatch()), {
    ok: false,
    failure: { class: 'not_actionable', message: 'Could not go forward: the page has no later entry in its history, so nothing happened.' },
  })
})
