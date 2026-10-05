import type { NativeExecutionIdentity } from '../native/identity.ts'
import type { NativeAppSession, NativeSessionOptions, NativeCapture, UnknownOutcome } from '../native/session.ts'
import type { NativeUnknownOutcome } from '../native/interaction-session.ts'
import type { FrameSource } from '../media/capture.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { DiagnosticCollection, DiagnosticSink } from '../diagnostics/observations.ts'
import type { CommandResult, Observation, PageCommand } from '../protocol/commands.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { Failure } from '../protocol/failures.ts'
import type { TextQuery } from '../protocol/host-check.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { NavigationCause, NavigationDocument, PageFacts } from '../protocol/page-facts.ts'
import type { StorageState } from '../protocol/storage-state.ts'

export type { Emulation } from '../protocol/emulation.ts'
export type { TextQuery } from '../protocol/host-check.ts'

// The session and capability contract. A runtime is what sessions open in: a browser process for the web, later a
// simulator or a desktop app. A session is one app's page or window in one attempt. The runner acquires a target's
// runtime from the driver its kind needs, opens a session for each app before the test's first action, sends each
// session bounded commands, and keeps what it observes. `OwnedBrowser` and `OwnedPage` are the web runtime and
// session as the runner holds them; `WebRuntime` and `WebSession` add what every driver states. Chromium and native drivers
// share this contract; the runner supplies the native interaction layer for native sessions.

/** The kinds of target a session runs on. The first web engine is Chromium; native targets use their own executor. */
export type TargetKind = 'web' | 'ios-simulator' | 'macos'

/** The native kinds of target: an app on an iOS simulator, and an app on the Mac Retest runs on. */
export type NativeKind = Exclude<TargetKind, 'web'>

/** The engines a web target runs on. Chromium, Chrome and Edge are all the `chromium` engine. */
export type WebEngine = 'chromium' | 'firefox' | 'webkit'

/**
 * The drivers a target can need: one for each web engine and one for each native kind. The
 * runner asks the driver a target needs for its runtime, and no other: a target whose driver does not exist fails
 * setup by name, and no driver stands in for another.
 */
export type DriverName = WebEngine | NativeKind

/**
 * What a web session runs on, as its driver read it: the engine, the product and version the browser itself
 * reported, the absolute path of the executable that was started, and the ids of the processes it owns. A Chromium
 * browser owns one process, which is also its process group.
 */
export type WebRuntimeIdentity = {
  readonly kind: 'web'
  readonly engine: WebEngine
  readonly product: string
  readonly version: string
  readonly executablePath: string
  readonly processIds: readonly number[]
}

/**
 * What a native session runs on: the app's bundle id and version as its bundle states them, the absolute path of
 * the app that was installed or launched, the processes it owns, and for an iOS simulator, its device and runtime
 * as the simulator names them. The runner embeds the execution identity read from the real target.
 */
export type NativeRuntimeIdentity = { readonly execution?: NativeExecutionIdentity } & (
  | {
      readonly kind: 'ios-simulator'
      readonly bundleId: string
      readonly appVersion?: string
      readonly appPath: string
      readonly device: string
      readonly runtime: string
      readonly processIds: readonly number[]
    }
  | { readonly kind: 'macos'; readonly bundleId: string; readonly appVersion?: string; readonly appPath: string; readonly processIds: readonly number[] }

)

export type RuntimeIdentity = WebRuntimeIdentity | NativeRuntimeIdentity

/**
 * Who holds a session: the run, and the test, attempt and app within it. An attempt gives each of its apps a session
 * of its own, so an attempt and an app name one session.
 */
export type SessionOwner = { readonly runId: string; readonly testId: string; readonly attemptId: string; readonly app: string }

/**
 * A session's identity: its id, which every observation it serves and every piece of evidence it captures carries,
 * who holds it, and what it runs on.
 */
export type SessionIdentity = { readonly sessionId: string; readonly owner: SessionOwner; readonly runtime: RuntimeIdentity }

/**
 * How far a command's input got. Every event a command sends to act is input, a click's mouse move among them, since
 * a move can set off hover handlers. `not_sent`: no input event went. It does not mean nothing changed: before any
 * input, on every look while an action waits for its element, the readiness look may have focused the element (for
 * `fill` and `press`), selected a field's text (for `fill`) or scrolled the element into view (for every action but
 * `press`), and the page's focus, blur and scroll handlers run on those. A driver author or a replay host must not
 * read `not_sent` as an untouched page. `sent`: the target confirmed each input that went, so it may have acted.
 * `unknown`: an input went and no confirmation came back: the connection was lost, the time ran out, or the browser
 * answered it with an error. Chrome's error answer does not prove the event was not dispatched, so it counts as
 * unknown, as the failure beside it says Retest cannot tell; an earlier event the target confirmed does not make it
 * sent. Input that may have gone is never sent again. Stopping a command sends nothing more and never takes back
 * input that went.
 */
export type InputDispatch = 'not_sent' | 'sent' | 'unknown'

/**
 * A command's answer, and how far its input got. A command whose session was lost after its input went answers
 * `outcome_unknown`, with `input` `sent` or `unknown`; the runner keeps that answer and the last document it saw the
 * page commit, and takes no screenshot of a session that is gone.
 */
export type DispatchedCommand = { readonly result: CommandResult; readonly input: InputDispatch }

/**
 * The session and generation an observation belongs to. A generation is one document of a web page, or one launch
 * of a native app. A reference to what an observation saw is good only in the session that served it: the parent
 * hands the test process each look's id with its session, and refuses an assertion that sends back another session,
 * as one replaying a look an earlier attempt served would. To act, a reference is good only while its generation is
 * current. Chromium keeps that rule inside the page: each action's element is readied and guarded in
 * the document's own execution context, input readied in a document that has gone is never sent, and the element is
 * looked for again in the document that replaced it. Chromium does not report its generation.
 */
export type ObservationScope = { readonly sessionId: string; readonly generation: number }

/**
 * How to launch a browser. `hiddenVariables` are environment variables its process must not see, such as the ones AI
 * judges' credentials are read from; the browser inherits every other variable of this process.
 */
export type OutputRedactor = { write(text: string): string; end(): string }
export type LaunchOptions = { executablePath: string; logFile: string; headless: boolean; hiddenVariables?: readonly string[]; redact?: (text: string) => string; redactStream?: () => OutputRedactor }

/**
 * A browser context's proxy: Chrome's proxy server, `scheme://host:port`, and its bypass rules. Loopback
 * addresses go around the proxy unless `bypass` holds `<-loopback>`.
 */
export type ProxyOptions = { server: string; bypass: readonly string[] }

/**
 * How to open a page. Relative `goto` URLs resolve against `baseUrl`. `emulation` applies before the page loads
 * anything; without its `userAgent` the page keeps the browser's own. `storageState` is restored before the
 * test's first command: its cookies in the new context, and each origin's `localStorage` before that origin's
 * own scripts run. `proxy` is a setting of the page's new browser context, so every request of the page goes
 * through it.
 */
export type NewPageOptions = { baseUrl?: string; emulation?: Emulation; storageState?: StorageState; proxy?: ProxyOptions }

/**
 * What `readPage` saw. `url` is the main frame's origin and path as of its latest commit, and `title` the
 * document's title as the page has it, when it has one; the parent redacts, cleans and cuts it. `navigating` is
 * true while the frame is opening another document. `found` answers each query in order. `body` is false when the
 * document has no body, such as an XML or SVG document, so it has no visible text to read and `found` says nothing.
 */
export type PageReading = { url: string | undefined; title?: string | undefined; navigating: boolean; found: boolean[]; body?: false }

/**
 * A navigation of the main frame, told when it commits. `url` is its origin and path. `title` settles, and never
 * rejects, with the document's title as the page has it, or undefined when it has none: once its
 * `DOMContentLoaded` fires, once the next command to the page begins, or one second after the commit, whichever
 * comes first, and at the next commit with the title it had then. A navigation within the document settles at
 * once, with the title as it stands. `cause` says what started it, and `document` whether it committed a new
 * document or moved to a new path within the one the frame held. `commandToken` is the token `execute` was given
 * for the command whose input or `goto` started it, when one did, however late it commits.
 */
export type PageNavigation = {
  url: string
  title: Promise<string | undefined>
  cause: NavigationCause
  document: NavigationDocument
  commandToken?: number
}

/**
 * A `fill` whose value is the text to type. The parent reads a secret, and checks the page's origin may take
 * it, before the page sees the command, so the page never holds a secret reference. `secret` is the value's
 * label: the name of the secret it came from, written `{{name}}` wherever the page would name the value.
 *
 * `allowedOrigins` binds the text to those origins. The page checks the document's origin in the same call that
 * focuses the field, and from before the focus until the text arrives it cancels any navigation the page starts
 * to another document. While the browser is on a navigation of the frame, one the page began earlier or a
 * server redirected, the fill waits for the document it brings and checks that one instead. Should a document
 * still arrive while the text is on its way, its own guard stops the text. In every case the fill fails with
 * `not_actionable` naming the origin, and the text reaches no document Retest did not check.
 */
export type ResolvedFill = { kind: 'fill'; locator: LocatorRecipe; value: string; secret?: string; allowedOrigins?: readonly string[] }

/**
 * A page command as the page runs it: every `fill` carries the text to type, and every other command, `select`,
 * `check`, `uncheck` and `scroll` among them, is as the test sent it.
 */
export type BrowserCommand = Exclude<PageCommand, { kind: 'fill' | 'swipe' | 'nativeKeyboard' | 'nativeAlert' }> | ResolvedFill

/**
 * How long `close` waits for a browser's process group to go once it has been killed. A killed process takes a
 * moment to go, so this is the one wait no budget sets: it stands however small the budget is.
 */
export const closeGraceMs: number = 1000

/**
 * What sessions open in, whatever the kind of target. It tells of its loss once, to every listener, even one that
 * arrives after it. A loss ends each session in it: a command whose input may have gone answers `outcome_unknown`,
 * and one that sent nothing `session_lost`. `close` is finite, and a failure to close is reported beside the
 * failure that ended the test, never in its place.
 */
export interface SessionRuntime {
  readonly identity: RuntimeIdentity
  readonly connected: boolean
  /** Settles after stdout/stderr, every issued log write and the log close; present on runtimes that own output. */
  readonly outputSettled?: Promise<void>
  /** Returns a function that removes the listener. */
  onDisconnect(listener: (reason: string) => void): () => void
  /** Ends the runtime and everything it started within `timeoutMs`. A second call waits for the first. */
  close(timeoutMs: number): Promise<void>
}

/**
 * One app's page or window in one attempt, as every driver offers it. Each command is bounded by its `timeoutMs`
 * and never throws for a page or application problem: the answer carries the failure, and says how far the input
 * got. Aborting `signal` stops the command: input not yet sent is never sent, and input already sent is not taken
 * back. The failure then takes its class from `signal.reason`, a `Failure`, and anything else counts as a timeout.
 * `dispose` is finite, and its failure never replaces the one that ended the test.
 */
export interface Session<Command> {
  dispatch(command: Command, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand>
  /** A PNG of what the session shows, within `timeoutMs`. Sends no input. */
  screenshot(timeoutMs: number): Promise<Uint8Array>
  capture?(timeoutMs: number): Promise<{ readonly ok: true; readonly capture: SessionCapture } | { readonly ok: false; readonly failure: Failure }>
  cancel?(reason: Failure): void
  reconcile?(timeoutMs: number): Promise<readonly SessionUnknownOutcome[]>
  readonly unknownOutcomes?: readonly SessionUnknownOutcome[]
  dispose(timeoutMs: number): Promise<void>
}

/** Navigation, a web capability: `goto` among the commands, and the page's address, title and committed navigations. */
export interface NavigationCapability {
  /**
   * The main frame's origin and path as of its latest commit, as navigations are told, or undefined while it has
   * none. The parent's secret origin check reads it, so it never waits for a title.
   */
  readonly url: string | undefined
  /**
   * Reads the page's address, its title and whether its visible text holds each query, within `timeoutMs`. Sends
   * no input. The visible text is `document.body.innerText` of the top-level document, read by `pageTextHolds`,
   * and never leaves the page: only the answers do, one for each query.
   */
  readPage(queries: readonly TextQuery[], timeoutMs: number): Promise<PageReading>
  /**
   * Main frame navigations, each told when it commits: a new document, or a new path within the document. Returns
   * a function that removes the listener.
   */
  onNavigation(listener: (navigation: PageNavigation) => void): () => void
}

/**
 * Storage state, a web capability: the context's cookies and `localStorage` read back here, and restored into a new
 * context by `NewPageOptions.storageState`.
 */
export interface StorageStateCapability {
  /**
   * Reads the context's cookies, and `localStorage` for each origin the page visited, within `timeoutMs`. What
   * it returns holds session cookies: it goes to the run folder's `states` and nowhere else.
   */
  captureState(timeoutMs: number): Promise<StorageState>
}

/**
 * Contexts, the proxy and emulation, web capabilities: each session opens in a new browser context of its own,
 * whose `NewPageOptions` give its storage state, its proxy and the screen it emulates.
 */
export interface ContextCapability {
  /** Opens a page in a new browser context within `timeoutMs`. */
  newPage(options: NewPageOptions, timeoutMs: number): Promise<WebSession>
}

/** A browser this run launched, with its own process group and temporary profile. */
export interface OwnedBrowser {
  readonly product: string
  readonly version: string
  readonly userAgent: string
  /** The browser's process id, which is also its process group. */
  readonly pid: number
  /** The absolute path of the executable that was launched. */
  readonly executablePath: string
  readonly connected: boolean
  /** Settles after every stdout/stderr log write and the log close, when this runtime owns output. */
  readonly outputSettled?: Promise<void>
  /** Process and output completion, independent of whether another cleanup step failed. */
  readonly gone?: Promise<void>
  /** Opens a page in a new browser context within `timeoutMs`. */
  newPage(options: NewPageOptions, timeoutMs: number): Promise<OwnedPage>
  /** Returns a function that removes the listener. */
  onDisconnect(listener: (reason: string) => void): () => void
  /**
   * Asks the browser to close and ends its process group at once, since a test browser has nothing to save and
   * Chrome's own shutdown takes about half a second. `close` waits up to `closeGraceMs` for the group to go, within
   * `timeoutMs`. Resolves once the group is gone and the profile is removed. A second call waits for the first.
   */
  close(timeoutMs: number): Promise<void>
}

/** A web page as the runner holds it: its commands, navigation, storage state, a screenshot and disposal. */
export interface OwnedPage extends NavigationCapability, StorageStateCapability {
  identify?(session: SessionIdentity): void
  /**
   * Runs a command within `timeoutMs`, and answers as `Session.dispatch` does, without saying how far the input got.
   * Never throws for a page or application problem; the result carries the failure instead. Aborting `signal` stops
   * the command: input not yet sent is never sent, and input already sent is not taken back. The failure then takes
   * its class from `signal.reason`, a `Failure` (anything else counts as a timeout), and says whether input was sent.
   * `tap` needs a page that emulates a touch screen. A result that passed names the page the command went to in
   * `page`, read in the same call that checked or read the element, and after `load` for a `goto`. Before a command
   * goes past its start, every navigation already told has its `title` settled. A navigation the command's input or
   * `goto` started carries `commandToken` back. An `observe` answers with `changes`, how many times the document has
   * changed as the page counts it; one with `after` first waits for the count to pass `after.changes`, or for
   * `after.waitMs`, and says how long in `waitedMs`.
   */
  execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult>
  screenshot(timeoutMs: number): Promise<Uint8Array>
  /** Disposes the page's browser context. */
  dispose(timeoutMs: number): Promise<void>
  /**
   * Diagnostics, a capability of Chromium pages: starts collecting the page's console messages, runtime errors and
   * network metadata into `sink`, within `timeoutMs`, and resolves with what the collection covers. The parent calls
   * it before the page's first navigation, and stops it once the attempt's checks are over. Collecting is read-only:
   * it sends no input, never reads a page object and never asks for a body. Rejects when capture cannot start. Absent
   * on a driver that collects nothing, whose results then say so.
   */
  collectDiagnostics?(sink: DiagnosticSink, timeoutMs: number): Promise<DiagnosticCollection>
}

/**
 * One locator's matches as a keyed read saw them: the observation `observe` answers, and a key for each element it
 * lists, in the same order.
 */
export type KeyedRead = { readonly observation: Observation; readonly keys: readonly string[] }

/** A keyed read of several locators, taken at once, and the page it read; or why there is none. */
export type KeyedReading = { readonly ok: true; readonly reads: readonly KeyedRead[]; readonly page?: PageFacts } | { readonly ok: false; readonly failure: Failure }

/**
 * Element identity, a web capability: telling one element from another from one call to the next, which text never
 * does, since two elements can show the same and a page can put one in another's place. A driver offers it by these
 * two methods; the agent sessions detect them on the page. Chromium's page offers it.
 */
export interface ElementIdentity {
  /**
   * Reads each locator's matches as `observe` does, all in one task of the page's current main-frame document, so
   * nothing of the page runs between them, and gives each element listed a key: the same key for the same node in
   * every read of that document, never the key of another node, and a key read in an earlier document matches
   * nothing. `keys.length` equals the elements the observation lists. Sends no input.
   */
  readElements(locators: readonly LocatorRecipe[], timeoutMs: number, signal?: AbortSignal): Promise<KeyedReading>
  /**
   * Sends `command` as `dispatch` does, and only to the node `key` names: in the task that readies the element, the
   * task of the hit test, the command's locator must find that node, or the command is refused at once, with no wait
   * for the element to come back, as `not_actionable` with `details.refused` `'moved'`, and no input goes. A command
   * that acts on no element is refused with `usage`, since there is no node to hold it to.
   */
  dispatchTo(command: BrowserCommand, key: string, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand>
}

/** A web session: the shared commands, with navigation and storage state. A Chromium page is one. */
export interface WebSession extends Session<BrowserCommand>, OwnedPage {
  identify?(session: SessionIdentity): void
  frameSource?(identity: RecordIdentity): FrameSource
}

/**
 * A web runtime: a browser whose every session opens in a new context of its own, with its storage state, proxy and
 * emulation. A Chromium browser is one.
 */
export interface WebRuntime extends SessionRuntime, ContextCapability, OwnedBrowser {
  readonly identity: WebRuntimeIdentity
  newPage(options: NewPageOptions, timeoutMs: number): Promise<WebSession>
}

/**
 * A browser's identity as a web runtime, from what the browser reported at launch.
 *
 * @example webRuntimeIdentity(browser, 'chromium') // { kind: 'web', engine: 'chromium', product: 'Chrome', version: '154.0.8037.92', executablePath, processIds: [4242] }
 */
export function webRuntimeIdentity(browser: Pick<OwnedBrowser, 'product' | 'version' | 'executablePath' | 'pid'>, engine: WebEngine): WebRuntimeIdentity {
  const { product, version, executablePath, pid } = browser
  return { kind: 'web', engine, product, version, executablePath, processIds: [pid] }
}

/** A native app build to install or launch: the absolute path of its app bundle. */
export type LaunchSpec = { readonly arguments: readonly string[]; readonly environment: Readonly<Record<string, string>> }

export type SessionCapture = NativeCapture | { readonly png: Uint8Array; readonly source: 'chromium'; readonly reference: { readonly sessionId: string }; readonly capturedAt: string }
export type SessionUnknownOutcome = UnknownOutcome | NativeUnknownOutcome

export type AppBuild = { readonly appPath: string }

/** Where a native app is: not running, or running in the background or in the foreground. */
export type AppState = 'not_running' | 'background' | 'foreground'

/**
 * What a native session starts from. Relaunching an app clears nothing by itself: `appData` and `keychain` each say
 * whether the driver resets it before the session starts, or keeps what the last session left.
 */
export type ResetPolicy = { readonly appData: 'reset' | 'kept'; readonly keychain: 'reset' | 'kept' }

/** A gesture on the element a locator finds, or without one, on the centre of the screen. */
export type Gesture =
  | { readonly kind: 'tap'; readonly locator?: LocatorRecipe }
  | { readonly kind: 'swipe'; readonly locator?: LocatorRecipe; readonly direction: 'up' | 'down' | 'left' | 'right' }

/** A request's answer: done, or the failure that says why not. */
export type RequestResult = { readonly ok: true } | { readonly ok: false; readonly failure: Failure }

/** A request's answer, and how far the request got, as `InputDispatch` counts it for input. */
export type DispatchedRequest = { readonly result: RequestResult; readonly input: InputDispatch }

/** Where an app is, or the failure that says why it could not be read. */
export type AppStateReading = { readonly ok: true; readonly state: AppState; readonly endedUnexpectedly?: boolean } | { readonly ok: false; readonly failure: Failure }

/**
 * An app's lifecycle, a native capability: install a build, launch the app, bring it to the front, terminate it and
 * read where it is. Each request is bounded by its `timeoutMs` and never throws for an app or platform problem: the
 * answer carries the failure, and says how far the request got, so a `terminate` whose time ran out after it went
 * answers `unknown`. Aborting `signal` stops the request: one not sent is never sent, and one that went is not taken
 * back. Terminating an app resets none of its data; `resetPolicy` says what a session starts from.
 */
export interface AppLifecycleCapability {
  readonly resetPolicy: ResetPolicy
  install?(build: AppBuild, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest>
  launch(timeoutMs: number, signal?: AbortSignal, spec?: LaunchSpec): Promise<DispatchedRequest>
  activate(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest>
  terminate(timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest>
  /** Sends nothing to the app. */
  appState(timeoutMs: number, signal?: AbortSignal): Promise<AppStateReading>
}

/** Gestures, a native capability: each sent once as real input, as `Session.dispatch` sends a command. */
export interface GestureCapability {
  gesture(gesture: Gesture, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedRequest>
}

/** A native session: commands, lifecycle, gestures, capture and its unresolved action outcomes. */
export interface NativeSession<Command> extends Session<Command>, AppLifecycleCapability, GestureCapability {
  capture(timeoutMs: number): Promise<{ readonly ok: true; readonly capture: NativeCapture } | { readonly ok: false; readonly failure: Failure }>
  cancel(reason: Failure): void
  reconcile(timeoutMs: number): Promise<readonly SessionUnknownOutcome[]>
  readonly unknownOutcomes: readonly SessionUnknownOutcome[]
}

/** What native sessions open in: a simulator, or the Mac Retest runs on. */
export interface NativeRuntime extends SessionRuntime {
  readonly identity: NativeRuntimeIdentity
  openSession(options: NativeSessionOptions, timeoutMs: number, signal?: AbortSignal): Promise<{ readonly ok: true; readonly session: NativeAppSession } | { readonly ok: false; readonly failure: Failure }>
}

/** Thrown when a browser cannot be launched. The message names the problem. */
export class LaunchError extends Error {
  override readonly name = 'LaunchError'
  readonly failure: Failure

  constructor(message: string, options?: ErrorOptions & { failureClass?: 'setup_failed' | 'cleanup_failed' }) {
    super(message, options)
    this.failure = { class: options?.failureClass ?? 'setup_failed', message }
  }
}
