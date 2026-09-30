import type { NavigationContext } from '../../src/browser/navigation.ts'
import type { ScriptedSession } from './browser-fixtures.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpAbortedError } from '../../src/browser/cdp/errors.ts'
import { Dispatch } from '../../src/browser/dispatch.ts'
import { navigate } from '../../src/browser/navigation.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { scriptedSession } from './browser-fixtures.ts'

const origin = 'http://app.test'
const mainFrame = 'F1'

type Browser = ScriptedSession & { context: NavigationContext }

/** An event from the browser, and the main frame address it moves the page to, if any. */
type BrowserEvent = { method: string; params: object; address?: string }

/**
 * A page whose browser answers `Page.navigate` with `answer` and then sends `events`, as Chrome does. The page
 * takes each event's address before the navigation hears of it, as `ChromiumPage` does.
 */
function browserThatNavigates(answer: object, events: BrowserEvent[], proxyServer?: string): Browser {
  let current = new URL(`${origin}/`)
  const scripted = scriptedSession(async (method) => {
    if (method !== 'Page.navigate') return {}
    setImmediate(() => {
      for (const { method: event, params, address } of events) {
        if (address !== undefined) current = new URL(address)
        scripted.emit(event, params)
      }
    })
    return answer
  })
  const context = { session: scripted.session, baseUrl: origin, mainFrameId: () => mainFrame, currentUrl: () => current, proxyServer }
  return { ...scripted, context }
}

function committed(loaderId: string, path: string): BrowserEvent {
  const address = `${origin}${path}`
  return { method: 'Page.frameNavigated', params: { frame: { id: mainFrame, loaderId, url: address } }, address }
}

function committedInFrame(loaderId: string, path: string): BrowserEvent {
  return { method: 'Page.frameNavigated', params: { frame: { id: 'F2', parentId: mainFrame, loaderId, url: `${origin}${path}` } } }
}

function movedWithinDocument(frameId: string, path: string): BrowserEvent {
  const address = `${origin}${path}`
  const params = { frameId, url: address, navigationType: 'fragment' }
  return frameId === mainFrame ? { method: 'Page.navigatedWithinDocument', params, address } : { method: 'Page.navigatedWithinDocument', params }
}

function loaded(loaderId: string): BrowserEvent {
  return { method: 'Page.lifecycleEvent', params: { frameId: mainFrame, loaderId, name: 'load', timestamp: 1 } }
}

function goto({ context }: Browser, url: string, budgetMs = 1000) {
  return navigate(context, url, new Deadline(budgetMs), new Dispatch())
}

test('a navigation within the document answers with the address the browser reports after its answer', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame }, [movedWithinDocument(mainFrame, '/tasks#top')])
  assert.deepEqual(await goto(browser, '/tasks#top'), { ok: true, kind: 'goto', url: `${origin}/tasks` })
})

test('a navigation within the document that the browser never reports times out at its deadline', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame }, [movedWithinDocument('F2', '/inner#top')])
  const started = performance.now()
  const result = await goto(browser, '/#top', 100)
  assert.deepEqual(result, {
    ok: false,
    failure: { class: 'timeout', message: `${origin}/ did not finish loading within 100 ms.`, details: { url: `${origin}/` } },
  })
  assert.ok(performance.now() - started < 1000)
})

test('a document is loaded when its own load event arrives', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame, loaderId: 'L1' }, [committed('L1', '/tasks'), loaded('L1')])
  assert.deepEqual(await goto(browser, '/tasks'), { ok: true, kind: 'goto', url: `${origin}/tasks` })
})

test('a document replaced before it loaded, as by a client-side redirect, is loaded when the one that replaced it loads', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame, loaderId: 'L1' }, [
    committed('L1', '/start'),
    committed('L2', '/middle'),
    committed('L3', '/final'),
    loaded('L2'),
    loaded('L3'),
  ])
  assert.deepEqual(await goto(browser, '/start'), { ok: true, kind: 'goto', url: `${origin}/final` })
})

test('a replaced document is not loaded by the load of a document it replaced in turn', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame, loaderId: 'L1' }, [
    committed('L1', '/start'),
    committed('L2', '/middle'),
    committed('L3', '/final'),
    loaded('L2'),
  ])
  const result = await goto(browser, '/start', 100)
  assert.equal(result.ok ? result.kind : result.failure.class, 'timeout')
})

test('a document that committed before this navigation did, or in a frame inside the page, is not followed', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame, loaderId: 'L1' }, [
    committed('L0', '/earlier'),
    loaded('L0'),
    committedInFrame('L9', '/inner'),
    loaded('L9'),
  ])
  const result = await goto(browser, '/start', 100)
  assert.equal(result.ok ? result.kind : result.failure.class, 'timeout')
})

test('a stopped navigation stops waiting for the load at once, and counts as sent', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame, loaderId: 'L1' }, [committed('L1', '/slow')])
  const stop = new AbortController()
  const dispatch = new Dispatch()
  const going = navigate(browser.context, '/slow', new Deadline(5000, { signal: stop.signal }), dispatch).catch((error: unknown) => error)
  setTimeout(() => stop.abort(), 20)
  const started = performance.now()
  const error = await going
  assert.ok(error instanceof CdpAbortedError && error.method === 'Page.navigate', String(error))
  assert.ok(performance.now() - started < 1000)
  assert.equal(dispatch.sent, true)
})

test('a navigation stopped before it starts is never sent', async () => {
  const browser = browserThatNavigates({ frameId: mainFrame, loaderId: 'L1' }, [])
  const stop = new AbortController()
  stop.abort()
  const dispatch = new Dispatch()
  const error = await navigate(browser.context, '/', new Deadline(5000, { signal: stop.signal }), dispatch).catch((thrown: unknown) => thrown)
  assert.ok(error instanceof CdpAbortedError, String(error))
  assert.equal(dispatch.sent, false)
  assert.deepEqual(browser.sent, [])
})

// The browser shows its error page as a document of its own, which commits and loads.
function failedWith(errorText: string, proxyServer?: string): Browser {
  const errorPage = { method: 'Page.frameNavigated', params: { frame: { id: mainFrame, loaderId: 'L1', url: 'chrome-error://chromewebdata/' } } }
  return browserThatNavigates({ frameId: mainFrame, loaderId: 'L1', errorText }, [errorPage, loaded('L1')], proxyServer)
}

test("a navigation its proxy failed is a setup failure naming the proxy, and any other failed navigation is the page's", async () => {
  const proxy = 'http://127.0.0.1:8080'
  const errors = [
    'net::ERR_PROXY_CONNECTION_FAILED',
    'net::ERR_TUNNEL_CONNECTION_FAILED',
    'net::ERR_PROXY_AUTH_UNSUPPORTED',
    'net::ERR_PROXY_CERTIFICATE_INVALID',
    'net::ERR_NO_SUPPORTED_PROXIES',
  ]
  for (const errorText of errors) {
    assert.deepEqual(await goto(failedWith(errorText, proxy), '/tasks'), {
      ok: false,
      failure: {
        class: 'setup_failed',
        message: `Could not open ${origin}/tasks through the proxy ${proxy}: ${errorText}. The proxy failed, not the app.`,
        details: { url: `${origin}/tasks`, errorText, proxy },
      },
    })
  }
  // Another error through a proxy, and a proxy error on a page with no proxy of Retest's, are the page's failure.
  const others = [
    ['net::ERR_INVALID_AUTH_CREDENTIALS', proxy],
    ['net::ERR_CONNECTION_REFUSED', proxy],
    ['net::ERR_PROXY_CONNECTION_FAILED', undefined],
  ] as const
  for (const [errorText, server] of others) {
    assert.deepEqual(
      await goto(failedWith(errorText, server), '/tasks'),
      { ok: false, failure: { class: 'not_actionable', message: `Could not open ${origin}/tasks: ${errorText}.`, details: { url: `${origin}/tasks`, errorText } } },
      errorText,
    )
  }
})
