/**
 * The code of a Node system error, such as `ENOENT`, or undefined for anything else.
 *
 * @example errorCode(new Error('gone')) // undefined
 */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/**
 * Whether a file system error says nothing is at the path: no such entry, or a part of the path that is not a
 * folder.
 *
 * @example isMissingFile(Object.assign(new Error('gone'), { code: 'ENOENT' })) // true
 */
export function isMissingFile(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}
