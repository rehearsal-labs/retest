import type { TestContext } from 'node:test'
import type { ReceivedCommand, ScriptedBuild } from './webkit-scripted-inspector.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { CdpBlockedError, CdpClosedError, CdpDisconnectedError, CdpProtocolError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { isGoneContext, neverRan } from '../../src/browser/isolated-world.ts'
import { LostReadingError, WebKitTargetSession } from '../../src/browser/webkit/target-session.ts'
import { scriptedBuild } from './webkit-scripted-inspector.ts'

// The bridge is the one place WebKit's protocol differs from what the shared CDP code expects; each mapping is held
// here against a scripted build, and the integration tests show the shared code working through it on the real one.

const secret = 'retest-test-secret'

function bridgeOn(t: TestContext, build: ScriptedBuild = scriptedBuild(t)): { build: ScriptedBuild; bridge: WebKitTargetSession } {
  const bridge = new WebKitTargetSession({ connection: build.connection, pageProxyId: '7', secret, worldName: 'retest', onListenerError: () => {} })
  t.after(() => bridge.close('the test ended'))
  bridge.committed('page-8')
  bridge.mainFrame('page-8', 'frame-1')
  return { build, bridge }
}

/** Answers the guard's installation in a world, and the read of its global object, as the build would. */
function serveWorlds(build: ScriptedBuild, globals: Map<number, string> = new Map()): void {
  build.serve((command) => {
    if (command.method !== 'Runtime.evaluate') return undefined
    if (String(command.params['expression']).includes('retestRelay')) return { result: { type: 'boolean', value: true } }
    if (command.params['expression'] === 'globalThis') return { result: { type: 'object', objectId: globals.get(Number(command.params['contextId'])) ?? `global-${String(command.params['contextId'])}` } }
    return undefined
  })
}

function userWorld(bridge: WebKitTargetSession, targetId: string, id: number, frameId = 'frame-1'): void {
  bridge.contextCreated(targetId, { context: { id, type: 'user', name: 'retest', frameId } })
}

async function next(build: ScriptedBuild, method: string): Promise<ReceivedCommand> {
  for (;;) {
    const command = await build.nextCommand()
    if (command.method === method) return command
  }
}

test("Chrome's isolated world is the main frame's user world, handed over once the relay and the guard are in it", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const asked = bridge.session.send('Page.createIsolatedWorld', { frameId: 'whatever frame', worldName: 'retest' })
  await nextTurn()
  userWorld(bridge, 'page-8', 4)
  const install = await build.nextCommand()
  assert.equal(install.method, 'Runtime.evaluate')
  assert.equal(install.targetId, 'page-8')
  assert.equal(install.params['contextId'], 4)
  assert.ok(String(install.params['expression']).includes(JSON.stringify(secret)))
  build.reply(install, { result: { type: 'boolean', value: true } })
  assert.deepEqual(await asked, { executionContextId: 1 })
})

test("a call into a world is WebKit's call on the world's global object, and its value comes back as Chrome's", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const answer = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'function (a) { return a }', executionContextId, arguments: [{ value: 3 }, { objectId: 'element-1' }], returnByValue: true, awaitPromise: true })
  const call = await next(build, 'Runtime.callFunctionOn')
  assert.deepEqual(call.params, { objectId: 'global-4', functionDeclaration: 'function (a) { return a }', arguments: [{ value: 3 }, { objectId: 'element-1' }], returnByValue: true, awaitPromise: true })
  build.reply(call, { result: { type: 'object', value: { count: 2 } }, wasThrown: false })
  assert.deepEqual(await answer, { result: { value: { count: 2 } } })
})

test("a script that threw is answered as Chrome's exception details, which the shared code turns into its failure", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const answer = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId, returnByValue: true, awaitPromise: true })
  build.reply(await next(build, 'Runtime.callFunctionOn'), { result: { type: 'object', subtype: 'error', description: 'TypeError: boom' }, wasThrown: true })
  assert.deepEqual(await answer, { result: { value: undefined }, exceptionDetails: { text: 'TypeError: boom', exception: { description: 'TypeError: boom' } } })
})

test("WebKit's answer for a world whose document went is Chrome's answer for a context that never ran the call", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const answer = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId })
  build.fail(await next(build, 'Runtime.callFunctionOn'), 'Missing injected script for given objectId')
  const error = await answer.catch((caught: unknown) => caught)
  assert.ok(isGoneContext(error) && neverRan(error), String(error))
  assert.ok(error instanceof CdpProtocolError && error.data === 'Missing injected script for given objectId', "WebKit's own words are kept beside it")
})

test('a call waiting in a world that a newer document replaces is answered as one whose context was destroyed', { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const answer = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'async function () { await new Promise(() => {}) }', executionContextId, awaitPromise: true })
  await next(build, 'Runtime.callFunctionOn')
  userWorld(bridge, 'page-8', 6)
  const error = await answer.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpProtocolError && error.protocolMessage === 'Execution context was destroyed.', String(error))
  assert.ok(isGoneContext(error) && !neverRan(error))
  const replaced = await bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId }).catch((caught: unknown) => caught)
  assert.ok(neverRan(replaced), 'the old world is never called again')
})

test('a world of a target a navigation swapped out is gone, and the next world handed over is the new target main frame\'s', { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  await worldOf(bridge)
  userWorld(bridge, 'page-50', 2, 'frame-2')
  bridge.committed('page-50')
  bridge.mainFrame('page-50', 'frame-2')
  const { executionContextId } = await worldOf(bridge)
  const answer = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId, returnByValue: true })
  const call = await next(build, 'Runtime.callFunctionOn')
  assert.deepEqual([call.targetId, call.params['objectId']], ['page-50', 'global-2'])
  build.reply(call, { result: { type: 'number', value: 1 } })
  await answer
})

test('a dialog blocks the page: a waiting command fails as blocked, and a new one is refused unsent until it closes', { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const waiting = bridge.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1, button: 'left', buttons: 1, clickCount: 1 })
  await build.nextCommand()
  bridge.block('a JavaScript alert dialog holds the page')
  const error = await waiting.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpBlockedError && error.written)
  const refused = await bridge.session.send('Input.insertText', { text: 'x' }).catch((caught: unknown) => caught)
  assert.ok(refused instanceof CdpBlockedError && !refused.written)
  bridge.unblock()
  const sent = bridge.session.send('Input.insertText', { text: 'x' })
  const command = await build.nextCommand()
  assert.deepEqual([command.method, command.targetId, command.params], ['Page.insertText', 'page-8', { text: 'x' }])
  build.reply(command, {})
  await sent
})

test("a page that ended fails its waiting commands as disconnected, saying they were written, and refuses later ones", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const waiting = bridge.session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0, text: 'a' })
  await build.nextCommand()
  bridge.close('the page crashed')
  const error = await waiting.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpDisconnectedError && error.written && error.reason === 'the page crashed')
  const refused = await bridge.session.send('Input.insertText', { text: 'x' }).catch((caught: unknown) => caught)
  assert.ok(refused instanceof CdpClosedError)
})

type Properties = { exists: boolean; ignored?: boolean; role: string; label: string }

/**
 * Answers a reading of the document as the build would: the document, its elements by selector, WebKit's accessibility
 * of each, and each element made an object, `element-<node id>`. `missing` says, per command, whether WebKit answers
 * that its node is gone instead.
 */
function serveReading(build: ScriptedBuild, page: { all: number[]; properties: Record<number, Properties> | 'answered elsewhere'; selectors?: Record<string, number[]>; missing?: (command: ReceivedCommand) => boolean }): void {
  const { properties } = page
  build.serve((command) => {
    if (page.missing?.(command) === true) return new Error('Missing node for given nodeId')
    if (command.method === 'Runtime.evaluate' && command.params['expression'] === 'document') return { result: { type: 'object', objectId: `document-${command.id}` } }
    if (command.method === 'Runtime.evaluate' && String(command.params['expression']).includes('checkVisibility')) return { result: { type: 'object', value: [] } }
    if (command.method === 'Runtime.evaluate' && String(command.params['expression']).includes('querySelectorAll')) return { result: { type: 'object', value: [] } }
    if (command.method === 'DOM.getDocument') return { root: { nodeId: 1 } }
    if (command.method === 'DOM.querySelectorAll') {
      const selector = String(command.params['selector'])
      return { nodeIds: selector === '*' ? page.all : (Object.entries(page.selectors ?? {}).find(([start]) => selector.startsWith(start))?.[1] ?? []) }
    }
    if (command.method === 'DOM.getAccessibilityPropertiesForNode') return properties === 'answered elsewhere' ? undefined : { properties: properties[Number(command.params['nodeId'])] ?? { exists: false, role: '', label: '' } }
    if (command.method === 'DOM.resolveNode') return { object: { type: 'object', objectId: `element-${String(command.params['nodeId'])}` } }
    if (command.method === 'Runtime.releaseObjectGroup') return {}
    return undefined
  })
}

/** One look as the shared role lookup makes it: the document as an object of the world and group, then the tree query. */
async function lookFor(bridge: WebKitTargetSession, executionContextId: number, role: string, group: string, timeoutMs?: number): Promise<{ nodes: { name: { value: string }; backendDOMNodeId: number }[] }> {
  const options = timeoutMs === undefined ? undefined : { timeoutMs }
  const document = await bridge.session.send('Runtime.evaluate', { expression: 'document', contextId: executionContextId, objectGroup: group }, options)
  const objectId = typeof document === 'object' && document !== null && 'result' in document && typeof document.result === 'object' && document.result !== null && 'objectId' in document.result ? String(document.result.objectId) : ''
  const answer = await bridge.session.send('Accessibility.queryAXTree', { objectId, role }, options)
  if (typeof answer !== 'object' || answer === null || !('nodes' in answer) || !Array.isArray(answer.nodes)) throw new Error('no nodes')
  return { nodes: answer.nodes.map((node: { name: { value: string }; backendDOMNodeId: number }) => node) }
}

test("Chrome's tree query is answered from WebKit's accessibility of every element, a select and a number field named as Chrome names them", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const properties: Record<number, Properties> = {
    10: { exists: true, role: 'button', label: 'Save' },
    11: { exists: true, ignored: true, role: 'button', label: 'Save' },
    12: { exists: false, role: '', label: '' },
    13: { exists: true, role: 'button', label: 'Size' },
    14: { exists: true, role: 'textbox', label: 'Count' },
  }
  serveReading(build, { all: [10, 11, 12, 13, 14], properties, selectors: { 'select:not([multiple])': [13], 'input[type="number" i]': [14] } })
  const document = await bridge.session.send('Runtime.evaluate', { expression: 'document', contextId: executionContextId, objectGroup: 'g1' })
  assert.deepEqual(document, { result: { type: 'object', objectId: `document-${build.received.at(-1)?.id}` } })
  const objectId = `document-${build.received.at(-1)?.id}`
  const buttons = await bridge.session.send('Accessibility.queryAXTree', { objectId, role: 'button' })
  const combobox = await bridge.session.send('Accessibility.queryAXTree', { objectId, role: 'combobox' })
  const spinbutton = await bridge.session.send('Accessibility.queryAXTree', { objectId, role: 'spinbutton' })
  const named = [buttons, combobox, spinbutton].map((answer) => (answer as { nodes: { ignored: boolean; name: { value: string }; backendDOMNodeId: number }[] }).nodes)
  assert.deepEqual(named.map((nodes) => nodes.map(({ ignored, name }) => [ignored, name.value])), [[[false, 'Save']], [[false, 'Size']], [[false, 'Count']]])
  // Each element is handed out by the bridge's own key, which resolves to the object WebKit made for that very node.
  const objects = []
  for (const nodes of named) {
    for (const { backendDOMNodeId } of nodes) objects.push(await bridge.session.send('DOM.resolveNode', { backendNodeId: backendDOMNodeId, executionContextId, objectGroup: 'g1' }))
  }
  assert.deepEqual(objects, [10, 13, 14].map((nodeId) => ({ object: { type: 'object', objectId: `element-${nodeId}` } })))
  assert.deepEqual(build.received.filter((command) => command.method === 'DOM.resolveNode').map((command) => [command.params['nodeId'], command.params['executionContextId'], command.params['objectGroup']]), [[10, 4, 'g1'], [13, 4, 'g1'], [14, 4, 'g1']])
  assert.equal(build.received.filter((command) => command.method === 'DOM.getDocument').length, 1, 'one reading of the document serves every role a lookup asks for')
})

// W-1: WebKit's `DOM.getDocument` gives every node a new id. Two looks at once once shared a half-cancelled document,
// and a node the reading lost was dropped as if the page had none: 400 buttons were counted as 0, 100, 200 or 300.
test('looks at once take their target turn by turn: the document is asked for once, and each look makes its elements objects before the next reads', { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const all = Array.from({ length: 250 }, (_, index) => 100 + index)
  const properties = Object.fromEntries(all.map((nodeId) => [nodeId, { exists: true, role: 'button', label: `Item ${nodeId}` }]))
  serveReading(build, { all, properties })
  const looks = await Promise.all(['g1', 'g2', 'g3'].map((group) => lookFor(bridge, executionContextId, 'button', group)))
  assert.deepEqual(looks.map((look) => look.nodes.length), [250, 250, 250])
  assert.equal(build.received.filter((command) => command.method === 'DOM.getDocument').length, 1, 'the document is asked for once, so no node id handed out is ever cancelled')
  // Every resolve of a look comes before the next look's reading begins.
  const order = build.received.flatMap((command) => {
    if (command.method === 'DOM.querySelectorAll' && command.params['selector'] === '*') return ['read']
    if (command.method === 'DOM.resolveNode') return [String(command.params['objectGroup'])]
    return []
  })
  const runs = order.filter((entry, index) => index === 0 || entry !== order[index - 1])
  assert.deepEqual(runs.map((entry) => entry === 'read' ? 'read' : 'resolve'), ['read', 'resolve', 'read', 'resolve', 'read', 'resolve'])
})

test('a node WebKit lost while the document was read is read again, never left out, and a look that keeps losing it ends named once its one budget is spent', { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  serveWorlds(build)
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const properties = { 10: { exists: true, role: 'button', label: 'One' }, 11: { exists: true, role: 'button', label: 'Two' } }
  let lostOnce = 0
  serveReading(build, {
    all: [10, 11],
    properties,
    missing: (command) => command.method === 'DOM.getAccessibilityPropertiesForNode' && command.params['nodeId'] === 11 && (lostOnce += 1) === 1,
  })
  const look = await lookFor(bridge, executionContextId, 'button', 'g1')
  assert.deepEqual(look.nodes.map((node) => node.name.value), ['One', 'Two'], 'both buttons, after reading the document again')
  assert.equal(build.received.filter((command) => command.method === 'DOM.querySelectorAll' && command.params['selector'] === '*').length, 2)

  const { build: lossy, bridge: lossyBridge } = bridgeOn(t)
  serveWorlds(lossy)
  userWorld(lossyBridge, 'page-8', 4)
  const lossyWorld = await worldOf(lossyBridge)
  serveReading(lossy, { all: [10, 11], properties, missing: (command) => command.method === 'DOM.resolveNode' && command.params['nodeId'] === 11 })
  const started = performance.now()
  const error = await lookFor(lossyBridge, lossyWorld.executionContextId, 'button', 'g1', 150).catch((caught: unknown) => caught)
  assert.ok(error instanceof LostReadingError, String(error))
  assert.ok(error.attempts >= 2, `${error.attempts} attempts`)
  assert.ok(performance.now() - started < 600, 'within its budget, give or take a send')
})

// W-5: every page call carries the command's own budget; the world's set-up and global object, which calls share, are
// waited on no longer than each call's budget, and the whole reading of a document sits under one deadline.
test("a call waits for the world's set-up and global object no longer than its own budget, and the whole reading of a document no longer than the look's", { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t, scriptedBuild(t, { timeoutMs: 5000 }))
  userWorld(bridge, 'page-8', 4)
  let started = performance.now()
  const installing = await bridge.session.send('Page.createIsolatedWorld', { frameId: 'frame-1' }, { timeoutMs: 100 }).catch((caught: unknown) => caught)
  assert.ok(installing instanceof CdpTimeoutError, String(installing))
  assert.ok(performance.now() - started < 1000, `the set-up waited ${Math.round(performance.now() - started)} ms`)
  build.reply(await next(build, 'Runtime.evaluate'), { result: { type: 'boolean', value: true } })
  const { executionContextId } = await worldOf(bridge)
  started = performance.now()
  const calling = await bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId, returnByValue: true }, { timeoutMs: 100 }).catch((caught: unknown) => caught)
  assert.ok(calling instanceof CdpTimeoutError, String(calling))
  assert.ok(performance.now() - started < 1000, `the global object waited ${Math.round(performance.now() - started)} ms`)

  const { build: slow, bridge: slowBridge } = bridgeOn(t, scriptedBuild(t, { timeoutMs: 5000 }))
  serveWorlds(slow)
  userWorld(slowBridge, 'page-8', 4)
  const slowWorld = await worldOf(slowBridge)
  const all = Array.from({ length: 250 }, (_, index) => 100 + index)
  slow.serve((command) => {
    if (command.method !== 'DOM.getAccessibilityPropertiesForNode') return undefined
    setTimeout(() => slow.reply(command, { properties: { exists: true, role: 'button', label: 'Late' } }), 120)
    return undefined
  })
  serveReading(slow, { all, properties: 'answered elsewhere' })
  started = performance.now()
  const reading = await lookFor(slowBridge, slowWorld.executionContextId, 'button', 'g1', 250).catch((caught: unknown) => caught)
  assert.ok(reading instanceof CdpTimeoutError, `three batches of 120 ms each do not fit a 250 ms look: ${String(reading)}`)
  assert.ok(performance.now() - started < 450, `the reading took ${Math.round(performance.now() - started)} ms`)
})

test('input goes to the page proxy, text to the page target, and a command with no WebKit counterpart is refused by name', { timeout: 10_000 }, async (t) => {
  const { build, bridge } = bridgeOn(t)
  const moved = bridge.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5.5, y: 6.5 })
  const move = await build.nextCommand()
  assert.deepEqual([move.method, move.pageProxyId, move.targetId, move.params], ['Input.dispatchMouseEvent', '7', undefined, { type: 'move', x: 5, y: 6, button: 'none', buttons: 0, modifiers: 0 }])
  build.reply(move, {})
  await moved
  const refused = await bridge.session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [] }).catch((caught: unknown) => caught)
  assert.ok(refused instanceof CdpProtocolError)
  assert.equal(refused.protocolMessage, "Input.dispatchTouchEvent has no WebKit counterpart in Retest's WebKit driver")
})

test('a wrapper a swapped-out target refused, for a call into its world, is answered as a context the call never reached', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t, { answerWrappers: false })
  const { bridge } = bridgeOn(t, build)
  build.serve((command) => {
    if (command.method !== 'Runtime.evaluate') return undefined
    build.reply(command, String(command.params['expression']).includes('retestRelay') ? { result: { type: 'boolean', value: true } } : { result: { type: 'object', objectId: 'global-4' } })
    return undefined
  })
  userWorld(bridge, 'page-8', 4)
  const { executionContextId } = await worldOf(bridge)
  const answer = bridge.session.send('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId })
  build.refuseWrapper(await next(build, 'Runtime.callFunctionOn'), 'Missing target for given targetId')
  assert.ok(neverRan(await answer.catch((caught: unknown) => caught)))
})

async function worldOf(bridge: WebKitTargetSession): Promise<{ executionContextId: number }> {
  const answer = await bridge.session.send('Page.createIsolatedWorld', { frameId: 'frame-1', worldName: 'retest' })
  if (typeof answer !== 'object' || answer === null || !('executionContextId' in answer) || typeof answer.executionContextId !== 'number') throw new Error('no world')
  return { executionContextId: answer.executionContextId }
}
