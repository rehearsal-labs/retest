import { relative, sep } from 'node:path'

/**
 * A path relative to `from`, with forward slashes on every platform. Test files, test ids and source
 * locations name files this way, in the parent and in the test file's process alike.
 *
 * @example relativePosixPath('/work', '/work/tests/tasks.retest.ts') // 'tests/tasks.retest.ts'
 */
export function relativePosixPath(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

/**
 * A path with forward slashes on every platform, as a record stores it, so a run on macOS and one on Windows read alike.
 *
 * @example posixPath('C:\\work\\.data\\desk') // 'C:/work/.data/desk' on Windows; a POSIX path is unchanged
 */
export function posixPath(path: string): string {
  return path.split(sep).join('/')
}

/**
 * A path a record stores, as this platform writes it, for a person.
 *
 * @example platformPath('C:/work/.data/desk') // 'C:\\work\\.data\\desk' on Windows; unchanged on macOS and Linux
 */
export function platformPath(path: string): string {
  return path.split('/').join(sep)
}
