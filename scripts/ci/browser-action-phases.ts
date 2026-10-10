import type { BrowserCommand, DispatchedCommand, InputDispatch } from '../../src/browser/contract.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  CdpAbortedError, CdpBlockedError, CdpClosedError, CdpDisconnectedError, CdpInvalidResponseError,
  CdpPendingLimitError, CdpProtocolError, CdpTimeoutError,
} from '../../src/browser/cdp/errors.ts'
import { CdpSession } from '../../src/browser/cdp/session.ts'
import { BidiClient } from '../../src/browser/firefox/bidi-client.ts'
import {
  BidiAbortedError, BidiClosedError, BidiDisconnectedError, BidiInvalidResponseError,
  BidiPendingLimitError, BidiProtocolError, BidiTimeoutError,
} from '../../src/browser/firefox/bidi-errors.ts'
import { FirefoxPage } from '../../src/browser/firefox/page.ts'
import {
  armDocumentFunction, checkedFunction, disarmFunction, observeFunction, pageFactsFunction,
  prepareFunction, registrationFunction, selectionFunction, setOffFunction, verdictFunction,
} from '../../src/browser/page-scripts.ts'
import { WebKitConnection } from '../../src/browser/webkit/connection.ts'
import { WebKitPage } from '../../src/browser/webkit/page.ts'
import { listPlanFunction } from '../../src/browser/webkit/select.ts'

type Engine = 'firefox' | 'webkit'
type ActionKind = 'click' | 'tap' | 'hover' | 'fill' | 'press' | 'select' | 'check' | 'uncheck' | 'scroll'
type Layer = 'shared' | 'bidi' | 'webkit.browser' | 'webkit.proxy' | 'webkit.target'
type Phase = 'prepare' | 'guard.arm' | 'guard.verdict' | 'guard.registration' | 'guard.disarm' | 'guard.set_off' | 'selection' | 'selection.plan' | 'checked' | 'observe' | 'page_facts'
type ErrorClass = 'timeout' | 'aborted' | 'blocked' | 'closed' | 'disconnected' | 'protocol' | 'invalid_response' | 'pending_limit' | 'other'

const methods = [
  'Page.createIsolatedWorld', 'Runtime.callFunctionOn', 'Runtime.evaluate', 'DOM.resolveNode',
  'DOM.getDocument', 'Accessibility.queryAXTree', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent',
  'Input.dispatchWheelEvent', 'Input.insertText', 'Page.insertText', 'Page.createUserWorld',
  'script.callFunction', 'script.getRealms', 'browsingContext.locateNodes', 'browsingContext.activate',
  'input.performActions', 'input.releaseActions',
] as const
type Method = (typeof methods)[number]

type TraceEvent = {
  call: number
  layer: Layer
  method: Method
  phase: Phase | undefined
  event: 'started' | 'settled' | 'rejected'
  elapsedMs: number
  remainingMs: number
  callBudgetMs: number | undefined
  errorClass: ErrorClass | undefined
}
type Action = {
  engine: Engine
  kind: ActionKind
  startedAt: number
  timeoutMs: number
  events: TraceEvent[]
  nextCall: number
  omitted: number
  settled: boolean
}

const phases = new Map<string, Phase>([
  [prepareFunction, 'prepare'], [armDocumentFunction, 'guard.arm'], [verdictFunction, 'guard.verdict'],
  [registrationFunction, 'guard.registration'], [disarmFunction, 'guard.disarm'], [setOffFunction, 'guard.set_off'],
  [selectionFunction, 'selection'], [listPlanFunction, 'selection.plan'], [checkedFunction, 'checked'],
  [observeFunction, 'observe'], [pageFactsFunction, 'page_facts'],
])
const actions = new AsyncLocalStorage<Action>()
const eventLimit = 128
const logPath = process.env['RETEST_CI_BROWSER_ACTION_PHASE_LOG']
// CI prints this separate log after integration. The CLI's stdout and stderr remain test inputs.
if (process.platform === 'darwin' && logPath !== undefined && isAbsolute(logPath)) observeActions(logPath)

function observeActions(path: string): void {
  const firefoxDispatch = FirefoxPage.prototype.dispatch
  FirefoxPage.prototype.dispatch = function (this: FirefoxPage, ...args: Parameters<FirefoxPage['dispatch']>): Promise<DispatchedCommand> {
    return observeAction('firefox', args[0].kind, args[1], () => firefoxDispatch.apply(this, args), path)
  }
  const webkitDispatch = WebKitPage.prototype.dispatch
  WebKitPage.prototype.dispatch = function (this: WebKitPage, ...args: Parameters<WebKitPage['dispatch']>): Promise<DispatchedCommand> {
    return observeAction('webkit', args[0].kind, args[1], () => webkitDispatch.apply(this, args), path)
  }
  const sharedSend = CdpSession.prototype.send
  CdpSession.prototype.send = function (this: CdpSession, ...args: Parameters<CdpSession['send']>): Promise<unknown> {
    return observeCall('shared', args[0], args[1], args[2]?.timeoutMs, () => sharedSend.apply(this, args))
  }
  const bidiSend = BidiClient.prototype.send
  BidiClient.prototype.send = function (this: BidiClient, ...args: Parameters<BidiClient['send']>): Promise<unknown> {
    return observeCall('bidi', args[0], undefined, args[2]?.timeoutMs, () => bidiSend.apply(this, args))
  }
  const browserSend = WebKitConnection.prototype.send
  WebKitConnection.prototype.send = function (this: WebKitConnection, ...args: Parameters<WebKitConnection['send']>): Promise<unknown> {
    return observeCall('webkit.browser', args[0], undefined, args[2]?.timeoutMs, () => browserSend.apply(this, args))
  }
  // Proxy input and target helpers bypass the connection's browser-level send.
  const proxySend = WebKitConnection.prototype.sendToPageProxy
  WebKitConnection.prototype.sendToPageProxy = function (this: WebKitConnection, ...args: Parameters<WebKitConnection['sendToPageProxy']>): Promise<unknown> {
    return observeCall('webkit.proxy', args[1], undefined, args[3]?.timeoutMs, () => proxySend.apply(this, args))
  }
  const targetSend = WebKitConnection.prototype.sendToTarget
  WebKitConnection.prototype.sendToTarget = function (this: WebKitConnection, ...args: Parameters<WebKitConnection['sendToTarget']>): Promise<unknown> {
    return observeCall('webkit.target', args[2], undefined, args[4]?.timeoutMs, () => targetSend.apply(this, args))
  }
}

function observeAction(engine: Engine, kind: BrowserCommand['kind'], timeoutMs: number, send: () => Promise<DispatchedCommand>, path: string): Promise<DispatchedCommand> {
  const actionKind = knownAction(kind)
  if (actionKind === undefined) return send()
  const action: Action = { engine, kind: actionKind, startedAt: performance.now(), timeoutMs, events: [], nextCall: 1, omitted: 0, settled: false }
  const promise = actions.run(action, send)
  void promise.then((answer) => {
    action.settled = true
    if (!answer.result.ok && answer.result.failure.class === 'timeout') flush(path, action, answer.input)
  }, (error: unknown) => {
    action.settled = true
    if (classOf(error) === 'timeout') flush(path, action, undefined)
  })
  return promise
}

function observeCall(layer: Layer, method: string, params: object | undefined, timeoutMs: number | undefined, send: () => Promise<unknown>): Promise<unknown> {
  const action = actions.getStore()
  const known = methods.find((each) => each === method)
  if (action === undefined || action.settled || known === undefined) return send()
  const call = action.nextCall++
  const phase = phaseOf(known, params)
  const callBudgetMs = timeoutMs !== undefined && Number.isFinite(timeoutMs) ? timeoutMs : undefined
  const record = (event: TraceEvent['event'], errorClass?: ErrorClass): void => {
    if (action.settled) return
    const elapsedMs = performance.now() - action.startedAt
    action.events.push({ call, layer, method: known, phase, event, elapsedMs, remainingMs: Math.max(0, action.timeoutMs - elapsedMs), callBudgetMs, errorClass })
    if (action.events.length > eventLimit) {
      action.events.shift()
      action.omitted += 1
    }
  }
  record('started')
  let promise: Promise<unknown>
  try {
    promise = send()
  } catch (error: unknown) {
    record('rejected', classOf(error))
    throw error
  }
  void promise.then(() => record('settled'), (error: unknown) => record('rejected', classOf(error)))
  return promise
}

function phaseOf(method: Method, params: object | undefined): Phase | undefined {
  if (method !== 'Runtime.callFunctionOn' || params === undefined) return undefined
  // Compare the shared helper in memory. Neither its source nor any argument is retained or printed.
  try {
    if ('functionDeclaration' in params && typeof params.functionDeclaration === 'string') return phases.get(params.functionDeclaration)
  } catch {
    // A diagnostic property read must not prevent the original send.
  }
  return undefined
}

function flush(path: string, action: Action, input: InputDispatch | undefined): void {
  try {
    const elapsedMs = performance.now() - action.startedAt
    appendFileSync(path, `# retest.browser.action.timeout ${JSON.stringify({
      version: 1, hostPid: process.pid, engine: action.engine, kind: action.kind,
      timeoutMs: action.timeoutMs, elapsedMs, remainingMs: Math.max(0, action.timeoutMs - elapsedMs),
      errorClass: 'timeout', input, omitted: action.omitted, events: action.events,
    })}\n`, { mode: 0o600 })
  } catch {
    // A failed diagnostic write cannot replace the action's original result or rejection.
  }
}

function knownAction(kind: BrowserCommand['kind']): ActionKind | undefined {
  switch (kind) {
    case 'click': case 'tap': case 'hover': case 'fill': case 'press':
    case 'select': case 'check': case 'uncheck': case 'scroll': return kind
    default: return undefined
  }
}

function classOf(error: unknown): ErrorClass {
  if (error instanceof CdpTimeoutError || error instanceof BidiTimeoutError) return 'timeout'
  if (error instanceof CdpAbortedError || error instanceof BidiAbortedError) return 'aborted'
  if (error instanceof CdpBlockedError) return 'blocked'
  if (error instanceof CdpClosedError || error instanceof BidiClosedError) return 'closed'
  if (error instanceof CdpDisconnectedError || error instanceof BidiDisconnectedError) return 'disconnected'
  if (error instanceof CdpProtocolError || error instanceof BidiProtocolError) return 'protocol'
  if (error instanceof CdpInvalidResponseError || error instanceof BidiInvalidResponseError) return 'invalid_response'
  if (error instanceof CdpPendingLimitError || error instanceof BidiPendingLimitError) return 'pending_limit'
  return 'other'
}
