import type { CommandIdentity } from './bidi-errors.ts'
import type { Schema } from '../../src/protocol/schema.ts'
import { Listeners } from '../../src/browser/listeners.ts'
import { isPlainObject, parse, toJsonSchema } from '../../src/protocol/schema.ts'
import { maxTimeout } from '../../src/protocol/timeouts.ts'
import {
  BidiAbortedError,
  BidiClosedError,
  BidiConnectError,
  BidiDisconnectedError,
  BidiInvalidResponseError,
  BidiProtocolError,
  BidiTimeoutError,
} from './bidi-errors.ts'
import { parseBidiMessage } from './bidi-message.ts'

/**
 * Something the client could not use or deliver. None of them end the connection. A failed listener names its
 * event, or `close` for a disconnect listener.
 */
export type BidiDiagnostic =
  | { kind: 'malformed-message'; problem: string }
  | { kind: 'unmatched-response'; id: number | undefined }
  | { kind: 'listener-failed'; event: string; error: unknown }

export type ConnectOptions = {
  /** Bounds every command that does not set its own timeout, and opening the WebSocket unless `connectTimeoutMs` is given. */
  timeoutMs: number
  connectTimeoutMs?: number
  onDiagnostic: (diagnostic: BidiDiagnostic) => void
}

/**
 * How one command is sent. `keepErrorMessage` keeps the browser's own message in a protocol error. Firefox quotes
 * argument values in it, so a command whose arguments can hold a secret, such as text to type, never asks for it.
 */
export type SendOptions = { timeoutMs?: number; signal?: AbortSignal | undefined; keepErrorMessage?: boolean }

type PendingCommand = {
  readonly command: CommandIdentity
  readonly keepErrorMessage: boolean
  readonly timer: NodeJS.Timeout
  readonly stopListening: () => void
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

type SchemaNode = Parameters<typeof toJsonSchema>[0]

const closedByRetest = 'Retest closed the connection'

/**
 * A WebDriver BiDi client over one WebSocket, such as Firefox's Remote Agent serves at `/session`. It numbers
 * commands, matches each response to its command, bounds every wait, hands events to their listeners and fails
 * every waiting command once the connection ends. It knows no browser and starts no session: `session.new` is a
 * command like any other.
 *
 * @example const client = await BidiClient.connect(`${firefox.webSocketUrl}/session`, { timeoutMs: 5000, onDiagnostic })
 */
export class BidiClient {
  readonly #socket: WebSocket
  readonly #timeoutMs: number
  readonly #onDiagnostic: (diagnostic: BidiDiagnostic) => void
  readonly #events = new Map<string, Listeners<unknown>>()
  readonly #disconnectListeners: Listeners<string>
  readonly #pending = new Map<number, PendingCommand>()
  #nextId = 1
  #closeReason: string | undefined

  /** Opens the WebSocket within its timeout. A socket that does not open is closed, and the failure says why. */
  static async connect(url: string, options: ConnectOptions): Promise<BidiClient> {
    const connectTimeoutMs = options.connectTimeoutMs ?? options.timeoutMs
    assertTimeout(options.timeoutMs)
    assertTimeout(connectTimeoutMs)
    const client = new BidiClient(new WebSocket(url), options)
    await client.#opened(url, connectTimeoutMs)
    return client
  }

  private constructor(socket: WebSocket, options: ConnectOptions) {
    this.#socket = socket
    this.#timeoutMs = options.timeoutMs
    this.#onDiagnostic = options.onDiagnostic
    this.#disconnectListeners = new Listeners((error) => this.#onDiagnostic({ kind: 'listener-failed', event: 'close', error }))
    socket.addEventListener('message', (event) => this.#receive(event.data))
    socket.addEventListener('close', (event) => this.#disconnect(describeClose(event.code)))
  }

  /** Set once the connection ended. */
  get closeReason(): string | undefined {
    return this.#closeReason
  }

  /** How many commands are waiting for their response. A listener reads it to tell whether an event came first. */
  get waiting(): number {
    return this.#pending.size
  }

  /**
   * Sends a command and resolves with its unvalidated result. The socket gives no sign of when the browser read a
   * message, so a command counts as written once the socket took it.
   *
   * @example await client.send('browser.createUserContext', {})
   */
  async send(method: string, params: object, options: SendOptions = {}): Promise<unknown> {
    const command = { method }
    const timeoutMs = options.timeoutMs ?? this.#timeoutMs
    assertTimeout(timeoutMs)
    const { signal } = options
    if (signal?.aborted === true) throw new BidiAbortedError(command, { written: false })
    if (this.#closeReason !== undefined) throw new BidiClosedError(command, this.#closeReason)
    if (this.#socket.readyState !== WebSocket.OPEN) throw new BidiClosedError(command, 'the WebSocket is not open')

    const id = this.#nextId
    this.#nextId += 1
    const text = JSON.stringify({ id, method, params })
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const abort = (): void => this.#take(id)?.reject(new BidiAbortedError(command, { written: true }))
    this.#pending.set(id, {
      command,
      keepErrorMessage: options.keepErrorMessage === true,
      timer: setTimeout(() => this.#take(id)?.reject(new BidiTimeoutError(command, { timeoutMs, written: true })), timeoutMs),
      stopListening: () => signal?.removeEventListener('abort', abort),
      resolve,
      reject,
    })
    signal?.addEventListener('abort', abort, { once: true })
    this.#socket.send(text)
    return promise
  }

  /**
   * Sends a command and validates the parts of its result Retest relies on.
   *
   * @example const { userContext } = await client.request('browser.createUserContext', {}, userContextSchema)
   */
  async request<T>(method: string, params: object, schema: Schema<T>, options?: SendOptions): Promise<T> {
    return readBidi(schema, await this.send(method, params, options), method)
  }

  /**
   * Listens for an event the session subscribed to, and returns a function that stops listening.
   *
   * @example const stop = client.on('log.entryAdded', (params) => entries.push(params))
   */
  on(method: string, listener: (params: unknown) => void): () => void {
    let listeners = this.#events.get(method)
    if (listeners === undefined) {
      listeners = new Listeners((error) => this.#onDiagnostic({ kind: 'listener-failed', event: method, error }))
      this.#events.set(method, listeners)
    }
    return listeners.add(listener)
  }

  /** Hears why the connection ended, once. Returns a function that removes the listener. */
  onDisconnect(listener: (reason: string) => void): () => void {
    if (this.#closeReason !== undefined) {
      listener(this.#closeReason)
      return () => {}
    }
    return this.#disconnectListeners.add(listener)
  }

  /** Ends the connection. Every waiting command rejects with a `BidiDisconnectedError`. */
  close(): void {
    this.#disconnect(closedByRetest)
    this.#socket.close()
  }

  async #opened(url: string, timeoutMs: number): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const timer = setTimeout(() => reject(new BidiConnectError(`The WebSocket at ${url} did not open within ${timeoutMs} ms`)), timeoutMs)
    const opened = (): void => resolve()
    const ended = (): void => reject(new BidiConnectError(`The WebSocket at ${url} closed before it opened: ${this.#closeReason ?? 'no reason given'}`))
    this.#socket.addEventListener('open', opened, { once: true })
    this.#socket.addEventListener('close', ended, { once: true })
    try {
      await promise
    } catch (error) {
      this.close()
      throw error
    } finally {
      clearTimeout(timer)
      this.#socket.removeEventListener('open', opened)
      this.#socket.removeEventListener('close', ended)
    }
  }

  #receive(data: unknown): void {
    if (typeof data !== 'string') {
      this.#onDiagnostic({ kind: 'malformed-message', problem: 'the message is not text' })
      return
    }
    const message = parseBidiMessage(data)
    if (message.kind === 'event') {
      this.#events.get(message.method)?.emit(message.params)
      return
    }
    if (message.kind === 'malformed') {
      this.#onDiagnostic({ kind: 'malformed-message', problem: message.problem })
      const pending = message.id === undefined ? undefined : this.#take(message.id)
      pending?.reject(new BidiInvalidResponseError(pending.command, message.problem))
      return
    }
    const pending = message.id === undefined ? undefined : this.#take(message.id)
    if (pending === undefined) {
      this.#onDiagnostic({ kind: 'unmatched-response', id: message.id })
    } else if (message.kind === 'error') {
      const body = { error: message.error, message: pending.keepErrorMessage ? message.message : undefined }
      pending.reject(new BidiProtocolError(pending.command, body))
    } else {
      pending.resolve(message.result)
    }
  }

  #disconnect(reason: string): void {
    if (this.#closeReason !== undefined) return
    this.#closeReason = reason
    for (const id of [...this.#pending.keys()]) {
      const pending = this.#take(id)
      pending?.reject(new BidiDisconnectedError(pending.command, { reason, written: true }))
    }
    this.#events.clear()
    this.#disconnectListeners.emit(reason)
    this.#disconnectListeners.clear()
  }

  /** Removes a command for good, so a late response finds nothing. */
  #take(id: number): PendingCommand | undefined {
    const pending = this.#pending.get(id)
    if (pending === undefined) return undefined
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.stopListening()
    return pending
  }
}

/**
 * Validates a BiDi result or event. Keys the schema does not name are dropped first, because each browser release
 * may add fields. A problem names only the paths, since values can hold page content.
 *
 * @example const { userContext } = readBidi(userContextSchema, result, 'browser.createUserContext')
 */
export function readBidi<T>(schema: Schema<T>, value: unknown, method: string): T {
  const result = parse(schema, project(schema, value))
  if (result.ok) return result.value
  const problem = result.issues.map((issue) => `${issue.path} ${issue.message.replace(/, received .*$/, '')}`).join('; ')
  throw new BidiInvalidResponseError({ method }, problem)
}

function project(node: SchemaNode, value: unknown): unknown {
  if (node.kind === 'array' && Array.isArray(value)) return value.map((item: unknown) => project(node.item, item))
  if (node.kind !== 'object' || !isPlainObject(value)) return value
  const known: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(node.shape)) {
    if (Object.hasOwn(value, key)) known[key] = project(field.kind === 'optional' ? field.inner : field, value[key])
  }
  return known
}

// 1006 is the code a WebSocket reports when the connection dropped without a closing handshake, as a killed browser leaves it.
function describeClose(code: number): string {
  return code === 1006 ? 'the WebSocket connection was lost (code 1006)' : `the WebSocket closed with code ${code}`
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout) {
    throw new RangeError(`A BiDi timeout must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${timeoutMs}`)
  }
}
