import type { CdpConnection } from './cdp/connection.ts'
import type { ChromiumProcess } from './chromium-process.ts'
import type { NewPageOptions, OwnedBrowser, OwnedPage, ProxyOptions } from './contract.ts'
import type { Schema } from '../protocol/schema.ts'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { s } from '../protocol/schema.ts'
import { describeExit } from '../shared/process-exit.ts'
import { BrowserError } from './browser-error.ts'
import { CdpClosedError, CdpDisconnectedError } from './cdp/errors.ts'
import { request, sendOptions } from './cdp-results.ts'
import { Listeners } from './listeners.ts'
import { ChromiumPage } from './page.ts'
import { restoreState } from './storage-state.ts'

/** What `Browser.getVersion` said, split into a product name and its version. */
export type BrowserVersion = { product: string; version: string; userAgent: string }

export type BrowserOptions = {
  process: ChromiumProcess
  executablePath: string
  connection: CdpConnection
  version: BrowserVersion
  /** Receives errors thrown by listeners, which must not reach the connection or the process. */
  onListenerError: (error: unknown) => void
}

const contextSchema = s.object({ browserContextId: s.string() })
const targetSchema = s.object({ targetId: s.string() })

/** A Chromium browser this run launched and owns. */
export class ChromiumBrowser implements OwnedBrowser {
  readonly product: string
  readonly version: string
  readonly userAgent: string
  readonly pid: number
  readonly executablePath: string
  readonly #process: ChromiumProcess
  readonly #connection: CdpConnection
  readonly #onListenerError: (error: unknown) => void
  readonly #disconnects: Listeners<string>
  #disconnectReason: string | undefined
  #closeRequested = false
  #closing: Promise<void> | undefined

  constructor(options: BrowserOptions) {
    this.product = options.version.product
    this.version = options.version.version
    this.userAgent = options.version.userAgent
    this.pid = options.process.pid
    this.executablePath = options.executablePath
    this.#process = options.process
    this.#connection = options.connection
    this.#onListenerError = options.onListenerError
    this.#disconnects = new Listeners(options.onListenerError)
    this.#connection.onDisconnect((reason) => this.#disconnected(reason))
    if (this.#connection.closeReason !== undefined) this.#disconnected(this.#connection.closeReason)
    void this.#process.exited.then((exit) => {
      this.#disconnected(`the browser process ended with ${describeExit(exit)}`)
      this.#connection.close()
    })
  }

  get connected(): boolean {
    return this.#disconnectReason === undefined
  }

  async newPage(options: NewPageOptions, timeoutMs: number): Promise<OwnedPage> {
    if (this.#disconnectReason !== undefined) throw this.#lost(this.#disconnectReason)
    const deadline = new Deadline(timeoutMs)
    const { browserContextId } = await this.#request('Target.createBrowserContext', browserContextOptions(options.proxy), contextSchema, deadline)
    try {
      // A download would otherwise land in the person's own Downloads folder, whatever the profile.
      await this.#request('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId }, s.object({}), deadline)
      const { storageState } = options
      const context = { connection: this.#connection, browserContextId }
      const restoredOrigins = storageState === undefined ? [] : await restoreState(context, storageState, deadline)
      const target = await this.#request('Target.createTarget', { url: 'about:blank', browserContextId }, targetSchema, deadline)
      const session = await this.#connection.attach(target.targetId, sendOptions(deadline))
      const pageOptions = {
        connection: this.#connection,
        session,
        browserContextId,
        baseUrl: options.baseUrl,
        emulation: options.emulation,
        restoredOrigins,
        proxyServer: options.proxy?.server,
        onListenerError: this.#onListenerError,
      }
      return await ChromiumPage.open(pageOptions, deadline)
    } catch (error) {
      await this.#connection.send('Target.disposeBrowserContext', { browserContextId }, sendOptions(deadline)).catch(() => {
        // The context goes with the browser when it closes, and the error that matters is the one below.
      })
      throw this.#setupError(error)
    }
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    const reason = this.#disconnectReason
    if (reason === undefined) return this.#disconnects.add(listener)
    // A listener that arrives after the disconnect still hears about it, once.
    const late = new Listeners<string>(this.#onListenerError)
    const remove = late.add(listener)
    queueMicrotask(() => late.emit(reason))
    return remove
  }

  close(timeoutMs: number): Promise<void> {
    this.#closing ??= this.#close(timeoutMs)
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<void> {
    this.#closeRequested = true
    const deadline = new Deadline(timeoutMs)
    if (this.connected) {
      await this.#connection.send('Browser.close', undefined, sendOptions(deadline)).catch(() => {
        // Chrome often closes the pipe instead of answering, and `stop` ends the process group either way.
      })
    }
    const problems = await this.#process.stop(deadline.remainingMs)
    this.#connection.close()
    if (problems.length > 0) throw new BrowserError({ class: 'cleanup_failed', message: problems.join(' ') })
  }

  async #request<T>(method: string, params: object, schema: Schema<T>, deadline: Deadline): Promise<T> {
    try {
      return await request(this.#connection, method, params, schema, sendOptions(deadline))
    } catch (error) {
      throw this.#setupError(error)
    }
  }

  #setupError(error: unknown): BrowserError {
    if (error instanceof BrowserError) return error
    if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) {
      return this.#lost(this.#disconnectReason ?? error.reason, error)
    }
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
 * The parameters of `Target.createBrowserContext` for a page. A proxy is a setting of the browser context, so
 * each page's requests, its frames' and its service workers' included, go through its own. Chrome sends
 * loopback addresses around a proxy unless the bypass rules hold `<-loopback>`.
 *
 * @example browserContextOptions({ server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal'] }) // { proxyServer: 'http://127.0.0.1:8080', proxyBypassList: '<-loopback>;*.internal' }
 */
export function browserContextOptions(proxy: ProxyOptions | undefined): { proxyServer?: string; proxyBypassList?: string } {
  if (proxy === undefined) return {}
  const bypass = proxy.bypass.length === 0 ? {} : { proxyBypassList: proxy.bypass.join(';') }
  return { proxyServer: proxy.server, ...bypass }
}
