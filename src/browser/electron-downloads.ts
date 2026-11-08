import type { CdpConnection } from './cdp/connection.ts'
import type { FilesCapability } from './contract.ts'
import type { Failure } from '../protocol/failures.ts'
import { readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { s } from '../protocol/schema.ts'
import { errorCode } from '../shared/error-code.ts'
import { BrowserError } from './browser-error.ts'
import { CdpClosedError, CdpDisconnectedError, CdpProtocolError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { BrowserDownloads } from './downloads.ts'

// An Electron app's downloads, as Retest can set them over the app's debugging pipe, measured on Electron 44.5.1.
// Electron takes a download behavior for its default session only, and only when the behavior names no session, so
// Retest saves the downloads of the default session's windows and none of a window in a session of its own, as a
// partition makes. Once the behavior is set, Chromium decides where each download goes: the app's will-download handler
// still runs, but a path it gives with setSavePath, or a save dialog it asks for, never takes effect, though the app's
// DownloadItem goes on reporting the path it gave. A handler that cancels a download is told to Retest only as a stop
// with no reason, and one that pauses it, only as a download that does not finish. A download the main process starts
// with session.downloadURL() belongs to no window: Chromium tells Retest nothing of it, though it saves it in the folder
// all the same.

const contextsSchema = s.object({ defaultBrowserContextId: s.optional(s.string()) })
const willBeginSchema = s.object({ guid: s.string(), suggestedFilename: s.string() })
// A file Chromium writes under a download's id: the download itself until Retest names it, or the part of it on its way.
const downloadIdFile = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(\.crdownload)?$/

export type ElectronDownloadsOptions = {
  readonly connection: CdpConnection
  /** The app and target as the config names them, which a refusal names. */
  readonly app: string
  readonly target: string
  readonly onListenerError: (error: unknown) => void
  /** Hears what Retest could not save or refuse, for the launch's windows record and the app's log. */
  readonly note: (text: string) => void
  /** Writes a line to the app's log. */
  readonly log: (line: string) => void
}

/**
 * The downloads of an Electron app's default session: refused from the launch on, so none lands in the person's own
 * Downloads folder by the app's own handling, and saved in the folder the test's page names once it names one. The
 * first window's downloads are refused by name when it is in a session of its own.
 *
 * @example const downloads = new ElectronDownloads({ connection, app: 'desk', target: 'electron', onListenerError, note, log })
 */
export class ElectronDownloads {
  /** The browser's downloads, which route each download to the first window. */
  readonly browser: BrowserDownloads
  readonly #connection: CdpConnection
  readonly #app: string
  readonly #target: string
  readonly #onListenerError: (error: unknown) => void
  readonly #note: (text: string) => void
  readonly #log: (line: string) => void
  // Every download Chromium told of, by its id, with the name it suggested.
  readonly #told = new Map<string, string>()
  #defaultContext: string | undefined
  #refusal: Failure | undefined
  #folder: string | undefined

  constructor(options: ElectronDownloadsOptions) {
    this.#connection = options.connection
    this.#app = options.app
    this.#target = options.target
    this.#onListenerError = options.onListenerError
    this.#note = options.note
    this.#log = options.log
    this.browser = new BrowserDownloads(options.connection, options.onListenerError)
    options.connection.on('Browser.downloadWillBegin', (params) => this.#guarded(() => {
      const { guid, suggestedFilename } = readProtocol(willBeginSchema, params, { method: 'Browser.downloadWillBegin' })
      this.#told.set(guid, suggestedFilename)
    }))
  }

  /**
   * Reads which session is the app's default, and refuses every download in it until a test's page names a folder. An
   * app whose Electron refuses either is launched all the same: the launch's record says its downloads go the app's own
   * way, and a test that waits for one is refused by name.
   */
  async start(deadline: Deadline): Promise<void> {
    try {
      const { defaultBrowserContextId } = await request(this.#connection, 'Target.getBrowserContexts', undefined, contextsSchema, sendOptions(deadline))
      // Refusing names no context, so it holds for the default session whether or not Electron named it.
      await this.browser.configure(defaultBrowserContextId ?? '', undefined, deadline, { defaultContext: true })
      this.#defaultContext = defaultBrowserContextId
    } catch (error) {
      if (!(error instanceof CdpProtocolError)) throw error
      const message = `The Electron app ${this.#app} did not let Retest set where its downloads go (${errorMessage(error)}), so Retest waited for none.`
      this.#refusal = { class: 'unsupported', message, details: { app: this.#app, target: this.#target } }
      this.#note(`Electron did not let Retest set where downloads go (${errorMessage(error)}), so Retest neither saves nor refuses the app's downloads: they go the app's own way`)
    }
  }

  /**
   * Takes the session of the first window. A window outside the default session keeps its downloads to the app, which
   * Retest neither saves nor refuses, so a test that waits for one is refused by name.
   */
  window(browserContextId: string): void {
    const named = `The first window of the Electron app ${this.#app}`
    const details = { app: this.#app, target: this.#target }
    if (this.#refusal !== undefined) return
    if (this.#defaultContext === undefined) {
      const message = `${named} may be in a session of its own: Electron did not say which session is its default, so Retest cannot set where the window's downloads go, and waited for none.`
      this.#refusal = { class: 'unsupported', message, details }
      this.#note("Electron did not say which session is its default, so Retest saves none of the first window's downloads")
    } else if (browserContextId !== this.#defaultContext) {
      const message = `${named} is in a session of its own, as a partition makes, and Retest sets where downloads go only in the app's default session, so it waited for none.`
      this.#refusal = { class: 'unsupported', message, details }
      this.#note("the first window is not in the app's default session, so Retest neither saves nor refuses its downloads: they go the app's own way")
    }
  }

  /**
   * Saves the default session's downloads in `folder` from now on, each named by its id until the test's files name it.
   * Without a folder, or for a first window outside the default session, the downloads stay as they are. Throws a
   * `BrowserError` when the app does not take the behavior.
   */
  async save(folder: string | undefined, timeoutMs: number): Promise<void> {
    if (folder === undefined || this.#refusal !== undefined || this.#defaultContext === undefined) return
    const deadline = new Deadline(timeoutMs)
    try {
      await this.browser.configure(this.#defaultContext, folder, deadline, { defaultContext: true })
    } catch (error) {
      if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) {
        throw new BrowserError({ class: 'session_lost', message: `Could not tell the Electron app ${this.#app} where to save its downloads, because it is gone: ${error.reason}.` }, { cause: error })
      }
      throw new BrowserError({ class: 'setup_failed', message: `Could not tell the Electron app ${this.#app} where to save its downloads: ${errorMessage(error)}` }, { cause: error })
    }
    this.#folder = folder
  }

  /**
   * The window's file pickers, with its downloads once they are saved in a folder, or the reason they are not. A window
   * whose downloads are refused tells of none.
   */
  files(files: FilesCapability | undefined): FilesCapability | undefined {
    if (files === undefined) return undefined
    const armFileChooser = () => files.armFileChooser()
    if (this.#refusal !== undefined) return { armFileChooser, downloadsRefused: this.#refusal }
    if (this.#folder === undefined || files.onDownload === undefined) return { armFileChooser }
    return { armFileChooser, onDownload: files.onDownload.bind(files) }
  }

  /**
   * Once the app has quit, removes what Chromium left in the folder under a download's id: the part of a download that
   * never finished, and the file of one that finished once its test had ended, or that Chromium told nothing of. No
   * record names such a file and nothing read it for secrets. One Chromium told nothing of is noted, since no event
   * tells of it. Returns the problems met.
   */
  sweep(): string[] {
    const folder = this.#folder
    if (folder === undefined) return []
    let entries: string[]
    try {
      entries = readdirSync(folder)
    } catch (error) {
      return errorCode(error) === 'ENOENT' ? [] : [`Could not read the Electron app's downloads folder ${folder}: ${errorMessage(error)}`]
    }
    // A page may suggest a name that looks like an id, and the file Retest kept under it stays.
    const suggested = new Set(this.#told.values())
    const problems: string[] = []
    for (const entry of entries) {
      const guid = downloadIdFile.exec(entry)?.[1]
      if (guid === undefined || suggested.has(entry)) continue
      try {
        unlinkSync(join(folder, entry))
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') problems.push(`Could not remove ${entry} from the Electron app's downloads folder: ${errorMessage(error)}`)
        continue
      }
      if (this.#told.has(guid)) this.#log(`Retest removed ${entry} from the downloads folder: what Chromium left of a download whose test had ended`)
      else this.#note(`a download Chromium told nothing of, as one the app's main process starts with session.downloadURL(), was saved in the downloads folder as ${entry}; Retest removed it, since no record names it and nothing read it for secrets`)
    }
    return problems
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
