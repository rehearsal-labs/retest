import type { OutgoingMessage, Transport } from '../../src/browser/cdp/transport.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { Listeners } from '../../src/browser/listeners.ts'

/**
 * A client for the protocol Playwright's WebKit build speaks over `--inspector-pipe`: WebKit's inspector protocol
 * plus the build's `Playwright.*` domain. Messages reach three places. The browser takes `{id, method, params}`.
 * A page proxy, the browser-process side of one page, takes the same with a `pageProxyId`, and handles input,
 * emulation and dialogs. A page target, the web-process side, takes commands wrapped in
 * `Target.sendMessageToTarget` and answers in `Target.dispatchMessageFromTarget` events, and handles `Page`,
 * `Runtime`, `DOM`, `Console` and `Network`. Every command, wrapped or not, takes its id from one counter, so a
 * response finds its command by id alone.
 */

/** An error the browser returned. WebKit repeats it in `data` as a list, where Chromium sends a string. */
export type WkErrorBody = { code: number; message: string }

export type WkIncoming =
  | { kind: 'result'; id: number; result: unknown; pageProxyId: string | undefined }
  | { kind: 'error'; id: number; error: WkErrorBody; pageProxyId: string | undefined }
  | { kind: 'event'; method: string; params: unknown; pageProxyId: string | undefined }
  | { kind: 'malformed'; problem: string; id: number | undefined }

/** Where a command went: `browser`, `page proxy 7` or `target page-8 of page proxy 7`. */
export type WkCommand = { readonly method: string; readonly scope: string }

/** An event from a page target, unwrapped from the page proxy's `Target.dispatchMessageFromTarget`. */
export type TargetEvent = { pageProxyId: string; targetId: string; method: string; params: unknown }

/** An event a page proxy sent itself, such as `Target.targetCreated`. */
export type PageProxyEvent = { method: string; params: unknown }

/** `timeoutMs` bounds the wait for the response. A command that times out may still have run. */
export type WkSendOptions = { timeoutMs?: number }

export type WkConnectionOptions = {
  /** Used by every command that does not set its own timeout. */
  timeoutMs: number
  /** Something the connection could not use. None of them end the connection. */
  onDiagnostic: (problem: string) => void
}

export class WkCommandError extends Error {
  readonly method: string
  readonly scope: string

  constructor(command: WkCommand, message: string) {
    super(message)
    this.name = new.target.name
    this.method = command.method
    this.scope = command.scope
  }
}

/** The browser answered the command with an error. */
export class WkProtocolError extends WkCommandError {
  readonly code: number
  /** The browser's own words. They can quote page content, so they stay out of anything shared. */
  readonly detail: string

  constructor(command: WkCommand, error: WkErrorBody) {
    super(command, `${command.method} on the ${command.scope} failed: ${error.message}`)
    this.code = error.code
    this.detail = error.message
  }
}

export class WkTimeoutError extends WkCommandError {
  readonly timeoutMs: number
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: WkCommand, outcome: { timeoutMs: number; written: boolean }) {
    super(command, `${command.method} on the ${command.scope} got no response within ${outcome.timeoutMs} ms`)
    this.timeoutMs = outcome.timeoutMs
    this.written = outcome.written
  }
}

/**
 * The connection ended before the command was answered. When `written` is true the browser may have acted on it,
 * so its outcome is unknown.
 */
export class WkDisconnectedError extends WkCommandError {
  readonly reason: string
  /** False only when the command certainly never reached the browser. */
  readonly written: boolean

  constructor(command: WkCommand, outcome: { reason: string; written: boolean }) {
    super(command, `${command.method} on the ${command.scope} got no response: ${outcome.reason}`)
    this.reason = outcome.reason
    this.written = outcome.written
  }
}

/** The browser answered in a form this client cannot read. */
export class WkInvalidResponseError extends WkCommandError {
  constructor(command: WkCommand, problem: string) {
    super(command, `${command.method} on the ${command.scope} got a response that cannot be read: ${problem}`)
  }
}

type Pending = {
  readonly command: WkCommand
  readonly outgoing: OutgoingMessage
  readonly timer: NodeJS.Timeout
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

const WRAP_METHOD = 'Target.sendMessageToTarget'
const UNWRAP_EVENT = 'Target.dispatchMessageFromTarget'

/**
 * Reads one message from the browser. Problems never quote the text, which can hold page content.
 *
 * @example parseWkMessage('{"result":{},"id":1}') // { kind: 'result', id: 1, result: {}, pageProxyId: undefined }
 */
export function parseWkMessage(text: string): WkIncoming {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return malformed('the message is not valid JSON')
  }
  if (!isRecord(value)) return malformed('the message is not a JSON object')
  const pageProxyId = optionalId(value['pageProxyId'])
  if (pageProxyId === false) return malformed('the message has a pageProxyId that is not a non-empty string')
  if ('id' in value) return parseResponse(value, pageProxyId)
  const method = value['method']
  if (typeof method !== 'string' || method === '') return malformed('the message is neither a response nor an event')
  return { kind: 'event', method, params: value['params'], pageProxyId }
}

function parseResponse(value: Record<string, unknown>, pageProxyId: string | undefined): WkIncoming {
  const id = value['id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return malformed('the response id is not a non-negative integer')
  const hasResult = 'result' in value
  if (hasResult === 'error' in value) {
    return malformed(`the response has ${hasResult ? 'both a result and an error' : 'neither a result nor an error'}`, id)
  }
  if (hasResult) return { kind: 'result', id, result: value['result'], pageProxyId }
  const error = value['error']
  if (!isRecord(error)) return malformed('the response error is not an object', id)
  const { code, message } = error
  if (typeof code !== 'number' || !Number.isInteger(code) || typeof message !== 'string') {
    return malformed('the response error has no integer code and text message', id)
  }
  return { kind: 'error', id, error: { code, message }, pageProxyId }
}

function optionalId(value: unknown): string | undefined | false {
  if (value === undefined) return undefined
  return typeof value === 'string' && value !== '' ? value : false
}

function malformed(problem: string, id?: number): WkIncoming {
  return { kind: 'malformed', problem, id }
}

/** One connection to a WebKit build over a transport, with page proxies and page targets multiplexed on it. */
export class WkConnection {
  readonly #transport: Transport
  readonly #timeoutMs: number
  readonly #onDiagnostic: (problem: string) => void
  readonly #pending = new Map<number, Pending>()
  readonly #browserEvents = new Map<string, Listeners<unknown>>()
  readonly #pageProxyEvents = new Map<string, Listeners<PageProxyEvent>>()
  readonly #targetEvents = new Map<string, Listeners<TargetEvent>>()
  readonly #disconnectListeners: Listeners<string>
  #nextId = 1
  #closeReason: string | undefined

  constructor(transport: Transport, options: WkConnectionOptions) {
    if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1) {
      throw new RangeError(`A timeout must be a positive whole number of milliseconds, received ${options.timeoutMs}`)
    }
    this.#transport = transport
    this.#timeoutMs = options.timeoutMs
    this.#onDiagnostic = options.onDiagnostic
    this.#disconnectListeners = this.#listeners('disconnect')
    transport.listen({
      message: (text) => this.#receive(text),
      malformed: (problem) => this.#onDiagnostic(`a message from the browser could not be read: ${problem}`),
      close: (reason) => this.#disconnect(reason),
    })
  }

  /** Set once the connection ended. */
  get closeReason(): string | undefined {
    return this.#closeReason
  }

  /**
   * Sends a command to the browser and resolves with its unvalidated result.
   * @example await connection.send('Playwright.createContext')
   */
  send(method: string, params?: object, options?: WkSendOptions): Promise<unknown> {
    const command = { method, scope: 'browser' }
    return this.#write(command, { method, params }, options)
  }

  /**
   * Sends a command to a page proxy, the browser-process side of a page.
   * @example await connection.sendToPageProxy('7', 'Input.dispatchMouseEvent', { type: 'move', x: 10, y: 10 })
   */
  sendToPageProxy(pageProxyId: string, method: string, params?: object, options?: WkSendOptions): Promise<unknown> {
    const command = { method, scope: `page proxy ${pageProxyId}` }
    return this.#write(command, { method, params, pageProxyId }, options)
  }

  /**
   * Sends a command to a page target, wrapped in `Target.sendMessageToTarget` on its page proxy. The answer comes
   * back as a `Target.dispatchMessageFromTarget` event that carries the inner id.
   *
   * @example await connection.sendToTarget('7', 'page-8', 'Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
   */
  async sendToTarget(pageProxyId: string, targetId: string, method: string, params?: object, options?: WkSendOptions): Promise<unknown> {
    const command = { method, scope: `target ${targetId} of page proxy ${pageProxyId}` }
    const wrapper = { method: WRAP_METHOD, scope: `page proxy ${pageProxyId}` }
    const timeoutMs = this.#timeout(options)
    if (this.#closeReason !== undefined) throw new WkDisconnectedError(command, { reason: this.#closeReason, written: false })
    const innerId = this.#takeId()
    const outerId = this.#takeId()
    const message = JSON.stringify({ id: innerId, method, params })
    const outgoing = this.#transport.send(
      JSON.stringify({ id: outerId, method: WRAP_METHOD, params: { targetId, message }, pageProxyId }),
    )
    const inner = this.#register(innerId, command, outgoing, timeoutMs)
    // A wrapper the page proxy refused, such as one for a target that is gone, never reached the target.
    this.#register(outerId, wrapper, outgoing, timeoutMs).catch((error: unknown) => {
      if (!(error instanceof WkProtocolError)) return
      const refusal = { code: error.code, message: `the page proxy did not pass it on: ${error.detail}` }
      this.#settle(innerId, (pending) => pending.reject(new WkProtocolError(command, refusal)))
    })
    return inner
  }

  /**
   * Listens for a browser event, one without a `pageProxyId`, and returns a function that stops listening.
   * @example const stop = connection.onBrowserEvent('Playwright.pageProxyCreated', (params) => {})
   */
  onBrowserEvent(method: string, listener: (params: unknown) => void): () => void {
    return this.#listenersFor(this.#browserEvents, method).add(listener)
  }

  /** Listens for every event a page proxy sends itself. Wrapped target messages go to `onTargetEvent` instead. */
  onPageProxyEvent(pageProxyId: string, listener: (event: PageProxyEvent) => void): () => void {
    return this.#listenersFor(this.#pageProxyEvents, pageProxyId).add(listener)
  }

  /** Listens for every event from every target of a page proxy. */
  onTargetEvent(pageProxyId: string, listener: (event: TargetEvent) => void): () => void {
    return this.#listenersFor(this.#targetEvents, pageProxyId).add(listener)
  }

  /** Listens for the end of the connection, whichever side ended it. */
  onDisconnect(listener: (reason: string) => void): () => void {
    if (this.#closeReason !== undefined) {
      listener(this.#closeReason)
      return () => {}
    }
    return this.#disconnectListeners.add(listener)
  }

  /** Ends the connection. Every waiting command rejects with a `WkDisconnectedError`. */
  close(): void {
    this.#transport.close()
  }

  async #write(command: WkCommand, message: object, options: WkSendOptions | undefined): Promise<unknown> {
    const timeoutMs = this.#timeout(options)
    if (this.#closeReason !== undefined) throw new WkDisconnectedError(command, { reason: this.#closeReason, written: false })
    const id = this.#takeId()
    const outgoing = this.#transport.send(JSON.stringify({ id, ...message }))
    return this.#register(id, command, outgoing, timeoutMs)
  }

  #register(id: number, command: WkCommand, outgoing: OutgoingMessage, timeoutMs: number): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const timer = setTimeout(() => {
      this.#settle(id, (pending) => pending.reject(new WkTimeoutError(command, { timeoutMs, written: pending.outgoing.written })))
    }, timeoutMs)
    this.#pending.set(id, { command, outgoing, timer, resolve, reject })
    return promise
  }

  #receive(text: string): void {
    const message = parseWkMessage(text)
    if (message.kind === 'malformed') {
      this.#onDiagnostic(`a message from the browser could not be read: ${message.problem}`)
      if (message.id !== undefined) this.#settle(message.id, (pending) => pending.reject(new WkInvalidResponseError(pending.command, message.problem)))
      return
    }
    if (message.kind === 'event') {
      this.#dispatch(message.method, message.params, message.pageProxyId)
      return
    }
    this.#answer(message)
  }

  #answer(message: Extract<WkIncoming, { kind: 'result' | 'error' }>): void {
    const settled = this.#settle(message.id, (pending) => {
      if (message.kind === 'error') pending.reject(new WkProtocolError(pending.command, message.error))
      else pending.resolve(message.result)
    })
    if (!settled) this.#onDiagnostic(`the browser answered command ${message.id}, which nothing was waiting for`)
  }

  #dispatch(method: string, params: unknown, pageProxyId: string | undefined): void {
    if (pageProxyId === undefined) {
      this.#browserEvents.get(method)?.emit(params)
      return
    }
    if (method !== UNWRAP_EVENT) {
      this.#pageProxyEvents.get(pageProxyId)?.emit({ method, params })
      return
    }
    const targetId = isRecord(params) ? params['targetId'] : undefined
    const text = isRecord(params) ? params['message'] : undefined
    if (typeof targetId !== 'string' || typeof text !== 'string') {
      this.#onDiagnostic(`${UNWRAP_EVENT} has no targetId and message text`)
      return
    }
    const inner = parseWkMessage(text)
    if (inner.kind === 'malformed') {
      this.#onDiagnostic(`a message from target ${targetId} could not be read: ${inner.problem}`)
      if (inner.id !== undefined) this.#settle(inner.id, (pending) => pending.reject(new WkInvalidResponseError(pending.command, inner.problem)))
    } else if (inner.kind === 'event') {
      this.#targetEvents.get(pageProxyId)?.emit({ pageProxyId, targetId, method: inner.method, params: inner.params })
    } else {
      this.#answer(inner)
    }
  }

  #disconnect(reason: string): void {
    if (this.#closeReason !== undefined) return
    this.#closeReason = reason
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, (pending) => pending.reject(new WkDisconnectedError(pending.command, { reason, written: pending.outgoing.written })))
    }
    this.#disconnectListeners.emit(reason)
  }

  /** Removes a command for good, so it is never written after this and a late response finds nothing. */
  #settle(id: number, settle: (pending: Pending) => void): boolean {
    const pending = this.#pending.get(id)
    if (pending === undefined) return false
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    if (!this.#anyPendingShares(pending.outgoing)) pending.outgoing.withdraw()
    settle(pending)
    return true
  }

  // A wrapped command and its wrapper share one outgoing message; it is withdrawn only once neither waits on it.
  #anyPendingShares(outgoing: OutgoingMessage): boolean {
    for (const pending of this.#pending.values()) if (pending.outgoing === outgoing) return true
    return false
  }

  #takeId(): number {
    const id = this.#nextId
    this.#nextId += 1
    return id
  }

  #timeout(options: WkSendOptions | undefined): number {
    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError(`A timeout must be a positive whole number of milliseconds, received ${timeoutMs}`)
    }
    return timeoutMs
  }

  #listenersFor<T>(map: Map<string, Listeners<T>>, key: string): Listeners<T> {
    let listeners = map.get(key)
    if (listeners === undefined) {
      listeners = this.#listeners(key)
      map.set(key, listeners)
    }
    return listeners
  }

  #listeners<T>(name: string): Listeners<T> {
    return new Listeners<T>((error) => this.#onDiagnostic(`a listener for ${name} failed: ${error instanceof Error ? error.message : String(error)}`))
  }
}
