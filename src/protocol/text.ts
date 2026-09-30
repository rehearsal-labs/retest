import { truncateText } from './failures.ts'

/**
 * Reads text the way locators and `toHaveText` compare it: trims both ends and turns each run of whitespace,
 * line breaks included, into one space. Nothing else changes: case, punctuation and every other character count.
 *
 * @example normalizeText('  Release\n  checklist ') // 'Release checklist'
 */
export function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/** How `toHaveText` compares, as `normalizeText` reads text, printed with every result so a reader never has to guess. */
export const textComparison = 'whole text, ends trimmed, each run of spaces or line breaks read as one space'

// Messages stay readable; the full values travel in the event, truncated only past the event limit.
const messageLimit = 200

/** Text in quotes for a message, cut short when long. */
export function quoteText(text: string): string {
  const { text: shown, truncated } = truncateText(text, messageLimit)
  return `${JSON.stringify(shown)}${truncated ? '…' : ''}`
}

/** Formatted text for a message, cut short when long. */
export function shorten(text: string): string {
  const { text: shown, truncated } = truncateText(text, messageLimit)
  return truncated ? `${shown}…` : shown
}
