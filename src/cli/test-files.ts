import { readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { relativePosixPath } from '../shared/posix-path.ts'
import { CliError, UsageError } from './errors.ts'
import { statIfPresent } from './file-system.ts'
import { suggest } from './suggest.ts'

export const testFileSuffix = '.retest.ts'

const listedFiles = 5

/**
 * Checks the files named on the command line and returns them as POSIX paths relative to `cwd`.
 * Milestone 1 takes only files: no folders, no patterns.
 *
 * @example resolveTestFiles('/work', ['examples/task.retest.ts']) // ['examples/task.retest.ts']
 */
export function resolveTestFiles(cwd: string, args: readonly string[]): string[] {
  if (args.length === 0) throw new UsageError(`Name at least one test file, such as examples/task${testFileSuffix}.`)
  const files: string[] = []
  for (const arg of args) {
    const absolute = resolve(cwd, arg)
    checkFile(arg, absolute)
    const file = relativePosixPath(cwd, absolute)
    if (files.includes(file)) throw new UsageError(`${arg} is named twice.`)
    files.push(file)
  }
  return files
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
  return `${arg} is a folder. Pass files, not folders: Retest runs only the files you name.${hint}`
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
