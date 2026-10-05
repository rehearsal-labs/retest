import type { TargetEvent } from '../../src/browser/webkit/connection.ts'
import type { PageLoss } from '../../src/browser/webkit/page.ts'
import type { CollectorLoss, DiagnosticSink, Observation } from '../../src/diagnostics/observations.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WebKitCollector, webKitScope } from '../../src/diagnostics/webkit-collector.ts'

/** A page whose target events, provisional target and end a test tells. */
function fakePage() {
  const events = new Set<(event: TargetEvent) => void>()
  const losses = new Set<(loss: PageLoss) => void>()
  let provisionalTargetId: string | undefined
  return {
    mainFrameId: 'frame-1',
    get provisionalTargetId() {
      return provisionalTargetId
    },
    swapInto: (targetId: string | undefined) => {
      provisionalTargetId = targetId
    },
    onTargetEvent: (listener: (event: TargetEvent) => void) => {
      events.add(listener)
      return () => events.delete(listener)
    },
    onLost: (listener: (loss: PageLoss) => void) => {
      losses.add(listener)
      return () => losses.delete(listener)
    },
    tell: (method: string, params: object, targetId = 'page-8') => {
      for (const listener of [...events]) listener({ pageProxyId: '7', targetId, method, params })
    },
    lose: (loss: PageLoss) => {
      for (const listener of [...losses]) listener(loss)
    },
    listening: () => events.size + losses.size,
  }
}

function recordingSink(): DiagnosticSink & { observations: Observation[]; unreadables: string[]; losses: CollectorLoss[] } {
  const observations: Observation[] = []
  const unreadables: string[] = []
  const losses: CollectorLoss[] = []
  return {
    observations,
    unreadables,
    losses,
    observe: (observation) => observations.push(observation),
    unreadable: (method) => unreadables.push(method),
    lost: (loss) => losses.push(loss),
  }
}

function collect() {
  const page = fakePage()
  const sink = recordingSink()
  const collector = new WebKitCollector({ page, sink })
  return { page, sink, collector }
}

test("the page's console calls are console records, named as Chromium names them, their text read from the arguments", () => {
  const { page, sink } = collect()
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', type: 'log', text: 'saved 3', parameters: [{ type: 'string', value: 'saved' }, { type: 'number', value: 3, description: '3' }], url: 'http://app.test/', line: 4, column: 9, timestamp: 1791150000.5 } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'warning', type: 'log', text: 'careful', timestamp: 1791150001 } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'error', type: 'assert', text: 'Assertion failed', timestamp: 1791150001.5 } })
  const [log, warning, assertion] = sink.observations
  assert.deepEqual(log, { kind: 'console', consoleType: 'log', level: 'info', origin: 'page', text: 'saved 3', time: 1791150000500, url: 'http://app.test/', line: 4, column: 9 })
  assert.deepEqual([warning?.kind === 'console' && warning.consoleType, warning?.kind === 'console' && warning.level, warning?.kind === 'console' && warning.time], ['warning', 'warning', 1791150001000])
  assert.deepEqual([assertion?.kind === 'console' && assertion.consoleType, assertion?.kind === 'console' && assertion.level], ['assert', 'error'])
})

test('an uncaught error and an unhandled rejection are runtime errors with their stack, lines and columns from 1 as WebKit numbers them', () => {
  const { page, sink } = collect()
  page.tell('Console.messageAdded', { message: { source: 'javascript', level: 'error', text: 'TypeError: x is not a function', url: 'http://app.test/app.js', line: 12, column: 5, stackTrace: { callFrames: [{ functionName: 'save', url: 'http://app.test/app.js', scriptId: '3', lineNumber: 12, columnNumber: 5 }] }, timestamp: 1791150002 } })
  page.tell('Console.messageAdded', { message: { source: 'javascript', level: 'error', text: 'Unhandled Promise Rejection: Error: late', timestamp: 1791150002.5 } })
  const [uncaught, rejection] = sink.observations
  assert.deepEqual(uncaught, { kind: 'runtime_error', key: 'webkit-error-1', errorKind: 'uncaught', message: 'TypeError: x is not a function', time: 1791150002000, url: 'http://app.test/app.js', line: 12, column: 5, stack: [{ function: 'save', url: 'http://app.test/app.js', line: 12, column: 5 }] })
  assert.equal(rejection?.kind === 'runtime_error' ? rejection.errorKind : undefined, 'unhandled_rejection')
})

test("a message WebKit folds into a repeat count is recorded again for each repeat, and the browser's own messages name their source and request", () => {
  const { page, sink } = collect()
  page.tell('Network.requestWillBeSent', { requestId: '5.1', frameId: 'frame-1', loaderId: 'L', request: { url: 'http://app.test/missing', method: 'GET' }, timestamp: 10, walltime: 1791150010, type: 'Fetch' })
  page.tell('Console.messageAdded', { message: { source: 'network', level: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)', networkRequestId: '5.1', timestamp: 1791150011 } })
  page.tell('Console.messageRepeatCountUpdated', { count: 2, timestamp: 1791150012 })
  const browserMessages = sink.observations.filter((observation) => observation.kind === 'console')
  assert.equal(browserMessages.length, 2)
  assert.deepEqual(browserMessages.map((observation) => observation.kind === 'console' && [observation.origin, observation.source, observation.requestKey, observation.time]), [
    ['browser', 'network', '5.1#1', 1791150011000],
    ['browser', 'network', '5.1#1', 1791150012000],
  ])
})

test('a request, its response, data and end are network records on the wall clock, timed by the browser, with what reached Retest', () => {
  const { page, sink } = collect()
  page.tell('Network.requestWillBeSent', { requestId: '5.2', frameId: 'frame-1', loaderId: 'L', documentURL: 'http://app.test/', request: { url: 'http://app.test/api/tasks', method: 'POST', headers: { cookie: 'secret' }, postData: 'secret body' }, timestamp: 100, walltime: 1791150100, type: 'XHR' })
  page.tell('Network.responseReceived', { requestId: '5.2', timestamp: 100.25, type: 'XHR', response: { url: 'http://app.test/api/tasks', status: 201, statusText: 'Created', mimeType: 'application/json', source: 'network', headers: { 'set-cookie': 'secret' } } })
  page.tell('Network.dataReceived', { requestId: '5.2', timestamp: 100.3, dataLength: 2, encodedDataLength: 2 })
  page.tell('Network.loadingFinished', { requestId: '5.2', timestamp: 100.5, metrics: { protocol: 'http/1.1', responseHeaderBytesReceived: 120, responseBodyBytesReceived: 2 } })
  assert.deepEqual(sink.observations, [
    { kind: 'request', key: '5.2#1', method: 'POST', url: 'http://app.test/api/tasks', resourceType: 'XHR', time: 1791150100000, frame: 'main' },
    { kind: 'response', status: 201, statusText: 'Created', contentType: 'application/json', cache: 'none', serviceWorker: false, key: '5.2#1', time: 1791150100250 },
    { kind: 'data', key: '5.2#1' },
    { kind: 'finished', key: '5.2#1', time: 1791150100500, durationMs: 500, transferredBytes: 122 },
  ])
  assert.ok(!JSON.stringify(sink.observations).includes('secret'), 'no header and no body is copied')
})

test('a redirect ends one hop with its response and starts the next under the same request id; a failure and a cancel say which', () => {
  const { page, sink } = collect()
  page.tell('Network.requestWillBeSent', { requestId: '5.3', frameId: 'frame-1', request: { url: 'http://app.test/old', method: 'GET' }, timestamp: 1, walltime: 1000, type: 'Document' })
  page.tell('Network.requestWillBeSent', { requestId: '5.3', frameId: 'frame-1', request: { url: 'http://app.test/new', method: 'GET' }, timestamp: 1.1, walltime: 1000.1, type: 'Document', redirectResponse: { url: 'http://app.test/old', status: 302, statusText: 'Found', mimeType: 'text/html', source: 'network' } })
  page.tell('Network.loadingFailed', { requestId: '5.3', timestamp: 1.2, errorText: 'Frame load interrupted', canceled: true })
  page.tell('Network.requestWillBeSent', { requestId: '5.4', frameId: 'frame-9', request: { url: 'http://app.test/frame', method: 'GET' }, timestamp: 2, walltime: 1001 })
  page.tell('Network.loadingFailed', { requestId: '5.4', timestamp: 2.5, errorText: 'Could not connect to the server.' })
  const kinds = sink.observations.map((observation) => `${observation.kind} ${'key' in observation ? observation.key : ''}`)
  assert.deepEqual(kinds, ['request 5.3#1', 'response 5.3#1', 'finished 5.3#1', 'request 5.3#2', 'failed 5.3#2', 'request 5.4#1', 'failed 5.4#1'])
  const redirected = sink.observations[1]
  assert.equal(redirected?.kind === 'response' ? redirected.redirectedTo : undefined, '5.3#2')
  const next = sink.observations[3]
  assert.equal(next?.kind === 'request' ? next.redirectedFrom : undefined, '5.3#1')
  const canceled = sink.observations[4]
  assert.deepEqual(canceled?.kind === 'failed' ? [canceled.reason, canceled.canceled] : [], ['Frame load interrupted', true])
  const child = sink.observations[5]
  assert.equal(child?.kind === 'request' ? child.frame : undefined, 'child')
})

test("a resource from WebKit's memory cache is one record of each kind, and a request of a target a navigation left is told as left", () => {
  const { page, sink } = collect()
  page.tell('Page.frameNavigated', { frame: { id: 'frame-1', loaderId: 'L1', url: 'http://app.test/' } }, 'page-8')
  page.tell('Network.requestServedFromMemoryCache', { requestId: '5.5', frameId: 'frame-1', loaderId: 'L1', documentURL: 'http://app.test/', timestamp: 3, initiator: { type: 'parser' }, resource: { url: 'http://app.test/logo.png', type: 'Image', response: { url: 'http://app.test/logo.png', status: 200, mimeType: 'image/png', source: 'memory-cache' } } })
  page.tell('Network.requestWillBeSent', { requestId: '5.6', frameId: 'frame-1', request: { url: 'http://app.test/slow', method: 'GET' }, timestamp: 4, walltime: 2000 })
  page.tell('Page.frameNavigated', { frame: { id: 'frame-2', loaderId: 'L2', url: 'http://other.test/' } }, 'page-50')
  const kinds = sink.observations.map((observation) => observation.kind)
  assert.deepEqual(kinds, ['request', 'response', 'finished', 'request', 'left'])
  const cached = sink.observations[1]
  assert.equal(cached?.kind === 'response' ? cached.cache : undefined, 'memory')
})

test("an event Retest cannot read is counted, never guessed at; the page's end is told once and stops the collector", () => {
  const { page, sink, collector } = collect()
  page.tell('Network.responseReceived', { requestId: 7 })
  assert.deepEqual(sink.unreadables, ['Network.responseReceived'])
  page.lose({ reason: 'the page crashed', crashed: true })
  assert.equal(sink.losses.length, 1)
  assert.deepEqual([sink.losses[0]?.kind, sink.losses[0]?.reason], ['page_crashed', 'the page crashed'])
  assert.equal(page.listening(), 0)
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', text: 'after', timestamp: 1791150003 } })
  assert.equal(sink.observations.length, 0)
  collector.stop()
})

test('the scope says what the page target covers, and names the rest as not covered', () => {
  assert.equal(webKitScope.engine, 'webkit')
  // Frames' messages now name their frame, so the console covers the frames whose messages it hears.
  assert.deepEqual(webKitScope.console.covered, ['top_level_document', 'same_process_frames', 'out_of_process_frames'])
  assert.ok(webKitScope.network.notCovered.includes('service_workers'))
})

const webAreas = ['top_level_document', 'same_process_frames', 'out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers']

test("the network and the console cover the frames in the page's process, whose records name their frame; each area is named once; the reason names what WebKit does not give", { timeout: 10_000 }, () => {
  assert.deepEqual(webKitScope.network.covered, ['top_level_document', 'same_process_frames', 'out_of_process_frames'])
  for (const kind of [webKitScope.console, webKitScope.network]) assert.deepEqual([...kind.covered, ...kind.notCovered].sort(), [...webAreas].sort())
  assert.ok(webKitScope.network.notCovered.includes('dedicated_workers'), "a worker's requests are not the page's")
  assert.match(webKitScope.reason ?? '', /names no frame unless it is about a request/)
  assert.match(webKitScope.reason ?? '', /protocol/)
})

test("the document a navigation into another web process loads in its provisional target is the main frame's; a frame's document on the page's target stays a child's", { timeout: 10_000 }, () => {
  const { page, sink } = collect()
  page.swapInto('page-50')
  page.tell('Network.requestWillBeSent', { requestId: '9.1', frameId: 'frame-50', loaderId: 'L50', documentURL: 'http://localhost:4173/next', request: { url: 'http://localhost:4173/next', method: 'GET' }, timestamp: 5, walltime: 3000, type: 'Document' }, 'page-50')
  page.tell('Network.requestWillBeSent', { requestId: '9.1', frameId: 'frame-50', loaderId: 'L50', request: { url: 'http://localhost:4173/after', method: 'GET' }, timestamp: 5.1, walltime: 3000.1, type: 'Document', redirectResponse: { url: 'http://localhost:4173/next', status: 302, source: 'network' } }, 'page-50')
  page.tell('Network.requestWillBeSent', { requestId: '9.2', frameId: 'frame-7', loaderId: 'L7', request: { url: 'http://127.0.0.1:4173/frame', method: 'GET' }, timestamp: 5.2, walltime: 3000.2, type: 'Document' }, 'page-8')
  page.swapInto(undefined)
  page.tell('Network.requestWillBeSent', { requestId: '9.3', frameId: 'frame-51', loaderId: 'L51', request: { url: 'http://localhost:4173/other', method: 'GET' }, timestamp: 6, walltime: 3001, type: 'Document' }, 'page-50')
  const requests = sink.observations.flatMap((observation) => (observation.kind === 'request' ? [[observation.url, observation.frame]] : []))
  assert.deepEqual(requests, [
    ['http://localhost:4173/next', 'main'],
    ['http://localhost:4173/after', 'main'],
    ['http://127.0.0.1:4173/frame', 'child'],
    ['http://localhost:4173/other', 'child'],
  ])
})

// WebKit's own event for `console.log('first', 42, { saved: true, title: 'Release checklist' }, [1, 2, 3])` and for
// `console.table([{ a: 1 }])` on build 2359, as /tmp/retest-diag-probe-webkit-args.log recorded them.
const fourArguments = { message: { source: 'console-api', level: 'log', text: 'first', type: 'log', line: 1, column: 65, url: 'http://127.0.0.1:49356/', repeatCount: 1, timestamp: 1791171928.848924, parameters: [{ type: 'string', value: 'first' }, { type: 'number', value: 42, description: '42' }, { type: 'object', objectId: '{"injectedScriptId":3,"id":1}', className: 'Object', description: 'Object', preview: { type: 'object', description: 'Object', lossless: true, properties: [{ name: 'saved', type: 'boolean', value: 'true' }, { name: 'title', type: 'string', value: 'Release checklist' }] } }, { type: 'object', objectId: '{"injectedScriptId":3,"id":2}', subtype: 'array', className: 'Array', description: 'Array', size: 3, preview: { type: 'object', description: 'Array', lossless: true, subtype: 'array', overflow: false, properties: [{ name: '0', type: 'number', value: '1' }, { name: '1', type: 'number', value: '2' }, { name: '2', type: 'number', value: '3' }], size: 3 } }], stackTrace: { callFrames: [{ functionName: 'global code', url: 'http://127.0.0.1:49356/', scriptId: '2', lineNumber: 1, columnNumber: 65 }] } } }
const table = { message: { source: 'console-api', level: 'log', text: '[object Object]', type: 'table', line: 1, column: 175, url: 'http://127.0.0.1:49356/', repeatCount: 1, timestamp: 1791171928.851622, parameters: [{ type: 'object', objectId: '{"injectedScriptId":3,"id":3}', subtype: 'array', className: 'Array', description: 'Array', size: 1, preview: { type: 'object', description: 'Array', lossless: true, subtype: 'array', overflow: false, properties: [{ name: '0', type: 'object', valuePreview: { type: 'object', description: 'Object', lossless: true, properties: [{ name: 'a', type: 'number', value: '1' }] } }], size: 1 } }], stackTrace: { callFrames: [{ functionName: 'global code', url: 'http://127.0.0.1:49356/', scriptId: '2', lineNumber: 1, columnNumber: 175 }] } } }

test("a message's text holds every argument as WebKit sends it, a plain object whose preview leaves out `overflow` among them, as Chromium's text reads", { timeout: 10_000 }, () => {
  const { page, sink } = collect()
  page.tell('Console.messageAdded', fourArguments)
  page.tell('Console.messageAdded', table)
  const texts = sink.observations.map((observation) => (observation.kind === 'console' ? observation.text : undefined))
  assert.deepEqual(texts, ['first 42 {saved: true, title: "Release checklist"} [1, 2, 3]', '[Object]'])
  assert.deepEqual(sink.unreadables, [])
  assert.ok(!JSON.stringify(sink.observations).includes('injectedScriptId'), "no object's handle is kept")
})

test('an argument WebKit sends in a form Retest cannot read stands as (cut); properties left out, or a preview without its properties, read as left out; a collection carries its size', { timeout: 10_000 }, () => {
  const { page, sink } = collect()
  const parameters = [
    { type: 'string', value: 'tasks' },
    { value: 3 },
    { type: 'object', subtype: 'map', className: 'Map', description: 'Map', size: 2, objectId: 'map', preview: { type: 'object', subtype: 'map', description: 'Map', lossless: false, size: 2, entries: [{ key: { type: 'string', description: 'a', lossless: true }, value: { type: 'number', description: '1', lossless: true } }], properties: [] } },
    { type: 'object', className: 'Object', description: 'Object', objectId: 'wide', preview: { type: 'object', description: 'Object', lossless: false, overflow: true, properties: [{ name: 'a', type: 'number', value: '1' }] } },
    { type: 'object', className: 'Object', description: 'Object', objectId: 'unfinished', preview: { type: 'object', description: 'Object', lossless: false } },
  ]
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', type: 'log', text: 'tasks', parameters, timestamp: 1791150003 } })
  const [message] = sink.observations
  assert.equal(message?.kind === 'console' ? message.text : undefined, 'tasks (cut) Map(2) {a: 1, …} {…}')
})

test("a console message and an uncaught error name their frame where WebKit names the script's context and the context's frame, and name none where it does not", { timeout: 10_000 }, () => {
  const { page, sink } = collect()
  page.tell('Runtime.executionContextCreated', { context: { id: 3, type: 'normal', name: '', frameId: 'frame-1' } })
  page.tell('Runtime.executionContextCreated', { context: { id: 4, type: 'normal', name: '', frameId: 'frame-7' } })
  page.tell('Debugger.scriptParsed', { scriptId: '20', url: 'http://app.test/', startLine: 0, startColumn: 0, endLine: 9, endColumn: 0, executionContextId: 3, scriptType: 'classic' })
  page.tell('Debugger.scriptParsed', { scriptId: '21', url: 'http://app.test/frame', startLine: 0, startColumn: 0, endLine: 9, endColumn: 0, executionContextId: 4, scriptType: 'classic' })
  const from = (scriptId: string) => ({ callFrames: [{ functionName: 'global code', url: 'http://app.test/', scriptId, lineNumber: 1, columnNumber: 1 }] })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', type: 'log', text: 'document', parameters: [{ type: 'string', value: 'document' }], stackTrace: from('20'), timestamp: 1791150004 } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'error', type: 'log', text: 'frame', parameters: [{ type: 'string', value: 'frame' }], stackTrace: from('21'), timestamp: 1791150005 } })
  page.tell('Console.messageAdded', { message: { source: 'javascript', level: 'error', text: 'Error: in the frame', stackTrace: from('21'), timestamp: 1791150006 } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', type: 'log', text: 'unknown script', parameters: [{ type: 'string', value: 'unknown script' }], stackTrace: from('99'), timestamp: 1791150007 } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', type: 'log', text: 'no stack', timestamp: 1791150008 } })
  const frames = sink.observations.map((observation) => (observation.kind === 'console' ? [observation.text, observation.frame] : observation.kind === 'runtime_error' ? [observation.message, observation.frame] : []))
  assert.deepEqual(frames, [
    ['document', 'main'],
    ['frame', 'child'],
    ['Error: in the frame', 'child'],
    ['unknown script', undefined],
    ['no stack', undefined],
  ])
  assert.deepEqual(sink.unreadables, [])
})

// D-8: a message with no time of its own once took the parent's clock, presented as the engine's.
test("a console message or a repeat with no time of its own is counted as unread, never given the parent's clock", { timeout: 10_000 }, () => {
  const { page, sink } = collect()
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', type: 'log', text: 'timeless' } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'log', type: 'log', text: 'timed', timestamp: 1791150004 } })
  page.tell('Console.messageRepeatCountUpdated', { count: 2 })
  assert.deepEqual(sink.observations.map((observation) => (observation.kind === 'console' ? [observation.text, observation.time] : observation.kind)), [['timed', 1791150004000]])
  assert.deepEqual(sink.unreadables, ['Console.messageAdded', 'Console.messageRepeatCountUpdated'])
})

// D-10 and the scope: a frame's message, and one the browser logs about a frame's request, carry the frame; a worker's
// own request, outside the scope, leaves no record, while its script, which the page loads, is the page's.
test("a message the browser logs about a frame's request names that frame, and a worker's own request leaves no record while its script is the page's", { timeout: 10_000 }, () => {
  const { page, sink } = collect()
  page.tell('Network.requestWillBeSent', { requestId: '6.1', frameId: 'frame-9', loaderId: 'L9', request: { url: 'http://other.test/missing', method: 'GET' }, timestamp: 20, walltime: 1791150020, type: 'Fetch' })
  page.tell('Console.messageAdded', { message: { source: 'network', level: 'error', text: 'Failed to load resource', networkRequestId: '6.1', timestamp: 1791150021 } })
  page.tell('Network.requestWillBeSent', { requestId: '6.2', frameId: 'frame-1', loaderId: 'L1', targetId: 'worker-3', request: { url: 'http://app.test/worker.js', method: 'GET' }, timestamp: 21, walltime: 1791150021, type: 'Script' })
  page.tell('Network.loadingFinished', { requestId: '6.2', timestamp: 21.2 })
  page.tell('Network.requestWillBeSent', { requestId: '6.3', frameId: 'frame-1', loaderId: 'L1', targetId: 'worker-3', request: { url: 'http://app.test/from-worker', method: 'GET' }, timestamp: 22, walltime: 1791150022, type: 'Fetch' })
  page.tell('Network.responseReceived', { requestId: '6.3', timestamp: 22.1, response: { url: 'http://app.test/from-worker', status: 200, source: 'network' } })
  page.tell('Network.loadingFinished', { requestId: '6.3', timestamp: 22.2 })
  const consoles = sink.observations.flatMap((observation) => (observation.kind === 'console' ? [[observation.text, observation.frame]] : []))
  assert.deepEqual(consoles, [['Failed to load resource', 'child']])
  assert.deepEqual(sink.observations.filter((observation) => 'key' in observation && observation.key.startsWith('6.2')).map((observation) => observation.kind), ['request', 'finished'], "the worker's script is the page's request")
  assert.deepEqual(sink.observations.filter((observation) => 'key' in observation && observation.key.startsWith('6.3')), [], "the worker's own request is not the page's")
  assert.deepEqual(sink.unreadables, [])
})

// WebKit sends `console.count` as a log at debug level, made without the call's arguments.
test('a count is a record of its type, and a debug message with its arguments, even none, stays a debug message', { timeout: 10_000 }, () => {
  const { page, sink } = collect()
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'debug', type: 'log', text: 'counted: 1', timestamp: 1791150030 } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'debug', type: 'log', text: 'counted: 1', parameters: [{ type: 'string', value: 'counted: 1' }], timestamp: 1791150031 } })
  page.tell('Console.messageAdded', { message: { source: 'console-api', level: 'debug', type: 'log', text: '', parameters: [], timestamp: 1791150032 } })
  assert.deepEqual(sink.observations.map((observation) => (observation.kind === 'console' ? [observation.consoleType, observation.level] : observation.kind)), [['count', 'debug'], ['debug', 'debug'], ['debug', 'debug']])
})
