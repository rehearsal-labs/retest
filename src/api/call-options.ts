import { maxTimeout } from '../protocol/timeouts.ts'
import { formatValue } from './format-value.ts'

/**
 * Options an action or `goto` takes. `timeout` is the most milliseconds the call may take. It can only shorten the
 * action or navigation budget the config and the command line set: a longer one is cut to that budget.
 */
export type CallOptions = { readonly timeout?: number | undefined }

export type ReadCallOptions = { readonly ok: true; readonly timeoutMs?: number } | { readonly ok: false; readonly problem: string }

/**
 * Reads the options a JavaScript caller may have passed to an action any way it liked, and says what is wrong. A
 * key set to undefined counts as absent, and so do no options at all.
 *
 * @example readCallOptions('click', { timeout: 2000 }) // { ok: true, timeoutMs: 2000 }
 */
export function readCallOptions(kind: string, options: unknown): ReadCallOptions {
  if (options === undefined) return { ok: true }
  const refusal = { ok: false, problem: `${kind}() takes options such as { timeout: 2000 }, in milliseconds, received ${formatValue(options)}.` } as const
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return refusal
  const given = Object.entries(options).filter(([, value]) => value !== undefined)
  const unknown = given.find(([key]) => key !== 'timeout')
  if (unknown !== undefined) return { ok: false, problem: `Unknown ${kind}() option ${JSON.stringify(unknown[0])}. Its only option is timeout.` }
  const [entry] = given
  if (entry === undefined) return { ok: true }
  const [, timeout] = entry
  if (typeof timeout === 'number' && Number.isInteger(timeout) && timeout >= 1 && timeout <= maxTimeout) return { ok: true, timeoutMs: timeout }
  return { ok: false, problem: `The timeout option of ${kind}() must be a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(timeout)}.` }
}
