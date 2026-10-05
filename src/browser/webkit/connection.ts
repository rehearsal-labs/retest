import type { OutgoingMessage, Transport } from '../cdp/transport.ts'
import type { CommandIdentity } from '../cdp/errors.ts'
import type { SendOptions } from '../cdp/session.ts'
import { maxTimeout } from '../../protocol/timeouts.ts'
import {
  CdpAbortedError,
  CdpClosedError,
  CdpDisconnectedError,
  CdpInvalidResponseError,
  CdpPendingLimitError,
  CdpProtocolError,
  CdpTimeoutError,
} from '../cdp/errors.ts'
import { isRecord } from '../cdp/message.ts'
import { Listeners } from '../listeners.ts'

// The protocol Playwright's WebKit build speaks over `--inspector-pipe`: WebKit's inspector protocol plus the build's
// `Playwright` domain, as NUL-terminated JSON on fds 3 and 4, the framing `PipeTransport` reads. A message reaches one of
// three places. The browser takes `{id, method, params}`. A page proxy, the browser-process side of one page, takes the
// same with a `pageProxyId`, and handles input, emulation, dialogs and the screencast. A page target, the web-process
// side, takes commands wrapped in `Target.sendMessageToTarget` and answers in `Target.dispatchMessageFromTarget` events;
// it handles `Page`, `Runtime`, `DOM`, `Console` and `Network`. Every command, wrapped or not, takes its id from one
// counter, so a response finds its command by id alone. Failures use the same error classes as Retest's CDP client,
// so the code that judges how far a command got reads both drivers alike.

/** An event a page proxy sent itself, such as `Target.targetCreated`. */
export type PageProxyEvent = { readonly method: string; readonly params: unknown }

/** An event from a page target, unwrapped from its page proxy's `Target.dispatchMessageFromTarget`. */
export type TargetEvent = { readonly pageProxyId: string; readonly targetId: string; readonly method: string; readonly params: unknown }

export type WebKitConnectionOptions = {
  /** Used by every command that does not set its own timeout. */
  timeoutMs: number
  /** How many commands may wait for a response at once. */
  maxPending?: number
  /** Something the connection could not read or deliver. None of them end the connection. */
  onDiagnostic: (problem: string) => void
}

/** The body of an error the browser returned. WebKit repeats the error in `data` as a list, which is not kept. */
export type WebKitErrorBody = { code: number; message: string }

/** One message from the browser, read. */
export type WebKitIncoming =
  | { kind: 'result'; id: number; result: unknown; pageProxyId: string | undefined }
  | { kind: 'error'; id: number; error: WebKitErrorBody; pageProxyId: string | undefined }
  | { kind: 'event'; method: string; params: unknown; pageProxyId: string | undefined }
  | { kind: 'malformed'; problem: string; id: number | undefined }

type Pending = {
  readonly command: CommandIdentity
  readonly outgoing: OutgoingMessage
  readonly timer: NodeJS.Timeout
  readonly stopListening: () => void
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
  /** The wrapper a page target's command went in, which goes with it once the command is settled. */
  wrapperId?: number
}

export const defaultMaxPending: number = 1000

const wrapMethod = 'Target.sendMessageToTarget'
const unwrapEvent = 'Target.dispatchMessageFromTarget'

/**
 * Reads one message from the browser. Problems never quote the text, which can hold page content.
 *
 * @example parseWebKitMessage('{"result":{},"id":1}') // { kind: 'result', id: 1, result: {}, pageProxyId: undefined }
 */
export function parseWebKitMessage(text: string): WebKitIncoming {
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

function parseResponse(value: Record<string, unknown>, pageProxyId: string | undefined): WebKitIncoming {
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

function malformed(problem: string, id?: number): WebKitIncoming {
  return { kind: 'malformed', problem, id }
}

/**
 * Where a command went, as an error names it: nothing for the browser, `page proxy 7`, or `target page-8 of page
 * proxy 7`.
 *
 * @example targetScope('7', 'page-8') // 'target page-8 of page proxy 7'
 */
export function targetScope(pageProxyId: string, targetId: string): string {
  return `target ${targetId} of page proxy ${pageProxyId}`
}

/** One connection to a WebKit build, with its page proxies and page targets on it. */
export class WebKitConnection {
  readonly #transport: Transport
  readonly #timeoutMs: number
  readonly #maxPending: number
  readonly #onDiagnostic: (problem: string) => void
  readonly #pending = new Map<number, Pending>()
  readonly #browserEvents = new Map<string, Listened<unknown>>()
  readonly #pageProxyEvents = new Map<string, Listened<PageProxyEvent>>()
  readonly #targetEvents = new Map<string, Listened<TargetEvent>>()
  readonly #disconnects: Listeners<string>
  #nextId = 1
  #closeReason: string | undefined

  constructor(transport: Transport, options: WebKitConnectionOptions) {
    assertTimeout(options.timeoutMs)
    const maxPending = options.maxPending ?? defaultMaxPending
    if (!Number.isInteger(maxPending) || maxPending < 1) throw new RangeError(`maxPending must be a positive integer, received ${maxPending}`)
    this.#transport = transport
    this.#timeoutMs = options.timeoutMs
    this.#maxPending = maxPending
    this.#onDiagnostic = options.onDiagnostic
    this.#disconnects = this.#listeners('disconnect')
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
  send(method: string, params?: object, options?: SendOptions): Promise<unknown> {
    return this.#write({ method, sessionId: undefined }, { method, params }, options)
  }

  /**
   * Sends a command to a page proxy, the browser-process side of a page.
   * @example await connection.sendToPageProxy('7', 'Input.dispatchMouseEvent', { type: 'move', x: 10, y: 10 })
   */
  sendToPageProxy(pageProxyId: string, method: string, params?: object, options?: SendOptions): Promise<unknown> {
    return this.#write({ method, sessionId: `page proxy ${pageProxyId}` }, { method, params, pageProxyId }, options)
  }

  /**
   * Sends a command to a page target, wrapped in `Target.sendMessageToTarget` on its page proxy; the answer comes back
   * in a `Target.dispatchMessageFromTarget` event that carries the inner id. A wrapper the page proxy refuses, as it
   * refuses one for a target that is gone, never reached the target, so the command fails as one that was not sent.
   *
   * @example await connection.sendToTarget('7', 'page-8', 'Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
   */
  async sendToTarget(pageProxyId: string, targetId: string, method: string, params?: object, options?: SendOptions): Promise<unknown> {
    const command = { method, sessionId: targetScope(pageProxyId, targetId) }
    const wrapper = { method: wrapMethod, sessionId: `page proxy ${pageProxyId}` }
    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs
    assertTimeout(timeoutMs)
    const refused = this.#refusal(command, options)
    if (refused !== undefined) throw refused
    if (this.#pending.size + 2 > this.#maxPending) throw new CdpPendingLimitError(command, this.#maxPending)
    const innerId = this.#takeId()
    const outerId = this.#takeId()
    const message = JSON.stringify({ id: innerId, method, params })
    const outgoing = this.#transport.send(JSON.stringify({ id: outerId, method: wrapMethod, params: { targetId, message }, pageProxyId }))
    const inner = this.#register(innerId, command, outgoing, timeoutMs, options?.signal)
    this.#register(outerId, wrapper, outgoing, timeoutMs, undefined).catch((error: unknown) => {
      if (!(error instanceof CdpProtocolError)) return
      this.#settle(innerId, (pending) => pending.reject(new CdpClosedError(pending.command, `the page's target ${targetId} is gone: ${error.protocolMessage}`)))
    })
    const registered = this.#pending.get(innerId)
    if (registered !== undefined) registered.wrapperId = outerId
    return inner
  }

  /**
   * Listens for a browser event, one without a `pageProxyId`, and returns a function that stops listening.
   * @example const stop = connection.onBrowserEvent('Playwright.pageProxyCreated', (params) => {})
   */
  onBrowserEvent(method: string, listener: (params: unknown) => void): () => void {
    return this.#listen(this.#browserEvents, method, listener)
  }

  /** Listens for every event a page proxy sends itself. Wrapped target messages go to `onTargetEvent` instead. */
  onPageProxyEvent(pageProxyId: string, listener: (event: PageProxyEvent) => void): () => void {
    return this.#listen(this.#pageProxyEvents, pageProxyId, listener)
  }

  /** Listens for every event from every target of a page proxy. */
  onTargetEvent(pageProxyId: string, listener: (event: TargetEvent) => void): () => void {
    return this.#listen(this.#targetEvents, pageProxyId, listener)
  }

  /** How many page proxies something listens to, by their own events or their targets'; one goes with its last listener. */
  get listenedPages(): number {
    return new Set([...this.#pageProxyEvents.keys(), ...this.#targetEvents.keys()]).size
  }

  /** Listens for the end of the connection, whichever side ended it; one that arrives after it hears it at once. */
  onDisconnect(listener: (reason: string) => void): () => void {
    const reason = this.#closeReason
    if (reason === undefined) return this.#disconnects.add(listener)
    const late = this.#listeners<string>('disconnect')
    const remove = late.add(listener)
    queueMicrotask(() => late.emit(reason))
    return remove
  }

  /** Ends the connection. Every waiting command rejects with a `CdpDisconnectedError`. */
  close(): void {
    this.#transport.close()
  }

  // Async, so every refusal arrives as a rejection.
  async #write(command: CommandIdentity, message: object, options: SendOptions | undefined): Promise<unknown> {
    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs
    assertTimeout(timeoutMs)
    const refused = this.#refusal(command, options)
    if (refused !== undefined) throw refused
    if (this.#pending.size >= this.#maxPending) throw new CdpPendingLimitError(command, this.#maxPending)
    const id = this.#takeId()
    const outgoing = this.#transport.send(JSON.stringify({ id, ...message }))
    return this.#register(id, command, outgoing, timeoutMs, options?.signal)
  }

  #refusal(command: CommandIdentity, options: SendOptions | undefined): Error | undefined {
    if (options?.signal?.aborted === true) return new CdpAbortedError(command, { written: false })
    if (this.#closeReason !== undefined) return new CdpClosedError(command, this.#closeReason)
    return undefined
  }

  #register(id: number, command: CommandIdentity, outgoing: OutgoingMessage, timeoutMs: number, signal: AbortSignal | undefined): Promise<unknown> {
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const abort = (): void => {
      this.#settle(id, (pending) => pending.reject(new CdpAbortedError(pending.command, { written: pending.outgoing.written })))
    }
    const timer = setTimeout(() => {
      this.#settle(id, (pending) => pending.reject(new CdpTimeoutError(pending.command, { timeoutMs, written: pending.outgoing.written })))
    }, timeoutMs)
    this.#pending.set(id, { command, outgoing, timer, stopListening: () => signal?.removeEventListener('abort', abort), resolve, reject })
    signal?.addEventListener('abort', abort, { once: true })
    return promise
  }

  #receive(text: string): void {
    const message = parseWebKitMessage(text)
    if (message.kind === 'malformed') {
      this.#onDiagnostic(`a message from the browser could not be read: ${message.problem}`)
      if (message.id !== undefined) this.#settle(message.id, (pending) => pending.reject(new CdpInvalidResponseError(pending.command, message.problem)))
      return
    }
    if (message.kind === 'event') {
      this.#dispatch(message.method, message.params, message.pageProxyId)
      return
    }
    this.#answer(message)
  }

  #answer(message: Extract<WebKitIncoming, { kind: 'result' | 'error' }>): void {
    const settled = this.#settle(message.id, (pending) => {
      if (message.kind === 'error') pending.reject(new CdpProtocolError(pending.command, { ...message.error, data: undefined }))
      else pending.resolve(message.result)
    })
    if (!settled) this.#onDiagnostic(`the browser answered command ${message.id}, which nothing was waiting for`)
  }

  #dispatch(method: string, params: unknown, pageProxyId: string | undefined): void {
    if (pageProxyId === undefined) {
      this.#browserEvents.get(method)?.listeners.emit(params)
      return
    }
    if (method !== unwrapEvent) {
      this.#pageProxyEvents.get(pageProxyId)?.listeners.emit({ method, params })
      return
    }
    const targetId = isRecord(params) ? params['targetId'] : undefined
    const text = isRecord(params) ? params['message'] : undefined
    if (typeof targetId !== 'string' || typeof text !== 'string') {
      this.#onDiagnostic(`${unwrapEvent} has no targetId and message text`)
      return
    }
    const inner = parseWebKitMessage(text)
    if (inner.kind === 'malformed') {
      this.#onDiagnostic(`a message from target ${targetId} could not be read: ${inner.problem}`)
      if (inner.id !== undefined) this.#settle(inner.id, (pending) => pending.reject(new CdpInvalidResponseError(pending.command, inner.problem)))
    } else if (inner.kind === 'event') {
      this.#targetEvents.get(pageProxyId)?.listeners.emit({ pageProxyId, targetId, method: inner.method, params: inner.params })
    } else {
      this.#answer(inner)
    }
  }

  #disconnect(reason: string): void {
    if (this.#closeReason !== undefined) return
    this.#closeReason = reason
    for (const id of [...this.#pending.keys()]) {
      this.#settle(id, (pending) => pending.reject(new CdpDisconnectedError(pending.command, { reason, written: pending.outgoing.written })))
    }
    this.#disconnects.emit(reason)
  }

  /**
   * Removes a command for good, so it is never written after this and a late response finds nothing. A settled command
   * takes its wrapper with it, so a command stopped before it was written is never written.
   */
  #settle(id: number, settle: (pending: Pending) => void): boolean {
    const pending = this.#pending.get(id)
    if (pending === undefined) return false
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.stopListening()
    const wrapper = pending.wrapperId === undefined ? undefined : this.#pending.get(pending.wrapperId)
    if (wrapper !== undefined && pending.wrapperId !== undefined) {
      this.#pending.delete(pending.wrapperId)
      clearTimeout(wrapper.timer)
      wrapper.resolve(undefined)
    }
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

  // Each key keeps its entry only while something listens to it, so a page that went takes its entries with it.
  #listen<T>(map: Map<string, Listened<T>>, key: string, listener: (value: T) => void): () => void {
    let entry = map.get(key)
    if (entry === undefined) {
      entry = { listeners: this.#listeners(key), count: 0 }
      map.set(key, entry)
    }
    const listened = entry
    const remove = listened.listeners.add(listener)
    listened.count += 1
    let removed = false
    return () => {
      if (removed) return
      removed = true
      remove()
      listened.count -= 1
      if (listened.count === 0 && map.get(key) === listened) map.delete(key)
    }
  }

  #listeners<T>(name: string): Listeners<T> {
    return new Listeners<T>((error) => this.#onDiagnostic(`a listener for ${name} failed: ${error instanceof Error ? error.message : String(error)}`))
  }
}

/** The listeners of one key, and how many there are. */
type Listened<T> = { readonly listeners: Listeners<T>; count: number }

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout) {
    throw new RangeError(`A WebKit timeout must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${timeoutMs}`)
  }
}
