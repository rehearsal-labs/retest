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
