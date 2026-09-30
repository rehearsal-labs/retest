import type { CommandIdentity } from './cdp/errors.ts'
import type { CdpSession } from './cdp/session.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Schema } from '../protocol/schema.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { s } from '../protocol/schema.ts'
import { CdpAbortedError, CdpProtocolError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'

/** A value a page function returned, and the execution context of the document it ran in. */
export type InDocument<T> = { value: T; context: number }

type Creation = { readonly promise: Promise<number>; context: number | undefined }

const worldName = 'retest'
const retryPauseMs = 10

// What Chrome answers when a call reaches a world whose document has gone.
const goneContextMessages = new Set([
  'Cannot find context with specified id',
  'Execution context was destroyed.',
  'No frame for given id found',
])

const worldSchema = s.object({ executionContextId: s.number({ integer: true }) })
const scriptSchema = s.object({ identifier: s.string() })
const exceptionSchema = s.object({
  exceptionDetails: s.optional(
    s.object({ text: s.string(), exception: s.optional(s.object({ description: s.optional(s.string()) })) }),
  ),
})

/** Retest's own JavaScript world in the page's main frame, made again for each new document. */
export class IsolatedWorld {
  readonly #session: CdpSession
  readonly #frameId: () => string
  #creation: Creation | undefined

  constructor(session: CdpSession, frameId: () => string) {
    this.#session = session
    this.#frameId = frameId
  }

  /** Forgets the world, for a document that replaced the one it was made in. */
  reset(): void {
    this.#creation = undefined
  }

  /** Runs `source` in the world of every document the page opens from now on, before the page's own scripts. */
  async addScript(source: string, deadline: Deadline): Promise<void> {
    const params = { source, worldName }
    await request(this.#session, 'Page.addScriptToEvaluateOnNewDocument', params, scriptSchema, sendOptions(deadline))
  }

  /**
   * Calls a function in the world with JSON arguments and validates what it returns. A document that
   * goes away during the call is not an answer, so the call runs again in the next document's world.
   */
  async call<T>(functionDeclaration: string, args: readonly unknown[], schema: Schema<T>, deadline: Deadline): Promise<T> {
    return (await this.enter(functionDeclaration, args, schema, deadline)).value
  }

  /** Like `call`, and also names the context it ran in, so that `callIn` can stay in that document. */
  async enter<T>(functionDeclaration: string, args: readonly unknown[], schema: Schema<T>, deadline: Deadline): Promise<InDocument<T>> {
    for (;;) {
      const context = await this.#context(deadline)
      try {
        return { value: await this.callIn(context, functionDeclaration, args, schema, deadline), context }
      } catch (error) {
        if (!isGoneContext(error)) throw error
        if (this.#creation?.context === context) this.#creation = undefined
        await this.#pause(deadline)
      }
    }
  }

  /** Calls a function in the world of one document. Once that document has gone the call fails, and never moves on. */
  async callIn<T>(
    context: number,
    functionDeclaration: string,
    args: readonly unknown[],
    schema: Schema<T>,
    deadline: Deadline,
  ): Promise<T> {
    const params = {
      functionDeclaration,
      executionContextId: context,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
      awaitPromise: true,
    }
    const raw = await this.#session.send('Runtime.callFunctionOn', params, sendOptions(deadline))
    const source = callIdentity(this.#session)
    const { exceptionDetails } = readProtocol(exceptionSchema, raw, source)
    if (exceptionDetails !== undefined) {
      throw new Error(`Retest's page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
    }
    return readProtocol(s.object({ result: s.object({ value: schema }) }), raw, source).result.value
  }

  // Every call that needs the current document's world waits for one creation, but none past its own deadline.
  async #context(deadline: Deadline): Promise<number> {
    for (;;) {
      this.#creation ??= this.#create(deadline)
      const identity = { method: 'Page.createIsolatedWorld', sessionId: this.#session.id }
      try {
        return await beforeDeadline(this.#creation.promise, deadline, identity)
      } catch (error) {
        // Another call's shorter deadline, or a document that went away, ended the creation; this call may still have time.
        if (!(error instanceof CdpTimeoutError) && !isGoneContext(error)) throw error
        await this.#pause(deadline)
      }
    }
  }

  // Shared by every call waiting for this document's world, so no single caller's signal can stop it.
  #create(deadline: Deadline): Creation {
    const params = { frameId: this.#frameId(), worldName }
    const world = request(this.#session, 'Page.createIsolatedWorld', params, worldSchema, { timeoutMs: deadline.commandTimeoutMs })
    const creation: Creation = { promise: world.then(({ executionContextId }) => executionContextId), context: undefined }
    creation.promise.then(
      (context) => {
        creation.context = context
      },
      () => {
        if (this.#creation === creation) this.#creation = undefined
      },
    )
    return creation
  }

  async #pause(deadline: Deadline): Promise<void> {
    if (deadline.expired) throw new CdpTimeoutError(callIdentity(this.#session), { timeoutMs: deadline.budgetMs, written: true })
    await sleep(Math.min(retryPauseMs, deadline.remainingMs), undefined, { signal: deadline.signal })
  }
}

/** True for the answer Chrome gives a call into a world whose document has gone. */
export function isGoneContext(error: unknown): boolean {
  return error instanceof CdpProtocolError && goneContextMessages.has(error.protocolMessage)
}

function beforeDeadline<T>(work: Promise<T>, deadline: Deadline, command: CommandIdentity): Promise<T> {
  const { signal } = deadline
  if (signal?.aborted === true) return Promise.reject(new CdpAbortedError(command, { written: true }))
  return new Promise((resolve, reject) => {
    const timeoutMs = deadline.commandTimeoutMs
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      settle()
      reject(new CdpAbortedError(command, { written: true }))
    }
    const timer = setTimeout(() => {
      settle()
      reject(new CdpTimeoutError(command, { timeoutMs, written: true }))
    }, timeoutMs)
    signal?.addEventListener('abort', abort, { once: true })
    work.then(
      (value) => {
        settle()
        resolve(value)
      },
      (error: unknown) => {
        settle()
        reject(error)
      },
    )
  })
}

function callIdentity(session: CdpSession): CommandIdentity {
  return { method: 'Runtime.callFunctionOn', sessionId: session.id }
}
