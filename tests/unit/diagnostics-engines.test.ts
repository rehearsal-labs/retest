import type { SessionIdentity, WebEngine } from '../../src/browser/contract.ts'
import type { TargetEvent } from '../../src/browser/webkit/connection.ts'
import type { PageLoss } from '../../src/browser/webkit/page.ts'
import type { DiagnosedPage } from '../../src/diagnostics/attempt.ts'
import type { FirefoxCollectorOptions } from '../../src/diagnostics/firefox-collector.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../../src/diagnostics/observations.ts'
import type { FinishedCapture } from '../../src/diagnostics/session-capture.ts'
import type { DiagnosticIdentity, DiagnosticRecord, DiagnosticsSummary } from '../../src/protocol/diagnostics.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, test } from 'node:test'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { ChromiumCollector } from '../../src/diagnostics/chromium-collector.ts'
import { FirefoxCollector, firefoxConsoleUnavailable } from '../../src/diagnostics/firefox-collector.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { AttemptBudget, SessionCapture } from '../../src/diagnostics/session-capture.ts'
import { WebKitCollector } from '../../src/diagnostics/webkit-collector.ts'
import { defaultDiagnosticLimits } from '../../src/protocol/diagnostics.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The three browser collectors held to one contract, each fed its own engine's events through the parent's own
// session capture: a field the protocol leaves optional and the engine left out stays out of the record, never a zero
// or a guess; an event that cannot be read, a request over the collector's own tracking limit and the end of the
// connection make the kind they belong to partial, with the reason, and leave the other kind as it was; a capture
// that cannot start, or answers too late, is unavailable with the reason and keeps no listener. Every case runs once
// per engine, with the same assertions, except that Firefox's console is expected to be unavailable (`consoleUnavailable`).

const engines: readonly WebEngine[] = ['chromium', 'firefox', 'webkit']
const identity: DiagnosticIdentity = { testId: 'a.retest.ts > reads', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }
// A start for every hop on the epoch clock, and a monotonic clock in seconds for the engines whose events carry one.
const at = Date.UTC(2026, 9, 5)
const monotonicStart = 10

/**
 * Which fields of a protocol event a test sends: only those the protocol requires and those Retest cannot do without,
 * or the optional ones as well.
 */
type Fields = 'required' | 'optional'

type FirefoxSubscriptions = FirefoxCollectorOptions['subscriptions']

// The one difference between engines this file expects, decided for 0.1.0: Firefox records no console message and no
// runtime error, since Firefox runs logged enumerable getters before the consumer can filter entries. Its collector names the console
// unavailable, with this reason, and the parent's attempt writes it so. Every other engine must capture its console.
const consoleUnavailable: Readonly<Record<WebEngine, string | undefined>> = { chromium: undefined, firefox: firefoxConsoleUnavailable, webkit: undefined }

/**
 * The console of a collector that has no source for it: the collection names it unavailable with the engine's reason,
 * its scope covers no area of it, and nothing the page logged reached the capture.
 */
function assertNoConsole(rig: Rig, finished: FinishedCapture, reason: string): void {
  assert.deepEqual(rig.collector.unavailable, { console: reason })
  assert.deepEqual(rig.collector.scope.console.covered, [])
  assert.deepEqual(finished.records.filter((record) => record.type === 'console' || record.type === 'runtime_error'), [], 'nothing the page logged was heard')
  assert.match(reason, /enumerable getters/)
  assert.match(reason, /before Retest can filter an entry/)
  assert.match(reason, /ignores serialization options/)
}

/**
 * One collector, made as its page makes it, feeding a session capture of its own. Each method sends what that
 * engine's protocol sends for the same thing, so a case reads the same records whichever engine produced them.
 */
type Rig = {
  readonly engine: WebEngine
  readonly capture: SessionCapture
  readonly collector: DiagnosticCollection
  /** A request to `url` that is answered 200 after 250 ms and ends after 500 ms, on the engine's own clock. */
  exchange(id: string, url: string, fields: Fields): void
  /** A request that is sent and nothing more. */
  request(id: string, url: string): void
  /** A console message from the page's own code. */
  message(text: string, fields: Fields): void
  /** A network event missing a field Retest relies on. */
  unreadableNetwork(): void
  /** A console event missing a field Retest relies on. */
  unreadableConsole(): void
  /** The connection to the page ends, as the browser tells it. */
  lose(): void
  /** How many listeners the collector still holds on its page or its client. */
  listening(): number
  /** Lets every event sent so far reach the collector. */
  settle(): Promise<void>
  close(): Promise<void>
}

function sessionCapture(): SessionCapture {
  return new SessionCapture({ identity, budget: new AttemptBudget(defaultDiagnosticLimits), redactor: new Redactor(), startedAt: at })
}

/** A CDP session double: events a test sends, the listeners alive, and an answer to each command. */
class FakeSession {
  readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  readonly detaches = new Set<(reason: string) => void>()
  refuse: string | undefined

  on(method: string, listener: (params: unknown) => void): () => void {
    const set = this.listeners.get(method) ?? new Set()
    set.add(listener)
    this.listeners.set(method, set)
    return () => set.delete(listener)
  }

  onDetach(listener: (reason: string) => void): () => void {
    this.detaches.add(listener)
    return () => this.detaches.delete(listener)
  }

  async send(method: string): Promise<unknown> {
    if (method === this.refuse) throw new Error(`${method} was refused`)
    return {}
  }

  emit(method: string, params: unknown): void {
    for (const listener of [...(this.listeners.get(method) ?? [])]) listener(params)
  }

  get alive(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) + this.detaches.size
  }
}

async function chromiumRig(maxTrackedRequests?: number): Promise<Rig> {
  const session = new FakeSession()
  const capture = sessionCapture()
  const collector = new ChromiumCollector({ session, mainFrameId: () => 'MAIN', sink: capture, ...(maxTrackedRequests === undefined ? {} : { maxTrackedRequests }) })
  await collector.start(1000)
  const sent = (id: string, url: string, fields: Fields): object => ({ requestId: id, request: { url, method: 'GET' }, timestamp: monotonicStart, wallTime: at / 1000, ...(fields === 'optional' ? { type: 'Fetch', frameId: 'MAIN', loaderId: 'L', documentURL: url } : {}) })
  return {
    engine: 'chromium',
    capture,
    collector,
    exchange(id, url, fields) {
      session.emit('Network.requestWillBeSent', sent(id, url, fields))
      const optional = fields === 'optional' ? { statusText: 'OK', mimeType: 'application/json', fromDiskCache: false, fromServiceWorker: false, protocol: 'http/1.1' } : {}
      session.emit('Network.responseReceived', { requestId: id, timestamp: monotonicStart + 0.25, response: { url, status: 200, ...optional } })
      session.emit('Network.loadingFinished', { requestId: id, timestamp: monotonicStart + 0.5, ...(fields === 'optional' ? { encodedDataLength: 120 } : {}) })
    },
    request: (id, url) => session.emit('Network.requestWillBeSent', sent(id, url, 'required')),
    message(text, fields) {
      const place = fields === 'optional' ? { stackTrace: { callFrames: [{ functionName: 'save', url: 'http://app.test/app.js', lineNumber: 3, columnNumber: 7 }] } } : {}
      session.emit('Runtime.consoleAPICalled', { type: 'log', args: [{ type: 'string', value: text }], executionContextId: 1, timestamp: at, ...place })
    },
    unreadableNetwork: () => session.emit('Network.responseReceived', { requestId: 'R', timestamp: 'soon' }),
    unreadableConsole: () => session.emit('Runtime.consoleAPICalled', { type: 'log', executionContextId: 1, timestamp: at }),
    lose: () => {
      for (const detach of [...session.detaches]) detach('the target detached')
    },
    listening: () => session.alive,
    settle: async () => undefined,
    close: async () => collector.stop(),
  }
}

/**
 * Counts the listeners held on a BiDi client, by wrapping its own `on` and `onDisconnect`, so a test can see what a
 * collector added and whether it removed it.
 */
function countListeners(client: BidiClient): () => number {
  let alive = 0
  const counted = (remove: () => void): (() => void) => {
    alive += 1
    let removed = false
    return () => {
      if (!removed) alive -= 1
      removed = true
      remove()
    }
  }
  const on = client.on.bind(client)
  const onDisconnect = client.onDisconnect.bind(client)
  client.on = (method, listener) => counted(on(method, listener))
  client.onDisconnect = (listener) => counted(onDisconnect(listener))
  return () => alive
}

/**
 * Starts a Firefox collector on a client of a scripted endpoint. A start that fails closes the client and the endpoint
 * before it throws: a socket or a server left open keeps the test file's process alive after its last case.
 */
async function startedFirefox(options: { sink: DiagnosticSink; subscriptions: FirefoxSubscriptions; maxTrackedRequests?: number | undefined }): Promise<{ endpoint: ScriptedBidi; client: BidiClient; collector: FirefoxCollector; listening: () => number }> {
  const endpoint = await ScriptedBidi.start()
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => undefined })
  const listening = countListeners(client)
  const { sink, subscriptions, maxTrackedRequests } = options
  const collector = new FirefoxCollector({ client, context: 'tab', sink, subscriptions, ...(maxTrackedRequests === undefined ? {} : { maxTrackedRequests }) })
  try {
    await collector.start(1000)
  } catch (error) {
    client.close()
    await endpoint.close()
    throw error
  }
  return { endpoint, client, collector, listening }
}

async function firefoxRig(maxTrackedRequests?: number): Promise<Rig> {
  const capture = sessionCapture()
  const subscriptions = { subscribe: async () => undefined, unsubscribe: () => undefined }
  const { endpoint, client, collector, listening } = await startedFirefox({ sink: capture, subscriptions, maxTrackedRequests })
  const request = (id: string, url: string): object => ({ request: id, url, method: 'GET' })
  const base = (id: string, url: string, offsetMs: number): object => ({ context: 'tab', navigation: null, redirectCount: 0, timestamp: at + offsetMs, request: request(id, url) })
  return {
    engine: 'firefox',
    capture,
    collector,
    exchange(id, url, fields) {
      endpoint.emit('network.beforeRequestSent', { ...base(id, url, 0), isBlocked: false })
      const optional = fields === 'optional' ? { statusText: 'OK', mimeType: 'application/json', protocol: 'http/1.1', fromCache: false } : {}
      endpoint.emit('network.responseStarted', { ...base(id, url, 250), response: { status: 200, ...optional } })
      endpoint.emit('network.responseCompleted', { ...base(id, url, 500), response: { status: 200, ...optional, ...(fields === 'optional' ? { bytesReceived: 120 } : {}) } })
    },
    request: (id, url) => endpoint.emit('network.beforeRequestSent', { ...base(id, url, 0), isBlocked: false }),
    message(text, fields) {
      const place = fields === 'optional' ? { method: 'log', stackTrace: { callFrames: [{ functionName: 'save', url: 'http://app.test/app.js', lineNumber: 3, columnNumber: 7 }] } } : {}
      endpoint.emit('log.entryAdded', { type: 'console', level: 'info', text, timestamp: at, source: { realm: 'r', context: 'tab' }, ...place })
    },
    unreadableNetwork: () => endpoint.emit('network.responseStarted', { context: 'tab', redirectCount: 0, timestamp: at, response: { status: 200 } }),
    unreadableConsole: () => endpoint.emit('log.entryAdded', { type: 'console', level: 'info', text: 'no time', source: { context: 'tab' } }),
    lose: () => endpoint.drop(),
    listening,
    // A command's answer comes after every event sent before it, on the one socket.
    async settle() {
      endpoint.accept('session.status')
      await client.send('session.status', {}).catch(() => undefined)
      await delay(20)
    },
    async close() {
      collector.stop()
      client.close()
      await endpoint.close()
    },
  }
}

/** A WebKit page whose target events and end a test tells. */
function fakeWebKitPage() {
  const events = new Set<(event: TargetEvent) => void>()
  const losses = new Set<(loss: PageLoss) => void>()
  return {
    mainFrameId: 'frame-1',
    onTargetEvent(listener: (event: TargetEvent) => void): () => void {
      events.add(listener)
      return () => events.delete(listener)
    },
    onLost(listener: (loss: PageLoss) => void): () => void {
      losses.add(listener)
      return () => losses.delete(listener)
    },
    tell(method: string, params: object): void {
      for (const listener of [...events]) listener({ pageProxyId: '7', targetId: 'page-8', method, params })
    },
    lose(loss: PageLoss): void {
      for (const listener of [...losses]) listener(loss)
    },
    get listening(): number {
      return events.size + losses.size
    },
  }
}

async function webKitRig(maxTrackedRequests?: number): Promise<Rig> {
  const page = fakeWebKitPage()
  const capture = sessionCapture()
  const collector = new WebKitCollector({ page, sink: capture, ...(maxTrackedRequests === undefined ? {} : { maxTrackedRequests }) })
  const sent = (id: string, url: string, fields: Fields): object => ({ requestId: id, request: { url, method: 'GET' }, timestamp: monotonicStart, walltime: at / 1000, ...(fields === 'optional' ? { type: 'Fetch', frameId: 'frame-1', loaderId: 'L' } : {}) })
  return {
    engine: 'webkit',
    capture,
    collector,
    exchange(id, url, fields) {
      page.tell('Network.requestWillBeSent', sent(id, url, fields))
      const optional = fields === 'optional' ? { statusText: 'OK', mimeType: 'application/json', source: 'network' } : {}
      page.tell('Network.responseReceived', { requestId: id, timestamp: monotonicStart + 0.25, response: { url, status: 200, ...optional } })
      const metrics = fields === 'optional' ? { metrics: { protocol: 'http/1.1', responseHeaderBytesReceived: 100, responseBodyBytesReceived: 20 } } : {}
      page.tell('Network.loadingFinished', { requestId: id, timestamp: monotonicStart + 0.5, ...metrics })
    },
    request: (id, url) => page.tell('Network.requestWillBeSent', sent(id, url, 'required')),
    // WebKit's protocol leaves a message's timestamp optional, but the collector counts a message without one as unread
    // rather than stamp it with Retest's own clock, so even the plainest message carries the engine's time, in seconds.
    message(text, fields) {
      const place = fields === 'optional' ? { type: 'log', url: 'http://app.test/app.js', line: 4, column: 8 } : {}
      page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', text, timestamp: at / 1000, ...place } })
    },
    unreadableNetwork: () => page.tell('Network.responseReceived', { requestId: 7 }),
    unreadableConsole: () => page.tell('Console.messageAdded', { message: { source: 'console-api' } }),
    lose: () => page.lose({ reason: 'the inspector pipe closed', crashed: false }),
    listening: () => page.listening,
    settle: async () => undefined,
    close: async () => collector.stop(),
  }
}

function rigFor(engine: WebEngine, maxTrackedRequests?: number): Promise<Rig> {
  if (engine === 'chromium') return chromiumRig(maxTrackedRequests)
  return engine === 'firefox' ? firefoxRig(maxTrackedRequests) : webKitRig(maxTrackedRequests)
}

function only<T extends DiagnosticRecord['type']>(records: readonly DiagnosticRecord[], type: T): Extract<DiagnosticRecord, { type: T }> {
  const found = records.filter((record): record is Extract<DiagnosticRecord, { type: T }> => record.type === type)
  assert.equal(found.length, 1, `one ${type} record`)
  const [record] = found
  assert.ok(record !== undefined)
  return record
}

/** The record's keys beyond its identity, sorted, so a case can say exactly which facts it holds. */
function facts(record: DiagnosticRecord): string[] {
  const shared = new Set(['type', 'testId', 'attemptId', 'app', 'sessionId', 'target'])
  return Object.keys(record).filter((key) => !shared.has(key)).sort()
}

for (const engine of engines) {
  describe(`the ${engine} collector, held to the shared contract`, () => {
    test('a request, a response and an end that carry only the fields the protocol requires keep only those, with no zero or guess for the rest, and the capture is complete', async () => {
      const rig = await rigFor(engine)
      rig.exchange('A', 'http://app.test/api/tasks', 'required')
      rig.message('saved', 'required')
      await rig.settle()
      const finished = rig.capture.finish('attempt_ended', at + 1000)
      await rig.close()
      const request = only(finished.records, 'network.request')
      assert.deepEqual([request.requestId, request.method, request.url, request.time], ['n1', 'GET', 'http://app.test/api/tasks', new Date(at).toISOString()])
      assert.equal(request.resourceType, undefined, 'no resource type the engine did not give')
      assert.deepEqual(facts(only(finished.records, 'network.response')), ['requestId', 'status', 'time'], 'a status and nothing the engine left out: no status text, content type, cache, service worker or protocol')
      const ended = only(finished.records, 'network.finished')
      assert.deepEqual(facts(ended), ['durationMs', 'requestId', 'time'], 'no transferred size the engine did not give')
      assert.equal(ended.durationMs, 500, "measured on the engine's own clock")
      assert.ok(finished.network.state === 'complete' && finished.network.requests === 1, JSON.stringify(finished.network))
      const reason = consoleUnavailable[engine]
      if (reason !== undefined) return assertNoConsole(rig, finished, reason)
      const message = only(finished.records, 'console')
      assert.deepEqual([message.text.text, message.url, message.line, message.column], ['saved', undefined, undefined, undefined], 'no place the engine did not give')
      assert.equal(message.time, new Date(at).toISOString(), "the time the engine stamped on the message, never Retest's own clock passed off as the engine's")
      assert.ok(finished.console.state === 'complete' && finished.console.entries === 1, JSON.stringify(finished.console))
    })

    test('the optional fields the engine gives are kept as it gave them', async () => {
      const rig = await rigFor(engine)
      rig.exchange('A', 'http://app.test/api/tasks', 'optional')
      rig.message('saved', 'optional')
      await rig.settle()
      const finished = rig.capture.finish('attempt_ended', at + 1000)
      await rig.close()
      const response = only(finished.records, 'network.response')
      assert.deepEqual([response.status, response.statusText, response.contentType, response.cache], [200, 'OK', 'application/json', 'none'])
      const ended = only(finished.records, 'network.finished')
      assert.deepEqual([ended.durationMs, ended.transferredBytes], [500, 120])
      assert.equal(finished.network.state, 'complete')
      const reason = consoleUnavailable[engine]
      if (reason !== undefined) return assertNoConsole(rig, finished, reason)
      const message = only(finished.records, 'console')
      assert.deepEqual([message.url, message.line, message.column], ['http://app.test/app.js', 4, 8], 'lines and columns from 1, whatever the engine counts from')
      assert.equal(finished.console.state, 'complete')
    })

    test('a network event that cannot be read makes the network capture partial, with the reason, and leaves the console complete', async () => {
      const rig = await rigFor(engine)
      rig.message('before', 'required')
      rig.unreadableNetwork()
      await rig.settle()
      const finished = rig.capture.finish('attempt_ended', at + 1000)
      await rig.close()
      assert.ok(finished.network.state === 'partial', `the network capture is not complete: ${JSON.stringify(finished.network)}`)
      assert.equal(finished.network.reason, '1 network event from the browser could not be read')
      assert.equal(finished.console.state, 'complete', JSON.stringify(finished.console))
    })

    test('a console event that cannot be read makes the console capture partial, with the reason, and leaves the network complete', async () => {
      const rig = await rigFor(engine)
      rig.exchange('A', 'http://app.test/api/tasks', 'required')
      rig.unreadableConsole()
      await rig.settle()
      const finished = rig.capture.finish('attempt_ended', at + 1000)
      await rig.close()
      assert.equal(finished.network.state, 'complete', JSON.stringify(finished.network))
      // A collector with no console source never reads a console event, so none can be unreadable.
      const reason = consoleUnavailable[engine]
      if (reason !== undefined) return assertNoConsole(rig, finished, reason)
      assert.ok(finished.console.state === 'partial', JSON.stringify(finished.console))
      assert.equal(finished.console.reason, '1 console event from the browser could not be read')
    })

    test("a request over the collector's own tracking limit makes the network capture partial and counts it there, never in the console", async () => {
      const rig = await rigFor(engine, 1)
      rig.request('A', 'http://app.test/first')
      rig.request('B', 'http://app.test/second')
      await rig.settle()
      const finished = rig.capture.finish('attempt_ended', at + 1000)
      await rig.close()
      assert.ok(finished.network.state === 'partial', `the network capture is not complete: ${JSON.stringify(finished.network)}`)
      assert.equal(finished.network.reason, "1 request over the collector's tracking limit was dropped")
      assert.equal(finished.network.dropped, 1)
      assert.equal(finished.console.state, 'complete', JSON.stringify(finished.console))
    })

    test('the end of the connection makes both kinds partial from that moment, marks the open request with it, and the collector lets go of its page', async () => {
      const rig = await rigFor(engine)
      rig.request('A', 'http://app.test/slow')
      await rig.settle()
      assert.ok(rig.listening() > 0, 'the collector listens while its page is there')
      const before = Date.now()
      rig.lose()
      await rig.settle()
      assert.equal(rig.listening(), 0, 'no listener survives the end of the connection')
      rig.message('after the end', 'required')
      await rig.settle()
      const finished = rig.capture.finish('attempt_ended', at + 1_000_000)
      await rig.close()
      for (const capture of [finished.console, finished.network]) {
        assert.ok(capture.state === 'partial', JSON.stringify(capture))
        assert.match(capture.reason, /^the connection to the page ended at \S+ \(.+\), and nothing after it was captured$/)
      }
      const pending = only(finished.records, 'network.pending')
      assert.deepEqual([pending.reason, pending.lastState], ['connection_lost', 'requested'])
      assert.ok(Date.parse(finished.endedAt) >= before, 'the capture ends when the connection did, not when the attempt did')
      assert.equal(finished.records.some((record) => record.type === 'console'), false, 'nothing after the end')
    })

    test('stopping the collector removes every listener it added, and a second stop changes nothing', async () => {
      const rig = await rigFor(engine)
      const listening = rig.listening()
      assert.ok(listening > 0, `the collector listens: ${listening}`)
      await rig.close()
      assert.equal(rig.listening(), 0)
      rig.collector.stop()
      assert.equal(rig.listening(), 0)
    })
  })
}

/** A session of the attempt, on the named engine. */
function sessionOf(engine: WebEngine): SessionIdentity {
  return { sessionId: identity.sessionId, owner: { runId: 'run', testId: identity.testId, attemptId: identity.attemptId, app: identity.app }, runtime: { kind: 'web', engine, product: engine, version: '1', executablePath: `/${engine}`, processIds: [1] } }
}

function attempt(): { diagnostics: AttemptDiagnostics; written: string[]; events: EventBody[] } {
  const written: string[] = []
  const events: EventBody[] = []
  const diagnostics = new AttemptDiagnostics({
    policy: defaultDiagnosticsPolicy,
    redactor: new Redactor(),
    writeArtifact: (path) => void written.push(path),
    emit: (body) => void events.push(body),
    testId: identity.testId,
    attemptId: identity.attemptId,
    variant: undefined,
    named: true,
  })
  return { diagnostics, written, events }
}

function onlySummary(summaries: readonly DiagnosticsSummary[]): DiagnosticsSummary {
  assert.equal(summaries.length, 1)
  const [summary] = summaries
  assert.ok(summary !== undefined)
  return summary
}

/**
 * A page whose collector cannot start, as each engine's page fails: Chrome does not enable a domain, Firefox does not
 * take the subscription, and WebKit's page is not ready to be heard, which its page checks before it makes the
 * collector, since WebKit's collector itself sends nothing. `listening` counts what is still held on the refused
 * session, client or page.
 */
function refusingPage(engine: WebEngine): { page: DiagnosedPage['page']; made: () => boolean; listening: () => number } {
  const session = new FakeSession()
  session.refuse = 'Network.enable'
  const webKit = fakeWebKitPage()
  let clientListening: (() => number) | undefined
  let made = false
  return {
    page: {
      async collectDiagnostics(sink: DiagnosticSink, timeoutMs: number): Promise<DiagnosticCollection> {
        if (engine === 'chromium') {
          const collector = new ChromiumCollector({ session, mainFrameId: () => 'MAIN', sink })
          made = session.alive > 0
          await collector.start(timeoutMs)
          return collector
        }
        if (engine === 'firefox') {
          const endpoint = await ScriptedBidi.start()
          const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => undefined })
          clientListening = countListeners(client)
          const subscriptions = { subscribe: async () => Promise.reject(new Error('session.subscribe was refused')), unsubscribe: () => undefined }
          const collector = new FirefoxCollector({ client, context: 'tab', sink, subscriptions })
          made = (clientListening?.() ?? 0) > 0
          try {
            await collector.start(timeoutMs)
            return collector
          } finally {
            client.close()
            await endpoint.close()
          }
        }
        throw new Error('the page was not ready to be heard')
      },
    },
    made: () => made,
    listening: () => (engine === 'chromium' ? session.alive : engine === 'firefox' ? (clientListening?.() ?? 0) : webKit.listening),
  }
}

/**
 * A page whose collector answers only after `delayMs`, made as the engine's page makes it, with whether it was made
 * and what it still holds.
 */
function latePage(engine: WebEngine, delayMs: number): { page: DiagnosedPage['page']; made: () => boolean; listening: () => number } {
  const session = new FakeSession()
  const webKit = fakeWebKitPage()
  let subscribed = 0
  let made = false
  return {
    page: {
      async collectDiagnostics(sink: DiagnosticSink): Promise<DiagnosticCollection> {
        await delay(delayMs)
        made = true
        if (engine === 'chromium') return new ChromiumCollector({ session, mainFrameId: () => 'MAIN', sink })
        if (engine === 'webkit') return new WebKitCollector({ page: webKit, sink })
        const subscriptions = { subscribe: async () => void (subscribed += 1), unsubscribe: () => void (subscribed -= 1) }
        const { endpoint, client, collector } = await startedFirefox({ sink, subscriptions })
        // The client goes with the collector's end, which is what the parent asks for.
        const stop = collector.stop.bind(collector)
        return { scope: collector.scope, stop: () => { stop(); client.close(); void endpoint.close() } }
      },
    },
    made: () => made,
    listening: () => (engine === 'chromium' ? session.alive : engine === 'webkit' ? webKit.listening : subscribed),
  }
}

for (const engine of engines) {
  describe(`a ${engine} capture that cannot start`, () => {
    test('is unavailable on both kinds with the reason, writes no artifact and no start marker, and never reads as an empty complete capture', async () => {
      const { diagnostics, written, events } = attempt()
      const refusing = refusingPage(engine)
      await diagnostics.start([{ app: 'web', page: refusing.page, session: sessionOf(engine) }], 500)
      assert.equal(refusing.made(), engine !== 'webkit', "a collector was made and listened before its start failed, except on WebKit, whose page fails before it makes one")
      assert.equal(refusing.listening(), 0, 'the collector that could not start keeps no listener')
      const summary = onlySummary(diagnostics.finish('attempt_ended').summaries)
      assert.equal(summary.console.state, 'unavailable')
      assert.match(summary.console.state === 'unavailable' ? summary.console.reason : '', /^Retest could not start capture: .*(refused|not ready)/)
      assert.deepEqual(summary.network, summary.console)
      assert.equal(summary.path, undefined)
      assert.deepEqual(written, [])
      assert.deepEqual(events.map((event) => event.type), ['diagnostics.finished'])
    })

    test('that answers after the parent stopped waiting is stopped at once, keeps no listener, and the capture is unavailable', async () => {
      const { diagnostics } = attempt()
      const late = latePage(engine, 1400)
      await diagnostics.start([{ app: 'web', page: late.page, session: sessionOf(engine) }], 200)
      const summary = onlySummary(diagnostics.finish('attempt_ended').summaries)
      assert.deepEqual(summary.console, { state: 'unavailable', reason: 'Retest could not start capture: the page did not answer within 200 ms.' })
      await delay(800)
      assert.ok(late.made(), 'the collector answered in the end')
      assert.equal(late.listening(), 0, 'the late collector was stopped when it answered')
    })
  })
}

// Each engine's own names for its events, as its collector passes them to the capture: Chrome and WebKit speak of a
// `Network` domain, Firefox's WebDriver BiDi of a `network` module.
const eventNames: Readonly<Record<WebEngine, { request: string; network: string; console: string }>> = {
  chromium: { request: 'Network.requestWillBeSent', network: 'Network.responseReceived', console: 'Runtime.consoleAPICalled' },
  firefox: { request: 'network.beforeRequestSent', network: 'network.responseStarted', console: 'log.entryAdded' },
  webkit: { request: 'Network.requestWillBeSent', network: 'Network.loadingFinished', console: 'Console.messageAdded' },
}

for (const engine of engines) {
  test(`a session capture counts an unreadable ${engine} event, and requests past its collector's limit, under the kind each belongs to`, () => {
    const names = eventNames[engine]
    const networkCapture = sessionCapture()
    networkCapture.unreadable(names.network)
    networkCapture.limited(names.request, 2)
    const fromNetwork = networkCapture.finish('attempt_ended', at + 1000)
    assert.ok(fromNetwork.network.state === 'partial', `the network is not complete: ${JSON.stringify(fromNetwork.network)}`)
    assert.equal(fromNetwork.network.reason, "1 network event from the browser could not be read; 2 requests over the collector's tracking limit were dropped")
    assert.equal(fromNetwork.network.dropped, 2)
    assert.equal(fromNetwork.console.state, 'complete', JSON.stringify(fromNetwork.console))
    const consoleCapture = sessionCapture()
    consoleCapture.unreadable(names.console)
    const fromConsole = consoleCapture.finish('attempt_ended', at + 1000)
    assert.ok(fromConsole.console.state === 'partial' && fromConsole.console.reason === '1 console event from the browser could not be read', JSON.stringify(fromConsole.console))
    assert.equal(fromConsole.network.state, 'complete', JSON.stringify(fromConsole.network))
  })
}

test("an unreadable Chrome Page.frameDetached, which ends a frame's requests, makes the network capture partial, not the console", async () => {
  const session = new FakeSession()
  const capture = sessionCapture()
  const collector = new ChromiumCollector({ session, mainFrameId: () => 'MAIN', sink: capture })
  await collector.start(1000)
  session.emit('Page.frameDetached', { reason: 'swap' })
  collector.stop()
  const finished = capture.finish('attempt_ended', at + 1000)
  assert.ok(finished.network.state === 'partial' && finished.network.reason === '1 network event from the browser could not be read', JSON.stringify(finished.network))
  assert.equal(finished.console.state, 'complete', JSON.stringify(finished.console))
})

// WebKit's protocol leaves a message's timestamp optional. A record's time is the engine's, so a message without one is
// counted as unread, never given Retest's own clock in its place.
test("a WebKit console message or uncaught error without the engine's own time leaves no record and makes the console capture partial, and the network stays complete", () => {
  const page = fakeWebKitPage()
  const capture = sessionCapture()
  const collector = new WebKitCollector({ page, sink: capture })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', text: 'no time of its own' } })
  page.tell('Console.messageAdded', { message: { source: 'javascript', level: 'error', text: 'TypeError: thrown with no time' } })
  collector.stop()
  const finished = capture.finish('attempt_ended', at + 1000)
  assert.deepEqual(finished.records.filter((record) => record.type === 'console' || record.type === 'runtime_error'), [], 'no record carries a time the engine did not give')
  assert.ok(finished.console.state === 'partial' && finished.console.reason === '2 console events from the browser could not be read', JSON.stringify(finished.console))
  assert.equal(finished.network.state, 'complete', JSON.stringify(finished.network))
})

test("a WebKit repeat count without the engine's own time leaves the message it repeats once, and makes the console capture partial", () => {
  const page = fakeWebKitPage()
  const capture = sessionCapture()
  const collector = new WebKitCollector({ page, sink: capture })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', text: 'again', timestamp: at / 1000 } })
  page.tell('Console.messageRepeatCountUpdated', { count: 2 })
  collector.stop()
  const finished = capture.finish('attempt_ended', at + 1000)
  const messages = finished.records.filter((record): record is Extract<DiagnosticRecord, { type: 'console' }> => record.type === 'console')
  assert.deepEqual(messages.map((record) => [record.text.text, record.time]), [['again', new Date(at).toISOString()]], 'the stamped message alone, at its own time')
  assert.ok(finished.console.state === 'partial' && finished.console.reason === '1 console event from the browser could not be read', JSON.stringify(finished.console))
})

test('an unreadable event of a kind Retest does not know leaves neither kind complete', () => {
  const capture = sessionCapture()
  capture.unreadable('Browser.somethingNew')
  const finished = capture.finish('attempt_ended', at + 1000)
  assert.ok(finished.console.state === 'partial' && finished.network.state === 'partial', JSON.stringify(finished))
})

test('the Firefox attempt writes unavailable console even after primitive entries, and an unreadable network event cannot turn that refusal into a partial or complete console', async () => {
  const written: string[] = []
  const diagnostics = new AttemptDiagnostics({ policy: defaultDiagnosticsPolicy, redactor: new Redactor(),
    writeArtifact: (_path, bytes) => void written.push(Buffer.from(bytes).toString('utf8')), emit: () => {},
    testId: identity.testId, attemptId: identity.attemptId, variant: undefined, named: true })
  let made: Awaited<ReturnType<typeof startedFirefox>> | undefined
  const subscribed: string[][] = []
  const subscriptions: FirefoxSubscriptions = { subscribe: async (events) => { subscribed.push([...events]) }, unsubscribe: () => {} }
  await diagnostics.start([{ app: 'web', session: sessionOf('firefox'), page: { collectDiagnostics: async (sink) => {
    made = await startedFirefox({ sink, subscriptions })
    return made.collector
  } } }], 1000)
  assert.ok(made !== undefined)
  const rig = made
  try {
    assert.deepEqual(subscribed, [['network.beforeRequestSent', 'network.responseStarted', 'network.responseCompleted', 'network.fetchError']])
    for (const args of [[{ type: 'string', value: 'safe text' }], [{ type: 'number', value: 37 }], [{ type: 'object' }]]) {
      rig.endpoint.emit('log.entryAdded', { type: 'console', method: 'log', level: 'info', timestamp: at, source: { realm: 'r', context: 'tab' }, args })
    }
    rig.endpoint.emit('network.responseStarted', { context: 'tab', timestamp: at })
    rig.endpoint.accept('session.status')
    await rig.client.send('session.status', {})
    const finished = diagnostics.finish('attempt_ended')
    const summary = onlySummary(finished.summaries)
    assert.deepEqual(summary.console, { state: 'unavailable', reason: firefoxConsoleUnavailable })
    assert.ok(summary.network.state === 'partial')
    assert.equal(summary.network.reason, '1 network event from the browser could not be read')
    const lines = written.flatMap((artifact) => {
      const parsed = parseArtifact(artifact, 'firefox-probe.jsonl')
      assert.ok(parsed.ok)
      return parsed.lines
    })
    assert.equal(lines.length, 2, 'only the start and end markers, with no invented console record')
    const ending = lines.at(-1)
    assert.ok(ending?.type === 'capture.finished')
    assert.deepEqual(ending.console, { state: 'unavailable', reason: firefoxConsoleUnavailable })
    assert.equal(rig.listening(), 0)
  } finally {
    rig.collector.stop()
    rig.client.close()
    await rig.endpoint.close()
  }
})
