import type { DownloadEnd, DownloadStart, PageDownload } from '../contract.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import type { WebKitConnection } from './connection.ts'
import { rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { s } from '../../protocol/schema.ts'
import { readProtocol } from '../cdp-results.ts'
import { Listeners } from '../listeners.ts'

// Downloads on WebKit. The build tells of each download on the browser's own connection, by the page proxy that began
// it: `Playwright.downloadCreated` with its address, `Playwright.downloadFilenameSuggested` with the name it suggests,
// and `Playwright.downloadFinished` with an error text that is empty once the file is saved. A context that saves
// downloads saves each in its folder under the download's own id, and the file is there while it arrives. The build
// counts no bytes and gives no total, so the bytes that arrived are read from that file, and the total is never known.

const createdSchema = s.object({ pageProxyId: s.string(), frameId: s.string(), uuid: s.string(), url: s.string() })
const namedSchema = s.object({ uuid: s.string(), suggestedFilename: s.string() })
const finishedSchema = s.object({ uuid: s.string(), error: s.string() })

/** Where a page proxy stands to the test's page of its context: its context, and where a download it began began. */
export type DownloadPlace = { readonly context: string; readonly startedIn: DownloadStart | undefined }

/** A download the browser began in a context that saves downloads, before the name it suggests has come. */
type Begun = { readonly uuid: string; readonly url: string; readonly startedIn: DownloadStart | undefined; readonly home: WebKitPageDownloads }

/**
 * The browser's downloads, each told to the test's page of the context it began in: a download that page or a frame
 * inside it began is its own; one a page it opened, or a page that one opened, began is told as begun in a popup; and
 * one any other page of the context began, as begun in another page.
 */
export class WebKitDownloads {
  readonly #connection: WebKitConnection
  readonly #placeOf: (pageProxyId: string) => DownloadPlace | undefined
  readonly #onListenerError: (error: unknown) => void
  // The downloads of the test's page of each context that saves them, by context.
  readonly #homes = new Map<string, WebKitPageDownloads>()
  // Downloads begun whose name has not come, by id.
  readonly #begun = new Map<string, Begun>()
  // Downloads told to a page, by id, until they end.
  readonly #told = new Map<string, WebKitPageDownloads>()

  constructor(connection: WebKitConnection, placeOf: (pageProxyId: string) => DownloadPlace | undefined, onListenerError: (error: unknown) => void) {
    this.#connection = connection
    this.#placeOf = placeOf
    this.#onListenerError = onListenerError
    connection.onBrowserEvent('Playwright.downloadCreated', (params) => this.#guarded(() => this.#created(params)))
    connection.onBrowserEvent('Playwright.downloadFilenameSuggested', (params) => this.#guarded(() => this.#named(params)))
    connection.onBrowserEvent('Playwright.downloadFinished', (params) => this.#guarded(() => this.#finished(params)))
  }

  /**
   * Has a context save every download in `folder`, each under its own id until Retest names it, and returns the
   * downloads of the context's test page. A context made without a folder refuses downloads, as `createContext` set it.
   *
   * @example const downloads = await browserDownloads.save(browserContextId, '/run/artifacts/k3v9q0x2mb/web-1a2b/downloads', deadline)
   */
  async save(browserContextId: string, folder: string, deadline: Deadline): Promise<WebKitPageDownloads> {
    const cancel = (uuid: string): void => {
      this.#connection.send('Playwright.cancelDownload', { uuid }).catch(() => {
        // A download the browser ended meanwhile, or a browser that is gone, has nothing left to stop.
      })
    }
    const home = new WebKitPageDownloads({ folder: resolve(folder), onListenerError: this.#onListenerError, cancel, closed: () => this.#closed(browserContextId, home) })
    this.#homes.set(browserContextId, home)
    try {
      await this.#connection.send('Playwright.setDownloadBehavior', { behavior: 'allow', downloadPath: home.folder, browserContextId }, { timeoutMs: deadline.commandTimeoutMs })
    } catch (error) {
      home.close()
      throw error
    }
    return home
  }

  #created(params: unknown): void {
    const { pageProxyId, uuid, url } = readProtocol(createdSchema, params, { method: 'Playwright.downloadCreated' })
    const place = this.#placeOf(pageProxyId)
    const home = place === undefined ? undefined : this.#homes.get(place.context)
    if (place === undefined || home === undefined) return
    this.#begun.set(uuid, { uuid, url, startedIn: place.startedIn, home })
  }

  #named(params: unknown): void {
    const { uuid, suggestedFilename } = readProtocol(namedSchema, params, { method: 'Playwright.downloadFilenameSuggested' })
    this.#tell(uuid, suggestedFilename)
  }

  // A download that ends before it was given a name was suggested none.
  #finished(params: unknown): void {
    const { uuid, error } = readProtocol(finishedSchema, params, { method: 'Playwright.downloadFinished' })
    const home = this.#told.get(uuid) ?? this.#tell(uuid, '')
    this.#told.delete(uuid)
    home?.finished(uuid, error)
  }

  #tell(uuid: string, suggestedFilename: string): WebKitPageDownloads | undefined {
    const begun = this.#begun.get(uuid)
    if (begun === undefined) return undefined
    this.#begun.delete(uuid)
    this.#told.set(uuid, begun.home)
    begun.home.began({ guid: uuid, url: begun.url, suggestedFilename, ...(begun.startedIn === undefined ? {} : { startedIn: begun.startedIn }) })
    return begun.home
  }

  #closed(browserContextId: string, home: WebKitPageDownloads): void {
    if (this.#homes.get(browserContextId) === home) this.#homes.delete(browserContextId)
    for (const [uuid, begun] of this.#begun) if (begun.home === home) this.#begun.delete(uuid)
    for (const [uuid, told] of this.#told) if (told === home) this.#told.delete(uuid)
  }

  // An event Retest cannot read must not reach the connection, which would drop the browser's other events with it.
  #guarded(work: () => void): void {
    try {
      work()
    } catch (error) {
      this.#onListenerError(error)
    }
  }
}

/** One download as the page keeps it, and how to end it. */
type Tracked = { readonly download: PageDownload; readonly end: (end: DownloadEnd) => void }

/** What a page's downloads need: their folder, where listener errors go, how to stop a download, and what to do once closed. */
type PageDownloadsParts = { folder: string; onListenerError: (error: unknown) => void; cancel: (uuid: string) => void; closed: () => void }

/** The downloads of a context's test page, saved in its folder, until `close` is called on them. */
export class WebKitPageDownloads {
  readonly folder: string
  readonly #listeners: Listeners<PageDownload>
  readonly #tracked = new Map<string, Tracked>()
  readonly #cancel: (uuid: string) => void
  readonly #closed: () => void

  constructor({ folder, onListenerError, cancel, closed }: PageDownloadsParts) {
    this.folder = folder
    this.#listeners = new Listeners(onListenerError)
    this.#cancel = cancel
    this.#closed = closed
  }

  /** Tells `listener` of every download the page is told of from now on. Returns a function that removes it. */
  onDownload(listener: (download: PageDownload) => void): () => void {
    return this.#listeners.add(listener)
  }

  began({ guid, url, suggestedFilename, startedIn }: { guid: string; url: string; suggestedFilename: string; startedIn?: DownloadStart }): void {
    const ended = Promise.withResolvers<DownloadEnd>()
    const file = join(this.folder, guid)
    const download: PageDownload = {
      guid,
      url,
      suggestedFilename,
      ...(startedIn === undefined ? {} : { startedIn }),
      ended: ended.promise,
      progress: () => ({ receivedBytes: sizeOf(file) ?? 0, totalBytes: 0 }),
    }
    this.#tracked.set(guid, { download, end: ended.resolve })
    this.#listeners.emit(download)
  }

  // A saved download is its file. One the build gave up keeps no file: what arrived of it is counted, then removed, and
  // the build's own words say why it stopped.
  finished(guid: string, error: string): void {
    const tracked = this.#tracked.get(guid)
    if (tracked === undefined) return
    this.#tracked.delete(guid)
    const filePath = join(this.folder, guid)
    const size = sizeOf(filePath)
    if (error === '' && size !== undefined) {
      tracked.end({ state: 'completed', filePath, receivedBytes: size, totalBytes: size })
      return
    }
    rmSync(filePath, { force: true })
    const reason = error === '' ? 'WebKit said it finished the download, and saved no file of it' : error
    tracked.end({ state: 'canceled', receivedBytes: size ?? 0, totalBytes: 0, reason })
  }

  /**
   * Stops telling of downloads, and of their ends, as the page goes. A download still on its way is stopped, and what had
   * arrived of it removed, since its attempt has written it down as unfinished and keeps no file of it.
   */
  close(): void {
    for (const guid of this.#tracked.keys()) {
      this.#cancel(guid)
      rmSync(join(this.folder, guid), { force: true })
    }
    this.#listeners.clear()
    this.#tracked.clear()
    this.#closed()
  }
}

function sizeOf(path: string): number | undefined {
  try {
    return statSync(path).size
  } catch {
    return undefined
  }
}
