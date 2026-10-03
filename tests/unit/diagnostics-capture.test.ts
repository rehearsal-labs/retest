import type { DiagnosticLimits, DiagnosticRecord, RecordIdentity } from '../../src/protocol/diagnostics.ts'
import type { Observation } from '../../src/diagnostics/observations.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ChromiumCollector } from '../../src/diagnostics/chromium-collector.ts'
import { consoleText } from '../../src/diagnostics/console-text.ts'
import { AttemptBudget, SessionCapture } from '../../src/diagnostics/session-capture.ts'
import { defaultDiagnosticLimits } from '../../src/protocol/diagnostics.ts'
import { Redactor } from '../../src/runner/redactor.ts'

const identity: RecordIdentity = { testId: 'a.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }
const at = Date.UTC(2026, 9, 3)

function capture(limits: Partial<DiagnosticLimits> = {}, redactor: Redactor = new Redactor(), budget?: AttemptBudget): SessionCapture {
  return new SessionCapture({ identity, budget: budget ?? new AttemptBudget({ ...defaultDiagnosticLimits, ...limits }), redactor, startedAt: at })
}

function feed(target: SessionCapture, observations: readonly Observation[]): void {
  for (const observation of observations) target.observe(observation)
}

function types(records: readonly DiagnosticRecord[], requestId: string): string[] {
  return records.flatMap((record) => ('requestId' in record && record.type !== 'console' && record.requestId === requestId ? [record.type] : []))
}

describe('a session capture', () => {
  test('numbers what it keeps, and correlates each hop of a redirect with the one it led to', () => {
    const session = capture()
    feed(session, [
      { kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: 'hello', time: at },
      { kind: 'runtime_error', key: '1', errorKind: 'uncaught', message: 'Uncaught Error: boom', time: at, stack: [{ line: 1, column: 2 }] },
      { kind: 'request', key: 'r#1', method: 'GET', url: 'http://app.test/redirect?x=1', time: at },
      { kind: 'response', key: 'r#1', status: 302, time: at + 2, redirectedTo: 'r#2' },
      { kind: 'finished', key: 'r#1', time: at + 2, durationMs: 2 },
      { kind: 'request', key: 'r#2', method: 'GET', url: 'http://app.test/final', time: at + 2, redirectedFrom: 'r#1' },
      { kind: 'response', key: 'r#2', status: 200, contentType: 'text/html', time: at + 4, cache: 'none', serviceWorker: false },
      { kind: 'finished', key: 'r#2', time: at + 5, durationMs: 3, transferredBytes: 512 },
    ])
    const finished = session.finish('attempt_ended', at + 10)
    const ids = finished.records.map((record) => (record.type === 'console' || record.type === 'runtime_error' ? record.id : record.requestId))
    assert.deepEqual(ids, ['c1', 'e1', 'n1', 'n1', 'n1', 'n2', 'n2', 'n2'])
    const redirect = finished.records.find((record) => record.type === 'network.response' && record.requestId === 'n1')
    assert.equal(redirect?.type === 'network.response' ? redirect.redirectedTo : undefined, 'n2')
    const next = finished.records.find((record) => record.type === 'network.request' && record.requestId === 'n2')
    assert.equal(next?.type === 'network.request' ? next.redirectedFrom : undefined, 'n1')
    assert.equal(next?.type === 'network.request' ? next.url : undefined, 'http://app.test/final')
    assert.ok(finished.records.every((record) => record.sessionId === identity.sessionId && record.attemptId === identity.attemptId))
    assert.deepEqual(finished.console, { state: 'complete', entries: 1, errors: 0, warnings: 0, runtimeErrors: 1, handledLater: 0, dropped: 0, truncated: 0, bytes: finished.console.state === 'complete' ? finished.console.bytes : 0 })
    assert.ok(finished.network.state === 'complete' && finished.network.requests === 2 && finished.network.pending === 0)
    assert.equal(finished.startedAt, new Date(at).toISOString())
    assert.equal(finished.endedAt, new Date(at + 10).toISOString())
  })

  test('keeps an HTTP error apart from a transport failure, and a cancellation apart from both', () => {
    const session = capture()
    feed(session, [
      { kind: 'request', key: 'a', method: 'GET', url: 'http://app.test/missing', time: at },
      { kind: 'response', key: 'a', status: 404, time: at },
      { kind: 'finished', key: 'a', time: at, durationMs: 1 },
      { kind: 'request', key: 'b', method: 'GET', url: 'http://127.0.0.1:9/refused', time: at },
      { kind: 'failed', key: 'b', time: at, reason: 'net::ERR_CONNECTION_REFUSED' },
      { kind: 'request', key: 'c', method: 'GET', url: 'http://app.test/left', time: at },
      { kind: 'failed', key: 'c', time: at, reason: 'net::ERR_ABORTED', canceled: true },
    ])
    const { network, records } = session.finish('attempt_ended')
    assert.ok(network.state === 'complete')
    assert.deepEqual([network.httpErrors, network.transportFailures, network.canceled], [1, 1, 1])
    assert.deepEqual(types(records, 'n1'), ['network.request', 'network.response', 'network.finished'])
    assert.deepEqual(types(records, 'n2'), ['network.request', 'network.failed'])
    const finished = records.find((record) => record.type === 'network.finished')
    assert.equal(finished?.type === 'network.finished' ? finished.transferredBytes : 'absent', undefined, 'a size the engine did not give is absent, never zero')
  })

  test('counts a failure that ends an error answer with no body once, as the HTTP error, and a rejection handled later apart', () => {
    const session = capture()
    feed(session, [
      { kind: 'request', key: 'a', method: 'GET', url: 'http://app.test/empty-404', time: at },
      { kind: 'response', key: 'a', status: 404, time: at },
      { kind: 'failed', key: 'a', time: at, reason: 'net::ERR_HTTP_RESPONSE_CODE_FAILURE' },
      { kind: 'request', key: 'b', method: 'GET', url: 'http://app.test/streaming', time: at },
      { kind: 'response', key: 'b', status: 200, time: at },
      { kind: 'failed', key: 'b', time: at, reason: 'net::ERR_CONNECTION_RESET' },
      { kind: 'runtime_error', key: '1', errorKind: 'unhandled_rejection', message: 'Uncaught (in promise) Error: late', time: at, stack: [] },
      { kind: 'runtime_error', key: '2', errorKind: 'uncaught', message: 'Uncaught Error: boom', time: at, stack: [] },
      { kind: 'revoked', key: '1' },
    ])
    const { network, console } = session.finish('attempt_ended')
    assert.ok(network.state === 'complete' && console.state === 'complete')
    assert.deepEqual([network.httpErrors, network.transportFailures], [1, 1], 'a body cut after a 200 is still a transport failure')
    assert.deepEqual([console.runtimeErrors, console.handledLater], [1, 1])
  })

  test('marks every hop still open with how far it got and why, once, whatever ends it', () => {
    const session = capture()
    feed(session, [
      { kind: 'request', key: 'a', method: 'GET', url: 'http://app.test/sent', time: at },
      { kind: 'request', key: 'b', method: 'GET', url: 'http://app.test/answered', time: at },
      { kind: 'response', key: 'b', status: 200, time: at },
      { kind: 'request', key: 'c', method: 'GET', url: 'http://app.test/streaming', time: at },
      { kind: 'response', key: 'c', status: 200, time: at },
      { kind: 'data', key: 'c' },
    ])
    const first = session.finish('run_interrupted', at + 5)
    const pending = first.records.filter((record) => record.type === 'network.pending')
    assert.deepEqual(pending.map((record) => (record.type === 'network.pending' ? [record.requestId, record.lastState, record.reason] : [])), [
      ['n1', 'requested', 'run_interrupted'],
      ['n2', 'responded', 'run_interrupted'],
      ['n3', 'receiving', 'run_interrupted'],
    ])
    assert.equal(session.finish('attempt_ended'), first, 'the first ending stands')
  })

  test('a loss makes both kinds partial, marks open hops with it, and ends the capture at that moment', () => {
    const session = capture()
    feed(session, [
      { kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: 'before', time: at },
      { kind: 'request', key: 'a', method: 'GET', url: 'http://app.test/hang', time: at },
    ])
    session.lost({ kind: 'page_crashed', reason: 'the page crashed', time: at + 3 })
    session.observe({ kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: 'after', time: at + 4 })
    const finished = session.finish('attempt_ended', at + 9)
    assert.ok(finished.console.state === 'partial')
    assert.equal(finished.console.reason, `the page crashed at ${new Date(at + 3).toISOString()}, and nothing after it was captured`)
    assert.ok(finished.network.state === 'partial' && finished.network.pending === 1)
    assert.deepEqual(finished.records.flatMap((record) => (record.type === 'console' ? [record.text.text] : [])), ['before'])
    const pending = finished.records.find((record) => record.type === 'network.pending')
    assert.equal(pending?.type === 'network.pending' ? pending.reason : undefined, 'page_crashed')
    assert.equal(finished.endedAt, new Date(at + 3).toISOString())
  })

  test('redacts every text before it cuts it, cleans every address, and holds back a cut that may start a secret', () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-value')
    const session = capture({ textLength: 41 }, redactor)
    const huge = `${'x'.repeat(155)}hunter2-va`
    feed(session, [
      { kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: 'token hunter2-value at http://app.test/p?token=hunter2-value', time: at },
      { kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: `${huge}lue and more`, time: at },
      { kind: 'request', key: 'a', method: 'GET', url: 'http://app.test/echo/hunter2-value?q=1', time: at },
    ])
    const { records, console } = session.finish('attempt_ended')
    const [first, second] = records.flatMap((record) => (record.type === 'console' ? [record.text] : []))
    assert.deepEqual(first, { text: 'token {{password}} at http://app.test/p?…', truncated: false, length: 41 })
    assert.equal(second?.truncated, true)
    assert.equal(second?.length, huge.length + 'lue and more'.length)
    assert.equal(second?.text.includes('hunter2'), false)
    const request = records.find((record) => record.type === 'network.request')
    assert.equal(request?.type === 'network.request' ? request.url : undefined, 'http://app.test/echo/{{password}}?…')
    assert.ok(console.state === 'complete' && console.truncated === 1, 'only the long message was cut')
  })

  test('finds a secret with quotes and backslashes, and one in a function source past any cut, before writing them', () => {
    const redactor = new Redactor()
    redactor.learn('password', 'pa"ss\\word9')
    redactor.learn('token', 'SECRETSECRETSECRET20')
    const session = capture({}, redactor)
    const objectText = consoleText([{ type: 'object', description: 'Object', preview: { type: 'object', overflow: false, properties: [{ name: 'short', type: 'string', value: 'pa"ss\\word9' }] } }])
    const functionSource = consoleText([{ type: 'function', description: `() => "${'z'.repeat(63)}SECRETSECRETSECRET20"` }])
    feed(session, [
      { kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: objectText, time: at },
      { kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: functionSource, time: at },
    ])
    const texts = session.finish('attempt_ended').records.flatMap((record) => (record.type === 'console' ? [record.text.text] : []))
    assert.deepEqual(texts, ['{short: "{{password}}"}', `() => "${'z'.repeat(63)}{{token}}"`])
    assert.equal(JSON.stringify(texts).includes('ss\\\\word9'), false, 'not even in its escaped form')
  })

  test('drops what arrives past the entry limit, counts it, and makes the kind partial', () => {
    const session = capture({ consoleEntries: 2 })
    for (let index = 0; index < 5; index += 1) session.observe({ kind: 'console', consoleType: 'log', level: 'error', origin: 'page', text: `m${index}`, time: at })
    const { console, records } = session.finish('attempt_ended')
    assert.ok(console.state === 'partial')
    assert.deepEqual([console.entries, console.errors, console.dropped], [2, 2, 3])
    assert.equal(console.reason, "3 messages over the attempt's limits were dropped")
    assert.deepEqual(records.map((record) => (record.type === 'console' ? record.id : '')), ['c1', 'c2'])
  })

  test('keeps a hop only while the attempt can hold its later records, so a kept hop never loses its response', () => {
    const budget = new AttemptBudget({ ...defaultDiagnosticLimits, networkBytes: 12_000 })
    const session = capture({}, new Redactor(), budget)
    for (let index = 0; index < 10; index += 1) session.observe({ kind: 'request', key: `k${index}`, method: 'GET', url: `http://app.test/${index}`, time: at })
    for (let index = 0; index < 10; index += 1) {
      session.observe({ kind: 'response', key: `k${index}`, status: 200, statusText: 'OK'.repeat(200), contentType: 'text/plain', time: at })
      session.observe({ kind: 'failed', key: `k${index}`, time: at, reason: 'net::ERR_FAILED'.repeat(30), blocked: 'other'.repeat(30) })
    }
    const { network, records } = session.finish('attempt_ended')
    assert.ok(network.state === 'partial' && network.dropped > 0 && network.requests > 0, JSON.stringify(network))
    assert.ok(network.bytes <= 12_000, `the artifact holds ${network.bytes} bytes`)
    for (const record of records) if (record.type === 'network.request') assert.deepEqual(types(records, record.requestId), ['network.request', 'network.response', 'network.failed'])
  })

  test('shares the attempt limits between its sessions', () => {
    const budget = new AttemptBudget({ ...defaultDiagnosticLimits, requests: 3 })
    const one = capture({}, new Redactor(), budget)
    const two = capture({}, new Redactor(), budget)
    for (let index = 0; index < 2; index += 1) {
      one.observe({ kind: 'request', key: `a${index}`, method: 'GET', url: 'http://app.test/a', time: at })
      two.observe({ kind: 'request', key: `b${index}`, method: 'GET', url: 'http://app.test/b', time: at })
    }
    const first = one.finish('attempt_ended').network
    const second = two.finish('attempt_ended').network
    assert.equal((first.state === 'complete' || first.state === 'partial' ? first.requests : 0) + (second.state === 'complete' || second.state === 'partial' ? second.requests : 0), 3)
    assert.equal(budget.requests, 3)
  })

  test('counts an event it could not read and says so', () => {
    const session = capture()
    session.unreadable('Network.responseReceived')
    session.unreadable('Runtime.consoleAPICalled')
    const { console, network } = session.finish('attempt_ended')
    assert.deepEqual([console.state === 'partial' ? console.reason : '', network.state === 'partial' ? network.reason : ''], ['1 console event from the browser could not be read', '1 network event from the browser could not be read'])
  })
})

/** A CDP session double: events a test sends, the listeners alive, and the commands the collector sent. */
class FakeSession {
  readonly listeners = new Map<string, Set<(params: unknown) => void>>()
  readonly detaches = new Set<(reason: string) => void>()
  readonly sent: string[] = []

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
    this.sent.push(method)
    return {}
  }

  emit(method: string, params: unknown): void {
    for (const listener of [...(this.listeners.get(method) ?? [])]) listener(params)
  }

  get alive(): number {
    return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) + this.detaches.size
  }
}

describe('the Chromium collector', () => {
  function collect(): { session: FakeSession; observed: Observation[]; unread: string[]; losses: string[]; collector: ChromiumCollector } {
    const session = new FakeSession()
    const observed: Observation[] = []
    const unread: string[] = []
    const losses: string[] = []
    const collector = new ChromiumCollector({ session, mainFrameId: () => 'MAIN', sink: { observe: (item) => void observed.push(item), unreadable: (method) => void unread.push(method), lost: (loss) => void losses.push(loss.kind) } })
    return { session, observed, unread, losses, collector }
  }

  test('enables Runtime, Log and Network, and sends nothing after that', async () => {
    const { session, collector } = collect()
    await collector.start(1000)
    assert.deepEqual(session.sent, ['Runtime.enable', 'Log.enable', 'Network.enable'])
  })

  test('reads a console call from a frame main world, and leaves out any other world', () => {
    const { session, observed } = collect()
    session.emit('Runtime.executionContextCreated', { context: { id: 1, auxData: { isDefault: true, frameId: 'MAIN' } } })
    session.emit('Runtime.executionContextCreated', { context: { id: 2, auxData: { isDefault: false, frameId: 'MAIN' } } })
    session.emit('Runtime.executionContextCreated', { context: { id: 3, auxData: { isDefault: true, frameId: 'CHILD' } } })
    const call = (id: number, text: string) => ({ type: 'warning', args: [{ type: 'string', value: text }], executionContextId: id, timestamp: at, stackTrace: { callFrames: [{ functionName: 'f', url: 'http://app.test/', lineNumber: 4, columnNumber: 0, scriptId: '1' }] }, objectId: 'never-read' })
    session.emit('Runtime.consoleAPICalled', call(1, 'main'))
    session.emit('Runtime.consoleAPICalled', call(2, 'isolated'))
    session.emit('Runtime.consoleAPICalled', call(3, 'child'))
    assert.deepEqual(observed, [
      { kind: 'console', consoleType: 'warning', level: 'warning', origin: 'page', text: 'main', time: at, url: 'http://app.test/', line: 5, column: 1, frame: 'main' },
      { kind: 'console', consoleType: 'warning', level: 'warning', origin: 'page', text: 'child', time: at, url: 'http://app.test/', line: 5, column: 1, frame: 'child' },
    ])
  })

  test('turns Chrome redirects into hops, measures each on the browser clock, and names a browser entry about a request', () => {
    const { session, observed } = collect()
    const request = (url: string, timestamp: number, redirectResponse?: object) => ({ requestId: 'R', loaderId: 'L', documentURL: 'http://app.test/', request: { url, method: 'GET', headers: { authorization: 'Bearer x' } }, timestamp, wallTime: 1000 + timestamp, type: 'Fetch', frameId: 'MAIN', ...(redirectResponse === undefined ? {} : { redirectResponse }) })
    session.emit('Network.requestWillBeSent', request('http://app.test/a', 1))
    session.emit('Network.requestWillBeSent', request('http://app.test/b', 1.002, { url: 'http://app.test/a', status: 302, statusText: 'Found', headers: { 'set-cookie': 'x' }, mimeType: '', fromDiskCache: false, responseTime: 1001001.5, encodedDataLength: 120 }))
    session.emit('Network.responseReceived', { requestId: 'R', timestamp: 1.004, response: { url: 'http://app.test/b', status: 404, statusText: 'Not Found', mimeType: 'text/plain', fromDiskCache: false, fromServiceWorker: false, headers: {} } })
    session.emit('Log.entryAdded', { entry: { source: 'network', level: 'error', text: 'Failed to load resource: 404', timestamp: at, url: 'http://app.test/b', networkRequestId: 'R' } })
    session.emit('Network.loadingFinished', { requestId: 'R', timestamp: 1.0055, encodedDataLength: 300 })
    assert.deepEqual(observed.map((item) => item.kind), ['request', 'response', 'finished', 'request', 'response', 'console', 'finished'])
    assert.deepEqual(observed[1], { kind: 'response', status: 302, statusText: 'Found', cache: 'none', key: 'R#1', time: 1001001.5, redirectedTo: 'R#2' })
    assert.deepEqual(observed[2], { kind: 'finished', key: 'R#1', time: 1001001.5, durationMs: 2, transferredBytes: 120 })
    assert.deepEqual(observed[3], { kind: 'request', key: 'R#2', method: 'GET', url: 'http://app.test/b', resourceType: 'Fetch', time: 1001002, frame: 'main', redirectedFrom: 'R#1' })
    assert.equal(observed[5]?.kind === 'console' ? observed[5].requestKey : undefined, 'R#2')
    assert.equal(observed[6]?.kind === 'finished' ? observed[6].durationMs : undefined, 3.5)
    assert.equal(JSON.stringify(observed).includes('Bearer'), false, 'no header is copied')
  })

  test("hands a worker's own script and a frame that moved to another site's process outside the scope", () => {
    const { session, observed } = collect()
    session.emit('Network.requestWillBeSent', { requestId: 'W', loaderId: '', documentURL: 'http://app.test/worker.js', request: { url: 'http://app.test/worker.js', method: 'GET' }, timestamp: 1, wallTime: 1001, type: 'Script', frameId: 'MAIN' })
    session.emit('Network.requestWillBeSent', { requestId: 'F', loaderId: 'F', documentURL: 'http://other.test/', request: { url: 'http://other.test/', method: 'GET' }, timestamp: 1, wallTime: 1001, type: 'Document', frameId: 'CHILD' })
    session.emit('Page.frameDetached', { frameId: 'CHILD', reason: 'swap' })
    assert.deepEqual(observed.filter((item) => item.kind === 'left').map((item) => (item.kind === 'left' ? item.key : '')), ['W#1', 'F#1'])
  })

  test('reads an uncaught error and a rejection with their stacks, and a later revocation', () => {
    const { session, observed } = collect()
    const details = (text: string) => ({ exceptionId: 7, text, lineNumber: 2, columnNumber: 4, url: 'http://app.test/app.js', stackTrace: { callFrames: [{ functionName: 'boom', url: 'http://app.test/app.js', lineNumber: 2, columnNumber: 4 }] }, exception: { type: 'object', subtype: 'error', description: 'Error: kaput\n    at boom (http://app.test/app.js:3:5)' } })
    session.emit('Runtime.exceptionThrown', { timestamp: at, exceptionDetails: details('Uncaught (in promise)') })
    session.emit('Runtime.exceptionRevoked', { exceptionId: 7, reason: 'Handler added' })
    session.emit('Runtime.exceptionThrown', { timestamp: at, exceptionDetails: { exceptionId: 8, text: 'Uncaught SyntaxError: Unexpected token', lineNumber: 0, columnNumber: 0, exception: { type: 'object', subtype: 'error', description: 'SyntaxError: Unexpected token' } } })
    session.emit('Runtime.exceptionThrown', { timestamp: at, exceptionDetails: { exceptionId: 9, text: 'Uncaught', lineNumber: 0, columnNumber: 0, exception: { type: 'string', value: 'a plain string' } } })
    assert.deepEqual(observed.slice(2).map((item) => (item.kind === 'runtime_error' ? item.message : '')), ['Uncaught SyntaxError: Unexpected token', 'Uncaught a plain string'])
    assert.deepEqual(observed.slice(0, 2), [
      { kind: 'runtime_error', key: '7', errorKind: 'unhandled_rejection', message: 'Uncaught (in promise) Error: kaput', time: at, url: 'http://app.test/app.js', line: 3, column: 5, stack: [{ function: 'boom', url: 'http://app.test/app.js', line: 3, column: 5 }] },
      { kind: 'revoked', key: '7' },
    ])
  })

  test('counts an event it cannot read, reports a crash and a detach once, and removes every listener when it stops', () => {
    const { session, unread, losses, collector } = collect()
    const listening = session.alive
    assert.ok(listening > 10)
    session.emit('Network.responseReceived', { requestId: 'R', timestamp: 'soon' })
    assert.deepEqual(unread, ['Network.responseReceived'])
    session.emit('Inspector.targetCrashed', {})
    for (const detach of [...session.detaches]) detach('the target detached')
    assert.deepEqual(losses, ['page_crashed'], 'the first loss stops the collector')
    assert.equal(session.alive, 0, 'no listener survives the collector')
    collector.stop()
    assert.equal(session.alive, 0)
  })

  test('stops itself and rejects when the page does not enable a domain', async () => {
    const session = new FakeSession()
    session.send = async (method: string) => {
      session.sent.push(method)
      if (method === 'Network.enable') throw new Error('Could not enable the network domain')
      return {}
    }
    const collector = new ChromiumCollector({ session, mainFrameId: () => 'MAIN', sink: { observe: () => undefined, unreadable: () => undefined, lost: () => undefined } })
    await assert.rejects(collector.start(1000), /Could not enable the network domain/)
    assert.equal(session.alive, 0)
  })
})
