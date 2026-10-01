import { truncateText } from './failures.ts'
import { s, type Schema } from './schema.ts'

/**
 * The page a command went to, as the browser read it in the same call that checked or read the element: the
 * main frame's origin and path, and its title when it has one. Titles are page text.
 */
export type PageFacts = { url: string; title?: string }

/**
 * What started a navigation of the main frame: the test's `goto`, the page while the input of one of the test's
 * actions was being delivered, or anything else, such as a redirect the page makes on its own, a timer or the
 * browser.
 */
export type NavigationCause = 'goto' | 'action' | 'page'

/** How many UTF-16 code units of a page's title Retest records. */
export const pageTitleLimit = 300

/**
 * How many code units of a page's title the browser hands the parent. The parent cuts a title to `pageTitleLimit`
 * only after it has redacted it, so a secret that runs past the cut is hidden whole.
 */
export const readTitleLimit = 4096

export const navigationCauseSchema: Schema<NavigationCause> = s.enum(['goto', 'action', 'page'])

export const pageFactsSchema: Schema<PageFacts> = s.object({ url: s.string(), title: s.optional(s.string()) })

const controlCharacters = /\p{Cc}/gu

/**
 * A page's title as the browser hands it to the parent: `document.title` with every control character removed,
 * trimmed, and cut to `readTitleLimit` code units, never inside a surrogate pair. A title that leaves nothing is none.
 *
 * @example readPageTitle('  Checkout\u001b[2J ') // 'Checkout[2J'
 */
export function readPageTitle(title: string): string | undefined {
  const cleaned = title.replace(controlCharacters, '').trim()
  return cleaned === '' ? undefined : cutTitle(cleaned, readTitleLimit)
}

/**
 * A title as Retest records it, once the parent has redacted it: cut to `pageTitleLimit` code units, never inside
 * a surrogate pair, and never ending on a space.
 *
 * @example recordedTitle(`${'x'.repeat(299)} yz`) // 'x'.repeat(299)
 */
export function recordedTitle(title: string): string {
  return cutTitle(title, pageTitleLimit)
}

function cutTitle(title: string, limit: number): string {
  return truncateText(title, limit).text.trimEnd()
}
