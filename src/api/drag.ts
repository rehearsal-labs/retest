import type { CallOptions } from './call-options.ts'
import { dragProblem } from '../protocol/drag.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { formatValue } from './format-value.ts'

/**
 * Options a drag takes: `steps`, how many positions the mouse moves through on its way to the target, 5 when absent and
 * at most 100, and the `timeout` every action takes.
 */
export type DragOptions = CallOptions & { readonly steps?: number | undefined }

/**
 * A drag's options as the command takes them: its steps when given, and the timeout as the caller passed it, which the
 * action reads as every action reads its own.
 */
export type ReadDragOptions = { readonly ok: true; readonly steps: { steps?: number }; readonly call: { readonly timeout: unknown } | undefined } | { readonly ok: false; readonly problem: string }

/**
 * Reads the options a JavaScript caller may have passed `dragTo` any way it liked, and says what is wrong as a sentence.
 * `timeout` is left for the action to read, as every action reads its own.
 *
 * @example readDragOptions({ steps: 10, timeout: 2000 }) // { ok: true, steps: { steps: 10 }, call: { timeout: 2000 } }
 */
export function readDragOptions(options: unknown): ReadDragOptions {
  if (options === undefined) return { ok: true, steps: {}, call: undefined }
  if (!isPlainObject(options)) return { ok: false, problem: `dragTo() takes options such as { steps: 10, timeout: 2000 }, received ${formatValue(options)}.` }
  const given = Object.entries(options).filter(([, value]) => value !== undefined)
  const unknown = given.find(([key]) => key !== 'steps' && key !== 'timeout')
  if (unknown !== undefined) return { ok: false, problem: `Unknown dragTo() option ${JSON.stringify(unknown[0])}. Its options are steps and timeout.` }
  const { steps, timeout } = Object.fromEntries(given)
  if (steps !== undefined && typeof steps !== 'number') return { ok: false, problem: `dragTo() takes steps as a whole number from 1 to 100, received ${formatValue(steps)}.` }
  const problem = dragProblem({ steps })
  if (problem !== undefined) return { ok: false, problem: problem.message }
  return { ok: true, steps: steps === undefined ? {} : { steps }, call: timeout === undefined ? undefined : { timeout } }
}
