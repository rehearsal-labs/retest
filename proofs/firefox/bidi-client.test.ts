import assert from 'node:assert/strict'
import { test } from 'node:test'
import { s } from '../../src/protocol/schema.ts'
import { BidiClient, readBidi } from './bidi-client.ts'
import { BidiAbortedError, BidiConnectError, BidiInvalidResponseError, BidiProtocolError, BidiTimeoutError } from './bidi-errors.ts'
import { createUserContext, openTab } from './firefox-page.ts'
import { commandMs, rejection, sharedSession, viewport } from './harness.ts'

const session = sharedSession()
const statusSchema = s.object({ ready: s.boolean(), message: s.string() })
const contextCreatedSchema = s.object({ context: s.string(), userContext: s.string() })

test('an unknown command is answered with the protocol error, and the connection goes on', async () => {
  const { client } = session()
  const failure = await rejection(client.send('retest.nothing', {}))
  assert.ok(failure instanceof BidiProtocolError, String(failure))
  assert.equal(failure.error, 'unknown command')
  assert.equal(failure.method, 'retest.nothing')
  assert.equal(typeof (await client.request('session.status', {}, statusSchema)).ready, 'boolean')
})

test("Firefox quotes a command's arguments in its errors, and the client keeps that text only for a command that asks", async () => {
  const { client } = session()
  const marker = 'hunter2-secret'
  const hidden = await rejection(client.send('browsingContext.navigate', { context: marker, url: 'about:blank' }))
  assert.ok(hidden instanceof BidiProtocolError, String(hidden))
  assert.equal(hidden.message, 'browsingContext.navigate failed: no such frame')
  assert.equal(hidden.protocolMessage, undefined)
  assert.ok(!`${hidden.stack ?? ''} ${JSON.stringify(hidden)}`.includes(marker), 'the value appears nowhere in the error')
  const shown = await rejection(client.send('browsingContext.navigate', { context: marker, url: 'about:blank' }, { keepErrorMessage: true }))
  assert.ok(shown instanceof BidiProtocolError, String(shown))
  assert.equal(shown.protocolMessage, `Browsing Context with id ${marker} not found`)
})

test('a command with no answer in time fails as a timeout that was written, and the connection goes on', async () => {
  const { client } = session()
  const tab = await openTab(client, await createUserContext(client, commandMs), viewport, commandMs)
  const never = { expression: 'new Promise(() => {})', target: { context: tab.context }, awaitPromise: true }
  const started = performance.now()
  const failure = await rejection(client.send('script.evaluate', never, { timeoutMs: 300 }))
  const elapsedMs = performance.now() - started
  assert.ok(failure instanceof BidiTimeoutError, String(failure))
  assert.equal(failure.timeoutMs, 300)
  assert.equal(failure.written, true)
  assert.ok(elapsedMs >= 290 && elapsedMs < 2000, `gave up after ${elapsedMs} ms`)
  assert.equal(typeof (await client.request('session.status', {}, statusSchema)).ready, 'boolean')
})

test('a stopped command fails as stopped, and says whether it was sent', async () => {
  const { client } = session()
  const tab = await openTab(client, await createUserContext(client, commandMs), viewport, commandMs)
  const already = new AbortController()
  already.abort()
  const unsent = await rejection(client.send('session.status', {}, { signal: already.signal }))
  assert.ok(unsent instanceof BidiAbortedError && !unsent.written, String(unsent))
  const controller = new AbortController()
  const waiting = rejection(client.send('script.evaluate', { expression: 'new Promise(() => {})', target: { context: tab.context }, awaitPromise: true }, { signal: controller.signal }))
  controller.abort()
  const sent = await waiting
  assert.ok(sent instanceof BidiAbortedError && sent.written, String(sent))
})

test('a result that is not what Retest relies on fails naming only the paths', async () => {
  const { client } = session()
  const failure = await rejection(client.request('session.status', {}, s.object({ ready: s.string(), message: s.string() })))
  assert.ok(failure instanceof BidiInvalidResponseError, String(failure))
  assert.equal(failure.problem, '$.ready expected string')
})

test('events reach their listeners, and a listener that throws is a diagnostic', async () => {
  const { client, diagnostics } = session()
  await client.request('session.subscribe', { events: ['browsingContext.contextCreated'] }, s.object({}))
  const created: unknown[] = []
  const stopFailing = client.on('browsingContext.contextCreated', () => {
    throw new Error('a listener that fails')
  })
  const stopListening = client.on('browsingContext.contextCreated', (params) => created.push(params))
  const userContext = await createUserContext(client, commandMs)
  const tab = await openTab(client, userContext, viewport, commandMs)
  stopFailing()
  stopListening()
  await client.request('session.unsubscribe', { events: ['browsingContext.contextCreated'] }, s.object({}))
  const mine = created.map((params) => readBidi(contextCreatedSchema, params, 'browsingContext.contextCreated')).find((event) => event.context === tab.context)
  assert.equal(mine?.userContext, userContext, 'the contextCreated event names the new tab and its user context')
  assert.ok(diagnostics.some((diagnostic) => diagnostic.kind === 'listener-failed' && diagnostic.event === 'browsingContext.contextCreated'))
})

test('a WebSocket that cannot open fails to connect, with no command sent', async () => {
  const failure = await rejection(BidiClient.connect('ws://127.0.0.1:9/session', { timeoutMs: 3000, onDiagnostic: () => {} }))
  assert.ok(failure instanceof BidiConnectError, String(failure))
})
