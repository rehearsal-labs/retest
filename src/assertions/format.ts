import { truncateText } from '../protocol/failures.ts'

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
