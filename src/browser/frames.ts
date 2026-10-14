import type { PendingNavigation } from './actionability.ts'
import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { BrowserCommand } from './contract.ts'
import type { DocumentFacts } from './document-facts.ts'
import type { Dispatch } from './dispatch.ts'
import type { Check, FramedWorld, PointerThrough, Prepared, Readiness, ReadyReadiness } from './element-queries.ts'
import type { Point } from './input.ts'
import type { Guard } from './input-guard.ts'
import type { InDocument, PageWorld, WorldArgument, WorldArguments } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { Failure } from '../protocol/failures.ts'
import type { EmptyStep, FrameRecipe, LocatorRecipe } from '../protocol/locator.ts'
import type { Schema } from '../protocol/schema.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeEmptyStep, describeFrames, describeLocator, describeStep, emptyStepSchema, frameLocator, locatorSteps, sameFramePath } from '../protocol/locator.ts'
import { errorMessage } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { CdpClosedError, CdpDisconnectedError, CdpProtocolError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { documentFactsSchema } from './document-facts.ts'
import { letGo } from './input-guard.ts'
import { IsolatedWorld, isGoneContext, worldName } from './isolated-world.ts'
import { locatorArguments } from './locate.ts'
import { changeBinding, changeScript, frameElementFunction, frameHiddenFunction, frameShownFunction, guardScript, pageFactsFunction, placeFunction } from './page-scripts.ts'

// A frame is found again from the page for every call, by the element of each frame on its path, in the document of
// the frame before: the browser names the frame that element holds (`DOM.describeNode`), and Retest's world in that
// frame's document runs the call. A frame of the page's own process is reached through the page's session. A frame of
// another site runs in a process of its own, a target the page's session attaches to (`Target.setAutoAttach`, flat
// sessions, iframes only), and is reached through that target's session. Retest asks to attach the first time a test
// looks into a frame, and holds each new frame target until its session carries Retest's guard and change scripts, as a
// page does, so the guard is in the frame's first document. Input is never sent to a frame's session: the page's own
// session dispatches it at the point in its viewport, and the browser routes it to the frame there, as it does a
// person's mouse and keyboard.
// What Retest keeps of a document or a frame goes with it: a document's number with its execution context, a frame's
// world and navigation with the frame, and all of a session's with the session, so a page that opens and closes frames
// all day keeps no more than the frames it holds.

/** What the frames of one page need of it: its connection, its own session and world, its main frame, and its changes. */
export type PageFramesOptions = {
  readonly connection: CdpConnection
  /** The page's own session, which reaches the frames of its process and dispatches all input. */
  readonly session: CdpSession
  /** Retest's world in the page's own document. */
  readonly world: PageWorld
  readonly mainFrameId: () => string
  /** Told each time a document of a frame in another process changes, as the page's own documents tell it. */
  readonly onChange: () => void
  /** Takes on the session of a frame in another process as Retest sets it up, before the frame runs, as the page's file pickers do. */
  readonly follow: (session: CdpSession, options: { timeoutMs: number }) => Promise<void>
}

/**
 * One document Retest has entered: its session, its world's execution context there, and in `frame` the id of the
 * frame it is in, for a document inside a frame; the page's own document has none.
 */
type FrameDocument = { readonly session: CdpSession; readonly frame: string | undefined; readonly context: number; readonly world: IsolatedWorld }

/**
 * A frame on a locator's path as Retest reached it: the document around its element, the element's recipe, its place,
 * the id of the frame the element holds, and whether the element is shown in its document.
 */
type FrameLevel = { readonly parent: FrameDocument; readonly locator: LocatorRecipe; readonly place: number; readonly frame: string; readonly shown: boolean }

/** Why a frame's element could not be used, as the page function that looked for it answers. */
type FrameLookup =
  | { status: 'missing'; empty: EmptyStep | null }
  | { status: 'ambiguous'; count: number }
  | { status: 'element'; element: string }
  | { status: 'invalid'; step: number; message: string }

const lookupSchema: Schema<FrameLookup> = s.discriminatedUnion('status', [
  s.object({ status: s.literal('missing'), empty: s.nullable(emptyStepSchema) }),
  s.object({ status: s.literal('ambiguous'), count: s.number({ integer: true, min: 2 }) }),
  s.object({ status: s.literal('element'), element: s.string() }),
  s.object({ status: s.literal('invalid'), step: s.number({ integer: true, min: 0 }), message: s.string() }),
])

const placeChecks = ['visible', 'attached', 'stable', 'in-view', 'hit-target'] as const

const placedSchema = s.union([
  s.object({ status: s.literal('placed'), point: s.object({ x: s.number(), y: s.number() }), scale: s.number({ min: 0 }), token: s.nullable(s.number({ integer: true, min: 1 })) }),
  s.object({ status: s.literal('blocked'), check: s.enum(placeChecks), detail: s.nullable(s.string()) }),
  lookupSchema,
])

const elementAnswerSchema = s.object({
  result: s.object({ type: s.string(), value: s.optional(s.string()), objectId: s.optional(s.string()) }),
  exceptionDetails: s.optional(s.object({ text: s.string(), exception: s.optional(s.object({ description: s.optional(s.string()) })) })),
})
const describedSchema = s.object({ node: s.object({ frameId: s.optional(s.string()) }) })
const shownSchema = s.object({ result: s.object({ value: s.boolean() }) })
const worldSchema = s.object({ executionContextId: s.number({ integer: true }) })
const attachedSchema = s.object({ sessionId: s.string(), targetInfo: s.object({ targetId: s.string(), type: s.string() }), waitingForDebugger: s.boolean() })
const bindingCalledSchema = s.object({ name: s.string() })
// Chrome marks the context's id as deprecated in this event; one that stops sending it leaves the number to the session's end.
const contextDestroyedSchema = s.object({ executionContextId: s.optional(s.number({ integer: true })) })
const frameIdSchema = s.object({ frameId: s.string() })
const navigatingSchema = s.object({ frameId: s.string(), url: s.string(), navigationType: s.string() })
const navigatedSchema = s.object({ frame: s.object({ id: s.string() }) })

// Navigations that keep the document. Any other replaces it when it commits.
const withinDocument: ReadonlySet<string> = new Set(['sameDocument', 'historySameDocument'])

const autoAttach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }] }
// A frame target's setup runs outside any command, so it has a budget of its own.
const setupMs = 10_000
const retryPauseMs = 10
const goneMessage = 'Execution context was destroyed.'

const ignore = (): void => {}

/**
 * Why a call could not reach a frame: its element was not there, or could not be one. Caught where a look or an action
 * gives it a meaning of its own; anywhere else, `failure` names it for the command it stopped.
 */
export abstract class FrameError extends Error {
  /** The locator whose frame path held the frame. */
  readonly locator: LocatorRecipe

  constructor(locator: LocatorRecipe, message: string) {
    super(message)
    this.locator = locator
  }

  /** The failure of `command`, which the error stopped, and how far its input got. */
  abstract failure(command: string, inputSent: boolean): Failure
}

/** A frame's element that is not there: as an element that is not there, it is waited for, and a look finds nothing. */
export class FrameMissing extends FrameError {
  readonly empty: EmptyStep

  constructor(locator: LocatorRecipe, empty: EmptyStep) {
    super(locator, `A frame of ${describeLocator(locator)} is not there`)
    this.empty = empty
  }

  failure(command: string, inputSent: boolean): Failure {
    if (inputSent) return frameWentAway(command)
    const said = describeEmptyStep(this.locator, this.empty) ?? `${describeLocator(this.locator)} found no frame.`
    return { class: 'not_found', message: `Could not ${command}: ${said}`, details: { frame: this.empty.frame ?? 0 } }
  }
}

/** A frame's element that can never be used as it stands: several, or not a frame, or a selector the page cannot read. */
export class FrameRefused extends FrameError {
  readonly place: number
  readonly lookup: Exclude<FrameLookup, { status: 'missing' }>

  constructor(locator: LocatorRecipe, place: number, lookup: Exclude<FrameLookup, { status: 'missing' }>) {
    super(locator, `A frame of ${describeLocator(locator)} cannot be used`)
    this.place = place
    this.lookup = lookup
  }

  failure(command: string, inputSent: boolean): Failure {
    if (inputSent) return frameWentAway(command)
    const path = this.locator.frame ?? []
    const frame = describeFrames(path.slice(0, this.place + 1), this.locator.dialect).slice(0, -1)
    const { lookup } = this
    switch (lookup.status) {
      case 'ambiguous':
        return {
          class: 'ambiguous',
          message: `Could not ${command}: ${frame} matches ${lookup.count} elements, and a frame's locator must match exactly one. Retest sent nothing.`,
          details: { frame: this.place, count: lookup.count },
        }
      case 'element':
        return {
          class: 'usage',
          message: `Could not ${command}: ${frame} found ${lookup.element}, which is not a frame. frame() takes the locator of an <iframe> or a <frame>.`,
          details: { frame: this.place, element: lookup.element },
        }
      case 'invalid': {
        const step = locatorSteps(path[this.place] ?? this.locator)[lookup.step]
        const selector = step === undefined ? frame : describeStep(step, this.locator.dialect)
        return { class: 'usage', message: `Could not ${command}: the page cannot read the CSS selector in ${selector}, in ${frame}. ${lookup.message}`, details: { selector } }
      }
    }
  }
}

/** A frame of another site whose process Retest could not set up to look into, with the browser's reason. */
export class FrameUnreachable extends FrameError {
  readonly place: number
  readonly reason: string

  constructor(locator: LocatorRecipe, place: number, reason: string) {
    super(locator, `A frame of ${describeLocator(locator)} could not be reached`)
    this.place = place
    this.reason = reason
  }

  failure(command: string, inputSent: boolean): Failure {
    if (inputSent) return frameWentAway(command)
    const frame = describeFrames((this.locator.frame ?? []).slice(0, this.place + 1), this.locator.dialect).slice(0, -1)
    return { class: 'setup_failed', message: `Could not ${command}: Retest could not set up ${frame}, a frame of another site, to look inside it: ${this.reason}.`, details: { frame: this.place, inputSent: false } }
  }
}

/**
 * The frames of one Chromium page. Each locator with a frame path gets a `FrameWorld` here, which finds its frame
 * again for every call. The documents frame worlds enter are numbered here, by session and context, so a later call
 * into the same document, such as the guard's verdict, reaches it through any frame world of the page.
 */
export class PageFrames {
  readonly #options: PageFramesOptions
  // Frames in another process Retest has set up, by frame id, which is their target's id.
  readonly #targets = new Map<string, CdpSession>()
  // The documents frame worlds entered, by number, and each one's number, by session and context.
  readonly #documents = new Map<number, FrameDocument>()
  readonly #numbers = new Map<string, number>()
  // Whether each document was last told its frame is hidden, by number.
  readonly #hidden = new Map<number, boolean>()
  // Retest's world in each frame, by session and frame.
  readonly #worlds = new Map<string, IsolatedWorld>()
  // Frames in another process Retest could not set up, by frame id: the session it tried, with the browser's reason.
  readonly #unready = new Map<string, { session: CdpSession; reason: string }>()
  // Frames whose browser has begun a navigation to another document, by frame id, with the address it is opening.
  readonly #navigating = new Map<string, string>()
  #watching: Promise<void> | undefined
  #calls = 0
  #lastNumber = 0

  constructor(options: PageFramesOptions) {
    this.#options = options
    options.session.on('Target.attachedToTarget', (params) => this.#attached(params))
    this.#track(options.session)
  }

  /** The world of the frame `locator`'s frame path names. */
  world(locator: LocatorRecipe): FrameWorld {
    return new FrameWorld(this, locator)
  }

  /**
   * Finds the frame of `locator`'s path from the page, one frame at a time, and enters Retest's world in its current
   * document: the document and how each frame on the path was reached. A frame whose element is not there throws
   * `FrameMissing`, and one whose element can never be used `FrameRefused`. A frame whose document is not there yet,
   * or went during the search, is looked for again until `deadline`. With `reveal`, each frame's element out of view is
   * scrolled into it, outermost first, as an action needs.
   */
  async enter(locator: LocatorRecipe, reveal: boolean, deadline: Deadline): Promise<{ document: FrameDocument; levels: FrameLevel[] }> {
    await this.#watch(deadline)
    for (;;) {
      const entered = await this.#search(locator, reveal, deadline)
      if (entered !== undefined) return entered
      await pause(deadline)
    }
  }

  /** Calls a function in a document a frame world entered, by the number it gave it. A document that went is gone. */
  async callIn<T>(number: number, functionDeclaration: string, args: WorldArguments, schema: Schema<T>, deadline: Deadline, dispatch?: Dispatch): Promise<T> {
    const document = this.#documents.get(number)
    if (document === undefined) throw gone(this.#options.session)
    return this.inDocument(document, (world) => world.callIn(document.context, functionDeclaration, scoped(args, document), schema, deadline, dispatch))
  }

  /**
   * The number of a document a frame world entered, the same for every call into that document. A number is never
   * given to another document, even once its own has gone.
   */
  number(document: FrameDocument): number {
    const key = documentKey(document.session, document.context)
    const known = this.#numbers.get(key)
    if (known !== undefined) return known
    this.#lastNumber += 1
    this.#numbers.set(key, this.#lastNumber)
    this.#documents.set(this.#lastNumber, document)
    return this.#lastNumber
  }

  /** The navigation the browser has begun in a frame, by the frame's id, or undefined while none is under way. */
  navigation(frameId: string): PendingNavigation | undefined {
    const url = this.#navigating.get(frameId)
    return url === undefined ? undefined : { url }
  }

  /** The page's own address and title, read in its own document. */
  pageFacts(deadline: Deadline): Promise<DocumentFacts> {
    return this.#options.world.call(pageFactsFunction, [], documentFactsSchema, deadline)
  }

  /** Runs `call` in a document, and turns the end of a frame's own session into the document going. */
  async inDocument<T>(document: FrameDocument, call: (world: IsolatedWorld) => Promise<T>): Promise<T> {
    try {
      return await call(document.world)
    } catch (error) {
      if (this.#targetEnded(error, document.session)) throw gone(document.session)
      throw error
    }
  }

  // One search from the page, or undefined when a frame's document was not there to enter. The document found is told
  // whether a frame on the way is hidden, as its looks then read every element hidden.
  async #search(locator: LocatorRecipe, reveal: boolean, deadline: Deadline): Promise<{ document: FrameDocument; levels: FrameLevel[] } | undefined> {
    let document = await this.#documentOf(this.#options.session, this.#options.mainFrameId(), false, deadline)
    const levels: FrameLevel[] = []
    for (const [place, frame] of (locator.frame ?? []).entries()) {
      if (document === undefined) return undefined
      const element = frameLocator(frame, locator)
      const { frameId, shown } = await this.#frameIn(document, element, { locator, place, reveal }, deadline)
      if (frameId === undefined) return undefined
      const unready = this.#unready.get(frameId)
      if (unready !== undefined) throw new FrameUnreachable(locator, place, unready.reason)
      levels.push({ parent: document, locator: element, place, frame: frameId, shown })
      document = await this.#documentOf(this.#targets.get(frameId) ?? document.session, frameId, true, deadline)
    }
    if (document === undefined) return undefined
    const told = await this.#tell(document, levels.some((level) => !level.shown), deadline)
    return told ? { document, levels } : undefined
  }

  // Tells a frame's document whether its frame is hidden, when that changed since it was last told. False when the
  // document went first.
  async #tell(document: FrameDocument, hidden: boolean, deadline: Deadline): Promise<boolean> {
    const number = this.number(document)
    if ((this.#hidden.get(number) ?? false) === hidden) return true
    try {
      await document.world.callIn(document.context, frameHiddenFunction, [hidden], s.boolean(), deadline)
    } catch (error) {
      if (isGoneContext(error) || this.#targetEnded(error, document.session)) return false
      throw error
    }
    this.#hidden.set(number, hidden)
    return true
  }

  // Retest's world in a frame's current document, or undefined while the frame has none, or is not reachable through
  // this session yet, as a frame of another process is before its target is set up.
  async #documentOf(session: CdpSession, frameId: string, framed: boolean, deadline: Deadline): Promise<FrameDocument | undefined> {
    try {
      const { executionContextId } = await request(session, 'Page.createIsolatedWorld', { frameId, worldName }, worldSchema, sendOptions(deadline))
      return { session, frame: framed ? frameId : undefined, context: executionContextId, world: this.#worldOf(session, frameId) }
    } catch (error) {
      if (isGoneContext(error) || this.#targetEnded(error, session)) return undefined
      throw error
    }
  }

  // The frame a frame's element holds, by the id the browser names it with, or undefined when the element holds no
  // document yet, and whether the element is shown in its document. The element is found by a page function that gives
  // the element itself back, as an object of the document's world, which the browser then describes.
  async #frameIn(
    parent: FrameDocument,
    element: LocatorRecipe,
    { locator, place, reveal }: { locator: LocatorRecipe; place: number; reveal: boolean },
    deadline: Deadline,
  ): Promise<{ frameId: string | undefined; shown: boolean }> {
    this.#calls += 1
    const objectGroup = `retest-frame-${this.#calls}`
    const { session, context } = parent
    try {
      return await this.inDocument(parent, async () => {
        const built = locatorArguments(element, [reveal])
        const frame = parent.frame === undefined ? {} : { frame: parent.frame }
        const args: readonly WorldArgument[] = typeof built === 'function' ? await built({ session, context, objectGroup, ...frame }, deadline) : built.map((value) => ({ value }))
        const params = { functionDeclaration: frameElementFunction, executionContextId: context, arguments: args, returnByValue: false, objectGroup }
        const { result, exceptionDetails } = await request(session, 'Runtime.callFunctionOn', params, elementAnswerSchema, sendOptions(deadline))
        if (exceptionDetails !== undefined) throw new Error(`Retest's page script failed: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`)
        if (result.type === 'string') throw lookupError(locator, place, readLookup(result.value, session))
        const { objectId } = result
        if (objectId === undefined) throw new CdpProtocolError({ method: 'Runtime.callFunctionOn', sessionId: session.id }, { code: -32000, message: goneMessage, data: undefined })
        const showing = { functionDeclaration: frameShownFunction, objectId, returnByValue: true }
        const [{ node }, shown] = await Promise.all([
          request(session, 'DOM.describeNode', { objectId }, describedSchema, sendOptions(deadline)),
          request(session, 'Runtime.callFunctionOn', showing, shownSchema, sendOptions(deadline)),
        ])
        return { frameId: node.frameId, shown: shown.result.value }
      })
    } finally {
      session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(ignore)
    }
  }

  // Each session's world object, by frame, for calls into its documents.
  #worldOf(session: CdpSession, frameId: string): IsolatedWorld {
    const key = worldKey(session, frameId)
    const known = this.#worlds.get(key)
    if (known !== undefined) return known
    const world = new IsolatedWorld(session, () => frameId)
    this.#worlds.set(key, world)
    return world
  }

  // Asks the page's session, once, to attach to its frames of other processes. A start that failed is tried again.
  async #watch(deadline: Deadline): Promise<void> {
    const watching = (this.#watching ??= this.#startWatching(this.#options.session, deadline))
    try {
      await watching
    } catch (error) {
      if (this.#watching === watching) this.#watching = undefined
      throw error
    }
  }

  async #startWatching(session: CdpSession, deadline: Deadline): Promise<void> {
    await request(session, 'Target.setAutoAttach', autoAttach, s.object({}), sendOptions(deadline))
  }

  // The session is taken on while its event is handled, so none of its events arrives first.
  #attached(params: unknown): void {
    const { sessionId, targetInfo, waitingForDebugger } = readProtocol(attachedSchema, params, { method: 'Target.attachedToTarget' })
    const session = this.#options.connection.adopt(sessionId)
    void this.#setUp(session, targetInfo.targetId, waitingForDebugger)
  }

  // A frame target gets what a page gets: the guard and the change observer in each new document, the binding the
  // observer calls, the page's file pickers, and the watch for frames of other processes inside it. One already running
  // gets both scripts in its current document too. A held target is let run whatever happens, so the app's frame never
  // stays stopped. A frame comes back under the same id when it opens a document of another site again, so each target
  // is set up afresh, and a frame whose setup failed is refused by name only while that target lasts.
  async #setUp(session: CdpSession, frameId: string, held: boolean): Promise<void> {
    this.#unready.delete(frameId)
    // The frame's navigation committed in this process.
    this.#navigating.delete(frameId)
    session.on('Runtime.bindingCalled', (params) => {
      if (readProtocol(bindingCalledSchema, params, { method: 'Runtime.bindingCalled', sessionId: session.id }).name === changeBinding) this.#options.onChange()
    })
    session.on('Target.attachedToTarget', (params) => this.#attached(params))
    this.#track(session)
    session.onDetach(() => {
      if (this.#targets.get(frameId) === session) this.#targets.delete(frameId)
      if (this.#unready.get(frameId)?.session === session) this.#unready.delete(frameId)
      this.#navigating.delete(frameId)
      this.#forgetSession(session)
    })
    const sent = { timeoutMs: setupMs }
    try {
      await session.send('Page.enable', undefined, sent)
      await session.send('Runtime.enable', undefined, sent)
      await session.send('Runtime.addBinding', { name: changeBinding, executionContextName: worldName }, sent)
      for (const source of [guardScript, changeScript]) await session.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName }, sent)
      await this.#options.follow(session, sent)
      await session.send('Target.setAutoAttach', autoAttach, sent)
      if (!held) {
        const { executionContextId } = await request(session, 'Page.createIsolatedWorld', { frameId, worldName }, worldSchema, sent)
        for (const expression of [guardScript, changeScript]) await session.send('Runtime.evaluate', { expression, contextId: executionContextId }, sent)
      }
      this.#targets.set(frameId, session)
    } catch (error) {
      if (session.detachReason === undefined) this.#unready.set(frameId, { session, reason: errorMessage(error) })
    } finally {
      if (held) session.send('Runtime.runIfWaitingForDebugger', undefined, sent).catch(ignore)
    }
  }

  // Follows a session's documents and frames: what Retest keeps of each goes with it, and a frame's navigation to
  // another document is noted until it commits, stops or the frame goes. The page's own main frame is the page's.
  #track(session: CdpSession): void {
    const source = (method: string) => ({ method, sessionId: session.id })
    session.on('Runtime.executionContextDestroyed', (params) => {
      const { executionContextId } = readProtocol(contextDestroyedSchema, params, source('Runtime.executionContextDestroyed'))
      if (executionContextId !== undefined) this.#forgetDocument(documentKey(session, executionContextId))
    })
    session.on('Runtime.executionContextsCleared', () => this.#forgetDocuments(session))
    session.on('Page.frameDetached', (params) => {
      const { frameId } = readProtocol(frameIdSchema, params, source('Page.frameDetached'))
      this.#worlds.delete(worldKey(session, frameId))
      this.#navigating.delete(frameId)
    })
    session.on('Page.frameStartedNavigating', (params) => {
      const { frameId, url, navigationType } = readProtocol(navigatingSchema, params, source('Page.frameStartedNavigating'))
      if (frameId !== this.#options.mainFrameId() && !withinDocument.has(navigationType)) this.#navigating.set(frameId, url)
    })
    session.on('Page.frameNavigated', (params) => this.#navigating.delete(readProtocol(navigatedSchema, params, source('Page.frameNavigated')).frame.id))
    session.on('Page.frameStoppedLoading', (params) => this.#navigating.delete(readProtocol(frameIdSchema, params, source('Page.frameStoppedLoading')).frameId))
  }

  #forgetDocument(key: string): void {
    const number = this.#numbers.get(key)
    if (number === undefined) return
    this.#numbers.delete(key)
    this.#documents.delete(number)
    this.#hidden.delete(number)
  }

  #forgetDocuments(session: CdpSession): void {
    const prefix = `${session.id}\n`
    for (const key of [...this.#numbers.keys()]) if (key.startsWith(prefix)) this.#forgetDocument(key)
  }

  #forgetSession(session: CdpSession): void {
    this.#forgetDocuments(session)
    const prefix = `${session.id}\n`
    for (const key of [...this.#worlds.keys()]) if (key.startsWith(prefix)) this.#worlds.delete(key)
  }

  // A frame's own session ends with its target while the page goes on: its documents are gone, not the browser.
  #targetEnded(error: unknown, session: CdpSession): boolean {
    const ended = error instanceof CdpClosedError || error instanceof CdpDisconnectedError
    return ended && session !== this.#options.session && this.#options.connection.closeReason === undefined
  }
}

/**
 * Retest's world in the frame a locator's frame path names, found again from the page for every call, as the page's
 * own world is found again in each new document. A call that finds the frame's document gone, as when the frame opened
 * another, finds the frame again and runs there. `callIn` reaches a document this or any frame world of the page
 * entered, by the number `enter` gave it.
 */
export class FrameWorld implements FramedWorld {
  readonly #frames: PageFrames
  readonly #locator: LocatorRecipe
  // How the last call reached the frame, which `place` follows back out to the page.
  #levels: FrameLevel[] = []

  constructor(frames: PageFrames, locator: LocatorRecipe) {
    this.#frames = frames
    this.#locator = locator
  }

  async call<T>(functionDeclaration: string, args: WorldArguments, schema: Schema<T>, deadline: Deadline): Promise<T> {
    return (await this.enter(functionDeclaration, args, schema, deadline)).value
  }

  enter<T>(functionDeclaration: string, args: WorldArguments, schema: Schema<T>, deadline: Deadline): Promise<InDocument<T>> {
    return this.#enter(functionDeclaration, args, schema, false, deadline)
  }

  enterInView<T>(functionDeclaration: string, args: WorldArguments, schema: Schema<T>, deadline: Deadline): Promise<InDocument<T>> {
    return this.#enter(functionDeclaration, args, schema, true, deadline)
  }

  callIn<T>(context: number, functionDeclaration: string, args: WorldArguments, schema: Schema<T>, deadline: Deadline, dispatch?: Dispatch): Promise<T> {
    return this.#frames.callIn(context, functionDeclaration, args, schema, deadline, dispatch)
  }

  missing(error: unknown): EmptyStep | null | undefined {
    return error instanceof FrameMissing && sameFramePath(error.locator.frame, this.#locator.frame) ? error.empty : undefined
  }

  /**
   * Moves a point readied in the frame's document out to the page's viewport, one frame at a time, innermost first: in
   * each document around a frame, its element is found again, checked to be shown, brought into view, checked to stand
   * still, and checked to be the element at the point, so a frame hidden or covered in the page is refused as such an
   * element is. For `pointer` input, each of those documents' guards is armed for the frame's element there, and the
   * look carries them. The scale is the page's own. A frame that fails its checks, or a placing that stops, has every
   * guard the look armed ended, and the look is unready, as for an element.
   */
  async place({ value, context }: InDocument<ReadyReadiness>, pointer: PointerThrough | null, deadline: Deadline): Promise<Prepared> {
    const around: Guard[] = []
    let { point, scale } = value
    let placed = false
    try {
      for (const level of [...this.#levels].reverse()) {
        if (point === null) break
        const at = await this.#placeIn(level, { point, pointer }, deadline)
        if (at.status !== 'placed') return { value: this.#unplaced(at, level), context }
        point = at.point
        scale = at.scale
        if (at.token !== null) around.unshift({ context: this.#frames.number(level.parent), token: at.token })
      }
      placed = true
    } finally {
      if (!placed) await letGo(this, [...(value.token === null ? [] : [{ context, token: value.token }]), ...around])
    }
    return { value: { ...value, point, scale }, context, ...(around.length === 0 ? {} : { around }) }
  }

  /**
   * The navigation the browser has begun in a frame on the path, as the last call found the path, or undefined while
   * none is under way: input then would go to the document the frame opens.
   */
  pendingNavigation(): PendingNavigation | undefined {
    for (const level of this.#levels) {
      const pending = this.#frames.navigation(level.frame)
      if (pending !== undefined) return pending
    }
    return undefined
  }

  pageFacts(deadline: Deadline): Promise<DocumentFacts> {
    return this.#frames.pageFacts(deadline)
  }

  async #enter<T>(functionDeclaration: string, args: WorldArguments, schema: Schema<T>, reveal: boolean, deadline: Deadline): Promise<InDocument<T>> {
    for (;;) {
      const { document, levels } = await this.#frames.enter(this.#locator, reveal, deadline)
      try {
        const value = await this.#frames.inDocument(document, (world) => world.callIn(document.context, functionDeclaration, scoped(args, document), schema, deadline))
        this.#levels = levels
        return { value, context: this.#frames.number(document) }
      } catch (error) {
        if (!isGoneContext(error)) throw error
        await pause(deadline)
      }
    }
  }

  // A document around the frame that went while the point was placed leaves the frame to be found again.
  async #placeIn({ parent, locator }: FrameLevel, { point, pointer }: { point: Point; pointer: PointerThrough | null }, deadline: Deadline): Promise<Placed> {
    try {
      const args = scoped(locatorArguments(locator, [point, pointer]), parent)
      return await this.#frames.inDocument(parent, (world) => world.callIn(parent.context, placeFunction, args, placedSchema, deadline))
    } catch (error) {
      if (!isGoneContext(error)) throw error
      return { status: 'missing', empty: null }
    }
  }

  // Why a frame's element could not take the point, as a look says it: blocked, or missing as the frame's element.
  #unplaced(placed: Exclude<Placed, { status: 'placed' }>, level: FrameLevel): Readiness {
    if (placed.status === 'blocked') return placed
    if (placed.status === 'missing') return { status: 'missing', empty: frameEmpty(level.locator, level.place, placed.empty) }
    throw new FrameRefused(this.#locator, level.place, placed)
  }
}

type Placed =
  | { status: 'placed'; point: Point; scale: number; token: number | null }
  | { status: 'blocked'; check: Extract<Check, (typeof placeChecks)[number]>; detail: string | null }
  | FrameLookup

function lookupError(locator: LocatorRecipe, place: number, lookup: FrameLookup): FrameError {
  if (lookup.status === 'missing') return new FrameMissing(locator, frameEmpty(locator.frame?.[place] ?? locator, place, lookup.empty))
  return new FrameRefused(locator, place, lookup)
}

// The step of a frame's recipe that kept nothing, as a look names it: the step the page named, or its last step, which
// matched no element.
function frameEmpty(frame: FrameRecipe, place: number, empty: EmptyStep | null): EmptyStep {
  if (empty !== null) return { frame: place, step: empty.step, matched: empty.matched }
  return { frame: place, step: locatorSteps(frame).length - 1, matched: 0 }
}

function readLookup(text: string | undefined, session: CdpSession): FrameLookup {
  let value: unknown
  try {
    value = JSON.parse(text ?? '')
  } catch {
    value = undefined
  }
  const read = parse(lookupSchema, value)
  if (!read.ok) throw new Error(`Retest's frame lookup answered what it cannot read, on session ${session.id}`)
  return read.value
}

function frameWentAway(command: string): Failure {
  return {
    class: 'outcome_unknown',
    message: `Retest began to ${command}, then the frame it was in went away, so Retest cannot tell whether that took effect.`,
    details: { inputSent: true },
  }
}

// A call's arguments as they are made in a document: in a frame's, with the frame named, as role lookups there need.
function scoped(args: WorldArguments, document: FrameDocument): WorldArguments {
  const { frame } = document
  if (typeof args !== 'function' || frame === undefined) return args
  return (scope, deadline) => args({ ...scope, frame }, deadline)
}

function documentKey(session: CdpSession, context: number): string {
  return `${session.id}\n${context}`
}

function worldKey(session: CdpSession, frameId: string): string {
  return `${session.id}\n${frameId}`
}

// What a call into a document of a frame whose session ended answers, as a call into a document that went does.
function gone(session: CdpSession): CdpProtocolError {
  return new CdpProtocolError({ method: 'Runtime.callFunctionOn', sessionId: session.id }, { code: -32000, message: goneMessage, data: undefined })
}

async function pause(deadline: Deadline): Promise<void> {
  if (deadline.expired) throw new CdpTimeoutError({ method: 'Runtime.callFunctionOn', sessionId: undefined }, { timeoutMs: deadline.budgetMs, written: true })
  await sleep(Math.min(retryPauseMs, deadline.remainingMs), undefined, { signal: deadline.signal })
}

/**
 * Whether a locator names a frame to find its element in. A recipe without a frame path, or with an empty one, finds
 * in the page's own document.
 *
 * @example inFrame({ by: 'text', text: 'Paid', frame: [{ by: 'css', selector: '#pay' }] }) // true
 */
export function inFrame(locator: LocatorRecipe | undefined): locator is LocatorRecipe & { frame: FrameRecipe[] } {
  return locator?.frame !== undefined && locator.frame.length > 0
}

/** Every locator a browser command names, as `commandLocators` names a page command's. */
export function browserCommandLocators(command: BrowserCommand): LocatorRecipe[] {
  const own = 'locator' in command && command.locator !== undefined ? [command.locator] : []
  return command.kind === 'observeLayout' && command.other !== undefined ? [...own, command.other] : own
}

/**
 * The refusal of a command that names a frame, from a driver that does not look inside frames, which names where it
 * runs; undefined for a command that names none. Nothing is sent.
 *
 * @example framesUnreached([{ by: 'text', text: 'Paid', frame: [{ by: 'css', selector: '#pay' }] }], 'Firefox')?.class // 'unsupported'
 */
export function framesUnreached(locators: readonly LocatorRecipe[], where: string): Failure | undefined {
  const framed = locators.find(inFrame)
  if (framed === undefined) return undefined
  return {
    class: 'unsupported',
    message: `Retest looks inside frames on Chrome and Chromium only, and not on ${where} yet, so it sent nothing for ${describeLocator(framed)}.`,
    details: { inputSent: false },
  }
}

/**
 * The refusal of a read of several locators in different frames, which one look cannot read together: a look reads one
 * document. Undefined when they share one frame, or none.
 *
 * @example framesApart([{ by: 'testId', value: 'a' }, { by: 'testId', value: 'b', frame: [{ by: 'css', selector: 'iframe' }] }], 'read them')?.class // 'usage'
 */
export function framesApart(locators: readonly LocatorRecipe[], command: string): Failure | undefined {
  const [first, ...rest] = locators
  if (first === undefined || rest.every((locator) => sameFramePath(locator.frame, first.frame))) return undefined
  return { class: 'usage', message: `Could not ${command}: its locators are in different frames, and Retest reads them together in one document only.` }
}

/**
 * The refusal of a command Retest does not run inside a frame yet, named by what it does: giving a file input files,
 * or taking a picture of an element. Nothing is sent.
 *
 * @example notInFrames('set the files of frame(locator(\'#upload\')).getByLabel(\'Report\')').class // 'unsupported'
 */
export function notInFrames(command: string): Failure {
  return { class: 'unsupported', message: `Could not ${command}: Retest does this in the page's own document only, not inside a frame yet, so it sent nothing.`, details: { inputSent: false } }
}

/**
 * The refusal of a command for a native app that names a frame: a native app has none. Undefined for a command that
 * names no frame. Nothing is sent.
 *
 * @example noFramesInApp([{ by: 'text', text: 'Paid', frame: [{ by: 'css', selector: '#pay' }] }])?.class // 'unsupported'
 */
export function noFramesInApp(locators: readonly LocatorRecipe[]): Failure | undefined {
  const framed = locators.find(inFrame)
  if (framed === undefined) return undefined
  return { class: 'unsupported', message: `A native app has no frames, so Retest sent nothing for ${describeLocator(framed)}. frame() is for a web page.`, details: { inputSent: false } }
}
