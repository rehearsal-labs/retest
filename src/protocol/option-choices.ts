import type { Failure } from './failures.ts'
import { stringLiteral } from './locator.ts'
import { s, type Schema } from './schema.ts'
import { shorten } from './text.ts'

/**
 * An option a `select` names: by its label, as a person reads it, or by its `value` attribute. A label matches
 * the option's `label` property with whitespace normalised, whole and case-sensitive; a value matches exactly.
 */
export type OptionChoiceRecord = { label: string } | { value: string }

export const optionChoiceRecordSchema: Schema<OptionChoiceRecord> = s.union([s.object({ label: s.string() }), s.object({ value: s.string() })])

/**
 * Names one option as a test writes it: a label as a string, a value as `{ value }`. Long text is cut short, as
 * messages cut any text.
 *
 * @example describeOptionChoice({ value: 'ca' }) // "{ value: 'ca' }"
 */
export function describeOptionChoice(choice: OptionChoiceRecord): string {
  return 'label' in choice ? stringLiteral(shorten(choice.label)) : `{ value: ${stringLiteral(shorten(choice.value))} }`
}

/**
 * Names what a `select` was given, as a test writes it: one option on its own, and any other number as a list.
 *
 * @example describeOptionChoices([{ label: 'Red' }, { value: 'b' }]) // "['Red', { value: 'b' }]"
 */
export function describeOptionChoices(choices: readonly OptionChoiceRecord[]): string {
  const [only] = choices
  if (choices.length === 1 && only !== undefined) return describeOptionChoice(only)
  return `[${choices.map(describeOptionChoice).join(', ')}]`
}

/**
 * What the test process and the parent both refuse, as `usage`, in the options a `select` names: none at all.
 * Whether the element takes several is for the page to tell.
 *
 * @example optionChoicesProblem([]) // { class: 'usage', message: 'select() needs at least one option, received an empty list.' }
 */
export function optionChoicesProblem(choices: readonly OptionChoiceRecord[]): Failure | undefined {
  if (choices.length > 0) return undefined
  return { class: 'usage', message: 'select() needs at least one option, received an empty list.' }
}

/** The part of a `select` command the parent checks: its options, and whether the test passed them as a list. */
type SelectChoices = { readonly choices: readonly OptionChoiceRecord[]; readonly multiple?: true | undefined }

/**
 * What the parent refuses, as `usage`, in a `select` command before it reaches the page: what
 * `optionChoicesProblem` refuses, and more than one option that the test did not pass as a list. The test's own
 * API never sends the second; only a process that speaks the protocol itself can.
 *
 * @example selectCommandProblem({ choices: [{ label: 'Red' }, { label: 'Blue' }] }) // { class: 'usage', message: 'select() received 2 options that were not a list. Several options need a list.' }
 */
export function selectCommandProblem(command: SelectChoices): Failure | undefined {
  const { choices, multiple } = command
  const problem = optionChoicesProblem(choices)
  if (problem !== undefined || multiple === true || choices.length === 1) return problem
  return { class: 'usage', message: `select() received ${choices.length} options that were not a list. Several options need a list.` }
}
