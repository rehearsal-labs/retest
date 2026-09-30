/**
 * The code of a Node system error, such as `ENOENT`, or undefined for anything else.
 *
 * @example errorCode(new Error('gone')) // undefined
 */
export function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}
