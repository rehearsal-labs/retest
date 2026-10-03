import type { AriaRole } from '../protocol/aria-role.ts'
import type { LocatorPick, LocatorRecipe, TextMatch } from '../protocol/locator.ts'
import { ariaRoles } from '../protocol/aria-role.ts'
import { locatorSteps, selectorProblem, textPatternOf } from '../protocol/locator.ts'
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
 * The recipe `getByRole(role, options)` makes. `name` and `exact` are written only when given; a name may be a
 * `RegExp`, which takes no `exact`.
 *
 * @example roleRecipe('button', { name: 'Save' }) // { recipe: { by: 'role', role: 'button', name: 'Save' } }
 */
export function roleRecipe(role: unknown, options: unknown): BuiltRecipe {
  if (!isAriaRole(role)) return { problem: `getByRole() takes an ARIA role such as 'button', received ${formatValue(role)}.` }
  const read = readOptions('getByRole', options, ['name', 'exact'])
  if ('problem' in read) return read
  const name = read.name === undefined ? undefined : readName(read.name)
  if (name === null) return { problem: `getByRole() takes name as a string or a RegExp, received ${formatValue(read.name)}.` }
  const exactness = readExact('getByRole', read.exact, name)
  if ('problem' in exactness) return exactness
  return { recipe: { by: 'role', role, ...(name === undefined ? {} : { name }), ...exactness } }
}

/**
 * The recipe `getByLabel(text, options)`, `getByText(text, options)` or `getByPlaceholder(text, options)` makes. The
 * text must hold more than spaces, or be a `RegExp`, which takes no `exact`.
 *
 * @example textRecipe('text', 'Saved', { exact: false }) // { recipe: { by: 'text', text: 'Saved', exact: false } }
 */
export function textRecipe(by: 'label' | 'text' | 'placeholder', text: unknown, options: unknown): BuiltRecipe {
  const call = by === 'label' ? 'getByLabel' : by === 'text' ? 'getByText' : 'getByPlaceholder'
  const read = readText(text)
  if (read === null) return { problem: `${call}() takes the text to find, or a RegExp, received ${formatValue(text)}.` }
  const given = readOptions(call, options, ['exact'])
  if ('problem' in given) return given
  const exactness = readExact(call, given.exact, read)
  if ('problem' in exactness) return exactness
  return { recipe: { by, text: read, ...exactness } }
}

/**
 * The recipe `locator(selector)` makes: a CSS selector, refused when empty or written as XPath or with one of
 * Playwright's selector engines.
 *
 * @example cssRecipe('.task') // { recipe: { by: 'css', selector: '.task' } }
 */
export function cssRecipe(selector: unknown): BuiltRecipe {
  if (typeof selector !== 'string') return { problem: `locator() takes a CSS selector as a string, received ${formatValue(selector)}.` }
  const problem = selectorProblem(selector)
  return problem === undefined ? { recipe: { by: 'css', selector } } : { problem }
}

/**
 * A recipe scoped inside another: the outer recipe's steps, then the inner one's, which finds elements inside those
 * the outer one keeps.
 *
 * @example scopedRecipe({ by: 'testId', value: 'tasks' }, { by: 'role', role: 'listitem' }) // { by: 'role', role: 'listitem', within: [{ by: 'testId', value: 'tasks' }] }
 */
export function scopedRecipe(outer: LocatorRecipe, inner: LocatorRecipe): LocatorRecipe {
  const { within: _innerScope, dialect: _innerDialect, ...step } = inner
  return { ...step, within: locatorSteps(outer), ...(outer.dialect === undefined ? {} : { dialect: outer.dialect }) }
}

/**
 * The recipe `first()`, `last()` or `nth(index)` makes: the same steps, keeping one match of the last. A locator
 * chooses once; scope it with another step to choose again.
 *
 * @example pickedRecipe({ by: 'role', role: 'listitem' }, 'nth(index)', 2) // { recipe: { by: 'role', role: 'listitem', pick: 2 } }
 */
export function pickedRecipe(recipe: LocatorRecipe, call: 'first()' | 'last()' | 'nth(index)', index?: unknown): BuiltRecipe {
  const pick = call === 'first()' ? 'first' : call === 'last()' ? 'last' : readIndex(index)
  if (pick === undefined) return { problem: `nth() takes a whole number, counted from 0 and from the end when negative, received ${formatValue(index)}.` }
  if (recipe.pick !== undefined) return { problem: `${call.replace('(index)', '()')} chooses from a locator's matches, and this locator has chosen one already. Find inside it, or choose once.` }
  return { recipe: { ...recipe, pick } }
}

function readIndex(index: unknown): LocatorPick | undefined {
  return typeof index === 'number' && Number.isSafeInteger(index) ? index : undefined
}

function isAriaRole(value: unknown): value is AriaRole {
  return typeof value === 'string' && roles.has(value)
}

// Text with more than spaces, or a pattern; null for anything else.
function readText(text: unknown): TextMatch | null {
  if (text instanceof RegExp) return textPatternOf(text)
  return typeof text === 'string' && text.trim() !== '' ? text : null
}

function readName(name: unknown): TextMatch | null {
  if (name instanceof RegExp) return textPatternOf(name)
  return typeof name === 'string' ? name : null
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

function readExact(call: string, exact: unknown, text: TextMatch | undefined): Exactness | { readonly problem: string } {
  if (exact === undefined) return {}
  if (typeof exact !== 'boolean') return { problem: `${call}() takes exact as true or false, received ${formatValue(exact)}.` }
  if (text !== undefined && typeof text !== 'string') return { problem: `${call}() takes exact only with text. A RegExp says itself how it matches, so leave exact out.` }
  return { exact }
}

