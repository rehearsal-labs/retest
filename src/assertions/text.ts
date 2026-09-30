/** How `toHaveText` compares, printed with every result so a reader never has to guess. */
export const textComparison = 'whole text, ends trimmed, each run of spaces or line breaks read as one space'

/**
 * Reads text the way `toHaveText` compares it: trims both ends and turns each run of whitespace, line
 * breaks included, into one space. Nothing else changes: case, punctuation and every other character count.
 *
 * @example normalizeText('  Release\n  checklist ') // 'Release checklist'
 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}
