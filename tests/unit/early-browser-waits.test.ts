import type { TestContext } from 'node:test'
import type { WorldArguments } from '../../src/browser/isolated-world.ts'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { Schema } from '../../src/protocol/schema.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitUntilActionable } from '../../src/browser/actionability.ts'
import { awaitCheckedState } from '../../src/browser/checked-state.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { CdpClosedError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { AppWindows } from '../../src/browser/electron.ts'
import { BidiProtocolError, BidiInvalidResponseError } from '../../src/browser/firefox/bidi-errors.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxPage } from '../../src/browser/firefox/page.ts'
import { inWindowOrder } from '../../src/browser/firefox/window-order.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { checkedFunction, disarmFunction, prepareFunction, selectionFunction, setOffFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { WebKitPage } from '../../src/browser/webkit/page.ts'
import { listPlanFunction } from '../../src/browser/webkit/select.ts'
import { WebKitTargetSession } from '../../src/browser/webkit/target-session.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { readProtocol } from '../../src/browser/cdp-results.ts'
import { protocolError, scriptedPage } from './browser-fixtures.ts'
import { earlyClock, fullBudget } from './early-waits-clock.ts'
import { ScriptedBidi } from './firefox-scripted-bidi.ts'
import { scriptedBuild } from './webkit-scripted-inspector.ts'

const locator = { by: 'testId', value: 'subject' } as const
const facts = { href: 'http://app.test/', title: 'App' }
const timeout = () => new CdpTimeoutError({ method: 'Runtime.callFunctionOn', sessionId: 'S' }, { timeoutMs: 1, written: true })

function worldAnswers(t: TestContext, answer: (fn: string) => unknown): void {
  const read = <T>(fn: string, schema: Schema<T>): T => readProtocol(schema, answer(fn), { method: 'Runtime.callFunctionOn' })
  t.mock.method(IsolatedWorld.prototype, 'enter', async <T>(fn: string, _args: WorldArguments, schema: Schema<T>) => ({ value: read(fn, schema), context: 5 }))
  t.mock.method(IsolatedWorld.prototype, 'call', async <T>(fn: string, _args: WorldArguments, schema: Schema<T>) => read(fn, schema))
  t.mock.method(IsolatedWorld.prototype, 'callIn', async <T>(_context: number, fn: string, _args: WorldArguments, schema: Schema<T>) => read(fn, schema))
}

async function enginePage(t: TestContext, engine: string): Promise<{ page: OwnedPage; client?: BidiClient; inputCount: () => number; screenshotReply: (answer: () => unknown) => Promise<void> }> {
  if (engine === 'Chrome') {
    let capture: () => unknown = () => ({ data: 'aQ==' })
    const { page, sent } = scriptedPage({ call: async () => assert.fail('world calls are mocked'), other: async (method) => method === 'Page.captureScreenshot' ? capture() : {} })
    return { page, inputCount: () => sent.filter((command) => command.method.startsWith('Input.')).length, screenshotReply: async (answer) => { capture = answer } }
  }
  if (engine === 'Firefox') {
    const endpoint = await ScriptedBidi.start()
    const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
    t.after(async () => { client.close(); await endpoint.close() })
    endpoint.accept('session.subscribe', 'session.unsubscribe', 'script.removePreloadScript', 'input.performActions', 'input.releaseActions', 'browsingContext.activate')
    endpoint.on('script.addPreloadScript', () => ({ result: { script: 'preload' } }))
    endpoint.on('browsingContext.getTree', () => ({ result: { contexts: [{ context: 'tab', url: 'about:blank', children: [] }] } }))
    endpoint.on('script.callFunction', () => ({ result: { type: 'success', realm: 'realm', result: { type: 'undefined' } } }))
    const page = await FirefoxPage.open({ client, context: 'tab', userContext: 'user', baseUrl: undefined, emulation: undefined, restoredOrigins: [], onListenerError: () => {} }, new Deadline(2000))
    // This pending document is what makes a missing screenshot retryable.
    return { page, client, inputCount: () => endpoint.sent.filter((command) => command.method.startsWith('input.')).length, screenshotReply: async (answer) => {
      endpoint.emit('browsingContext.navigationStarted', { context: 'tab', navigation: 'n', timestamp: 0, url: 'http://app.test/' })
      endpoint.accept('session.status'); await client.send('session.status', {})
      t.mock.method(client, 'request', async () => answer())
    } }
  }
  const build = scriptedBuild(t)
  build.serve((command) => {
    if (command.method === 'Page.getResourceTree') return { frameTree: { frame: { id: 'frame', url: 'about:blank', loaderId: 'L0', securityOrigin: '', mimeType: 'text/html' }, resources: [] } }
    if (command.method === 'Runtime.evaluate') return { result: { type: 'boolean', value: true } }
    return {}
  })
  const page = new WebKitPage({ connection: build.connection, pageProxyId: '7', browserContextId: 'context', setup: { baseUrl: undefined, screen: { viewport: { width: 640, height: 480 }, deviceScaleFactor: 1 }, restoredOrigins: [] }, openSidePage: async () => assert.fail('no side page'), onListenerError: (error) => assert.fail(String(error)) })
  t.after(() => page.markClosed('test ended'))
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page', type: 'page', isPaused: true } })
  await page.ready
  return { page, inputCount: () => build.received.filter((command) => command.method.startsWith('Input.')).length, screenshotReply: async (answer) => { t.mock.method(WebKitTargetSession.prototype, 'target', async () => answer()) } }
}

for (const engine of ['Chrome', 'Firefox', 'WebKit']) {
  test(`${engine} screenshot retries send their final probe after early timers and a straddling read`, async (t) => {
    const { page, screenshotReply } = await enginePage(t, engine)
    const clock = earlyClock(t)
    const probes: number[] = []
    await screenshotReply(() => {
      probes.push(clock.now()); clock.spend()
      if (probes.at(-1)! >= 120) return engine === 'WebKit' ? { dataURL: 'data:image/png;base64,aQ==' } : { data: 'aQ==' }
      if (probes.length === 2) throw timeout()
      if (engine === 'WebKit') throw new CdpClosedError({ method: 'Page.snapshotRect', sessionId: undefined }, 'no document')
      if (engine === 'Firefox') throw new BidiProtocolError({ method: 'browsingContext.captureScreenshot' }, { error: 'unable to capture screen', message: undefined })
      throw protocolError('Page.captureScreenshot', 'Not attached to an active page')
    })
    assert.deepEqual(await clock.run(page.screenshot(120)), Buffer.from('i'))
    fullBudget(probes, clock.now())
  })

  test(`${engine} selection verification sends the final read after early timers and retries a read timeout`, async (t) => {
    const { page, inputCount } = await enginePage(t, engine)
    let inputsBeforeVerification: number | undefined
    // Action readiness must not wait on the screenshot test's pending navigation.
    const clock = earlyClock(t)
    const reads: number[] = []
    worldAnswers(t, (fn) => {
      if (fn === prepareFunction) return { status: 'ready', point: null, token: 1, via: null, scale: 1, page: facts, plan: { quietMs: 0, keys: [{ key: 'w', toggle: false }] } }
      if (fn === selectionFunction) {
        inputsBeforeVerification ??= inputCount()
        reads.push(clock.now()); clock.spend()
        if (reads.length === 2) throw timeout()
        return { status: reads.at(-1)! >= 120 ? 'selected' : 'other', selected: reads.at(-1)! >= 120 ? ['Wanted'] : [], page: facts }
      }
      if (fn === listPlanFunction) return { status: 'single' }
      if (fn === verdictFunction) return { reached: ['keydown', 'keyup'], intercepted: null, landed: '<select>', leaving: null }
      if (fn === setOffFunction) return false
      if (fn === disarmFunction) return true
      return true
    })
    const result = await clock.run(page.execute({ kind: 'select', locator, choices: [{ label: 'Wanted' }] }, 120))
    assert.ok(result.ok && result.kind === 'select' && result.changed, JSON.stringify(result))
    assert.ok((inputsBeforeVerification ?? 0) > 0, 'the key went before verification')
    assert.equal(inputCount(), inputsBeforeVerification, 'verification never types again')
    fullBudget(reads, clock.now())
  })
}

test('browser actionability sends a final readiness look after an early read timeout', async (t) => {
  const { session } = scriptedPage({ call: async () => assert.fail('mocked') })
  const world = new IsolatedWorld(session, () => 'F1')
  const clock = earlyClock(t)
  const reads: number[] = []
  worldAnswers(t, () => {
    reads.push(clock.now()); clock.spend()
    if (reads.length <= 2) throw timeout()
    return { status: 'missing', empty: null }
  })
  const result = await clock.run(waitUntilActionable({ world, locator, intent: { action: 'click', multiline: false }, deadline: new Deadline(120), pendingNavigation: () => undefined }))
  assert.ok(!result.ok && result.failure.class === 'not_found')
  fullBudget(reads, clock.now())
})

test('checked-state verification sends its final read after early timers and an early read timeout', async (t) => {
  const { session } = scriptedPage({ call: async () => assert.fail('mocked') })
  const world = new IsolatedWorld(session, () => 'F1')
  const clock = earlyClock(t)
  const reads: number[] = []
  worldAnswers(t, (fn) => {
    assert.equal(fn, checkedFunction); reads.push(clock.now()); clock.spend()
    if (reads.length === 2) throw timeout()
    return false
  })
  const result = await clock.run(awaitCheckedState({ world, locator, intent: { action: 'check', pointer: 'click', multiline: false }, via: undefined, deadline: new Deadline(120) }))
  assert.equal(result?.class, 'not_actionable')
  fullBudget(reads, clock.now())
})

test('Electron first-window readiness rechecks an early end timer', async (t) => {
  const connection = new CdpConnection({ listen: () => {}, send: () => ({ written: true, withdraw: () => {} }), close: () => {} }, { timeoutMs: 1000, onDiagnostic: () => {} })
  t.after(() => connection.close())
  const windows = new AppWindows(connection, 0, () => {})
  const clock = earlyClock(t)
  await assert.rejects(clock.run(windows.first(new Deadline(120))), /window/)
  assert.ok(clock.now() >= 120, `refused at ${clock.now()}`)
  assert.ok(clock.now() < 122)
})

test('Firefox window ordering rechecks its end timer', async (t) => {
  const endpoint = await ScriptedBidi.start()
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
  t.after(async () => { client.close(); await endpoint.close() })
  const previous = Promise.withResolvers<void>()
  const first = inWindowOrder(client, new Deadline(2000), () => previous.promise)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const clock = earlyClock(t)
  const waiting = inWindowOrder(client, new Deadline(120), async () => assert.fail('turn never came'))
  await assert.rejects(clock.run(waiting), /still opening/)
  assert.ok(clock.now() >= 120, `refused at ${clock.now()}`)
  assert.ok(clock.now() < 122)
  previous.resolve(); await first
})

for (const engine of ['Firefox', 'WebKit']) {
  test(`${engine} returned whole-budget action refusals are held through early timers`, async (t) => {
    const { page } = await enginePage(t, engine)
    const clock = earlyClock(t)
    // A lower layer can exhaust its whole-millisecond allocation before the enclosing exact deadline.
    t.mock.getter(Deadline.prototype, 'reached', () => true)
    worldAnswers(t, () => { clock.spend(Math.max(0, 119.5 - clock.now())); return { status: 'missing', empty: null } })
    const result = await clock.run(page.execute({ kind: 'click', locator }, 120))
    assert.ok(!result.ok && result.failure.class === 'not_found', JSON.stringify(result))
    assert.ok(clock.now() >= 120, `refused at ${clock.now()}`)
    assert.ok(clock.now() < 122)
  })

  test(`${engine} a stop during a whole-budget refusal hold preserves the stop`, async (t) => {
    const { page } = await enginePage(t, engine)
    const clock = earlyClock(t)
    t.mock.getter(Deadline.prototype, 'reached', () => true)
    const stop = new AbortController()
    const failure = { class: 'interrupted', message: 'Stopped while waiting.' } as const
    worldAnswers(t, () => {
      clock.spend(Math.max(0, 119.5 - clock.now()))
      setTimeout(() => stop.abort(failure), 1)
      return { status: 'missing', empty: null }
    })
    const result = await clock.run(page.execute({ kind: 'click', locator }, 120, stop.signal))
    assert.ok(!result.ok && result.failure.class === 'interrupted', JSON.stringify(result))
    assert.match(result.failure.message, /^Stopped while waiting\./)
    assert.equal(result.failure.details?.['inputSent'], false)
    assert.ok(clock.now() < 120, `stop held until ${clock.now()}`)
  })

  test(`${engine} an ambiguous match just before the limit returns unchanged before a later stop`, async (t) => {
    const { page } = await enginePage(t, engine)
    const clock = earlyClock(t)
    const stop = new AbortController()
    worldAnswers(t, () => {
      clock.spend(Math.max(0, 119.5 - clock.now()))
      setTimeout(() => stop.abort({ class: 'interrupted', message: 'Later stop.' }), 1)
      return { status: 'ambiguous', count: 2 }
    })
    const result = await clock.run(page.execute({ kind: 'click', locator }, 120, stop.signal))
    assert.ok(!result.ok && result.failure.class === 'ambiguous', JSON.stringify(result))
    assert.equal(stop.signal.aborted, false)
    assert.equal(clock.now(), 119.5)
  })
}

test('Firefox screenshot retries preserve a non-time protocol failure immediately during navigation', async (t) => {
  const { page, screenshotReply } = await enginePage(t, 'Firefox')
  const clock = earlyClock(t)
  const failure = new BidiInvalidResponseError({ method: 'browsingContext.captureScreenshot' }, 'malformed reply')
  await screenshotReply(() => { clock.spend(Math.max(0, 100 - clock.now())); throw failure })
  await assert.rejects(clock.run(page.screenshot(120)), /response|malformed|read/i)
  assert.equal(clock.now(), 100)
})

test('Firefox window ordering permits a turn in the deadline\'s last fraction', async (t) => {
  const endpoint = await ScriptedBidi.start()
  const client = await BidiClient.connect(endpoint.url, { timeoutMs: 2000, onDiagnostic: () => {} })
  t.after(async () => { client.close(); await endpoint.close() })
  const previous = Promise.withResolvers<void>()
  const first = inWindowOrder(client, new Deadline(2000), () => previous.promise)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const clock = earlyClock(t)
  let sent = 0
  const second = inWindowOrder(client, new Deadline(120), async () => { sent++; return 'opened' })
  clock.spend(119.5)
  previous.resolve()
  assert.equal(await clock.run(second), 'opened')
  await first
  assert.equal(sent, 1)
  assert.equal(clock.now(), 119.5)
})

for (const closes of [true, false]) {
  test(`Firefox dispatched protocol failure survives ${closes ? 'a later connection loss' : 'a later stop'} unchanged`, async (t) => {
    const { page, client } = await enginePage(t, 'Firefox')
    assert.ok(client !== undefined)
    assert.ok(page instanceof FirefoxPage)
    const clock = earlyClock(t)
    const stop = new AbortController()
    let inputs = 0
    const send = client.send.bind(client)
    t.mock.method(client, 'send', async (...args: Parameters<BidiClient['send']>) => {
      if (args[0] !== 'input.performActions') return send(...args)
      inputs++
      clock.spend(Math.max(0, 119.5 - clock.now()))
      setImmediate(() => closes ? client.close() : stop.abort({ class: 'interrupted', message: 'Later stop.' }))
      throw new BidiProtocolError({ method: 'input.performActions' }, { error: 'unknown error', message: undefined })
    })
    worldAnswers(t, (fn) => fn === prepareFunction
      ? { status: 'ready', point: { x: 10, y: 10 }, token: 1, via: null, scale: 1, page: facts, plan: null }
      : true)
    const { result, input } = await clock.run(page.dispatch({ kind: 'click', locator }, 120, stop.signal))
    assert.equal(input, 'unknown')
    assert.equal(inputs, 1)
    assert.ok(!result.ok)
    assert.equal(result.failure.class, 'outcome_unknown')
    assert.equal(result.failure.message, "Retest began to click getByTestId('subject'), then the browser gave an answer it cannot read, so it cannot tell whether that took effect: input.performActions failed: unknown error (-32000)")
    assert.equal(clock.now(), 119.5, 'no deadline hold follows a non-time failure')
    await new Promise<void>((resolve) => setImmediate(resolve))
    if (closes) {
      assert.ok(page instanceof FirefoxPage)
      assert.ok(page.lostReason !== undefined, 'the later connection loss really arrived')
    } else assert.equal(stop.signal.aborted, true, 'the later stop really arrived')
  })
}
