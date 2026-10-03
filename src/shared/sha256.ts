import { createHash } from 'node:crypto'

/**
 * The SHA-256 of text as UTF-8, or of bytes, in lowercase hex.
 *
 * @example sha256Hex('') // 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
 */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
