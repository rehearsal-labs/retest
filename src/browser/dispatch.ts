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
  return !(error instanceof CdpClosedError || error instanceof CdpPendingLimitError)
}
