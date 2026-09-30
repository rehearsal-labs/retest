import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { BrowserCommand, OwnedPage, PageReading, TextQuery } from './contract.ts'
import type { ActionIntent } from './element-queries.ts'
import type { GuardVerdict } from './input-guard.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { StorageState, StoredOrigin } from '../protocol/storage-state.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { describeLocator } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { isWebUrl } from '../protocol/url.ts'
import { waitUntilActionable, type PendingNavigation } from './actionability.ts'
import { BrowserError } from './browser-error.ts'
import { CdpClosedError, CdpDisconnectedError, CdpProtocolError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { commandStopped, connectionEnded, dialogOpened, failureFromError } from './command-failures.ts'
import { Dispatch } from './dispatch.ts'
import { describeAction, observe } from './element-queries.ts'
import { applyEmulation } from './emulation.ts'
import { clickAt, pressKey, replaceSelection, tapAt, type Point } from './input.ts'
import { disarmGuard, guardFailure, guardInput, keyFailure } from './input-guard.ts'
import { IsolatedWorld } from './isolated-world.ts'
import { Listeners } from './listeners.ts'
import { navigate } from './navigation.ts'
import { guardScript, readPageFunction } from './page-scripts.ts'
import { originAndPath } from './page-url.ts'
import { readCookies, readLocalStorage, readOriginStorage } from './storage-state.ts'

export type PageOptions = {
  connection: CdpConnection
  session: CdpSession
  browserContextId: string
  baseUrl: string | undefined
  /** Applied before the page opens anything. A touch screen makes every click a tap. */
  emulation: Emulation | undefined
  /** Origins whose storage the page's context already holds, from a restored state. */
  restoredOrigins: readonly string[]
  /** The proxy the page's context sends its requests through, which a failed navigation names. */
  proxyServer: string | undefined
  /** Receives errors thrown by navigation listeners. */
  onListenerError: (error: unknown) => void
}

type ElementAction = Exclude<BrowserCommand, { kind: 'goto' | 'observe' | 'press' }>

/**
 * An action's input on the element `locator` finds, or, without one, on the page's keyboard. `judge` reads what
 * the guard saw of the input.
 */
type Acting = {
  locator: LocatorRecipe | undefined
  intent: ActionIntent
  input: (point: Point | null) => Promise<void>
  judge: (verdict: GuardVerdict) => Failure | undefined
}

const retryPauseMs = 20
const screenshotCommand = 'take a screenshot'
const captureCommand = 'save the sign-in state'
const readCommand = 'read the page'

const frameTreeSchema = s.object({ frameTree: s.object({ frame: s.object({ id: s.string(), url: s.string() }) }) })
const frameNavigatedSchema = s.object({
  frame: s.object({ id: s.string(), parentId: s.optional(s.string()), url: s.string() }),
})
const sameDocumentSchema = s.object({ frameId: s.string(), url: s.string() })
const navigatingSchema = s.object({ frameId: s.string(), url: s.string(), navigationType: s.string() })
const frameSchema = s.object({ frameId: s.string() })
const foundSchema = s.array(s.boolean())
const screenshotSchema = s.object({ data: s.string() })
const dialogSchema = s.object({ type: s.string() })

// Navigations that keep the document. Any other replaces it when it commits.
const withinDocument: ReadonlySet<string> = new Set(['sameDocument', 'historySameDocument'])

/** One page in a browser context of its own. */
export class ChromiumPage implements OwnedPage {
  readonly #connection: CdpConnection
  readonly #session: CdpSession
  readonly #browserContextId: string
  readonly #baseUrl: string | undefined
  readonly #world: IsolatedWorld
  readonly #navigations: Listeners<string>
  readonly #navigationStarts: Listeners<string>
  readonly #touch: boolean
  readonly #proxyServer: string | undefined
  // The http and https origins the main frame opened, and those the restored state held, in the order they came.
  readonly #origins: Set<string>
  #mainFrameId: string
  #url: URL | undefined
  #pendingNavigation: PendingNavigation | undefined
  #lostReason: string | undefined
  #dialog: string | undefined
  #disposing: Promise<void> | undefined

  /**
   * Applies the page's emulation, reads its main frame, then follows it through the events this enables, and has
   * every document it opens install Retest's input guard before the page's own scripts run.
   *
   * @example const page = await ChromiumPage.open({ connection, session, browserContextId, baseUrl, emulation, restoredOrigins: [], onListenerError }, deadline)
   */
  static async open(options: PageOptions, deadline: Deadline): Promise<ChromiumPage> {
    const { session, emulation } = options
    if (emulation !== undefined) await applyEmulation(session, emulation, deadline)
    const { frameTree } = await request(session, 'Page.getFrameTree', undefined, frameTreeSchema, sendOptions(deadline))
    const page = new ChromiumPage(options, frameTree.frame)
    await request(session, 'Page.enable', undefined, s.object({}), sendOptions(deadline))
    await request(session, 'Page.setLifecycleEventsEnabled', { enabled: true }, s.object({}), sendOptions(deadline))
    await page.#world.addScript(guardScript, deadline)
    return page
  }

  constructor(options: PageOptions, mainFrame: { id: string; url: string }) {
    this.#connection = options.connection
    this.#session = options.session
    this.#browserContextId = options.browserContextId
    this.#baseUrl = options.baseUrl
    this.#touch = options.emulation?.touch === true
    this.#proxyServer = options.proxyServer
    this.#origins = new Set(options.restoredOrigins)
    this.#mainFrameId = mainFrame.id
    this.#url = URL.parse(mainFrame.url) ?? undefined
    this.#navigations = new Listeners(options.onListenerError)
    this.#navigationStarts = new Listeners(options.onListenerError)
    this.#world = new IsolatedWorld(this.#session, () => this.#mainFrameId)
    this.#session.on('Page.frameNavigated', (params) => this.#frameNavigated(params))
    this.#session.on('Page.navigatedWithinDocument', (params) => this.#navigatedWithinDocument(params))
    this.#session.on('Page.frameStartedNavigating', (params) => this.#navigationStarted(params))
    this.#session.on('Page.frameStoppedLoading', (params) => this.#loadingStopped(params))
    // A crashed page and one a dialog holds answer nothing, so commands waiting on them fail at once.
    this.#session.on('Inspector.targetCrashed', () => {
      this.#lostReason ??= 'the page crashed'
      this.#session.block('the page crashed')
    })
    this.#session.on('Page.javascriptDialogOpening', (params) => {
      const { type } = readProtocol(dialogSchema, params, { method: 'Page.javascriptDialogOpening', sessionId: this.#session.id })
      this.#dialog = type
      this.#session.block(`a JavaScript ${type} dialog holds the page`)
    })
    this.#session.on('Page.javascriptDialogClosed', () => {
      this.#dialog = undefined
      if (this.#lostReason === undefined) this.#session.unblock()
    })
    this.#session.onDetach((reason) => {
      this.#lostReason ??= reason
    })
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    const deadline = new Deadline(timeoutMs, { signal })
    const described = this.#describe(command)
    const dispatch = new Dispatch()
    try {
      signal?.throwIfAborted()
      const blocked = this.#blocked(described, false)
      if (blocked !== undefined) return { ok: false, failure: blocked }
      const result = await this.#run(command, deadline, dispatch)
      return result.ok ? result : { ok: false, failure: this.#blocked(described, dispatch.sent) ?? result.failure }
    } catch (error) {
      if (signal?.aborted === true) return { ok: false, failure: commandStopped(described, dispatch.sent, signal.reason) }
      const failure = this.#blocked(described, dispatch.sent) ?? failureFromError(error, { command: described, timeoutMs, inputSent: dispatch.sent })
      return { ok: false, failure }
    }
  }

  async screenshot(timeoutMs: number): Promise<Uint8Array> {
    const deadline = new Deadline(timeoutMs)
    for (;;) {
      const blocked = this.#blocked(screenshotCommand, false)
      if (blocked !== undefined) throw new BrowserError(blocked)
      try {
        const params = { format: 'png' }
        const { data } = await request(this.#session, 'Page.captureScreenshot', params, screenshotSchema, sendOptions(deadline))
        return Buffer.from(data, 'base64')
      } catch (error) {
        if (!isBetweenDocuments(error) || deadline.expired) throw this.#operationError(screenshotCommand, error, timeoutMs)
        await sleep(Math.min(retryPauseMs, deadline.remainingMs))
      }
    }
  }

  /**
   * Reads the context's cookies, and the `localStorage` of each http or https origin the main frame opened or
   * the page's restored state held. The current document's origin is read in its own world, and every other one
   * from an empty document Retest serves for it, so no request reaches the site and none of its code runs.
   * Frames' own origins, sessionStorage, IndexedDB and partitioned cookies are not saved, nor origins whose
   * storage is empty.
   */
  async captureState(timeoutMs: number): Promise<StorageState> {
    const deadline = new Deadline(timeoutMs)
    const blocked = this.#blocked(captureCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    try {
      const cookies = await readCookies(this.#connection, this.#browserContextId, deadline)
      const current = await this.#currentStorage(deadline)
      const others = [...this.#origins].filter((origin) => origin !== current?.origin)
      const context = { connection: this.#connection, browserContextId: this.#browserContextId }
      const earlier = await readOriginStorage(context, others, deadline)
      const shown = current === undefined || current.localStorage.length === 0 ? [] : [current]
      return { cookies, origins: [...shown, ...earlier] }
    } catch (error) {
      throw this.#operationError(captureCommand, error, timeoutMs)
    }
  }

  /**
   * Reads the page in Retest's world. A document about to be replaced is not read, since the browser would hold
   * the call until the new one commits. While the frame is opening another document, or once it begins to during
   * the read, the reading says `navigating`, and `found` is empty: nothing was read.
   */
  async readPage(queries: readonly TextQuery[], timeoutMs: number): Promise<PageReading> {
    const blocked = this.#blocked(readCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    const navigating = new AbortController()
    const stopListening = this.#navigationStarts.add(() => navigating.abort())
    try {
      if (this.#pendingNavigation === undefined) {
        const deadline = new Deadline(timeoutMs, { signal: navigating.signal })
        const found = await this.#world.call(readPageFunction, [queries], foundSchema, deadline)
        return { url: this.#address(), navigating: this.#pendingNavigation !== undefined, found }
      }
    } catch (error) {
      if (!navigating.signal.aborted) throw this.#operationError(readCommand, error, timeoutMs)
    } finally {
      stopListening()
    }
    return { url: this.#address(), navigating: true, found: [] }
  }

  onNavigation(listener: (url: string) => void): () => void {
    return this.#navigations.add(listener)
  }

  dispose(timeoutMs: number): Promise<void> {
    this.#disposing ??= this.#dispose(new Deadline(timeoutMs))
    return this.#disposing
  }

  async #run(command: BrowserCommand, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
    switch (command.kind) {
      case 'goto': {
        const context = {
          session: this.#session,
          baseUrl: this.#baseUrl,
          mainFrameId: () => this.#mainFrameId,
          currentUrl: () => this.#url,
          proxyServer: this.#proxyServer,
        }
        return navigate(context, command.url, deadline, dispatch)
      }
      case 'observe':
        return { ok: true, kind: 'observe', observation: await observe(this.#world, command.locator, deadline) }
      case 'press':
        return this.#pressKey(command, deadline, dispatch)
      case 'tap':
        if (!this.#touch) return { ok: false, failure: noTouchScreen(command) }
        return this.#pointer(command, 'tap', deadline, dispatch)
      case 'click':
        return this.#pointer(command, this.#touch ? 'tap' : 'click', deadline, dispatch)
      case 'fill': {
        const { locator, secret, allowedOrigins } = command
        const intent: ActionIntent = {
          action: 'fill',
          multiline: /[\n\r]/.test(command.value),
          ...(secret === undefined ? {} : { secret }),
          ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
        }
        const input = () => replaceSelection(this.#session, command.value, deadline, dispatch)
        return this.#act({ locator, intent, input, judge: (verdict) => guardFailure(verdict, intent, locator) }, deadline)
      }
    }
  }

  #pointer(command: ElementAction, action: 'click' | 'tap', deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
    const { locator } = command
    const intent: ActionIntent = { action, multiline: false }
    const send = action === 'tap' ? tapAt : clickAt
    const input = (point: Point | null) => send(this.#session, pointOf(point), deadline, dispatch)
    return this.#act({ locator, intent, input, judge: (verdict) => guardFailure(verdict, intent, locator) }, deadline)
  }

  // The parent has read the key already. It is read again here because the parsed key is what the browser is sent.
  async #pressKey(command: Extract<BrowserCommand, { kind: 'press' }>, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
    const parsed = parseKey(command.key)
    if (!parsed.ok) return { ok: false, failure: parsed.failure }
    const { locator, key } = command
    const intent: ActionIntent = { action: 'press', key, multiline: false }
    const input = () => pressKey(this.#session, parsed.key, deadline, dispatch)
    return this.#act({ locator, intent, input, judge: (verdict) => keyFailure(verdict, key, locator) }, deadline)
  }

  // Input goes to whatever document the frame holds when the browser processes it. A navigation the browser
  // began after the page's ready answer would take it into the document it opens, so such a target is let go,
  // and the element is looked for again once that navigation is over.
  async #act({ locator, intent, input, judge }: Acting, deadline: Deadline): Promise<CommandResult> {
    const wait = { world: this.#world, locator, intent, deadline, pendingNavigation: () => this.#pendingNavigation }
    for (;;) {
      const target = await waitUntilActionable(wait)
      if (!target.ok) return target
      if (this.#pendingNavigation !== undefined) {
        await disarmGuard(this.#world, target.guard, deadline)
        continue
      }
      const verdict = await guardInput(this.#world, target.guard, deadline, () => input(target.point))
      const failure = judge(verdict)
      return failure === undefined ? { ok: true, kind: intent.action } : { ok: false, failure }
    }
  }

  #address(): string | undefined {
    return this.#url === undefined ? undefined : originAndPath(this.#url)
  }

  // The current document's own storage is read in its world, where the page keeps writing it.
  async #currentStorage(deadline: Deadline): Promise<StoredOrigin | undefined> {
    const url = this.#url
    if (url === undefined || !this.#origins.has(url.origin)) return undefined
    return (await readLocalStorage(this.#world, deadline)) ?? undefined
  }

  // A page that crashed, closed or is held by a dialog stops answering, which says nothing about how fast it is.
  #blocked(command: string, inputSent: boolean): Failure | undefined {
    if (this.#lostReason !== undefined) return connectionEnded(command, inputSent, this.#lostReason)
    if (this.#dialog !== undefined) return dialogOpened(command, this.#dialog, inputSent)
    return undefined
  }

  #describe(command: BrowserCommand): string {
    switch (command.kind) {
      case 'goto': {
        const target = URL.parse(command.url, this.#baseUrl)
        return `open ${target === null ? JSON.stringify(command.url) : originAndPath(target)}`
      }
      case 'observe':
        return `read ${describeLocator(command.locator)}`
      case 'click':
        return `${this.#touch ? 'tap' : 'click'} ${describeLocator(command.locator)}`
      case 'fill': {
        const { secret } = command
        return `fill ${describeLocator(command.locator)}${secret === undefined ? '' : ` with ${secretPlaceholder(secret)}`}`
      }
      case 'tap':
        return `tap ${describeLocator(command.locator)}`
      case 'press':
        return describeAction({ action: 'press', key: command.key, multiline: false }, command.locator)
    }
  }

  async #dispose(deadline: Deadline): Promise<void> {
    this.#lostReason ??= 'the page was closed'
    if (this.#connection.closeReason !== undefined) return
    try {
      const params = { browserContextId: this.#browserContextId }
      await this.#connection.send('Target.disposeBrowserContext', params, sendOptions(deadline))
    } catch (error) {
      // A browser that went away took the context with it.
      if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return
      throw new BrowserError(
        { class: 'cleanup_failed', message: `Could not close the page's browser context: ${errorMessage(error)}` },
        { cause: error },
      )
    }
  }

  // Turns an error from a browser call outside `execute`, which reads the page and sends no input, into its failure.
  // A timeout names the budget the caller gave.
  #operationError(command: string, error: unknown, timeoutMs: number): unknown {
    if (error instanceof BrowserError) return error
    const blocked = this.#blocked(command, false)
    if (blocked !== undefined) return new BrowserError(blocked, { cause: error })
    if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) {
      return new BrowserError(connectionEnded(command, false, error.reason), { cause: error })
    }
    if (error instanceof CdpTimeoutError) {
      const message = `Could not ${command} within ${timeoutMs} ms.`
      return new BrowserError({ class: 'timeout', message }, { cause: error })
    }
    return error
  }

  #frameNavigated(params: unknown): void {
    const { frame } = readProtocol(frameNavigatedSchema, params, { method: 'Page.frameNavigated', sessionId: this.#session.id })
    if (frame.parentId !== undefined) return
    this.#mainFrameId = frame.id
    this.#pendingNavigation = undefined
    this.#world.reset()
    this.#moveTo(frame.url, true)
  }

  // The browser has begun a navigation of the main frame. Its document replaces the current one when it commits,
  // unless the browser gives it up first, as it does a 204 or a download, or begins another in its place.
  #navigationStarted(params: unknown): void {
    const source = { method: 'Page.frameStartedNavigating', sessionId: this.#session.id }
    const { frameId, url, navigationType } = readProtocol(navigatingSchema, params, source)
    if (frameId !== this.#mainFrameId || withinDocument.has(navigationType)) return
    this.#pendingNavigation = { url }
    this.#navigationStarts.emit(url)
  }

  // The main frame stopped loading with nothing committed since the navigation began: the browser gave it up.
  #loadingStopped(params: unknown): void {
    const { frameId } = readProtocol(frameSchema, params, { method: 'Page.frameStoppedLoading', sessionId: this.#session.id })
    if (frameId === this.#mainFrameId) this.#pendingNavigation = undefined
  }

  #navigatedWithinDocument(params: unknown): void {
    const source = { method: 'Page.navigatedWithinDocument', sessionId: this.#session.id }
    const { frameId, url } = readProtocol(sameDocumentSchema, params, source)
    if (frameId === this.#mainFrameId) this.#moveTo(url, false)
  }

  // A new document is always news; within a document only a new path is, since a fragment is never reported.
  #moveTo(address: string, newDocument: boolean): void {
    const url = URL.parse(address)
    if (url === null) throw new Error('The browser reported a main frame address that is not a URL')
    const previous = this.#url
    this.#url = url
    if (isWebUrl(url)) this.#origins.add(url.origin)
    const path = originAndPath(url)
    if (newDocument || previous === undefined || originAndPath(previous) !== path) this.#navigations.emit(path)
  }
}

// Only a key is ready without a point, and a key never goes through one.
function pointOf(point: Point | null): Point {
  if (point === null) throw new Error("Retest's page script readied a pointer action without a point")
  return point
}

function noTouchScreen(command: Extract<BrowserCommand, { kind: 'tap' }>): Failure {
  return {
    class: 'unsupported',
    message: `Could not tap ${describeLocator(command.locator)}: the page does not emulate a touch screen, and tap() needs one.`,
  }
}

// Between a failed navigation and its error page, the page has no document to capture.
function isBetweenDocuments(error: unknown): boolean {
  return error instanceof CdpProtocolError && error.protocolMessage === 'Not attached to an active page'
}
