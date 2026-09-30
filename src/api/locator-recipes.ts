import type { AriaRole } from '../protocol/aria-role.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { ariaRoles } from '../protocol/aria-role.ts'
import { formatValue } from './format-value.ts'

// Each builder checks what a JavaScript caller passed, since types do not reach it, and says what is wrong.

export type BuiltRecipe = { readonly recipe: LocatorRecipe } | { readonly problem: string }

type Exactness = { readonly exact?: boolean }

const roles: ReadonlySet<string> = new Set(ariaRoles)

/**
 * The recipe `getByTestId(id)` makes.
 *
 * @example testIdRecipe('save-task') // { recipe: { by: 'testId', value: 'save-task' } }
 */
export function testIdRecipe(id: unknown): BuiltRecipe {
  if (typeof id !== 'string') return { problem: `getByTestId() takes a string, received ${formatValue(id)}.` }
  return { recipe: { by: 'testId', value: id } }
}

/**
 * The recipe `getByRole(role, options)` makes. `name` and `exact` are written only when given.
 *
 * @example roleRecipe('button', { name: 'Save' }) // { recipe: { by: 'role', role: 'button', name: 'Save' } }
 */
export function roleRecipe(role: unknown, options: unknown): BuiltRecipe {
  if (!isAriaRole(role)) return { problem: `getByRole() takes an ARIA role such as 'button', received ${formatValue(role)}.` }
  const read = readOptions('getByRole', options, ['name', 'exact'])
  if ('problem' in read) return read
  const { name } = read
  if (name !== undefined && typeof name !== 'string') return { problem: `getByRole() takes name as a string, received ${formatValue(name)}.` }
  const exactness = readExact('getByRole', read.exact)
  if ('problem' in exactness) return exactness
  return { recipe: { by: 'role', role, ...(name === undefined ? {} : { name }), ...exactness } }
}

/**
 * The recipe `getByLabel(text, options)` or `getByText(text, options)` makes. The text must hold more than spaces.
 *
 * @example textRecipe('text', 'Saved', { exact: false }) // { recipe: { by: 'text', text: 'Saved', exact: false } }
 */
export function textRecipe(by: 'label' | 'text', text: unknown, options: unknown): BuiltRecipe {
  const call = by === 'label' ? 'getByLabel' : 'getByText'
  if (typeof text !== 'string' || text.trim() === '') return { problem: `${call}() takes the text to find, received ${formatValue(text)}.` }
  const read = readOptions(call, options, ['exact'])
  if ('problem' in read) return read
  const exactness = readExact(call, read.exact)
  if ('problem' in exactness) return exactness
  return { recipe: { by, text, ...exactness } }
}

function isAriaRole(value: unknown): value is AriaRole {
  return typeof value === 'string' && roles.has(value)
}

type ReadOptions = { readonly name?: unknown; readonly exact?: unknown } | { readonly problem: string }

function readOptions(call: string, options: unknown, allowed: readonly string[]): ReadOptions {
  if (options === undefined) return {}
  const problem = { problem: `${call}() options take ${allowed.join(' and ')}, received ${formatValue(options)}.` }
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return problem
  if (Object.keys(options).some((key) => !allowed.includes(key))) return problem
  return {
    ...('name' in options ? { name: options.name } : {}),
    ...('exact' in options ? { exact: options.exact } : {}),
  }
}

function readExact(call: string, exact: unknown): Exactness | { readonly problem: string } {
  if (exact === undefined) return {}
  if (typeof exact !== 'boolean') return { problem: `${call}() takes exact as true or false, received ${formatValue(exact)}.` }
  return { exact }
}
