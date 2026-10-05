import type { CollectorLoss, Observation } from '../../src/diagnostics/observations.ts'
import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxCollector, firefoxConsoleUnavailable, firefoxScope } from '../../src/diagnostics/firefox-collector.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The Firefox collector from scripted BiDi events: network events only, a request's hops through a redirect, a failed
// request, the tab's frames, other tabs left out, the tracking limit and the end of the tab, and the console kind
// named unavailable, since Firefox can run logged enumerable getters before Retest could filter a delivered entry.

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

type Heard = { observed: Observation[]; unreadable: string[]; limited: string[]; lost: CollectorLoss[] }

async function collector(context: string, maxTrackedRequests?: number): Promise<{ collector: FirefoxCollector; heard: Heard; subscribed: string[][]; unsubscribed: string[][] }> {
  const heard: Heard = { observed: [], unreadable: [], limited: [], lost: [] }
  const subscribed: string[][] = []
  const unsubscribed: string[][] = []
  const sink = {
    observe: (observation: Observation) => heard.observed.push(observation),
    unreadable: (method: string) => heard.unreadable.push(method),
    limited: (method: string) => heard.limited.push(method),
    lost: (loss: CollectorLoss) => heard.lost.push(loss),
  }
  const subscriptions = {
    subscribe: async (events: readonly string[]) => { subscribed.push([...events]) },
    unsubscribe: (events: readonly string[]) => { unsubscribed.push([...events]) },
  }
  const made = new FirefoxCollector({ client, context, sink, subscriptions, ...(maxTrackedRequests === undefined ? {} : { maxTrackedRequests }) })
  await made.start(1000)
  return { collector: made, heard, subscribed, unsubscribed }
}

async function settle(): Promise<void> {
  endpoint.accept('session.status')
  await client.send('session.status', {})
}

const request = (id: string, url: string) => ({ request: id, url, method: 'GET' })

describe('the Firefox collector', () => {
  test("names what it covers: the tab's document and its frames for network, workers' requests not claimed, and no console at all", () => {
    assert.equal(firefoxScope.engine, 'firefox')
    assert.deepEqual(firefoxScope.console.covered, [])
    assert.deepEqual(firefoxScope.network.covered, ['top_level_document', 'same_process_frames', 'out_of_process_frames'])
    assert.ok(firefoxScope.network.notCovered.includes('dedicated_workers'))
    assert.match(firefoxScope.reason ?? '', /dedicated worker's request is recorded as its page's/)
  })

  test('subscribes to network events only, and names the console kind unavailable with the reason', async () => {
    const { collector: made, heard, subscribed } = await collector('tab')
    assert.deepEqual(subscribed, [['network.beforeRequestSent', 'network.responseStarted', 'network.responseCompleted', 'network.fetchError']])
    assert.deepEqual(made.unavailable, { console: firefoxConsoleUnavailable })
    assert.match(firefoxConsoleUnavailable, /runs the page's own enumerable getters/)
    assert.match(firefoxConsoleUnavailable, /before Retest can filter an entry/)
    assert.match(firefoxConsoleUnavailable, /ignores serialization options/)
    // An entry another client subscribed to is not the collector's to read.
    endpoint.emit('log.entryAdded', { type: 'console', level: 'warn', method: 'warn', text: 'careful', timestamp: 1000, source: { realm: 'r', context: 'tab' }, args: [] })
    await settle()
    assert.deepEqual(heard, { observed: [], unreadable: [], limited: [], lost: [] })
    made.stop()
  })

  test('primitive arguments do not grant permission to subscribe: later object entries would already have run their getters', async () => {
    const { collector: made, heard, subscribed, unsubscribed } = await collector('tab')
    for (const argument of [{ type: 'string', value: 'safe text' }, { type: 'number', value: 37 }, { type: 'object', value: [['tripwire', { type: 'number', value: 2 }]] }, { type: 'node' }]) {
      endpoint.emit('log.entryAdded', { type: 'console', method: 'log', level: 'info', timestamp: 1000, source: { realm: 'r', context: 'tab' }, args: [argument] })
    }
    await settle()
    assert.equal(subscribed.flat().includes('log.entryAdded'), false)
    assert.deepEqual(made.unavailable, { console: firefoxConsoleUnavailable })
    assert.deepEqual(heard, { observed: [], unreadable: [], limited: [], lost: [] })
    made.stop()
    assert.deepEqual(unsubscribed, subscribed)
  })

  test('a redirect chain names each hop, links the hops, and a failed request says why', async () => {
    const { collector: made, heard } = await collector('tab')
    endpoint.emit('network.beforeRequestSent', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 2000, request: request('16', 'http://127.0.0.1/r1'), isBlocked: false })
    endpoint.emit('network.responseStarted', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 2003, request: request('16', 'http://127.0.0.1/r1'), response: { status: 302, statusText: 'Found', mimeType: 'application/x-unknown-content-type', protocol: 'http/1.1', fromCache: false, headers: [{ name: 'set-cookie', value: { type: 'string', value: 'secret' } }] } })
    endpoint.emit('network.responseCompleted', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 2004, request: request('16', 'http://127.0.0.1/r1'), response: { status: 302, fromCache: false, bytesReceived: 149 } })
    endpoint.emit('network.beforeRequestSent', { context: 'tab', navigation: null, redirectCount: 1, timestamp: 2005, request: request('16', 'http://127.0.0.1/final'), isBlocked: false })
    endpoint.emit('network.responseStarted', { context: 'tab', navigation: null, redirectCount: 1, timestamp: 2007, request: request('16', 'http://127.0.0.1/final'), response: { status: 200, statusText: 'OK', mimeType: 'text/plain;charset=utf-8', protocol: 'http/1.1', fromCache: true } })
    endpoint.emit('network.responseCompleted', { context: 'tab', navigation: null, redirectCount: 1, timestamp: 2009.5, request: request('16', 'http://127.0.0.1/final'), response: { status: 200, fromCache: true, bytesReceived: 172 } })
    endpoint.emit('network.beforeRequestSent', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 2010, request: request('17', 'http://127.0.0.1:9/'), isBlocked: false })
    endpoint.emit('network.fetchError', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 2012, request: request('17', 'http://127.0.0.1:9/'), errorText: 'NS_ERROR_CONNECTION_REFUSED' })
    await settle()
    assert.deepEqual(heard.observed, [
      { kind: 'request', key: '16#1', method: 'GET', url: 'http://127.0.0.1/r1', frame: 'main', time: 2000 },
      { kind: 'response', key: '16#1', status: 302, statusText: 'Found', contentType: 'application/x-unknown-content-type', cache: 'none', protocol: 'http/1.1', time: 2003, redirectedTo: '16#2' },
      { kind: 'finished', key: '16#1', time: 2004, durationMs: 4, transferredBytes: 149 },
      { kind: 'request', key: '16#2', method: 'GET', url: 'http://127.0.0.1/final', frame: 'main', time: 2005, redirectedFrom: '16#1' },
      { kind: 'response', key: '16#2', status: 200, statusText: 'OK', contentType: 'text/plain', protocol: 'http/1.1', time: 2007 },
      { kind: 'finished', key: '16#2', time: 2009.5, durationMs: 4.5, transferredBytes: 172 },
      { kind: 'request', key: '17#1', method: 'GET', url: 'http://127.0.0.1:9/', frame: 'main', time: 2010 },
      { kind: 'failed', key: '17#1', time: 2012, durationMs: 2, reason: 'NS_ERROR_CONNECTION_REFUSED' },
    ])
    assert.doesNotMatch(JSON.stringify(heard.observed), /secret/, 'no header is copied')
    made.stop()
  })

  test('requests past the tracking limit are counted as limited, and an event it cannot read is counted, never guessed', async () => {
    const { collector: made, heard } = await collector('tab', 1)
    endpoint.emit('network.beforeRequestSent', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 1, request: request('1', 'http://127.0.0.1/a'), isBlocked: false })
    endpoint.emit('network.beforeRequestSent', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 2, request: request('2', 'http://127.0.0.1/b'), isBlocked: false })
    endpoint.emit('network.responseStarted', { context: 'tab', redirectCount: 0, timestamp: 3, request: request('1', 'http://127.0.0.1/a') })
    await settle()
    assert.equal(heard.observed.length, 1)
    assert.deepEqual(heard.limited, ['network.beforeRequestSent'])
    assert.deepEqual(heard.unreadable, ['network.responseStarted'], 'a response without its response part is counted, never guessed')
    made.stop()
  })

  test("the tab's end is a loss, after which nothing more arrives, and stopping ends its subscription once", async () => {
    const { heard, unsubscribed } = await collector('tab')
    endpoint.emit('browsingContext.contextDestroyed', { context: 'tab' })
    endpoint.emit('network.beforeRequestSent', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 1, request: request('late', 'http://127.0.0.1/late'), isBlocked: false })
    await settle()
    assert.deepEqual(heard.lost.map((loss) => [loss.kind, loss.reason]), [['page_crashed', 'the page was closed']])
    assert.deepEqual(heard.observed, [])
    assert.deepEqual(unsubscribed, [], 'a tab that closed took its subscription with it')
    const { collector: second, unsubscribed: ended } = await collector('tab-2')
    second.stop()
    second.stop()
    assert.equal(ended.length, 1)
  })
})


test('a navigation reported by BiDi names its request as Document and keeps a frame navigation a child', async () => {
  const { collector: made, heard } = await collector('tab')
  endpoint.emit('browsingContext.contextCreated', { context: 'frame', parent: 'tab' })
  for (const context of ['tab', 'frame']) endpoint.emit('network.beforeRequestSent', { context, navigation: `navigation-${context}`, redirectCount: 0, timestamp: 1, request: request(context, 'https://site.test/') })
  await settle()
  assert.deepEqual(heard.observed.map((record) => record.kind === 'request' ? [record.resourceType, record.frame] : []), [['Document', 'main'], ['Document', 'child']])
  made.stop()
})

test('a request with no navigation is never given a resource type by its address', async () => {
  const { collector: made, heard } = await collector('tab')
  endpoint.emit('network.beforeRequestSent', { context: 'tab', navigation: null, redirectCount: 0, timestamp: 1, request: request('fetch', 'https://site.test/document.html'), isBlocked: false })
  await settle()
  assert.deepEqual(heard.observed, [{ kind: 'request', key: 'fetch#1', method: 'GET', url: 'https://site.test/document.html', frame: 'main', time: 1 }])
  made.stop()
})

test("a request of a frame Firefox never told of, or of another tab, is not the tab's", async () => {
  const { collector: made, heard } = await collector('tab')
  endpoint.emit('network.beforeRequestSent', { context: 'unknown-frame', navigation: null, redirectCount: 0, timestamp: 1, request: request('stray', 'https://other.test/') , isBlocked: false })
  endpoint.emit('browsingContext.contextCreated', { context: 'elsewhere', parent: 'other-tab' })
  endpoint.emit('network.beforeRequestSent', { context: 'elsewhere', navigation: null, redirectCount: 0, timestamp: 2, request: request('other', 'https://other.test/') , isBlocked: false })
  await settle()
  assert.deepEqual(heard.observed, [])
  made.stop()
})
