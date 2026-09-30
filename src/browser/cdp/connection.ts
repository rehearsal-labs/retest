import type { OutgoingMessage, Transport } from './transport.ts'
import { maxTimeout } from '../../protocol/timeouts.ts'
import { Channel } from './channel.ts'
import {
  CdpAbortedError,
  CdpBlockedError,
  CdpClosedError,
  CdpDisconnectedError,
  CdpInvalidResponseError,
  CdpPendingLimitError,
  CdpProtocolError,
  CdpTimeoutError,
  type CommandIdentity,
} from './errors.ts'
import { isRecord, parseMessage, type IncomingEvent, type MalformedMessage } from './message.ts'
import { CdpSession, type SendOptions } from './session.ts'

/**
 * Something the connection could not use or deliver. None of them end the connection.
 * A failed listener names its CDP event, `block` for a block listener, or `close` for a detach or
 * disconnect listener.
 */
export type CdpDiagnostic =
  | { kind: 'malformed-message'; problem: string }
  | { kind: 'unmatched-response'; id: number }
  | { kind: 'unknown-session'; sessionId: string; method: string }
  | { kind: 'listener-failed'; event: string; sessionId: string | undefined; error: unknown }

export type ConnectionOptions = {
  /** Used by every command that does not set its own timeout. */
  timeoutMs: number
  /** How many commands may wait for a response at once. */
  maxPending?: number
  onDiagnostic: (diagnostic: CdpDiagnostic) => void
}

export const DEFAULT_MAX_PENDING: number = 1000

const ATTACH_METHOD = 'Target.attachToTarget'
const DETACHED_EVENT = 'Target.detachedFromTarget'

type PendingCommand = {
  readonly command: CommandIdentity
  readonly outgoing: OutgoingMessage
  readonly timer: NodeJS.Timeout
  readonly stopListening: () => void
  readonly resolve: (result: unknown) => void
  readonly reject: (error: Error) => void
}

/** A CDP client over one transport, with flat sessions. */
export class CdpConnection {
  readonly #transport: Transport
  readonly #timeoutMs: number
  readonly #maxPending: number
  readonly #onDiagnostic: (diagnostic: CdpDiagnostic) => void
  readonly #root: Channel
  readonly #sessions = new Map<string, Channel>()
  readonly #pending = new Map<number, PendingCommand>()
  #nextId = 1
  #closeReason: string | undefined

  constructor(transport: Transport, options: ConnectionOptions) {
    assertTimeout(options.timeoutMs)
    const maxPending = options.maxPending ?? DEFAULT_MAX_PENDING
    if (!Number.isInteger(maxPending) || maxPending < 1) {
      throw new RangeError(`maxPending must be a positive integer, received ${maxPending}`)
    }
    this.#transport = transport
    this.#timeoutMs = options.timeoutMs
    this.#maxPending = maxPending
    this.#onDiagnostic = options.onDiagnostic
    this.#root = this.#createChannel(undefined)
    transport.listen({
      message: (text) => this.#receive(text),
      malformed: (problem) => this.#onDiagnostic({ kind: 'malformed-message', problem }),
      close: (reason) => this.#disconnect(reason),
    })
  }

  /** Set once the connection ended. */
  get closeReason(): string | undefined {
    return this.#closeReason
  }

  /**
   * Sends a command to the browser and resolves with its unvalidated result.
   * @example await connection.send('Browser.getVersion')
   */
  send(method: string, params?: object, options?: SendOptions): Promise<unknown> {
    return this.#send(this.#root, method, params, options, passThrough)
  }

  /**
   * Listens for a browser-level event and returns a function that stops listening.
   * @example const stop = connection.on('Target.targetCrashed', () => {})
   */
  on(method: string, listener: (params: unknown) => void): () => void {
    return this.#root.on(method, listener)
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    return this.#root.onClose(listener)
  }

  /**
   * Attaches a flat session to a target.
   * @example const session = await connection.attach(targetId)
   */
  attach(targetId: string, options?: SendOptions): Promise<CdpSession> {
    return this.#send(this.#root, ATTACH_METHOD, { targetId, flatten: true }, options, (result) =>
      this.#openSession(result),
    )
  }

  /** Ends the connection. Every waiting command rejects with a `CdpDisconnectedError`. */
  close(): void {
    this.#transport.close()
  }

  // Async so that every refusal, including a params value JSON cannot hold, arrives as a rejection.
  async #send<T>(
    channel: Channel,
    method: string,
    params: object | undefined,
    options: SendOptions | undefined,
    read: (result: unknown) => T,
  ): Promise<T> {
    const command = { method, sessionId: channel.sessionId }
    const timeoutMs = options?.timeoutMs ?? this.#timeoutMs
    assertTimeout(timeoutMs)
    const signal = options?.signal
    if (signal?.aborted === true) throw new CdpAbortedError(command, { written: false })
    const closeReason = this.#closeReason ?? channel.closeReason
    if (closeReason !== undefined) throw new CdpClosedError(command, closeReason)
    const blockReason = channel.blockReason
    if (blockReason !== undefined) throw new CdpBlockedError(command, { reason: blockReason, written: false })
    if (this.#pending.size >= this.#maxPending) throw new CdpPendingLimitError(command, this.#maxPending)

    const id = this.#nextId
    const text = JSON.stringify({ id, method, params, sessionId: channel.sessionId })
    this.#nextId += 1
    const outgoing = this.#transport.send(text)
    const { promise, resolve, reject } = Promise.withResolvers<T>()
    const abort = (): void => this.#abort(id)
    this.#pending.set(id, {
      command,
      outgoing,
      timer: setTimeout(() => this.#expire(id, timeoutMs), timeoutMs),
      stopListening: () => signal?.removeEventListener('abort', abort),
      // Runs while the response is handled, before any later message, so a session exists before its first event.
      resolve: (result) => {
        try {
          resolve(read(result))
        } catch (error) {
          reject(error)
        }
      },
      reject,
    })
    signal?.addEventListener('abort', abort, { once: true })
    return promise
  }

  #receive(text: string): void {
    const message = parseMessage(text)
    if (message.kind === 'event') {
      this.#dispatch(message)
      return
    }
    if (message.kind === 'malformed') {
      this.#reportMalformed(message)
      return
    }
    const pending = this.#take(message.id)
    if (pending === undefined) {
      this.#onDiagnostic({ kind: 'unmatched-response', id: message.id })
    } else if (message.kind === 'error') {
      pending.reject(new CdpProtocolError(pending.command, message.error))
    } else {
      pending.resolve(message.result)
    }
  }

  #reportMalformed({ problem, id }: MalformedMessage): void {
    this.#onDiagnostic({ kind: 'malformed-message', problem })
    const pending = id === undefined ? undefined : this.#take(id)
    pending?.reject(new CdpInvalidResponseError(pending.command, problem))
  }

  #dispatch({ method, params, sessionId }: IncomingEvent): void {
    let channel = this.#root
    if (sessionId !== undefined) {
      const session = this.#sessions.get(sessionId)
      if (session === undefined) {
        this.#onDiagnostic({ kind: 'unknown-session', sessionId, method })
        return
      }
      channel = session
    }
    if (method === DETACHED_EVENT) this.#detach(params)
    channel.emit(method, params)
  }

  #detach(params: unknown): void {
    const sessionId = isRecord(params) ? params['sessionId'] : undefined
    if (typeof sessionId !== 'string') {
      this.#onDiagnostic({ kind: 'malformed-message', problem: `${DETACHED_EVENT} has no sessionId` })
      return
    }
    const channel = this.#sessions.get(sessionId)
    if (channel === undefined) return
    this.#sessions.delete(sessionId)
    this.#closeChannel(channel, 'the target detached')
  }

  #disconnect(reason: string): void {
    this.#closeReason = reason
    for (const channel of this.#sessions.values()) this.#closeChannel(channel, reason)
    this.#sessions.clear()
    this.#closeChannel(this.#root, reason)
  }

  #closeChannel(channel: Channel, reason: string): void {
    this.#rejectPending(channel, (command, written) => new CdpDisconnectedError(command, { reason, written }))
    channel.close(reason)
  }

  #rejectPending(channel: Channel, error: (command: CommandIdentity, written: boolean) => Error): void {
    for (const [id, pending] of this.#pending) {
      if (pending.command.sessionId !== channel.sessionId) continue
      this.#take(id)
      pending.reject(error(pending.command, pending.outgoing.written))
    }
  }

  #expire(id: number, timeoutMs: number): void {
    const pending = this.#take(id)
    pending?.reject(new CdpTimeoutError(pending.command, { timeoutMs, written: pending.outgoing.written }))
  }

  #abort(id: number): void {
    const pending = this.#take(id)
    pending?.reject(new CdpAbortedError(pending.command, { written: pending.outgoing.written }))
  }

  /** Removes a command for good: it is never written after this, and a late response finds nothing. */
  #take(id: number): PendingCommand | undefined {
    const pending = this.#pending.get(id)
    if (pending === undefined) return undefined
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.stopListening()
    pending.outgoing.withdraw()
    return pending
  }

  #openSession(result: unknown): CdpSession {
    const sessionId = isRecord(result) ? result['sessionId'] : undefined
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new CdpInvalidResponseError({ method: ATTACH_METHOD, sessionId: undefined }, 'the result has no sessionId')
    }
    const channel = this.#createChannel(sessionId)
    this.#sessions.set(sessionId, channel)
    // Registered first, so every waiting command has failed before any other block listener hears of it.
    channel.onBlock((reason) => {
      this.#rejectPending(channel, (command, written) => new CdpBlockedError(command, { reason, written }))
    })
    return new CdpSession(sessionId, channel, (method, params, options) =>
      this.#send(channel, method, params, options, passThrough),
    )
  }

  #createChannel(sessionId: string | undefined): Channel {
    return new Channel(sessionId, (event, error) =>
      this.#onDiagnostic({ kind: 'listener-failed', event, sessionId, error }),
    )
  }
}

function passThrough(result: unknown): unknown {
  return result
}

function assertTimeout(timeoutMs: number): void {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeout) {
    throw new RangeError(`A CDP timeout must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${timeoutMs}`)
  }
}
