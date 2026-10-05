import type { BidiClient } from './bidi-client.ts'
import type { NewPageOptions, WebRuntime, WebRuntimeIdentity, WebSession } from '../contract.ts'
import type { SessionFacts } from './launch.ts'
import type { FirefoxProcess } from './process.ts'
import type { FirefoxRoute } from './route.ts'
import type { Emulation } from '../../protocol/emulation.ts'
import type { Failure } from '../../protocol/failures.ts'
import { Deadline } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { s } from '../../protocol/schema.ts'
import { describeExit } from '../../shared/process-exit.ts'
import { BrowserError } from '../browser-error.ts'
import { Listeners } from '../listeners.ts'
import { BidiClosedError, BidiDisconnectedError, BidiProtocolError, BidiTimeoutError } from './bidi-errors.ts'
import { FirefoxPage } from './page.ts'
import { callInSandbox } from './sandbox.ts'
import { restoreFirefoxState } from './storage.ts'
import { inWindowOrder } from './window-order.ts'

/** What the runtime reads and asks of the process it drives; a launch hands it the `FirefoxProcess` it started. */
export type FirefoxProcessHandle = Pick<FirefoxProcess, 'pid' | 'route' | 'outputSettled' | 'gone' | 'exited' | 'recordDescendants' | 'expectExit' | 'stop'> & Partial<Pick<FirefoxProcess, 'crash'>>

export type FirefoxBrowserOptions = {
  process: FirefoxProcessHandle
  client: BidiClient
  executablePath: string
  facts: SessionFacts
  /** Receives errors thrown by listeners, which must not reach the connection or the process. */
  onListenerError: (error: unknown) => void
}

const userContextSchema = s.object({ userContext: s.string() })
const contextSchema = s.object({ context: s.string() })
const treeSchema = s.object({ contexts: s.array(s.object({ context: s.string() })) })

/** How long `close` waits for Firefox to answer `browser.close` before it ends the process group itself. */
const closeAnswerMs = 1000

/**
 * A Firefox this run launched and owns: a web runtime over its one WebDriver BiDi session. Each page opens in a user
 * context of its own, with its own cookies, storage and cache. The product is Firefox and the version and build are
 * the ones `session.new` reported.
 */
export class FirefoxBrowser implements WebRuntime {
  readonly product = 'Firefox'
  readonly version: string
  /** The build the version comes from, as `session.new` reported it in `moz:buildID`, when it did. */
  readonly buildId: string | undefined
  readonly userAgent: string
  readonly pid: number
  readonly executablePath: string
  readonly route: FirefoxRoute
  readonly outputSettled: Promise<void>
  readonly gone: Promise<void>
  readonly #process: FirefoxProcessHandle
  readonly #client: BidiClient
  readonly #onListenerError: (error: unknown) => void
  readonly #disconnects: Listeners<string>
  #disconnectReason: string | undefined
  #closeRequested = false
  #closing: Promise<void> | undefined

  /**
   * Reads what the session did not say of the browser, its user agent, from the tab it opened with, and returns the
   * runtime.
   *
   * @example const browser = await FirefoxBrowser.open({ process, client, executablePath, facts, onListenerError }, deadline)
   */
  static async open(options: FirefoxBrowserOptions, deadline: Deadline): Promise<FirefoxBrowser> {
    const userAgent = options.facts.userAgent ?? (await readUserAgent(options.client, deadline))
    return new FirefoxBrowser(options, userAgent)
  }

  private constructor(options: FirefoxBrowserOptions, userAgent: string) {
    this.version = options.facts.browserVersion
    this.buildId = options.facts.buildId
    this.userAgent = userAgent
    this.pid = options.process.pid
    this.executablePath = options.executablePath
    this.route = options.process.route
    this.outputSettled = options.process.outputSettled
    this.gone = options.process.gone()
    this.#process = options.process
    this.#client = options.client
    this.#onListenerError = options.onListenerError
    this.#disconnects = new Listeners(options.onListenerError)
    // The connection's end is the sign the browser went, so a process Retest cannot hear exit is looked for at once.
    this.#client.onDisconnect((reason) => {
      this.#process.expectExit()
      this.#disconnected(reason)
    })
    void this.#process.exited.then((exit) => {
      this.#disconnected(`the browser process ended${exit === undefined ? '' : ` with ${describeExit(exit)}`}`)
      this.#client.close()
    })
  }

  get connected(): boolean {
    return this.#disconnectReason === undefined
  }

  get identity(): WebRuntimeIdentity {
    return { kind: 'web', engine: 'firefox', product: this.product, version: this.version, executablePath: this.executablePath, processIds: [this.pid] }
  }

  /** The test gate loses a launched browser through its recorded ownership, never by an unchecked numeric pid. */
  crash(): void {
    if (this.#process.crash === undefined) throw new BrowserError({ class: 'unsupported', message: 'This Firefox handle offers no verified process ownership for a deliberate crash.' })
    this.#process.crash()
  }

  /**
   * Opens a tab in a new user context within `timeoutMs`. The context starts with no cookies or storage beyond a saved
   * state restored into it. A viewport and pixel ratio are applied through BiDi. A proxy, touch screen, mobile
   * layout or user agent is refused by name.
   */
  async newPage(options: NewPageOptions, timeoutMs: number): Promise<WebSession> {
    if (this.#disconnectReason !== undefined) throw this.#lost(this.#disconnectReason)
    const refusal = refusedOptions(options)
    if (refusal !== undefined) throw new BrowserError(refusal)
    const deadline = new Deadline(timeoutMs)
    const send = () => ({ timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal })
    let userContext: string | undefined
    try {
      userContext = (await this.#client.request('browser.createUserContext', {}, userContextSchema, send())).userContext
      const restoredOrigins = options.storageState === undefined ? [] : await restoreFirefoxState(this.#client, userContext, options.storageState, deadline)
      const context = await openWindow(this.#client, userContext, deadline)
      const pageOptions = { client: this.#client, context, userContext, baseUrl: options.baseUrl, emulation: options.emulation, restoredOrigins, onListenerError: this.#onListenerError }
      return await FirefoxPage.open(pageOptions, deadline)
    } catch (error) {
      if (userContext !== undefined) {
        // The page's budget may be spent by now; the removal still gets a turn of its own among the browser's windows.
        const removing = new Deadline(Math.max(cleanupTurnMs, deadline.remainingMs))
        await inWindowOrder(this.#client, removing, () => this.#client.send('browser.removeUserContext', { userContext }, { timeoutMs: removing.commandTimeoutMs })).catch(() => {
          // The user context goes with the browser when it closes, and the error that matters is the one below.
        })
      }
      throw this.#setupError(error)
    }
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    const reason = this.#disconnectReason
    if (reason === undefined) return this.#disconnects.add(listener)
    const late = new Listeners<string>(this.#onListenerError)
    const remove = late.add(listener)
    queueMicrotask(() => late.emit(reason))
    return remove
  }

  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  // Firefox is asked to close, which ends its one session and lets its processes go, and its process group is ended
  // if it has not gone within the grace. Its folder, profile and all, is removed once nothing of it is left.
  async #close(timeoutMs: number): Promise<void> {
    this.#closeRequested = true
    const deadline = new Deadline(timeoutMs)
    await this.#process.recordDescendants(deadline)
    if (this.connected) {
      await this.#client.send('browser.close', {}, { timeoutMs: Math.max(1, Math.min(closeAnswerMs, deadline.remainingMs)) }).catch(() => {
        // Firefox often closes the connection instead of answering, and `stop` ends the process group either way.
      })
    }
    const problems = await this.#process.stop(Math.min(deadline.remainingMs, closeAnswerMs), deadline)
    this.#client.close()
    if (problems.length > 0) throw new BrowserError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  #setupError(error: unknown): BrowserError {
    if (error instanceof BrowserError) return error
    if (error instanceof BidiDisconnectedError || error instanceof BidiClosedError) return this.#lost(this.#disconnectReason ?? error.reason, error)
    return new BrowserError({ class: 'setup_failed', message: `Could not open a page: ${errorMessage(error)}` }, { cause: error })
  }

  #lost(reason: string, cause?: unknown): BrowserError {
    return new BrowserError({ class: 'session_lost', message: `Could not open a page, because the browser is gone: ${reason}.` }, { cause })
  }

  #disconnected(reason: string): void {
    if (this.#disconnectReason !== undefined) return
    this.#disconnectReason = this.#closeRequested ? 'Retest closed the browser' : reason
    this.#disconnects.emit(this.#disconnectReason)
  }
}

/**
 * Why a page cannot open with these options on Firefox, or undefined when it can: a proxy, or an emulation beyond a
 * viewport and pixel ratio.
 *
 * @example refusedOptions({ proxy: { server: 'http://127.0.0.1:8080', bypass: [] } })?.class // 'unsupported'
 */
export function refusedOptions(options: NewPageOptions): Failure | undefined {
  if (options.proxy !== undefined) {
    return { class: 'unsupported', message: 'Firefox cannot send one page\'s requests through a proxy here: the Firefox release Retest drives ignores the proxy of a user context. Leave out proxy for a Firefox target.' }
  }
  const unsupported = options.emulation === undefined ? [] : emulationParts(options.emulation)
  if (unsupported.length === 0) return undefined
  return { class: 'unsupported', message: `Firefox cannot emulate ${unsupported.join(', ')} through WebDriver BiDi in the release Retest drives. A Firefox target takes a viewport, and no device.` }
}

// How long removing the user context of a page that failed to open may wait for the browser's other windows.
const cleanupTurnMs = 1000

/**
 * Opens the window a page lives in, in its user context, once, within the deadline. Firefox has answered this with
 * `unknown error` once in a conformance run, a window that may or may not exist: it is never asked again, since a second
 * request could open a second window, and whatever the first left goes with the user context the caller removes. The
 * failure names the window and keeps Firefox's own words, which name no page content.
 *
 * @example const context = await openWindow(client, userContext, deadline)
 */
export async function openWindow(client: BidiClient, userContext: string, deadline: Deadline): Promise<string> {
  try {
    const { context } = await inWindowOrder(client, deadline, () => client.request('browsingContext.create', { type: 'window', userContext }, contextSchema, { timeoutMs: deadline.commandTimeoutMs, signal: deadline.signal, keepErrorMessage: true }))
    return context
  } catch (error) {
    if (error instanceof BidiProtocolError) {
      const words = error.protocolMessage === undefined || error.protocolMessage === '' ? error.error : `${error.error}: ${error.protocolMessage}`
      throw new BrowserError({ class: 'setup_failed', message: `Firefox could not open a window for the page, and answered ${JSON.stringify(words)}. Retest did not ask again, so no second window was opened.` }, { cause: error })
    }
    if (error instanceof BidiTimeoutError) {
      throw new BrowserError({ class: 'setup_failed', message: `Firefox did not open a window for the page within the page's command budget. Retest did not ask again, so no second window was opened.` }, { cause: error })
    }
    throw error
  }
}

function emulationParts(emulation: Emulation): string[] {
  return [
    ...(emulation.touch ? ['a touch screen'] : []),
    ...(emulation.isMobile ? ['a mobile layout'] : []),
    ...(emulation.userAgent === undefined ? [] : ['another user agent']),
  ]
}

async function readUserAgent(client: BidiClient, deadline: Deadline): Promise<string> {
  const { contexts } = await client.request('browsingContext.getTree', { maxDepth: 0 }, treeSchema, { timeoutMs: deadline.commandTimeoutMs })
  const first = contexts[0]?.context
  if (first === undefined) throw new BrowserError({ class: 'setup_failed', message: 'Firefox opened with no tab to read its user agent from.' })
  return callInSandbox(client, first, '() => navigator.userAgent', [], s.string(), deadline)
}
