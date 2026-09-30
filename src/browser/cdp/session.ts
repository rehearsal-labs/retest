import type { Channel } from './channel.ts'

/** `signal` stops waiting for the answer, and withdraws the command if it has not been written yet. */
export type SendOptions = { timeoutMs?: number; signal?: AbortSignal | undefined }

export type SendCommand = (method: string, params: object | undefined, options: SendOptions | undefined) => Promise<unknown>

/** A flat CDP session attached to one target. Commands and events carry its `sessionId`. */
export class CdpSession {
  readonly id: string
  readonly #channel: Channel
  readonly #send: SendCommand

  constructor(id: string, channel: Channel, send: SendCommand) {
    this.id = id
    this.#channel = channel
    this.#send = send
  }

  /** Set once the target detached or the connection ended. */
  get detachReason(): string | undefined {
    return this.#channel.closeReason
  }

  /** Set while the session is blocked. */
  get blockReason(): string | undefined {
    return this.#channel.blockReason
  }

  /**
   * Sends a command to this session's target and resolves with its unvalidated result.
   * @example await session.send('Page.navigate', { url: 'http://127.0.0.1:4173/' })
   */
  send(method: string, params?: object, options?: SendOptions): Promise<unknown> {
    return this.#send(method, params, options)
  }

  /**
   * Listens for an event on this session and returns a function that stops listening.
   * @example const stop = session.on('Page.loadEventFired', () => {})
   */
  on(method: string, listener: (params: unknown) => void): () => void {
    return this.#channel.on(method, listener)
  }

  /** Listens for the end of this session, whether the target detached or the connection ended. */
  onDetach(listener: (reason: string) => void): () => void {
    return this.#channel.onClose(listener)
  }

  /**
   * Stops waiting on a target that cannot answer, such as one that crashed or that a JavaScript dialog
   * holds. Every command waiting on this session fails at once with a `CdpBlockedError` that names the
   * reason, and so does every command sent before `unblock`, since a deadline would only hide the reason.
   *
   * @example session.block('the page opened an alert dialog')
   */
  block(reason: string): void {
    this.#channel.block(reason)
  }

  /** Sends commands again, for a target that can answer once more. */
  unblock(): void {
    this.#channel.unblock()
  }

  /** Listens for the session being blocked, as work that waits on events rather than commands must. */
  onBlock(listener: (reason: string) => void): () => void {
    return this.#channel.onBlock(listener)
  }
}
