import type { PageNavigation } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxPage } from '../../src/browser/firefox/page.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { earlyClock } from './early-waits-clock.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The Firefox page over a scripted BiDi endpoint: what it sets up in the tab, the commands it refuses before sending
// any input, how Firefox's navigation events become a goto's answer and the page's navigation records (a response with
// no document, and a load Firefox names by the navigation that came after it), and a prompt or a closed tab ending what
// waits.

const context = 'tab-1'
let endpoint: ScriptedBidi
let client: BidiClient
let tabs = 0

before(async () => {
  endpoint = await ScriptedBidi.start()
  client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
})

after(async () => {
  client.close()
  await endpoint.close()
})

beforeEach(() => {
  endpoint.sent.length = 0
  endpoint.accept('session.subscribe', 'session.unsubscribe', 'script.removePreloadScript', 'browser.removeUserContext', 'browsingContext.setViewport')
  endpoint.on('script.addPreloadScript', () => ({ result: { script: 'preload-1' } }))
  endpoint.on('browsingContext.getTree', () => ({ result: { contexts: [{ context, url: 'about:blank', children: [], userContext: 'user-1' }] } }))
  // The tab's own script runs; every page function after it fails here, so the page reads no facts from a document,
  // which the commands under test need none of.
  endpoint.on('script.callFunction', (params) => {
    if (!String(params['functionDeclaration']).startsWith('async function retestCall')) return { result: { type: 'success', realm: 'realm', result: { type: 'undefined' } } }
    return { result: { type: 'exception', realm: 'realm', exceptionDetails: { text: 'scripted' } } }
  })
})

async function page(): Promise<FirefoxPage> {
  tabs += 1
  const opened = await FirefoxPage.open({ client, context, userContext: `user-${tabs}`, baseUrl: 'http://127.0.0.1:4173', emulation: undefined, restoredOrigins: [], onListenerError: () => {} }, new Deadline(2000))
  // The script's run in the document the tab opened with tells of that document, as Firefox's run of it would.
  documented('about:blank')
  await settle()
  return opened
}

// What the document's own script tells when it commits: the address, on the tab's channel.
function documented(url: string): void {
  endpoint.emit('script.message', { channel: `retest-documented-${context}`, data: { type: 'string', value: url }, source: { realm: 'realm', context } })
}

function navigationEvent(method: string, navigation: string, url: string): void {
  endpoint.emit(`browsingContext.${method}`, { context, navigation, timestamp: 0, url })
}

async function settle(): Promise<void> {
  endpoint.accept('session.status')
  await client.send('session.status', {})
}

describe('the Firefox page', () => {
  test('page setup commands consume one deadline instead of restarting it after subscribing', async () => {
    let subscriptions = 0
    endpoint.on('session.subscribe', async () => {
      subscriptions += 1
      if (subscriptions > 1) return 'silent'
      await new Promise((resolve) => setTimeout(resolve, 80))
      return { result: {} }
    })
    const startedAt = performance.now()
    await assert.rejects(FirefoxPage.open({ client, context, userContext: 'budget-user', baseUrl: undefined, emulation: undefined, restoredOrigins: [], onListenerError: () => {} }, new Deadline(100)))
    assert.ok(performance.now() - startedAt < 150, 'page setup never receives another full command budget')
  })

  test("follows the tab's events, and has every document run Retest's script in its sandbox before the page's own", async () => {
    const opened = await page()
    const subscribed = endpoint.commands('session.subscribe').map((command) => command.params['events'])
    assert.deepEqual(subscribed, [['browsingContext', 'script'], ['network.responseStarted']])
    const [preload] = endpoint.commands('script.addPreloadScript')
    assert.equal(preload?.params['sandbox'], 'retest')
    assert.deepEqual(preload?.params['contexts'], [context])
    assert.deepEqual(preload?.params['arguments'], [
      { type: 'channel', value: { channel: `retest-changed-${context}`, ownership: 'none' } },
      { type: 'channel', value: { channel: `retest-documented-${context}`, ownership: 'none' } },
    ])
    assert.match(String(preload?.params['functionDeclaration']), /const claimType = "retest-claim-[0-9a-f-]{36}";/, 'the tab claims its documents with an event type of its own')
    assert.match(String(preload?.params['functionDeclaration']), /retestRelays/, 'the relays the guard listens through come first')
    const [initial] = endpoint.commands('script.callFunction')
    assert.equal(initial?.params['functionDeclaration'], preload?.params['functionDeclaration'], 'the document the tab opened with runs the same script')
    await opened.dispose(1000)
  })

  test('a tap is refused, for want of a touch screen, and a fill with a code point Firefox reads as a named key is refused, each sending no input', async () => {
    const opened = await page()
    const tapped = await opened.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'save' } }, 1000)
    assert.deepEqual([tapped.result.ok ? '' : tapped.result.failure.class, tapped.input], ['unsupported', 'not_sent'])
    const filled = await opened.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'field' }, value: 'ab' }, 1000)
    assert.ok(!filled.result.ok)
    assert.equal(filled.result.failure.class, 'unsupported')
    assert.match(filled.result.failure.message, /U\+E007, which Firefox reads as a named key/)
    const secret = await opened.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'field' }, value: 'ab', secret: 'password' }, 1000)
    assert.ok(!secret.result.ok)
    assert.doesNotMatch(secret.result.failure.message, /E007/, 'a secret is never described by its characters')
    assert.equal(endpoint.commands('input.performActions').length, 0)
    await opened.dispose(1000)
  })

  test('a window that cannot be activated receives no readiness call or keyboard input', async () => {
    const opened = await page()
    endpoint.sent.length = 0
    endpoint.on('browsingContext.activate', () => ({ error: 'no such frame', message: 'the window is gone' }))
    const filled = await opened.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'field' }, value: 'New' }, 1000)
    assert.ok(!filled.result.ok)
    assert.equal(filled.result.failure.class, 'session_lost')
    assert.equal(filled.input, 'not_sent')
    assert.deepEqual(endpoint.sent.map((command) => command.method), ['browsingContext.activate'])
    await opened.dispose(1000)
  })

  test('an activation that never answers ends at the action deadline with no readiness call or input', async () => {
    const opened = await page()
    endpoint.sent.length = 0
    endpoint.on('browsingContext.activate', () => 'silent')
    const filled = await opened.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'field' }, value: 'New' }, 30)
    assert.ok(!filled.result.ok)
    assert.equal(filled.result.failure.class, 'timeout')
    assert.equal(filled.input, 'not_sent')
    assert.deepEqual(endpoint.sent.map((command) => command.method), ['browsingContext.activate'])
    await opened.dispose(1000)
  })

  test('an origin-bound fill lets go, at its next look, a navigation the page started before the look that readies its field, and sends no key meanwhile', async (t) => {
    const opened = await page()
    endpoint.sent.length = 0
    endpoint.accept('browsingContext.activate', 'network.removeIntercept', 'network.continueRequest', 'network.failRequest')
    // The page sets off for its next step as the hold is armed, before the fill has found its field.
    endpoint.on('network.addIntercept', () => {
      navigationEvent('navigationStarted', 'step-2', 'http://127.0.0.1:4173/login?step=2')
      endpoint.emit('network.beforeRequestSent', { isBlocked: true, intercepts: ['fill-hold'], context, navigation: 'step-2', redirectCount: 0, timestamp: 1, request: { request: 'step-2-request', url: 'http://127.0.0.1:4173/login?step=2', method: 'GET' } })
      return { result: { intercept: 'fill-hold' } }
    })
    const clock = earlyClock(t)
    let finished = false
    let continued = false
    endpoint.on('network.continueRequest', (params) => {
      if (params['request'] === 'step-2-request') {
        assert.equal(finished, false, 'the fill still waits when the navigation continues')
        assert.deepEqual(endpoint.commands('network.removeIntercept'), [], 'the hold is still armed')
        continued = true
      }
      return { result: {} }
    })
    const filling = opened.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'field' }, value: 'New', secret: 'field', allowedOrigins: ['http://127.0.0.1:4173'] }, 300)
    void filling.then(() => { finished = true }, () => { finished = true })
    // The first look must release the held request before this fixture advances the action clock.
    const filled = await clock.run(filling, () => continued)
    clock.restore()
    assert.ok(!filled.result.ok, 'the document it waits for never arrives here')
    assert.equal(filled.result.failure.class, 'not_actionable')
    assert.equal(filled.result.failure.details?.['check'], 'navigation')
    assert.equal(filled.result.failure.details?.['waitedMs'], 300)
    assert.deepEqual(endpoint.commands('script.callFunction'), [], 'no field look or registration was attempted')
    assert.equal(filled.input, 'not_sent')
    const methods = endpoint.sent.map((command) => command.method)
    const letGo = endpoint.sent.findIndex((command) => command.method === 'network.continueRequest' && command.params['request'] === 'step-2-request')
    assert.ok(letGo !== -1, "the page's own navigation goes on")
    assert.ok(letGo < methods.indexOf('network.removeIntercept'), 'while the fill still waits, not only when the hold is released')
    assert.deepEqual(endpoint.commands('network.failRequest'), [], 'nothing is cancelled')
    assert.deepEqual(endpoint.commands('input.performActions'), [])
    await opened.dispose(1000)
  })

  test('a look whose page call Firefox never answers fails as a timeout no sooner than its budget, every time', async () => {
    const opened = await page()
    endpoint.on('script.callFunction', (params) => {
      if (String(params['functionDeclaration']).startsWith('async function retestCall')) return 'silent'
      return { result: { type: 'success', realm: 'realm', result: { type: 'undefined' } } }
    })
    const early: number[] = []
    for (let round = 0; round < 10; round += 1) {
      const startedAt = performance.now()
      const looked = await opened.execute({ kind: 'observe', locator: { by: 'testId', value: 'field' } }, 30)
      const tookMs = performance.now() - startedAt
      assert.ok(!looked.ok && looked.failure.class === 'timeout', JSON.stringify(looked))
      if (tookMs < 30) early.push(tookMs)
    }
    assert.deepEqual(early, [], 'no look gave up before its 30 ms had passed')
    await opened.dispose(1000)
  })

  test("a goto ends at its document's load, and the navigation it records is the goto's", async () => {
    const opened = await page()
    const records: PageNavigation[] = []
    opened.onNavigation((navigation) => void records.push(navigation))
    endpoint.on('browsingContext.navigate', (params) => {
      setTimeout(() => {
        navigationEvent('navigationStarted', 'n1', String(params['url']))
        documented(String(params['url']))
        navigationEvent('load', 'n1', String(params['url']))
      }, 10)
      return { result: { navigation: 'n1', url: params['url'] } }
    })
    const result = await opened.execute({ kind: 'goto', url: '/tasks' }, 2000, undefined, 7)
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.deepEqual(records.map(({ url, document, cause, commandToken }) => [url, document, cause, commandToken]), [['http://127.0.0.1:4173/tasks', 'new', 'goto', 7]])
    await opened.dispose(1000)
  })

  test('a goto whose load Firefox names by the navigation the load handler started still ends at that load, and the next navigation is the page’s', async () => {
    const opened = await page()
    const records: PageNavigation[] = []
    opened.onNavigation((navigation) => void records.push(navigation))
    endpoint.on('browsingContext.navigate', (params) => {
      const url = String(params['url'])
      setTimeout(() => {
        navigationEvent('navigationStarted', 'n1', url)
        documented(url)
        navigationEvent('domContentLoaded', 'n1', url)
        navigationEvent('navigationStarted', 'n2', 'http://127.0.0.1:9999/elsewhere')
        navigationEvent('load', 'n2', url)
      }, 10)
      return { result: { navigation: 'n1', url } }
    })
    const result = await opened.execute({ kind: 'goto', url: '/leaving' }, 1500)
    assert.equal(result.ok, true, JSON.stringify(result))
    documented('http://127.0.0.1:9999/elsewhere')
    await settle()
    assert.deepEqual(records.map(({ url, cause }) => [url, cause]), [
      ['http://127.0.0.1:4173/leaving', 'goto'],
      ['http://127.0.0.1:9999/elsewhere', 'page'],
    ])
    await opened.dispose(1000)
  })

  test('a navigation whose response has no content fails at once, naming the address, with its request sent', async () => {
    const opened = await page()
    endpoint.on('browsingContext.navigate', (params) => {
      const url = String(params['url'])
      setTimeout(() => {
        navigationEvent('navigationStarted', 'n1', url)
        endpoint.emit('network.responseStarted', { context, navigation: 'n1', redirectCount: 0, timestamp: 0, isBlocked: false, request: { request: '1', url, method: 'GET' }, response: { url, status: 204, statusText: 'No Content', fromCache: false, headers: [] } })
      }, 10)
      return { result: { navigation: 'n1', url } }
    })
    const started = performance.now()
    const result = await opened.execute({ kind: 'goto', url: '/empty' }, 2000)
    assert.ok(performance.now() - started < 1000, 'it fails without waiting out its time')
    assert.deepEqual(result, {
      ok: false,
      failure: {
        class: 'not_actionable',
        message: 'Could not open http://127.0.0.1:4173/empty: the browser sent the request and gave the navigation up without opening a document, as it does for a response with no content or a download. The page stayed on about:blank.',
        details: { url: 'http://127.0.0.1:4173/empty', inputSent: true },
      },
    })
    await opened.dispose(1000)
  })

  test('a prompt the page opens fails what waits on the page, and a closed tab ends the session', async () => {
    const opened = await page()
    endpoint.on('browsingContext.navigate', () => 'silent')
    const waiting = opened.execute({ kind: 'goto', url: '/slow' }, 2000)
    await settle()
    endpoint.emit('browsingContext.userPromptOpened', { context, type: 'alert', message: 'Hello', handler: 'ignore' })
    const failed = await waiting
    assert.ok(!failed.ok)
    assert.match(failed.failure.message, /alert/)
    endpoint.emit('browsingContext.userPromptClosed', { context, accepted: true, type: 'alert' })
    endpoint.emit('browsingContext.contextDestroyed', { context, url: 'about:blank', children: [], userContext: 'user-1' })
    await settle()
    const later = await opened.dispatch({ kind: 'click', locator: { by: 'testId', value: 'save' } }, 1000)
    assert.deepEqual([later.result.ok ? '' : later.result.failure.class, later.input], ['session_lost', 'not_sent'])
    await opened.dispose(1000)
  })
})
