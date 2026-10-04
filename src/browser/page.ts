import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { ChromiumCaptureOptions } from './capture.ts'
import type { BrowserCommand, DispatchedCommand, PageNavigation, PageReading, SessionIdentity, TextQuery, WebSession } from './contract.ts'
import type { ActionTarget, PendingNavigation, ReadyTarget } from './actionability.ts'
import type { ActionIntent, PlannedKey, Pointer, SelectPlan, Selection } from './element-queries.ts'
import type { Guard, GuardedIntent, GuardVerdict } from './input-guard.ts'
import type { NavigationContext, Traversal } from './navigation.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../diagnostics/observations.ts'
import type { ObserveAfter, CommandResult, PageObservation } from '../protocol/commands.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { Key, ModifierName } from '../protocol/keys.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { StorageState, StoredOrigin } from '../protocol/storage-state.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { ChromiumCollector } from '../diagnostics/chromium-collector.ts'
import { isNavigationKind } from '../protocol/commands.ts'
import { Deadline, monotonicClock } from '../protocol/deadline.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage } from '../protocol/failures.ts'
import { keyStrokes, namedKeys, parseKey } from '../protocol/keys.ts'
import { describeLocator } from '../protocol/locator.ts'
import { optionChoicesProblem } from '../protocol/option-choices.ts'
import { s } from '../protocol/schema.ts'
import { scrollProblem } from '../protocol/scroll-delta.ts'
import { secretPlaceholder } from '../protocol/secret.ts'
import { isWebUrl } from '../protocol/url.ts'
import { invalidSelector, shadowRefused, waitUntilActionable } from './actionability.ts'
import { BrowserError } from './browser-error.ts'
import { ChromiumFrameSource } from './capture.ts'
import { CdpClosedError, CdpDisconnectedError, CdpInvalidResponseError, CdpProtocolError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { awaitCheckedState } from './checked-state.ts'
import { commandStopped, connectionEnded, dialogOpened, failureFromError } from './command-failures.ts'
import { Dispatch } from './dispatch.ts'
import { documentFactsSchema, pageFactsOf, pageTitleOf } from './document-facts.ts'
import { describeAction, describeChoices, observe, pageSetOff, readSelection } from './element-queries.ts'
import { worldName } from './isolated-world.ts'
import { applyEmulation } from './emulation.ts'
import { clickAt, moveTo, pressKey, replaceSelection, tapAt, wheelAt, type Point } from './input.ts'
import { disarmGuard, guardFailure, guardInput } from './input-guard.ts'
import { IsolatedWorld } from './isolated-world.ts'
import { Listeners } from './listeners.ts'
import { navigate, reload, traverse } from './navigation.ts'
import { NavigationCauses } from './navigation-causes.ts'
import { NavigationTitles } from './navigation-titles.ts'
import { changeScript, guardScript, pageFactsFunction, pageLookFunction, readPageFunction } from './page-scripts.ts'
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

type PointerAction = Extract<BrowserCommand, { kind: 'click' | 'tap' }>

/**
 * An action's input on the element `locator` finds, or, without one, on the document: a key for the page's
 * keyboard, or the wheel at the centre of the viewport. `input` sends it to the target that passed its checks.
 * `commandToken` is the token the action's command was given, which a navigation its input starts carries.
 */
type Acting = {
  locator: LocatorRecipe | undefined
  intent: GuardedIntent
  input: (target: ReadyTarget) => Promise<void>
  commandToken: number | undefined
}

/** A command's own time, the signal that stops it, its token, and the dispatch that records how far its input got. */
type Executing = { timeoutMs: number; signal: AbortSignal | undefined; commandToken: number | undefined; dispatch: Dispatch }

const retryPauseMs = 20
// How long `goto` may spend reading the title of the page it loaded; a page too busy to answer has none.
const loadedPageReadMs = 1000
const firstSelectionPauseMs = 20
const maxSelectionPauseMs = 200
// The modifier that moves the focus of a select that takes several options without changing what it holds.
const listModifier: ModifierName = process.platform === 'darwin' ? 'Meta' : 'Control'
const screenshotCommand = 'take a screenshot'
const captureCommand = 'save the sign-in state'
const readCommand = 'read the page'
const collectCommand = 'collect diagnostics'

const frameTreeSchema = s.object({ frameTree: s.object({ frame: s.object({ id: s.string(), url: s.string() }) }) })
// The function Chrome gives Retest's world in every document, which the change script calls.
const changeBinding = 'retestChanged'
const bindingCalledSchema = s.object({ name: s.string() })

const frameNavigatedSchema = s.object({
  frame: s.object({ id: s.string(), parentId: s.optional(s.string()), url: s.string(), loaderId: s.string() }),
})
const sameDocumentSchema = s.object({ frameId: s.string(), url: s.string() })
const navigatingSchema = s.object({ frameId: s.string(), url: s.string(), loaderId: s.string(), navigationType: s.string() })
const requestedSchema = s.object({ frameId: s.string(), url: s.string(), disposition: s.string() })
const lifecycleSchema = s.object({ frameId: s.string(), loaderId: s.string(), name: s.string() })
const frameSchema = s.object({ frameId: s.string() })
const readingSchema = s.object({ found: s.array(s.boolean()), title: s.string(), body: s.boolean() })
const pageLookSchema = s.object({ url: s.string(), title: s.string(), cut: s.array(s.enum(['url', 'title'])) })
const screenshotSchema = s.object({ data: s.string() })
const dialogSchema = s.object({ type: s.string() })

// Navigations that keep the document. Any other replaces it when it commits.
const withinDocument: ReadonlySet<string> = new Set(['sameDocument', 'historySameDocument'])

/** One page in a browser context of its own: a web session. */
export class ChromiumPage implements WebSession {
  readonly #connection: CdpConnection
  readonly #session: CdpSession
  readonly #browserContextId: string
  readonly #baseUrl: string | undefined
  readonly #world: IsolatedWorld
  readonly #navigations: Listeners<PageNavigation>
  readonly #navigationStarts: Listeners<string>
  readonly #touch: boolean
  readonly #proxyServer: string | undefined
  readonly #causes = new NavigationCauses()
  // Every look waiting for the document to change, each woken by the next change, its own timer or the page's end.
  readonly #changeWaiters = new Set<() => void>()
  // How many times the document changed, as its observer told, counting each new document.
  #changes = 0
  readonly #titles: NavigationTitles
  // The http and https origins the main frame opened, and those the restored state held, in the order they came.
  readonly #origins: Set<string>
  #mainFrameId: string
  #url: URL | undefined
  // How many commits of the main frame the page has been told, so a read of the frame that was overtaken is not kept.
  #commits = 0
  #pendingNavigation: PendingNavigation | undefined
  #lostReason: string | undefined
  #dialog: string | undefined
  #disposing: Promise<void> | undefined
  // The session this page is, once the runner has named it; what its captures are recorded as.
  #identity: RecordIdentity | undefined

  /**
   * Applies the page's emulation, reads its main frame, then follows it through the events this enables, and has
   * every document it opens install Retest's input guard and its change observer before the page's own scripts run.
   * The frame is read again once its events are on, since a document that committed before that, as an app's own
   * window commits its first, is told by no event.
   *
   * @example const page = await ChromiumPage.open({ connection, session, browserContextId, baseUrl, emulation, restoredOrigins: [], onListenerError }, deadline)
   */
  static async open(options: PageOptions, deadline: Deadline): Promise<ChromiumPage> {
    const { session, emulation } = options
    if (emulation !== undefined) await applyEmulation(session, emulation, deadline)
    const { frameTree } = await request(session, 'Page.getFrameTree', undefined, frameTreeSchema, sendOptions(deadline))
    const page = new ChromiumPage(options, frameTree.frame)
    await request(session, 'Page.enable', undefined, s.object({}), sendOptions(deadline))
    // A commit told while the frame is read again is at least as new as the read, so the read is kept only without one.
    const commits = page.#commits
    const current = await request(session, 'Page.getFrameTree', undefined, frameTreeSchema, sendOptions(deadline))
    if (page.#commits === commits) page.#holdFrame(current.frameTree.frame)
    await request(session, 'Page.setLifecycleEventsEnabled', { enabled: true }, s.object({}), sendOptions(deadline))
    // Chrome delivers a binding's calls only while the Runtime domain is enabled (fact F7 of the speed plan), so it is
    // enabled here, as Playwright and Puppeteer enable it on every page. Its other events have no listeners and are dropped.
    await request(session, 'Runtime.enable', undefined, s.object({}), sendOptions(deadline))
    await request(session, 'Runtime.addBinding', { name: changeBinding, executionContextName: worldName }, s.object({}), sendOptions(deadline))
    await page.#world.addScript(guardScript, deadline)
    await page.#world.addScript(changeScript, deadline)
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
    // A title is read from the document the page holds, which answers only while no other document is on its way,
    // and while the page is neither lost nor held by a dialog.
    this.#titles = new NavigationTitles({
      readable: () => this.#pendingNavigation === undefined && this.#lostReason === undefined && this.#dialog === undefined,
      read: async (deadline) => pageTitleOf((await this.#world.call(pageFactsFunction, [], documentFactsSchema, deadline)).title),
    })
    this.#session.on('Page.frameNavigated', (params) => this.#frameNavigated(params))
    this.#session.on('Page.navigatedWithinDocument', (params) => this.#navigatedWithinDocument(params))
    this.#session.on('Page.frameRequestedNavigation', (params) => this.#navigationRequested(params))
    this.#session.on('Page.frameStartedNavigating', (params) => this.#navigationStarted(params))
    this.#session.on('Page.frameStoppedLoading', (params) => this.#loadingStopped(params))
    this.#session.on('Page.lifecycleEvent', (params) => this.#lifecycle(params))
    this.#session.on('Runtime.bindingCalled', (params) => {
      const { name } = readProtocol(bindingCalledSchema, params, { method: 'Runtime.bindingCalled', sessionId: this.#session.id })
      if (name === changeBinding) this.#changed()
    })
    // A crashed page and one a dialog holds answer nothing, so commands waiting on them fail at once.
    this.#session.on('Inspector.targetCrashed', () => {
      this.#lostReason ??= 'the page crashed'
      this.#session.block('the page crashed')
      this.#titles.dispose()
      this.#wake()
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
      this.#titles.dispose()
      this.#wake()
    })
  }

  get url(): string | undefined {
    return this.#address()
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult> {
    return (await this.dispatch(command, timeoutMs, signal, commandToken)).result
  }

  // The answer is read from the dispatch once the command has settled, so it says how far the input got by then.
  async dispatch(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand> {
    const dispatch = new Dispatch()
    const result = await this.#execute(command, { timeoutMs, signal, commandToken, dispatch })
    return { result, input: dispatch.input }
  }

  /** A capture names this page\'s runner session beside its Chromium source. */
  async capture(timeoutMs: number): Promise<{ readonly ok: true; readonly capture: { readonly png: Uint8Array; readonly source: 'chromium'; readonly reference: { readonly sessionId: string }; readonly capturedAt: string } } | { readonly ok: false; readonly failure: Failure }> {
    if (this.#identity === undefined) return { ok: false, failure: { class: 'unsupported', message: 'The runner has not named this page\'s session, so no capture can be attributed to it.' } }
    try {
      const png = await this.screenshot(timeoutMs)
      return { ok: true, capture: { png, source: 'chromium', reference: { sessionId: this.#identity.sessionId }, capturedAt: new Date().toISOString() } }
    } catch (error) {
      if (error instanceof BrowserError) return { ok: false, failure: error.failure }
      throw error
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
   * the read, the reading says `navigating`, and `found` is empty: nothing was read. An answer that does not answer
   * each query once is refused: only Retest's own function answers, so it is a fault of the browser.
   */
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
          const source = { method: 'Runtime.callFunctionOn', sessionId: this.#session.id }
          throw new CdpInvalidResponseError(source, `it answered ${found.length} of ${queries.length} text queries`)
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
   * Collects the page's console messages, runtime errors and network metadata from its own session. The collector's
   * listeners are added before its domains are enabled, so nothing after this call is missed. Sends no input.
   */
  async collectDiagnostics(sink: DiagnosticSink, timeoutMs: number): Promise<DiagnosticCollection> {
    const blocked = this.#blocked(collectCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    const collector = new ChromiumCollector({ session: this.#session, mainFrameId: () => this.#mainFrameId, sink })
    try {
      await collector.start(timeoutMs)
    } catch (error) {
      throw this.#operationError(collectCommand, error, timeoutMs)
    }
    return collector
  }

  /**
   * Names the session this page is, as the runner holds it: its id and the test, attempt and app that hold it. A page is
   * one session for its whole life, so naming it again as another throws, and so does an id that is not the attempt's
   * and the app's.
   *
   * @example page.identify(appPage.session)
   */
  identify(session: SessionIdentity): void {
    const { sessionId, owner } = session
    const expected = formatSessionId(owner.attemptId, owner.app)
    if (sessionId !== expected) throw new Error(`A session of attempt ${owner.attemptId} and app ${owner.app} is ${expected}, not ${sessionId}.`)
    const identity = { testId: owner.testId, attemptId: owner.attemptId, app: owner.app, sessionId }
    const known = this.#identity
    if (known !== undefined && !sameSession(known, identity)) throw new Error(`This page is session ${known.sessionId} of ${JSON.stringify(known.testId)}; it cannot become ${sessionId}.`)
    this.#identity = identity
  }

  /**
   * A frame source for the media process over this page's own session: Chrome's screencast of this page alone. Its
   * frames carry the page's own identity, as `identify` named it. The caller names the session it means to record, and a
   * page not yet named, or named as another session, gives a source that is unavailable and says why, so one page is
   * never recorded as another's session. Nothing is captured until it starts. Sends no input.
   */
  frameSource(identity: RecordIdentity, options?: ChromiumCaptureOptions): ChromiumFrameSource {
    const own = this.#identity
    if (own === undefined) return new ChromiumFrameSource(this.#session, identity, options, `Retest has not named the session this page is, so it records nothing as ${identity.sessionId}.`)
    if (!sameSession(own, identity)) {
      const refused = `This page is session ${own.sessionId} of ${JSON.stringify(own.testId)}, not ${identity.sessionId} of ${JSON.stringify(identity.testId)}, so Retest records nothing of it as that session.`
      return new ChromiumFrameSource(this.#session, own, options, refused)
    }
    return new ChromiumFrameSource(this.#session, own, options)
  }

  dispose(timeoutMs: number): Promise<void> {
    this.#disposing ??= this.#dispose(new Deadline(timeoutMs))
    return this.#disposing
  }

  async #execute(command: BrowserCommand, { timeoutMs, signal, commandToken, dispatch }: Executing): Promise<CommandResult> {
    const deadline = new Deadline(timeoutMs, { signal })
    const described = this.#describe(command)
    try {
      await this.#titles.settle(deadline)
      signal?.throwIfAborted()
      const blocked = this.#blocked(described, false)
      if (blocked !== undefined) return { ok: false, failure: blocked }
      const result = await this.#run(command, deadline, dispatch, commandToken)
      return result.ok ? result : { ok: false, failure: this.#blocked(described, dispatch.sent) ?? result.failure }
    } catch (error) {
      if (signal?.aborted === true) return { ok: false, failure: commandStopped(described, dispatch.sent, signal.reason) }
      const failure = this.#blocked(described, dispatch.sent) ?? failureFromError(error, { command: described, timeoutMs, inputSent: dispatch.sent })
      return { ok: false, failure }
    }
  }

  async #run(command: BrowserCommand, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    switch (command.kind) {
      case 'goto':
        return this.#goto(command.url, deadline, dispatch, commandToken)
      case 'reload':
      case 'goBack':
      case 'goForward':
        return this.#history(command.kind, deadline, dispatch, commandToken)
      case 'observe': {
        const waitedMs = command.after === undefined ? 0 : await this.#awaitChange(command.after, deadline)
        // Counted before the read, so a change during it is seen by the next look.
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
        if (!this.#touch) return { ok: false, failure: noTouchScreen(command) }
        return this.#pointer(command, 'tap', deadline, dispatch, commandToken)
      case 'click':
        return this.#pointer(command, this.#pointerInput(), deadline, dispatch, commandToken)
      case 'hover': {
        const input = (target: ReadyTarget) => moveTo(this.#session, pointOf(target.point), deadline, dispatch)
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
        const input = () => replaceSelection(this.#session, command.value, deadline, dispatch)
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

  // Page.navigate raises no request, so a navigation it starts is the goto's (fact F12). The page it loaded is
  // read after load, and a page too busy to answer keeps only its address.
  async #goto(url: string, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const result = await this.#causes.opening(commandToken, () => navigate(this.#navigationContext(), url, deadline, dispatch))
    return this.#withLoadedPage(result, deadline)
  }

  // A reload and a move through the history are the test's own navigations, as a goto is.
  async #history(kind: 'reload' | Traversal, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const context = this.#navigationContext()
    const result = await this.#causes.opening(commandToken, () => (kind === 'reload' ? reload(context, deadline, dispatch) : traverse(context, kind, deadline, dispatch)))
    return this.#withLoadedPage(result, deadline)
  }

  #navigationContext(): NavigationContext {
    return {
      session: this.#session,
      baseUrl: this.#baseUrl,
      mainFrameId: () => this.#mainFrameId,
      currentUrl: () => this.#url,
      proxyServer: this.#proxyServer,
      opened: (loaderId: string) => this.#causes.opened(loaderId),
    }
  }

  async #withLoadedPage(result: CommandResult, deadline: Deadline): Promise<CommandResult> {
    if (!result.ok || !isNavigationKind(result.kind) || !('url' in result)) return result
    return { ...result, page: await this.#loadedPage(result.url, deadline) }
  }

  // The page's address and title as `readPage` reads them. A title is unknown while another document is on its way,
  // and is empty, not unknown, on a page that has none.
  async #observePage(after: ObserveAfter | undefined, deadline: Deadline): Promise<CommandResult> {
    const waitedMs = after === undefined ? 0 : await this.#awaitChange(after, deadline)
    const changes = this.#changes
    const blocked = this.#blocked(readCommand, false)
    if (blocked !== undefined) return { ok: false, failure: blocked }
    const observation = await this.#lookAtPage(deadline)
    const base = this.#baseUrl === undefined ? null : URL.parse(this.#baseUrl)
    const baseUrl = base === null || !isWebUrl(base) ? {} : { baseUrl: originAndPath(base) }
    const url = this.#address()
    const title = observation.title === null ? undefined : pageTitleOf(observation.title)
    const page = url === undefined ? {} : { page: title === undefined ? { url } : { url, title } }
    return { ok: true, kind: 'observePage', observation, ...baseUrl, changes, ...(waitedMs > 0 ? { waitedMs } : {}), ...page }
  }

  // The page's whole address and title, as the page has them, for `toHaveURL` and `toHaveTitle`; the page facts keep
  // origin and path. While another document is on its way the title is unread, and the address is the frame's own.
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

  async #loadedPage(url: string, deadline: Deadline): Promise<PageFacts> {
    if (this.#pendingNavigation !== undefined) return { url }
    try {
      const budget = new Deadline(Math.min(loadedPageReadMs, deadline.remainingMs), { signal: deadline.signal })
      return pageFactsOf(await this.#world.call(pageFactsFunction, [], documentFactsSchema, budget))
    } catch {
      return { url }
    }
  }

  async #pointer(command: PointerAction, action: Pointer, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const send = action === 'tap' ? tapAt : clickAt
    const input = (target: ReadyTarget) => send(this.#session, pointOf(target.point), deadline, dispatch)
    return passed(action, await this.#act({ locator: command.locator, intent: { action, multiline: false }, input, commandToken }, deadline))
  }

  // The parent has read the key already. It is read again here because the parsed key is what the browser is sent.
  async #pressKey(command: Extract<BrowserCommand, { kind: 'press' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const parsed = parseKey(command.key)
    if (!parsed.ok) return { ok: false, failure: parsed.failure }
    const { locator, key } = command
    const input = () => pressKey(this.#session, parsed.key, deadline, dispatch)
    const intent: GuardedIntent = { action: 'press', key, strokes: keyStrokes(parsed.key), multiline: false }
    return passed('press', await this.#act({ locator, intent, input, commandToken }, deadline))
  }

  // Clicks the control, or its label when it is hidden, once, then waits for the state it asked for.
  async #check(command: Extract<BrowserCommand, { kind: 'check' | 'uncheck' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const { kind, locator } = command
    const pointer = this.#pointerInput()
    const intent = { action: kind, pointer, multiline: false }
    const send = pointer === 'tap' ? tapAt : clickAt
    const input = (target: ReadyTarget) => send(this.#session, pointOf(target.point), deadline, dispatch)
    const acted = await this.#act({ locator, intent, input, commandToken }, deadline)
    if (!acted.ok) return acted
    if (acted.kind === 'unchanged') return { ok: true, kind, changed: false, page: acted.page }
    const failure = await awaitCheckedState({ world: this.#world, locator, intent, via: acted.via, deadline })
    if (failure !== undefined) return { ok: false, failure }
    return { ok: true, kind, changed: true, ...(acted.via === undefined ? {} : { via: acted.via }), page: acted.page }
  }

  // The one delta a test gives is in CSS pixels. The browser scrolls a wheel's delta divided by the visual
  // viewport's scale, as a zoomed-out mobile page shows (fact F6), so the delta sent is multiplied by it.
  async #scroll(command: Extract<BrowserCommand, { kind: 'scroll' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const problem = scrollProblem(command)
    if (problem !== undefined) return { ok: false, failure: problem }
    const input = ({ point, scale }: ReadyTarget) =>
      wheelAt(this.#session, pointOf(point), { x: command.x * scale, y: command.y * scale }, deadline, dispatch)
    const acted = await this.#act({ locator: command.locator, intent: { action: 'scroll', multiline: false }, input, commandToken }, deadline)
    return passed('scroll', acted)
  }

  // Chrome draws a select's list outside the page, where input cannot reach it (fact F3), so a select is chosen with
  // the keyboard while it is closed. A look finds the select ready and plans the keys that choose the options; each key
  // is then readied and guarded as a press on the select, and the selection is read until it is the one asked for.
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
      const typed = await this.#typeSelection({ locator, intent, plan: target.plan, document: target.context, commandToken }, deadline, dispatch)
      // The page opened another document before the first key went, so the select is looked at and planned there.
      if (typed !== undefined) return typed
    }
  }

  // A select's own quiet second comes first, so no earlier key joins the type-ahead. Its keys carry times a millisecond
  // apart, so Chrome reads them as typed together however long each took to ready. The toggles of a select that takes
  // several have no type-ahead, and no times.
  // A plan belongs to the select in one document. A key never goes to a select another document holds, even one the
  // locator matches, so once a key has gone and the page opens another document, Retest types no more. Undefined when
  // the page opened another document before any key went.
  async #typeSelection({ locator, intent, plan, document, commandToken }: Typing, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult | undefined> {
    const typeAhead = plan.keys.some((planned) => !planned.toggle)
    const quietMs = Math.min(plan.quietMs, deadline.remainingMs)
    if (quietMs > 0) await sleep(quietMs, undefined, { signal: deadline.signal })
    const startedAt = typeAhead ? Date.now() / 1000 : undefined
    let sent = 0
    let token: number | null = null
    const heard: (Selection | undefined)[] = []
    for (const [index, planned] of plan.keys.entries()) {
      const typed: KeysTyped = { locator, intent, sent: index, of: plan.keys.length, heard: lastHeard(heard) }
      if (token !== null && (await pageSetOff(this.#world, { document, token }, deadline))) return selectionLeft(typed)
      const key = plannedKey(planned)
      const at = startedAt === undefined ? undefined : startedAt + sent / 1000
      sent += 2 * keyStrokes(key)
      const typing: GuardedIntent = { ...intent, typing: { strokes: keyStrokes(key) } }
      const acting = { locator, intent: typing, input: () => pressKey(this.#session, key, deadline, dispatch, at), commandToken }
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

  // Retest never types again: a select that took the keys and holds other options fails once the action's time is up.
  // A select its own change took off the page, often with the document it was in, holds what the guard read as that
  // change arrived.
  async #awaitSelection({ locator, intent, document, heard }: AwaitedSelection, deadline: Deadline): Promise<CommandResult> {
    let last: Selection | undefined
    for (let attempt = 0; ; attempt += 1) {
      let read: Selection | undefined
      try {
        read = await readSelection(this.#world, { locator, choices: intent.choices, document }, deadline)
      } catch (error) {
        // The time ran out during a read, so the previous read is the latest there is.
        if (!(error instanceof CdpTimeoutError)) throw error
        break
      }
      const gone = read === undefined || read.status === 'lost'
      if (gone && heard?.status === 'selected') return { ok: true, kind: 'select', changed: true, page: heard.page }
      if (read === undefined) return selectionLeft({ locator, intent, sent: 0, of: 0, heard })
      last = read
      if (last.status === 'selected') return { ok: true, kind: 'select', changed: true, page: last.page }
      if (deadline.expired) break
      await sleep(Math.min(firstSelectionPauseMs * 2 ** attempt, maxSelectionPauseMs, deadline.remainingMs), undefined, { signal: deadline.signal })
    }
    return { ok: false, failure: selectionStayed(locator, intent, last) }
  }

  // Input goes to whatever document the frame holds when the browser processes it. A navigation the browser
  // began after the page's ready answer would take it into the document it opens, so such a target is let go,
  // and the element is looked for again once that navigation is over.
  async #act(acting: Acting, deadline: Deadline): Promise<ActionTarget> {
    const seeing = await this.#actSeeing(acting, undefined, deadline)
    if (!('target' in seeing)) throw new Error("Retest's action moved on from a document it was not bound to")
    return seeing.target
  }

  // As `#act`, with what the guard saw of input that went. Bound to `document`, it sends nothing once the page holds
  // another document, however well the element there matches, and says the page moved on.
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

  // A page that emulates a touch screen taps wherever a person would click.
  #pointerInput(): Pointer {
    return this.#touch ? 'tap' : 'click'
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
        return `${this.#touch ? 'tap' : 'click'} ${describeLocator(command.locator)}`
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
        return describeAction({ action: command.kind, pointer: this.#pointerInput(), multiline: false }, command.locator)
    }
  }

  // Waits for the document to change past `after.changes`, or for `after.waitMs`, within the command's time. A page
  // that is lost or closed meanwhile wakes the wait, so the look that follows reports that instead of waiting on.
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

  async #dispose(deadline: Deadline): Promise<void> {
    this.#lostReason ??= 'the page was closed'
    this.#titles.dispose()
    this.#wake()
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
    this.#changed()
    this.#moveTo(frame.url, frame.loaderId)
  }

  // The page asked for a navigation of the main frame in its own tab: the request the cause of a navigation rests on.
  #navigationRequested(params: unknown): void {
    const source = { method: 'Page.frameRequestedNavigation', sessionId: this.#session.id }
    const { frameId, url, disposition } = readProtocol(requestedSchema, params, source)
    if (frameId === this.#mainFrameId && disposition === 'currentTab') this.#causes.requested(url)
  }

  // The browser has begun a navigation of the main frame. Its document replaces the current one when it commits,
  // unless the browser gives it up first, as it does a 204 or a download, or begins another in its place.
  #navigationStarted(params: unknown): void {
    const source = { method: 'Page.frameStartedNavigating', sessionId: this.#session.id }
    const { frameId, url, loaderId, navigationType } = readProtocol(navigatingSchema, params, source)
    if (frameId !== this.#mainFrameId || withinDocument.has(navigationType)) return
    this.#pendingNavigation = { url }
    this.#causes.started(url, loaderId)
    this.#navigationStarts.emit(url)
  }

  // The main frame stopped loading with nothing committed since the navigation began: the browser gave it up, and
  // a request it had not started by now it never will.
  #loadingStopped(params: unknown): void {
    const { frameId } = readProtocol(frameSchema, params, { method: 'Page.frameStoppedLoading', sessionId: this.#session.id })
    if (frameId !== this.#mainFrameId) return
    this.#pendingNavigation = undefined
    this.#causes.stoppedLoading()
  }

  #lifecycle(params: unknown): void {
    const { frameId, loaderId, name } = readProtocol(lifecycleSchema, params, { method: 'Page.lifecycleEvent', sessionId: this.#session.id })
    if (frameId === this.#mainFrameId && name === 'DOMContentLoaded') this.#titles.contentLoaded(loaderId)
  }

  #navigatedWithinDocument(params: unknown): void {
    const source = { method: 'Page.navigatedWithinDocument', sessionId: this.#session.id }
    const { frameId, url } = readProtocol(sameDocumentSchema, params, source)
    if (frameId === this.#mainFrameId) this.#moveTo(url, undefined)
  }

  // The main frame as a read found it, when no event told of the document it holds: its address is the page's from now
  // on. No navigation is told for it, since nobody saw it commit.
  #holdFrame(frame: { id: string; url: string }): void {
    if (frame.id !== this.#mainFrameId) {
      this.#mainFrameId = frame.id
      this.#world.reset()
    }
    const url = URL.parse(frame.url) ?? undefined
    if (url === undefined || url.href === this.#url?.href) return
    this.#url = url
    if (isWebUrl(url)) this.#origins.add(url.origin)
  }

  // A new document, committed with its loader, is always news; within a document only a new path is, since a
  // fragment is never reported.
  #moveTo(address: string, loaderId: string | undefined): void {
    const url = URL.parse(address)
    if (url === null) throw new Error('The browser reported a main frame address that is not a URL')
    const previous = this.#url
    this.#commits += 1
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

function passed(kind: 'click' | 'tap' | 'fill' | 'hover' | 'press' | 'scroll', acted: ActionTarget): CommandResult {
  return acted.ok ? { ok: true, kind, page: acted.page } : acted
}

// Every input arms the guard for its element before it goes; a select's look sends none, and its keys arm their own.
function guardOf({ context, token }: ReadyTarget): Guard {
  if (token === null) throw new Error("Retest's page script readied an action without arming its guard")
  return { context, token }
}

/** A select's plan as it types: its keys, and the command they belong to. */
type Typing = {
  locator: LocatorRecipe
  intent: Extract<ActionIntent, { action: 'select' }>
  plan: SelectPlan
  document: number
  commandToken: number | undefined
}

/** The select whose keys went, what it was asked to hold, its document, and what the guard read as the last key arrived. */
type AwaitedSelection = {
  locator: LocatorRecipe
  intent: Extract<ActionIntent, { action: 'select' }>
  document: number
  heard: Selection | undefined
}

/** How far a select's plan got: `sent` of its `of` keys went, and the guard read `heard` as the last of them arrived. */
type KeysTyped = {
  locator: LocatorRecipe
  intent: Extract<ActionIntent, { action: 'select' }>
  sent: number
  of: number
  heard: Selection | undefined
}

/** An action's target, or why it failed, and what the guard saw of the input, when input went. */
type Seeing = { target: ActionTarget; verdict: GuardVerdict | undefined }

/** The page holds another document than the one an action was bound to, and nothing was sent there. */
type MovedOn = { movedOn: true }

function lastHeard(heard: readonly (Selection | undefined)[]): Selection | undefined {
  return heard.findLast((each) => each !== undefined)
}

function heldLabels(heard: Selection | undefined): string {
  if (heard === undefined) return ''
  const held = heard.selected.length === 0 ? 'nothing' : heard.selected.map((label) => JSON.stringify(label)).join(', ')
  return `, and the select held ${held} as the last of them arrived`
}

// The page began to open another document after keys went, or opened it. What the guard read as the last of them
// arrived decides: a select that held the options asked for chose them.
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

// A key after the first could not go. The keys before it went, and may have changed the selection.
function selectionCut({ sent, of, heard }: KeysTyped, failure: Failure): Failure {
  return {
    ...failure,
    message: `${failure.message} Retest had typed ${sent} of the ${of} keys that choose it${heldLabels(heard)}.`,
    details: { ...failure.details, inputSent: true },
  }
}

// A planned key as the keyboard sends it: a named key, with the list's modifier when it must leave the selection
// alone, or a character of an option's label, a space included.
function plannedKey({ key, toggle }: PlannedKey): Key {
  const held: ModifierName[] = toggle ? [listModifier] : []
  const named = namedKeys.find((name) => name === key) ?? (key === ' ' ? 'Space' : undefined)
  return named === undefined ? { kind: 'character', character: key, shift: false, held } : { kind: 'named', name: named, held }
}

function selectionStayed(locator: LocatorRecipe, intent: Extract<ActionIntent, { action: 'select' }>, last: Selection | undefined): Failure {
  const action = `select ${describeChoices(intent)} in ${describeLocator(locator)}`
  const after =
    last === undefined || last.status === 'lost'
      ? 'then no single select it matched still held the options asked for'
      : `the select holds ${last.selected.length === 0 ? 'nothing' : last.selected.map((label) => JSON.stringify(label)).join(', ')}`
  return {
    class: 'not_actionable',
    message: `Could not ${action}: Retest typed the keys that choose it, and ${after}. Retest does not type again.`,
    details: { check: 'selection', inputSent: true },
  }
}

function selectIntent(command: Extract<BrowserCommand, { kind: 'select' }>): Extract<ActionIntent, { action: 'select' }> {
  return { action: 'select', choices: command.choices, multiple: command.multiple === true, multiline: false }
}

// Two identities name one session when they name the same test, attempt, app and session id.
function sameSession(first: RecordIdentity, second: RecordIdentity): boolean {
  return first.testId === second.testId && first.attemptId === second.attemptId && first.app === second.app && first.sessionId === second.sessionId
}

function withTitle(title: string | undefined): { title?: string } {
  return title === undefined ? {} : { title }
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
