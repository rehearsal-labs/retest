import type { PipeStreams, Transport } from '../cdp/transport.ts'
import type { NewPageOptions, OutputRedactor, WebRuntime, WebRuntimeIdentity, WebSession } from '../contract.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import type { WebKitBuild } from './build.ts'
import type { WebKitPageSetup } from './page.ts'
import type { SidePage } from './storage.ts'
import { tmpdir } from 'node:os'
import { Deadline as Budget } from '../../protocol/deadline.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { s } from '../../protocol/schema.ts'
import { describeExit } from '../../shared/process-exit.ts'
import { BrowserError } from '../browser-error.ts'
import { CdpClosedError, CdpDisconnectedError, CdpTimeoutError } from '../cdp/errors.ts'
import { PipeTransport } from '../cdp/transport.ts'
import { readProtocol } from '../cdp-results.ts'
import { ProcessLaunchError } from '../chromium-process.ts'
import { closeGraceMs, LaunchError } from '../contract.ts'
import { launchOutput, logLength, logWriter } from '../launch.ts'
import { Listeners } from '../listeners.ts'
import { describeBuildVersion, findWebKitBuild } from './build.ts'
import { WebKitConnection } from './connection.ts'
import { WebKitPage } from './page.ts'
import { WebKitProcess } from './process.ts'
import { defaultScreen, webKitScreen } from './screen.ts'
import { restoreCookies, restoreOrigins } from './storage.ts'
import { sweepWebKitHomes } from './sweep.ts'

/**
 * How to launch a WebKit build: the path a target or `RETEST_WEBKIT_BUILD` gives, and what named it, the log, whether to
 * show a window, and the redaction the run's other browsers get. The build's environment is set in full, so no
 * variable of Retest's own, and no judge's credential, reaches it.
 */
export type WebKitLaunchOptions = {
  buildPath: string
  buildSource: string
  logFile: string
  headless: boolean
  redact?: (text: string) => string
  redactStream?: () => OutputRedactor
}

const launchTimeoutMs = 30_000
// The setup of a page the browser opened on its own.
const popupSetup: WebKitPageSetup = { baseUrl: undefined, screen: defaultScreen, restoredOrigins: [] }
const pageProxySchema = s.object({ pageProxyId: s.string() })
const contextSchema = s.object({ browserContextId: s.string() })
const proxyCreatedSchema = s.object({ pageProxyId: s.string(), browserContextId: s.string() })
const proxyDestroyedSchema = s.object({ pageProxyId: s.string() })
const loadFailedSchema = s.object({ pageProxyId: s.string(), loaderId: s.string(), error: s.string() })
const userAgentSchema = s.object({ result: s.object({ value: s.string() }) })

/**
 * Starts a WebKit build this run owns: its main process leads a process group of its own, with a temporary home, the
 * inspector pipe, and its helpers recorded as launchd starts them. WebKit homes earlier Retest processes left are swept
 * first, by their own records. The user agent is read once from a page of a context made for that and thrown away.
 * Every failure is a `LaunchError` that names the problem.
 *
 * @example const browser = await launchWebKit({ buildPath: '/cache/webkit-2359', buildSource: 'RETEST_WEBKIT_BUILD', logFile: 'logs/webkit.log', headless: true })
 */
export async function launchWebKit(
  options: WebKitLaunchOptions,
  timeoutMs: number = launchTimeoutMs,
  transport: (pipe: PipeStreams) => Transport = (pipe) => new PipeTransport(pipe),
): Promise<WebKitBrowser> {
  const deadline = new Budget(timeoutMs)
  const build = await findWebKitBuild(options.buildPath, options.buildSource)
  const swept = await sweepWebKitHomes(tmpdir())
  const outputStart = await logLength(options.logFile)
  const redacting = options.redact === undefined ? {} : { redact: options.redact }
  const streaming = options.redactStream === undefined ? {} : { redactStream: options.redactStream }
  const process = await WebKitProcess.start({ build, logFile: options.logFile, headless: options.headless, ...redacting, ...streaming })
  const write = logWriter(options.logFile)
  const log = options.redact === undefined ? write : (line: string) => write(options.redact?.(line) ?? line)
  for (const note of swept) log(note)
  let connection: WebKitConnection | undefined
  try {
    connection = new WebKitConnection(transport(process.pipe), { timeoutMs, onDiagnostic: log })
    await connection.send('Playwright.enable', undefined, { timeoutMs: deadline.commandTimeoutMs })
    const browser = new WebKitBrowser({ process, connection, build, onListenerError: (error) => log(`a listener failed: ${errorMessage(error)}`), log })
    await browser.readUserAgent(deadline)
    return browser
  } catch (error) {
    const ended = error instanceof CdpDisconnectedError || error instanceof CdpClosedError
    const exit = ended ? await process.waitForExit(Math.min(deadline.remainingMs, closeGraceMs)) : undefined
    const problems: string[] = []
    try { connection?.close() } catch (closeError) { problems.push(`Could not close the browser's inspector pipe: ${errorMessage(closeError)}`) }
    problems.push(...(await process.stop(0)))
    const output = await launchOutput(options.logFile, outputStart)
    const advice = `Its output is in ${options.logFile}.${output.trim() === '' ? '' : ` Its last words: ${lastLine(output)}`}`
    const message = error instanceof CdpTimeoutError
      ? `${build.executable} did not answer as a WebKit build within ${timeoutMs} ms. ${advice}`
      : exit !== undefined
        ? `${build.executable} exited with ${describeExit(exit)} before it answered as a WebKit build. ${advice}`
        : ended
          ? `${build.executable} closed its inspector pipe before it answered as a WebKit build. ${advice}`
          : `${build.executable} answered, but not as the WebKit build Retest drives: ${errorMessage(error)}. ${advice}`
    const cleanup = problems.length === 0 ? '' : ` Cleaning up also failed: ${problems.join(' ')}`
    throw new ProcessLaunchError(`${message}${cleanup}`, process.gone(), { cause: error, failureClass: problems.length > 0 ? 'cleanup_failed' : 'setup_failed' }, process.outputSettled)
  }
}

type BrowserParts = { process: WebKitProcess; connection: WebKitConnection; build: WebKitBuild; onListenerError: (error: unknown) => void; log: (line: string) => void }

/** A WebKit build this run launched and owns: a web runtime whose every session opens in a context of its own. */
export class WebKitBrowser implements WebRuntime {
  readonly product: string = 'WebKit'
  readonly version: string
  readonly pid: number
  readonly executablePath: string
  readonly build: WebKitBuild
  readonly outputSettled: Promise<void>
  readonly gone: Promise<void>
  readonly #process: WebKitProcess
  readonly #connection: WebKitConnection
  readonly #onListenerError: (error: unknown) => void
  readonly #log: (line: string) => void
  readonly #disconnects: Listeners<string>
  readonly #pages = new Map<string, WebKitPage>()
  // How many `Playwright.createPage` of each context are on their way.
  readonly #creating = new Map<string, number>()
  // Each page announced while a `Playwright.createPage` of its context was on its way, until the answer names it: the
  // function that hands it its setup, and so lets its first target run.
  readonly #unclaimed = new Map<string, { readonly browserContextId: string; readonly apply: (setup: WebKitPageSetup) => void }>()
  readonly #cleanupProblems: string[] = []
  #userAgent = ''
  #disconnectReason: string | undefined
  #closeRequested = false
  #closing: Promise<void> | undefined

  constructor(parts: BrowserParts) {
    this.#process = parts.process
    this.#connection = parts.connection
    this.build = parts.build
    this.version = describeBuildVersion(parts.build)
    this.pid = parts.process.pid
    this.executablePath = parts.build.executable
    this.outputSettled = parts.process.outputSettled
    this.gone = parts.process.gone()
    this.#onListenerError = parts.onListenerError
    this.#log = parts.log
    this.#disconnects = new Listeners(parts.onListenerError)
    this.#connection.onBrowserEvent('Playwright.pageProxyCreated', (params) => this.#pageCreated(params))
    this.#connection.onBrowserEvent('Playwright.pageProxyDestroyed', (params) => {
      const { pageProxyId } = readProtocol(proxyDestroyedSchema, params, { method: 'Playwright.pageProxyDestroyed' })
      this.#pages.get(pageProxyId)?.markClosed('the page was closed')
      this.#pages.delete(pageProxyId)
      this.#unclaimed.delete(pageProxyId)
    })
    this.#connection.onBrowserEvent('Playwright.provisionalLoadFailed', (params) => {
      const { pageProxyId, loaderId, error } = readProtocol(loadFailedSchema, params, { method: 'Playwright.provisionalLoadFailed' })
      this.#pages.get(pageProxyId)?.provisionalLoadFailed(loaderId, error)
    })
    this.#connection.onDisconnect((reason) => this.#disconnected(reason))
    void this.#process.exited.then((exit) => {
      try { this.#disconnected(`the browser process ended with ${describeExit(exit)}`) }
      catch (error) { this.#cleanupProblems.push(`Could not report the browser's process exit: ${errorMessage(error)}`) }
      try { this.#connection.close() }
      catch (error) { this.#cleanupProblems.push(`Could not close the browser's inspector pipe: ${errorMessage(error)}`) }
    })
  }

  get userAgent(): string {
    return this.#userAgent
  }

  get connected(): boolean {
    return this.#disconnectReason === undefined
  }

  get identity(): WebRuntimeIdentity {
    return { kind: 'web', engine: 'webkit', product: this.product, version: this.version, executablePath: this.executablePath, processIds: this.#process.processIds }
  }

  /** The helpers recorded so far, by pid and label: WebKit's web content, networking and GPU processes. */
  get helpers(): readonly { pid: number; label: string }[] {
    return this.#process.helpers.map(({ pid, label }) => ({ pid, label }))
  }

  /** The browser's process, for a test that checks what it owns. */
  get process(): WebKitProcess {
    return this.#process
  }

  /** Reads the build's user agent from a page of a context made for that alone, and throws the context away. */
  async readUserAgent(deadline: Deadline): Promise<void> {
    const browserContextId = await this.#createContext(deadline)
    try {
      const page = await this.#openPage(browserContextId, { baseUrl: undefined, screen: defaultScreen, restoredOrigins: [] }, deadline)
      const targetId = page.bridge.targetId
      if (targetId === undefined) throw new LaunchError('The WebKit build opened a page with no document.')
      const answer = await page.bridge.target(targetId, 'Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true }, { timeoutMs: deadline.commandTimeoutMs })
      this.#userAgent = readProtocol(userAgentSchema, answer, { method: 'Runtime.evaluate' }).result.value
    } finally {
      await this.#connection.send('Playwright.deleteContext', { browserContextId }, { timeoutMs: deadline.commandTimeoutMs }).catch(() => undefined)
    }
  }

  async newPage(options: NewPageOptions, timeoutMs: number): Promise<WebSession> {
    if (this.#disconnectReason !== undefined) throw this.#lost(this.#disconnectReason)
    if (options.proxy !== undefined) {
      throw new BrowserError({ class: 'unsupported', message: "Retest's WebKit driver sends no page through a proxy. Remove the proxy from this WebKit target." })
    }
    const screen = webKitScreen(options.emulation)
    if (!screen.ok) throw new BrowserError(screen.failure)
    const deadline = new Budget(timeoutMs)
    let browserContextId: string | undefined
    try {
      browserContextId = await this.#createContext(deadline)
      const context = browserContextId
      const state = options.storageState
      let restoredOrigins: string[] = []
      if (state !== undefined) {
        await restoreCookies(this.#connection, context, state.cookies, deadline)
        restoredOrigins = await restoreOrigins(this.#sidePages(context), state.origins, deadline)
      }
      const page = await this.#openPage(context, { baseUrl: options.baseUrl, screen: screen.screen, restoredOrigins }, deadline)
      await this.#recordHelpers()
      return page
    } catch (error) {
      if (browserContextId !== undefined) {
        await this.#connection.send('Playwright.deleteContext', { browserContextId }, { timeoutMs: deadline.commandTimeoutMs }).catch(() => {
          // The context goes with the browser when it closes, and the error that matters is the one below.
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

  // The helpers are recorded while the browser still runs, since launchd answers only for a running process. The
  // close is asked for, and the browser given a moment to end its helpers itself, which it does within a fraction of a
  // second; whatever of it is left then is killed by its record.
  async #close(timeoutMs: number): Promise<void> {
    this.#closeRequested = true
    const problems = await this.#process.recordHelpers()
    if (this.connected) {
      this.#connection.send('Playwright.close', undefined, { timeoutMs: Math.max(1, Math.min(timeoutMs, closeGraceMs)) }).catch(() => {
        // The browser often closes its pipe instead of answering, and the stop below ends it either way.
      })
    }
    problems.push(...(await this.#process.stop(Math.min(timeoutMs, closeGraceMs))))
    try { this.#connection.close() }
    catch (error) { problems.push(`Could not close the browser's inspector pipe: ${errorMessage(error)}`) }
    problems.push(...this.#cleanupProblems)
    if (problems.length > 0) throw new BrowserError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  async #createContext(deadline: Deadline): Promise<string> {
    const { browserContextId } = readProtocol(contextSchema, await this.#connection.send('Playwright.createContext', {}, { timeoutMs: deadline.commandTimeoutMs }), { method: 'Playwright.createContext' })
    // A download would otherwise land in a folder of the build's choosing.
    await this.#connection.send('Playwright.setDownloadBehavior', { behavior: 'deny', browserContextId }, { timeoutMs: deadline.commandTimeoutMs })
    return browserContextId
  }

  // A page is announced before `Playwright.createPage` answers, and so are the pages a page of the same context opens on
  // its own meanwhile, as a popup: each announced page waits, its first target paused, until an answer names it and
  // hands it its own setup. Once no `createPage` of the context is on its way, a page no answer named is a popup.
  async #openPage(browserContextId: string, setup: WebKitPageSetup, deadline: Deadline): Promise<WebKitPage> {
    this.#creating.set(browserContextId, (this.#creating.get(browserContextId) ?? 0) + 1)
    let pageProxyId: string
    try {
      const answer = await this.#connection.send('Playwright.createPage', { browserContextId }, { timeoutMs: deadline.commandTimeoutMs })
      pageProxyId = readProtocol(pageProxySchema, answer, { method: 'Playwright.createPage' }).pageProxyId
      const waiting = this.#unclaimed.get(pageProxyId)
      if (waiting !== undefined) {
        this.#unclaimed.delete(pageProxyId)
        waiting.apply(setup)
      }
    } finally {
      const creating = (this.#creating.get(browserContextId) ?? 1) - 1
      if (creating > 0) this.#creating.set(browserContextId, creating)
      else this.#releasePopups(browserContextId)
    }
    const page = this.#pages.get(pageProxyId)
    if (page === undefined) throw new BrowserError({ class: 'setup_failed', message: `The WebKit build created page proxy ${pageProxyId} without announcing it.` })
    await within(page.ready, deadline, 'the page to start its first document')
    return page
  }

  // Every page of the context that no answer named is one the browser opened on its own, and runs with the default screen.
  #releasePopups(browserContextId: string): void {
    this.#creating.delete(browserContextId)
    for (const [pageProxyId, waiting] of [...this.#unclaimed]) {
      if (waiting.browserContextId !== browserContextId) continue
      this.#unclaimed.delete(pageProxyId)
      waiting.apply(popupSetup)
    }
  }

  #sidePages(browserContextId: string): (deadline: Deadline) => Promise<SidePage> {
    return async (deadline) => {
      const page = await this.#openPage(browserContextId, { baseUrl: undefined, screen: defaultScreen, restoredOrigins: [], serveEmptyDocuments: true }, deadline)
      return {
        world: page.world,
        open: async (url, openDeadline) => {
          const opened = await page.execute({ kind: 'goto', url }, openDeadline.commandTimeoutMs)
          if (!opened.ok) throw new BrowserError({ class: 'setup_failed', message: `Could not open an empty document of ${new URL(url).origin}: ${opened.failure.message}` })
        },
        close: (closeTimeoutMs) => page.closePage(closeTimeoutMs),
      }
    }
  }

  #pageCreated(params: unknown): void {
    const { pageProxyId, browserContextId } = readProtocol(proxyCreatedSchema, params, { method: 'Playwright.pageProxyCreated' })
    // A page the browser opened on its own, as a popup, is set up and let run, and never handed to a test.
    const setup = Promise.withResolvers<WebKitPageSetup>()
    if ((this.#creating.get(browserContextId) ?? 0) > 0) this.#unclaimed.set(pageProxyId, { browserContextId, apply: setup.resolve })
    else setup.resolve(popupSetup)
    const page = new WebKitPage({
      connection: this.#connection,
      pageProxyId,
      browserContextId,
      setup: setup.promise,
      openSidePage: this.#sidePages(browserContextId),
      onListenerError: this.#onListenerError,
    })
    this.#pages.set(pageProxyId, page)
  }

  async #recordHelpers(): Promise<void> {
    for (const problem of await this.#process.recordHelpers()) this.#log(problem)
  }

  #setupError(error: unknown): BrowserError {
    if (error instanceof BrowserError) return error
    if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return this.#lost(this.#disconnectReason ?? error.reason, error)
    return new BrowserError({ class: 'setup_failed', message: `Could not open a page: ${errorMessage(error)}` }, { cause: error })
  }

  #lost(reason: string, cause?: unknown): BrowserError {
    return new BrowserError({ class: 'session_lost', message: `Could not open a page, because the browser is gone: ${reason}.` }, { cause })
  }

  #disconnected(reason: string): void {
    if (this.#disconnectReason !== undefined) return
    this.#disconnectReason = this.#closeRequested ? 'Retest closed the browser' : reason
    for (const page of this.#pages.values()) page.markClosed(`the browser connection ended: ${this.#disconnectReason}`)
    this.#disconnects.emit(this.#disconnectReason)
  }
}

async function within<T>(work: Promise<T>, deadline: Deadline, waitingFor: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new BrowserError({ class: 'setup_failed', message: `Waited ${deadline.budgetMs} ms for ${waitingFor}.` })), deadline.commandTimeoutMs)
  })
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
  }
}

function lastLine(output: string): string {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '')
  return lines.at(-1) ?? ''
}
