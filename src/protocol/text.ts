/**
 * Reads text the way locators and `toHaveText` compare it: trims both ends and turns each run of whitespace,
 * line breaks included, into one space. Nothing else changes: case, punctuation and every other character count.
 *
 * @example normalizeText('  Release\n  checklist ') // 'Release checklist'
 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}
