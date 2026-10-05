import type { ActionTarget, PendingNavigation, ReadyTarget } from '../actionability.ts'
import type { BrowserCommand, DispatchedCommand, ElementIdentity, KeyedReading, PageNavigation, PageReading, SessionIdentity, TextQuery, WebSession } from '../contract.ts'
import type { ActionIntent, PlannedKey, Pointer, Selection } from '../element-queries.ts'
import type { Guard, GuardedIntent, GuardVerdict } from '../input-guard.ts'
import type { Point } from '../input.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../../diagnostics/observations.ts'
import type { CommandResult, ObserveAfter, PageObservation } from '../../protocol/commands.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { RecordIdentity } from '../../protocol/identity.ts'
import type { Key, ModifierName } from '../../protocol/keys.ts'
import type { LocatorRecipe } from '../../protocol/locator.ts'
import type { PageFacts } from '../../protocol/page-facts.ts'
import type { StorageState, StoredOrigin } from '../../protocol/storage-state.ts'
import type { RoleDoubt } from './accessibility-reading.ts'
import type { PageProxyEvent, TargetEvent, WebKitConnection } from './connection.ts'
import type { FrameEvent, Traversal, WebKitNavigationContext } from './navigation.ts'
import type { WebKitScreen } from './screen.ts'
import type { ListPlanRequest } from './select.ts'
import type { SidePage } from './storage.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { waitBeforeRead } from '../../assertions/wait-before-read.ts'
import { WebKitCollector } from '../../diagnostics/webkit-collector.ts'
import { isNavigationKind } from '../../protocol/commands.ts'
import { Deadline, monotonicClock } from '../../protocol/deadline.ts'
import { formatSessionId } from '../../protocol/evidence.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { keyStrokes, namedKeys, parseKey } from '../../protocol/keys.ts'
import { describeLocator } from '../../protocol/locator.ts'
import { optionChoicesProblem } from '../../protocol/option-choices.ts'
import { s } from '../../protocol/schema.ts'
import { scrollProblem } from '../../protocol/scroll-delta.ts'
import { secretPlaceholder } from '../../protocol/secret.ts'
import { isWebUrl } from '../../protocol/url.ts'
import { invalidSelector, shadowRefused, waitUntilActionable } from '../actionability.ts'
import { BrowserError } from '../browser-error.ts'
import { Channel } from '../cdp/channel.ts'
import { CdpClosedError, CdpDisconnectedError, CdpInvalidResponseError, CdpProtocolError, CdpTimeoutError } from '../cdp/errors.ts'
import { CdpSession } from '../cdp/session.ts'
import { isRecord } from '../cdp/message.ts'
import { readProtocol } from '../cdp-results.ts'
import { awaitCheckedState } from '../checked-state.ts'
import { commandStopped, connectionEnded, dialogOpened, failureFromError } from '../command-failures.ts'
import { Dispatch } from '../dispatch.ts'
import { documentFactsSchema, pageFactsOf, pageTitleOf } from '../document-facts.ts'
import { describeAction, describeChoices, dispatchPinned, observe, observeKeyed, pageSetOff, readSelection } from '../element-queries.ts'
import { clickAt, moveTo, pressKey, replaceSelection, wheelAt } from '../input.ts'
import { disarmGuard, guardFailure, guardInput } from '../input-guard.ts'
import { IsolatedWorld, isGoneContext } from '../isolated-world.ts'
import { Listeners } from '../listeners.ts'
import { NavigationCauses } from '../navigation-causes.ts'
import { NavigationTitles } from '../navigation-titles.ts'
import { pageFactsFunction, pageLookFunction, readPageFunction } from '../page-scripts.ts'
import { originAndPath } from '../page-url.ts'
import { locatorArguments } from '../locate.ts'
import { readLocalStorage } from '../storage-state.ts'
import { navigate, reload, traverse } from './navigation.ts'
import { bootstrapScript } from './relay.ts'
import { doubtedRole, genericRefusal, roleRefusal } from './roles.ts'
import { listKey, listPlanFunction, listPlanSchema } from './select.ts'
import { defaultScreen } from './screen.ts'
import { readContextCookies, readOtherOrigins } from './storage.ts'
import { LostReadingError, WebKitTargetSession } from './target-session.ts'
import { WebKitFrameSource } from './capture.ts'

/**
 * What a page needs to know before its first target is set up: its address base, its screen, its restored origins, and
 * whether it is a page Retest opens for its own use, which answers every request itself with an empty document.
 */
export type WebKitPageSetup = {
  baseUrl: string | undefined
  screen: WebKitScreen
  /** Origins whose storage the page's context already holds, from a restored state. */
  restoredOrigins: readonly string[]
  serveEmptyDocuments?: true
}

export type WebKitPageOptions = {
  connection: WebKitConnection
  pageProxyId: string
  browserContextId: string
  /**
   * The page's own setup, or the promise of it while the browser has not yet said which page its `Playwright.createPage`
   * made: the page's first target stays paused until its setup is there.
   */
  setup: WebKitPageSetup | Promise<WebKitPageSetup>
  /** Opens a page in the same context for Retest's own use, such as reading another origin's storage. */
  openSidePage: (deadline: Deadline) => Promise<SidePage>
  onListenerError: (error: unknown) => void
}

/** A WebKit screenshot as a capture: its PNG, its source, the session that took it, and when it came back. */
export type WebKitCapture = { readonly png: Uint8Array; readonly source: 'webkit'; readonly reference: { readonly sessionId: string }; readonly capturedAt: string }

/** How a page ended: the reason, and whether its web process crashed. */
export type PageLoss = { readonly reason: string; readonly crashed: boolean }

/** A command's own time, the signal that stops it, its token, and the dispatch that records how far its input got. */
type Executing = { timeoutMs: number; signal: AbortSignal | undefined; commandToken: number | undefined; dispatch: Dispatch }

type Acting = {
  locator: LocatorRecipe | undefined
  intent: GuardedIntent
  input: (target: ReadyTarget) => Promise<void>
  commandToken: number | undefined
}

type PointerAction = Extract<BrowserCommand, { kind: 'click' | 'tap' }>

const worldName = 'retest'
const changeBinding = 'retestChanged'
const retryPauseMs = 20
const loadedPageReadMs = 1000
const firstSelectionPauseMs = 20
const maxSelectionPauseMs = 200
const setupTimeoutMs = 10_000
// The modifier that moves the focus of a select that takes several options without changing what it holds.
const listModifier: ModifierName = 'Meta'
const screenshotCommand = 'take a screenshot'
const captureCommand = 'save the sign-in state'
const readCommand = 'read the page'
const collectCommand = 'collect diagnostics'

const targetInfoSchema = s.object({ targetInfo: s.object({ targetId: s.string(), type: s.string(), isProvisional: s.optional(s.boolean()), isPaused: s.optional(s.boolean()) }) })
const committedSchema = s.object({ oldTargetId: s.string(), newTargetId: s.string() })
const destroyedSchema = s.object({ targetId: s.string(), crashed: s.optional(s.boolean()) })
const dialogSchema = s.object({ type: s.string() })
const frameNavigatedSchema = s.object({ frame: s.object({ id: s.string(), parentId: s.optional(s.string()), loaderId: s.string(), url: s.string() }) })
const frameSchema = s.object({ frameId: s.string() })
const policySchema = s.object({ frameId: s.string(), cancel: s.optional(s.boolean()) })
const withinSchema = s.object({ frameId: s.string(), url: s.string() })
const requestSchema = s.object({ requestId: s.string(), frameId: s.string(), loaderId: s.string(), request: s.object({ url: s.string() }), type: s.optional(s.string()), redirectResponse: s.optional(s.object({})) })
const bindingSchema = s.object({ name: s.string() })
const resourceTreeSchema = s.object({ frameTree: s.object({ frame: s.object({ id: s.string(), url: s.string() }) }) })
const readingSchema = s.object({ found: s.array(s.boolean()), title: s.string(), body: s.boolean() })
const pageLookSchema = s.object({ url: s.string(), title: s.string(), cut: s.array(s.enum(['url', 'title'])) })
const snapshotSchema = s.object({ dataURL: s.string() })
const historySchema = s.object({ can: s.boolean(), length: s.number({ integer: true, min: 0 }) })
const interceptedSchema = s.object({ requestId: s.string() })
const requestEndSchema = s.object({ requestId: s.string() })
const requestFailedSchema = s.object({ requestId: s.string(), errorText: s.string() })

/**
 * Waits until `endsAt` on the monotonic clock has passed, or `signal` aborts. A timer can fire a fraction of a
 * millisecond before its time by the clock, and a timeout is never told before the budget it names has passed: a poll's
 * last look waits all but a moment of its budget, and its caller takes a timeout that comes at the deadline as the
 * deadline, but one that comes before it as the failure of the check.
 *
 * @example await outlast(monotonicClock() + 20, undefined) // monotonicClock() is now at least 20 ms on
 */
export async function outlast(endsAt: number, signal: AbortSignal | undefined): Promise<void> {
  for (let left = endsAt - monotonicClock(); left > 0 && signal?.aborted !== true; left = endsAt - monotonicClock()) {
    await sleep(Math.ceil(left), undefined, signal === undefined ? {} : { signal }).catch(() => undefined)
  }
}

/**
 * Whether a failure is one a command tells at the end of its budget: a timeout, or a failure that says it waited the
 * whole budget, such as an element still covered when the time was up. Either is told only once the budget it names
 * has passed by the clock, whatever the deadline read when it came.
 *
 * @example waitedWholeBudget({ class: 'not_actionable', message: 'covered', details: { waitedMs: 500 } }, 500) // true
 */
export function waitedWholeBudget(failure: Failure, budgetMs: number): boolean {
  return failure.class === 'timeout' || failure.details?.['waitedMs'] === budgetMs
}

// The key of the element `dispatchTo` pins an action to. The shared look that readies each element reads its own pin;
// the WebKit list plan, which reads the select again to plan its keys, reads this one, so it plans from that element.
const pinnedList = new AsyncLocalStorage<string>()

/** One page of a WebKit browser context: a web session that tells one element from another. */
export class WebKitPage implements WebSession, ElementIdentity {
  readonly pageProxyId: string
  readonly browserContextId: string
  /** Settles once the first page target is set up and running, and rejects if the page fails before that. */
  readonly ready: Promise<void>
  readonly #connection: WebKitConnection
  readonly #bridge: WebKitTargetSession
  // The browser end of the connection as a CDP session, so `Playwright.navigate` goes through `Dispatch` as input.
  readonly #browserSession: CdpSession
  readonly #world: IsolatedWorld
  readonly #secret = `retest-${randomUUID()}`
  readonly #setupApplied: Promise<WebKitPageSetup>
  #appliedSetup: WebKitPageSetup | undefined
  readonly #openSidePage: (deadline: Deadline) => Promise<SidePage>
  readonly #navigations: Listeners<PageNavigation>
  readonly #navigationStarts: Listeners<string>
  readonly #frameEvents: Listeners<FrameEvent>
  readonly #events: Listeners<TargetEvent>
  readonly #proxyEvents: Listeners<PageProxyEvent>
  readonly #losses: Listeners<PageLoss>
  readonly #causes = new NavigationCauses()
  readonly #titles: NavigationTitles
  readonly #origins = new Set<string>()
  readonly #changeWaiters = new Set<() => void>()
  readonly #readyResolvers = Promise.withResolvers<void>()
  readonly #stopListening: (() => void)[]
  readonly #loaderUrls = new Map<string, string>()
  readonly #startedLoaders = new Set<string>()
  // The loader of each main frame document request still on its way, by request id.
  readonly #documentRequests = new Map<string, string>()
  #proxyReady = false
  #targetId: string | undefined
  #provisionalTargetId: string | undefined
  #mainFrameId = ''
  #loaderId: string | undefined
  #url: URL | undefined
  #changes = 0
  #pendingNavigation: PendingNavigation | undefined
  // A reload, a move through the history or a goto has sent its command, and the next navigation the page checks is its own.
  #ownNavigationDue = false
  #lostReason: string | undefined
  #crashed = false
  #dialog: string | undefined
  #disposing: Promise<void> | undefined
  #identity: RecordIdentity | undefined

  constructor(options: WebKitPageOptions) {
    this.#connection = options.connection
    this.pageProxyId = options.pageProxyId
    this.browserContextId = options.browserContextId
    const { setup } = options
    if (setup instanceof Promise) {
      this.#setupApplied = setup.then((applied) => this.#applySetup(applied))
      this.#setupApplied.catch(() => undefined)
    } else {
      this.#setupApplied = Promise.resolve(this.#applySetup(setup))
    }
    this.#openSidePage = options.openSidePage
    this.ready = this.#readyResolvers.promise
    // A page nobody opened through newPage has nobody waiting on it to hear that it failed.
    this.ready.catch(() => undefined)
    this.#navigations = new Listeners(options.onListenerError)
    this.#navigationStarts = new Listeners(options.onListenerError)
    this.#frameEvents = new Listeners(options.onListenerError)
    this.#events = new Listeners(options.onListenerError)
    this.#proxyEvents = new Listeners(options.onListenerError)
    this.#losses = new Listeners(options.onListenerError)
    this.#bridge = new WebKitTargetSession({
      connection: this.#connection,
      pageProxyId: this.pageProxyId,
      secret: this.#secret,
      worldName,
      onListenerError: (_event, error) => options.onListenerError(error),
    })
    this.#browserSession = new CdpSession('webkit browser', new Channel(undefined, (_event, error) => options.onListenerError(error)), (method, params, sendOptions) => this.#connection.send(method, params, sendOptions))
    this.#world = new IsolatedWorld(this.#bridge.session, () => this.#mainFrameId)
    this.#titles = new NavigationTitles({
      readable: () => this.#pendingNavigation === undefined && this.#lostReason === undefined && this.#dialog === undefined,
      read: async (deadline) => pageTitleOf((await this.#world.call(pageFactsFunction, [], documentFactsSchema, deadline)).title),
    })
    this.#stopListening = [
      this.#connection.onPageProxyEvent(this.pageProxyId, (event) => this.#onPageProxyEvent(event)),
      this.#connection.onTargetEvent(this.pageProxyId, (event) => this.#onTargetEvent(event)),
    ]
  }

  get url(): string | undefined {
    return this.#address()
  }

  // The page's setup once the browser has said which page it is; a page is handed out only after that.
  get #setup(): WebKitPageSetup {
    return this.#appliedSetup ?? pendingSetup
  }

  #applySetup(setup: WebKitPageSetup): WebKitPageSetup {
    this.#appliedSetup = setup
    for (const origin of setup.restoredOrigins) this.#origins.add(origin)
    return setup
  }

  /** The page's own events from its committed and provisional targets, for its collector and frame source. */
  onTargetEvent(listener: (event: TargetEvent) => void): () => void {
    return this.#events.add(listener)
  }

  /** Events its page proxy sends itself, for its frame source. */
  onPageProxyEvent(listener: (event: PageProxyEvent) => void): () => void {
    return this.#proxyEvents.add(listener)
  }

  /** The end of the page, told once: it crashed, closed or lost its browser. One that comes later hears it at once. */
  onLost(listener: (loss: PageLoss) => void): () => void {
    const reason = this.#lostReason
    if (reason === undefined) return this.#losses.add(listener)
    listener({ reason, crashed: this.#crashed })
    return () => undefined
  }

  /** The bridge the shared page code talks through, and Retest's own WebKit commands go through. */
  get bridge(): WebKitTargetSession {
    return this.#bridge
  }

  /** The page's main frame now. */
  get mainFrameId(): string {
    return this.#mainFrameId
  }

  /**
   * The target a navigation into another web process set up and has not committed yet, if one is under way: its first
   * document request is the main frame's, though its main frame id is not the page's until it commits.
   */
  get provisionalTargetId(): string | undefined {
    return this.#provisionalTargetId
  }

  /** Why the page stopped answering, if it did. */
  get lostReason(): string | undefined {
    return this.#lostReason
  }

  /** The screen the page shows, as its emulation set it. */
  get screen(): WebKitScreen {
    return this.#setup.screen
  }

  /** Retest's own world in the page's main frame. */
  get world(): IsolatedWorld {
    return this.#world
  }

  /** Stops the page for good: every later command fails with `reason`. The browser calls it. */
  markClosed(reason: string, crashed = false): void {
    if (this.#lostReason === undefined) {
      this.#lostReason = reason
      this.#crashed = crashed
      this.#losses.emit({ reason, crashed })
    }
    this.#bridge.close(reason)
    this.#titles.dispose()
    this.#readyResolvers.reject(new BrowserError({ class: 'session_lost', message: `The page was lost before it was ready: ${reason}.` }))
    this.#frameEvents.emit({ kind: 'stopped', reason })
    this.#wake()
    for (const stop of this.#stopListening) stop()
  }

  /** The browser gave up loading a navigation of this page. The browser calls it. */
  provisionalLoadFailed(loaderId: string, error: string): void {
    if (this.#pendingNavigation !== undefined) this.#pendingNavigation = undefined
    this.#causes.stoppedLoading()
    this.#frameEvents.emit({ kind: 'given_up', loaderId, url: this.#loaderUrls.get(loaderId), error })
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult> {
    return (await this.dispatch(command, timeoutMs, signal, commandToken)).result
  }

  async dispatch(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand> {
    const dispatch = new Dispatch()
    const result = await this.#execute(command, { timeoutMs, signal, commandToken, dispatch })
    return { result, input: dispatch.input }
  }

  /**
   * Reads each locator's matches as `observe` does, in one task of the current document, with a key for each element
   * listed. A lookup WebKit cannot answer as Chrome does is refused by name, as `observe` refuses it, for any of the
   * locators. Sends no input.
   */
  async readElements(locators: readonly LocatorRecipe[], timeoutMs: number, signal?: AbortSignal): Promise<KeyedReading> {
    const startedAt = monotonicClock()
    const described = `read ${locators.map((locator) => describeLocator(locator)).join(' and ')}`
    for (const locator of locators) {
      const generic = genericRefusal(locator)
      if (generic !== undefined) return { ok: false, failure: generic }
    }
    const doubted = new AbortController()
    let refusal: { locator: LocatorRecipe; role: string; doubt: RoleDoubt } | undefined
    const stopWatching = this.#bridge.watchDoubts((doubt) => {
      if (refusal !== undefined) return
      for (const locator of locators) {
        const role = doubtedRole(locator, doubt)
        if (role === undefined) continue
        refusal = { locator, role, doubt }
        doubted.abort()
        return
      }
    })
    const refused = (): KeyedReading | undefined => (refusal === undefined ? undefined : { ok: false, failure: roleRefusal(refusal.locator, refusal.role, refusal.doubt, false) })
    const deadline = new Deadline(timeoutMs, { signal: signal === undefined ? doubted.signal : AbortSignal.any([signal, doubted.signal]), startedAt })
    try {
      await this.#titles.settle(deadline)
      signal?.throwIfAborted()
      const blocked = this.#blocked(described, false)
      if (blocked !== undefined) return { ok: false, failure: blocked }
      const read = await observeKeyed(this.#world, locators, deadline)
      const doubt = refused()
      if (doubt !== undefined) return doubt
      if ('reads' in read) return { ok: true, reads: read.reads, page: read.page }
      const named = locators[read.locator]
      if (named === undefined) throw new Error("Retest's keyed look named a locator it was not given")
      return { ok: false, failure: 'invalid' in read ? invalidSelector(read.invalid, named, undefined) : shadowRefused(read.shadow, named, undefined) }
    } catch (error) {
      if (error instanceof CdpTimeoutError || error instanceof LostReadingError) await outlast(startedAt + timeoutMs, signal)
      if (signal?.aborted === true) return { ok: false, failure: commandStopped(described, false, signal.reason) }
      const doubt = refused()
      if (doubt !== undefined) return doubt
      const failure = this.#blocked(described, false) ?? (error instanceof LostReadingError ? lostReading(described, timeoutMs, error, false) : failureFromError(error, { command: described, timeoutMs, inputSent: false }))
      return { ok: false, failure }
    } finally {
      stopWatching()
    }
  }

  /**
   * Sends `command` as `dispatch` does, only to the node `key` names: every look that readies the element, and the plan
   * of a list's keys, checks that the locator's one match is that node, and one that finds another fails the command
   * at once as `not_actionable` with `details.refused` `'moved'`, with no input sent.
   */
  dispatchTo(command: BrowserCommand, key: string, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand> {
    return dispatchPinned(command, key, () => pinnedList.run(key, () => this.dispatch(command, timeoutMs, signal, commandToken)))
  }

  async screenshot(timeoutMs: number): Promise<Uint8Array> {
    const deadline = new Deadline(timeoutMs)
    for (;;) {
      const finalRead = deadline.reached
      const blocked = this.#blocked(screenshotCommand, false)
      if (blocked !== undefined) throw new BrowserError(blocked)
      const targetId = this.#targetId
      try {
        if (targetId === undefined) throw new CdpClosedError({ method: 'Page.snapshotRect', sessionId: undefined }, 'the page has no document')
        const { width, height } = this.#setup.screen.viewport
        const params = { x: 0, y: 0, width, height, coordinateSystem: 'Viewport' }
        const answer = await this.#bridge.target(targetId, 'Page.snapshotRect', params, { timeoutMs: deadline.commandTimeoutMs })
        return decodePng(readProtocol(snapshotSchema, answer, { method: 'Page.snapshotRect' }).dataURL)
      } catch (error) {
        if (!(error instanceof CdpTimeoutError || error instanceof CdpClosedError) || finalRead || this.#lostReason !== undefined) throw this.#operationError(screenshotCommand, error, timeoutMs)
        // Between a target and the one a navigation swaps in, the page has no document to capture.
        await waitBeforeRead(deadline, retryPauseMs)
      }
    }
  }

  /**
   * Reads the context's cookies, and the `localStorage` of each http or https origin the main frame opened or the
   * page's restored state held: the current document's in its own world, every other one from an empty document Retest
   * serves for it, so no request reaches the site and none of its code runs. Partitioned cookies, sessionStorage,
   * IndexedDB and empty storage are not saved, as Chromium leaves them.
   */
  async captureState(timeoutMs: number): Promise<StorageState> {
    const deadline = new Deadline(timeoutMs)
    const blocked = this.#blocked(captureCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    try {
      const cookies = await readContextCookies(this.#connection, this.browserContextId, deadline)
      const current = await this.#currentStorage(deadline)
      const others = [...this.#origins].filter((origin) => origin !== current?.origin)
      const earlier = await readOtherOrigins(this.#openSidePage, others, deadline)
      const shown = current === undefined || current.localStorage.length === 0 ? [] : [current]
      return { cookies, origins: [...shown, ...earlier] }
    } catch (error) {
      throw this.#operationError(captureCommand, error, timeoutMs)
    }
  }

  async readPage(queries: readonly TextQuery[], timeoutMs: number): Promise<PageReading> {
    const started = monotonicClock()
    await this.#titles.settle(new Deadline(timeoutMs, { startedAt: started }))
    const blocked = this.#blocked(readCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    const navigating = new AbortController()
    const stopListening = this.#navigationStarts.add(() => navigating.abort())
    try {
      if (this.#pendingNavigation === undefined) {
        const deadline = new Deadline(timeoutMs, { startedAt: started, signal: navigating.signal })
        const { found, title, body } = await this.#world.call(readPageFunction, [queries], readingSchema, deadline)
        if (found.length !== queries.length) {
          throw new CdpInvalidResponseError({ method: 'Runtime.callFunctionOn', sessionId: this.#bridge.session.id }, `it answered ${found.length} of ${queries.length} text queries`)
        }
        const titled = withTitle(pageTitleOf(title))
        return { url: this.#address(), ...titled, navigating: this.#pendingNavigation !== undefined, found, ...(body ? {} : { body: false }) }
      }
    } catch (error) {
      if (!navigating.signal.aborted) throw this.#operationError(readCommand, error, timeoutMs)
    } finally {
      stopListening()
    }
    return { url: this.#address(), navigating: true, found: [] }
  }

  onNavigation(listener: (navigation: PageNavigation) => void): () => void {
    return this.#navigations.add(listener)
  }

  /**
   * Collects the page's console messages, runtime errors and network metadata from its targets as they come, following
   * each one a navigation swaps in. The collector's listeners are added at once, and the domains it hears were turned
   * on when each target was set up, so nothing after this call is missed. Sends no input and no command.
   */
  async collectDiagnostics(sink: DiagnosticSink, timeoutMs: number): Promise<DiagnosticCollection> {
    const blocked = this.#blocked(collectCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    await this.#settleReady(timeoutMs, collectCommand)
    return new WebKitCollector({ page: this, sink })
  }

  identify(session: SessionIdentity): void {
    const { sessionId, owner } = session
    const expected = formatSessionId(owner.attemptId, owner.app)
    if (sessionId !== expected) throw new Error(`A session of attempt ${owner.attemptId} and app ${owner.app} is ${expected}, not ${sessionId}.`)
    const identity = { testId: owner.testId, attemptId: owner.attemptId, app: owner.app, sessionId }
    const known = this.#identity
    if (known !== undefined && !sameSession(known, identity)) throw new Error(`This page is session ${known.sessionId} of ${JSON.stringify(known.testId)}; it cannot become ${sessionId}.`)
    this.#identity = identity
  }

  /** The session this page is, as `identify` named it, if it has been named. */
  get identity(): RecordIdentity | undefined {
    return this.#identity
  }

  /**
   * A frame source over this page's own screencast, its frames carrying the session `identify` named. A page not yet
   * named, or named as another session, gives a source that is unavailable and says why, so one page is never recorded
   * as another's session. Nothing is captured until it starts. Sends no input.
   */
  frameSource(identity: RecordIdentity): WebKitFrameSource { return this.webKitFrameSource(identity) }

  webKitFrameSource(identity: RecordIdentity): WebKitFrameSource {
    const own = this.#identity
    if (own === undefined) return new WebKitFrameSource(this, identity, `Retest has not named the session this page is, so it records nothing as ${identity.sessionId}.`)
    if (!sameSession(own, identity)) {
      return new WebKitFrameSource(this, own, `This page is session ${own.sessionId} of ${JSON.stringify(own.testId)}, not ${identity.sessionId} of ${JSON.stringify(identity.testId)}, so Retest records nothing of it as that session.`)
    }
    return new WebKitFrameSource(this, own)
  }

  /**
   * A screenshot named by its source, `webkit`, and the session that took it, with when it came back; refused while the
   * runner has not named the page's session.
   */
  async webKitCapture(timeoutMs: number): Promise<{ ok: true; capture: WebKitCapture } | { ok: false; failure: Failure }> {
    if (this.#identity === undefined) return { ok: false, failure: { class: 'unsupported', message: "The runner has not named this page's session, so no capture can be attributed to it." } }
    try {
      const png = await this.screenshot(timeoutMs)
      return { ok: true, capture: { png, source: 'webkit', reference: { sessionId: this.#identity.sessionId }, capturedAt: new Date().toISOString() } }
    } catch (error) {
      if (error instanceof BrowserError) return { ok: false, failure: error.failure }
      throw error
    }
  }

  /** Sends one of Retest's own commands to the page proxy, as its frame source does. */
  proxy(method: string, params: object | undefined, options: { timeoutMs: number }): Promise<unknown> {
    return this.#bridge.proxy(method, params, options)
  }

  dispose(timeoutMs: number): Promise<void> {
    this.#disposing ??= this.#dispose(new Deadline(timeoutMs))
    return this.#disposing
  }

  /** Closes this page alone, for a page Retest opened for its own use. */
  async closePage(timeoutMs: number): Promise<void> {
    this.#lostReason ??= 'the page was closed'
    if (this.#connection.closeReason !== undefined) return
    await this.#connection.send('Playwright.closePage', { pageProxyId: this.pageProxyId }, { timeoutMs }).catch(() => {
      // The context's end closes the page with it.
    })
  }

  // A lookup a reading of the page doubts is refused by name as soon as the doubt comes, which is before any input of the
  // command goes, since an action looks before it acts; one that comes after the input went still refuses the result,
  // saying the input went.
  async #execute(command: BrowserCommand, { timeoutMs, signal, commandToken, dispatch }: Executing): Promise<CommandResult> {
    const startedAt = monotonicClock()
    const described = this.#describe(command)
    const locator = 'locator' in command ? command.locator : undefined
    const generic = locator === undefined ? undefined : genericRefusal(locator)
    if (generic !== undefined) return { ok: false, failure: generic }
    const doubted = new AbortController()
    let refusal: { role: string; doubt: RoleDoubt } | undefined
    const stopWatching = locator === undefined ? () => undefined : this.#bridge.watchDoubts((doubt) => {
      const role = refusal === undefined ? doubtedRole(locator, doubt) : undefined
      if (role === undefined) return
      refusal = { role, doubt }
      if (!dispatch.sent) doubted.abort()
    })
    const refused = (): CommandResult | undefined => (locator === undefined || refusal === undefined ? undefined : { ok: false, failure: roleRefusal(locator, refusal.role, refusal.doubt, dispatch.sent) })
    const deadline = new Deadline(timeoutMs, { signal: signal === undefined ? doubted.signal : AbortSignal.any([signal, doubted.signal]), startedAt })
    try {
      await this.#titles.settle(deadline)
      signal?.throwIfAborted()
      const blocked = this.#blocked(described, false)
      if (blocked !== undefined) return { ok: false, failure: blocked }
      const result = await this.#run(command, deadline, dispatch, commandToken)
      const doubt = refused()
      if (doubt !== undefined) return doubt
      if (result.ok) return result
      // A nested timeout or readiness refusal that claims this whole budget waits through its exact end.
      // Another failure returns immediately, including in the deadline's last fraction.
      if (!stopped(signal) && waitedWholeBudget(result.failure, timeoutMs)) {
        await outlast(startedAt + timeoutMs, signal)
        if (signal !== undefined && stopped(signal)) return { ok: false, failure: commandStopped(described, dispatch.sent, signal.reason) }
      }
      return { ok: false, failure: this.#blocked(described, dispatch.sent) ?? result.failure }
    } catch (error) {
      if (error instanceof CdpTimeoutError || error instanceof LostReadingError) await outlast(startedAt + timeoutMs, signal)
      if (signal?.aborted === true) return { ok: false, failure: commandStopped(described, dispatch.sent, signal.reason) }
      const doubt = refused()
      if (doubt !== undefined) return doubt
      const failure = this.#blocked(described, dispatch.sent) ?? (error instanceof LostReadingError ? lostReading(described, timeoutMs, error, dispatch.sent) : failureFromError(error, { command: described, timeoutMs, inputSent: dispatch.sent }))
      return { ok: false, failure }
    } finally {
      stopWatching()
    }
  }

  async #run(command: BrowserCommand, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    switch (command.kind) {
      case 'goto':
        return this.#withLoadedPage(await this.#opening(commandToken, () => navigate(this.#navigationContext(), command.url, deadline, dispatch)), deadline)
      case 'reload':
        return this.#withLoadedPage(await this.#opening(commandToken, () => reload(this.#navigationContext(), deadline, dispatch)), deadline)
      case 'goBack':
      case 'goForward':
        return this.#withLoadedPage(await this.#traverse(command.kind, deadline, dispatch, commandToken), deadline)
      case 'observe': {
        const waitedMs = command.after === undefined ? 0 : await this.#awaitChange(command.after, deadline)
        const changes = this.#changes
        const observed = await observe(this.#world, command.locator, deadline)
        if ('invalid' in observed) return { ok: false, failure: invalidSelector(observed.invalid, command.locator, undefined) }
        if ('shadow' in observed) return { ok: false, failure: shadowRefused(observed.shadow, command.locator, undefined) }
        return { ok: true, kind: 'observe', observation: observed.observation, page: observed.page, changes, ...(waitedMs > 0 ? { waitedMs } : {}) }
      }
      case 'observePage':
        return this.#observePage(command.after, deadline)
      case 'press':
        return this.#pressKey(command, deadline, dispatch, commandToken)
      case 'tap':
        return { ok: false, failure: noTouchScreen(command) }
      case 'click':
        return this.#pointer(command, 'click', deadline, dispatch, commandToken)
      case 'hover': {
        const input = (target: ReadyTarget) => moveTo(this.#bridge.session, pointOf(target.point), deadline, dispatch)
        return passed('hover', await this.#act({ locator: command.locator, intent: { action: 'hover', multiline: false }, input, commandToken }, deadline))
      }
      case 'fill': {
        const { locator, secret, allowedOrigins } = command
        const intent: GuardedIntent = {
          action: 'fill',
          multiline: /[\n\r]/.test(command.value),
          ...(secret === undefined ? {} : { secret }),
          ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
        }
        const input = () => replaceSelection(this.#bridge.session, command.value, deadline, dispatch)
        return passed('fill', await this.#act({ locator, intent, input, commandToken }, deadline))
      }
      case 'select':
        return this.#select(command, deadline, dispatch, commandToken)
      case 'check':
      case 'uncheck':
        return this.#check(command, deadline, dispatch, commandToken)
      case 'scroll':
        return this.#scroll(command, deadline, dispatch, commandToken)
    }
  }

  // A goto, a reload and a move through the history are the test's own navigations.
  async #opening(commandToken: number | undefined, work: () => Promise<CommandResult>): Promise<CommandResult> {
    this.#ownNavigationDue = true
    try {
      return await this.#causes.opening(commandToken, work)
    } finally {
      this.#ownNavigationDue = false
    }
  }

  // WebKit's protocol has no history to read. The page's Navigation API knows whether an entry of its own origin lies that
  // way, and `history.length` how many entries there are, the empty document every page Retest opens starts with among
  // them. With no entry of its own origin, and none besides that empty one, nothing is sent; otherwise the move goes to
  // WebKit, which refuses it before it navigates when there is no entry.
  async #traverse(kind: Traversal, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const history = await this.#world.call(`function history(back) {
      const can = typeof navigation === 'object' && navigation !== null ? (back ? navigation.canGoBack : navigation.canGoForward) === true : false
      return { can, length: history.length }
    }`, [kind === 'goBack'], historySchema, deadline)
    if (!history.can && history.length <= 2) {
      const where = kind === 'goBack' ? 'back: the page has no earlier' : 'forward: the page has no later'
      return { ok: false, failure: { class: 'not_actionable', message: `Could not go ${where} entry in its history, so Retest sent nothing.` } }
    }
    return this.#opening(commandToken, () => traverse(this.#navigationContext(), kind, deadline, dispatch))
  }

  #navigationContext(): WebKitNavigationContext {
    return {
      baseUrl: this.#setup.baseUrl,
      currentUrl: () => this.#url,
      onFrameEvent: (listener) => this.#frameEvents.add(listener),
      stopped: () => this.#lostReason ?? this.#bridge.blockReason,
      navigate: (url, deadline, dispatch) => dispatch.send(this.#browserSession, 'Playwright.navigate', { url, pageProxyId: this.pageProxyId }, deadline),
      // A move WebKit refuses for want of an entry changed nothing, so it is not counted as input.
      history: (method, deadline, dispatch) => dispatch.attempt(async (attempt) => {
        try {
          await attempt.send(this.#bridge.session, method, {}, deadline)
          return 'sent' as const
        } catch (error) {
          if (error instanceof CdpProtocolError && /^Failed to go (back|forward)/.test(error.protocolMessage)) return 'no_entry' as const
          throw error
        }
      }, (sent) => sent === 'sent'),
      opened: (loaderId) => this.#causes.opened(loaderId),
    }
  }

  async #withLoadedPage(result: CommandResult, deadline: Deadline): Promise<CommandResult> {
    if (!result.ok || !isNavigationKind(result.kind) || !('url' in result)) return result
    return { ...result, page: await this.#loadedPage(result.url, deadline) }
  }

  async #loadedPage(url: string, deadline: Deadline): Promise<PageFacts> {
    if (this.#pendingNavigation !== undefined) return { url }
    try {
      const budget = new Deadline(Math.min(loadedPageReadMs, deadline.remainingMs), { signal: deadline.signal })
      return pageFactsOf(await this.#world.call(pageFactsFunction, [], documentFactsSchema, budget))
    } catch {
      return { url }
    }
  }

  async #observePage(after: ObserveAfter | undefined, deadline: Deadline): Promise<CommandResult> {
    const waitedMs = after === undefined ? 0 : await this.#awaitChange(after, deadline)
    const changes = this.#changes
    const blocked = this.#blocked(readCommand, false)
    if (blocked !== undefined) return { ok: false, failure: blocked }
    const observation = await this.#lookAtPage(deadline)
    const base = this.#setup.baseUrl === undefined ? null : URL.parse(this.#setup.baseUrl)
    const baseUrl = base === null || !isWebUrl(base) ? {} : { baseUrl: originAndPath(base) }
    const url = this.#address()
    const title = observation.title === null ? undefined : pageTitleOf(observation.title)
    const page = url === undefined ? {} : { page: title === undefined ? { url } : { url, title } }
    return { ok: true, kind: 'observePage', observation, ...baseUrl, changes, ...(waitedMs > 0 ? { waitedMs } : {}), ...page }
  }

  async #lookAtPage(deadline: Deadline): Promise<PageObservation> {
    const held: PageObservation = { url: this.#url?.href ?? null, title: null }
    if (this.#pendingNavigation !== undefined) return held
    const navigating = new AbortController()
    const stopListening = this.#navigationStarts.add(() => navigating.abort())
    try {
      const signal = deadline.signal === undefined ? navigating.signal : AbortSignal.any([deadline.signal, navigating.signal])
      const { url, title, cut } = await this.#world.call(pageLookFunction, [], pageLookSchema, new Deadline(deadline.remainingMs, { signal }))
      return cut.length === 0 ? { url, title } : { url, title, cut }
    } catch (error) {
      if (navigating.signal.aborted) return held
      throw error
    } finally {
      stopListening()
    }
  }

  async #pointer(command: PointerAction, action: Pointer, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const input = (target: ReadyTarget) => clickAt(this.#bridge.session, pointOf(target.point), deadline, dispatch)
    return passed(action, await this.#act({ locator: command.locator, intent: { action, multiline: false }, input, commandToken }, deadline))
  }

  async #pressKey(command: Extract<BrowserCommand, { kind: 'press' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const parsed = parseKey(command.key)
    if (!parsed.ok) return { ok: false, failure: parsed.failure }
    const { locator, key } = command
    const input = () => pressKey(this.#bridge.session, parsed.key, deadline, dispatch)
    const intent: GuardedIntent = { action: 'press', key, strokes: keyStrokes(parsed.key), multiline: false }
    return passed('press', await this.#act({ locator, intent, input, commandToken }, deadline))
  }

  async #check(command: Extract<BrowserCommand, { kind: 'check' | 'uncheck' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const { kind, locator } = command
    const pointer: Pointer = 'click'
    const intent = { action: kind, pointer, multiline: false }
    const input = (target: ReadyTarget) => clickAt(this.#bridge.session, pointOf(target.point), deadline, dispatch)
    const acted = await this.#act({ locator, intent, input, commandToken }, deadline)
    if (!acted.ok) return acted
    if (acted.kind === 'unchanged') return { ok: true, kind, changed: false, page: acted.page }
    const failure = await awaitCheckedState({ world: this.#world, locator, intent, via: acted.via, deadline })
    if (failure !== undefined) return { ok: false, failure }
    return { ok: true, kind, changed: true, ...(acted.via === undefined ? {} : { via: acted.via }), page: acted.page }
  }

  async #scroll(command: Extract<BrowserCommand, { kind: 'scroll' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const problem = scrollProblem(command)
    if (problem !== undefined) return { ok: false, failure: problem }
    const input = ({ point, scale }: ReadyTarget) => wheelAt(this.#bridge.session, pointOf(point), { x: command.x * scale, y: command.y * scale }, deadline, dispatch)
    return passed('scroll', await this.#act({ locator: command.locator, intent: { action: 'scroll', multiline: false }, input, commandToken }, deadline))
  }

  // As Chromium's: a select is chosen with the keyboard while it is closed. WebKit on macOS opens a select's menu for
  // its arrow keys and Space, so a select that takes one option is only ever typed into, as the shared plan does.
  async #select(command: Extract<BrowserCommand, { kind: 'select' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const problem = optionChoicesProblem(command.choices)
    if (problem !== undefined) return { ok: false, failure: problem }
    const { locator } = command
    const intent = selectIntent(command)
    for (;;) {
      const target = await waitUntilActionable({ world: this.#world, locator, intent, deadline, pendingNavigation: () => this.#pendingNavigation })
      if (!target.ok) return target
      if (target.kind === 'unchanged') return { ok: true, kind: 'select', changed: false, page: target.page }
      if (this.#pendingNavigation !== undefined) continue
      if (target.plan === null) throw new Error("Retest's page script readied a select without the keys that choose it")
      const request: ListPlanRequest = { choices: command.choices, element: pinnedList.getStore() ?? null }
      const list = await this.#world.callIn(target.context, listPlanFunction, locatorArguments(locator, [request]), listPlanSchema, deadline).catch((error: unknown) => {
        if (isGoneContext(error)) return { status: 'lost' as const }
        throw error
      })
      if (list.status === 'lost') continue
      if (list.status === 'moved') return { ok: false, failure: movedList(locator, intent) }
      if (list.status === 'apart' || list.status === 'detour' || list.status === 'unreachable') return { ok: false, failure: listRefused(list.status, locator, intent) }
      const keys = list.status === 'planned' ? list.keys.map(listKey) : target.plan.keys.map(plannedKey)
      const quietMs = list.status === 'planned' ? 0 : target.plan.quietMs
      const typed = await this.#typeSelection({ locator, intent, keys, quietMs, document: target.context, commandToken }, deadline, dispatch)
      if (typed !== undefined) return typed
    }
  }

  async #typeSelection({ locator, intent, keys, quietMs: quiet, document, commandToken }: Typing, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult | undefined> {
    const quietMs = Math.min(quiet, deadline.remainingMs)
    if (quietMs > 0) await sleep(quietMs, undefined, { signal: deadline.signal })
    let token: number | null = null
    const heard: (Selection | undefined)[] = []
    for (const [index, key] of keys.entries()) {
      const typed: KeysTyped = { locator, intent, sent: index, of: keys.length, heard: lastHeard(heard) }
      if (token !== null && (await pageSetOff(this.#world, { document, token }, deadline))) return selectionLeft(typed)
      const typing: GuardedIntent = { ...intent, typing: { strokes: keyStrokes(key) } }
      const acting = { locator, intent: typing, input: () => pressKey(this.#bridge.session, key, deadline, dispatch), commandToken }
      const seeing = await this.#actSeeing(acting, document, deadline)
      if (!('target' in seeing)) return index === 0 ? undefined : selectionLeft(typed)
      const { target, verdict } = seeing
      if (!target.ok) return index === 0 ? target : { ok: false, failure: selectionCut(typed, target.failure) }
      if (target.kind === 'unchanged') return { ok: true, kind: 'select', changed: index > 0, page: target.page }
      token = target.token
      heard.push(verdict?.kind === 'seen' ? verdict.selection : undefined)
    }
    return this.#awaitSelection({ locator, intent, document, heard: lastHeard(heard) }, deadline)
  }

  async #awaitSelection({ locator, intent, document, heard }: AwaitedSelection, deadline: Deadline): Promise<CommandResult> {
    let last: Selection | undefined
    for (let attempt = 0; ; attempt += 1) {
      const finalRead = deadline.reached
      let read: Selection | undefined
      try {
        read = await readSelection(this.#world, { locator, choices: intent.choices, document }, deadline)
      } catch (error) {
        if (!(error instanceof CdpTimeoutError)) throw error
        if (finalRead) break
        await waitBeforeRead(deadline, Math.min(firstSelectionPauseMs * 2 ** attempt, maxSelectionPauseMs))
        continue
      }
      const gone = read === undefined || read.status === 'lost'
      if (gone && heard?.status === 'selected') return { ok: true, kind: 'select', changed: true, page: heard.page }
      if (read === undefined) return selectionLeft({ locator, intent, sent: 0, of: 0, heard })
      last = read
      if (last.status === 'selected') return { ok: true, kind: 'select', changed: true, page: last.page }
      if (finalRead) break
      await waitBeforeRead(deadline, Math.min(firstSelectionPauseMs * 2 ** attempt, maxSelectionPauseMs))
    }
    return { ok: false, failure: selectionStayed(locator, intent, last) }
  }

  async #act(acting: Acting, deadline: Deadline): Promise<ActionTarget> {
    const seeing = await this.#actSeeing(acting, undefined, deadline)
    if (!('target' in seeing)) throw new Error("Retest's action moved on from a document it was not bound to")
    return seeing.target
  }

  // Input goes to whatever document the frame holds when the browser processes it, so a target readied while the
  // browser has begun another navigation is let go, and the element is looked for again once that navigation is over.
  async #actSeeing({ locator, intent, input, commandToken }: Acting, document: number | undefined, deadline: Deadline): Promise<Seeing | MovedOn> {
    const wait = { world: this.#world, locator, intent, deadline, pendingNavigation: () => this.#pendingNavigation }
    for (;;) {
      const target = await waitUntilActionable(wait)
      if (!target.ok) return { target, verdict: undefined }
      const elsewhere = document !== undefined && target.context !== document
      if (target.kind === 'unchanged') return elsewhere ? { movedOn: true } : { target, verdict: undefined }
      const guard = guardOf(target)
      if (elsewhere) {
        await disarmGuard(this.#world, guard, deadline)
        return { movedOn: true }
      }
      if (this.#pendingNavigation !== undefined) {
        await disarmGuard(this.#world, guard, deadline)
        continue
      }
      const verdict = await this.#causes.delivering(commandToken, () => guardInput(this.#world, guard, deadline, () => input(target)))
      const failure = guardFailure(verdict, intent, locator)
      return { target: failure === undefined ? target : { ok: false, failure }, verdict }
    }
  }

  #address(): string | undefined {
    return this.#url === undefined ? undefined : originAndPath(this.#url)
  }

  async #currentStorage(deadline: Deadline): Promise<StoredOrigin | undefined> {
    const url = this.#url
    if (url === undefined || !this.#origins.has(url.origin)) return undefined
    return (await readLocalStorage(this.#world, deadline)) ?? undefined
  }

  #blocked(command: string, inputSent: boolean): Failure | undefined {
    if (this.#lostReason !== undefined) return connectionEnded(command, inputSent, this.#lostReason)
    if (this.#dialog !== undefined) return dialogOpened(command, this.#dialog, inputSent)
    return undefined
  }

  #describe(command: BrowserCommand): string {
    switch (command.kind) {
      case 'goto': {
        const target = URL.parse(command.url, this.#setup.baseUrl)
        return `open ${target === null ? JSON.stringify(command.url) : originAndPath(target)}`
      }
      case 'reload':
        return 'reload the page'
      case 'goBack':
        return 'go back'
      case 'goForward':
        return 'go forward'
      case 'observe':
        return `read ${describeLocator(command.locator)}`
      case 'observePage':
        return readCommand
      case 'hover':
        return `hover ${describeLocator(command.locator)}`
      case 'click':
        return `click ${describeLocator(command.locator)}`
      case 'fill': {
        const { secret } = command
        return `fill ${describeLocator(command.locator)}${secret === undefined ? '' : ` with ${secretPlaceholder(secret)}`}`
      }
      case 'tap':
        return `tap ${describeLocator(command.locator)}`
      case 'press':
        return describeAction({ action: 'press', key: command.key, strokes: 1, multiline: false }, command.locator)
      case 'select':
        return describeAction(selectIntent(command), command.locator)
      case 'check':
      case 'uncheck':
      case 'scroll':
        return describeAction({ action: command.kind, pointer: 'click', multiline: false }, command.locator)
    }
  }

  async #awaitChange(after: ObserveAfter, deadline: Deadline): Promise<number> {
    const waitMs = Math.min(after.waitMs, deadline.remainingMs)
    if (this.#changes > after.changes || waitMs <= 0 || this.#lostReason !== undefined) return 0
    const startedAt = Date.now()
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        this.#changeWaiters.delete(wake)
        clearTimeout(timer)
        deadline.signal?.removeEventListener('abort', wake)
        resolve()
      }
      const timer = setTimeout(wake, waitMs)
      this.#changeWaiters.add(wake)
      deadline.signal?.addEventListener('abort', wake, { once: true })
    })
    return Date.now() - startedAt
  }

  #changed(): void {
    this.#changes += 1
    this.#wake()
  }

  #wake(): void {
    for (const wake of [...this.#changeWaiters]) wake()
  }

  async #settleReady(timeoutMs: number, command: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new BrowserError({ class: 'timeout', message: `Could not ${command} within ${timeoutMs} ms: the page was not ready.` })), Math.max(1, timeoutMs))
    })
    try {
      await Promise.race([this.ready, late])
    } finally {
      clearTimeout(timer)
    }
  }

  async #dispose(deadline: Deadline): Promise<void> {
    this.#lostReason ??= 'the page was closed'
    this.#bridge.close(this.#lostReason)
    this.#titles.dispose()
    this.#wake()
    // A context whose deletion fails leaves its page proxy behind; the page hears nothing of it from now on.
    for (const stop of this.#stopListening) stop()
    if (this.#connection.closeReason !== undefined) return
    try {
      await this.#connection.send('Playwright.deleteContext', { browserContextId: this.browserContextId }, { timeoutMs: deadline.commandTimeoutMs })
    } catch (error) {
      if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return
      throw new BrowserError({ class: 'cleanup_failed', message: `Could not close the page's browser context: ${errorMessage(error)}` }, { cause: error })
    }
  }

  #operationError(command: string, error: unknown, timeoutMs: number): unknown {
    if (error instanceof BrowserError) return error
    const blocked = this.#blocked(command, false)
    if (blocked !== undefined) return new BrowserError(blocked, { cause: error })
    if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return new BrowserError(connectionEnded(command, false, error.reason), { cause: error })
    if (error instanceof CdpTimeoutError) return new BrowserError({ class: 'timeout', message: `Could not ${command} within ${timeoutMs} ms.` }, { cause: error })
    return error
  }

  #onPageProxyEvent(event: PageProxyEvent): void {
    this.#proxyEvents.emit(event)
    const { method, params } = event
    if (method === 'Target.targetCreated') this.#targetCreated(params)
    else if (method === 'Target.didCommitProvisionalTarget') this.#committedTarget(params)
    else if (method === 'Target.targetDestroyed') this.#targetDestroyed(params)
    else if (method === 'Dialog.javascriptDialogOpening') this.#dialogOpened(params)
    else if (method === 'Dialog.javascriptDialogClosed') this.#dialogClosed()
  }

  #onTargetEvent(event: TargetEvent): void {
    const { targetId, method, params } = event
    if (targetId !== this.#targetId && targetId !== this.#provisionalTargetId) return
    this.#events.emit(event)
    switch (method) {
      case 'Runtime.executionContextCreated':
        this.#bridge.contextCreated(targetId, params)
        return
      case 'Runtime.bindingCalled':
        if (readProtocol(bindingSchema, params, { method }).name === changeBinding) this.#changed()
        return
      case 'Page.frameNavigated':
        this.#frameNavigated(targetId, params)
        return
      case 'Page.navigatedWithinDocument':
        this.#navigatedWithinDocument(params)
        return
      case 'Page.willCheckNavigationPolicy':
        this.#navigationChecked(params)
        return
      case 'Page.didCheckNavigationPolicy':
        this.#navigationDecided(params)
        return
      case 'Page.loadEventFired':
        this.#loaded(params)
        return
      case 'Page.domContentEventFired':
        if (readProtocol(frameSchema, params, { method }).frameId === this.#mainFrameId && this.#loaderId !== undefined) this.#titles.contentLoaded(this.#loaderId)
        return
      case 'Network.requestWillBeSent':
        this.#documentRequested(targetId, params)
        return
      case 'Network.requestIntercepted':
        this.#serveEmptyDocument(targetId, params)
        return
      case 'Network.loadingFinished':
        this.#documentRequests.delete(readProtocol(requestEndSchema, params, { method }).requestId)
        return
      case 'Network.loadingFailed':
        this.#documentFailed(params)
        return
    }
  }

  // A page target starts paused, so every domain, Retest's user world, the change binding and the relay are in place
  // before its first document runs a script. A target of another kind is let run and left alone.
  #targetCreated(params: unknown): void {
    const { targetInfo } = readProtocol(targetInfoSchema, params, { method: 'Target.targetCreated' })
    const { targetId } = targetInfo
    const provisional = targetInfo.isProvisional === true
    if (targetInfo.type !== 'page') {
      if (targetInfo.isPaused === true) this.#connection.sendToPageProxy(this.pageProxyId, 'Target.resume', { targetId }).catch(() => undefined)
      return
    }
    if (provisional) this.#provisionalTargetId = targetId
    else {
      this.#targetId = targetId
      this.#bridge.committed(targetId)
    }
    this.#attach(targetId, provisional, targetInfo.isPaused === true).then(
      () => {
        if (!provisional) this.#readyResolvers.resolve()
      },
      (error: unknown) => {
        if (!provisional) this.#readyResolvers.reject(new BrowserError({ class: 'setup_failed', message: `Could not set up the page: ${errorMessage(error)}` }, { cause: error }))
      },
    )
  }

  async #attach(targetId: string, provisional: boolean, paused: boolean): Promise<void> {
    // A page whose setup has not come stays paused; one lost meanwhile ends here, as its ready promise says.
    await Promise.race([this.#setupApplied, this.ready.then(() => this.#setupApplied)])
    const options = { timeoutMs: setupTimeoutMs }
    const send = (method: string, params?: object) => this.#connection.sendToTarget(this.pageProxyId, targetId, method, params, options)
    const { userAgent } = this.#setup.screen
    await Promise.all([
      send('Page.enable'),
      send('Runtime.enable'),
      send('Network.enable'),
      send('Console.enable'),
      send('Page.createUserWorld', { name: worldName }),
      send('Runtime.addBinding', { name: changeBinding }),
      send('Page.setBootstrapScript', { source: bootstrapScript(this.#secret) }),
      // A desktop page has no touch screen, as Chromium's has none unless one is emulated.
      send('Page.setTouchEmulationEnabled', { enabled: false }),
      ...(userAgent === undefined ? [] : [send('Page.overrideUserAgent', { value: userAgent })]),
    ])
    // The debugger names the context each script was parsed in, which is how a console message, which names only its
    // script, is known to be a frame's; it never pauses the page. Measured on build 2359: no cost to a page's script.
    await send('Debugger.enable')
    await Promise.all([
      send('Debugger.setBreakpointsActive', { active: false }),
      send('Debugger.setPauseOnDebuggerStatements', { enabled: false }),
      send('Debugger.setPauseOnExceptions', { state: 'none' }),
      send('Debugger.setPauseOnAssertions', { enabled: false }),
    ])
    if (this.#setup.serveEmptyDocuments === true) {
      await send('Network.setInterceptionEnabled', { enabled: true })
      await send('Network.addInterception', { url: '.*', stage: 'request', isRegex: true })
    }
    if (!provisional && !this.#proxyReady) {
      this.#proxyReady = true
      const proxy = (method: string, params?: object) => this.#connection.sendToPageProxy(this.pageProxyId, method, params, options)
      const { viewport, deviceScaleFactor } = this.#setup.screen
      await Promise.all([
        proxy('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, fixedLayout: false, deviceScaleFactor }),
        proxy('Emulation.setActiveAndFocused', { active: true }),
        proxy('Dialog.enable'),
      ])
    }
    if (paused) await this.#connection.sendToPageProxy(this.pageProxyId, 'Target.resume', { targetId }, options)
    if (provisional) return
    const { frameTree } = readProtocol(resourceTreeSchema, await send('Page.getResourceTree'), { method: 'Page.getResourceTree' })
    if (this.#mainFrameId === '') this.#holdFrame(frameTree.frame)
  }

  #committedTarget(params: unknown): void {
    const { newTargetId } = readProtocol(committedSchema, params, { method: 'Target.didCommitProvisionalTarget' })
    if (newTargetId !== this.#provisionalTargetId) {
      this.markClosed(`the browser committed target ${newTargetId}, which was not the provisional one, so the page's document is unknown`)
      return
    }
    this.#targetId = newTargetId
    this.#provisionalTargetId = undefined
    this.#bridge.committed(newTargetId)
  }

  #targetDestroyed(params: unknown): void {
    const { targetId, crashed } = readProtocol(destroyedSchema, params, { method: 'Target.targetDestroyed' })
    this.#bridge.targetGone(targetId)
    if (targetId === this.#provisionalTargetId) {
      this.#provisionalTargetId = undefined
      return
    }
    if (targetId === this.#targetId && crashed === true) this.markClosed('the page crashed', true)
  }

  #dialogOpened(params: unknown): void {
    const { type } = readProtocol(dialogSchema, params, { method: 'Dialog.javascriptDialogOpening' })
    this.#dialog = type
    const reason = `a JavaScript ${type} dialog holds the page`
    this.#bridge.block(reason)
    this.#frameEvents.emit({ kind: 'stopped', reason })
  }

  #dialogClosed(): void {
    this.#dialog = undefined
    if (this.#lostReason === undefined) this.#bridge.unblock()
  }

  // WebKit checks a navigation's policy before it begins it, and names no address then: the main frame's document
  // request names it a moment later. A navigation the page begins while an action is delivered is the action's; the
  // first one an opening command checks is that command's own.
  #navigationChecked(params: unknown): void {
    const { frameId } = readProtocol(frameSchema, params, { method: 'Page.willCheckNavigationPolicy' })
    if (frameId !== this.#mainFrameId) return
    if (this.#ownNavigationDue) this.#ownNavigationDue = false
    else this.#causes.requested(pageRequested)
    this.#pendingNavigation ??= { url: 'another document' }
    this.#navigationStarts.emit(this.#pendingNavigation.url)
  }

  // A navigation cancelled at its policy check never begins, unless it went on in a new web process: WebKit cancels it
  // in the old one when it swaps the page into a provisional target.
  #navigationDecided(params: unknown): void {
    const { frameId, cancel } = readProtocol(policySchema, params, { method: 'Page.didCheckNavigationPolicy' })
    if (frameId !== this.#mainFrameId || cancel !== true || this.#provisionalTargetId !== undefined) return
    this.#pendingNavigation = undefined
    this.#causes.stoppedLoading()
  }

  // The main frame's document request, or the first one of a provisional target, whose page is the main frame's.
  #documentRequested(targetId: string, params: unknown): void {
    if (!isRecord(params) || params['type'] !== 'Document') return
    const request = readProtocol(requestSchema, params, { method: 'Network.requestWillBeSent' })
    const provisional = targetId === this.#provisionalTargetId && this.#pendingNavigation !== undefined
    if (request.frameId !== this.#mainFrameId && !provisional) return
    this.#loaderUrls.set(request.loaderId, request.request.url)
    this.#documentRequests.set(request.requestId, request.loaderId)
    if (this.#pendingNavigation !== undefined) this.#pendingNavigation = { url: request.request.url }
    if (request.redirectResponse !== undefined || this.#startedLoaders.has(request.loaderId)) return
    this.#startedLoaders.add(request.loaderId)
    this.#causes.started(pageRequested, request.loaderId)
  }

  // WebKit reports a navigation it gives up without a document, as it does a response with no content, with
  // `Playwright.provisionalLoadFailed` only for some navigations: a move through the history onto one names it only by
  // the failed request of its document. A request that fails after its document committed leaves that document.
  #documentFailed(params: unknown): void {
    const { requestId, errorText } = readProtocol(requestFailedSchema, params, { method: 'Network.loadingFailed' })
    const loaderId = this.#documentRequests.get(requestId)
    if (loaderId === undefined) return
    this.#documentRequests.delete(requestId)
    if (loaderId !== this.#loaderId) this.provisionalLoadFailed(loaderId, errorText)
  }

  // A page Retest opened for its own use answers every request itself, with an empty document, so nothing reaches the site.
  #serveEmptyDocument(targetId: string, params: unknown): void {
    if (this.#setup.serveEmptyDocuments !== true) return
    const { requestId } = readProtocol(interceptedSchema, params, { method: 'Network.requestIntercepted' })
    const response = { requestId, content: '', base64Encoded: false, mimeType: 'text/html', status: 200, statusText: 'OK', headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    this.#connection.sendToTarget(this.pageProxyId, targetId, 'Network.interceptRequestWithResponse', response).catch(() => {
      // A request left unanswered fails the navigation waiting on it, which reports the problem.
    })
  }

  #loaded(params: unknown): void {
    const { frameId } = readProtocol(frameSchema, params, { method: 'Page.loadEventFired' })
    if (frameId !== this.#mainFrameId || this.#loaderId === undefined) return
    this.#frameEvents.emit({ kind: 'loaded', loaderId: this.#loaderId })
  }

  #frameNavigated(targetId: string, params: unknown): void {
    const { frame } = readProtocol(frameNavigatedSchema, params, { method: 'Page.frameNavigated' })
    if (frame.parentId !== undefined) return
    this.#mainFrameId = frame.id
    this.#loaderId = frame.loaderId
    this.#pendingNavigation = undefined
    this.#startedLoaders.clear()
    this.#bridge.mainFrame(targetId, frame.id)
    this.#world.reset()
    this.#changed()
    this.#moveTo(frame.url, frame.loaderId)
    this.#frameEvents.emit({ kind: 'committed', loaderId: frame.loaderId })
  }

  #navigatedWithinDocument(params: unknown): void {
    const { frameId, url } = readProtocol(withinSchema, params, { method: 'Page.navigatedWithinDocument' })
    if (frameId !== this.#mainFrameId) return
    this.#moveTo(url, undefined)
    this.#frameEvents.emit({ kind: 'within' })
  }

  #holdFrame(frame: { id: string; url: string }): void {
    this.#mainFrameId = frame.id
    const targetId = this.#targetId
    if (targetId !== undefined) this.#bridge.mainFrame(targetId, frame.id)
    const url = URL.parse(frame.url) ?? undefined
    if (url === undefined || url.href === this.#url?.href) return
    this.#url = url
    if (isWebUrl(url)) this.#origins.add(url.origin)
  }

  #moveTo(address: string, loaderId: string | undefined): void {
    const url = URL.parse(address)
    if (url === null) throw new Error('The browser reported a main frame address that is not a URL')
    const previous = this.#url
    this.#url = url
    if (isWebUrl(url)) this.#origins.add(url.origin)
    const path = originAndPath(url)
    if (loaderId !== undefined) {
      const start = this.#causes.committed(loaderId)
      this.#navigations.emit({ url: path, title: this.#titles.committed(loaderId), document: 'new', ...start })
    } else if (previous === undefined || originAndPath(previous) !== path) {
      this.#navigations.emit({ url: path, title: this.#titles.movedWithinDocument(), document: 'same', ...this.#causes.movedWithinDocument() })
    }
  }
}

// What a page reads before the browser has said which page it is: nothing reads it then, since a page is handed out only
// once its setup is applied.
const pendingSetup: WebKitPageSetup = { baseUrl: undefined, screen: defaultScreen, restoredOrigins: [] }

// WebKit names no address when it checks a navigation, so the request it begins and the one the page asked for are
// matched by this one name instead.
const pageRequested = 'the navigation the page asked for'

function passed(kind: 'click' | 'tap' | 'fill' | 'hover' | 'press' | 'scroll', acted: ActionTarget): CommandResult {
  return acted.ok ? { ok: true, kind, page: acted.page } : acted
}

function guardOf({ context, token }: ReadyTarget): Guard {
  if (token === null) throw new Error("Retest's page script readied an action without arming its guard")
  return { context, token }
}

type Typing = { locator: LocatorRecipe; intent: Extract<ActionIntent, { action: 'select' }>; keys: readonly Key[]; quietMs: number; document: number; commandToken: number | undefined }
type AwaitedSelection = { locator: LocatorRecipe; intent: Extract<ActionIntent, { action: 'select' }>; document: number; heard: Selection | undefined }
type KeysTyped = { locator: LocatorRecipe; intent: Extract<ActionIntent, { action: 'select' }>; sent: number; of: number; heard: Selection | undefined }
type Seeing = { target: ActionTarget; verdict: GuardVerdict | undefined }
type MovedOn = { movedOn: true }

function lastHeard(heard: readonly (Selection | undefined)[]): Selection | undefined {
  return heard.findLast((each) => each !== undefined)
}

function heldLabels(heard: Selection | undefined): string {
  if (heard === undefined) return ''
  const held = heard.selected.length === 0 ? 'nothing' : heard.selected.map((label) => JSON.stringify(label)).join(', ')
  return `, and the select held ${held} as the last of them arrived`
}

function selectionLeft({ locator, intent, sent, of, heard }: KeysTyped): CommandResult {
  if (heard?.status === 'selected') return { ok: true, kind: 'select', changed: true, page: heard.page }
  const keys = of === 0 ? 'the keys that choose it' : `${sent} of the ${of} keys that choose it`
  return {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: `Could not select ${describeChoices(intent)} in ${describeLocator(locator)}: the page began to open another document after Retest typed ${keys}${heldLabels(heard)}. Retest typed no more.`,
      details: { check: 'selection', inputSent: true },
    },
  }
}

function selectionCut({ sent, of, heard }: KeysTyped, failure: Failure): Failure {
  return { ...failure, message: `${failure.message} Retest had typed ${sent} of the ${of} keys that choose it${heldLabels(heard)}.`, details: { ...failure.details, inputSent: true } }
}

function plannedKey({ key, toggle }: PlannedKey): Key {
  const held: ModifierName[] = toggle ? [listModifier] : []
  const named = namedKeys.find((name) => name === key) ?? (key === ' ' ? 'Space' : undefined)
  return named === undefined ? { kind: 'character', character: key, shift: false, held } : { kind: 'named', name: named, held }
}

// A pinned select whose locator found another list when its keys were planned: the same refusal, in the same words, as
// a look that readies a pinned element and finds another (`moved` in `actionability.ts`, which is not exported).
function movedList(locator: LocatorRecipe, intent: Extract<ActionIntent, { action: 'select' }>): Failure {
  return {
    class: 'not_actionable',
    message: `Could not ${describeAction(intent, locator)}: it finds another element than the one Retest was asked to act on, which the page moved or replaced, and Retest sent nothing to it.`,
    details: { refused: 'moved', inputSent: false },
  }
}

// A WebKit list chooses with Home, End, the arrows and Shift only, so options apart from each other, options away from
// both ends of the list, or one no key reaches, have no keys that choose them and nothing else on the way.
function listRefused(status: 'apart' | 'detour' | 'unreachable', locator: LocatorRecipe, intent: Extract<ActionIntent, { action: 'select' }>): Failure {
  const action = `select ${describeChoices(intent)} in ${describeLocator(locator)}`
  const messages = {
    apart: `Could not ${action}: in WebKit a list that takes several options widens its selection only to the options next to it, with Shift and the arrow keys, and these options are not next to each other. Retest typed nothing.`,
    detour: `Could not ${action}: in WebKit a list that takes several options selects one option alone only from its first or its last, with Home or End, and these options touch neither end, so the keys would select an option nobody asked for on the way, which the page would hear. Retest typed nothing.`,
    unreachable: `Could not ${action}: no key a person can press in this WebKit list reaches what was asked, such as a disabled or hidden option. Retest typed nothing.`,
  }
  const message = messages[status]
  return { class: 'unsupported', message, details: { element: '<select multiple>' } }
}

function selectionStayed(locator: LocatorRecipe, intent: Extract<ActionIntent, { action: 'select' }>, last: Selection | undefined): Failure {
  const action = `select ${describeChoices(intent)} in ${describeLocator(locator)}`
  const after = last === undefined || last.status === 'lost'
    ? 'then no single select it matched still held the options asked for'
    : `the select holds ${last.selected.length === 0 ? 'nothing' : last.selected.map((label) => JSON.stringify(label)).join(', ')}`
  return { class: 'not_actionable', message: `Could not ${action}: Retest typed the keys that choose it, and ${after}. Retest does not type again.`, details: { check: 'selection', inputSent: true } }
}

function selectIntent(command: Extract<BrowserCommand, { kind: 'select' }>): Extract<ActionIntent, { action: 'select' }> {
  return { action: 'select', choices: command.choices, multiple: command.multiple === true, multiline: false }
}

function sameSession(first: RecordIdentity, second: RecordIdentity): boolean {
  return first.testId === second.testId && first.attemptId === second.attemptId && first.app === second.app && first.sessionId === second.sessionId
}

function withTitle(title: string | undefined): { title?: string } {
  return title === undefined ? {} : { title }
}

function pointOf(point: Point | null): Point {
  if (point === null) throw new Error("Retest's page script readied a pointer action without a point")
  return point
}

// A look WebKit kept losing to the page until its time ran out: a timeout, named, and never a count of fewer elements.
function lostReading(command: string, timeoutMs: number, error: LostReadingError, inputSent: boolean): Failure {
  const message = `Could not ${command} within ${timeoutMs} ms: the page removed elements while Retest read its accessibility tree, ${error.attempts} ${error.attempts === 1 ? 'time' : 'times'}, so Retest has no answer it can trust.`
  return { class: 'timeout', message, details: { inputSent } }
}

function noTouchScreen(command: Extract<BrowserCommand, { kind: 'tap' }>): Failure {
  return { class: 'unsupported', message: `Could not tap ${describeLocator(command.locator)}: the page does not emulate a touch screen, and tap() needs one.` }
}

/**
 * The PNG inside a `data:image/png;base64,` URL, as `Page.snapshotRect` answers.
 *
 * @example decodePng('data:image/png;base64,iVBORw0K')
 */
export function decodePng(dataUrl: string): Uint8Array {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) throw new CdpInvalidResponseError({ method: 'Page.snapshotRect', sessionId: undefined }, 'the snapshot is not a PNG data URL')
  return Buffer.from(dataUrl.slice(prefix.length), 'base64')
}

function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}
