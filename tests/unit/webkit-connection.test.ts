import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { CdpAbortedError, CdpClosedError, CdpDisconnectedError, CdpInvalidResponseError, CdpPendingLimitError, CdpProtocolError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { parseWebKitMessage, targetScope } from '../../src/browser/webkit/connection.ts'
import { scriptedBuild } from './webkit-scripted-inspector.ts'

test('reads a WebKit error, whose data is a list where CDP sends a string, and keeps the pageProxyId', { timeout: 10_000 }, () => {
  const text = '{"error":{"code":-32601,"message":"\'Bogus\' domain was not found","data":[{"code":-32601,"message":"\'Bogus\' domain was not found"}]},"id":3,"pageProxyId":"7"}'
  assert.deepEqual(parseWebKitMessage(text), { kind: 'error', id: 3, error: { code: -32601, message: "'Bogus' domain was not found" }, pageProxyId: '7' })
  assert.deepEqual(parseWebKitMessage('{"method":"Target.targetCreated","params":{},"pageProxyId":"7"}'), { kind: 'event', method: 'Target.targetCreated', params: {}, pageProxyId: '7' })
  assert.deepEqual(parseWebKitMessage('{"id":1,"result":{},"error":{}}'), { kind: 'malformed', problem: 'the response has both a result and an error', id: 1 })
  assert.deepEqual(parseWebKitMessage('{"method":"x","pageProxyId":7}'), { kind: 'malformed', problem: 'the message has a pageProxyId that is not a non-empty string', id: undefined })
})

test('a command reaches the browser, a page proxy, or a page target wrapped in its page proxy, each with an id from one counter', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const browser = build.connection.send('Playwright.enable')
  const proxy = build.connection.sendToPageProxy('7', 'Input.dispatchMouseEvent', { type: 'move', x: 1, y: 2 })
  const target = build.connection.sendToTarget('7', 'page-8', 'Runtime.evaluate', { expression: '1' })
  const [first, second, third] = [await build.nextCommand(), await build.nextCommand(), await build.nextCommand()]
  assert.deepEqual([first.method, first.pageProxyId, first.targetId], ['Playwright.enable', undefined, undefined])
  assert.deepEqual([second.method, second.pageProxyId, second.targetId, second.params], ['Input.dispatchMouseEvent', '7', undefined, { type: 'move', x: 1, y: 2 }])
  assert.deepEqual([third.method, third.pageProxyId, third.targetId], ['Runtime.evaluate', '7', 'page-8'])
  // The wrapped command and its wrapper take ids of their own, after the commands before them.
  assert.deepEqual([first.id, second.id, third.id, third.wrapperId], [1, 2, 3, 4])
  build.reply(first, {})
  build.reply(second, {})
  build.reply(third, { result: { type: 'number', value: 1 } })
  assert.deepEqual(await Promise.all([browser, proxy, target]), [{}, {}, { result: { type: 'number', value: 1 } }])
})

test('an error the build returns is a protocol error that names the command and where it went', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const sent = build.connection.sendToTarget('7', 'page-8', 'Runtime.callFunctionOn', {})
  build.fail(await build.nextCommand(), 'Missing injected script for given objectId')
  const error = await sent.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpProtocolError)
  assert.equal(error.protocolMessage, 'Missing injected script for given objectId')
  assert.equal(error.sessionId, targetScope('7', 'page-8'))
  assert.equal(error.data, undefined)
})

test('a wrapper the page proxy refuses never reached its target, so the command fails as one that was not sent', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t, { answerWrappers: false })
  const sent = build.connection.sendToTarget('7', 'page-9', 'Page.insertText', { text: 'secret value' })
  build.refuseWrapper(await build.nextCommand(), 'Missing target for given targetId')
  const error = await sent.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpClosedError)
  assert.equal(error.reason, "the page's target page-9 is gone: Missing target for given targetId")
})

test('a command with no answer times out, saying it was written; one aborted after it was written says so too', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const timed = build.connection.send('Playwright.navigate', {}, { timeoutMs: 30 })
  await build.nextCommand()
  const timeout = await timed.catch((caught: unknown) => caught)
  assert.ok(timeout instanceof CdpTimeoutError)
  assert.equal(timeout.written, true)
  const controller = new AbortController()
  const aborted = build.connection.sendToPageProxy('7', 'Input.dispatchKeyEvent', {}, { signal: controller.signal })
  await build.nextCommand()
  controller.abort()
  const error = await aborted.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpAbortedError)
  assert.equal(error.written, true)
})

test('a command aborted before it is sent is never written, and its wrapper goes with it', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const controller = new AbortController()
  controller.abort()
  const refused = await build.connection.sendToTarget('7', 'page-8', 'Page.insertText', { text: 'x' }, { signal: controller.signal }).catch((caught: unknown) => caught)
  assert.ok(refused instanceof CdpAbortedError)
  assert.equal(refused.written, false)
  build.connection.send('Playwright.enable').catch(() => undefined)
  assert.equal((await build.nextCommand()).method, 'Playwright.enable', 'the aborted command never reached the build')
})

test('the end of the connection fails every waiting command, saying whether each was written, and refuses later ones unsent', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const waiting = build.connection.sendToTarget('7', 'page-8', 'Runtime.awaitPromise', {})
  await build.nextCommand()
  const heard: string[] = []
  build.connection.onDisconnect((reason) => heard.push(reason))
  build.exit()
  const error = await waiting.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpDisconnectedError)
  assert.equal(error.written, true)
  assert.deepEqual(heard, ['the browser closed the pipe'])
  const later = await build.connection.send('Playwright.close').catch((caught: unknown) => caught)
  assert.ok(later instanceof CdpClosedError)
  const late: string[] = []
  build.connection.onDisconnect((reason) => late.push(reason))
  await nextTurn()
  assert.deepEqual(late, ['the browser closed the pipe'], 'a listener that arrives after the end hears it once')
})

test('no more commands go than the pending limit allows, a target command counting with its wrapper', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t, { maxPending: 2 })
  const first = build.connection.send('Playwright.enable')
  const refused = await build.connection.sendToTarget('7', 'page-8', 'Runtime.evaluate', {}).catch((caught: unknown) => caught)
  assert.ok(refused instanceof CdpPendingLimitError)
  build.reply(await build.nextCommand(), {})
  await first
})

test('events reach the browser, the page proxy or the target listeners, a target event unwrapped with its target', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const browserEvents: unknown[] = []
  const proxyEvents: unknown[] = []
  const targetEvents: unknown[] = []
  build.connection.onBrowserEvent('Playwright.pageProxyCreated', (params) => browserEvents.push(params))
  build.connection.onPageProxyEvent('7', (event) => proxyEvents.push(event))
  build.connection.onTargetEvent('7', (event) => targetEvents.push(event))
  build.event('Playwright.pageProxyCreated', { pageProxyId: '7', browserContextId: 'c1' })
  build.proxyEvent('7', 'Target.targetCreated', { targetInfo: { targetId: 'page-8', type: 'page' } })
  build.targetEvent('7', 'page-8', 'Page.frameNavigated', { frame: { id: 'f' } })
  build.proxyEvent('8', 'Target.targetCreated', {})
  await nextTurn()
  assert.deepEqual(browserEvents, [{ pageProxyId: '7', browserContextId: 'c1' }])
  assert.deepEqual(proxyEvents, [{ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'page-8', type: 'page' } } }])
  assert.deepEqual(targetEvents, [{ pageProxyId: '7', targetId: 'page-8', method: 'Page.frameNavigated', params: { frame: { id: 'f' } } }])
})

test('an answer that cannot be read fails its command, and an answer nothing waits for is a diagnostic that never quotes the page', { timeout: 10_000 }, async (t) => {
  const build = scriptedBuild(t)
  const sent = build.connection.sendToTarget('7', 'page-8', 'Runtime.evaluate', {})
  const command = await build.nextCommand()
  build.proxyEvent('7', 'Target.dispatchMessageFromTarget', { targetId: 'page-8', message: `{"id":${command.id},"result":{},"error":{}}` })
  const error = await sent.catch((caught: unknown) => caught)
  assert.ok(error instanceof CdpInvalidResponseError)
  build.reply(command, { secret: 'page text' })
  await nextTurn()
  await nextTurn()
  assert.ok(build.diagnostics.some((problem) => problem.includes(`answered command ${command.id}`)))
  assert.ok(build.diagnostics.every((problem) => !problem.includes('page text')))
})
