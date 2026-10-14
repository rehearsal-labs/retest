import type { ReadyReadiness } from '../../src/browser/element-queries.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { PageFrames } from '../../src/browser/frames.ts'
import { IsolatedWorld, isGoneContext } from '../../src/browser/isolated-world.ts'
import { disarmFunction, frameElementFunction, frameShownFunction, placeFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { s } from '../../src/protocol/schema.ts'
import { scriptedSession } from './browser-fixtures.ts'

// A page whose main frame, MAIN, holds a frame of its own process, CHILD, both reached through the page's session:
// Retest's world is context 1 in the page's document and context 2 in the frame's. The page answers a place with
// `place`.

const button: LocatorRecipe = { by: 'testId', value: 'save', frame: [{ by: 'css', selector: 'iframe' }] }
const ready: ReadyReadiness = { status: 'ready', point: { x: 10, y: 10 }, token: 5, via: null, scale: 1, page: { href: 'http://app.test/order', title: 'Order' }, plan: null }

function field(params: unknown, name: string): unknown {
  return typeof params === 'object' && params !== null && name in params ? Reflect.get(params, name) : undefined
}

function framedPage(place: () => Promise<unknown>) {
  const scripted = scriptedSession(async (method, params) => {
    if (method === 'Target.setAutoAttach' || method === 'Runtime.releaseObjectGroup') return {}
    if (method === 'Page.createIsolatedWorld') return { executionContextId: field(params, 'frameId') === 'MAIN' ? 1 : 2 }
    if (method === 'DOM.describeNode') return { node: { frameId: 'CHILD' } }
    const call = field(params, 'functionDeclaration')
    if (call === frameElementFunction) return { result: { type: 'object', objectId: 'frame-element' } }
    if (call === frameShownFunction) return { result: { value: true } }
    if (call === placeFunction) return place()
    return { result: { value: true } }
  })
  const transport = { listen: () => undefined, send: () => ({ written: true, withdraw: () => {} }), close: () => undefined }
  const connection = new CdpConnection(transport, { timeoutMs: 5000, onDiagnostic: () => undefined })
  const world = new IsolatedWorld(scripted.session, () => 'MAIN')
  const frames = new PageFrames({ connection, session: scripted.session, world, mainFrameId: () => 'MAIN', onChange: () => {}, follow: async () => {} })
  return { ...scripted, frames }
}

test('a place that stops, as when its time runs out, ends the guard the look armed in the frame', async () => {
  const { frames, sent } = framedPage(() => new Promise(() => {}))
  const world = frames.world(button)
  const looked = await world.enter('function look() { return true }', [], s.boolean(), new Deadline(1000))
  await assert.rejects(world.place({ value: ready, context: looked.context }, 'click', new Deadline(50)), CdpTimeoutError)
  const disarms = sent.filter(({ params }) => field(params, 'functionDeclaration') === disarmFunction)
  assert.deepEqual(
    disarms.map(({ params }) => [field(params, 'executionContextId'), field(params, 'arguments')]),
    [[2, [{ value: 5 }]]],
  )
})

test('a frame the page draws is placed through each document around it, and the guard armed there travels with the look', async () => {
  const { frames } = framedPage(async () => ({ result: { value: { status: 'placed', point: { x: 110, y: 60 }, scale: 0.5, token: 9 } } }))
  const world = frames.world(button)
  const looked = await world.enter('function look() { return true }', [], s.boolean(), new Deadline(1000))
  const placed = await world.place({ value: ready, context: looked.context }, 'click', new Deadline(1000))
  assert.deepEqual(placed.value, { ...ready, point: { x: 110, y: 60 }, scale: 0.5 }, "the page's point, at the page's scale")
  assert.equal(placed.around?.length, 1)
  assert.equal(placed.around?.[0]?.token, 9)
  assert.notEqual(placed.around?.[0]?.context, looked.context, "the page's document, not the frame's")
})

test('a document whose context went is forgotten, and a number is never given to another document', async () => {
  const { frames, emit } = framedPage(() => new Promise(() => {}))
  const world = frames.world(button)
  const first = await world.enter('function look() { return true }', [], s.boolean(), new Deadline(1000))
  emit('Runtime.executionContextDestroyed', { executionContextId: 2 })
  await assert.rejects(frames.callIn(first.context, 'function look() { return true }', [], s.boolean(), new Deadline(1000)), (error) => isGoneContext(error))
  const second = await world.enter('function look() { return true }', [], s.boolean(), new Deadline(1000))
  assert.notEqual(second.context, first.context)
  emit('Runtime.executionContextsCleared', {})
  await assert.rejects(frames.callIn(second.context, 'function look() { return true }', [], s.boolean(), new Deadline(1000)), (error) => isGoneContext(error))
})

test('a frame on the path that opens another document holds the action until that document commits or the frame stops loading', async () => {
  const { frames, emit } = framedPage(() => new Promise(() => {}))
  const world = frames.world(button)
  await world.enter('function look() { return true }', [], s.boolean(), new Deadline(1000))
  assert.equal(world.pendingNavigation(), undefined)
  emit('Page.frameStartedNavigating', { frameId: 'CHILD', url: 'http://app.test/order#total', loaderId: 'L1', navigationType: 'sameDocument' })
  emit('Page.frameStartedNavigating', { frameId: 'MAIN', url: 'http://app.test/next', loaderId: 'L2', navigationType: 'differentDocument' })
  assert.equal(world.pendingNavigation(), undefined, "a move within the document, and the page's own navigation, which the page holds")
  emit('Page.frameStartedNavigating', { frameId: 'CHILD', url: 'http://app.test/step?n=2', loaderId: 'L3', navigationType: 'differentDocument' })
  assert.deepEqual(world.pendingNavigation(), { url: 'http://app.test/step?n=2' })
  emit('Page.frameNavigated', { frame: { id: 'CHILD', url: 'http://app.test/step?n=2', loaderId: 'L3' } })
  assert.equal(world.pendingNavigation(), undefined)
  emit('Page.frameStartedNavigating', { frameId: 'CHILD', url: 'http://app.test/report.pdf', loaderId: 'L4', navigationType: 'differentDocument' })
  emit('Page.frameStoppedLoading', { frameId: 'CHILD' })
  assert.equal(world.pendingNavigation(), undefined, 'a navigation the browser gave up, as for a download')
})
