import type { BidiClient } from './bidi-client.ts'
import type { FirefoxBridge } from './bridge.ts'
import type { CaughtChooser, ChooserArm, DownloadEnd, DownloadStart, PageDownload, ResolvedInputFiles } from '../contract.ts'
import type { Dispatch } from '../dispatch.ts'
import type { CommandResult } from '../../protocol/commands.ts'
import type { Deadline } from '../../protocol/deadline.ts'
import { copyFile, mkdir, rename, rm, stat, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { s } from '../../protocol/schema.ts'
import { errorCode } from '../../shared/error-code.ts'
import { BrowserError } from '../browser-error.ts'
import { CdpProtocolError } from '../cdp/errors.ts'
import { readProtocol, request, sendOptions } from '../cdp-results.ts'
import { giveFiles, oneFileOnly, pickerBefore, pickerDuring } from '../file-chooser.ts'
import { worldName } from '../isolated-world.ts'
import { Listeners } from '../listeners.ts'
import { readBidi } from './bidi-client.ts'

// File pickers and downloads on a Firefox page, over WebDriver BiDi. Retest's session asks Firefox to dismiss every
// file picker a page opens (`unhandledPromptBehavior.file`, in `launch.ts`), so no picker is ever shown, and Firefox
// tells of each one by `input.fileDialogOpened`, naming the input it opened for. The page hears `cancel` from the
// input as the picker closes, whether or not a test waits for it: Firefox closes it before Retest hears of it. A test
// that waited is given the picker, and its input then takes files through `input.setFiles`, as one a person chose in
// the picker would. A picker nobody waited for fails the action that opened it, as on Chromium.
//
// Downloads are saved by the browser for a user context, through `browser.setDownloadBehavior`, in a folder of the
// browser's own that only that user context's downloads on their way use, since Firefox renames a download whose name
// its folder already holds before it tells the name. Once Firefox says a download completed, its file is moved into
// the session's own downloads folder, named by its id until the runner names it. Firefox tells no progress, and says
// nothing of the bytes of a download it stopped.

const worldSchema = s.object({ executionContextId: s.number({ integer: true }) })
const placedSchema = s.object({ result: s.object({ value: s.boolean() }) })

// Whether an element Firefox named is still in the document its world now holds: a reference to a node of a document
// that went can still resolve, to a node no page shows.
const placedFunction = `function isPlaced() {
  return this.isConnected && this.ownerDocument === document
}`

/** A picker Firefox told of: the input it opened for, by its shared id, the browsing context it is in, and whether it takes several files. */
type Caught = { readonly sharedId: string; readonly context: string; readonly multiple: boolean }

/**
 * The file pickers of one Firefox page and the frames inside it. The next picker after `armFileChooser` goes to the test
 * that armed for it; every other is counted, so the action that opened it fails. Firefox has closed every one of them,
 * so the page heard `cancel` either way.
 */
export class FirefoxFileChoosers {
  readonly #caught = new Map<string, Caught>()
  #arm: PromiseWithResolvers<CaughtChooser> | undefined
  // Pickers nobody armed for, closed and not yet told of by a command.
  #unexpected = 0
  #count = 0

  /** Firefox told of a picker an input of this page, or of a frame inside it, opened, or of one no input opened. */
  opened(context: string, sharedId: string | undefined, multiple: boolean): void {
    const arm = this.#arm
    if (arm === undefined) {
      this.#unexpected += 1
      return
    }
    this.#arm = undefined
    if (sharedId === undefined) {
      arm.reject(new BrowserError({ class: 'unsupported', message: 'The page opened a file picker that belongs to no <input type="file">, and Retest gives files only to an input.' }))
      return
    }
    this.#count += 1
    const id = `chooser-${this.#count}`
    this.#caught.set(id, { sharedId, context, multiple })
    arm.resolve({ id, multiple })
  }

  /**
   * Arms the page for the next file picker it opens. A page holds one arm at a time: arming again while one waits fails
   * the new arm's picker at once, and leaves the first as it was.
   */
  armFileChooser(): ChooserArm {
    const arm = Promise.withResolvers<CaughtChooser>()
    // A refused arm's promise is read only by the caller, which may give up on it first.
    arm.promise.catch(() => undefined)
    if (this.#arm !== undefined) {
      arm.reject(new BrowserError({ class: 'usage', message: 'page.fileChooser() is already waiting for a file picker on this page. Await it before you wait for the next.' }))
      return { opened: arm.promise, release: () => undefined }
    }
    this.#arm = arm
    return {
      opened: arm.promise,
      release: () => {
        if (this.#arm === arm) this.#arm = undefined
      },
    }
  }

  /**
   * Runs one of the page's commands, and fails an action during which the page opened a picker nobody armed for, or
   * one that comes after such a picker opened since the last action ended, before anything is sent. Firefox tells of a
   * picker before it answers the input that opened it. A look sends no input, so it opens no picker.
   */
  async around(action: boolean, describe: () => string, run: () => Promise<CommandResult>): Promise<CommandResult> {
    if (!action) return run()
    if (this.#take() > 0) return { ok: false, failure: pickerBefore(describe()) }
    const result = await run()
    return this.#take() > 0 && result.ok ? { ok: false, failure: pickerDuring(describe()) } : result
  }

  /**
   * Gives the input of a picker this page caught the files, then reads back what it holds. The input is read in
   * Retest's own sandbox of the document it is in, the page's or a frame's, where no script of the page can change what
   * it reports.
   */
  async setFiles(command: Extract<ResolvedInputFiles, { kind: 'setChooserFiles' }>, bridge: FirefoxBridge, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
    const caught = this.#caught.get(command.chooser)
    const described = 'give the file picker files'
    if (caught === undefined) return { ok: false, failure: { class: 'usage', message: `Could not ${described}: it is not a picker this page caught, so Retest gave it nothing.`, details: { inputSent: false } } }
    if (command.paths.length > 1 && !caught.multiple) return { ok: false, failure: oneFileOnly(described, command.paths.length) }
    const { session } = bridge
    let world: number
    try {
      world = (await request(session, 'Page.createIsolatedWorld', { frameId: caught.context, worldName }, worldSchema, sendOptions(deadline))).executionContextId
    } catch (error) {
      if (!(error instanceof CdpProtocolError)) throw error
      return { ok: false, failure: { class: 'not_actionable', message: `Could not ${described}: the frame its input is in is gone from the page, so Retest gave it nothing.`, details: { inputSent: false } } }
    }
    const gone = { ok: false as const, failure: { class: 'not_actionable' as const, message: `Could not ${described}: the input it opened for is gone from the page, so Retest gave it nothing.`, details: { inputSent: false } } }
    if (!bridge.holdElement(caught.sharedId, world)) return gone
    let placed: boolean
    try {
      const raw = await session.send('Runtime.callFunctionOn', { objectId: caught.sharedId, functionDeclaration: placedFunction, returnByValue: true }, sendOptions(deadline))
      placed = readProtocol(placedSchema, raw, { method: 'Runtime.callFunctionOn', sessionId: session.id }).result.value
    } catch (error) {
      if (!(error instanceof CdpProtocolError)) throw error
      placed = false
    }
    if (!placed) return gone
    return giveFiles({ session, objectId: caught.sharedId, command, deadline, dispatch })
  }

  #take(): number {
    const count = this.#unexpected
    this.#unexpected = 0
    return count
  }
}

const contextCreatedSchema = s.object({ context: s.string(), parent: s.nullable(s.string()), originalOpener: s.optional(s.nullable(s.string())), userContext: s.optional(s.string()) })
const willBeginSchema = s.object({ context: s.string(), download: s.string(), suggestedFilename: s.string(), url: s.string(), userContext: s.optional(s.string()) })
const endSchema = s.object({ context: s.string(), download: s.string(), status: s.enum(['complete', 'canceled']), filepath: s.optional(s.nullable(s.string())), userContext: s.optional(s.string()) })

// How far a frame or a popup is followed back to the page that holds it: a popup's popup's frame is three steps.
const maxSteps = 8

/** What a page's downloads need: the browser's connection, its user context and tab, and the two folders downloads pass through. */
export type FirefoxDownloadsOptions = {
  readonly client: BidiClient
  readonly userContext: string
  /** The page's own tab, whose downloads, and those of the frames inside it, are its own. */
  readonly context: string
  /** The folder of the browser's own where Firefox saves this user context's downloads on their way. */
  readonly staging: string
  /** The session's downloads folder, where each completed download is moved. */
  readonly folder: string
  readonly onListenerError: (error: unknown) => void
}

/** One download as the page keeps it, and how to end it. */
type Tracked = { readonly download: PageDownload; readonly end: (end: DownloadEnd) => void }

/**
 * The downloads of one Firefox page's user context: those its tab and the frames inside it begin are its own; those a
 * page it opened begins, or a frame of such a page, are told as begun in a popup; any other, as begun in another page.
 * Firefox names a download begun by a link with a target, in the tab such a link opens and closes at once, by the page
 * the link was in, so such a download is the page's own.
 */
export class FirefoxDownloads {
  readonly #options: FirefoxDownloadsOptions
  readonly #listeners: Listeners<PageDownload>
  // Each browsing context of the user context Firefox told of: the frame it is inside, and the page that opened it.
  readonly #contexts = new Map<string, { parent: string | null; opener: string | null }>()
  readonly #tracked = new Map<string, Tracked>()
  readonly #stops: (() => void)[]
  #closed = false

  constructor(options: FirefoxDownloadsOptions) {
    this.#options = options
    this.#listeners = new Listeners(options.onListenerError)
    const guarded = (work: () => void) => () => {
      try {
        work()
      } catch (error) {
        options.onListenerError(error)
      }
    }
    this.#stops = [
      options.client.on('browsingContext.contextCreated', (params) => guarded(() => this.#created(params))()),
      options.client.on('browsingContext.downloadWillBegin', (params) => guarded(() => this.#began(params))()),
      options.client.on('browsingContext.downloadEnd', (params) => guarded(() => this.#ended(params))()),
    ]
  }

  /** Tells `listener` of every download the user context begins from now on. Returns a function that removes it. */
  onDownload(listener: (download: PageDownload) => void): () => void {
    return this.#listeners.add(listener)
  }

  /**
   * Stops telling of downloads, and removes the folder Firefox saved the user context's downloads in on their way, with
   * whatever it left of downloads that never completed. A download on its way is told no end.
   */
  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    for (const stop of this.#stops.splice(0)) stop()
    this.#listeners.clear()
    this.#tracked.clear()
    await rm(this.#options.staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined)
  }

  #mine(userContext: string | undefined, context: string): boolean {
    return userContext === undefined ? context === this.#options.context || this.#contexts.has(context) : userContext === this.#options.userContext
  }

  #created(params: unknown): void {
    const { context, parent, originalOpener, userContext } = readBidi(contextCreatedSchema, params, 'browsingContext.contextCreated')
    if (userContext !== undefined && userContext !== this.#options.userContext) return
    this.#contexts.set(context, { parent, opener: originalOpener ?? null })
  }

  #began(params: unknown): void {
    const { context, download, suggestedFilename, url, userContext } = readBidi(willBeginSchema, params, 'browsingContext.downloadWillBegin')
    if (this.#closed || !this.#mine(userContext, context)) return
    const startedIn = this.#startOf(context)
    const ended = Promise.withResolvers<DownloadEnd>()
    const tracked: Tracked = {
      end: ended.resolve,
      download: { guid: download, url, suggestedFilename, ...(startedIn === undefined ? {} : { startedIn }), ended: ended.promise, progress: () => undefined },
    }
    this.#tracked.set(download, tracked)
    this.#listeners.emit(tracked.download)
  }

  #ended(params: unknown): void {
    const { download, status, filepath } = readBidi(endSchema, params, 'browsingContext.downloadEnd')
    const tracked = this.#tracked.get(download)
    if (tracked === undefined) return
    this.#tracked.delete(download)
    // A download Firefox says it completed, but whose file it does not name, is not one Retest can keep.
    if (status !== 'complete' || filepath === undefined || filepath === null || !isAbsolute(filepath)) {
      tracked.end({ state: 'canceled' })
      return
    }
    void this.#keep(download, filepath).then(tracked.end)
  }

  // The completed file goes into the session's folder under the download's id. A file Retest could not move stays where
  // Firefox saved it, which the runner then refuses to keep, since it is outside the session's folder; one that is not
  // there at all was saved nowhere Retest can read.
  async #keep(download: string, saved: string): Promise<DownloadEnd> {
    const kept = join(this.#options.folder, download)
    try {
      await mkdir(this.#options.folder, { recursive: true })
      await move(saved, kept)
      const { size } = await stat(kept)
      return { state: 'completed', filePath: kept, receivedBytes: size, totalBytes: size }
    } catch {
      const size = await stat(saved).then((stats) => stats.size, () => undefined)
      return size === undefined ? { state: 'canceled' } : { state: 'completed', filePath: saved, receivedBytes: size, totalBytes: size }
    }
  }

  // Where a browsing context stands to the page: a frame inside it, a page it opened or a frame of one, or another page.
  #startOf(context: string): DownloadStart | undefined {
    let current: string | null = context
    let opened = false
    for (let step = 0; step < maxSteps && current !== null; step += 1) {
      if (current === this.#options.context) return opened ? 'popup' : undefined
      const facts = this.#contexts.get(current)
      if (facts === undefined) return 'other'
      if (facts.parent !== null) current = facts.parent
      else {
        opened = true
        current = facts.opener
      }
    }
    return 'other'
  }
}

// A rename where the two folders share a disk, and a copy where they do not.
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (error) {
    if (errorCode(error) !== 'EXDEV') throw error
    await copyFile(from, to)
    await unlink(from)
  }
}
