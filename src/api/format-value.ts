import { inspect } from 'node:util'

/**
 * A value as Retest's messages show it, on one line.
 *
 * @example formatValue({ a: [1, 2] }) // '{ a: [ 1, 2 ] }'
 */
export function formatValue(value: unknown): string {
  return inspect(value, { depth: 4, breakLength: Number.POSITIVE_INFINITY })
}

