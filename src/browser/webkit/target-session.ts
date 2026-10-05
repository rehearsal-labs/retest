import type { CommandIdentity } from '../cdp/errors.ts'
import type { SendOptions } from '../cdp/session.ts'
import type { AccessibilityReading, AccessibleNode, RoleDoubt } from './accessibility-reading.ts'
import type { WebKitConnection } from './connection.ts'
import type { WebKitInput } from './input-events.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { s } from '../../protocol/schema.ts'
import { maxTimeout } from '../../protocol/timeouts.ts'
import { Channel } from '../cdp/channel.ts'
import { CdpAbortedError, CdpBlockedError, CdpClosedError, CdpDisconnectedError, CdpProtocolError, CdpTimeoutError } from '../cdp/errors.ts'
import { isRecord } from '../cdp/message.ts'
import { CdpSession } from '../cdp/session.ts'
import { readProtocol } from '../cdp-results.ts'
import { isMissingNode, readAccessibility, StaleDocumentError } from './accessibility-reading.ts'
import { keyInput, mouseInput, textInput } from './input-events.ts'
import { guardInstallScript } from './relay.ts'
import { webKitRolesFor } from './roles.ts'
import { Turns } from './turns.ts'

// Retest's shared page code (`isolated-world.ts`, `accessibility.ts`, `input.ts`, and through them actionability, the
// element queries, the input guard and the checked state) talks to a page through a CDP session. This makes one for a
// WebKit page, whose `send` turns each command that code sends into its WebKit counterpart, and each WebKit answer
// back into the answer and the error class the shared code reads. So the locator rules, the actionability checks and
// the guard are one implementation for both engines, and every protocol difference is here. A command the shared code
// might send that has no counterpart is refused by name.
//
// Worlds: Chrome makes Retest's isolated world on request; WebKit makes the user world named by `Page.createUserWorld`
// in every document itself and tells of each in `Runtime.executionContextCreated`. Context ids are counted per web
// process, so each user world is handed to the shared code under a number of this session's own. A world is gone once
// its frame commits another document or its target is replaced; a call into it is then answered as Chrome answers a
// call into a context that is gone, so the shared code looks again in the new document.

/** The messages Chrome gives a call into a world that has gone, which `isGoneContext` and `neverRan` read. */
export const goneContextMessages = { neverRan: 'Cannot find context with specified id', destroyed: 'Execution context was destroyed.' } as const

/**
 * A user world: its target, its id there, its frame, and, once read, its global object, on which calls are made, and its
 * document's node id. The document is asked for once per world: every `DOM.getDocument` gives every node of the
 * document a new id and makes the ones handed out before it unknown to WebKit.
 */
type World = {
  readonly key: number
  readonly targetId: string
  readonly contextId: number
  readonly frameId: string
  readonly destroyed: AbortController
  global: Promise<string> | undefined
  installed: Promise<boolean> | undefined
  root: Promise<number> | undefined
}

/**
 * One look of the shared role lookup: the world of the document object it made, its object group, the reading that
 * answers every role it asks for, and the element each WebKit node it found became.
 */
type Look = { readonly world: World; readonly group: string | undefined; reading: AccessibilityReading | undefined; readonly elements: Map<number, number> }

/** An element a look found, made an object of the look's world and group while the look held its target's turn. */
type FoundElement = { readonly objectId: string; readonly world: World; readonly group: string | undefined }

/**
 * A look whose reading WebKit lost to the page again and again, until its time ran out: the page kept removing elements
 * while Retest read its accessibility. It never stands for fewer elements than the page holds.
 */
export class LostReadingError extends Error {
  readonly attempts: number
  constructor(command: CommandIdentity, attempts: number, options: { cause: unknown }) {
    super(`${command.method}: the page removed elements while Retest read its accessibility, ${attempts} times, until the look's time ran out`, options)
    this.name = 'LostReadingError'
    this.attempts = attempts
  }
}

export type TargetSessionOptions = {
  connection: WebKitConnection
  pageProxyId: string
  /** The secret that names the relay's private events in this page. */
  secret: string
  /** The user world's name, as `Page.createUserWorld` was given it. */
  worldName: string
  /** Receives errors thrown by listeners. */
  onListenerError: (event: string, error: unknown) => void
}

const contextSchema = s.object({ id: s.number({ integer: true }), type: s.string(), name: s.string(), frameId: s.string() })
// A remote object's value can be any JSON, which no schema names, so it is read on its own: `valueOf`.
const remoteObjectSchema = s.object({
  result: s.object({ type: s.string(), objectId: s.optional(s.string()), description: s.optional(s.string()) }),
  wasThrown: s.optional(s.boolean()),
})
const callSchema = s.object({
  functionDeclaration: s.string(),
  executionContextId: s.number({ integer: true }),
  returnByValue: s.optional(s.boolean()),
  awaitPromise: s.optional(s.boolean()),
})
const evaluateSchema = s.object({ expression: s.string(), contextId: s.number({ integer: true }), objectGroup: s.optional(s.string()) })
const worldRequestSchema = s.object({ frameId: s.string() })
const queryTreeSchema = s.object({ objectId: s.string(), role: s.string() })
const resolveSchema = s.object({ backendNodeId: s.number({ integer: true }), executionContextId: s.number({ integer: true }), objectGroup: s.optional(s.string()) })
const groupSchema = s.object({ objectGroup: s.string() })
const documentSchema = s.object({ root: s.object({ nodeId: s.number({ integer: true }) }) })
const resolvedSchema = s.object({ object: s.object({ objectId: s.string() }) })

// Making each element an object waits on the page, so a look with many matches makes them in batches.
const resolveBatch = 100
// What a page call no command budgets may take, such as setting up a world that every command shares; no caller waits
// on it longer than its own budget.
const sharedCallMs = maxTimeout

/** A WebKit page as the shared CDP code sees it. */
export class WebKitTargetSession {
  readonly session: CdpSession
  readonly #connection: WebKitConnection
  readonly #pageProxyId: string
  readonly #secret: string
  readonly #worldName: string
  readonly #channel: Channel
  readonly #worlds = new Map<number, World>()
  // The latest user world of each frame of each target, by `targetId frameId`.
  readonly #latest = new Map<string, World>()
  // Objects the role lookup made in a world, each with its object group.
  readonly #objects = new Map<string, { world: World; group: string | undefined }>()
  readonly #looks = new Map<string, Look>()
  readonly #elements = new Map<number, FoundElement>()
  readonly #turns = new Map<string, Turns>()
  readonly #doubtListeners = new Set<(doubt: RoleDoubt) => void>()
  readonly #arrivals = new Set<() => void>()
  #lifecycle = new AbortController()
  #targetId: string | undefined
  #mainFrame: { targetId: string; frameId: string } | undefined
  #nextKey = 1
  #nextElement = 1
  #readings = 0

  constructor(options: TargetSessionOptions) {
    this.#connection = options.connection
    this.#pageProxyId = options.pageProxyId
    this.#secret = options.secret
    this.#worldName = options.worldName
    this.#channel = new Channel(`webkit page ${options.pageProxyId}`, options.onListenerError)
    this.session = new CdpSession(`webkit page ${options.pageProxyId}`, this.#channel, (method, params, sendOptions) => this.#send(method, params, sendOptions))
  }

  /** The committed page target, which page commands go to. */
  get targetId(): string | undefined {
    return this.#targetId
  }

  /** Set once the page closed, crashed or lost its browser. */
  get closeReason(): string | undefined {
    return this.#channel.closeReason
  }

  /** Set while a dialog or a crash holds the page. */
  get blockReason(): string | undefined {
    return this.#channel.blockReason
  }

  /** The page's committed target is now `targetId`: every world of an earlier target went with it. */
  committed(targetId: string): void {
    this.#targetId = targetId
    for (const world of [...this.#worlds.values()]) if (world.targetId !== targetId) this.#destroy(world)
    this.#wakeArrivals()
  }

  /**
   * The page's main frame on `targetId` is now `frameId`, as its latest commit names it. Retest's world is always the
   * main frame's, so a frame the target no longer has as its main frame takes its worlds with it.
   */
  mainFrame(targetId: string, frameId: string): void {
    this.#mainFrame = { targetId, frameId }
    for (const world of [...this.#worlds.values()]) if (world.targetId === targetId && world.frameId !== frameId) this.#destroy(world)
    this.#wakeArrivals()
  }

  /** A target of the page ended. Its worlds went with it. */
  targetGone(targetId: string): void {
    for (const world of [...this.#worlds.values()]) if (world.targetId === targetId) this.#destroy(world)
    if (this.#targetId === targetId) this.#targetId = undefined
    this.#turns.delete(targetId)
  }

  /**
   * Hears each doubt a reading of this page's documents reports from now on: a lookup WebKit's tree cannot answer as
   * Chrome's does on the document it read. Returns the function that stops listening.
   */
  watchDoubts(listener: (doubt: RoleDoubt) => void): () => void {
    this.#doubtListeners.add(listener)
    return () => {
      this.#doubtListeners.delete(listener)
    }
  }

  /**
   * A target told of a new execution context. A user world of Retest's name is set up at once: the relay and the guard
   * go into it before the shared code can call it, and it replaces the frame's earlier world.
   */
  contextCreated(targetId: string, params: unknown): void {
    const context = readProtocol(s.object({ context: contextSchema }), params, { method: 'Runtime.executionContextCreated' }).context
    if (context.type !== 'user' || context.name !== this.#worldName) return
    const key = `${targetId} ${context.frameId}`
    const earlier = this.#latest.get(key)
    if (earlier !== undefined) this.#destroy(earlier)
    const world: World = { key: this.#nextKey, targetId, contextId: context.id, frameId: context.frameId, destroyed: new AbortController(), global: undefined, installed: undefined, root: undefined }
    this.#nextKey += 1
    this.#worlds.set(world.key, world)
    this.#latest.set(key, world)
    this.#install(world).catch(() => {
      // A world whose document went before the guard arrived is never handed out; the next one is set up the same way.
    })
    this.#wakeArrivals()
  }

  /**
   * Stops waiting on a page that cannot answer, such as one a dialog holds: every command waiting on it fails at once,
   * and so does every command sent before `unblock`.
   */
  block(reason: string): void {
    this.#channel.block(reason)
    this.#lifecycle.abort()
  }

  unblock(): void {
    if (this.#channel.closeReason !== undefined) return
    this.#channel.unblock()
    if (this.#lifecycle.signal.aborted) this.#lifecycle = new AbortController()
  }

  /** Ends the session for good: every waiting command fails with the reason, and no command is sent again. */
  close(reason: string): void {
    this.#channel.close(reason)
    this.#lifecycle.abort()
    for (const world of [...this.#worlds.values()]) this.#destroy(world)
  }

  async #send(method: string, params: object | undefined, options: SendOptions | undefined): Promise<unknown> {
    const command = { method, sessionId: this.session.id }
    this.#refuseIfStopped(command)
    switch (method) {
      case 'Page.createIsolatedWorld':
        readProtocol(worldRequestSchema, params, command)
        return { executionContextId: (await this.#currentWorld(command, options)).key }
      case 'Runtime.callFunctionOn':
        return this.#call(command, params, options)
      case 'Runtime.evaluate':
        return this.#evaluate(command, params, options)
      case 'Runtime.releaseObjectGroup':
        return this.#releaseGroup(command, params, options)
      case 'Accessibility.queryAXTree':
        return this.#queryTree(command, params, options)
      case 'DOM.resolveNode':
        return this.#resolveNode(command, params, options)
      case 'Input.dispatchMouseEvent':
        return this.#input(command, mouseInput(params), options)
      case 'Input.dispatchKeyEvent':
        return this.#input(command, keyInput(params), options)
      case 'Input.insertText':
        return this.#input(command, textInput(params), options)
      case 'Page.reload':
      case 'Page.goBack':
      case 'Page.goForward':
        return this.#toCommitted(command, method, options)
      default:
        throw new CdpProtocolError(command, { code: -32601, message: `${method} has no WebKit counterpart in Retest's WebKit driver`, data: undefined })
    }
  }

  // The world of the document the main frame holds now, set up, or once one is. Whatever frame the shared code names, it
  // means the main frame, whose id a process swap changes.
  async #currentWorld(command: CommandIdentity, options: SendOptions | undefined): Promise<World> {
    const deadline = callDeadline(options)
    for (;;) {
      this.#refuseIfStopped(command)
      const targetId = this.#targetId
      const frame = this.#mainFrame
      const world = targetId === undefined || frame === undefined || frame.targetId !== targetId ? undefined : this.#latest.get(`${targetId} ${frame.frameId}`)
      if (world !== undefined && !world.destroyed.signal.aborted) {
        try {
          await withinCall(this.#install(world), deadline, command)
        } catch (error) {
          // A world whose document went before the guard arrived is replaced by the next document's; any other failure
          // to set it up, the caller's own time running out among them, is the answer.
          if (!world.destroyed.signal.aborted && !isGoneWorld(error)) throw error
          this.#destroy(world)
          continue
        }
        if (!world.destroyed.signal.aborted) return world
        continue
      }
      if (deadline.expired) throw new CdpTimeoutError(command, { timeoutMs: deadline.budgetMs, written: false })
      await this.#nextArrival(deadline.remainingMs, deadline.signal, command)
    }
  }

  // Waits for a new world, the page's end or block, the caller's stop, or the time it has left.
  async #nextArrival(timeoutMs: number | undefined, signal: AbortSignal | undefined, command: CommandIdentity): Promise<void> {
    const lifecycle = this.#lifecycle.signal
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        clearTimeout(timer)
        this.#arrivals.delete(arrive)
        signal?.removeEventListener('abort', stop)
        lifecycle.removeEventListener('abort', ended)
      }
      const arrive = (): void => {
        done()
        resolve()
      }
      const stop = (): void => {
        done()
        reject(new CdpAbortedError(command, { written: false }))
      }
      const ended = (): void => {
        done()
        resolve()
      }
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        done()
        reject(new CdpTimeoutError(command, { timeoutMs, written: false }))
      }, timeoutMs)
      this.#arrivals.add(arrive)
      if (signal?.aborted === true) return stop()
      signal?.addEventListener('abort', stop, { once: true })
      lifecycle.addEventListener('abort', ended, { once: true })
    })
  }

  // The relay and the guard go in once per world; a world whose document went first is answered as gone. Every caller
  // shares the one installation and waits for it no longer than its own budget; one that failed is tried again by the
  // next caller.
  #install(world: World): Promise<boolean> {
    const existing = world.installed
    if (existing !== undefined) return existing
    const installing = (async () => {
      const params = { expression: guardInstallScript(this.#secret), contextId: world.contextId, returnByValue: true }
      const result = await this.#connection.sendToTarget(this.#pageProxyId, world.targetId, 'Runtime.evaluate', params, { timeoutMs: sharedCallMs, signal: world.destroyed.signal })
      const { result: value, wasThrown } = readProtocol(remoteObjectSchema, result, { method: 'Runtime.evaluate' })
      if (wasThrown === true) throw new Error(`Retest's guard could not be set up in the page: ${value.description ?? 'no description'}`)
      return valueOf(result) === true
    })()
    world.installed = installing
    installing.catch(() => {
      if (world.installed === installing) world.installed = undefined
    })
    return installing
  }

  async #call(command: CommandIdentity, params: object | undefined, options: SendOptions | undefined): Promise<unknown> {
    const call = readProtocol(callSchema, params, command)
    const world = this.#liveWorld(call.executionContextId, command)
    const deadline = callDeadline(options)
    const objectId = await this.#global(world, command, deadline)
    // The arguments go as the shared code made them: JSON values, and objects made in this same world.
    const args = isRecord(params) && Array.isArray(params['arguments']) ? params['arguments'] : []
    const sent = { objectId, functionDeclaration: call.functionDeclaration, arguments: args, returnByValue: call.returnByValue ?? false, awaitPromise: call.awaitPromise ?? false }
    const answer = await this.#toTarget(command, world.targetId, 'Runtime.callFunctionOn', sent, sendWithin(deadline, command), world)
    return chromeAnswer(answer, command)
  }

  // Chrome's `Runtime.evaluate` in a context, which the role lookup sends to make the document an object of the world.
  async #evaluate(command: CommandIdentity, params: object | undefined, options: SendOptions | undefined): Promise<unknown> {
    const evaluate = readProtocol(evaluateSchema, params, command)
    const world = this.#liveWorld(evaluate.contextId, command)
    const group = evaluate.objectGroup === undefined ? {} : { objectGroup: evaluate.objectGroup }
    const answer = await this.#toTarget(command, world.targetId, 'Runtime.evaluate', { expression: evaluate.expression, contextId: world.contextId, ...group }, options, world)
    const { result, wasThrown } = readProtocol(remoteObjectSchema, answer, command)
    if (wasThrown === true) return { result, exceptionDetails: { text: result.description ?? 'the expression threw', exception: { description: result.description } } }
    if (result.objectId !== undefined) this.#objects.set(result.objectId, { world, group: evaluate.objectGroup })
    return { result }
  }

  async #releaseGroup(command: CommandIdentity, params: object | undefined, options: SendOptions | undefined): Promise<unknown> {
    const { objectGroup } = readProtocol(groupSchema, params, command)
    for (const [objectId, object] of [...this.#objects]) {
      if (object.group !== objectGroup) continue
      this.#objects.delete(objectId)
      this.#looks.delete(objectId)
    }
    for (const [key, element] of [...this.#elements]) if (element.group === objectGroup) this.#elements.delete(key)
    const targetId = this.#targetId
    if (targetId === undefined) return {}
    return this.#toTarget(command, targetId, 'Runtime.releaseObjectGroup', { objectGroup }, options, undefined)
  }

  // Chrome's tree query, answered from WebKit's own accessibility of every element of the world's document: the nodes
  // with a role the asked role means, each with WebKit's computed name. An element with no accessibility object, such as
  // one not rendered, and one WebKit ignores, such as one under aria-hidden, is left out, as Chrome's tree leaves them.
  //
  // WebKit's node ids are numbers in a map of its own, and a node the page removes leaves it, so the whole look, from the
  // reading to making each element it found an object, holds its target's turn: no other look reads the document in
  // between, and every element is an object before the shared code sees it. The shared code is handed a key of the
  // bridge's own for each, which `DOM.resolveNode` answers with that object. A node WebKit no longer knows is never read
  // as an element that is not there: the whole document is read again, within the look's one budget, and a look that
  // keeps losing it until its time runs out ends as `LostReadingError`, never as fewer elements.
  async #queryTree(command: CommandIdentity, params: object | undefined, options: SendOptions | undefined): Promise<unknown> {
    const { objectId, role } = readProtocol(queryTreeSchema, params, command)
    const object = this.#objects.get(objectId)
    if (object === undefined || object.world.destroyed.signal.aborted) throw goneContext(command, 'neverRan')
    const { world } = object
    const deadline = callDeadline(options)
    let look = this.#looks.get(objectId)
    if (look === undefined) {
      look = { world, group: object.group, reading: undefined, elements: new Map() }
      this.#looks.set(objectId, look)
    }
    const release = await this.#turnOf(world, deadline, command, options)
    try {
      return await this.#answerQuery(command, look, webKitRolesFor(role), deadline)
    } finally {
      release()
    }
  }

  async #turnOf(world: World, deadline: Deadline, command: CommandIdentity, options: SendOptions | undefined): Promise<() => void> {
    let turns = this.#turns.get(world.targetId)
    if (turns === undefined) {
      turns = new Turns()
      this.#turns.set(world.targetId, turns)
    }
    const waiting = new Deadline(deadline.remainingMs, { signal: AbortSignal.any([this.#lifecycle.signal, world.destroyed.signal, ...(deadline.signal === undefined ? [] : [deadline.signal])]) })
    try {
      return await turns.take(waiting, command)
    } catch (error) {
      throw this.#translate(error, command, options, world)
    }
  }

  async #answerQuery(command: CommandIdentity, look: Look, roles: readonly string[], deadline: Deadline): Promise<unknown> {
    let lost = 0
    for (;;) {
      try {
        look.reading ??= await this.#read(command, look, deadline)
        const found = look.reading.nodes.filter((node) => roles.includes(node.role))
        const keys = await this.#elementsOf(command, look, found, deadline)
        return { nodes: found.map((node, index) => ({ ignored: false, name: { value: node.label }, backendDOMNodeId: keys[index] })) }
      } catch (error) {
        const stale = error instanceof StaleDocumentError
        if (!stale && !(error instanceof CdpProtocolError && isMissingNode(error.protocolMessage))) {
          if (lost > 0 && error instanceof CdpTimeoutError) throw new LostReadingError(command, lost, { cause: error })
          throw error
        }
        lost += 1
        look.reading = undefined
        // A document WebKit no longer knows by its node id is asked for again, and every node with it.
        if (stale) {
          look.world.root = undefined
          look.elements.clear()
        }
        if (deadline.expired) throw new LostReadingError(command, lost, { cause: error })
      }
    }
  }

  async #read(command: CommandIdentity, look: Look, deadline: Deadline): Promise<AccessibilityReading> {
    const { world } = look
    const send = (method: string, params?: object) => this.#toTarget(command, world.targetId, method, params, sendWithin(deadline, command), world)
    world.root ??= send('DOM.getDocument').then((answer) => readProtocol(documentSchema, answer, command).root.nodeId)
    const root = world.root
    root.catch(() => {
      if (world.root === root) world.root = undefined
    })
    this.#readings += 1
    const reading = await readAccessibility({ send, root: await root, contextId: world.contextId, objectGroup: `retest-webkit-reading-${this.#readings}` }, command)
    for (const doubt of reading.doubts) for (const listener of [...this.#doubtListeners]) listener(doubt)
    return reading
  }

  // Each element the look found becomes an object of its world and group, once per look, and is handed out by a key.
  async #elementsOf(command: CommandIdentity, look: Look, found: readonly AccessibleNode[], deadline: Deadline): Promise<number[]> {
    const { world, group } = look
    const objectGroup = group === undefined ? {} : { objectGroup: group }
    const keys: number[] = []
    for (let start = 0; start < found.length; start += resolveBatch) {
      keys.push(...(await Promise.all(found.slice(start, start + resolveBatch).map(async ({ nodeId }) => {
        const known = look.elements.get(nodeId)
        if (known !== undefined) return known
        const params = { nodeId, executionContextId: world.contextId, ...objectGroup }
        const answer = await this.#toTarget(command, world.targetId, 'DOM.resolveNode', params, sendWithin(deadline, command), world)
        const key = this.#nextElement
        this.#nextElement += 1
        this.#elements.set(key, { objectId: readProtocol(resolvedSchema, answer, command).object.objectId, world, group })
        look.elements.set(nodeId, key)
        return key
      }))))
    }
    return keys
  }

  // A key a look handed out, answered with the object it made. A key the bridge no longer holds, as one of a world that
  // went, sends the shared code to look again rather than leave an element out.
  async #resolveNode(command: CommandIdentity, params: object | undefined, _options: SendOptions | undefined): Promise<unknown> {
    const resolve = readProtocol(resolveSchema, params, command)
    const world = this.#liveWorld(resolve.executionContextId, command)
    const element = this.#elements.get(resolve.backendNodeId)
    if (element === undefined || element.world !== world || element.world.destroyed.signal.aborted) throw goneContext(command, 'neverRan')
    return { object: { type: 'object', objectId: element.objectId } }
  }

  // The selection again and the input itself share the input's one budget; input whose time has run out is never sent.
  async #input(command: CommandIdentity, input: WebKitInput, options: SendOptions | undefined): Promise<unknown> {
    const deadline = callDeadline(options)
    if (input.method === 'Page.insertText' || (input.method === 'Input.dispatchKeyEvent' && input.params['type'] === 'keyDown')) await this.#reselectFill(deadline)
    const within = sendWithin(deadline, command)
    if (input.to === 'page proxy') return this.#guarded(command, (signal) => this.#connection.sendToPageProxy(this.#pageProxyId, input.method, input.params, { ...timeoutOf(within), signal }), within, undefined)
    const targetId = this.#targetId
    if (targetId === undefined) throw new CdpClosedError(command, 'the page has no document to type into')
    return this.#toTarget(command, targetId, input.method, input.params, within, undefined)
  }

  // The shared guard selects a fill's whole value again when the typing's beforeinput arrives, since the page may have
  // moved the caret since Retest selected it. WebKit fixes where the text goes before that event, so for a fill the
  // field is selected again here, just before its text or key goes. A press is armed as one, and is left alone.
  async #reselectFill(deadline: Deadline): Promise<void> {
    const targetId = this.#targetId
    const frame = this.#mainFrame
    const world = targetId === undefined || frame === undefined ? undefined : this.#latest.get(`${targetId} ${frame.frameId}`)
    if (world === undefined || world.destroyed.signal.aborted || deadline.expired) return
    const expression = '(() => { const armed = globalThis.retestGuard?.armed; if (armed !== null && armed !== undefined && armed.action === "fill") armed.element.select() })()'
    const command = { method: 'Runtime.evaluate', sessionId: this.session.id }
    const options = { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal }
    await this.#toTarget(command, world.targetId, 'Runtime.evaluate', { expression, contextId: world.contextId, returnByValue: true }, options, world).catch(() => {
      // A field whose document went takes no text, and one whose time ran out is answered by the input's own send; the
      // guard answers for what happens to the input.
    })
  }

  /**
   * Sends one of Retest's own WebKit commands to a page target, such as `Page.snapshotRect`, failing at once while the
   * page is held or gone, and as the CDP session would when it is held or lost meanwhile.
   */
  target(targetId: string, method: string, params: object | undefined, options: SendOptions): Promise<unknown> {
    const command = { method, sessionId: this.session.id }
    this.#refuseIfStopped(command)
    return this.#toTarget(command, targetId, method, params, options, undefined)
  }

  /** Sends one of Retest's own WebKit commands to the page proxy, as `target` sends one to a target. */
  proxy(method: string, params: object | undefined, options: SendOptions): Promise<unknown> {
    const command = { method, sessionId: this.session.id }
    this.#refuseIfStopped(command)
    return this.#guarded(command, (signal) => this.#connection.sendToPageProxy(this.#pageProxyId, method, params, { ...timeoutOf(options), signal }), options, undefined)
  }

  #toCommitted(command: CommandIdentity, method: string, options: SendOptions | undefined): Promise<unknown> {
    const targetId = this.#targetId
    if (targetId === undefined) throw new CdpClosedError(command, 'the page has no document')
    return this.#toTarget(command, targetId, method, {}, options, undefined)
  }

  #toTarget(command: CommandIdentity, targetId: string, method: string, params: object | undefined, options: SendOptions | undefined, world: World | undefined): Promise<unknown> {
    return this.#guarded(command, (signal) => this.#connection.sendToTarget(this.#pageProxyId, targetId, method, params, { ...timeoutOf(options), signal }), options, world)
  }

  // Sends with a signal that the caller's stop, the page's end or block, and the world's end all abort, and answers each
  // of those as the CDP session would.
  async #guarded(command: CommandIdentity, send: (signal: AbortSignal) => Promise<unknown>, options: SendOptions | undefined, world: World | undefined): Promise<unknown> {
    const signals = [this.#lifecycle.signal, ...(options?.signal === undefined ? [] : [options.signal]), ...(world === undefined ? [] : [world.destroyed.signal])]
    try {
      return await send(AbortSignal.any(signals))
    } catch (error) {
      throw this.#translate(error, command, options, world)
    }
  }

  #translate(error: unknown, command: CommandIdentity, options: SendOptions | undefined, world: World | undefined): unknown {
    if (error instanceof CdpAbortedError) {
      if (options?.signal?.aborted === true) return new CdpAbortedError(command, { written: error.written })
      const closed = this.#channel.closeReason
      if (closed !== undefined) return new CdpDisconnectedError(command, { reason: closed, written: error.written })
      const blocked = this.#channel.blockReason
      if (blocked !== undefined) return new CdpBlockedError(command, { reason: blocked, written: error.written })
      if (world?.destroyed.signal.aborted === true) return goneContext(command, error.written ? 'destroyed' : 'neverRan')
      return error
    }
    if (error instanceof CdpProtocolError && isMissingContext(error.protocolMessage)) return goneContext(command, 'neverRan', error.protocolMessage)
    // A wrapper the page proxy refused never reached a target that went, as one a navigation replaced does.
    if (error instanceof CdpClosedError && world !== undefined && this.#channel.closeReason === undefined && this.#connection.closeReason === undefined) {
      return goneContext(command, 'neverRan', error.reason)
    }
    return error
  }

  #liveWorld(key: number, command: CommandIdentity): World {
    const world = this.#worlds.get(key)
    if (world === undefined || world.destroyed.signal.aborted || world.targetId !== this.#targetId) throw goneContext(command, 'neverRan')
    return world
  }

  // The world's global object is read once and shared; each call waits for it no longer than its own budget.
  async #global(world: World, command: CommandIdentity, deadline: Deadline): Promise<string> {
    world.global ??= this.#toTarget(command, world.targetId, 'Runtime.evaluate', { expression: 'globalThis', contextId: world.contextId }, { timeoutMs: sharedCallMs }, world).then((answer) => {
      const objectId = readProtocol(remoteObjectSchema, answer, command).result.objectId
      if (objectId === undefined) throw new CdpProtocolError(command, { code: -32000, message: goneContextMessages.neverRan, data: 'the user world has no global object' })
      return objectId
    })
    const global = world.global
    global.catch(() => {
      if (world.global === global) world.global = undefined
    })
    return withinCall(global, deadline, command)
  }

  #destroy(world: World): void {
    world.destroyed.abort()
    this.#worlds.delete(world.key)
    const key = `${world.targetId} ${world.frameId}`
    if (this.#latest.get(key) === world) this.#latest.delete(key)
    for (const [objectId, object] of [...this.#objects]) {
      if (object.world !== world) continue
      this.#objects.delete(objectId)
      this.#looks.delete(objectId)
    }
    for (const [key, element] of [...this.#elements]) if (element.world === world) this.#elements.delete(key)
  }

  #wakeArrivals(): void {
    for (const arrive of [...this.#arrivals]) arrive()
  }

  #refuseIfStopped(command: CommandIdentity): void {
    const closed = this.#channel.closeReason
    if (closed !== undefined) throw new CdpClosedError(command, closed)
    const blocked = this.#channel.blockReason
    if (blocked !== undefined) throw new CdpBlockedError(command, { reason: blocked, written: false })
  }
}

// WebKit answers a call with the remote object and whether it was thrown; Chrome with the value, or the exception's
// details, which is what `IsolatedWorld` reads.
function chromeAnswer(answer: unknown, command: CommandIdentity): unknown {
  const { result, wasThrown } = readProtocol(remoteObjectSchema, answer, command)
  if (wasThrown === true) return { result: { value: undefined }, exceptionDetails: { text: result.description ?? 'the page script threw', exception: { description: result.description ?? 'no description' } } }
  return { result: { value: valueOf(answer) } }
}

function valueOf(answer: unknown): unknown {
  const result = isRecord(answer) ? answer['result'] : undefined
  return isRecord(result) ? result['value'] : undefined
}

function goneContext(command: CommandIdentity, kind: keyof typeof goneContextMessages, said?: string): CdpProtocolError {
  return new CdpProtocolError(command, { code: -32000, message: goneContextMessages[kind], data: said })
}

// An answer that says the world's document went: WebKit's own words, or the wrapper of a target that went.
function isGoneWorld(error: unknown): boolean {
  return (error instanceof CdpProtocolError && isMissingContext(error.protocolMessage)) || error instanceof CdpClosedError || error instanceof CdpAbortedError
}

// WebKit's words for a call into a world, or on an object, whose document has gone.
function isMissingContext(message: string): boolean {
  return /^Missing injected script for given (executionContextId|objectId)/.test(message)
}

function timeoutOf(options: SendOptions | undefined): { timeoutMs?: number } {
  return options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }
}

// The budget of one call the shared code sent, from its own timeout and signal, which every page call it makes shares.
function callDeadline(options: SendOptions | undefined): Deadline {
  return new Deadline(options?.timeoutMs ?? sharedCallMs, { signal: options?.signal })
}

// What one page call of a budgeted call may take: what is left of the budget. Nothing is sent once none is left.
function sendWithin(deadline: Deadline, command: CommandIdentity): SendOptions {
  if (deadline.expired) throw new CdpTimeoutError(command, { timeoutMs: deadline.budgetMs, written: false })
  return { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal }
}

// Waits for work other calls share no longer than this call's budget and signal allow; the work itself goes on.
async function withinCall<T>(work: Promise<T>, deadline: Deadline, command: CommandIdentity): Promise<T> {
  const { signal } = deadline
  if (signal?.aborted === true) throw new CdpAbortedError(command, { written: false })
  return new Promise<T>((resolve, reject) => {
    const settle = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
    }
    const stop = (): void => {
      settle()
      reject(new CdpAbortedError(command, { written: false }))
    }
    const timer = setTimeout(() => {
      settle()
      reject(new CdpTimeoutError(command, { timeoutMs: deadline.budgetMs, written: false }))
    }, deadline.commandTimeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
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
