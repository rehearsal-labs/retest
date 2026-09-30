import { Channel } from '../../src/browser/cdp/channel.ts'
import { CdpAbortedError, CdpProtocolError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { CdpSession } from '../../src/browser/cdp/session.ts'

export type SentCommand = { method: string; params: unknown }

export type ScriptedSession = {
  session: CdpSession
  sent: SentCommand[]
  /** Delivers an event to the session's listeners, as the browser would. */
  emit(method: string, params: unknown): void
}

const sessionId = 'S1'

/**
 * A CDP session whose commands `answer` settles. Each command still fails with a `CdpTimeoutError` once its
 * own timeout passes, and with a `CdpAbortedError` once its signal aborts, as it would against a browser. A
 * command whose signal had already aborted is not sent.
 */
export function scriptedSession(answer: (method: string, params: unknown) => Promise<unknown>): ScriptedSession {
  const channel = new Channel(sessionId, (event, error) => {
    throw new Error(`a listener for ${event} failed`, { cause: error })
  })
  const sent: SentCommand[] = []
  const session = new CdpSession(sessionId, channel, async (method, params, options) => {
    const command = { method, sessionId }
    const signal = options?.signal
    if (signal?.aborted === true) throw new CdpAbortedError(command, { written: false })
    sent.push({ method, params })
    const reply = answer(method, params)
    const timeoutMs = options?.timeoutMs
    return new Promise((resolve, reject) => {
      const end = (): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const abort = (): void => {
        end()
        reject(new CdpAbortedError(command, { written: true }))
      }
      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              end()
              reject(new CdpTimeoutError(command, { timeoutMs, written: true }))
            }, timeoutMs)
      signal?.addEventListener('abort', abort, { once: true })
      reply.then(
        (result) => {
          end()
          resolve(result)
        },
        (error: unknown) => {
          end()
          reject(error)
        },
      )
    })
  })
  return { session, sent, emit: (method, params) => channel.emit(method, params) }
}

/** The error Chrome answers a command with, such as a call into a document that has gone. */
export function protocolError(method: string, message: string): CdpProtocolError {
  return new CdpProtocolError({ method, sessionId }, { code: -32000, message, data: undefined })
}

/** A reply that never comes, for a command that only its timeout ends. */
export function never(): Promise<unknown> {
  return new Promise(() => {})
}

export function count(sent: SentCommand[], method: string): number {
  return sent.filter((command) => command.method === method).length
}
