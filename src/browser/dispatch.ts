import type { CdpSession } from './cdp/session.ts'
import type { Deadline } from '../protocol/deadline.ts'
import {
  CdpAbortedError,
  CdpBlockedError,
  CdpClosedError,
  CdpDisconnectedError,
  CdpPendingLimitError,
  CdpTimeoutError,
} from './cdp/errors.ts'
import { sendOptions } from './cdp-results.ts'
import { neverRan } from './isolated-world.ts'

/**
 * Records whether a command's effect may have reached the page. Before that, a lost connection loses nothing;
 * after it, nobody can tell whether the action happened, and it is never sent again.
 */
export class Dispatch {
  #sent = false

  get sent(): boolean {
    return this.#sent
  }

  /**
   * Sends a command that makes the action happen, such as a mouse press or `Page.navigate`. Once the deadline's
   * signal has aborted, nothing more is sent, and a command still queued is withdrawn.
   */
  async send(session: CdpSession, method: string, params: object, deadline: Deadline): Promise<unknown> {
    try {
      const result = await session.send(method, params, sendOptions(deadline))
      this.#sent = true
      return result
    } catch (error) {
      if (mayHaveArrived(error)) this.#sent = true
      throw error
    }
  }

  /**
   * Sends, through `send`'s own dispatch, a command whose answer says whether it made the action happen, such as a
   * page call that checks the element again and acts only when every check passes. An answer that says it did not
   * leaves `sent` as it was. A command that got no answer may have.
   *
   * @example const readiness = await dispatch.attempt((attempt) => world.callIn(context, source, args, schema, deadline, attempt), (answer) => answer.status === 'selected')
   */
  async attempt<T>(send: (attempt: Dispatch) => Promise<T>, happened: (answer: T) => boolean): Promise<T> {
    const attempt = new Dispatch()
    try {
      const answer = await send(attempt)
      if (happened(answer)) this.#sent = true
      return answer
    } catch (error) {
      if (attempt.sent) this.#sent = true
      throw error
    }
  }
}

function mayHaveArrived(error: unknown): boolean {
  if (
    error instanceof CdpDisconnectedError ||
    error instanceof CdpTimeoutError ||
    error instanceof CdpBlockedError ||
    error instanceof CdpAbortedError
  ) {
    return error.written
  }
  return !(error instanceof CdpClosedError || error instanceof CdpPendingLimitError || neverRan(error))
}
