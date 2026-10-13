import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { DownloadEnd, DownloadStart, PageDownload } from './contract.ts'
import type { Deadline } from '../protocol/deadline.ts'
import { dirname, isAbsolute, resolve } from 'node:path'
import { s } from '../protocol/schema.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { Listeners } from './listeners.ts'

// Chrome tells of a download on the browser's own session, by the frame that began it, whatever context the frame is
// in, so the browser routes each one to the test's page of the context the frame is in. `Page.downloadWillBegin` would
// come on the page's session, but Chrome marks it deprecated in favour of these. A page a page opens, as a link with
// `target="_blank"` does, is a target of its own, often gone a moment after its download begins, so the browser keeps
// what it was told of every page and frame target in a context that saves downloads, from the moment it is made.

const willBeginSchema = s.object({ frameId: s.string(), guid: s.string(), url: s.string(), suggestedFilename: s.string() })
const progressSchema = s.object({
  guid: s.string(),
  totalBytes: s.number({ min: 0 }),
  receivedBytes: s.number({ min: 0 }),
  state: s.enum(['inProgress', 'completed', 'canceled']),
  filePath: s.optional(s.string()),
})
const targetSchema = s.object({
  targetInfo: s.object({ targetId: s.string(), type: s.string(), browserContextId: s.optional(s.string()), openerId: s.optional(s.string()), parentId: s.optional(s.string()) }),
})
const frameSchema = s.object({ frameId: s.string() })
const navigatedSchema = s.object({ frame: s.object({ id: s.string(), parentId: s.optional(s.string()) }) })

/** A page or frame target the browser told of: its context, the page that opened it, and the frame it is inside. */
type TargetFacts = { readonly context: string; readonly opener: string | undefined; readonly parent: string | undefined }

/** A download as the browser began it, before its page is known. */
type Began = { guid: string; url: string; suggestedFilename: string }

type Progress = { guid: string; totalBytes: number; receivedBytes: number; state: 'inProgress' | 'completed' | 'canceled'; filePath?: string | undefined }

/** What a page's downloads are told of it: its session, its main frame as it stands, its context, and whether it is a popup. */
export type PageDownloadsOptions = { session: CdpSession; mainFrame: () => string; browserContextId: string; popup: boolean }

// How far a frame or a popup is followed back to the page that holds it: a popup's popup's frame is three steps.
const maxSteps = 8

/**
 * The browser's downloads, each routed to the test's page of the context it began in. A download begun by that page or
 * a frame inside it is the page's own. One begun by a page it opened, or by a frame of such a page, is told as begun in
 * a popup; any other download of the context, as begun in another page. A download whose frame Retest was told of in no
 * way is placed once it is saved, by the folder it was saved in, as begun in another page.
 */
export class BrowserDownloads {
  readonly #connection: CdpConnection
  readonly #onListenerError: (error: unknown) => void
  readonly #pages = new Set<PageDownloads>()
  // The folder each context that saves downloads saves them in, by context.
  readonly #folders = new Map<string, string>()
  readonly #targets = new Map<string, TargetFacts>()
  // The page each download on its way was told to, by the download's id, until it ends or that page closes.
  readonly #owners = new Map<string, PageDownloads>()
  // Downloads no page could be found for as they began, by id, until they end.
  readonly #unplaced = new Map<string, Began>()
  #discovering: Promise<void> | undefined

  constructor(connection: CdpConnection, onListenerError: (error: unknown) => void) {
    this.#connection = connection
    this.#onListenerError = onListenerError
    connection.on('Browser.downloadWillBegin', (params) => this.#guarded(() => this.#began(params)))
    connection.on('Browser.downloadProgress', (params) => this.#guarded(() => this.#progressed(params)))
    connection.on('Target.targetCreated', (params) => this.#guarded(() => this.#targetTold(params)))
    connection.on('Target.targetInfoChanged', (params) => this.#guarded(() => this.#targetTold(params)))
  }

  /**
   * Tells the browser what to do with a context's downloads: save each in `folder`, named by its id until Retest names
   * it, and say how each goes; or, without a folder, refuse them, so none lands in the person's own Downloads folder.
   * The first context that saves them has the browser tell of every target it makes from then on.
   *
   * @example await downloads.configure(browserContextId, '/run/artifacts/k3v9q0x2mb/web-1a2b/downloads', deadline)
   */
  async configure(browserContextId: string, folder: string | undefined, deadline: Deadline): Promise<void> {
    if (folder !== undefined) {
      this.#folders.set(browserContextId, resolve(folder))
      await this.#discover(deadline)
    }
    const behavior = folder === undefined ? { behavior: 'deny', browserContextId } : { behavior: 'allowAndName', browserContextId, downloadPath: folder, eventsEnabled: true }
    await request(this.#connection, 'Browser.setDownloadBehavior', behavior, s.object({}), sendOptions(deadline))
  }

  /** The downloads of one page, until `close` is called on them. */
  page(options: PageDownloadsOptions): PageDownloads {
    const downloads = new PageDownloads({ ...options, onListenerError: this.#onListenerError, closed: () => this.#closed(downloads) })
    this.#pages.add(downloads)
    return downloads
  }

  // A start that failed is tried again by the next page that saves downloads.
  #discover(deadline: Deadline): Promise<void> {
    const discovering = (this.#discovering ??= request(this.#connection, 'Target.setDiscoverTargets', { discover: true }, s.object({}), sendOptions(deadline)).then(() => undefined))
    discovering.catch(() => {
      if (this.#discovering === discovering) this.#discovering = undefined
    })
    return discovering
  }

  #targetTold(params: unknown): void {
    const { targetId, type, browserContextId, openerId, parentId } = readProtocol(targetSchema, params, { method: 'Target.targetCreated' }).targetInfo
    if ((type !== 'page' && type !== 'iframe') || browserContextId === undefined || !this.#folders.has(browserContextId)) return
    const known = this.#targets.get(targetId)
    this.#targets.set(targetId, { context: browserContextId, opener: openerId ?? known?.opener, parent: parentId ?? known?.parent })
  }

  #began(params: unknown): void {
    const { frameId, guid, url, suggestedFilename } = readProtocol(willBeginSchema, params, { method: 'Browser.downloadWillBegin' })
    const holder = [...this.#pages].find((page) => page.holds(frameId))
    const target = this.#targets.get(frameId)
    const context = holder?.context ?? target?.context
    const home = context === undefined ? undefined : this.#home(context)
    if (home === undefined) {
      this.#unplaced.set(guid, { guid, url, suggestedFilename })
      return
    }
    const startedIn = holder === home ? undefined : holder !== undefined && holder.popup ? this.#openedBy(holder.mainFrame(), home) : this.#startOf(frameId, home)
    this.#owners.set(guid, home)
    home.began({ guid, url, suggestedFilename, ...(startedIn === undefined ? {} : { startedIn }) })
  }

  #progressed(params: unknown): void {
    const progress = readProtocol(progressSchema, params, { method: 'Browser.downloadProgress' })
    const final = progress.state !== 'inProgress'
    const owner = this.#owners.get(progress.guid)
    if (owner !== undefined) {
      if (final) this.#owners.delete(progress.guid)
      owner.progressed(progress)
      return
    }
    const began = this.#unplaced.get(progress.guid)
    if (began === undefined || !final) return
    this.#unplaced.delete(progress.guid)
    const home = progress.filePath === undefined ? undefined : this.#homeByFolder(dirname(progress.filePath))
    if (home === undefined) return
    home.began({ ...began, startedIn: 'other' })
    home.progressed(progress)
  }

  // The test's page of a context: the one page of it that is no popup.
  #home(context: string): PageDownloads | undefined {
    return [...this.#pages].find((page) => page.context === context && !page.popup)
  }

  #homeByFolder(folder: string): PageDownloads | undefined {
    const context = [...this.#folders].find(([, saved]) => saved === resolve(folder))?.[0]
    return context === undefined ? undefined : this.#home(context)
  }

  // Where a frame target stands to the page: a frame inside it, a page it opened or a frame of one, or another page.
  #startOf(targetId: string, home: PageDownloads): DownloadStart | undefined {
    let current: string | undefined = targetId
    let opened = false
    for (let step = 0; step < maxSteps && current !== undefined; step += 1) {
      if (current === home.mainFrame()) return opened ? 'popup' : undefined
      const facts = this.#targets.get(current)
      if (facts?.parent !== undefined) current = facts.parent
      else {
        opened = true
        current = facts?.opener
      }
    }
    return 'other'
  }

  // A popup page Retest opened is the test's when the page or a page it opened opened it.
  #openedBy(popupFrame: string, home: PageDownloads): DownloadStart {
    return this.#startOf(popupFrame, home) === 'popup' ? 'popup' : 'other'
  }

  // A page that closes takes the downloads still on their way to it, and the facts of its context, with it.
  #closed(page: PageDownloads): void {
    this.#pages.delete(page)
    for (const [guid, owner] of this.#owners) if (owner === page) this.#owners.delete(guid)
    if (page.popup) return
    this.#folders.delete(page.context)
    for (const [targetId, facts] of this.#targets) if (facts.context === page.context) this.#targets.delete(targetId)
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

type PageDownloadsParts = PageDownloadsOptions & { onListenerError: (error: unknown) => void; closed: () => void }

/** One download as the page keeps it: what it reports, and how to end it. */
type Tracked = { download: PageDownload; received: number; total: number; end: (end: DownloadEnd) => void }

/**
 * The downloads one page is told of: those begun in its main frame and in the frames inside it, which the page tells of
 * as they attach and detach, and, for the test's own page of a context, those begun anywhere else in its context.
 */
export class PageDownloads {
  readonly mainFrame: () => string
  readonly context: string
  readonly popup: boolean
  readonly #frames = new Set<string>()
  readonly #listeners: Listeners<PageDownload>
  readonly #tracked = new Map<string, Tracked>()
  readonly #stopListening: (() => void)[]
  readonly #closed: () => void

  constructor({ session, mainFrame, browserContextId, popup, onListenerError, closed }: PageDownloadsParts) {
    this.mainFrame = mainFrame
    this.context = browserContextId
    this.popup = popup
    this.#closed = closed
    this.#listeners = new Listeners(onListenerError)
    const source = (method: string) => ({ method, sessionId: session.id })
    this.#stopListening = [
      session.on('Page.frameAttached', (params) => this.#frames.add(readProtocol(frameSchema, params, source('Page.frameAttached')).frameId)),
      session.on('Page.frameDetached', (params) => this.#frames.delete(readProtocol(frameSchema, params, source('Page.frameDetached')).frameId)),
      session.on('Page.frameNavigated', (params) => {
        const { frame } = readProtocol(navigatedSchema, params, source('Page.frameNavigated'))
        if (frame.parentId !== undefined) this.#frames.add(frame.id)
      }),
    ]
  }

  /** Whether the frame is this page's: its main frame, or a frame inside it the page told of. */
  holds(frameId: string): boolean {
    return frameId === this.mainFrame() || this.#frames.has(frameId)
  }

  /** Tells `listener` of every download the page is told of from now on. Returns a function that removes it. */
  onDownload(listener: (download: PageDownload) => void): () => void {
    return this.#listeners.add(listener)
  }

  began({ guid, url, suggestedFilename, startedIn }: Began & { startedIn?: DownloadStart }): void {
    const ended = Promise.withResolvers<DownloadEnd>()
    const tracked: Tracked = {
      received: 0,
      total: 0,
      end: ended.resolve,
      download: {
        guid,
        url,
        suggestedFilename,
        ...(startedIn === undefined ? {} : { startedIn }),
        ended: ended.promise,
        progress: () => ({ receivedBytes: tracked.received, totalBytes: tracked.total }),
      },
    }
    this.#tracked.set(guid, tracked)
    this.#listeners.emit(tracked.download)
  }

  progressed({ guid, receivedBytes, totalBytes, state, filePath }: Progress): void {
    const tracked = this.#tracked.get(guid)
    if (tracked === undefined) return
    tracked.received = receivedBytes
    tracked.total = totalBytes
    if (state === 'inProgress') return
    this.#tracked.delete(guid)
    // A download the browser says it completed, but whose file it does not name, is not one Retest can keep.
    if (state === 'completed' && filePath !== undefined && isAbsolute(filePath)) tracked.end({ state: 'completed', filePath, receivedBytes, totalBytes })
    else tracked.end({ state: 'canceled', receivedBytes, totalBytes })
  }

  /** Stops routing downloads to this page and tells no listener of any more. A download on its way is left as it is. */
  close(): void {
    for (const stop of this.#stopListening) stop()
    this.#listeners.clear()
    this.#tracked.clear()
    this.#closed()
  }
}
