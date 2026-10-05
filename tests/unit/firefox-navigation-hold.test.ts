import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, test } from 'node:test'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { NavigationHold } from '../../src/browser/firefox/navigation-hold.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'

// The navigation hold a Firefox fill bound to origins arms right before its input (review F-3, F-9, F-10), over a
// scripted BiDi endpoint: what it holds, what it lets go at once, and that its release is bounded by the command.

const tab = 'tab-1'
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

// Each test's intercept has an id of its own, as Firefox gives, so a hold still answering late requests from an earlier
// test never answers for this one.
let intercepts = 0
let intercept = ''

beforeEach(() => {
  endpoint.sent.length = 0
  intercepts += 1
  intercept = `intercept-${intercepts}`
  endpoint.on('network.addIntercept', () => ({ result: { intercept } }))
  endpoint.accept('network.removeIntercept', 'network.continueRequest', 'network.failRequest')
})

type Harness = { failed: string[]; stopped: number; subscriptions: number; start(url: string): void }

async function armed(deadline = new Deadline(2000)): Promise<{ hold: NavigationHold; harness: Harness }> {
  const starts = new Set<(url: string) => void>()
  const harness: Harness = { failed: [], stopped: 0, subscriptions: 0, start: (url) => { for (const listener of starts) listener(url) } }
  const hold = await NavigationHold.arm(
    {
      client,
      context: tab,
      subscribe: async () => { harness.subscriptions += 1 },
      unsubscribe: () => { harness.subscriptions -= 1 },
      onNavigationStart: (listener) => {
        starts.add(listener)
        return () => starts.delete(listener)
      },
      navigationFailed: (navigation) => harness.failed.push(navigation),
      stopLoading: async () => { harness.stopped += 1 },
    },
    deadline,
  )
  return { hold, harness }
}

function paused(request: string, fields: { context: string | null; navigation: string | null; intercepts?: string[]; url?: string }): void {
  endpoint.emit('network.beforeRequestSent', { isBlocked: true, intercepts: fields.intercepts ?? [intercept], context: fields.context, navigation: fields.navigation, redirectCount: 0, timestamp: 1, request: { request, url: fields.url ?? 'http://127.0.0.1:4173/data', method: 'GET' } })
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50))
}

const continued = (): unknown[] => endpoint.commands('network.continueRequest').map((command) => command.params['request'])
const failed = (): unknown[] => endpoint.commands('network.failRequest').map((command) => command.params['request'])

describe('the Firefox navigation hold', () => {
  test('subscribing and arming the intercept share the same command deadline', async () => {
    endpoint.on('network.addIntercept', () => 'silent')
    const startedAt = performance.now()
    await assert.rejects(NavigationHold.arm({
      client,
      context: tab,
      subscribe: async () => { await new Promise((resolve) => setTimeout(resolve, 80)) },
      unsubscribe: () => {},
      onNavigationStart: () => () => {},
      navigationFailed: () => {},
      stopLoading: async () => {},
    }, new Deadline(100)))
    assert.ok(performance.now() - startedAt < 150, 'arming never receives a second full command budget')
  })

  test("holds only a navigation of the tab's own document; a frame's request and a frame's navigation go on at once", async () => {
    const { hold } = await armed()
    paused('frame-fetch', { context: 'frame-1', navigation: null })
    paused('frame-document', { context: 'frame-1', navigation: 'navigation-in-frame' })
    paused('page-fetch', { context: tab, navigation: null })
    paused('page-document', { context: tab, navigation: 'navigation-1', url: 'http://elsewhere.test/next' })
    await settle()
    assert.deepEqual(continued().sort(), ['frame-document', 'frame-fetch', 'page-fetch'])
    assert.equal(hold.leaving, 'http://elsewhere.test', 'the navigation asked for before the text went is the one the fill refuses')
    await hold.release(true, new Deadline(2000))
    assert.deepEqual(failed(), ['page-document'])
  })

  test("leaves another page's paused request to that page's own hold", async () => {
    const { hold } = await armed()
    paused('other-tab', { context: 'tab-2', navigation: 'navigation-2', intercepts: ['intercept-9'] })
    await settle()
    assert.deepEqual([...continued(), ...failed()], [])
    assert.equal(hold.leaving, undefined)
    await hold.release(false, new Deadline(2000))
  })

  test('a navigation asked for while the text is typed is let go when the hold is released', async () => {
    const { hold, harness } = await armed()
    hold.typing()
    harness.start('http://127.0.0.1:4173/welcome')
    paused('page-document', { context: tab, navigation: 'navigation-1', url: 'http://127.0.0.1:4173/welcome' })
    await settle()
    assert.equal(hold.leaving, undefined)
    await hold.release(false, new Deadline(2000))
    assert.deepEqual(continued(), ['page-document'])
    assert.deepEqual(harness.failed, [])
  })

  test('a request Firefox paused before the intercept went but told of after is still answered', async () => {
    const { hold } = await armed()
    await hold.release(false, new Deadline(2000))
    paused('late-fetch', { context: 'frame-1', navigation: null })
    await settle()
    assert.deepEqual(continued(), ['late-fetch'])
  })

  test("the release waits for Firefox no longer than the command's own deadline, and still sends every command", async () => {
    const { hold } = await armed()
    paused('page-document', { context: tab, navigation: 'navigation-1' })
    await settle()
    endpoint.on('network.removeIntercept', () => 'silent')
    endpoint.on('network.failRequest', () => 'silent')
    const startedAt = performance.now()
    await hold.release(true, new Deadline(0))
    const elapsedMs = performance.now() - startedAt
    assert.ok(elapsedMs < 200, `a release past the deadline returns at once, after ${Math.round(elapsedMs)} ms`)
    await settle()
    assert.deepEqual([endpoint.commands('network.removeIntercept').length, failed()], [1, ['page-document']], 'the commands went to Firefox all the same')
  })

  test('a hold that cannot set its intercept leaves no subscription behind', async () => {
    endpoint.on('network.addIntercept', () => ({ error: 'unknown error' }))
    const harness = { subscriptions: 0 }
    await assert.rejects(
      NavigationHold.arm(
        {
          client,
          context: tab,
          subscribe: async () => { harness.subscriptions += 1 },
          unsubscribe: () => { harness.subscriptions -= 1 },
          onNavigationStart: () => () => {},
          navigationFailed: () => {},
          stopLoading: async () => {},
        },
        new Deadline(2000),
      ),
    )
    assert.equal(harness.subscriptions, 0)
  })
})
