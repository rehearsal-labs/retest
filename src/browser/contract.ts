import type { CommandResult, PageCommand } from '../protocol/commands.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { Failure } from '../protocol/failures.ts'
import type { TextQuery } from '../protocol/host-check.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { NavigationCause, NavigationDocument } from '../protocol/page-facts.ts'
import type { StorageState } from '../protocol/storage-state.ts'

export type { Emulation } from '../protocol/emulation.ts'
export type { TextQuery } from '../protocol/host-check.ts'

export type LaunchOptions = { executablePath: string; logFile: string; headless: boolean }

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
export type BrowserCommand = Exclude<PageCommand, { kind: 'fill' }> | ResolvedFill

/**
 * How long `close` waits for a browser's process group to go once it has been killed. A killed process takes a
 * moment to go, so this is the one wait no budget sets: it stands however small the budget is.
 */
export const closeGraceMs: number = 1000

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

export interface OwnedPage {
  /**
   * The main frame's origin and path as of its latest commit, as navigations are told, or undefined while it has
   * none. The parent's secret origin check reads it, so it never waits for a title.
   */
  readonly url: string | undefined
  /**
   * Runs a command within `timeoutMs`. Never throws for a page or application problem; the result carries the
   * failure instead. Aborting `signal` stops the command: input not yet sent is never sent, and input already
   * sent is not taken back. The failure then takes its class from `signal.reason`, a `Failure` (anything else
   * counts as a timeout), and says whether input was sent. `tap` needs a page that emulates a touch screen. A
   * result that passed names the page the command went to in `page`, read in the same call that checked or read
   * the element, and after `load` for a `goto`. Before a command goes past its start, every navigation already
   * told has its `title` settled. A navigation the command's input or `goto` started carries `commandToken` back.
   * An `observe` answers with `changes`, how many times the document has changed as the page counts it; one with
   * `after` first waits for the count to pass `after.changes`, or for `after.waitMs`, and says how long in `waitedMs`.
   */
  execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult>
  screenshot(timeoutMs: number): Promise<Uint8Array>
  /**
   * Reads the context's cookies, and `localStorage` for each origin the page visited, within `timeoutMs`. What
   * it returns holds session cookies: it goes to the run folder's `states` and nowhere else.
   */
  captureState(timeoutMs: number): Promise<StorageState>
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
  /** Disposes the page's browser context. */
  dispose(timeoutMs: number): Promise<void>
}

/** Thrown when a browser cannot be launched. The message names the problem. */
export class LaunchError extends Error {
  override readonly name = 'LaunchError'
  readonly failure: Failure

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.failure = { class: 'setup_failed', message }
  }
}
