import { Listeners } from '../listeners.ts'

type ListenerErrorHandler = (event: string, error: unknown) => void

/**
 * Event listeners, the ending of one CDP session, or of the browser itself when `sessionId` is undefined,
 * and whether its target can answer for now.
 */
export class Channel {
  readonly sessionId: string | undefined
  readonly #onListenerError: ListenerErrorHandler
  readonly #events = new Map<string, Listeners<unknown>>()
  readonly #closeListeners = new Listeners<string>((error) => this.#onListenerError('close', error))
  readonly #blockListeners = new Listeners<string>((error) => this.#onListenerError('block', error))
  #closeReason: string | undefined
  #blockReason: string | undefined

  constructor(sessionId: string | undefined, onListenerError: ListenerErrorHandler) {
    this.sessionId = sessionId
    this.#onListenerError = onListenerError
  }

  get closeReason(): string | undefined {
    return this.#closeReason
  }

  get blockReason(): string | undefined {
    return this.#blockReason
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    let listeners = this.#events.get(method)
    if (listeners === undefined) {
      listeners = new Listeners((error) => this.#onListenerError(method, error))
      this.#events.set(method, listeners)
    }
    return listeners.add(listener)
  }

  onClose(listener: (reason: string) => void): () => void {
    return this.#closeListeners.add(listener)
  }

  onBlock(listener: (reason: string) => void): () => void {
    return this.#blockListeners.add(listener)
  }

  emit(method: string, params: unknown): void {
    this.#events.get(method)?.emit(params)
  }

  /** The first reason stands until `unblock`. */
  block(reason: string): void {
    if (this.#closeReason !== undefined || this.#blockReason !== undefined) return
    this.#blockReason = reason
    this.#blockListeners.emit(reason)
  }

  unblock(): void {
    this.#blockReason = undefined
  }

  close(reason: string): void {
    if (this.#closeReason !== undefined) return
    this.#closeReason = reason
    this.#events.clear()
    this.#blockListeners.clear()
    this.#closeListeners.emit(reason)
    this.#closeListeners.clear()
  }
}
