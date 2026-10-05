import type { BidiClient } from './bidi-client.ts'
import type { Lookup } from './accessible-names.ts'
import type { SendOptions } from '../cdp/session.ts'
import type { LocatorRecipe } from '../../protocol/locator.ts'
import type { Infer } from '../../protocol/schema.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Deadline } from '../../protocol/deadline.ts'
import { isPlainObject, s } from '../../protocol/schema.ts'
import { BrowserError } from '../browser-error.ts'
import { Channel } from '../cdp/channel.ts'
import { CdpSession } from '../cdp/session.ts'
import {
  CdpAbortedError,
  CdpBlockedError,
  CdpClosedError,
  CdpDisconnectedError,
  CdpInvalidResponseError,
  CdpPendingLimitError,
  CdpProtocolError,
  CdpTimeoutError,
} from '../cdp/errors.ts'
import { ariaRoleOf, lookupRefusal, namedElements, roleWantsOf } from './accessible-names.ts'
import { wrapped } from './sandbox.ts'
import {
  BidiAbortedError,
  BidiClosedError,
  BidiDisconnectedError,
  BidiInvalidResponseError,
  BidiPendingLimitError,
  BidiProtocolError,
  BidiTimeoutError,
} from './bidi-errors.ts'

// The page functions Retest shares between engines run in its own world, through `IsolatedWorld` and the element,
// actionability, guard and selection helpers built on it, which speak a handful of DevTools methods. This bridge
// answers exactly those over WebDriver BiDi, so Firefox runs the same page code and the same rules, and the protocol
// difference stays here:
//
// - `Page.createIsolatedWorld`: the realm of sandbox `retest` in the tab's current document, numbered.
// - `Runtime.callFunctionOn`: `script.callFunction` in that realm. JSON values travel as one JSON string and elements as
//   BiDi shared references, and the answer comes back as JSON, so nothing depends on BiDi's value serialization.
// - `Runtime.releaseObjectGroup`: nothing; shared references need no release.
// - `Runtime.evaluate` of `document`, `Accessibility.queryAXTree` and `DOM.resolveNode`: the elements of a role with
//   the names Firefox computed (`accessible-names.ts`), handed over as shared references.
//
// A method named the BiDi way, such as `input.performActions`, goes to Firefox as it is, so a command's input is
// counted by the same `Dispatch` as on Chromium. Any other method is refused by name.

const documentObject = 'retest-document'
// A realm gone before the call reached it, or a shared reference from a document that went, never ran: Chrome's own
// answer for that is what `isGoneContext` and `neverRan` read.
const neverRanMessage = 'Cannot find context with specified id'
const destroyedMessage = 'Execution context was destroyed.'
const bidiMethod = /^[a-z][A-Za-z]*\.[a-z][A-Za-z]*$/
// How long a call in a realm that went may still be answered: Firefox sends the answer and the realm's end within a few
// milliseconds of each other, in either order.
const realmGoneGraceMs = 250
// The budget of an accessibility query the shared helpers send without one, which they never do today.
const queryBudgetMs = 10_000

const realmSchema = s.object({ realm: s.string() })
const callSchema = s.object({
  type: s.enum(['success', 'exception']),
  result: s.optional(s.object({ type: s.string(), value: s.optional(s.string()) })),
  exceptionDetails: s.optional(s.object({ text: s.string() })),
})

/** A page function call's arguments as one JSON plan: each a JSON value, or the index of an element reference. */
type PlanEntry = { v: unknown } | { e: number }

/** A call the shared helpers make: the function, the world it runs in, and its arguments, values or element references. */
type FunctionCall = { functionDeclaration: string; executionContextId: number; arguments: readonly ({ value: unknown } | { objectId: string })[] }

export type BridgeOptions = {
  client: BidiClient
  /** The tab's browsing context. */
  context: string
  /** Receives errors thrown by listeners of the bridge's channel. */
  onListenerError: (event: string, error: unknown) => void
}

/**
 * A DevTools-shaped session over one Firefox tab, for the page helpers Retest shares with Chromium. Its channel ends
 * or blocks the session as Chromium's does: a page that is lost closes it, and a prompt the page opened blocks it, so
 * every waiting call fails at once with the reason.
 */
export class FirefoxBridge {
  readonly session: CdpSession
  readonly channel: Channel
  readonly #client: BidiClient
  readonly #context: string
  readonly #realms = new Map<number, string>()
  readonly #nodes = new Map<number, string>()
  readonly #nodeIds = new Map<string, number>()
  readonly #waiting = new Set<(reason: string) => void>()
  // Firefox never answers a call whose realm went while it ran, so each call waiting in a realm, or on a realm still to
  // be made for the tab, is failed when Firefox tells of that realm's end, after a grace: a call that settled as its
  // document went, such as the guard's verdict on a click that submits a form, is answered a moment either side of it.
  readonly #inRealms = new Set<{ realm: string | undefined; fail: (error: Error) => void; timer?: NodeJS.Timeout }>()
  readonly #realmContexts = new Map<string, string>()
  // The page functions on their way, by id, and whether each has told it waits in the page (`wrapped` says how).
  readonly #calls = new Map<string, boolean>()
  readonly #callWaiters = new Set<() => void>()
  readonly #startedChannel: string
  #nextCall = 1
  readonly #stops: (() => void)[] = []
  #nextRealm = 1
  #nextNode = 1
  // The locator each resolution looks up, and the names it asks of each role, travel with that resolution's own calls,
  // never in a field the page's looks share: two looks at the same page run at once, and each accessibility query must
  // answer, and refuse, its own locator.
  readonly #lookups = new AsyncLocalStorage<Lookup | undefined>()

  constructor(options: BridgeOptions) {
    this.#client = options.client
    this.#context = options.context
    const id = `firefox:${options.context}`
    this.#startedChannel = `retest-started-${options.context}`
    this.channel = new Channel(id, options.onListenerError)
    this.session = new CdpSession(id, this.channel, (method, params, sendOptions) => this.#send(method, params ?? {}, sendOptions ?? {}))
    this.channel.onBlock((reason) => {
      for (const reject of [...this.#waiting]) reject(reason)
    })
    this.channel.onClose((reason) => {
      for (const reject of [...this.#waiting]) reject(reason)
    })
    this.#stops.push(
      this.#client.on('script.realmCreated', (params) => {
        const context = Reflect.get(Object(params), 'context')
        const realm = Reflect.get(Object(params), 'realm')
        if (typeof context === 'string' && typeof realm === 'string') this.#realmContexts.set(realm, context)
      }),
      this.#client.on('script.realmDestroyed', (params) => {
        const realm = Reflect.get(Object(params), 'realm')
        if (typeof realm === 'string') this.#realmDestroyed(realm)
      }),
      this.#client.on('script.message', (params) => {
        if (Reflect.get(Object(params), 'channel') !== this.#startedChannel) return
        const call = Reflect.get(Object(Reflect.get(Object(params), 'data')), 'value')
        if (typeof call !== 'string' || !this.#calls.has(call)) return
        this.#calls.set(call, true)
        this.#wakeCallWaiters()
      }),
    )
  }

  /**
   * Settles once every page function on its way has told it waits in the page, or has ended, or after `timeoutMs`.
   * Firefox runs the commands it is sent in no fixed order, so input sent right after a call that is to hear of it, as
   * the guard's verdict is, could otherwise reach the page first, and the call reach a document the input replaced.
   */
  callsStarted(timeoutMs: number): Promise<void> {
    if (this.#allStarted()) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        if (!this.#allStarted()) return
        clearTimeout(timer)
        this.#callWaiters.delete(done)
        resolve()
      }
      const timer = setTimeout(() => {
        this.#callWaiters.delete(done)
        resolve()
      }, timeoutMs)
      this.#callWaiters.add(done)
    })
  }

  /** Stops hearing realm events, for a tab that is gone. */
  dispose(): void {
    for (const stop of this.#stops.splice(0)) stop()
  }

  /**
   * Runs `work`, which resolves `locator`, with the locator and the names its role and label steps ask for known to the
   * accessibility queries `work` makes, and to no other: a role asked only for exact names costs one Firefox match for
   * each, and a lookup Firefox cannot answer as Chrome does is refused by name. One no page could make exact is refused
   * before anything is sent.
   */
  async resolving<T>(locator: LocatorRecipe | undefined, work: () => Promise<T>): Promise<T> {
    return this.resolvingAll(locator === undefined ? [] : [locator], work)
  }

  /**
   * `resolving` for several locators that `work` resolves in one call, as a keyed read does: each is refused as one look
   * would refuse it, and their role and label steps are known together to the accessibility queries `work` makes.
   */
  async resolvingAll<T>(locators: readonly LocatorRecipe[], work: () => Promise<T>): Promise<T> {
    for (const locator of locators) {
      const refused = lookupRefusal(locator)
      if (refused !== undefined) throw new BrowserError(refused)
    }
    return this.#lookups.run(locators.length === 0 ? undefined : { locators, wants: roleWantsOf(locators) }, work)
  }

  /** Forgets the element references and realms of documents the tab no longer holds. */
  forgetDocument(): void {
    this.#nodes.clear()
    this.#nodeIds.clear()
    this.#realms.clear()
  }

  async #send(method: string, params: object, options: SendOptions): Promise<unknown> {
    const command = { method, sessionId: this.session.id }
    const closed = this.channel.closeReason
    if (closed !== undefined) throw new CdpClosedError(command, closed)
    const blocked = this.channel.blockReason
    if (blocked !== undefined) throw new CdpBlockedError(command, { reason: blocked, written: false })
    const { promise, resolve, reject } = Promise.withResolvers<unknown>()
    const stop = (reason: string): void => {
      const lost = this.channel.closeReason !== undefined
      reject(lost ? new CdpDisconnectedError(command, { reason, written: true }) : new CdpBlockedError(command, { reason, written: true }))
    }
    this.#waiting.add(stop)
    this.#answer(method, params, options).then(resolve, (error: unknown) => reject(cdpError(method, this.session.id, error)))
    try {
      return await promise
    } finally {
      this.#waiting.delete(stop)
    }
  }

  async #answer(method: string, params: object, options: SendOptions): Promise<unknown> {
    const sending = { timeoutMs: options.timeoutMs, signal: options.signal }
    switch (method) {
      case 'Page.createIsolatedWorld':
        return this.#createWorld(stringField(params, 'frameId', method), stringField(params, 'worldName', method), sending)
      case 'Runtime.callFunctionOn':
        return this.#callFunction(functionCall(params), sending)
      case 'Runtime.releaseObjectGroup':
        return {}
      case 'Runtime.evaluate': {
        const expression = stringField(params, 'expression', method)
        if (expression !== 'document') throw new Error(`The Firefox driver evaluates only the document for an accessibility query, not ${JSON.stringify(expression)}.`)
        return { result: { objectId: documentObject } }
      }
      case 'Accessibility.queryAXTree':
        return this.#queryTree(stringField(params, 'role', method), sending)
      case 'DOM.resolveNode': {
        const backendNodeId = numberField(params, 'backendNodeId', method)
        const sharedId = this.#nodes.get(backendNodeId)
        if (sharedId === undefined) throw new CdpProtocolError({ method, sessionId: this.session.id }, { code: -32000, message: 'No node with given id found', data: undefined })
        return { object: { objectId: sharedId } }
      }
      default:
        if (bidiMethod.test(method)) return this.#client.send(method, params, { ...sending, keepErrorMessage: method === 'browsingContext.navigate' })
        throw new Error(`The Firefox driver does not answer the DevTools method ${method}.`)
    }
  }

  async #createWorld(frameId: string, worldName: string, options: Sending): Promise<unknown> {
    const params = { functionDeclaration: '() => 0', arguments: [], target: { context: frameId, sandbox: worldName }, awaitPromise: false, resultOwnership: 'none' }
    const { realm } = await this.#inRealm(undefined, () => this.#client.request('script.callFunction', params, realmSchema, { ...options, keepErrorMessage: true }))
    const id = this.#nextRealm
    this.#nextRealm += 1
    this.#realms.set(id, realm)
    return { executionContextId: id }
  }

  async #callFunction(call: FunctionCall, options: Sending): Promise<unknown> {
    const realm = this.#realms.get(call.executionContextId)
    if (realm === undefined) throw new CdpProtocolError({ method: 'Runtime.callFunctionOn', sessionId: this.session.id }, { code: -32000, message: neverRanMessage, data: undefined })
    const references: { sharedId: string }[] = []
    const plan: PlanEntry[] = call.arguments.map((argument) => {
      if ('objectId' in argument) {
        references.push({ sharedId: argument.objectId })
        return { e: references.length - 1 }
      }
      return { v: argument.value }
    })
    const id = String(this.#nextCall)
    this.#nextCall += 1
    const started = { type: 'channel', value: { channel: this.#startedChannel, ownership: 'none' } }
    const params = {
      functionDeclaration: wrapped(call.functionDeclaration),
      arguments: [{ type: 'string', value: JSON.stringify(plan) }, { type: 'string', value: id }, started, ...references],
      target: { realm },
      awaitPromise: true,
      resultOwnership: 'none',
    }
    this.#calls.set(id, false)
    let answer: Infer<typeof callSchema>
    try {
      answer = await this.#inRealm(realm, () => this.#client.request('script.callFunction', params, callSchema, { ...options, keepErrorMessage: true }))
    } finally {
      this.#calls.delete(id)
      this.#wakeCallWaiters()
    }
    if (answer.type === 'exception') return { exceptionDetails: { text: answer.exceptionDetails?.text ?? 'the page script threw' } }
    const text = answer.result?.value
    if (text === undefined) throw new CdpInvalidResponseError({ method: 'Runtime.callFunctionOn', sessionId: this.session.id }, 'the page function answered no JSON')
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && 'v' in parsed ? { result: { value: parsed.v } } : { result: {} }
  }

  async #queryTree(role: string, options: Sending): Promise<unknown> {
    const aria = ariaRoleOf(role)
    if (aria === undefined) return { nodes: [] }
    // One deadline for every round trip the query takes, so a look of many confirmations answers within its own budget.
    const deadline = new Deadline(options.timeoutMs ?? queryBudgetMs, { signal: options.signal })
    const named = await namedElements({ client: this.#client, context: this.#context, deadline }, aria, this.#lookups.getStore())
    return { nodes: named.map(({ sharedId, name }) => ({ ignored: false, name: { value: name }, backendDOMNodeId: this.#nodeId(sharedId) })) }
  }

  // A call in `realm`, or with no realm yet when it makes the tab's world, raced against that realm's end.
  async #inRealm<T>(realm: string | undefined, call: () => Promise<T>): Promise<T> {
    const { promise, reject } = Promise.withResolvers<never>()
    const entry: { realm: string | undefined; fail: (error: Error) => void; timer?: NodeJS.Timeout } = { realm, fail: reject }
    this.#inRealms.add(entry)
    try {
      return await Promise.race([call(), promise])
    } finally {
      clearTimeout(entry.timer)
      this.#inRealms.delete(entry)
    }
  }

  #realmDestroyed(realm: string): void {
    const context = this.#realmContexts.get(realm)
    this.#realmContexts.delete(realm)
    const sessionId = this.session.id
    for (const entry of [...this.#inRealms]) {
      let error: Error | undefined
      if (entry.realm === realm) error = new CdpProtocolError({ method: 'Runtime.callFunctionOn', sessionId }, { code: -32000, message: destroyedMessage, data: undefined })
      else if (entry.realm === undefined && context === this.#context) error = new CdpProtocolError({ method: 'Page.createIsolatedWorld', sessionId }, { code: -32000, message: neverRanMessage, data: undefined })
      if (error === undefined || entry.timer !== undefined) continue
      const failure = error
      entry.timer = setTimeout(() => entry.fail(failure), realmGoneGraceMs)
    }
  }

  #allStarted(): boolean {
    for (const started of this.#calls.values()) if (!started) return false
    return true
  }

  #wakeCallWaiters(): void {
    for (const wake of [...this.#callWaiters]) wake()
  }

  #nodeId(sharedId: string): number {
    const known = this.#nodeIds.get(sharedId)
    if (known !== undefined) return known
    const id = this.#nextNode
    this.#nextNode += 1
    this.#nodes.set(id, sharedId)
    this.#nodeIds.set(sharedId, id)
    return id
  }
}

type Sending = { timeoutMs: number | undefined; signal: AbortSignal | undefined }

// The parameters come from Retest's own helpers; one that is not as they always send it is a fault of Retest's.
function stringField(params: object, key: string, method: string): string {
  const value: unknown = Reflect.get(params, key)
  if (typeof value !== 'string') throw new TypeError(`${method} was sent without a string ${key}.`)
  return value
}

function numberField(params: object, key: string, method: string): number {
  const value: unknown = Reflect.get(params, key)
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new TypeError(`${method} was sent without a whole number ${key}.`)
  return value
}

function functionCall(params: object): FunctionCall {
  const method = 'Runtime.callFunctionOn'
  const given: unknown = Reflect.get(params, 'arguments') ?? []
  if (!Array.isArray(given)) throw new TypeError(`${method} was sent arguments that are not a list.`)
  const args = given.map((argument: unknown): { value: unknown } | { objectId: string } => {
    if (!isPlainObject(argument)) throw new TypeError(`${method} was sent an argument that is not an object.`)
    const objectId = argument['objectId']
    if (typeof objectId === 'string') return { objectId }
    return { value: argument['value'] }
  })
  return { functionDeclaration: stringField(params, 'functionDeclaration', method), executionContextId: numberField(params, 'executionContextId', method), arguments: args }
}

/**
 * Turns an error from the BiDi client into the DevTools error the shared helpers read, keeping whether the command was
 * written. A protocol error keeps only its error code: Firefox quotes a command's arguments in its own message. A
 * realm or element reference that is gone is Chrome's answer for a context that is gone.
 */
export function cdpError(method: string, sessionId: string, error: unknown): unknown {
  const command = { method, sessionId }
  if (error instanceof BidiTimeoutError) return new CdpTimeoutError(command, { timeoutMs: error.timeoutMs, written: error.written })
  if (error instanceof BidiAbortedError) return new CdpAbortedError(command, { written: error.written })
  if (error instanceof BidiDisconnectedError) return new CdpDisconnectedError(command, { reason: error.reason, written: error.written })
  if (error instanceof BidiClosedError) return new CdpClosedError(command, error.reason)
  if (error instanceof BidiPendingLimitError) return new CdpPendingLimitError(command, error.limit)
  if (error instanceof BidiInvalidResponseError) return new CdpInvalidResponseError(command, error.problem)
  if (error instanceof BidiProtocolError) return new CdpProtocolError(command, { code: -32000, message: protocolMessage(method, error), data: undefined })
  return error
}

function protocolMessage(method: string, error: BidiProtocolError): string {
  const inWorld = method === 'Runtime.callFunctionOn' || method === 'Page.createIsolatedWorld'
  if (inWorld && (error.error === 'no such frame' || error.error === 'no such node' || error.error === 'no such handle')) return neverRanMessage
  // A call whose document went while it ran is answered with an error about the window's actor going away.
  if (inWorld && error.error === 'unknown error' && /destroyed|AbortError|discarded|unloaded/i.test(error.protocolMessage ?? '')) return destroyedMessage
  // Firefox names why it refused a navigation, such as a blocked port, in a message of its own words alone.
  const refused = method === 'browsingContext.navigate' && error.error === 'unknown error' ? /^Error: ([A-Za-z]+)$/.exec(error.protocolMessage ?? '')?.[1] : undefined
  if (refused !== undefined) return `unknown error: ${refused}`
  return error.error
}
