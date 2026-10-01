import type { PageCommand } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import type { OptionChoiceRecord } from '../protocol/option-choices.ts'
import { failure } from '../protocol/failures.ts'
import { optionChoicesProblem } from '../protocol/option-choices.ts'
import { isArray, isPlainObject } from '../protocol/schema.ts'
import { scrollProblem } from '../protocol/scroll-delta.ts'
import { formatValue } from './format-value.ts'

// Each reader checks what a JavaScript caller passed, since types do not reach it, then applies the protocol's own
// rule, so the test process refuses with the message the parent would.

/** What a `select` command carries besides its locator: the options, and `multiple` when the test passed a list. */
export type SelectArgument = Pick<Extract<PageCommand, { kind: 'select' }>, 'choices' | 'multiple'>

/** What a `scroll` command carries besides its locator: both axes, 0 for one the test left out. */
export type ScrollArgument = Pick<Extract<PageCommand, { kind: 'scroll' }>, 'x' | 'y'>

type Refusal = { readonly ok: false; readonly failure: Failure }

export type ReadArgument<T> = { readonly ok: true; readonly value: T } | Refusal

/**
 * Reads what `select()` was given: a label, `{ value }`, or a non-empty list of them.
 *
 * @example readSelectArgument(['Red', { value: 'b' }]) // { ok: true, value: { choices: [{ label: 'Red' }, { value: 'b' }], multiple: true } }
 */
export function readSelectArgument(argument: unknown): ReadArgument<SelectArgument> {
  const refusal = (): Refusal =>
    usage(`select() takes an option's label, such as 'Canada', its value, such as { value: 'ca' }, or a list of these, received ${formatValue(argument)}.`)
  if (!isArray(argument)) {
    const choice = optionChoice(argument)
    return choice === undefined ? refusal() : { ok: true, value: { choices: [choice] } }
  }
  const choices: OptionChoiceRecord[] = []
  for (const item of argument) {
    const choice = optionChoice(item)
    if (choice === undefined) return refusal()
    choices.push(choice)
  }
  const problem = optionChoicesProblem(choices)
  return problem === undefined ? { ok: true, value: { choices, multiple: true } } : { ok: false, failure: problem }
}

/**
 * Reads what `scroll()` was given: `{ x, y }` in CSS pixels, either left out for 0, and not both 0.
 *
 * @example readScrollArgument({ y: 600 }) // { ok: true, value: { x: 0, y: 600 } }
 */
export function readScrollArgument(argument: unknown): ReadArgument<ScrollArgument> {
  const refusal = (): Refusal => usage(`scroll() takes x and y in CSS pixels, such as { y: 600 }, received ${formatValue(argument)}.`)
  if (!isPlainObject(argument) || Object.keys(argument).some((key) => key !== 'x' && key !== 'y')) return refusal()
  const { x = 0, y = 0 } = argument
  if (typeof x !== 'number' || typeof y !== 'number') return refusal()
  const problem = scrollProblem({ x, y })
  return problem === undefined ? { ok: true, value: { x, y } } : { ok: false, failure: problem }
}

function optionChoice(value: unknown): OptionChoiceRecord | undefined {
  if (typeof value === 'string') return { label: value }
  if (!isPlainObject(value) || Object.keys(value).length !== 1) return undefined
  const { value: optionValue } = value
  return typeof optionValue === 'string' ? { value: optionValue } : undefined
}

function usage(message: string): Refusal {
  return { ok: false, failure: failure('usage', message) }
}
