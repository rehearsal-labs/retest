import { s, type Schema } from './schema.ts'

/** How to find an element again. Milestone 1 has one kind: an exact `data-testid` value. */
export type LocatorRecipe = { by: 'testId'; value: string }

export const locatorRecipeSchema: Schema<LocatorRecipe> = s.discriminatedUnion('by', [
  s.object({ by: s.literal('testId'), value: s.string() }),
])

/**
 * Writes a recipe as the call that makes it.
 *
 * @example describeLocator({ by: 'testId', value: 'save-task' }) // "getByTestId('save-task')"
 */
export function describeLocator(recipe: LocatorRecipe): string {
  return `getByTestId(${quote(recipe.value)})`
}

const requote: Record<string, string> = { '\\"': '"', "'": "\\'", '\u2028': '\\u2028', '\u2029': '\\u2029' }

// JSON escapes what a JavaScript string needs, except the quote swap and two characters that end a line.
function quote(text: string): string {
  const escaped = JSON.stringify(text)
    .slice(1, -1)
    .replace(/\\"|['\u2028\u2029]/g, (match) => requote[match] ?? match)
  return `'${escaped}'`
}
