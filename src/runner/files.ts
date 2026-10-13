import type { DownloadEnd, FilesCapability, PageDownload } from '../browser/contract.ts'
import type { EventBody } from '../protocol/events.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { FilesAnswer, InputFileRecord } from '../protocol/files.ts'
import type { Redactor } from './redactor.ts'
import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { filesRefused } from '../browser/file-chooser.ts'
import { originAndPath } from '../browser/page-url.ts'
import { errorMessage, failure, failureSchema } from '../protocol/failures.ts'
import { parse } from '../protocol/schema.ts'
import { downloadFileName } from '../store/artifacts.ts'
import { bounded } from './bounded.ts'

/** The folder of a run where Retest writes the files a test gives an input by content, while their test runs. */
export const uploadsFolder = 'uploads'

// A saved download is read for secrets a piece at a time, each piece beginning with the end of the one before, so a
// value that a piece's edge cuts is still read whole, up to this many characters long.
const pieceBytes = 8 * 1024 * 1024
const pieceOverlap = 64 * 1024

/**
 * One app's page as the attempt's files see it: its file pickers and downloads, when it has them, where it runs, for a
 * refusal that names it, such as `on Firefox` or `in an Electron app`, its session, and, when it saves downloads, the
 * folder they go to, absolute and as a reference in the run folder.
 */
export type FilesPage = {
  readonly files: FilesCapability | undefined
  readonly where: string
  readonly sessionId: string
  readonly downloads?: { readonly folder: string; readonly reference: string } | undefined
}

export type AttemptFilesOptions = {
  readonly pages: ReadonlyMap<string, FilesPage>
  readonly runFolder: string
  readonly testId: string
  readonly attemptId: string
  readonly redactor?: Redactor | undefined
  readonly emit: (body: EventBody) => void
}

/** How long a request may wait, the signal that stops it, and the step and place of the call that made it. */
export type FilesBudget = { readonly timeoutMs: number; readonly signal: AbortSignal; readonly stepId?: string | undefined; readonly location?: SourceLocation | undefined }

/** The files of an input command, as the page takes them: absolute paths, and the type the test named for each, or null. */
export type ResolvedFiles = { ok: true; paths: string[]; mimeTypes: (string | null)[] } | { ok: false; failure: Failure }

/** A download as the attempt keeps it, from the moment the page began it until it ended or the attempt did. */
type Kept = {
  readonly id: string
  readonly app: string
  readonly page: FilesPage
  readonly download: PageDownload
  readonly saved: Promise<Saved>
  given?: { readonly stepId?: string | undefined; readonly location?: SourceLocation | undefined }
  done: boolean
}

type Saved = { ok: true; path: string; size: number } | { ok: false; failure: Failure }

/**
 * One attempt's files: the files a test gives an input, checked and, when given by content, written to a folder of the
 * run's own; the file pickers a test waits for; and every download an app's browser context makes, saved under the
 * name the page suggested in its session's downloads folder, and written down once it ends, whether or not the test
 * waited for it. A download that holds the value of a secret is removed rather than kept.
 */
export class AttemptFiles {
  readonly #options: AttemptFilesOptions
  readonly #kept = new Map<string, Kept>()
  // What a `page.download()` on an app waits for: the next download that app begins.
  readonly #waiting = new Map<string, (kept: Kept) => void>()
  readonly #stopListening: (() => void)[] = []
  #staged = 0
  #closed = false

  constructor(options: AttemptFilesOptions) {
    this.#options = options
    for (const [app, page] of options.pages) {
      const stop = page.downloads === undefined ? undefined : page.files?.onDownload?.((download) => this.#began(app, page, download))
      if (stop !== undefined) this.#stopListening.push(stop)
    }
  }

  /**
   * The paths a page gives an input for the files a test named: each path read against the folder of the file that
   * made the call, and each file given by content written to a folder of the run's own, named as the test named it.
   * A path with no file at it fails `usage`, naming the path.
   */
  stage(files: readonly InputFileRecord[], method: string): ResolvedFiles {
    const paths: string[] = []
    const mimeTypes: (string | null)[] = []
    for (const file of files) {
      if ('path' in file) {
        const path = resolve(file.folder, file.path)
        const problem = fileProblem(path)
        if (problem !== undefined) return { ok: false, failure: { ...failure('usage', `${method}() ${problem}`), details: { path, inputSent: false } } }
        paths.push(path)
        mimeTypes.push(null)
        continue
      }
      this.#staged += 1
      const folder = join(this.#options.runFolder, uploadsFolder, this.#options.attemptId, String(this.#staged))
      try {
        mkdirSync(folder, { recursive: true })
        writeFileSync(join(folder, file.name), Buffer.from(file.base64, 'base64'))
      } catch (error) {
        return { ok: false, failure: failure('setup_failed', `Retest could not write ${file.name} for ${method}(): ${errorMessage(error)}`) }
      }
      paths.push(join(folder, file.name))
      mimeTypes.push(file.mimeType ?? null)
    }
    return { ok: true, paths, mimeTypes }
  }

  /** Waits for the next file picker the app's page opens, within the budget, and answers with it. */
  async chooser(app: string, budget: FilesBudget): Promise<FilesAnswer> {
    const page = this.#options.pages.get(app)
    if (page?.files === undefined) return refused(filesRefused('chooser', page?.where ?? 'on this app'))
    const arm = page.files.armFileChooser()
    const opened = await bounded(arm.opened, budget.timeoutMs, aborted(budget.signal))
    if (opened.status === 'done') return { ok: true, kind: 'chooser', chooser: opened.value.id, multiple: opened.value.multiple }
    arm.release()
    if (opened.status === 'failed') return refused(failureOf(opened.error))
    if (opened.status === 'stopped') return refused(stoppedBy(budget.signal, 'Retest stopped waiting for a file picker.'))
    const message = `No file picker opened within ${budget.timeoutMs} ms of page.fileChooser(). Check that its action opens one, as a click on an upload button does.`
    return refused({ ...failure('timeout', message), details: { timeoutMs: budget.timeoutMs } })
  }

  /** Waits for the next download the app's page begins, within the budget, and answers with it. */
  async download(app: string, budget: FilesBudget): Promise<FilesAnswer> {
    const page = this.#options.pages.get(app)
    if (page?.files?.onDownload === undefined || page.downloads === undefined) return refused(filesRefused('download', page?.where ?? 'on this app'))
    if (this.#waiting.has(app)) return refused(failure('usage', 'page.download() is already waiting for a download on this app. Await it before you wait for the next.'))
    const began = Promise.withResolvers<Kept>()
    this.#waiting.set(app, began.resolve)
    const waited = await bounded(began.promise, budget.timeoutMs, aborted(budget.signal))
    if (this.#waiting.get(app) === began.resolve) this.#waiting.delete(app)
    if (waited.status === 'done') {
      const kept = waited.value
      kept.given = { stepId: budget.stepId, location: budget.location }
      return { ok: true, kind: 'download', download: kept.id, suggestedFilename: this.#redact(kept.download.suggestedFilename) }
    }
    if (waited.status === 'stopped') return refused(stoppedBy(budget.signal, 'Retest stopped waiting for a download.'))
    const message = `No download began within ${budget.timeoutMs} ms of page.download(). Check that its action starts one, as a link to a file does.`
    return refused({ ...failure('timeout', message), details: { timeoutMs: budget.timeoutMs } })
  }

  /** Waits for a download the test was given to be saved, within the budget, and answers with its path and size. */
  async saved(id: string, budget: FilesBudget): Promise<FilesAnswer> {
    const kept = this.#kept.get(id)
    if (kept?.given === undefined) return refused(failure('usage', 'This download is not one page.download() gave this test, so Retest has no file for it.'))
    const saved = await bounded(kept.saved, budget.timeoutMs, aborted(budget.signal))
    if (saved.status === 'done') return saved.value.ok ? { ok: true, kind: 'saved', path: saved.value.path, size: saved.value.size } : refused(saved.value.failure)
    if (saved.status === 'failed') return refused(failureOf(saved.error))
    if (saved.status === 'stopped') return refused(stoppedBy(budget.signal, 'Retest stopped waiting for the download to be saved.'))
    const name = this.#redact(kept.download.suggestedFilename)
    const message = `The download of ${name} was not saved within ${budget.timeoutMs} ms: ${describeProgress(kept.download.progress())} had arrived.`
    return refused({ ...failure('timeout', message), details: { timeoutMs: budget.timeoutMs } })
  }

  /**
   * Ends the attempt's files: each download still on its way is written down as unfinished, no later one is told of,
   * and the files written for inputs are removed with their folder.
   */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    for (const stop of this.#stopListening) stop()
    for (const kept of this.#kept.values()) {
      if (kept.done) continue
      kept.done = true
      this.#write(kept, { state: 'unfinished', ...kept.download.progress() })
    }
    rmSync(join(this.#options.runFolder, uploadsFolder, this.#options.attemptId), { recursive: true, force: true })
    removeQuietly(join(this.#options.runFolder, uploadsFolder), rmdirSync)
  }

  // A `page.download()` takes a download the page, a frame inside it or a page it opened began, never one another page of
  // its context began.
  #began(app: string, page: FilesPage, download: PageDownload): void {
    if (this.#closed) return
    const id = `download-${this.#kept.size + 1}`
    const saved = Promise.withResolvers<Saved>()
    const kept: Kept = { id, app, page, download, saved: saved.promise, done: false }
    this.#kept.set(id, kept)
    void download.ended.then((end) => saved.resolve(this.#ended(kept, end)))
    const waiting = this.#waiting.get(app)
    if (waiting === undefined || download.startedIn === 'other') return
    this.#waiting.delete(app)
    waiting(kept)
  }

  // A completed download takes the name the page suggested, made safe for a file name, with a number before its
  // extension when the folder already holds one by that name. One that holds the value of a secret is removed, even once
  // its test has ended, since a secret never reaches a file of the run. A cancelled one leaves no file of its own behind.
  #ended(kept: Kept, end: DownloadEnd): Saved {
    const folder = kept.page.downloads
    const name = this.#redact(kept.download.suggestedFilename)
    if (end.state === 'completed' && this.#holdsSecret(end.filePath)) {
      removeQuietly(end.filePath)
      const message = `Retest did not keep the download of ${name}: it holds the value of a secret, and a secret never reaches a file of the run. Retest removed the file.`
      const withheld = { ...failure('unsupported', message), details: { download: name } }
      if (!kept.done) this.#write(kept, { state: 'withheld', size: end.receivedBytes, failure: withheld })
      kept.done = true
      return { ok: false, failure: withheld }
    }
    if (folder === undefined || kept.done) return { ok: false, failure: failure('interrupted', `The test ended before the download of ${name} was saved.`) }
    kept.done = true
    if (end.state === 'canceled') {
      removeQuietly(join(folder.folder, `${kept.download.guid}.crdownload`))
      const message = `The browser stopped the download of ${name} after ${describeProgress(end)} had arrived, and gives no reason. Retest saved nothing.`
      const stopped = { ...failure('not_actionable', message), details: { download: name, receivedBytes: end.receivedBytes, totalBytes: end.totalBytes } }
      this.#write(kept, { state: 'canceled', receivedBytes: end.receivedBytes, totalBytes: end.totalBytes, failure: stopped })
      return { ok: false, failure: stopped }
    }
    if (resolve(dirname(end.filePath)) !== resolve(folder.folder)) {
      const outside = failure('setup_failed', `The browser saved the download of ${name} outside its folder, so Retest did not keep it.`)
      this.#write(kept, { state: 'canceled', receivedBytes: end.receivedBytes, totalBytes: end.totalBytes, failure: outside })
      return { ok: false, failure: outside }
    }
    try {
      const file = freeName(folder.folder, downloadFileName(name))
      renameSync(end.filePath, join(folder.folder, file))
      const { size } = statSync(join(folder.folder, file))
      this.#write(kept, { state: 'completed', path: `${folder.reference}/${file}`, size })
      return { ok: true, path: join(folder.folder, file), size }
    } catch (error) {
      const lost = failure('setup_failed', `Retest could not keep the download of ${name}: ${errorMessage(error)}`)
      this.#write(kept, { state: 'canceled', receivedBytes: end.receivedBytes, totalBytes: end.totalBytes, failure: lost })
      return { ok: false, failure: lost }
    }
  }

  #write(kept: Kept, ending: DownloadEnding): void {
    const { testId, attemptId } = this.#options
    const given = kept.given === undefined ? {} : { awaited: true as const, ...(kept.given.stepId === undefined ? {} : { stepId: kept.given.stepId }), ...(kept.given.location === undefined ? {} : { location: kept.given.location }) }
    this.#options.emit({
      type: 'download',
      testId,
      attemptId,
      session: kept.app,
      sessionId: kept.page.sessionId,
      suggestedFilename: this.#redact(kept.download.suggestedFilename),
      url: this.#redact(downloadAddress(kept.download.url)),
      ...(kept.download.startedIn === undefined ? {} : { startedIn: kept.download.startedIn }),
      ...ending,
      ...given,
    })
  }

  #redact(text: string): string {
    return this.#options.redactor?.redact(text) ?? text
  }

  // Whether the file holds a value the run hides, read as text in every form the redactor knows it. A run that hides no
  // value reads nothing.
  #holdsSecret(path: string): boolean {
    const { redactor } = this.#options
    if (redactor === undefined || !redactor.active) return false
    let file: number
    try {
      file = openSync(path, 'r')
    } catch {
      return false
    }
    try {
      const piece = Buffer.alloc(pieceBytes)
      let carried = ''
      for (;;) {
        const read = readSync(file, piece, 0, pieceBytes, null)
        if (read === 0) return false
        const text = carried + piece.toString('utf8', 0, read)
        if (redactor.redact(text) !== text) return true
        carried = text.slice(-pieceOverlap)
      }
    } finally {
      closeSync(file)
    }
  }
}

/** How a download ended, as its event records it, besides who made it and where it came from. */
type DownloadEnding =
  | { state: 'completed'; path: string; size: number }
  | { state: 'withheld'; size: number; failure: Failure }
  | { state: 'canceled'; receivedBytes: number; totalBytes: number; failure: Failure }
  | { state: 'unfinished'; receivedBytes: number; totalBytes: number }

/**
 * A name in `folder` no file holds yet: `name` itself, or with `-2`, `-3` and so on before its extension.
 *
 * @example freeName('/run/downloads', 'tasks.csv') // 'tasks-2.csv' when tasks.csv is there
 */
export function freeName(folder: string, name: string): string {
  if (!existsSync(join(folder, name))) return name
  const extension = extname(name)
  const stem = extension === '' || extension === name ? name : name.slice(0, -extension.length)
  const suffix = extension === name ? '' : extension
  for (let number = 2; ; number += 1) {
    const candidate = `${stem}-${number}${suffix}`
    if (!existsSync(join(folder, candidate))) return candidate
  }
}

// Where a download came from, as an address is recorded: its origin and path, never its query, which can carry what the
// page was given. An address with no host, such as a blob's or a data address, keeps its scheme alone.
function downloadAddress(url: string): string {
  const parsed = URL.parse(url)
  return parsed === null ? 'an address Retest cannot read' : originAndPath(parsed)
}

function describeProgress({ receivedBytes, totalBytes }: { receivedBytes: number; totalBytes: number }): string {
  return totalBytes > 0 ? `${receivedBytes} of ${totalBytes} bytes` : `${receivedBytes} bytes`
}

function fileProblem(path: string): string | undefined {
  try {
    const stats = statSync(path)
    return stats.isFile() ? undefined : `received ${path}, which is not a file.`
  } catch {
    return `found no file at ${path}.`
  }
}

// What is gone already, or a folder another attempt still writes in, is left as it is.
function removeQuietly(path: string, remove: (path: string) => void = unlinkSync): void {
  try {
    remove(path)
  } catch {
    // The browser removes what it left of some downloads itself, and an attempt that still runs keeps its files.
  }
}

function refused(problem: Failure): FilesAnswer {
  return { ok: false, failure: problem }
}

// A browser's refusal of an arm carries its failure; anything else thrown is the browser call failing.
function failureOf(error: unknown): Failure {
  const carried = typeof error === 'object' && error !== null && 'failure' in error ? parse(failureSchema, error.failure) : undefined
  return carried?.ok === true ? carried.value : failure('session_lost', `The browser call failed: ${errorMessage(error)}`)
}

function stoppedBy(signal: AbortSignal, fallback: string): Failure {
  const parsed = parse(failureSchema, signal.reason)
  return parsed.ok ? parsed.value : failure('interrupted', fallback)
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}
