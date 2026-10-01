import type { Transport } from '../../src/browser/cdp/transport.ts'
import type { Emulation } from '../../src/protocol/emulation.ts'
import { Channel } from '../../src/browser/cdp/channel.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { CdpAbortedError, CdpProtocolError, CdpTimeoutError } from '../../src/browser/cdp/errors.ts'
import { CdpSession } from '../../src/browser/cdp/session.ts'
import { ChromiumPage } from '../../src/browser/page.ts'

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

/** What a scripted page answers: each call into Retest's world by its function, and any other command. */
export type PageScript = {
  call: (functionDeclaration: unknown, params: Record<string, unknown>) => Promise<unknown>
  /** Answers input, which otherwise answers at once. */
  input?: (method: string, params: unknown) => Promise<unknown>
  /** Answers commands other than calls, the world's creation and input. */
  other?: (method: string, params: unknown) => Promise<unknown>
  emulation?: Emulation
}

export type ScriptedPage = ScriptedSession & {
  page: ChromiumPage
  /** The browser begins a navigation of the main frame to `/next`, one that replaces the document unless said otherwise. */
  startNavigating(navigationType?: string, loaderId?: string): void
}

export const mainFrame = 'F1'

const silent: Transport = { listen: () => {}, send: () => ({ written: true, withdraw: () => {} }), close: () => {} }

/** A page over a scripted session, on `http://app.test/start?token=1#top`. */
export function scriptedPage({ call, input, other, emulation }: PageScript): ScriptedPage {
  const scripted = scriptedSession((method, params) => {
    if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 5 })
    if (method.startsWith('Input.')) return input?.(method, params) ?? Promise.resolve({})
    if (method === 'Runtime.callFunctionOn' && isRecord(params)) return call(params['functionDeclaration'], params)
    return other?.(method, params) ?? Promise.reject(new Error(`unexpected ${method}`))
  })
  const connection = new CdpConnection(silent, { timeoutMs: 1000, onDiagnostic: () => {} })
  const options = {
    connection,
    session: scripted.session,
    browserContextId: 'C1',
    baseUrl: 'http://app.test',
    emulation,
    restoredOrigins: [],
    proxyServer: undefined,
    onListenerError: (error: unknown) => {
      throw error
    },
  }
  const page = new ChromiumPage(options, { id: mainFrame, url: 'http://app.test/start?token=1#top' })
  const startNavigating = (navigationType = 'differentDocument', loaderId = 'L2') =>
    scripted.emit('Page.frameStartedNavigating', { frameId: mainFrame, url: 'http://app.test/next?code=1', loaderId, navigationType })
  return { ...scripted, page, startNavigating }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The answer to a call into Retest's world that returned `result`. */
export function value(result: unknown): Promise<unknown> {
  return Promise.resolve({ result: { value: result } })
}

/** The page functions called, in order. */
export function functionsCalled(sent: SentCommand[]): unknown[] {
  return sent.flatMap(({ method, params }) => (method === 'Runtime.callFunctionOn' && isRecord(params) ? [params['functionDeclaration']] : []))
}
