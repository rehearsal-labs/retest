import type { SourceLocation } from '../protocol/failures.ts'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
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
