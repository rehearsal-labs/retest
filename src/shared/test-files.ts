import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { relativePosixPath } from './posix-path.ts'

export const testFileSuffix = '.retest.ts'

const skippedFolders = new Set(['node_modules'])

/**
 * Every test file under `root`, as POSIX paths relative to it, in order. Folders whose names start with a dot
 * and `node_modules` are skipped, and links are not followed.
 *
 * @example findTestFiles('/work') // ['tests/example.retest.ts']
 */
export function findTestFiles(root: string): string[] {
  const found: string[] = []
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory() && !entry.name.startsWith('.') && !skippedFolders.has(entry.name)) walk(path)
      else if (entry.isFile() && entry.name.endsWith(testFileSuffix)) found.push(relativePosixPath(root, path))
    }
  }
  walk(root)
  return found.sort()
}
