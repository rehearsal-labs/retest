import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { firefoxGate } from '../integration/firefox-gate.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The gate the shared suites hold Firefox's input back with (review F-8), over a scripted endpoint: a press is split at
// its first key up so the key up can be held, a fill's keys are the text, and every other command goes as it was sent.

test('the Firefox gate splits a press at its key up, holds what the test holds, and lets every other command go as sent', async (t) => {
  const endpoint = await ScriptedBidi.start()
  const held: string[] = []
  const release = Promise.withResolvers<void>()
  const loads: string[] = []
  const socket = firefoxGate({
    hold: (input) => {
      held.push(input)
      return input === 'key up' ? release.promise : undefined
    },
    loaded: (url) => loads.push(url),
  })
  const diagnostics: string[] = []
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.kind), socket })
  t.after(async () => {
    client.close()
    await endpoint.close()
  })
  endpoint.accept('input.performActions', 'browsingContext.getTree')
  const meta = ''
  const enter = ''
  const press = [{ type: 'key', id: 'retest-keyboard', actions: [{ type: 'keyDown', value: meta }, { type: 'keyDown', value: enter }, { type: 'keyUp', value: enter }, { type: 'keyUp', value: meta }] }]
  const pressing = client.send('input.performActions', { context: 'tab-1', actions: press })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(endpoint.commands('input.performActions').map((command) => command.params['actions']), [[{ ...press[0], actions: press[0]?.actions.slice(0, 2) }]], 'the keys went down, and the key up waits')
  release.resolve()
  await pressing
  assert.deepEqual(endpoint.commands('input.performActions').at(-1)?.params['actions'], [{ ...press[0], actions: press[0]?.actions.slice(2) }])
  const typing = [{ type: 'key', id: 'retest-keyboard', actions: ['a', 'b'].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }]
  await client.send('input.performActions', { context: 'tab-1', actions: typing })
  assert.deepEqual(endpoint.commands('input.performActions').at(-1)?.params['actions'], typing, 'a fill goes whole')
  await client.send('browsingContext.getTree', {})
  assert.deepEqual(held, ['key down', 'key up', 'text'])
  endpoint.emit('browsingContext.load', { context: 'tab-1', navigation: 'n', timestamp: 1, url: 'http://127.0.0.1:4173/' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(loads, ['http://127.0.0.1:4173/'])
  assert.deepEqual(diagnostics, ['unmatched-response'], "the answer to the gate's own command is one the client was not waiting for")
})
