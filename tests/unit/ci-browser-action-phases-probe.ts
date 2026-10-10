import type { BrowserCommand, DispatchedCommand, InputDispatch } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { CdpSession } from '../../src/browser/cdp/session.ts'
import { CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import { FirefoxPage } from '../../src/browser/firefox/page.ts'
import { prepareFunction } from '../../src/browser/page-scripts.ts'
import { WebKitConnection } from '../../src/browser/webkit/connection.ts'
import { WebKitPage } from '../../src/browser/webkit/page.ts'
import { parse, s } from '../../src/protocol/schema.ts'

const mode = process.argv[2]
const configuredPath = process.env['RETEST_CI_BROWSER_ACTION_PHASE_LOG']
assert.ok(configuredPath !== undefined)
const path = configuredPath
const privateValue = 'CI_PRIVATE_ACTION_VALUE'
const privateLocator = 'CI_PRIVATE_LOCATOR_VALUE'
const privateSource = 'function CI_PRIVATE_FUNCTION_SOURCE() {}'
const command: BrowserCommand = { kind: 'select', locator: { by: 'testId', value: privateLocator }, choices: [{ label: privateValue }] }
const signal = new AbortController().signal
const commandToken = 921
const options = { timeoutMs: 1500, signal }
const bidiOptions = { ...options, keepErrorMessage: true }
const params = { functionDeclaration: prepareFunction, arguments: [{ value: privateValue }], objectGroup: privateValue }
const unrecognizedParams = { functionDeclaration: privateSource, arguments: [{ value: privateValue }] }
let sendPromise: Promise<unknown> = Promise.resolve({ value: privateValue, message: privateValue })
let dispatchPromise: Promise<DispatchedCommand> = Promise.resolve({ result: { ok: true, kind: 'select', changed: true }, input: 'sent' })
let insideDispatch = (): void => {}
const firefoxCalls: Parameters<FirefoxPage['dispatch']>[] = []
const webkitCalls: Parameters<WebKitPage['dispatch']>[] = []
const sharedCalls: Parameters<CdpSession['send']>[] = []
const bidiCalls: Parameters<BidiClient['send']>[] = []
const browserCalls: Parameters<WebKitConnection['send']>[] = []
const proxyCalls: Parameters<WebKitConnection['sendToPageProxy']>[] = []
const targetCalls: Parameters<WebKitConnection['sendToTarget']>[] = []

FirefoxPage.prototype.dispatch = function (this: FirefoxPage, ...args: Parameters<FirefoxPage['dispatch']>): Promise<DispatchedCommand> {
  assert.equal(this, FirefoxPage.prototype)
  firefoxCalls.push(args)
  insideDispatch()
  return dispatchPromise
}
WebKitPage.prototype.dispatch = function (this: WebKitPage, ...args: Parameters<WebKitPage['dispatch']>): Promise<DispatchedCommand> {
  assert.equal(this, WebKitPage.prototype)
  webkitCalls.push(args)
  insideDispatch()
  return dispatchPromise
}
CdpSession.prototype.send = function (this: CdpSession, ...args: Parameters<CdpSession['send']>): Promise<unknown> {
  assert.equal(this, CdpSession.prototype)
  sharedCalls.push(args)
  return sendPromise
}
BidiClient.prototype.send = function (this: BidiClient, ...args: Parameters<BidiClient['send']>): Promise<unknown> {
  assert.equal(this, BidiClient.prototype)
  bidiCalls.push(args)
  return sendPromise
}
WebKitConnection.prototype.send = function (this: WebKitConnection, ...args: Parameters<WebKitConnection['send']>): Promise<unknown> {
  assert.equal(this, WebKitConnection.prototype)
  browserCalls.push(args)
  return sendPromise
}
WebKitConnection.prototype.sendToPageProxy = function (this: WebKitConnection, ...args: Parameters<WebKitConnection['sendToPageProxy']>): Promise<unknown> {
  assert.equal(this, WebKitConnection.prototype)
  proxyCalls.push(args)
  return sendPromise
}
WebKitConnection.prototype.sendToTarget = function (this: WebKitConnection, ...args: Parameters<WebKitConnection['sendToTarget']>): Promise<unknown> {
  assert.equal(this, WebKitConnection.prototype)
  targetCalls.push(args)
  return sendPromise
}

// Only preload activation is simulated. These controls never construct or launch a browser on either host.
const platform = Object.getOwnPropertyDescriptor(process, 'platform')
assert.ok(platform !== undefined)
Object.defineProperty(process, 'platform', { value: 'darwin' })
try {
  await import('../../scripts/ci/browser-action-phases.ts')
} finally {
  Object.defineProperty(process, 'platform', platform)
}

const eventSchema = s.object({
  call: s.number({ integer: true, min: 1 }),
  layer: s.enum(['shared', 'bidi', 'webkit.browser', 'webkit.proxy', 'webkit.target']),
  method: s.enum([
    'Page.createIsolatedWorld', 'Runtime.callFunctionOn', 'Runtime.evaluate', 'DOM.resolveNode',
    'DOM.getDocument', 'Accessibility.queryAXTree', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent',
    'Input.dispatchWheelEvent', 'Input.insertText', 'Page.insertText', 'Page.createUserWorld',
    'script.callFunction', 'script.getRealms', 'browsingContext.locateNodes', 'browsingContext.activate',
    'input.performActions', 'input.releaseActions',
  ]),
  phase: s.optional(s.enum(['prepare', 'guard.arm', 'guard.verdict', 'guard.registration', 'guard.disarm', 'guard.set_off', 'selection', 'selection.plan', 'checked', 'observe', 'page_facts'])),
  event: s.enum(['started', 'settled', 'rejected']),
  elapsedMs: s.number({ min: 0 }), remainingMs: s.number({ min: 0 }),
  callBudgetMs: s.optional(s.number({ min: 0 })),
  errorClass: s.optional(s.enum(['timeout', 'aborted', 'blocked', 'closed', 'disconnected', 'protocol', 'invalid_response', 'pending_limit', 'other'])),
})
const recordSchema = s.object({
  version: s.literal(1), hostPid: s.number({ integer: true, min: 1 }),
  engine: s.enum(['firefox', 'webkit']),
  kind: s.enum(['click', 'tap', 'hover', 'fill', 'press', 'select', 'check', 'uncheck', 'scroll']),
  timeoutMs: s.number({ min: 0 }), elapsedMs: s.number({ min: 0 }), remainingMs: s.number({ min: 0 }),
  errorClass: s.literal('timeout'), input: s.optional(s.enum(['not_sent', 'sent', 'unknown'])),
  omitted: s.number({ integer: true, min: 0 }), events: s.array(eventSchema),
})

function sameArguments(actual: readonly unknown[] | undefined, expected: readonly unknown[]): void {
  assert.ok(actual !== undefined)
  assert.equal(actual.length, expected.length)
  expected.forEach((value, index) => assert.equal(actual[index], value, `argument ${index} keeps its identity`))
}

function exerciseSends(): void {
  assert.equal(CdpSession.prototype.send('Runtime.callFunctionOn', params, options), sendPromise)
  assert.equal(BidiClient.prototype.send('script.callFunction', params, bidiOptions), sendPromise)
  assert.equal(WebKitConnection.prototype.send('Runtime.evaluate', params, options), sendPromise)
  assert.equal(WebKitConnection.prototype.sendToPageProxy(privateValue, 'Input.dispatchWheelEvent', params, options), sendPromise)
  assert.equal(WebKitConnection.prototype.sendToTarget(privateValue, privateValue, 'Runtime.callFunctionOn', params, options), sendPromise)
  sameArguments(sharedCalls.at(-1), ['Runtime.callFunctionOn', params, options])
  sameArguments(bidiCalls.at(-1), ['script.callFunction', params, bidiOptions])
  sameArguments(browserCalls.at(-1), ['Runtime.evaluate', params, options])
  sameArguments(proxyCalls.at(-1), [privateValue, 'Input.dispatchWheelEvent', params, options])
  sameArguments(targetCalls.at(-1), [privateValue, privateValue, 'Runtime.callFunctionOn', params, options])
}

function reply(input: InputDispatch): DispatchedCommand {
  return { result: { ok: false, failure: { class: 'timeout', message: privateValue } }, input }
}

async function dispatch(engine: 'firefox' | 'webkit', answer: DispatchedCommand): Promise<void> {
  dispatchPromise = Promise.resolve(answer)
  const promise = engine === 'firefox'
    ? FirefoxPage.prototype.dispatch(command, 1500, signal, commandToken)
    : WebKitPage.prototype.dispatch(command, 1500, signal, commandToken)
  assert.equal(promise, dispatchPromise, 'dispatch returns the original promise')
  sameArguments(engine === 'firefox' ? firefoxCalls.at(-1) : webkitCalls.at(-1), [command, 1500, signal, commandToken])
  assert.equal(await promise, answer, 'the original result keeps its identity')
}

function onlyKeys(value: unknown, allowed: readonly string[]): void {
  assert.ok(isRecord(value))
  for (const key of Object.keys(value)) assert.ok(allowed.includes(key), `unexpected diagnostic field ${key}`)
}

function records() {
  const text = readFileSync(path, 'utf8')
  for (const value of [privateValue, privateLocator, privateSource, prepareFunction]) assert.ok(!text.includes(value), 'private payloads and function source are absent')
  const prefix = '# retest.browser.action.timeout '
  return text.trimEnd().split('\n').map((line) => {
    assert.ok(line.startsWith(prefix))
    const raw: unknown = JSON.parse(line.slice(prefix.length))
    onlyKeys(raw, ['version', 'hostPid', 'engine', 'kind', 'timeoutMs', 'elapsedMs', 'remainingMs', 'errorClass', 'input', 'omitted', 'events'])
    assert.ok(isRecord(raw) && Array.isArray(raw['events']))
    for (const event of raw['events']) onlyKeys(event, ['call', 'layer', 'method', 'phase', 'event', 'elapsedMs', 'remainingMs', 'callBudgetMs', 'errorClass'])
    const parsed = parse(recordSchema, raw)
    assert.ok(parsed.ok, 'the record has only allowlisted metadata values')
    return parsed.value
  })
}

switch (mode) {
  case 'identity': {
    insideDispatch = exerciseSends
    for (const engine of ['firefox', 'webkit'] as const) await dispatch(engine, reply('not_sent'))
    const saved = records()
    assert.equal(saved.length, 2)
    for (const record of saved) {
      assert.equal(record.kind, 'select')
      assert.equal(record.events.length, 10)
      assert.equal(record.events.filter((event) => event.phase === 'prepare').length, 2)
      assert.equal(record.input, 'not_sent')
    }
    break
  }
  case 'quiet': {
    insideDispatch = exerciseSends
    await dispatch('firefox', { result: { ok: true, kind: 'select', changed: true }, input: 'sent' })
    await dispatch('webkit', { result: { ok: false, failure: { class: 'unsupported', message: privateValue } }, input: 'not_sent' })
    const error = new Error(privateValue)
    dispatchPromise = Promise.reject(error)
    const promise = FirefoxPage.prototype.dispatch(command, 1500, signal, commandToken)
    assert.equal(promise, dispatchPromise)
    await assert.rejects(promise, (received: unknown) => { assert.equal(received, error); return true })
    sendPromise = Promise.reject(new CdpTimeoutError({ method: privateValue, sessionId: privateValue }, { timeoutMs: 1500, written: true }))
    insideDispatch = () => {
      const failed = CdpSession.prototype.send('Runtime.callFunctionOn', params, options)
      assert.equal(failed, sendPromise)
      void failed.catch(() => {})
    }
    await dispatch('webkit', { result: { ok: true, kind: 'select', changed: true }, input: 'sent' })
    assert.equal(existsSync(path), false, 'pass, refusal, non-timeout rejection and a recovered helper timeout write no log')
    break
  }
  case 'timeout': {
    insideDispatch = () => {
      exerciseSends()
      assert.equal(CdpSession.prototype.send('Runtime.callFunctionOn', unrecognizedParams, options), sendPromise)
      assert.equal(CdpSession.prototype.send(privateValue, params, options), sendPromise)
    }
    for (const engine of ['firefox', 'webkit'] as const) {
      for (const input of ['not_sent', 'sent', 'unknown'] as const) await dispatch(engine, reply(input))
    }
    const error = new CdpTimeoutError({ method: privateValue, sessionId: privateValue }, { timeoutMs: 1500, written: true })
    dispatchPromise = Promise.reject(error)
    const promise = WebKitPage.prototype.dispatch(command, 1500, signal, commandToken)
    assert.equal(promise, dispatchPromise)
    await assert.rejects(promise, (received: unknown) => { assert.equal(received, error); return true })
    const saved = records()
    assert.deepEqual(saved.map((record) => [record.engine, record.input]), [
      ['firefox', 'not_sent'], ['firefox', 'sent'], ['firefox', 'unknown'],
      ['webkit', 'not_sent'], ['webkit', 'sent'], ['webkit', 'unknown'], ['webkit', undefined],
    ])
    for (const record of saved) {
      assert.equal(record.events.length, 12, 'an unrecognized method is never retained')
      assert.equal(record.events.filter((event) => event.phase === 'prepare').length, 2)
      assert.equal(record.events.filter((event) => event.method === 'Runtime.callFunctionOn' && event.layer === 'shared' && event.phase === undefined).length, 2)
    }
    break
  }
  case 'ring': {
    insideDispatch = () => {
      for (let index = 0; index < 100; index += 1) assert.equal(CdpSession.prototype.send('Runtime.callFunctionOn', params, options), sendPromise)
    }
    await dispatch('firefox', reply('unknown'))
    const saved = records()
    assert.equal(saved.length, 1)
    const record = saved[0]
    assert.ok(record !== undefined)
    assert.equal(record.events.length, 128)
    assert.equal(record.omitted, 72)
    assert.equal(record.events.at(-1)?.call, 100)
    assert.equal(record.events.at(-1)?.event, 'settled')
    break
  }
  case 'write-failure': {
    insideDispatch = exerciseSends
    await dispatch('firefox', reply('sent'))
    const error = new CdpTimeoutError({ method: privateValue, sessionId: privateValue }, { timeoutMs: 1500, written: true })
    dispatchPromise = Promise.reject(error)
    const promise = WebKitPage.prototype.dispatch(command, 1500, signal, commandToken)
    assert.equal(promise, dispatchPromise)
    await assert.rejects(promise, (received: unknown) => { assert.equal(received, error); return true })
    break
  }
  default: assert.fail('unknown action observer control')
}
