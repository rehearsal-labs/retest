import type { TextMatch } from '../protocol/locator.ts'
import { patternMatches } from '../protocol/locator.ts'
import { normalizeText } from '../protocol/text.ts'

/**
 * Whether text matches what a locator asks for. Both sides are trimmed, with each run of whitespace read as one
 * space. `exact` compares the whole text, case-sensitively; otherwise `wanted` need only appear in it, in any case.
 * A pattern is searched for in the trimmed text with its own flags, and `exact` does not apply to it. The page
 * scripts apply the same rule to text, and a unit test holds the two together.
 *
 * @example matchesText('  Save\n draft ', 'save', false) // true
 * @example matchesText('Save draft', { pattern: '^save', flags: 'i' }, true) // true
 */
export function matchesText(actual: string, wanted: TextMatch, exact: boolean): boolean {
  const text = normalizeText(actual)
  if (typeof wanted !== 'string') return patternMatches(text, wanted)
  const target = normalizeText(wanted)
  return exact ? text === target : text.toLowerCase().includes(target.toLowerCase())
}
