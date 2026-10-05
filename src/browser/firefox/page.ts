import type { BidiClient } from './bidi-client.ts'
import type { BrowserCommand, DispatchedCommand, ElementIdentity, KeyedReading, PageNavigation, PageReading, SessionIdentity, TextQuery, WebSession } from '../contract.ts'
import type { ActionTarget, ReadyTarget } from '../actionability.ts'
import type { ActionIntent, PlannedKey, Pointer, SelectPlan, Selection } from '../element-queries.ts'
import type { Guard, GuardedIntent, GuardVerdict } from '../input-guard.ts'
import type { Traversal } from './navigation.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../../diagnostics/observations.ts'
import type { ObserveAfter, CommandResult, PageObservation } from '../../protocol/commands.ts'
import type { Emulation } from '../../protocol/emulation.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { RecordIdentity } from '../../protocol/identity.ts'
import type { Key, ModifierName } from '../../protocol/keys.ts'
import type { LocatorRecipe } from '../../protocol/locator.ts'
import type { PageFacts } from '../../protocol/page-facts.ts'
import type { Infer, Schema } from '../../protocol/schema.ts'
import type { StorageState, StoredOrigin } from '../../protocol/storage-state.ts'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { waitBeforeRead } from '../../assertions/wait-before-read.ts'
import { FirefoxCollector } from '../../diagnostics/firefox-collector.ts'
import { isNavigationKind } from '../../protocol/commands.ts'
import { Deadline, monotonicClock } from '../../protocol/deadline.ts'
import { formatSessionId } from '../../protocol/evidence.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { namedKeys, parseKey } from '../../protocol/keys.ts'
import { describeLocator } from '../../protocol/locator.ts'
import { optionChoicesProblem } from '../../protocol/option-choices.ts'
import { s } from '../../protocol/schema.ts'
import { scrollProblem } from '../../protocol/scroll-delta.ts'
import { secretPlaceholder } from '../../protocol/secret.ts'
import { isWebUrl } from '../../protocol/url.ts'
import { invalidSelector, shadowRefused, waitUntilActionable } from '../actionability.ts'
import { BrowserError } from '../browser-error.ts'
import { CdpClosedError, CdpDisconnectedError, CdpInvalidResponseError, CdpTimeoutError } from '../cdp/errors.ts'
import { awaitCheckedState } from '../checked-state.ts'
import { commandStopped, connectionEnded, dialogOpened, failureFromError } from '../command-failures.ts'
import { Dispatch } from '../dispatch.ts'
import { documentFactsSchema, pageFactsOf, pageTitleOf } from '../document-facts.ts'
import { describeAction, describeChoices, dispatchPinned, observe, observeKeyed, readSelection } from '../element-queries.ts'
import { disarmGuard, guardFailure, guardInput } from '../input-guard.ts'
import { originRefusal } from '../origin-refusal.ts'
import { isGoneContext, IsolatedWorld } from '../isolated-world.ts'
import { Listeners } from '../listeners.ts'
import { NavigationCauses } from '../navigation-causes.ts'
import { NavigationTitles } from '../navigation-titles.ts'
import { changeScript, guardScript, pageFactsFunction, pageLookFunction, readPageFunction } from '../page-scripts.ts'
import { originAndPath } from '../page-url.ts'
import { readLocalStorage } from '../storage-state.ts'
import { FirefoxFrameSource } from './capture.ts'
import { readBidi } from './bidi-client.ts'
import { BidiProtocolError } from './bidi-errors.ts'
import { cdpError, FirefoxBridge } from './bridge.ts'
import { clickAt, moveTo, pressedStrokes, pressKey, selectionProblem, typeText, typedStrokes, typingProblem, wheelAt, type Point } from './input.ts'
import { NavigationHold } from './navigation-hold.ts'
import { navigate, NavigationWatcher, reload, traverse } from './navigation.ts'
import { navigationShim, relayScript, sandboxName, wrapped } from './sandbox.ts'
import { inWindowOrder } from './window-order.ts'
import { readFirefoxCookies, readFirefoxOriginStorage } from './storage.ts'

export type FirefoxPageOptions = {
  client: BidiClient
  /** The tab's browsing context, and the user context it was made in, which holds its storage alone. */
  context: string
  userContext: string
  baseUrl: string | undefined
  /** The viewport and pixel ratio, applied before the page opens anything. */
  emulation: Emulation | undefined
  /** Origins whose storage the user context already holds, from a restored state. */
  restoredOrigins: readonly string[]
  /** Receives errors thrown by navigation listeners. */
  onListenerError: (error: unknown) => void
}

type PointerAction = Extract<BrowserCommand, { kind: 'click' | 'tap' }>
/**
 * One guarded action. `hold` is the navigation hold of a fill bound to origins: a navigation it holds is one the fill
 * will refuse and cancel, which the action then never waits for, and each look for the element lets go what it held
 * before that look began (`NavigationHold` says why).
 */
type Acting = {
  locator: LocatorRecipe | undefined
  intent: GuardedIntent
  input: (target: ReadyTarget) => Promise<void>
  commandToken: number | undefined
  hold?: NavigationHold
}
type Executing = { timeoutMs: number; signal: AbortSignal | undefined; commandToken: number | undefined; dispatch: Dispatch }

const retryPauseMs = 20
const loadedPageReadMs = 1000
const firstSelectionPauseMs = 20
const maxSelectionPauseMs = 200
const listModifier: ModifierName = process.platform === 'darwin' ? 'Meta' : 'Control'
const screenshotCommand = 'take a screenshot'
const captureCommand = 'save the sign-in state'
const readCommand = 'read the page'
const collectCommand = 'collect diagnostics'
const guardInstallMs = 5000

const readingSchema = s.object({ found: s.array(s.boolean()), title: s.string(), body: s.boolean() })
const pageLookSchema = s.object({ url: s.string(), title: s.string(), cut: s.array(s.enum(['url', 'title'])) })
const screenshotSchema = s.object({ data: s.string() })
const contextEventSchema = s.object({ context: s.string() })
const navigationEventSchema = s.object({ context: s.string(), navigation: s.nullable(s.string()), url: s.string() })
const promptSchema = s.object({ context: s.string(), type: s.string() })
const responseSchema = s.object({
  context: s.string(),
  navigation: s.nullable(s.string()),
  request: s.object({ url: s.string() }),
  response: s.object({ status: s.number(), headers: s.optional(s.array(s.object({ name: s.string(), value: s.object({ type: s.string(), value: s.optional(s.string()) }) }))) }),
})
const messageSchema = s.object({ channel: s.string(), data: s.object({ type: s.string(), value: s.optional(s.string()) }), source: s.object({ context: s.optional(s.string()) }) })
const treeSchema = s.object({ contexts: s.array(s.object({ url: s.string() })) })
const scriptSchema = s.object({ script: s.string() })
const callAnswerSchema = s.object({ type: s.enum(['success', 'exception']), exceptionDetails: s.optional(s.object({ text: s.string() })) })

// How often a document checks its own address, for a move within it that no action caused and that changed nothing in
// it: Firefox 133 tells no event for `history.pushState`.
const addressPollMs = 50

/**
 * The script every document of the tab runs in Retest's sandbox before its own scripts: the relays the input guard
 * listens through, the change observer reporting through `changed` with the document's address, a check of that
 * address every few milliseconds, and `documented`, which tells Retest the document committed and where. Channels are
 * how BiDi lets a sandbox speak to Retest; the page can see neither them nor the sandbox's timer.
 *
 * The guard itself is installed by a call (`relayScript` says why): the moment Retest hears the document commit, and by
 * every action's own check if that call has not landed yet. Either way its listeners join the relays, which were there
 * before the page's own. `claimType` is the tab's own event type for the sandbox calls reach to claim the document,
 * written into the script, since a preload script takes nothing but channels; the page never sees the script.
 */
const documentScript = (claimType: string): string => `(changed, documented) => {
  const claimType = ${JSON.stringify(claimType)};
  ${relayScript}
  globalThis.retestChanged = () => changed(location.href);
  ${changeScript};
  let address = location.href;
  setInterval(() => {
    if (location.href === address) return;
    address = location.href;
    changed(address);
  }, ${addressPollMs});
  documented(location.href)
}`

/** Has the document's own script report its address, which Retest reads as a move within it when the path changed. */
const tellAddressFunction = `function tellAddress() {
  globalThis.retestChanged?.()
  return true
}`

// How long an action's input waits for the guard's verdict call to wait in the page before it goes anyway.
const verdictWaitMs = 2000

// How long the address check after an action's input may take: a document that is going answers late or never.
const addressCallMs = 1000

/** Installs the shared input guard in the document's sandbox, from a call. */
const installGuardFunction = `function installRetestGuard() {
  ${navigationShim}
  ${guardScript}
}`

/** Retest's per-document function that turns the fill guard an action armed into one for typing key by key. */
const keystrokesFunction = `function typeKeys(token, strokes) {
  const guard = globalThis.retestGuard
  const armed = guard === undefined ? null : guard.armed
  if (armed === null || armed.token !== token) return false
  // Firefox types key by key, so the fill waits for each key's release, and the value Retest selected is replaced by
  // the first key alone: the guard selects it again on that key's beforeinput, and on no later one.
  armed.last = 'keyup'
  armed.left = strokes
  const typed = (event) => {
    if (!event.isTrusted || guard.armed !== armed) return
    armed.action = 'typing'
    window.removeEventListener('beforeinput', typed, true)
  }
  window.addEventListener('beforeinput', typed, true)
  return true
}`

/**
 * One tab in a user context of its own: a web session on Firefox, through WebDriver BiDi. The page code, the
 * actionability checks, the input guard and the failure messages are the ones Chromium uses, run in Retest's sandbox
 * of each document through `FirefoxBridge`; navigation, input, storage and capture speak BiDi.
 */
export class FirefoxPage implements WebSession, ElementIdentity {
  #navigationHold: NavigationHold | undefined
  readonly #client: BidiClient
  readonly #bridge: FirefoxBridge
  readonly #context: string
  readonly #userContext: string
  readonly #baseUrl: string | undefined
  readonly #world: IsolatedWorld
  readonly #navigations: Listeners<PageNavigation>
  readonly #navigationStarts: Listeners<string>
  readonly #causes = new NavigationCauses()
  readonly #titles: NavigationTitles
  readonly #changeWaiters = new Set<() => void>()
  readonly #watchers = new Set<NavigationWatcher>()
  readonly #origins: Set<string>
  readonly #stops: (() => void)[] = []
  readonly #channels: { changed: string; documented: string }
  readonly #subscriptions = new Map<string, number>()
  #changes = 0
  #url: URL | undefined
  #commits = 0
  #documents = 0
  #opening = 0
  // Whether a navigation started since the opening command began, which is then that command's.
  #claimed = false
  #pending: { id: string; url: string } | undefined
  readonly #started = new Set<string>()
  #document: string | undefined
  #lostReason: string | undefined
  #dialog: string | undefined
  #disposing: Promise<void> | undefined
  #identity: RecordIdentity | undefined
  #preload: string | undefined

  /**
   * Follows the tab's events, then has every document it opens run Retest's guard and change observer before the page's
   * own scripts, and runs them in the document it holds now, which opened before. Applies the viewport.
   *
   * @example const page = await FirefoxPage.open({ client, context, userContext, baseUrl, emulation, restoredOrigins: [], onListenerError }, deadline)
   */
  static async open(options: FirefoxPageOptions, deadline: Deadline): Promise<FirefoxPage> {
    const page = new FirefoxPage(options)
    try {
      await page.#start(options, deadline)
    } catch (error) {
      await page.dispose(deadline.commandTimeoutMs).catch(() => {
        // The browser removes the user context, with the tab, and the error that matters is the one below.
      })
      throw error
    }
    return page
  }

  private constructor(options: FirefoxPageOptions) {
    this.#client = options.client
    this.#context = options.context
    this.#userContext = options.userContext
    this.#baseUrl = options.baseUrl
    this.#origins = new Set(options.restoredOrigins)
    this.#channels = { changed: `retest-changed-${options.context}`, documented: `retest-documented-${options.context}` }
    this.#navigations = new Listeners(options.onListenerError)
    this.#navigationStarts = new Listeners(options.onListenerError)
    this.#bridge = new FirefoxBridge({ client: options.client, context: options.context, onListenerError: (_event, error) => options.onListenerError(error) })
    this.#world = new IsolatedWorld(this.#bridge.session, () => this.#context)
    this.#titles = new NavigationTitles({
      readable: () => this.#pending === undefined && this.#lostReason === undefined && this.#dialog === undefined,
      read: async (deadline) => pageTitleOf((await this.#world.call(pageFactsFunction, [], documentFactsSchema, deadline)).title),
    })
    this.#listen('browsingContext.navigationStarted', navigationEventSchema, ({ navigation, url }) => this.#navigationStarted(navigation, url))
    this.#listen('browsingContext.fragmentNavigated', navigationEventSchema, ({ url }) => this.#movedWithinDocument(url))
    this.#listen('browsingContext.domContentLoaded', navigationEventSchema, ({ navigation, url }) => this.#contentLoaded(navigation, url))
    this.#listen('browsingContext.load', navigationEventSchema, ({ navigation, url }) => this.#loaded(navigation, url))
    this.#listen('browsingContext.navigationFailed', navigationEventSchema, ({ navigation }) => this.#navigationFailed(navigation))
    this.#listen('network.responseStarted', responseSchema, (params) => this.#responded(params))
    this.#listen('browsingContext.userPromptOpened', promptSchema, ({ type }) => this.#promptOpened(type))
    this.#listen('browsingContext.userPromptClosed', contextEventSchema, () => this.#promptClosed())
    this.#listen('browsingContext.contextDestroyed', contextEventSchema, () => this.#lose('the page was closed'))
    this.#stops.push(this.#client.on('script.message', (params) => this.#message(params)))
    this.#stops.push(this.#client.onDisconnect((reason) => this.#lose(reason)))
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

  /**
   * Reads each locator's matches as `observe` does, all in one call of Retest's sandbox in the current document, and
   * keys each element listed with the key that sandbox keeps for the node. The role and label lookups of every locator
   * are scoped together, and one Firefox cannot answer as Chrome does is refused by name, as a look refuses it. Waits
   * for no change and sends no input; a page that is lost, closed or held by a dialog answers as a look does.
   */
  async readElements(locators: readonly LocatorRecipe[], timeoutMs: number, signal?: AbortSignal): Promise<KeyedReading> {
    const startedAt = monotonicClock()
    const deadline = new Deadline(timeoutMs, { signal, startedAt })
    const described = `read ${locators.map((locator) => describeLocator(locator)).join(' and ')}`
    try {
      await this.#titles.settle(deadline)
      signal?.throwIfAborted()
      const blocked = this.#blocked(described, false)
      if (blocked !== undefined) return { ok: false, failure: blocked }
      const read = await this.#bridge.resolvingAll(locators, () => observeKeyed(this.#world, locators, deadline))
      if ('reads' in read) return { ok: true, reads: read.reads, page: read.page }
      const named = locators[read.locator]
      if (named === undefined) throw new Error("Retest's keyed look named a locator it was not given")
      return { ok: false, failure: 'invalid' in read ? invalidSelector(read.invalid, named, undefined) : shadowRefused(read.shadow, named, undefined) }
    } catch (error) {
      if (error instanceof CdpTimeoutError) await outlast(startedAt + timeoutMs, signal)
      if (signal?.aborted === true) return { ok: false, failure: commandStopped(described, false, signal.reason) }
      if (error instanceof BrowserError) return { ok: false, failure: this.#blocked(described, false) ?? error.failure }
      return { ok: false, failure: this.#blocked(described, false) ?? failureFromError(error, { command: described, timeoutMs, inputSent: false }) }
    }
  }

  /**
   * Sends `command` as `dispatch` does, only to the node `key` names: every look that readies the element checks, in
   * the call of the hit test, that the locator's one match is that node, and a look that finds another fails the command
   * at once as `not_actionable` with `details.refused` `'moved'`, with no input sent. A key read in an earlier document
   * names nothing in this one.
   */
  dispatchTo(command: BrowserCommand, key: string, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand> {
    return dispatchPinned(command, key, () => this.dispatch(command, timeoutMs, signal, commandToken))
  }

  async screenshot(timeoutMs: number): Promise<Uint8Array> {
    const deadline = new Deadline(timeoutMs)
    for (;;) {
      const finalRead = deadline.reached
      const blocked = this.#blocked(screenshotCommand, false)
      if (blocked !== undefined) throw new BrowserError(blocked)
      try {
        const params = { context: this.#context, origin: 'viewport', format: { type: 'image/png' } }
        const { data } = await this.#client.request('browsingContext.captureScreenshot', params, screenshotSchema, { timeoutMs: deadline.commandTimeoutMs })
        return Buffer.from(data, 'base64')
      } catch (error) {
        const mapped = this.#operationError(screenshotCommand, cdpError('browsingContext.captureScreenshot', this.#bridge.session.id, error), timeoutMs)
        // Between a document going and the next one arriving there is nothing to capture for a moment.
        const retryable = (mapped instanceof BrowserError && mapped.failure.class === 'timeout')
          || (this.#pending !== undefined && error instanceof BidiProtocolError && (error.error === 'unknown error' || error.error === 'unable to capture screen'))
        if (!retryable || finalRead) throw mapped
        await waitBeforeRead(deadline, retryPauseMs)
      }
    }
  }

  /**
   * Reads the user context's cookies, and the `localStorage` of each http or https origin the tab opened or its restored
   * state held: the current document's own in Retest's sandbox, and every other one from an empty document Retest
   * serves for it, so no request reaches the site and none of its code runs. Frames' own origins, sessionStorage and
   * IndexedDB are not saved, nor origins whose storage is empty.
   */
  async captureState(timeoutMs: number): Promise<StorageState> {
    const deadline = new Deadline(timeoutMs)
    const blocked = this.#blocked(captureCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    try {
      const cookies = await readFirefoxCookies(this.#client, this.#userContext, deadline)
      const current = await this.#currentStorage(deadline)
      const others = [...this.#origins].filter((origin) => origin !== current?.origin)
      const earlier = await readFirefoxOriginStorage(this.#client, this.#userContext, others, deadline)
      const shown = current === undefined || current.localStorage.length === 0 ? [] : [current]
      return { cookies, origins: [...shown, ...earlier] }
    } catch (error) {
      throw this.#operationError(captureCommand, cdpError('storage.getCookies', this.#bridge.session.id, error), timeoutMs)
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
      if (this.#pending === undefined) {
        const deadline = new Deadline(timeoutMs, { startedAt: started, signal: navigating.signal })
        const { found, title, body } = await this.#world.call(readPageFunction, [queries], readingSchema, deadline)
        if (found.length !== queries.length) {
          throw new CdpInvalidResponseError({ method: 'Runtime.callFunctionOn', sessionId: this.#bridge.session.id }, `it answered ${found.length} of ${queries.length} text queries`)
        }
        return { url: this.#address(), ...withTitle(pageTitleOf(title)), navigating: this.#pending !== undefined, found, ...(body ? {} : { body: false }) }
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
   * Collects the tab's console messages, runtime errors and network metadata from its own BiDi events. The collector
   * listens before it subscribes, so nothing after this call is missed. Sends no input.
   */
  async collectDiagnostics(sink: DiagnosticSink, timeoutMs: number): Promise<DiagnosticCollection> {
    const blocked = this.#blocked(collectCommand, false)
    if (blocked !== undefined) throw new BrowserError(blocked)
    const subscriptions = { subscribe: (events: readonly string[], timeoutMs: number) => this.#subscribe(events, { timeoutMs }), unsubscribe: (events: readonly string[]) => this.#unsubscribe(events) }
    const collector = new FirefoxCollector({ client: this.#client, context: this.#context, sink, subscriptions })
    try {
      await collector.start(timeoutMs)
    } catch (error) {
      throw this.#operationError(collectCommand, cdpError('session.subscribe', this.#bridge.session.id, error), timeoutMs)
    }
    return collector
  }

  /**
   * Names the session this page is, as the runner holds it. A page is one session for its whole life, so naming it
   * again as another throws, and so does an id that is not the attempt's and the app's.
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

  /** The session this page was named as, which its captures belong to. */
  get identity(): RecordIdentity | undefined {
    return this.#identity
  }

  /** A PNG screenshot loop of this session, through the existing BiDi screenshot route. */
  frameSource(identity: RecordIdentity): FirefoxFrameSource { return new FirefoxFrameSource(this, identity) }

  /** Why this page ended, also read by its frame source while capture is suspended. */
  get lostReason(): string | undefined { return this.#lostReason }

  /** The tab's browsing context, which a capture of it names. */
  get context(): string {
    return this.#context
  }

  dispose(timeoutMs: number): Promise<void> {
    this.#disposing ??= this.#dispose(new Deadline(timeoutMs))
    return this.#disposing
  }

  async #start(options: FirefoxPageOptions, deadline: Deadline): Promise<void> {
    const send = () => ({ timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
    await this.#client.request('session.subscribe', { events: ['browsingContext', 'script'], contexts: [this.#context] }, s.object({}), send())
    const channels = [
      { type: 'channel', value: { channel: this.#channels.changed, ownership: 'none' } },
      { type: 'channel', value: { channel: this.#channels.documented, ownership: 'none' } },
    ]
    // The claim's event type is random, so no page can listen for it or send it.
    const script = documentScript(`retest-claim-${randomUUID()}`)
    // A navigation answered with no document is told by its response alone (`#responded`).
    await this.#subscribe(['network.responseStarted'], send())
    const preload = await this.#client.request('script.addPreloadScript', { functionDeclaration: script, arguments: channels, sandbox: sandboxName, contexts: [this.#context] }, scriptSchema, send())
    this.#preload = preload.script
    const { emulation } = options
    if (emulation !== undefined) {
      const viewport = { width: emulation.viewport.width, height: emulation.viewport.height }
      await this.#client.request('browsingContext.setViewport', { context: this.#context, viewport, devicePixelRatio: emulation.deviceScaleFactor }, s.object({}), send())
    }
    const tree = await this.#client.request('browsingContext.getTree', { root: this.#context, maxDepth: 0 }, treeSchema, send())
    const current = tree.contexts[0]?.url
    if (current !== undefined) this.#holdAddress(current)
    // The document the tab opened with was there before the preload script; it runs the same script now. Its message
    // reports the document already held, so it is no navigation.
    this.#documents = -1
    const initial = await this.#client.request('script.callFunction', { functionDeclaration: script, arguments: channels, target: { context: this.#context, sandbox: sandboxName }, awaitPromise: false, resultOwnership: 'none' }, callAnswerSchema, send())
    if (initial.type === 'exception') throw new BrowserError({ class: 'setup_failed', message: `Retest's page script failed in the page's first document: ${initial.exceptionDetails?.text ?? 'it threw'}` })
  }

  async #execute(command: BrowserCommand, { timeoutMs, signal, commandToken, dispatch }: Executing): Promise<CommandResult> {
    const startedAt = monotonicClock()
    const deadline = new Deadline(timeoutMs, { signal, startedAt })
    const described = this.#describe(command)
    try {
      await this.#titles.settle(deadline)
      signal?.throwIfAborted()
      const blocked = this.#blocked(described, false)
      if (blocked !== undefined) return { ok: false, failure: blocked }
      const result = await this.#run(command, deadline, dispatch, commandToken)
      if (result.ok) return result
      if (!stopped(signal) && waitedWholeBudget(result.failure, timeoutMs)) {
        await outlast(startedAt + timeoutMs, signal)
        if (signal !== undefined && stopped(signal)) return { ok: false, failure: commandStopped(described, dispatch.sent, signal.reason) }
      }
      return { ok: false, failure: this.#blocked(described, dispatch.sent) ?? result.failure }
    } catch (error) {
      if (error instanceof CdpTimeoutError) await outlast(startedAt + timeoutMs, signal)
      if (signal?.aborted === true) return { ok: false, failure: commandStopped(described, dispatch.sent, signal.reason) }
      if (error instanceof BrowserError) return { ok: false, failure: this.#blocked(described, dispatch.sent) ?? error.failure }
      const failure = this.#blocked(described, dispatch.sent) ?? failureFromError(error, { command: described, timeoutMs, inputSent: dispatch.sent })
      return { ok: false, failure }
    }
  }

  async #run(command: BrowserCommand, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    switch (command.kind) {
      case 'goto':
        await this.#navigationHold?.release(false, deadline)
        return this.#goto(command.url, deadline, dispatch, commandToken)
      case 'reload':
      case 'goBack':
      case 'goForward':
        await this.#navigationHold?.release(false, deadline)
        return this.#history(command.kind, deadline, dispatch, commandToken)
      case 'observe': {
        const waitedMs = command.after === undefined ? 0 : await this.#awaitChange(command.after, deadline)
        const changes = this.#changes
        const observed = await this.#bridge.resolving(command.locator, () => observe(this.#world, command.locator, deadline))
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
        const input = (target: ReadyTarget) => moveTo(this.#bridge.session, this.#context, pointOf(target.point), deadline, dispatch)
        return passed('hover', await this.#act({ locator: command.locator, intent: { action: 'hover', multiline: false }, input, commandToken }, deadline))
      }
      case 'fill':
        return this.#fill(command, deadline, dispatch, commandToken)
      case 'select':
        return this.#select(command, deadline, dispatch, commandToken)
      case 'check':
      case 'uncheck':
        return this.#check(command, deadline, dispatch, commandToken)
      case 'scroll':
        return this.#scroll(command, deadline, dispatch, commandToken)
    }
  }

  async #goto(url: string, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const result = await this.#openingWith(commandToken, () => navigate(this.#navigationContext(deadline), url, deadline, dispatch))
    return this.#withLoadedPage(result, deadline)
  }

  async #history(kind: 'reload' | Traversal, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const context = this.#navigationContext(deadline)
    const result = await this.#openingWith(commandToken, () => (kind === 'reload' ? reload(context, deadline, dispatch) : traverse(context, kind, deadline, dispatch)))
    return this.#withLoadedPage(result, deadline)
  }

  async #openingWith<T>(commandToken: number | undefined, work: () => Promise<T>): Promise<T> {
    this.#opening += 1
    this.#claimed = false
    try {
      return await this.#causes.opening(commandToken, work)
    } finally {
      this.#opening -= 1
    }
  }

  #navigationContext(deadline: Deadline) {
    return {
      session: this.#bridge.session,
      context: this.#context,
      baseUrl: this.#baseUrl,
      currentUrl: () => this.#url,
      watch: () => this.#watch(),
      movedWithin: () => this.#readAddress(deadline),
      opened: (navigation: string) => this.#causes.opened(navigation),
    }
  }

  #watch(): NavigationWatcher {
    const watcher = new NavigationWatcher(() => this.#watchers.delete(watcher))
    this.#watchers.add(watcher)
    const stopped = this.#lostReason ?? this.#bridge.channel.blockReason
    if (stopped !== undefined) watcher.onStopped(stopped)
    return watcher
  }

  // A move through the history within the document is told by no BiDi event, so the address is read from the document.
  async #readAddress(deadline: Deadline): Promise<void> {
    try {
      const { href } = await this.#world.call(pageFactsFunction, [], documentFactsSchema, new Deadline(Math.min(loadedPageReadMs, deadline.remainingMs), { signal: deadline.signal }))
      this.#movedWithinDocument(href)
    } catch {
      // A page too busy to answer keeps the address it had; the next change it reports tells the new one.
    }
  }

  async #withLoadedPage(result: CommandResult, deadline: Deadline): Promise<CommandResult> {
    if (!result.ok || !isNavigationKind(result.kind) || !('url' in result)) return result
    return { ...result, page: await this.#loadedPage(result.url, deadline) }
  }

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

  async #lookAtPage(deadline: Deadline): Promise<PageObservation> {
    const held: PageObservation = { url: this.#url?.href ?? null, title: null }
    if (this.#pending !== undefined) return held
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
    if (this.#pending !== undefined) return { url }
    try {
      const budget = new Deadline(Math.min(loadedPageReadMs, deadline.remainingMs), { signal: deadline.signal })
      return pageFactsOf(await this.#world.call(pageFactsFunction, [], documentFactsSchema, budget))
    } catch {
      return { url }
    }
  }

  async #pointer(command: PointerAction, action: Pointer, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const input = (target: ReadyTarget) => clickAt(this.#bridge.session, this.#context, pointOf(target.point), deadline, dispatch)
    return passed(action, await this.#act({ locator: command.locator, intent: { action, multiline: false }, input, commandToken }, deadline))
  }

  // Firefox has no command that inserts text as one edit, so a fill types its value key by key into the field the
  // shared checks focused and selected, and the guard counts every key's release.
  async #fill(command: Extract<BrowserCommand, { kind: 'fill' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const { locator, secret, allowedOrigins } = command
    const problem = typingProblem(command.value)
    if (problem !== undefined) {
      const value = secret === undefined ? `the text, which ${problem}` : `${secretPlaceholder(secret)}, which holds a character Firefox reads as a named key`
      return { ok: false, failure: { class: 'unsupported', message: `Could not fill ${describeLocator(locator)} with ${value}. Firefox types text key by key, and cannot type it.` } }
    }
    const intent: GuardedIntent = {
      action: 'fill',
      multiline: /[\n\r]/.test(command.value),
      ...(secret === undefined ? {} : { secret }),
      ...(allowedOrigins === undefined ? {} : { allowedOrigins }),
    }
    const strokes = typedStrokes(command.value)
    let refused: string | undefined
    const hold = allowedOrigins === undefined ? undefined : await this.#holdNavigations(intent, locator, deadline)
    if (hold !== undefined) this.#navigationHold = hold
    const input = async (target: ReadyTarget): Promise<void> => {
      const guard = guardOf(target)
      let armed: boolean
      try {
        armed = await this.#world.callIn(guard.context, keystrokesFunction, [guard.token, strokes], s.boolean(), deadline)
      } catch (error) {
        // The document the field was readied in went before any key was sent: the page left on its own.
        if (isGoneContext(error)) throw new BrowserError(movedBeforeTyping(intent, locator), { cause: error })
        throw error
      }
      if (!armed) return
      // The page set off for another document as the field took the focus: nothing is typed, as on Chromium.
      refused = hold?.leaving
      if (refused !== undefined) return
      hold?.typing()
      await typeText(this.#bridge.session, this.#context, command.value, deadline, dispatch)
    }
    try {
      const acted = await this.#act({ locator, intent, input, commandToken, ...(hold === undefined ? {} : { hold }) }, deadline)
      if (refused !== undefined) return { ok: false, failure: originRefusal({ origin: refused, leaving: true }, intent, locator) }
      return passed('fill', acted)
    } finally {
      await hold?.release(refused !== undefined, deadline)
      if (this.#navigationHold === hold) this.#navigationHold = undefined
    }
  }

  // Holds the tab's navigations while a fill bound to origins looks for its field and types (`NavigationHold` says how).
  // A hold Firefox refuses ends the fill before any input, by name.
  async #holdNavigations(intent: GuardedIntent, locator: LocatorRecipe, deadline: Deadline): Promise<NavigationHold> {
    try {
      return await this.#arm(deadline)
    } catch (error) {
      if (!(error instanceof BidiProtocolError)) throw cdpError('network.addIntercept', this.#bridge.session.id, error)
      const text = intent.secret === undefined ? 'the text' : secretPlaceholder(intent.secret)
      throw new BrowserError({ class: 'not_actionable', message: `Could not fill ${describeLocator(locator)} with ${text}: Firefox refused to hold the page's navigations while Retest typed (${error.error}). Retest typed nothing.`, details: { inputSent: false } }, { cause: error })
    }
  }

  #arm(deadline: Deadline): Promise<NavigationHold> {
    return NavigationHold.arm(
      {
        client: this.#client,
        context: this.#context,
        subscribe: (events, send) => this.#subscribe(events, send),
        unsubscribe: (events) => this.#unsubscribe(events),
        onNavigationStart: (listener) => this.#navigationStarts.add(listener),
        navigationFailed: (navigation) => this.#navigationFailed(navigation),
        stopLoading: (timeoutMs) => this.#stopLoading(timeoutMs),
      },
      deadline,
    )
  }

  // A navigation the fill refused whose request never reached the intercept, as one that needs no network request, is
  // stopped as the browser's Stop button stops it.
  async #stopLoading(timeoutMs: number): Promise<void> {
    const pending = this.#pending
    const params = { functionDeclaration: '() => window.stop()', arguments: [], target: { context: this.#context, sandbox: sandboxName }, awaitPromise: false, resultOwnership: 'none' }
    await this.#client.send('script.callFunction', params, { timeoutMs }).catch(() => undefined)
    if (pending !== undefined) this.#navigationFailed(pending.id)
  }

  // Subscriptions are counted by event, so the navigation hold and the diagnostics collector never end each other's.
  async #subscribe(events: readonly string[], send: { timeoutMs: number; signal?: AbortSignal | undefined }): Promise<void> {
    const fresh = events.filter((event) => (this.#subscriptions.get(event) ?? 0) === 0)
    if (fresh.length > 0) await this.#client.request('session.subscribe', { events: fresh, contexts: [this.#context] }, s.object({}), send)
    for (const event of events) this.#subscriptions.set(event, (this.#subscriptions.get(event) ?? 0) + 1)
  }

  #unsubscribe(events: readonly string[]): void {
    const ended: string[] = []
    for (const event of events) {
      const count = (this.#subscriptions.get(event) ?? 0) - 1
      if (count <= 0) {
        this.#subscriptions.delete(event)
        ended.push(event)
      } else this.#subscriptions.set(event, count)
    }
    if (ended.length > 0 && this.#client.closeReason === undefined && this.#lostReason === undefined) {
      this.#client.send('session.unsubscribe', { events: ended, contexts: [this.#context] }).catch(() => undefined)
    }
  }

  async #pressKey(command: Extract<BrowserCommand, { kind: 'press' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const parsed = parseKey(command.key)
    if (!parsed.ok) return { ok: false, failure: parsed.failure }
    const { locator, key } = command
    const input = () => pressKey(this.#bridge.session, this.#context, parsed.key, deadline, dispatch)
    const intent: GuardedIntent = { action: 'press', key, strokes: pressedStrokes(parsed.key), multiline: false }
    return passed('press', await this.#act({ locator, intent, input, commandToken }, deadline))
  }

  async #check(command: Extract<BrowserCommand, { kind: 'check' | 'uncheck' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const { kind, locator } = command
    const intent = { action: kind, pointer: 'click' as const, multiline: false }
    const input = (target: ReadyTarget) => clickAt(this.#bridge.session, this.#context, pointOf(target.point), deadline, dispatch)
    const acted = await this.#act({ locator, intent, input, commandToken }, deadline)
    if (!acted.ok) return acted
    if (acted.kind === 'unchanged') return { ok: true, kind, changed: false, page: acted.page }
    const failure = await this.#bridge.resolving(locator, () => awaitCheckedState({ world: this.#world, locator, intent, via: acted.via, deadline }))
    if (failure !== undefined) return { ok: false, failure }
    return { ok: true, kind, changed: true, ...(acted.via === undefined ? {} : { via: acted.via }), page: acted.page }
  }

  async #scroll(command: Extract<BrowserCommand, { kind: 'scroll' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const problem = scrollProblem(command)
    if (problem !== undefined) return { ok: false, failure: problem }
    // One scroll is one wheel event carrying the whole delta, as on Chromium. Firefox moves at most one page for it;
    // splitting the delta into several turns would have the page hear several wheel events nobody asked for, and a
    // page that loads more as it nears its end would load again for each.
    const input = ({ point, scale }: ReadyTarget) => wheelAt(this.#bridge.session, this.#context, pointOf(point), { x: command.x * scale, y: command.y * scale }, deadline, dispatch)
    return passed('scroll', await this.#act({ locator: command.locator, intent: { action: 'scroll', multiline: false }, input, commandToken }, deadline))
  }

  // Firefox draws a select's list outside the page, where input cannot reach it, so a select is chosen with the keyboard
  // while it is closed, by the plan the shared check makes. Each key is readied and guarded as a press on the select.
  async #select(command: Extract<BrowserCommand, { kind: 'select' }>, deadline: Deadline, dispatch: Dispatch, commandToken: number | undefined): Promise<CommandResult> {
    const problem = optionChoicesProblem(command.choices)
    if (problem !== undefined) return { ok: false, failure: problem }
    const { locator } = command
    const intent = selectIntent(command)
    return this.#bridge.resolving(locator, async () => {
      for (;;) {
        const target = await waitUntilActionable({ world: this.#world, locator, intent, deadline, pendingNavigation: () => this.#pending })
        if (!target.ok) return target
        if (target.kind === 'unchanged') return { ok: true, kind: 'select', changed: false, page: target.page }
        if (this.#pending !== undefined) continue
        if (target.plan === null) throw new Error("Retest's page script readied a select without the keys that choose it")
        const typed = await this.#typeSelection({ locator, intent, plan: target.plan, document: target.context, commandToken }, deadline, dispatch)
        if (typed !== undefined) return typed
      }
    })
  }

  // As on Chromium, with one difference Firefox makes: its sandbox has no Navigation API, so the guard cannot see the
  // page set off for another document. Retest reads that from Firefox's own navigation events instead: once the page
  // began to open another document, or opened one, after a key went, it types no more.
  async #typeSelection({ locator, intent, plan, document, commandToken }: Typing, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult | undefined> {
    const problem = selectionProblem(plan)
    if (problem !== undefined) return { ok: false, failure: { class: 'unsupported', message: `Could not select ${describeChoices(intent)} in ${describeLocator(locator)}: ${problem} Retest sent no input.`, details: { inputSent: false } } }
    const quietMs = Math.min(plan.quietMs, deadline.remainingMs)
    if (quietMs > 0) await sleep(quietMs, undefined, { signal: deadline.signal })
    const commits = this.#commits
    const heard: (Selection | undefined)[] = []
    for (const [index, planned] of plan.keys.entries()) {
      const typed: KeysTyped = { locator, intent, sent: index, of: plan.keys.length, heard: lastHeard(heard) }
      if (index > 0 && (this.#pending !== undefined || this.#commits !== commits)) return selectionLeft(typed)
      const key = plannedKey(planned)
      const typing: GuardedIntent = { ...intent, typing: { strokes: pressedStrokes(key) } }
      const acting = { locator, intent: typing, input: () => pressKey(this.#bridge.session, this.#context, key, deadline, dispatch), commandToken }
      const seeing = await this.#actSeeing(acting, document, deadline)
      if (!('target' in seeing)) return index === 0 ? undefined : selectionLeft(typed)
      const { target, verdict } = seeing
      if (!target.ok) return index === 0 ? target : { ok: false, failure: selectionCut(typed, target.failure) }
      if (target.kind === 'unchanged') return { ok: true, kind: 'select', changed: index > 0, page: target.page }
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
    const seeing = await this.#bridge.resolving(acting.locator, () => this.#actSeeing(acting, undefined, deadline))
    if (!('target' in seeing)) throw new Error("Retest's action moved on from a document it was not bound to")
    return seeing.target
  }

  // Input goes to whatever document the tab holds when Firefox dispatches it. A navigation Firefox began after the
  // page's ready answer would take it into the document it opens, so such a target is let go, and the element is looked
  // for again once that navigation is over.
  #actSeeing(acting: Acting, document: number | undefined, deadline: Deadline): Promise<Seeing | MovedOn> {
    return this.#actSeeingInOrder(acting, document, deadline)
  }

  async #actSeeingInOrder({ locator, intent, input, commandToken, hold }: Acting, document: number | undefined, deadline: Deadline): Promise<Seeing | MovedOn> {
    // The tab's window is brought to the front before its element is readied. Four windows of one browser filling at
    // once, ten rounds of four with and without one input turn for the whole browser, lost no text either way, so each
    // window's actions run on their own.
    try {
      await this.#client.send('browsingContext.activate', { context: this.#context }, { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
    } catch (error) {
      if (error instanceof BidiProtocolError) throw new BrowserError({
        class: error.error === 'no such frame' ? 'session_lost' : 'not_actionable',
        message: `Firefox could not activate the window before Retest readied its input: ${error.error}. Retest sent no input.`,
        details: { inputSent: false },
      }, { cause: error })
      throw cdpError('browsingContext.activate', this.#bridge.session.id, error)
    }
    const pending = () => (hold?.leaving !== undefined ? undefined : this.#pending)
    // Each look starts by letting go what the hold held before it, as the page's own, and waits for that document.
    const looking = () => {
      hold?.letGo()
      return pending()
    }
    const wait = { world: this.#world, locator, intent, deadline, pendingNavigation: looking }
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
      if (pending() !== undefined) {
        await disarmGuard(this.#world, guard, deadline)
        continue
      }
      const verdict = await this.#causes.delivering(commandToken, async () => {
        const deliver = async (): Promise<void> => {
          await this.#bridge.callsStarted(Math.max(1, Math.min(deadline.remainingMs, verdictWaitMs)))
          await input(target)
        }
        const heard = await guardInput(this.#world, guard, deadline, deliver)
        await this.#tellAddress(guard.context, deadline)
        return heard
      })
      const failure = guardFailure(verdict, intent, locator)
      return { target: failure === undefined ? target : { ok: false, failure }, verdict }
    }
  }

  // Firefox tells no event for a move within the document, such as `history.pushState`, so after an action's input the
  // document says where it is while the action is still being delivered, and a move the input caused is the action's.
  // A document that went meanwhile has nothing to say.
  async #tellAddress(context: number, deadline: Deadline): Promise<void> {
    await this.#world.callIn(context, tellAddressFunction, [], s.boolean(), new Deadline(Math.max(1, Math.min(deadline.remainingMs, addressCallMs)))).catch(() => undefined)
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

  async #dispose(deadline: Deadline): Promise<void> {
    this.#lostReason ??= 'the page was closed'
    this.#titles.dispose()
    this.#wake()
    for (const watcher of [...this.#watchers]) watcher.onStopped(this.#lostReason)
    this.#stop()
    this.#bridge.channel.close(this.#lostReason)
    if (this.#client.closeReason !== undefined) return
    const options = () => ({ timeoutMs: deadline.commandTimeoutMs })
    const problems: string[] = []
    const attempt = async (what: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work()
      } catch (error) {
        // A browser that went away took the tab and its user context with it.
        if (this.#client.closeReason !== undefined) return
        problems.push(`Could not ${what}: ${errorMessage(error)}`)
      }
    }
    const preload = this.#preload
    if (preload !== undefined) await attempt("remove the page's preload script", () => this.#client.send('script.removePreloadScript', { script: preload }, options()))
    await attempt("stop following the page's events", () => this.#client.send('session.unsubscribe', { events: ['browsingContext', 'script'], contexts: [this.#context] }, options()))
    await attempt("close the page's user context", () => inWindowOrder(this.#client, deadline, () => this.#client.send('browser.removeUserContext', { userContext: this.#userContext }, options())))
    if (problems.length > 0) throw new BrowserError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  #operationError(command: string, error: unknown, timeoutMs: number): unknown {
    if (error instanceof BrowserError) return error
    const blocked = this.#blocked(command, false)
    if (blocked !== undefined) return new BrowserError(blocked, { cause: error })
    if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return new BrowserError(connectionEnded(command, false, error.reason), { cause: error })
    if (error instanceof CdpTimeoutError) return new BrowserError({ class: 'timeout', message: `Could not ${command} within ${timeoutMs} ms.` }, { cause: error })
    const reason = this.#client.closeReason
    if (reason !== undefined) return new BrowserError(connectionEnded(command, false, reason), { cause: error })
    return error
  }

  #listen<T extends { context: string }>(method: string, schema: Schema<T>, handle: (params: T) => void): void {
    this.#stops.push(
      this.#client.on(method, (params) => {
        const read = readBidi(schema, params, method)
        if (read.context === this.#context) handle(read)
      }),
    )
  }

  #stop(): void {
    for (const stop of this.#stops.splice(0)) stop()
    this.#bridge.dispose()
  }

  // Firefox began a navigation of the tab's document. A navigation the page starts while an action's input is being
  // delivered is that action's; one a goto, reload or move through the history starts is that command's. Firefox says
  // nothing of who asked for a navigation, so the first one to start while such a command opens is the command's, as
  // its answer later confirms for a goto or a reload, and any other is the page's own, such as one a script starts
  // while the document the goto opened is parsed.
  #navigationStarted(navigation: string | null, url: string): void {
    const id = navigation ?? `navigation-${this.#commits}-${url}`
    const commands = this.#opening > 0 && !this.#claimed
    if (commands) this.#claimed = true
    else this.#causes.requested(url)
    this.#causes.started(url, id)
    this.#started.add(id)
    this.#pending = { id, url }
    this.#navigationStarts.emit(url)
    for (const watcher of [...this.#watchers]) watcher.onStarted(id)
  }

  // A document committed, as its own run of Retest's script told: the document of the navigation on its way, or one no
  // navigation announced, such as Firefox's error page for an address it refused at once.
  #committed(href: string): void {
    this.#documents += 1
    if (this.#documents === 0) return
    const id = this.#pending?.id ?? `document-${this.#documents}`
    this.#pending = undefined
    this.#started.clear()
    this.#document = id
    this.#world.reset()
    this.#bridge.forgetDocument()
    this.#guardDocument()
    this.#changed()
    this.#moveTo(href, id)
    for (const watcher of [...this.#watchers]) watcher.onCommitted(id)
  }

  // Installs the guard in the document that just committed, as early as Retest can. A document that went before the call
  // reached it needs none, and an action's own check installs it where this call did not.
  #guardDocument(): void {
    const params = { functionDeclaration: wrapped(installGuardFunction), arguments: [{ type: 'string', value: '[]' }], target: { context: this.#context, sandbox: sandboxName }, awaitPromise: false, resultOwnership: 'none' }
    this.#client.send('script.callFunction', params, { timeoutMs: guardInstallMs }).catch(() => undefined)
  }

  #contentLoaded(navigation: string | null, url: string): void {
    const id = this.#documentOf(navigation, url)
    this.#titles.contentLoaded(id)
    for (const watcher of [...this.#watchers]) watcher.onContentLoaded(id, url)
  }

  #loaded(navigation: string | null, url: string): void {
    const id = this.#documentOf(navigation, url)
    for (const watcher of [...this.#watchers]) watcher.onLoaded(id)
  }

  // Firefox names a document's events by the navigation that opened it; a document no navigation announced takes the
  // id the page gave it, and its events, which carry an id of Firefox's own, are its. Firefox 133 names a document's
  // load by the navigation under way when it fires instead: a load handler that sets off for another address has the
  // load named by that navigation, though it is the current document's, at the current document's address.
  #documentOf(navigation: string | null, url: string): string {
    const current = this.#document ?? 'document'
    if (navigation === null) return current
    const pending = this.#pending
    if (pending !== undefined && navigation === pending.id && url !== pending.url && url === this.#url?.href) return current
    return current.startsWith('document-') && !this.#started.has(navigation) && navigation !== current ? current : navigation
  }

  // The response of the navigation under way says it opens no document: no content, or a download. Firefox 133 keeps such
  // a navigation as started until another one begins, and only then says it failed, so the response is what ends it.
  #responded({ navigation, request, response }: Infer<typeof responseSchema>): void {
    if (navigation === null || navigation !== this.#pending?.id) return
    const disposition = response.headers?.find((header) => header.name.toLowerCase() === 'content-disposition')?.value.value
    const download = disposition !== undefined && /^\s*attachment\b/i.test(disposition)
    if (response.status !== 204 && response.status !== 205 && !download) return
    this.#pending = undefined
    this.#causes.stoppedLoading()
    this.#started.delete(navigation)
    for (const watcher of [...this.#watchers]) watcher.onAbandoned(navigation, request.url)
  }

  #navigationFailed(navigation: string | null): void {
    if (navigation === null) return
    if (this.#pending?.id === navigation) {
      this.#pending = undefined
      this.#causes.stoppedLoading()
    }
    this.#started.delete(navigation)
    for (const watcher of [...this.#watchers]) watcher.onFailed(navigation)
  }

  #movedWithinDocument(href: string): void {
    this.#moveTo(href, undefined)
    for (const watcher of [...this.#watchers]) watcher.onMovedWithinDocument()
  }

  #promptOpened(type: string): void {
    this.#dialog = type
    const reason = `a JavaScript ${type} dialog holds the page`
    this.#bridge.channel.block(reason)
    for (const watcher of [...this.#watchers]) watcher.onStopped(reason)
  }

  #promptClosed(): void {
    this.#dialog = undefined
    if (this.#lostReason === undefined) this.#bridge.channel.unblock()
  }

  #lose(reason: string): void {
    if (this.#lostReason !== undefined) return
    this.#lostReason = reason
    this.#bridge.channel.close(reason)
    this.#titles.dispose()
    this.#wake()
    for (const watcher of [...this.#watchers]) watcher.onStopped(reason)
  }

  // Retest's own script speaks through two channels of this tab: a document committed, and the document changed. A
  // change also tells the document's address, which is how a new path within the document, as `history.pushState`
  // makes, reaches Retest on Firefox: right after the input of the action that caused it, at the next change of the
  // document, or at the document's next check of its own address, whichever comes first.
  #message(params: unknown): void {
    let read
    try {
      read = readBidi(messageSchema, params, 'script.message')
    } catch {
      return
    }
    if (read.source.context !== this.#context || read.data.type !== 'string' || read.data.value === undefined) return
    const href = read.data.value
    if (read.channel === this.#channels.documented) {
      this.#committed(href)
      return
    }
    if (read.channel !== this.#channels.changed) return
    this.#changed()
    const url = URL.parse(href)
    if (url === null || this.#pending !== undefined || this.#url === undefined) return
    if (url.origin === this.#url.origin && originAndPath(url) !== originAndPath(this.#url)) this.#movedWithinDocument(href)
  }

  #holdAddress(address: string): void {
    const url = URL.parse(address) ?? undefined
    if (url === undefined) return
    this.#url = url
    if (isWebUrl(url)) this.#origins.add(url.origin)
  }

  // A new document is always news; within a document only a new path is, since a fragment is never reported.
  #moveTo(address: string, navigation: string | undefined): void {
    const url = URL.parse(address)
    if (url === null) return
    const previous = this.#url
    this.#commits += 1
    this.#url = url
    if (isWebUrl(url)) this.#origins.add(url.origin)
    const path = originAndPath(url)
    if (navigation !== undefined) {
      const start = this.#causes.committed(navigation)
      this.#navigations.emit({ url: path, title: this.#titles.committed(navigation), document: 'new', ...start })
    } else if (previous === undefined || originAndPath(previous) !== path) {
      this.#navigations.emit({ url: path, title: this.#titles.movedWithinDocument(), document: 'same', ...this.#causes.movedWithinDocument() })
    }
  }
}

// A command's last round trip is given what is left of its budget, and Firefox's answer can be timed out a moment
// before that budget has passed. A timeout is never told early: the command waits until its budget is up, as
// Chromium's page does, so a check that polls takes a timeout at the deadline as the deadline.
async function outlast(endsAt: number, signal: AbortSignal | undefined): Promise<void> {
  for (let left = endsAt - monotonicClock(); left > 0 && signal?.aborted !== true; left = endsAt - monotonicClock()) {
    await sleep(Math.ceil(left), undefined, signal === undefined ? {} : { signal }).catch(() => undefined)
  }
}

function passed(kind: 'click' | 'tap' | 'fill' | 'hover' | 'press' | 'scroll', acted: ActionTarget): CommandResult {
  return acted.ok ? { ok: true, kind, page: acted.page } : acted
}

function guardOf({ context, token }: ReadyTarget): Guard {
  if (token === null) throw new Error("Retest's page script readied an action without arming its guard")
  return { context, token }
}

/** A select's plan as it types: its keys, and the command they belong to. */
type Typing = { locator: LocatorRecipe; intent: Extract<ActionIntent, { action: 'select' }>; plan: SelectPlan; document: number; commandToken: number | undefined }

/** The select whose keys went, what it was asked to hold, its document, and what the guard read as the last key arrived. */
type AwaitedSelection = { locator: LocatorRecipe; intent: Extract<ActionIntent, { action: 'select' }>; document: number; heard: Selection | undefined }

/** How far a select's plan got: `sent` of its `of` keys went, and the guard read `heard` as the last of them arrived. */
type KeysTyped = { locator: LocatorRecipe; intent: Extract<ActionIntent, { action: 'select' }>; sent: number; of: number; heard: Selection | undefined }

type Seeing = { target: ActionTarget; verdict: GuardVerdict | undefined }

type MovedOn = { movedOn: true }

function lastHeard(heard: readonly (Selection | undefined)[]): Selection | undefined {
  return heard.findLast((each) => each !== undefined)
}

// The select failures below are worded as the Chromium page words them, so a test reads the same on either engine.
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

// The document a fill readied its field in went before Retest sent a key: the page left on its own, and nothing was typed.
function movedBeforeTyping(intent: GuardedIntent, locator: LocatorRecipe): Failure {
  const text = intent.secret === undefined ? 'the text' : secretPlaceholder(intent.secret)
  return {
    class: 'not_actionable',
    message: `Could not fill ${describeLocator(locator)} with ${text}: the page opened another document after Retest readied the field and before it typed. Retest typed nothing.`,
    details: { inputSent: false, moved: true },
  }
}

function selectionStayed(locator: LocatorRecipe, intent: Extract<ActionIntent, { action: 'select' }>, last: Selection | undefined): Failure {
  const action = `select ${describeChoices(intent)} in ${describeLocator(locator)}`
  const after =
    last === undefined || last.status === 'lost'
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

// Firefox's BiDi emulates no touch screen in the release Retest drives, so no page takes a tap.
function noTouchScreen(command: Extract<BrowserCommand, { kind: 'tap' }>): Failure {
  return { class: 'unsupported', message: `Could not tap ${describeLocator(command.locator)}: the page does not emulate a touch screen, and tap() needs one.` }
}

function stopped(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function waitedWholeBudget(failure: Failure, budgetMs: number): boolean {
  return failure.class === 'timeout' || failure.details?.['waitedMs'] === budgetMs
}
