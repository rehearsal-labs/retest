import type { FileLine } from '../runner/contract.ts'
import { readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { relativePosixPath } from '../shared/posix-path.ts'
import { findTestFiles, testFileSuffix } from '../shared/test-files.ts'
import { CliError, UsageError } from './errors.ts'
import { statIfPresent } from './file-system.ts'
import { suggest } from './suggest.ts'

/** Files as POSIX paths relative to the root, and the lines named with them, as `file:line` asks. */
export type NamedFiles = { files: string[]; locations: FileLine[] }

type Place = { line: number; row?: number }

const listedFiles = 5
const withLine = /^(.+\.retest\.ts):([^/\\]*)$/
const lineColumnAndRow = /^([1-9]\d*)(?::[1-9]\d*)?(?:#([1-9]\d*))?$/

/**
 * Checks the files named on the command line. Each may carry a line, `file:line`, to keep only the test,
 * `test.for` rows or `test.describe` block declared there; a column after it, as a code frame prints, is allowed.
 * `#row` after the line keeps one row of the `test.for` there, counted from 1.
 *
 * @example readFileArguments('/work', ['tests/a.retest.ts:7#2']) // { files: ['tests/a.retest.ts'], locations: [{ file: 'tests/a.retest.ts', line: 7, row: 2 }] }
 */
export function readFileArguments(cwd: string, args: readonly string[]): NamedFiles {
  const files: string[] = []
  const locations: FileLine[] = []
  const wholeFiles = new Set<string>()
  for (const arg of args) {
    const { path, place } = splitLine(arg)
    const absolute = resolve(cwd, path)
    checkFile(path, absolute)
    const file = relativePosixPath(cwd, absolute)
    if (!files.includes(file)) files.push(file)
    const named = place === undefined ? wholeFiles.has(file) : locations.some((known) => known.file === file && known.line === place.line && known.row === place.row)
    if (named) throw new UsageError(`${arg} is named twice.`)
    if (place === undefined) wholeFiles.add(file)
    else locations.push({ file, ...place })
    if (wholeFiles.has(file) && locations.some((known) => known.file === file)) {
      throw new UsageError(`${path} is named on its own and with a line. Name it one way.`)
    }
  }
  return { files, locations }
}

/**
 * Every test file under `root`, as a config run with no files named takes them. Finding none stops the command.
 *
 * @example everyTestFile('/work') // ['tests/example.retest.ts']
 */
export function everyTestFile(root: string): string[] {
  const found = findTestFiles(root)
  if (found.length === 0) throw new CliError(`No test files found. Test files end in ${testFileSuffix}.`)
  return found
}

function splitLine(arg: string): { path: string; place?: Place } {
  const match = withLine.exec(arg)
  if (match === null) return { path: arg }
  const [, path = '', text = ''] = match
  const [, line, row] = lineColumnAndRow.exec(text) ?? []
  if (line === undefined) {
    throw new UsageError(`${arg} names no line. Write the line as a whole number from 1, such as ${path}:7, and a row of a test.for after it, such as ${path}:7#2.`)
  }
  return { path, place: row === undefined ? { line: Number(line) } : { line: Number(line), row: Number(row) } }
}

function checkFile(arg: string, absolute: string): void {
  const stats = statIfPresent(absolute)
  if (stats?.isDirectory() === true) throw new CliError(folderMessage(arg, absolute))
  if (!arg.endsWith(testFileSuffix)) {
    throw new CliError(`${arg} is not a test file. Test files end in ${testFileSuffix}.`)
  }
  if (stats === undefined) throw new CliError(missingMessage(arg, absolute))
  if (!stats.isFile()) throw new CliError(`${arg} is not a file.`)
}

function folderMessage(arg: string, absolute: string): string {
  const inside = testFilesIn(absolute)
    .slice(0, listedFiles)
    .map((name) => join(arg, name))
  const hint = inside.length === 0 ? '' : ` Test files in it: ${inside.join(', ')}.`
  return `${arg} is a folder. Pass files, not folders.${hint}`
}

function missingMessage(arg: string, absolute: string): string {
  const guess = suggest(basename(absolute), testFilesIn(dirname(absolute)))
  const hint = guess === undefined ? '' : ` Did you mean ${join(dirname(arg), guess)}?`
  return `${arg} does not exist.${hint}`
}

function testFilesIn(folder: string): string[] {
  try {
    return readdirSync(folder, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(testFileSuffix))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}
