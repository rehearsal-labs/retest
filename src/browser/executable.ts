import { constants } from 'node:fs'
import { access, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { errorMessage } from '../protocol/failures.ts'
import { errorCode } from '../shared/error-code.ts'
import { LaunchError } from './contract.ts'

const passBrowser = 'Pass the path to a Chromium or Chrome executable.'

/**
 * Checks that a path names a file this process may execute, and returns it as an absolute path.
 *
 * @example await checkExecutable('/Applications/Google Chrome.app') // throws, naming the binary inside
 */
export async function checkExecutable(path: string): Promise<string> {
  const absolute = resolve(path)
  const stats = await stat(absolute).catch((error: unknown) => {
    throw new LaunchError(missingMessage(absolute, error), { cause: error })
  })
  if (stats.isDirectory()) throw new LaunchError(await folderMessage(absolute))
  if (!stats.isFile()) throw new LaunchError(`${absolute} is not a file. ${passBrowser}`)
  await access(absolute, constants.X_OK).catch((error: unknown) => {
    throw new LaunchError(`${absolute} is not executable. Allow it to run, or pass another browser.`, { cause: error })
  })
  return absolute
}

function missingMessage(path: string, error: unknown): string {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR') return `No browser at ${path}. ${passBrowser}`
  return `Cannot read ${path}: ${errorMessage(error)}`
}

async function folderMessage(path: string): Promise<string> {
  const binaries = join(path, 'Contents', 'MacOS')
  const entries = await readdir(binaries).catch(() => undefined)
  if (entries === undefined) return `${path} is a folder. ${passBrowser}`
  const [only] = entries
  if (entries.length === 1 && only !== undefined) {
    return `${path} is a macOS app bundle. Pass the executable inside it: ${join(binaries, only)}`
  }
  return `${path} is a macOS app bundle. Pass the executable inside its Contents/MacOS folder.`
}
