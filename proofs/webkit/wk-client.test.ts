import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { parseMessage } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { parseWkMessage, WkConnection, WkDisconnectedError, WkProtocolError, WkTimeoutError } from './wk-client.ts'

// These are protocol units over Retest's own pipe transport and an in-memory pipe. They prove the message shapes
// and routing, nothing about a real browser; run.ts and webkit-proof.test.ts drive the real build.

type Sent = { id: number; method: string; params?: Record<string, unknown>; pageProxyId?: string }

function openConnection(timeoutMs = 1000) {
  const toBrowser = new PassThrough()
  const fromBrowser = new PassThrough()
  const sent: Sent[] = []
  let buffer = ''
  toBrowser.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    for (let end = buffer.indexOf('\0'); end !== -1; end = buffer.indexOf('\0')) {
      sent.push(JSON.parse(buffer.slice(0, end)) as Sent)
      buffer = buffer.slice(end + 1)
    }
  })
  const diagnostics: string[] = []
  const connection = new WkConnection(new PipeTransport({ readable: fromBrowser, writable: toBrowser }), { timeoutMs, onDiagnostic: (problem) => diagnostics.push(problem) })
  const reply = (message: object) => fromBrowser.write(`${JSON.stringify(message)}\0`)
  return { connection, sent, reply, diagnostics, fromBrowser }
}

function innerOf(message: Sent | undefined): Sent {
  const text = message?.params?.['message']
  if (typeof text !== 'string') throw new Error('The command is not a wrapped target message')
  return JSON.parse(text) as Sent
}

test('reads a page proxy response, keeping its pageProxyId', () => {
  assert.deepEqual(parseWkMessage('{"result":{},"id":5,"browserContextId":"8","pageProxyId":"7"}'), { kind: 'result', id: 5, result: {}, pageProxyId: '7' })
})

test('reads a WebKit error, whose data is a list rather than a string', () => {
  const text = '{"error":{"code":-32601,"message":"\'Bogus\' domain was not found","data":[{"code":-32601,"message":"\'Bogus\' domain was not found"}]},"id":3}'
  assert.deepEqual(parseWkMessage(text), { kind: 'error', id: 3, error: { code: -32601, message: "'Bogus' domain was not found" }, pageProxyId: undefined })
})

test('reads an event with its pageProxyId', () => {
  const text = '{"method":"Target.targetCreated","params":{"targetInfo":{"targetId":"page-8","type":"page","isPaused":true}},"pageProxyId":"7"}'
  const message = parseWkMessage(text)
  assert.equal(message.kind, 'event')
  assert.equal(message.kind === 'event' ? message.pageProxyId : undefined, '7')
})

test('Retest\'s CDP message reader cannot serve WebKit: it refuses its errors and drops the pageProxyId', () => {
  const error = '{"error":{"code":-32601,"message":"not found","data":[{"code":-32601,"message":"not found"}]},"id":3}'
  assert.deepEqual(parseMessage(error), { kind: 'malformed', problem: 'the response error is not a CDP error', id: 3 })
  const event = parseMessage('{"method":"Target.targetCreated","params":{},"pageProxyId":"7"}')
  assert.deepEqual(event, { kind: 'event', method: 'Target.targetCreated', params: {}, sessionId: undefined })
})

test('refuses messages it cannot read without quoting them', () => {
  assert.deepEqual(parseWkMessage('not json'), { kind: 'malformed', problem: 'the message is not valid JSON', id: undefined })
  assert.deepEqual(parseWkMessage('{"id":1,"result":{},"error":{"code":1,"message":"x"}}'), { kind: 'malformed', problem: 'the response has both a result and an error', id: 1 })
  assert.equal(parseWkMessage('{"method":"Page.enable","pageProxyId":7}').kind, 'malformed')
  assert.equal(parseWkMessage('{"id":-1,"result":{}}').kind, 'malformed')
})

test('sends a browser command without a pageProxyId and resolves with its result', async () => {
  const { connection, sent, reply } = openConnection()
  const answer = connection.send('Playwright.createContext')
  await nextTurn()
  assert.deepEqual(sent, [{ id: 1, method: 'Playwright.createContext' }])
  reply({ result: { browserContextId: '8000000000000002' }, id: 1 })
  assert.deepEqual(await answer, { browserContextId: '8000000000000002' })
})

test('addresses a page proxy command by pageProxyId', async () => {
  const { connection, sent, reply } = openConnection()
  const answer = connection.sendToPageProxy('7', 'Input.dispatchMouseEvent', { type: 'move', x: 1, y: 2 })
  await nextTurn()
  assert.deepEqual(sent[0], { id: 1, method: 'Input.dispatchMouseEvent', params: { type: 'move', x: 1, y: 2 }, pageProxyId: '7' })
  reply({ result: {}, id: 1, pageProxyId: '7' })
  assert.deepEqual(await answer, {})
})

test('wraps a target command and resolves only with the inner answer', async () => {
  const { connection, sent, reply } = openConnection()
  let settled = false
  const answer = connection.sendToTarget('7', 'page-8', 'Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
  void answer.then(() => {
    settled = true
  })
  await nextTurn()
  const [wrapper] = sent
  assert.equal(wrapper?.method, 'Target.sendMessageToTarget')
  assert.equal(wrapper?.pageProxyId, '7')
  assert.equal(wrapper?.params?.['targetId'], 'page-8')
  const inner = innerOf(wrapper)
  assert.deepEqual(inner, { id: 1, method: 'Runtime.evaluate', params: { expression: '1 + 1', returnByValue: true } })
  assert.notEqual(wrapper?.id, inner.id)
  reply({ result: {}, id: wrapper?.id, pageProxyId: '7' })
  await nextTurn()
  assert.equal(settled, false)
  const message = JSON.stringify({ result: { result: { type: 'number', value: 2 }, wasThrown: false }, id: inner.id })
  reply({ method: 'Target.dispatchMessageFromTarget', params: { targetId: 'page-8', message }, pageProxyId: '7' })
  assert.deepEqual(await answer, { result: { type: 'number', value: 2 }, wasThrown: false })
})

test('fails a target command whose wrapper the page proxy refused', async () => {
  const { connection, sent, reply } = openConnection()
  const answer = connection.sendToTarget('7', 'page-gone', 'Page.enable')
  await nextTurn()
  reply({ error: { code: -32000, message: 'Missing target for given targetId', data: [] }, id: sent[0]?.id, pageProxyId: '7' })
  await assert.rejects(answer, (error: unknown) => {
    assert.ok(error instanceof WkProtocolError)
    assert.equal(error.method, 'Page.enable')
    assert.match(error.message, /did not pass it on: Missing target/)
    return true
  })
})

test('rejects with the browser error, its code and its words', async () => {
  const { connection, reply } = openConnection()
  const answer = connection.send('Bogus.command')
  await nextTurn()
  reply({ error: { code: -32601, message: "'Bogus' domain was not found", data: [{ code: -32601, message: "'Bogus' domain was not found" }] }, id: 1 })
  await assert.rejects(answer, (error: unknown) => error instanceof WkProtocolError && error.code === -32601 && error.detail === "'Bogus' domain was not found")
})

test('routes browser, page proxy and target events apart', async () => {
  const { connection, reply } = openConnection()
  const heard: string[] = []
  connection.onBrowserEvent('Playwright.pageProxyCreated', () => heard.push('browser'))
  connection.onPageProxyEvent('7', (event) => heard.push(`proxy 7 ${event.method}`))
  connection.onPageProxyEvent('9', (event) => heard.push(`proxy 9 ${event.method}`))
  connection.onTargetEvent('7', (event) => heard.push(`target ${event.targetId} ${event.method}`))
  reply({ method: 'Playwright.pageProxyCreated', params: { pageProxyId: '7', browserContextId: '8' } })
  reply({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'page-8', type: 'page' } }, pageProxyId: '7' })
  reply({ method: 'Target.dispatchMessageFromTarget', params: { targetId: 'page-8', message: '{"method":"Page.loadEventFired","params":{"frameId":"1"}}' }, pageProxyId: '7' })
  await nextTurn()
  assert.deepEqual(heard, ['browser', 'proxy 7 Target.targetCreated', 'target page-8 Page.loadEventFired'])
})

test('times out a written command and says it was written', async () => {
  const { connection } = openConnection(20)
  await assert.rejects(connection.send('Playwright.enable'), (error: unknown) => error instanceof WkTimeoutError && error.written && error.timeoutMs === 20)
})

test('fails waiting commands when the pipe closes, and refuses later ones unwritten', async () => {
  const { connection, fromBrowser } = openConnection()
  const reasons: string[] = []
  connection.onDisconnect((reason) => reasons.push(reason))
  const waiting = connection.sendToTarget('7', 'page-8', 'Runtime.awaitPromise', { promiseObjectId: '1' })
  await nextTurn()
  fromBrowser.end()
  await assert.rejects(waiting, (error: unknown) => error instanceof WkDisconnectedError && error.written && error.method === 'Runtime.awaitPromise')
  await assert.rejects(connection.send('Playwright.getInfo'), (error: unknown) => error instanceof WkDisconnectedError && !error.written)
  assert.deepEqual(reasons, ['the browser closed the pipe'])
  connection.onDisconnect((reason) => reasons.push(`late ${reason}`))
  assert.deepEqual(reasons, ['the browser closed the pipe', 'late the browser closed the pipe'])
})

test('reports an answer nothing waits for and keeps going', async () => {
  const { connection, reply, diagnostics } = openConnection()
  reply({ result: {}, id: 41 })
  await nextTurn()
  assert.deepEqual(diagnostics, ['the browser answered command 41, which nothing was waiting for'])
  const answer = connection.send('Playwright.getInfo')
  await nextTurn()
  reply({ result: { os: 'macOS' }, id: 1 })
  assert.deepEqual(await answer, { os: 'macOS' })
})
