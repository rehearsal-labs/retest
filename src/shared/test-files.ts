import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { relativePosixPath } from './posix-path.ts'

export const testFileSuffix = '.retest.ts'

/** The endings a Playwright test file has, as Playwright's own default matches them. */
export const playwrightFileSuffixes: readonly string[] = ['.spec.ts', '.spec.js', '.spec.mts', '.spec.mjs', '.test.ts', '.test.js', '.test.mts', '.test.mjs']

/** The Playwright endings a run takes when no file is named: `.test.` files are left out, since a project's unit tests end the same way. */
export const playwrightSpecSuffixes: readonly string[] = playwrightFileSuffixes.filter((suffix) => suffix.startsWith('.spec.'))

const skippedFolders = new Set(['node_modules'])

/**
 * Every test file under `root`, as POSIX paths relative to it, in order: every file whose name ends in one of
 * `suffixes`, Retest's own by default. Folders whose names start with a dot and `node_modules` are skipped, and
 * links are not followed.
 *
 * @example findTestFiles('/work') // ['tests/example.retest.ts']
 */
export function findTestFiles(root: string, suffixes: readonly string[] = [testFileSuffix]): string[] {
  const found: string[] = []
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && !skippedFolders.has(entry.name)) walk(path)
      else if (entry.isFile() && suffixes.some((suffix) => entry.name.endsWith(suffix))) found.push(relativePosixPath(root, path))
    }
  }
  walk(root)
  return found.sort()
}
