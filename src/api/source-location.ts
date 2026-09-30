import type { SourceLocation } from '../protocol/failures.ts'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCallSites } from 'node:util'
import { relativePosixPath } from '../shared/posix-path.ts'

// The folder holding this copy of Retest: `src` when run from source, `dist` when built.
const ownDirectory = fileURLToPath(new URL('../', import.meta.url))
const stackFrame = /(?:\(|at )((?:file:\/\/)?\/[^()]*?):(\d+):(\d+)\)?$/
const maxFrames = 64

/**
 * Where the code that called into Retest sits: the first stack frame outside Retest's own files.
 *
 * @example callerLocation('/work') // { file: 'tests/tasks.retest.ts', line: 7, column: 9 }
 */
export function callerLocation(rootDir: string): SourceLocation | undefined {
  for (const site of getCallSites(maxFrames)) {
    const location = toLocation(site.scriptName, site.lineNumber, site.columnNumber, rootDir)
    if (location !== undefined) return location
  }
  return undefined
}

/** Where an error was thrown, read from the first frame of its stack outside Retest's own files. */
export function errorLocation(error: Error, rootDir: string): SourceLocation | undefined {
  for (const line of (error.stack ?? '').split('\n')) {
    const [, script = '', row = '', column = ''] = stackFrame.exec(line.trim()) ?? []
    const location = toLocation(script, Number(row), Number(column), rootDir)
    if (location !== undefined) return location
  }
  return undefined
}

/**
 * Names a location for a sentence: `line 7` inside the test's own file, `file:line` elsewhere.
 *
 * @example describeLine({ file: 'a.retest.ts', line: 7, column: 3 }, 'a.retest.ts') // 'line 7'
 */
export function describeLine(location: SourceLocation | undefined, testFile: string): string {
  if (location === undefined) return 'an unknown line'
  return location.file === testFile ? `line ${location.line}` : `${location.file}:${location.line}`
}

function toLocation(script: string, line: number, column: number, rootDir: string): SourceLocation | undefined {
  const path = scriptPath(script)
  if (path === undefined || path.startsWith(ownDirectory) || !(line >= 1 && column >= 1)) return undefined
  return { file: relativePosixPath(rootDir, path), line, column }
}

function scriptPath(script: string): string | undefined {
  if (script.startsWith('file://')) return fileURLToPath(script)
  return isAbsolute(script) ? script : undefined
}
