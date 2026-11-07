import type { PageNavigation } from '../../src/browser/contract.ts'
import type { PopupEnd } from '../../src/browser/popups.ts'
import type { FirefoxPopupOpener, FirefoxPopupPage } from '../../src/browser/firefox/popups.ts'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxPagePopups, FirefoxPopupWatch } from '../../src/browser/firefox/popups.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The pages a Firefox page opens, over a scripted BiDi endpoint: which page of the user context each new browsing
// context goes to, and how a wait for one settles.

let endpoint: ScriptedBidi
let client: BidiClient

before(async () => {
  endpoint = await ScriptedBidi.start()
  client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
})

after(async () => {
  client.close()
  await endpoint.close()
})

async function settle(): Promise<void> {
  endpoint.accept('session.status')
  await client.send('session.status', {})
}

function created(context: string, parent: string | null, originalOpener: string | null, userContext = 'user-1'): void {
  endpoint.emit('browsingContext.contextCreated', { context, parent, originalOpener, userContext, url: 'about:blank', children: null, clientWindow: 'w' })
}

// A page made for a popup, which tells the navigations the test hands it and ends when the test says.
function standIn(context: string): FirefoxPopupPage & { navigate(navigation: PageNavigation): void; end(end: PopupEnd): void } {
  const listeners = new Set<(navigation: PageNavigation) => void>()
  const ended = Promise.withResolvers<PopupEnd>()
  let closedItself = false
  const unused = (): never => assert.fail(`the stand-in for ${context} was asked for something its test never gives`)
  return {
    ended: ended.promise,
    get closedItself() {
      return closedItself
    },
    navigate: (navigation) => {
      for (const listener of listeners) listener(navigation)
    },
    end: (end) => {
      closedItself = end.kind === 'closed'
      ended.resolve(end)
    },
    onNavigation: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    url: undefined,
    dispose: async () => undefined,
    execute: unused,
    dispatch: unused,
    screenshot: unused,
    readPage: unused,
    captureState: unused,
  }
}

test('a new browsing context goes to the page that opened it, or whose frame did, and a window with no opener, or of another user context, to none', async () => {
  const watch = new FirefoxPopupWatch(client, 'user-1', (error) => assert.fail(String(error)))
  const claimed: string[] = []
  const opener = (name: string): FirefoxPopupOpener => ({ claim: (context) => claimed.push(`${name} ${context}`) })
  watch.register('tab-1', opener('tab-1'))
  const stop = watch.register('popup-1', opener('popup-1'))
  created('frame-1', 'tab-1', null)
  created('frame-2', 'frame-1', null)
  created('popup-1', null, 'tab-1')
  created('popup-2', null, 'frame-2')
  created('popup-3', null, 'popup-1')
  created('window-9', null, null)
  created('theirs', null, 'tab-1', 'user-2')
  await settle()
  stop()
  created('popup-4', null, 'popup-1')
  await settle()
  assert.deepEqual(claimed, ['tab-1 popup-1', 'tab-1 popup-2', 'popup-1 popup-3'])
  watch.dispose()
})

test('a wait is given the next page the page opens, with its navigations from the first, and how it ends', async () => {
  const watch = new FirefoxPopupWatch(client, 'user-1', () => {})
  const made: ReturnType<typeof standIn>[] = []
  const popups = new FirefoxPagePopups({ watch, context: 'tab-1', open: (context) => (made[made.length] = standIn(context)), onListenerError: (error) => assert.fail(String(error)) })
  // A page opened while nothing waits gets a page all the same, and is no popup of a later wait.
  popups.claim('early', 'about:blank')
  const arming = popups.arm({ timeoutMs: 2000, setupMs: 1000 })
  assert.ok(arming.ok)
  assert.deepEqual(popups.arm({ timeoutMs: 2000, setupMs: 1000 }), { ok: false, failure: { class: 'usage', message: 'page.popup() is already waiting for a page on this page. Await it before the next one.' } })
  popups.claim('popup-1', 'about:blank')
  const wait = await arming.opened
  assert.ok(wait.ok)
  assert.equal(made.length, 2)
  const page = made[1]
  assert.ok(page !== undefined && wait.popup.page === page)
  const navigation: PageNavigation = { url: 'http://127.0.0.1/help', title: Promise.resolve('Help'), cause: 'page', document: 'new' }
  const first = wait.popup.first(2000)
  page.navigate(navigation)
  assert.equal(await first, navigation)
  const heard: PageNavigation[] = []
  wait.popup.follow((told) => heard.push(told))
  assert.deepEqual(heard, [navigation], 'a listener added later hears the navigations told before it')
  assert.equal(wait.popup.closed(), false)
  page.end({ kind: 'closed' })
  assert.deepEqual(await wait.popup.gone, { kind: 'closed' })
  assert.equal(wait.popup.closed(), true)
  watch.dispose()
})

test('a wait fails when its time runs out, when its signal aborts with a reason, and when its page goes', async () => {
  const watch = new FirefoxPopupWatch(client, 'user-1', () => {})
  const popups = new FirefoxPagePopups({ watch, context: 'tab-1', open: standIn, onListenerError: () => {} })
  const timed = popups.arm({ timeoutMs: 50, setupMs: 1000 })
  assert.ok(timed.ok)
  assert.deepEqual(await timed.opened, { ok: false, failure: { class: 'timeout', message: 'No page opened within 50 ms.' } })
  const stop = new AbortController()
  const stopped = popups.arm({ timeoutMs: 2000, setupMs: 1000, signal: stop.signal })
  assert.ok(stopped.ok)
  stop.abort({ class: 'interrupted', message: 'The action failed before a page opened.' })
  assert.deepEqual(await stopped.opened, { ok: false, failure: { class: 'interrupted', message: 'The action failed before a page opened.' } })
  const going = popups.arm({ timeoutMs: 2000, setupMs: 1000 })
  assert.ok(going.ok)
  popups.lost('the page was closed')
  assert.deepEqual(await going.opened, { ok: false, failure: { class: 'session_lost', message: 'The page went away before it opened another page: the page was closed.' } })
  assert.deepEqual(popups.arm({ timeoutMs: 2000, setupMs: 1000 }), { ok: false, failure: { class: 'session_lost', message: 'The page went away before it opened another page: the page was closed.' } })
  watch.dispose()
})
