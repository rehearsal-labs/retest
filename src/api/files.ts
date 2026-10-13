import type { CallOptions } from './call-options.ts'
import type { InputFileRecord } from '../protocol/files.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { Download, FileChooser, InputFiles } from './page.ts'
import type { TestRun } from './test-run.ts'
import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { errorMessage, failure } from '../protocol/failures.ts'
import { inputFilesProblem } from '../protocol/files.ts'
import { isArray, isPlainObject } from '../protocol/schema.ts'
import { readCallOptions } from './call-options.ts'
import { formatValue } from './format-value.ts'
import { misuse } from './misuse.ts'

/** The test, app and recipe behind a locator, as giving files to it needs them. */
type InputTarget = { readonly run: TestRun; readonly app: string; readonly recipe: LocatorRecipe }

/** The test and app behind a page. */
type PageTarget = { readonly run: TestRun; readonly app: string }

/** A file picker the parent caught for the test, whose input the test gives files through the page that opened it. */
class AppFileChooser implements FileChooser {
  readonly multiple: boolean
  readonly #page: PageTarget
  readonly #chooser: string

  constructor(page: PageTarget, chooser: string, multiple: boolean) {
    this.#page = page
    this.#chooser = chooser
    this.multiple = multiple
  }

  setFiles(files: InputFiles, options?: CallOptions): Promise<void> {
    const { run, app } = this.#page
    const location = run.location()
    const read = readInputFiles(files, run.callerFolder(location), 'setFiles')
    if (typeof read === 'string') throw misuse(read, run)
    return run.action(app, { kind: 'setChooserFiles', chooser: this.#chooser, files: read.files, ...(read.list ? { list: true as const } : {}) }, location, options)
  }
}

/** A download the parent caught for the test, whose saved file the test asks the parent for. */
class AppDownload implements Download {
  readonly suggestedFilename: string
  readonly #page: PageTarget
  readonly #download: string

  constructor(page: PageTarget, download: string, suggestedFilename: string) {
    this.#page = page
    this.#download = download
    this.suggestedFilename = suggestedFilename
  }

  path(options?: CallOptions): Promise<string> {
    return this.#saved('download.path()', 'path', options, async (path) => path)
  }

  saveAs(path: string, options?: CallOptions): Promise<void> {
    const { run } = this.#page
    if (typeof path !== 'string' || path === '') throw misuse(`download.saveAs() takes the path to copy the file to, received ${formatValue(path)}.`, run)
    const target = resolve(run.callerFolder(run.location()), path)
    return this.#saved('download.saveAs()', 'saveAs', options, async (saved) => {
      try {
        await mkdir(dirname(target), { recursive: true })
        await copyFile(saved, target)
      } catch (error) {
        throw run.fail(failure('usage', `download.saveAs() could not copy ${this.suggestedFilename} to ${target}: ${errorMessage(error)}`, run.location()))
      }
    })
  }

  #saved<T>(label: string, method: string, options: unknown, then: (path: string) => Promise<T>): Promise<T> {
    const { run } = this.#page
    const location = run.location()
    const read = readCallOptions(method, options)
    if (!read.ok) throw misuse(read.problem, run)
    const timeoutMs = Math.min(read.timeoutMs ?? run.timeouts.navigation, run.timeouts.navigation)
    return run.awaitFiles({ label, request: { kind: 'saved', download: this.#download }, location, timeoutMs }, (answer) => {
      if (answer.kind !== 'saved') throw new Error(`Retest answered a wait for a saved download with ${answer.kind}`)
      return then(answer.path)
    })
  }
}

/**
 * Gives the one file input a locator finds the files: the input that `setInputFiles` is called on.
 *
 * @example await setInputFiles(target, './report.pdf', undefined)
 */
export function setInputFiles({ run, app, recipe }: InputTarget, files: unknown, options: unknown): Promise<void> {
  const location = run.location()
  const read = readInputFiles(files, run.callerFolder(location), 'setInputFiles')
  if (typeof read === 'string') throw misuse(read, run)
  return run.action(app, { kind: 'setInputFiles', locator: recipe, files: read.files, ...(read.list ? { list: true as const } : {}) }, location, options)
}

/**
 * Arms the app's page for the next file picker it opens, runs `action`, and gives the picker that opened. The wait for
 * it starts before the action and lasts the action budget, or a shorter `{ timeout }`.
 *
 * @example const chooser = await fileChooser(page, () => button.click(), undefined)
 */
export function fileChooser(page: PageTarget, action: unknown, options: unknown): Promise<FileChooser> {
  const { run } = page
  const location = run.location()
  if (typeof action !== 'function') throw misuse(`page.fileChooser() takes the action that opens the picker, such as () => upload.click(), received ${formatValue(action)}.`, run)
  const timeoutMs = actionBudget(run, 'fileChooser', options)
  const request = { kind: 'chooser' as const, app: page.app }
  return run.awaitFiles({ label: 'page.fileChooser()', request, location, timeoutMs }, (answer) => {
    if (answer.kind !== 'chooser') throw new Error(`Retest answered a wait for a file picker with ${answer.kind}`)
    return new AppFileChooser(page, answer.chooser, answer.multiple)
  }, () => action())
}

/**
 * Arms the app's page for the next download it begins, runs `action`, and gives the download that began. The wait for
 * it starts before the action and lasts the action budget, or a shorter `{ timeout }`.
 *
 * @example const download = await download(page, () => link.click(), undefined)
 */
export function download(page: PageTarget, action: unknown, options: unknown): Promise<Download> {
  const { run } = page
  const location = run.location()
  if (typeof action !== 'function') throw misuse(`page.download() takes the action that starts the download, such as () => link.click(), received ${formatValue(action)}.`, run)
  const timeoutMs = actionBudget(run, 'download', options)
  const request = { kind: 'download' as const, app: page.app }
  return run.awaitFiles({ label: 'page.download()', request, location, timeoutMs }, (answer) => {
    if (answer.kind !== 'download') throw new Error(`Retest answered a wait for a download with ${answer.kind}`)
    return new AppDownload(page, answer.download, answer.suggestedFilename)
  }, () => action())
}

function actionBudget(run: TestRun, method: string, options: unknown): number {
  const read = readCallOptions(method, options)
  if (!read.ok) throw misuse(read.problem, run)
  return Math.min(read.timeoutMs ?? run.timeouts.action, run.timeouts.action)
}

/** The files a test gave, as the parent takes them, and whether it gave a list. */
type ReadFiles = { files: InputFileRecord[]; list: boolean }

/**
 * Reads the files a JavaScript caller may have passed any way it liked, and says what is wrong as a sentence. A path is
 * kept as the test wrote it, with the folder it is read against.
 *
 * @example readInputFiles('./report.pdf', '/work/tests', 'setInputFiles') // { files: [{ path: './report.pdf', folder: '/work/tests' }], list: false }
 */
export function readInputFiles(value: unknown, folder: string, method: string): ReadFiles | string {
  const list = isArray(value)
  const given: readonly unknown[] = isArray(value) ? value : [value]
  const files: InputFileRecord[] = []
  for (const item of given) {
    const file = readInputFile(item, folder)
    if (file === undefined) {
      const shown = list ? `a list holding ${formatValue(item)}` : formatValue(value)
      return `${method}() takes a path, a file such as { name: 'notes.txt', content: 'hello' }, or a list of them, received ${shown}.`
    }
    if (typeof file === 'string') return `${method}() ${file}`
    files.push(file)
  }
  const problem = inputFilesProblem(files, method)
  return problem === undefined ? { files, list } : problem.message
}

// One file, or undefined for something that is not one, or what is wrong with a file by content.
function readInputFile(item: unknown, folder: string): InputFileRecord | string | undefined {
  if (typeof item === 'string') return { path: item, folder }
  if (!isPlainObject(item)) return undefined
  const given = Object.entries(item).filter(([, entry]) => entry !== undefined)
  const unknown = given.find(([key]) => key !== 'name' && key !== 'mimeType' && key !== 'content')
  if (unknown !== undefined) return `has no file option ${JSON.stringify(unknown[0])}. A file by content takes name, mimeType and content.`
  const { name, mimeType, content } = Object.fromEntries(given)
  if (typeof name !== 'string') return `takes a file's name as text, received ${formatValue(name)}.`
  if (mimeType !== undefined && typeof mimeType !== 'string') return `takes mimeType as text, such as 'text/plain', received ${formatValue(mimeType)}.`
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content instanceof Uint8Array ? Buffer.from(content.buffer, content.byteOffset, content.byteLength) : undefined
  if (bytes === undefined) return `takes a file's content as text or bytes, received ${formatValue(content)}.`
  return { name, ...(mimeType === undefined ? {} : { mimeType }), base64: bytes.toString('base64') }
}
