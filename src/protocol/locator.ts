import { ariaRoles, type AriaRole } from './aria-role.ts'
import { s, type Schema } from './schema.ts'

/**
 * How to find an element again. `name` and `text` match with whitespace normalised: `exact`, the default,
 * is a case-sensitive match on the whole string, and `exact: false` a case-insensitive substring match.
 */
export type LocatorRecipe =
  | { by: 'testId'; value: string }
  | { by: 'role'; role: AriaRole; name?: string; exact?: boolean }
  | { by: 'label'; text: string; exact?: boolean }
  | { by: 'text'; text: string; exact?: boolean }

const exact = s.optional(s.boolean())

export const locatorRecipeSchema: Schema<LocatorRecipe> = s.discriminatedUnion('by', [
  s.object({ by: s.literal('testId'), value: s.string() }),
  s.object({ by: s.literal('role'), role: s.enum(ariaRoles), name: s.optional(s.string()), exact }),
  s.object({ by: s.literal('label'), text: s.string(), exact }),
  s.object({ by: s.literal('text'), text: s.string(), exact }),
])

/**
 * Writes a recipe as the call that makes it. `exact` is written only when it is false, since true is the default.
 *
 * @example describeLocator({ by: 'role', role: 'button', name: 'Save' }) // "getByRole('button', { name: 'Save' })"
 */
export function describeLocator(recipe: LocatorRecipe): string {
  switch (recipe.by) {
    case 'testId':
      return `getByTestId(${quote(recipe.value)})`
    case 'role':
      return `getByRole(${quote(recipe.role)}${describeOptions(recipe.name, recipe.exact)})`
    case 'label':
      return `getByLabel(${quote(recipe.text)}${describeOptions(undefined, recipe.exact)})`
    case 'text':
      return `getByText(${quote(recipe.text)}${describeOptions(undefined, recipe.exact)})`
  }
}

function describeOptions(name: string | undefined, exact: boolean | undefined): string {
  const options = [
    ...(name === undefined ? [] : [`name: ${quote(name)}`]),
    ...(exact === false ? ['exact: false'] : []),
  ]
  return options.length === 0 ? '' : `, { ${options.join(', ')} }`
}

const requote: Record<string, string> = { '\\"': '"', "'": "\\'", '\u2028': '\\u2028', '\u2029': '\\u2029' }

// JSON escapes what a JavaScript string needs, except the quote swap and two characters that end a line.
function quote(text: string): string {
  const escaped = JSON.stringify(text)
    .slice(1, -1)
    .replace(/\\"|['\u2028\u2029]/g, (match) => requote[match] ?? match)
  return `'${escaped}'`
}
