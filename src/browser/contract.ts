import type { CommandResult, PageCommand } from '../protocol/commands.ts'
import type { Emulation } from '../protocol/emulation.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { StorageState } from '../protocol/storage-state.ts'

export type { Emulation } from '../protocol/emulation.ts'

export type LaunchOptions = { executablePath: string; logFile: string; headless: boolean }

/**
 * How to open a page. Relative `goto` URLs resolve against `baseUrl`. `emulation` applies before the page loads
 * anything; without its `userAgent` the page keeps the browser's own. `storageState` is restored before the
 * test's first command: its cookies in the new context, and each origin's `localStorage` before that origin's
 * own scripts run.
 */
export type NewPageOptions = { baseUrl?: string; emulation?: Emulation; storageState?: StorageState }

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

/** A page command as the page runs it: every `fill` carries the text to type. */
export type BrowserCommand = Exclude<PageCommand, { kind: 'fill' }> | ResolvedFill

/**
 * How long `close` waits for a browser it had to kill. A killed process takes a moment to go, so this is the
 * one wait no budget sets: it stands however small the budget is.
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
   * Closes the browser within `timeoutMs`. Whatever is left of its process group then is killed, and `close`
   * waits up to `closeGraceMs` more for it to go. Resolves once the group is gone and the profile is removed.
   * A second call waits for the first.
   */
  close(timeoutMs: number): Promise<void>
}

export interface OwnedPage {
  /**
   * Runs a command within `timeoutMs`. Never throws for a page or application problem; the result carries the
   * failure instead. Aborting `signal` stops the command: input not yet sent is never sent, and input already
   * sent is not taken back. The failure then takes its class from `signal.reason`, a `Failure` (anything else
   * counts as a timeout), and says whether input was sent. `tap` needs a page that emulates a touch screen.
   */
  execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult>
  screenshot(timeoutMs: number): Promise<Uint8Array>
  /**
   * Reads the context's cookies, and `localStorage` for each origin the page visited, within `timeoutMs`. What
   * it returns holds session cookies: it goes to the run folder's `states` and nowhere else.
   */
  captureState(timeoutMs: number): Promise<StorageState>
  /** Main frame navigations. `url` is the origin and path. Returns a function that removes the listener. */
  onNavigation(listener: (url: string) => void): () => void
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
