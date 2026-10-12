import type { Failure } from './failures.ts'
import { failure, failureSchema } from './failures.ts'
import { stringLiteral } from './locator.ts'
import { s, type Schema } from './schema.ts'
import { shorten } from './text.ts'

/**
 * A file a test gives an `<input type="file">`, as the test file's process sends it: a path as the test wrote it, with
 * the folder it resolves against, which is the folder of the file that made the call, or a file by its content, its
 * bytes in base64. The parent reads the path and writes the content to a file of its own before the page sees either.
 */
export type InputFileRecord = { path: string; folder: string } | { name: string; mimeType?: string; base64: string }

/** A file as the browser holds it once an input took it, or as a download saved it: its name, its size in bytes and its type. */
export type FileRecord = { name: string; size: number; type?: string }

/**
 * What a test asks the parent for about files, beyond a page command. `chooser` arms an app's page for the next file
 * picker it opens, and `download` for the next download it begins; each is answered once that happens, or once its time
 * runs out. `saved` waits for a download the test was given to be saved in the run folder. `release` lets go of the
 * arm `request` named, when the action it armed for failed; it has no answer of its own.
 */
export type FilesRequest =
  | { kind: 'chooser'; app: string }
  | { kind: 'download'; app: string }
  | { kind: 'saved'; download: string }
  | { kind: 'release'; request: number }

/**
 * The parent's answer: the picker that opened, with whether its input takes several files; the download that began,
 * with the name the browser suggested; the saved download's absolute path and size; or why there is none.
 */
export type FilesAnswer =
  | { ok: true; kind: 'chooser'; chooser: string; multiple: boolean }
  | { ok: true; kind: 'download'; download: string; suggestedFilename: string }
  | { ok: true; kind: 'saved'; path: string; size: number }
  | { ok: false; failure: Failure }

export const inputFileRecordSchema: Schema<InputFileRecord> = s.union([
  s.object({ path: s.string(), folder: s.string() }),
  s.object({ name: s.string(), mimeType: s.optional(s.string()), base64: s.string() }),
])

export const fileRecordSchema: Schema<FileRecord> = s.object({ name: s.string(), size: s.number({ integer: true, min: 0 }), type: s.optional(s.string()) })

export const filesRequestSchema: Schema<FilesRequest> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('chooser'), app: s.string() }),
  s.object({ kind: s.literal('download'), app: s.string() }),
  s.object({ kind: s.literal('saved'), download: s.string() }),
  s.object({ kind: s.literal('release'), request: s.number({ integer: true, min: 0 }) }),
])

export const filesAnswerSchema: Schema<FilesAnswer> = s.union([
  s.object({ ok: s.literal(true), kind: s.literal('chooser'), chooser: s.string(), multiple: s.boolean() }),
  s.object({ ok: s.literal(true), kind: s.literal('download'), download: s.string(), suggestedFilename: s.string() }),
  s.object({ ok: s.literal(true), kind: s.literal('saved'), path: s.string(), size: s.number({ integer: true, min: 0 }) }),
  s.object({ ok: s.literal(false), failure: failureSchema }),
])

// A name a file may take in a folder: no separator, and not one of the names that mean a folder itself.
const separators = /[/\\\0]/
const base64Text = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Names the files a test gave an input, the way the test wrote them: a path as written, a file by content by its name,
 * and a list when the test passed one, even a list of one or of none.
 *
 * @example describeInputFiles([{ path: './report.pdf', folder: '/work/tests' }], false) // "'./report.pdf'"
 */
export function describeInputFiles(files: readonly InputFileRecord[], list: boolean): string {
  const described = files.map(describeInputFile)
  if (list || described.length !== 1) return `[${described.join(', ')}]`
  return described[0] ?? '[]'
}

function describeInputFile(file: InputFileRecord): string {
  return 'path' in file ? stringLiteral(shorten(file.path)) : `{ name: ${stringLiteral(shorten(file.name))} }`
}

/**
 * What the parent and the test file's process both refuse, as `usage`, in the files a test gives an input: an empty
 * path, a path whose folder is not absolute, a file by content with no name or a name that holds a folder, content that
 * is not base64, and a type that is not one. Undefined when every file is one Retest can give.
 *
 * @example inputFilesProblem([{ name: 'a/b.txt', base64: '' }], 'setInputFiles') // { class: 'usage', … }
 */
export function inputFilesProblem(files: readonly InputFileRecord[], method: string): Failure | undefined {
  for (const file of files) {
    const problem = 'path' in file ? pathProblem(file) : contentProblem(file)
    if (problem !== undefined) return failure('usage', `${method}() ${problem}`)
  }
  return undefined
}

function pathProblem({ path, folder }: Extract<InputFileRecord, { path: string }>): string | undefined {
  if (path === '' || path.includes('\0')) return 'takes a path to a file, received an empty path.'
  // The folder is the calling file's, which the test file's process reads as an absolute POSIX path.
  return folder.startsWith('/') ? undefined : `received the path ${JSON.stringify(path)} with a folder Retest cannot resolve it against.`
}

function contentProblem({ name, mimeType, base64 }: Extract<InputFileRecord, { base64: string }>): string | undefined {
  if (name === '' || name === '.' || name === '..' || separators.test(name)) {
    return `takes a file's name without a folder, such as 'notes.txt', received ${JSON.stringify(name)}.`
  }
  if (mimeType !== undefined && !/^[^\s/]+\/[^\s/]+$/.test(mimeType)) return `takes mimeType as a type such as 'text/plain', received ${JSON.stringify(mimeType)}.`
  return base64Text.test(base64) && base64.length % 4 === 0 ? undefined : `received the content of ${JSON.stringify(name)} in a form Retest cannot read.`
}
