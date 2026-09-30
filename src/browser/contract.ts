import type { CommandResult, PageCommand } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'

export type LaunchOptions = { executablePath: string; logFile: string; headless: boolean }

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
  newPage(options: { baseUrl?: string }, timeoutMs: number): Promise<OwnedPage>
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
   * counts as a timeout), and says whether input was sent.
   */
  execute(command: PageCommand, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult>
  screenshot(timeoutMs: number): Promise<Uint8Array>
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
