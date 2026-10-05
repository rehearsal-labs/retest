import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { BidiClient, readBidi } from '../../src/browser/firefox/bidi-client.ts'
import { BidiAbortedError, BidiClosedError, BidiConnectError, BidiDisconnectedError, BidiInvalidResponseError, BidiPendingLimitError, BidiProtocolError, BidiTimeoutError } from '../../src/browser/firefox/bidi-errors.ts'
import { s } from '../../src/protocol/schema.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The BiDi client over a real WebSocket to a scripted endpoint: command ids and answers, bounded waits, aborts, events,
// a lost connection, and protocol errors that keep Firefox's own message only when a command asks for it.

let endpoint: ScriptedBidi

before(async () => {
  endpoint = await ScriptedBidi.start()
})

after(() => endpoint.close())

function connect(maxPending?: number): Promise<BidiClient> {
  return BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {}, ...(maxPending === undefined ? {} : { maxPending }) })
}

describe('the Firefox BiDi client', () => {
  test('numbers commands and matches each answer to its command', async () => {
    endpoint.on('session.status', () => ({ result: { ready: false, message: 'busy' } }))
    endpoint.on('browser.getUserContexts', () => ({ result: { userContexts: [{ userContext: 'default' }] } }))
    const client = await connect()
    const [status, contexts] = await Promise.all([client.send('session.status', {}), client.send('browser.getUserContexts', {})])
    assert.deepEqual(status, { ready: false, message: 'busy' })
    assert.deepEqual(contexts, { userContexts: [{ userContext: 'default' }] })
    const ids = endpoint.sent.slice(-2).map((command) => command.id)
    assert.equal(new Set(ids).size, 2, 'each command has an id of its own')
    client.close()
  })

  test("a protocol error keeps only the error code unless the command asks for Firefox's message", async () => {
    endpoint.on('browsingContext.navigate', () => ({ error: 'no such frame', message: 'Browsing Context with id hunter2-secret not found' }))
    const client = await connect()
    const quiet = await client.send('browsingContext.navigate', { context: 'hunter2-secret' }).catch((error: unknown) => error)
    assert.ok(quiet instanceof BidiProtocolError)
    assert.equal(quiet.error, 'no such frame')
    assert.equal(quiet.protocolMessage, undefined)
    assert.doesNotMatch(quiet.message, /hunter2/)
    const kept = await client.send('browsingContext.navigate', { context: 'x' }, { keepErrorMessage: true }).catch((error: unknown) => error)
    assert.ok(kept instanceof BidiProtocolError)
    assert.equal(kept.protocolMessage, 'Browsing Context with id hunter2-secret not found')
    client.close()
  })

  test('a command with no answer in time is a timeout marked written, and the connection goes on', async () => {
    endpoint.on('script.evaluate', () => 'silent')
    endpoint.on('session.status', () => ({ result: { ready: true, message: '' } }))
    const client = await connect()
    const timedOut = await client.send('script.evaluate', {}, { timeoutMs: 50 }).catch((error: unknown) => error)
    assert.ok(timedOut instanceof BidiTimeoutError)
    assert.deepEqual([timedOut.written, timedOut.timeoutMs], [true, 50])
    assert.deepEqual(await client.send('session.status', {}), { ready: true, message: '' })
    client.close()
  })

  test('a command stopped before it is sent is never written, and one stopped while it waits was', async () => {
    endpoint.on('script.evaluate', () => 'silent')
    const client = await connect()
    const before = endpoint.commands('script.evaluate').length
    const stopped = new AbortController()
    stopped.abort()
    const unsent = await client.send('script.evaluate', {}, { signal: stopped.signal }).catch((error: unknown) => error)
    assert.ok(unsent instanceof BidiAbortedError)
    assert.equal(unsent.written, false)
    const waiting = new AbortController()
    const sent = client.send('script.evaluate', {}, { signal: waiting.signal }).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 30))
    waiting.abort()
    const aborted = await sent
    assert.ok(aborted instanceof BidiAbortedError)
    assert.equal(aborted.written, true)
    assert.equal(endpoint.commands('script.evaluate').length, before + 1, 'only the command stopped while it waited reached the endpoint')
    client.close()
  })

  test('events reach their listeners, and a listener that throws becomes a diagnostic', async () => {
    const diagnostics: unknown[] = []
    const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.kind) })
    const heard: unknown[] = []
    client.on('log.entryAdded', () => {
      throw new Error('a listener failed')
    })
    client.on('log.entryAdded', (params) => heard.push(params))
    endpoint.on('session.status', () => ({ result: {} }))
    await client.send('session.status', {})
    endpoint.emit('log.entryAdded', { text: 'hello' })
    await client.send('session.status', {})
    assert.deepEqual(heard, [{ text: 'hello' }])
    assert.deepEqual(diagnostics, ['listener-failed'])
    client.close()
  })

  test('a lost connection fails every waiting command as written, then refuses new ones, and is told once', async () => {
    endpoint.on('browsingContext.navigate', () => 'silent')
    const client = await connect()
    const reasons: string[] = []
    client.onDisconnect((reason) => reasons.push(reason))
    const waiting = client.send('browsingContext.navigate', {}).catch((error: unknown) => error)
    await new Promise((resolve) => setTimeout(resolve, 30))
    endpoint.drop()
    const lost = await waiting
    assert.ok(lost instanceof BidiDisconnectedError)
    assert.equal(lost.written, true)
    const refused = await client.send('session.status', {}).catch((error: unknown) => error)
    assert.ok(refused instanceof BidiClosedError)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(reasons.length, 1)
    const late: string[] = []
    client.onDisconnect((reason) => late.push(reason))
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.deepEqual(late, reasons, 'a listener added after the loss still hears it, once')
  })

  test('more commands than the limit allows waiting are refused before they are sent', async () => {
    endpoint.on('script.evaluate', () => 'silent')
    const client = await connect(1)
    const first = client.send('script.evaluate', {}, { timeoutMs: 200 }).catch((error: unknown) => error)
    const second = await client.send('script.evaluate', {}).catch((error: unknown) => error)
    assert.ok(second instanceof BidiPendingLimitError)
    assert.ok((await first) instanceof BidiTimeoutError)
    client.close()
  })

  test('a WebSocket that never opens fails to connect, naming the address', async () => {
    const failed = await BidiClient.connect('ws://127.0.0.1:9/session', { timeoutMs: 500, onDiagnostic: () => {} }).catch((error: unknown) => error)
    assert.ok(failed instanceof BidiConnectError)
    assert.match(failed.message, /ws:\/\/127\.0\.0\.1:9\/session/)
  })

  test('keys a result has beyond what Retest reads are dropped, in objects, arrays and each option of a union', () => {
    const part = s.discriminatedUnion('type', [s.object({ type: s.literal('node'), sharedId: s.string() }), s.object({ type: s.literal('string'), value: s.string() })])
    const schema = s.object({ value: s.array(part) })
    const read = readBidi(schema, { value: [{ type: 'node', sharedId: 'a', value: { nodeType: 1 } }, { type: 'string', value: 'Password', extra: true }], more: 1 }, 'script.callFunction')
    assert.deepEqual(read, { value: [{ type: 'node', sharedId: 'a' }, { type: 'string', value: 'Password' }] })
  })

  test('a result missing what Retest relies on names only the path, never the value', () => {
    const read = (): unknown => readBidi(s.object({ realm: s.string() }), { realm: 42, text: 'page text' }, 'script.callFunction')
    assert.throws(read, (error: unknown) => error instanceof BidiInvalidResponseError && /\$\.realm/.test(error.message) && !/42|page text/.test(error.message))
  })
})
