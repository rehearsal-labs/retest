import type { SourceLocation } from '../protocol/failures.ts'
import { readFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { lstat, realpath } from 'node:fs/promises'
import { readRecordText } from '../shared/regular-file.ts'
import { errorCode } from '../shared/error-code.ts'
import { splitLines } from './diff.ts'

export type CodeFrameLine = { number: number; text: string; marked: boolean }

/** The lines around a location, or why they could not be shown. */
export type CodeFrame = { ok: true; lines: CodeFrameLine[] } | { ok: false; problem: string }

const linesBefore = 2
const linesAfter = 1

/**
 * The lines around `line` in a source text, with that line marked.
 *
 * @example codeFrame('a\nb\nc', 2) // lines 1 to 3, line 2 marked
 */
export function codeFrame(source: string, line: number): CodeFrame {
  const lines = splitLines(source)
  if (line > lines.length) {
    return { ok: false, problem: `line ${line} is past the end of the file, which may have changed since the run` }
  }
  const first = Math.max(1, line - linesBefore)
  const last = Math.min(lines.length, line + linesAfter)
  const frame: CodeFrameLine[] = []
  for (let number = first; number <= last; number++) {
    frame.push({ number, text: lines[number - 1] ?? '', marked: number === line })
  }
  return { ok: true, lines: frame }
}

/** Reads the file at `location`, relative to the run's root directory, as it is now. */
export function readCodeFrame(rootDir: string, location: SourceLocation): CodeFrame {
  let source: string
  try {
    source = readFileSync(resolve(rootDir, location.file), 'utf8')
  } catch (error) {
    return { ok: false, problem: describeReadError(error) }
  }
  return codeFrame(source, location.line)
}

function describeReadError(error: unknown): string {
  const code = errorCode(error)
  if (code === 'ENOENT') return 'the file is gone'
  return code === undefined ? 'the file could not be read' : `the file could not be read (${code})`
}

/** Reads approved report source without following links, with the regular-file reader's byte bound. */
export async function readReportCodeFrame(rootDir: string, location: SourceLocation, redact: (text: string) => string): Promise<CodeFrame> {
  const root = await realpath(rootDir)
  const path = resolve(root, location.file)
  const within = relative(root, path)
  if (within === '' || within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) return { ok: false, problem: 'the file is outside the project folder' }
  const entry = await lstat(path)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return { ok: false, problem: 'the source is not a regular file with one name' }
  const parents: { path: string; dev: number; ino: number }[] = []
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const stats = await lstat(parent)
    if (!stats.isDirectory() || stats.isSymbolicLink()) return { ok: false, problem: 'a source folder is not an owned regular folder' }
    parents.push({ path: parent, dev: stats.dev, ino: stats.ino })
    if (parent === root) break
  }
  const verify = async (): Promise<void> => {
    const current = await lstat(path)
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== entry.dev || current.ino !== entry.ino) throw new Error('the source file changed while it was read')
    for (const parent of parents) {
      const stats = await lstat(parent.path)
      if (!stats.isDirectory() || stats.isSymbolicLink() || stats.dev !== parent.dev || stats.ino !== parent.ino) throw new Error('a source folder changed while it was read')
    }
  }
  const read = await readRecordText(path, { afterCheck: verify, afterOpen: verify })
  await verify()
  if (read.kind !== 'text') return { ok: false, problem: read.kind === 'missing' ? 'the file is gone' : read.problem }
  return codeFrame(redact(read.text), location.line)
}
