import { randomInt } from 'node:crypto'

const attemptIdLength = 10

/**
 * A new attempt id: ten random lowercase letters and digits, safe as part of a file name.
 *
 * @example newAttemptId() // 'k3v9q0x2mb'
 */
export function newAttemptId(): string {
  return Array.from({ length: attemptIdLength }, () => randomInt(36).toString(36)).join('')
}
