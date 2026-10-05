import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { openWindow } from '../../src/browser/firefox/browser.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// Firefox 133 fails a tab or window asked for while another window is still being built ("tabBrowser is undefined"),
// so one browser opens its windows one at a time, over a scripted endpoint here.

let endpoint: ScriptedBidi
let client: BidiClient

before(async () => {
  endpoint = await ScriptedBidi.start()
  client = await BidiClient.connect(endpoint.url, { timeoutMs: 30_000, onDiagnostic: () => {} })
})

after(async () => {
  client.close()
  await endpoint.close()
})

beforeEach(() => {
  endpoint.sent.length = 0
})

test('a window asked for while another is being opened is sent only once that one has been answered', async () => {
  const events: string[] = []
  let opened = 0
  endpoint.on('browsingContext.create', async () => {
    opened += 1
    const window = `window-${opened}`
    events.push(`asked ${window}`)
    await new Promise((resolve) => setTimeout(resolve, 80))
    events.push(`answered ${window}`)
    return { result: { context: window } }
  })
  const windows = await Promise.all([openWindow(client, 'user-1', new Deadline(2000)), openWindow(client, 'user-2', new Deadline(2000))])
  assert.deepEqual(windows, ['window-1', 'window-2'])
  assert.deepEqual(events, ['asked window-1', 'answered window-1', 'asked window-2', 'answered window-2'])
})

test('a window whose turn does not come within its budget fails by name, and nothing is sent for it', async () => {
  endpoint.on('browsingContext.create', () => 'silent')
  const first = openWindow(client, 'user-3', new Deadline(400)).catch((error: unknown) => error)
  const second = await openWindow(client, 'user-4', new Deadline(100)).catch((error: unknown) => error)
  assert.ok(second instanceof BrowserError)
  assert.equal(second.failure.class, 'timeout')
  assert.match(second.failure.message, /still opening or closing another window/)
  assert.deepEqual(endpoint.commands('browsingContext.create').map((command) => command.params['userContext']), ['user-3'])
  assert.ok((await first) instanceof BrowserError, 'the window Firefox never answered fails within its own budget')
})
