import type { TestContext } from 'node:test'
import type { CdpDiagnostic } from '../../src/browser/cdp/connection.ts'
import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { CdpConnection, DEFAULT_MAX_PENDING } from '../../src/browser/cdp/connection.ts'
import {
  CdpAbortedError,
  CdpBlockedError,
  CdpClosedError,
  CdpDisconnectedError,
  CdpInvalidResponseError,
  CdpPendingLimitError,
  CdpProtocolError,
  CdpTimeoutError,
} from '../../src/browser/cdp/errors.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'

type ReceivedCommand = { id: number; method: string; params: unknown; sessionId: unknown }

type Peer = ReturnType<typeof connect>

/** A connection whose far end is a scripted browser that reads real frames from the pipe. */
function connect(t: TestContext, options: { timeoutMs?: number; maxPending?: number } = {}) {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  const diagnostics: CdpDiagnostic[] = []
  const connection = new CdpConnection(new PipeTransport({ readable: fromBrowser, writable: toBrowser }), {
    timeoutMs: options.timeoutMs ?? 1000,
    maxPending: options.maxPending ?? DEFAULT_MAX_PENDING,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  })
  t.after(() => connection.close())

  const received: ReceivedCommand[] = []
  const waiting: ((command: ReceivedCommand) => void)[] = []
  const reader = new PipeTransport({ readable: toBrowser, writable: new PassThrough() })
  reader.listen({
    message: (text) => {
      const command = readCommand(text)
      const waiter = waiting.shift()
      if (waiter === undefined) received.push(command)
      else waiter(command)
    },
    malformed: (problem) => assert.fail(`the connection wrote a malformed frame: ${problem}`),
    close: () => {},
  })

  const browser = {
    nextCommand: (): Promise<ReceivedCommand> => {
      const command = received.shift()
      return command === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(command)
    },
    send: (message: object) => fromBrowser.write(`${JSON.stringify(message)}\0`),
    write: (bytes: string | Uint8Array) => fromBrowser.write(bytes),
    exit: () => fromBrowser.end(),
  }
  return { connection, browser, diagnostics }
}

function readCommand(text: string): ReceivedCommand {
  const value: unknown = JSON.parse(text)
  assert.ok(isRecord(value))
  const { id, method } = value
  assert.ok(typeof id === 'number' && typeof method === 'string')
  return { id, method, params: value['params'], sessionId: value['sessionId'] }
}

/** Proves every earlier frame from the browser was handled, and that nothing else was written. */
async function roundTrip({ connection, browser }: Peer): Promise<void> {
  const reply = connection.send('Test.ping')
  const command = await browser.nextCommand()
  assert.equal(command.method, 'Test.ping')
  browser.send({ id: command.id, result: {} })
  await reply
}

async function attach(peer: Peer, sessionId = 'S1') {
  const attaching = peer.connection.attach('T1')
  const command = await peer.browser.nextCommand()
  peer.browser.send({ id: command.id, result: { sessionId } })
  return attaching
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  assert.fail('expected the promise to reject')
}

/** A pipe that takes one write and holds it, so later writes stay queued in the transport. */
function fullPipe() {
  const writes: string[] = []
  const pending: (() => void)[] = []
  const stream = new Writable({
    highWaterMark: 1,
    write(chunk: unknown, _encoding, callback) {
      writes.push(String(chunk))
      pending.push(() => callback())
    },
  })
  return { stream, writes, release: () => pending.shift()?.() }
}

function connectThroughFullPipe(t: TestContext) {
  const pipe = fullPipe()
  const fromBrowser = new PassThrough()
  const connection = new CdpConnection(new PipeTransport({ readable: fromBrowser, writable: pipe.stream }), {
    timeoutMs: 1000,
    onDiagnostic: () => {},
  })
  t.after(() => connection.close())
  return { connection, pipe, fromBrowser }
}

test('sends commands with increasing ids and resolves each with its own response, in any order', async (t) => {
  const { connection, browser } = connect(t)
  const version = connection.send('Browser.getVersion')
  const targets = connection.send('Target.getTargets', { filter: [] })
  const first = await browser.nextCommand()
  const second = await browser.nextCommand()
  assert.deepEqual(first, { id: 1, method: 'Browser.getVersion', params: undefined, sessionId: undefined })
  assert.deepEqual(second, { id: 2, method: 'Target.getTargets', params: { filter: [] }, sessionId: undefined })

  browser.send({ id: 2, result: { targetInfos: [] } })
  browser.send({ id: 1, result: { product: 'Chrome/154' } })
  assert.deepEqual(await targets, { targetInfos: [] })
  assert.deepEqual(await version, { product: 'Chrome/154' })
})

test('rejects with the CDP error the browser returned', async (t) => {
  const { connection, browser } = connect(t)
  const navigation = connection.send('Page.navigate', { url: 'nowhere' })
  const { id } = await browser.nextCommand()
  browser.send({ id, error: { code: -32000, message: 'Cannot navigate to invalid URL', data: 'nowhere' } })

  const error = await rejection(navigation)
  assert.ok(error instanceof CdpProtocolError)
  assert.equal(error.message, 'Page.navigate failed: Cannot navigate to invalid URL (-32000)')
  assert.deepEqual([error.code, error.protocolMessage, error.data], [-32000, 'Cannot navigate to invalid URL', 'nowhere'])
  assert.deepEqual([error.method, error.sessionId], ['Page.navigate', undefined])
})

test('times out a command that was written, and a late response becomes a diagnostic', async (t) => {
  const peer = connect(t)
  const evaluation = rejection(peer.connection.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 20 }))
  const { id } = await peer.browser.nextCommand()

  const error = await evaluation
  assert.ok(error instanceof CdpTimeoutError)
  assert.equal(error.message, 'Runtime.evaluate got no response within 20 ms')
  assert.deepEqual([error.timeoutMs, error.written], [20, true])

  peer.browser.send({ id, result: {} })
  await roundTrip(peer)
  assert.deepEqual(peer.diagnostics, [{ kind: 'unmatched-response', id }])
})

test('a command that times out before reaching the pipe is never written', async (t) => {
  const { connection, pipe } = connectThroughFullPipe(t)
  const press = connection.send('Input.dispatchMouseEvent', { type: 'mousePressed' }, { timeoutMs: 20 })
  const release = connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }, { timeoutMs: 20 })

  const [pressError, releaseError] = await Promise.all([rejection(press), rejection(release)])
  assert.ok(pressError instanceof CdpTimeoutError && releaseError instanceof CdpTimeoutError)
  assert.deepEqual([pressError.written, releaseError.written], [true, false])

  pipe.release()
  await nextTurn()
  assert.equal(pipe.writes.length, 1)
  assert.match(pipe.writes[0] ?? '', /mousePressed/)
})

test('stopping withdraws a command still queued behind a full pipe, and says which commands were written', async (t) => {
  const { connection, pipe } = connectThroughFullPipe(t)
  const stop = new AbortController()
  const press = rejection(connection.send('Input.dispatchMouseEvent', { type: 'mousePressed' }, { signal: stop.signal }))
  const release = rejection(connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }, { signal: stop.signal }))
  stop.abort()

  const [pressError, releaseError] = await Promise.all([press, release])
  assert.ok(pressError instanceof CdpAbortedError && releaseError instanceof CdpAbortedError)
  assert.deepEqual([pressError.written, releaseError.written], [true, false])
  assert.equal(pressError.message, 'Input.dispatchMouseEvent was stopped while it waited for a response')
  assert.equal(releaseError.message, 'Input.dispatchMouseEvent was stopped before it was sent')
  pipe.release()
  await nextTurn()
  assert.equal(pipe.writes.length, 1)
  assert.doesNotMatch(pipe.writes.join(''), /mouseReleased/)
})

test('a signal that has already stopped sends nothing, and a stop after the answer changes nothing', async (t) => {
  const peer = connect(t)
  const stopped = new AbortController()
  stopped.abort()
  const refused = await rejection(peer.connection.send('Input.insertText', { text: 'x' }, { signal: stopped.signal }))
  assert.ok(refused instanceof CdpAbortedError)
  assert.equal(refused.written, false)

  const later = new AbortController()
  const reply = peer.connection.send('Test.ping', undefined, { signal: later.signal })
  const command = await peer.browser.nextCommand()
  assert.equal(command.method, 'Test.ping', 'the refused command was never written')
  peer.browser.send({ id: command.id, result: { pong: true } })
  assert.deepEqual(await reply, { pong: true })
  later.abort()
  await roundTrip(peer)
  assert.deepEqual(peer.diagnostics, [])
})

test('refuses a command once the pending bound is reached, without writing it', async (t) => {
  const peer = connect(t, { maxPending: 2 })
  const { connection, browser } = peer
  const first = connection.send('Test.first')
  const second = connection.send('Test.second')

  const error = await rejection(connection.send('Test.third'))
  assert.ok(error instanceof CdpPendingLimitError)
  assert.equal(error.limit, 2)
  assert.equal(error.message, 'Test.third was not sent: 2 commands are already waiting for a response')

  for (const reply of [first, second]) {
    const { id } = await browser.nextCommand()
    browser.send({ id, result: {} })
    await reply
  }
  await roundTrip(peer)
})

test('refuses timeouts a timer cannot honour and params JSON cannot hold, without writing anything', async (t) => {
  const peer = connect(t)
  for (const timeoutMs of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
    await assert.rejects(peer.connection.send('Test.b', undefined, { timeoutMs }), RangeError)
  }
  const circular: { self?: object } = {}
  circular.self = circular
  await assert.rejects(peer.connection.send('Test.b', circular), TypeError)
  await assert.rejects(peer.connection.send('Test.b', { value: 1n }), TypeError)
  await roundTrip(peer)

  const transport = new PipeTransport({ readable: new PassThrough(), writable: new PassThrough() })
  assert.throws(() => new CdpConnection(transport, { timeoutMs: 0, onDiagnostic: () => {} }), RangeError)
  assert.throws(() => new CdpConnection(transport, { timeoutMs: 10, maxPending: 0, onDiagnostic: () => {} }), RangeError)
})

test('attaches a flat session and routes its commands, responses and events by sessionId', async (t) => {
  const peer = connect(t)
  const { connection, browser } = peer
  const attaching = connection.attach('T1')
  const attachCommand = await browser.nextCommand()
  assert.deepEqual(attachCommand, {
    id: 1,
    method: 'Target.attachToTarget',
    params: { targetId: 'T1', flatten: true },
    sessionId: undefined,
  })
  browser.send({ method: 'Target.attachedToTarget', params: { sessionId: 'S1', waitingForDebugger: false } })
  browser.send({ id: attachCommand.id, result: { sessionId: 'S1' } })
  const session = await attaching
  assert.equal(session.id, 'S1')

  const sessionEvents: unknown[] = []
  const rootEvents: unknown[] = []
  session.on('Page.loadEventFired', (params) => sessionEvents.push(params))
  connection.on('Page.loadEventFired', (params) => rootEvents.push(params))

  const evaluation = session.send('Runtime.evaluate', { expression: '1' })
  const command = await browser.nextCommand()
  assert.deepEqual(command, { id: 2, method: 'Runtime.evaluate', params: { expression: '1' }, sessionId: 'S1' })
  browser.send({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' })
  browser.send({ method: 'Page.loadEventFired', params: { timestamp: 2 } })
  browser.send({ id: command.id, result: { result: { type: 'number', value: 1 } }, sessionId: 'S1' })

  assert.deepEqual(await evaluation, { result: { type: 'number', value: 1 } })
  assert.deepEqual(sessionEvents, [{ timestamp: 1 }])
  assert.deepEqual(rootEvents, [{ timestamp: 2 }])
  assert.deepEqual(peer.diagnostics, [])
})

test('a session exists before any message that follows its attach response in the same chunk', async (t) => {
  const peer = connect(t)
  const attaching = peer.connection.attach('T1')
  const { id } = await peer.browser.nextCommand()
  peer.browser.write(
    `${JSON.stringify({ id, result: { sessionId: 'S1' } })}\0` +
      `${JSON.stringify({ method: 'Runtime.executionContextCreated', params: {}, sessionId: 'S1' })}\0` +
      `${JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } })}\0`,
  )
  const session = await attaching
  assert.equal(session.detachReason, 'the target detached')
  const error = await rejection(session.send('Page.enable'))
  assert.ok(error instanceof CdpClosedError)
  assert.equal(error.message, 'Page.enable was not sent: the target detached')
  await roundTrip(peer)
  assert.deepEqual(peer.diagnostics, [])
})

test('rejects an attach whose result has no sessionId', async (t) => {
  const peer = connect(t)
  const attaching = peer.connection.attach('T1')
  const { id } = await peer.browser.nextCommand()
  peer.browser.send({ id, result: {} })

  const error = await rejection(attaching)
  assert.ok(error instanceof CdpInvalidResponseError)
  assert.equal(error.message, 'Target.attachToTarget got a response that could not be read: the result has no sessionId')
})

test('ends a session when its target detaches, leaving the browser and other sessions alone', async (t) => {
  const peer = connect(t)
  const { connection, browser } = peer
  const session = await attach(peer, 'S1')
  const other = await attach(peer, 'S2')
  const detachReasons: string[] = []
  const sessionEvents: unknown[] = []
  const rootEvents: unknown[] = []
  session.onDetach((reason) => detachReasons.push(reason))
  session.on('Page.loadEventFired', (params) => sessionEvents.push(params))
  connection.on('Target.detachedFromTarget', (params) => rootEvents.push(params))

  const evaluation = session.send('Runtime.evaluate', { expression: 'new Promise(() => {})', awaitPromise: true })
  await browser.nextCommand()
  const otherEvaluation = other.send('Runtime.evaluate', { expression: '2' })
  const otherCommand = await browser.nextCommand()

  browser.send({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1', targetId: 'T1' } })
  const error = await rejection(evaluation)
  assert.ok(error instanceof CdpDisconnectedError)
  assert.equal(error.message, 'Runtime.evaluate got no response: the target detached')
  assert.deepEqual([error.reason, error.written, error.sessionId], ['the target detached', true, 'S1'])
  assert.deepEqual(detachReasons, ['the target detached'])
  assert.deepEqual(rootEvents, [{ sessionId: 'S1', targetId: 'T1' }])
  assert.ok((await rejection(session.send('Page.enable'))) instanceof CdpClosedError)

  browser.send({ method: 'Page.loadEventFired', params: {}, sessionId: 'S1' })
  browser.send({ id: otherCommand.id, result: { value: 2 }, sessionId: 'S2' })
  assert.deepEqual(await otherEvaluation, { value: 2 })
  await roundTrip(peer)
  assert.deepEqual(sessionEvents, [])
  assert.equal(other.detachReason, undefined)
  assert.deepEqual(peer.diagnostics, [{ kind: 'unknown-session', sessionId: 'S1', method: 'Page.loadEventFired' }])
})

test('blocking a session fails its waiting commands at once with the reason, and leaves other sessions alone', async (t) => {
  const peer = connect(t, { timeoutMs: 30_000 })
  const { connection, browser } = peer
  const session = await attach(peer, 'S1')
  const other = await attach(peer, 'S2')
  const blocked: string[] = []
  session.onBlock((reason) => blocked.push(reason))

  const evaluation = rejection(session.send('Runtime.evaluate', { expression: '1' }))
  const release = rejection(session.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }))
  await browser.nextCommand()
  await browser.nextCommand()
  const otherEvaluation = other.send('Runtime.evaluate', { expression: '2' })
  const version = connection.send('Browser.getVersion')
  const otherCommand = await browser.nextCommand()
  const versionCommand = await browser.nextCommand()

  const started = performance.now()
  session.block('a JavaScript alert dialog holds the page')
  const [evaluationError, releaseError] = await Promise.all([evaluation, release])
  assert.ok(performance.now() - started < 100, 'the commands failed at once, not at their 30 s timeout')
  assert.ok(evaluationError instanceof CdpBlockedError && releaseError instanceof CdpBlockedError)
  assert.equal(evaluationError.message, 'Runtime.evaluate got no response: a JavaScript alert dialog holds the page')
  assert.deepEqual(
    [releaseError.method, releaseError.sessionId, releaseError.reason, releaseError.written],
    ['Input.dispatchMouseEvent', 'S1', 'a JavaScript alert dialog holds the page', true],
  )
  assert.deepEqual(blocked, ['a JavaScript alert dialog holds the page'])
  assert.equal(session.blockReason, 'a JavaScript alert dialog holds the page')
  assert.equal(session.detachReason, undefined)

  browser.send({ id: otherCommand.id, result: { value: 2 }, sessionId: 'S2' })
  browser.send({ id: versionCommand.id, result: { product: 'Chrome/154' } })
  assert.deepEqual(await otherEvaluation, { value: 2 })
  assert.deepEqual(await version, { product: 'Chrome/154' })
  assert.equal(other.blockReason, undefined)
})

test('a blocked session refuses new commands without writing them, until it is unblocked', async (t) => {
  const peer = connect(t)
  const { browser } = peer
  const session = await attach(peer, 'S1')
  session.block('the page crashed')
  session.block('a second reason is ignored')

  const refused = await rejection(session.send('Page.getFrameTree'))
  assert.ok(refused instanceof CdpBlockedError)
  assert.deepEqual([refused.reason, refused.written], ['the page crashed', false])
  await roundTrip(peer)

  session.unblock()
  assert.equal(session.blockReason, undefined)
  const frameTree = session.send('Page.getFrameTree')
  const command = await browser.nextCommand()
  assert.deepEqual([command.method, command.sessionId], ['Page.getFrameTree', 'S1'])
  browser.send({ id: command.id, result: { frameTree: {} }, sessionId: 'S1' })
  assert.deepEqual(await frameTree, { frameTree: {} })
})

test('blocking records a command still queued behind a full pipe as unwritten, and never writes it', async (t) => {
  const { connection, pipe, fromBrowser } = connectThroughFullPipe(t)
  const attaching = connection.attach('T1')
  fromBrowser.write(`${JSON.stringify({ id: 1, result: { sessionId: 'S1' } })}\0`)
  const session = await attaching
  pipe.release()
  const press = rejection(session.send('Input.dispatchMouseEvent', { type: 'mousePressed' }))
  const release = rejection(session.send('Input.dispatchMouseEvent', { type: 'mouseReleased' }))

  session.block('a JavaScript confirm dialog holds the page')
  const [pressError, releaseError] = await Promise.all([press, release])
  assert.ok(pressError instanceof CdpBlockedError && releaseError instanceof CdpBlockedError)
  assert.deepEqual([pressError.written, releaseError.written], [true, false])
  pipe.release()
  await nextTurn()
  assert.equal(pipe.writes.length, 2)
  assert.doesNotMatch(pipe.writes.join(''), /mouseReleased/)
})

test('a session that has ended cannot be blocked, and a block listener that throws is reported', async (t) => {
  const peer = connect(t)
  const { connection, browser } = peer
  const session = await attach(peer, 'S1')
  session.onBlock(() => {
    throw new Error('listener broke')
  })
  session.block('the page crashed')
  assert.deepEqual(
    peer.diagnostics.map((diagnostic) => [diagnostic.kind, diagnostic.kind === 'listener-failed' ? diagnostic.event : null]),
    [['listener-failed', 'block']],
  )

  const ended = await attach(peer, 'S2')
  const heard: string[] = []
  ended.onBlock((reason) => heard.push(reason))
  browser.send({ method: 'Target.detachedFromTarget', params: { sessionId: 'S2', targetId: 'T2' } })
  await roundTrip(peer)
  ended.block('too late')
  assert.equal(ended.blockReason, undefined)
  assert.deepEqual(heard, [])
  assert.ok((await rejection(ended.send('Page.enable'))) instanceof CdpClosedError)
  assert.ok(connection.closeReason === undefined)
})

test('rejects every waiting command when the browser goes away, recording that each was written', async (t) => {
  const peer = connect(t)
  const { connection, browser } = peer
  const session = await attach(peer)
  const disconnects: string[] = []
  const detaches: string[] = []
  connection.onDisconnect((reason) => disconnects.push(reason))
  session.onDetach((reason) => detaches.push(reason))

  const version = connection.send('Browser.getVersion')
  const click = session.send('Input.dispatchMouseEvent', { type: 'mousePressed' })
  await browser.nextCommand()
  await browser.nextCommand()
  browser.exit()

  const [versionError, clickError] = await Promise.all([rejection(version), rejection(click)])
  assert.ok(versionError instanceof CdpDisconnectedError && clickError instanceof CdpDisconnectedError)
  assert.deepEqual(
    [versionError.written, versionError.reason, clickError.written, clickError.sessionId],
    [true, 'the browser closed the pipe', true, 'S1'],
  )
  assert.equal(clickError.message, 'Input.dispatchMouseEvent got no response: the browser closed the pipe')
  assert.deepEqual(disconnects, ['the browser closed the pipe'])
  assert.deepEqual(detaches, ['the browser closed the pipe'])
  assert.equal(connection.closeReason, 'the browser closed the pipe')

  const refused = await rejection(connection.send('Browser.getVersion'))
  assert.ok(refused instanceof CdpClosedError)
  assert.equal(refused.message, 'Browser.getVersion was not sent: the browser closed the pipe')
  assert.ok((await rejection(session.send('Page.enable'))) instanceof CdpClosedError)
})

test('records a command still queued behind a full pipe as unwritten when the connection ends', async (t) => {
  const { connection, fromBrowser, pipe } = connectThroughFullPipe(t)
  const press = connection.send('Input.dispatchMouseEvent', { type: 'mousePressed' })
  const release = connection.send('Input.dispatchMouseEvent', { type: 'mouseReleased' })
  fromBrowser.end()

  const [pressError, releaseError] = await Promise.all([rejection(press), rejection(release)])
  assert.ok(pressError instanceof CdpDisconnectedError && releaseError instanceof CdpDisconnectedError)
  assert.deepEqual([pressError.written, releaseError.written], [true, false])
  assert.equal(pipe.writes.length, 1)
})

test('refuses commands sent from a detach listener while the connection is ending', async (t) => {
  const peer = connect(t)
  const session = await attach(peer)
  const attempts: Promise<unknown>[] = []
  session.onDetach(() => attempts.push(rejection(peer.connection.send('Browser.getVersion'))))
  const disconnected = new Promise((resolve) => peer.connection.onDisconnect(resolve))
  peer.browser.exit()
  await disconnected

  assert.equal(attempts.length, 1)
  assert.ok((await attempts[0]) instanceof CdpClosedError)
})

test('closing rejects waiting commands, notifies once and refuses later commands', async (t) => {
  const { connection, browser } = connect(t)
  const disconnects: string[] = []
  connection.onDisconnect((reason) => disconnects.push(reason))
  const version = connection.send('Browser.getVersion')
  await browser.nextCommand()

  connection.close()
  connection.close()
  const error = await rejection(version)
  assert.ok(error instanceof CdpDisconnectedError)
  assert.deepEqual([error.reason, error.written], ['the connection was closed', true])
  assert.deepEqual(disconnects, ['the connection was closed'])
  assert.ok((await rejection(connection.send('Browser.getVersion'))) instanceof CdpClosedError)
})

test('a connection over a pipe that already closed starts closed', async () => {
  const readable = new PassThrough()
  readable.destroy()
  await nextTurn()
  const connection = new CdpConnection(new PipeTransport({ readable, writable: new PassThrough() }), {
    timeoutMs: 1000,
    onDiagnostic: () => {},
  })
  assert.equal(connection.closeReason, 'the browser closed the pipe')
  assert.ok((await rejection(connection.send('Browser.getVersion'))) instanceof CdpClosedError)
})

test('reports malformed and unexpected messages and keeps working', async (t) => {
  const peer = connect(t)
  peer.browser.write('not json\0\0[1]\0{"id":"7","result":{}}\0{"sessionId":"S1"}\0')
  peer.browser.write(Buffer.from([0x7b, 0xc3, 0x7d, 0x00]))
  peer.browser.send({ id: 999, result: {} })
  peer.browser.send({ method: 'Page.loadEventFired', params: {}, sessionId: 'S404' })
  peer.browser.send({ method: 'Target.detachedFromTarget', params: {} })
  await roundTrip(peer)

  assert.deepEqual(peer.diagnostics, [
    { kind: 'malformed-message', problem: 'the message is not valid JSON' },
    { kind: 'malformed-message', problem: 'the message is not valid JSON' },
    { kind: 'malformed-message', problem: 'the message is not a JSON object' },
    { kind: 'malformed-message', problem: 'the response id is not a non-negative integer' },
    { kind: 'malformed-message', problem: 'the message is neither a response nor an event' },
    { kind: 'malformed-message', problem: 'the message is not valid UTF-8' },
    { kind: 'unmatched-response', id: 999 },
    { kind: 'unknown-session', sessionId: 'S404', method: 'Page.loadEventFired' },
    { kind: 'malformed-message', problem: 'Target.detachedFromTarget has no sessionId' },
  ])
})

test('rejects a command at once when its response cannot be read', async (t) => {
  const peer = connect(t)
  const version = peer.connection.send('Browser.getVersion')
  const { id } = await peer.browser.nextCommand()
  peer.browser.send({ id, error: 'boom' })

  const error = await rejection(version)
  assert.ok(error instanceof CdpInvalidResponseError)
  assert.equal(error.problem, 'the response error is not a CDP error')
  assert.deepEqual(peer.diagnostics, [{ kind: 'malformed-message', problem: 'the response error is not a CDP error' }])
})

test('stops calling a listener once it unsubscribes, even in the middle of an event', async (t) => {
  const peer = connect(t)
  const calls: string[] = []
  let stopSecond = () => {}
  peer.connection.on('Test.happened', () => {
    calls.push('first')
    stopSecond()
  })
  stopSecond = peer.connection.on('Test.happened', () => calls.push('second'))
  const stopThird = peer.connection.on('Test.happened', () => calls.push('third'))

  peer.browser.send({ method: 'Test.happened', params: {} })
  await roundTrip(peer)
  assert.deepEqual(calls, ['first', 'third'])

  stopThird()
  stopThird()
  peer.browser.send({ method: 'Test.happened', params: {} })
  await roundTrip(peer)
  assert.deepEqual(calls, ['first', 'third', 'first'])
})

test('reports a listener that throws and still calls the others and handles later messages', async (t) => {
  const peer = connect(t)
  const session = await attach(peer)
  const failure = new Error('listener bug')
  const heard: string[] = []
  session.on('Test.happened', () => {
    throw failure
  })
  session.on('Test.happened', () => heard.push('event'))
  session.onDetach(() => {
    throw failure
  })

  peer.browser.write(
    `${JSON.stringify({ method: 'Test.happened', params: {}, sessionId: 'S1' })}\0` +
      `${JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: 'S1' } })}\0`,
  )
  await roundTrip(peer)
  assert.deepEqual(heard, ['event'])
  assert.equal(session.detachReason, 'the target detached')
  assert.deepEqual(peer.diagnostics, [
    { kind: 'listener-failed', event: 'Test.happened', sessionId: 'S1', error: failure },
    { kind: 'listener-failed', event: 'close', sessionId: 'S1', error: failure },
  ])
})
