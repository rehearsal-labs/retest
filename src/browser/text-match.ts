import { normalizeText } from '../protocol/text.ts'

/**
 * Whether text matches what a locator asks for. Both sides are trimmed, with each run of whitespace read as one
 * space. `exact` compares the whole text, case-sensitively; otherwise `wanted` need only appear in it, in any case.
 * The page scripts apply the same rule to text, and a unit test holds the two together.
 *
 * @example matchesText('  Save\n draft ', 'save', false) // true
 */
export function matchesText(actual: string, wanted: string, exact: boolean): boolean {
  const text = normalizeText(actual)
  const target = normalizeText(wanted)
  return exact ? text === target : text.toLowerCase().includes(target.toLowerCase())
}
