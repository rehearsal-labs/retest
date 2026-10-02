import { truncateText } from './failures.ts'
import { s, type Schema } from './schema.ts'

/**
 * The page a command went to, as the browser read it in the same call that checked or read the element: the
 * main frame's origin and path, and its title when it has one. Titles are page text. The browser hands a title over
 * as the page has it; the parent redacts, cleans and cuts it before it records it or tells the test process.
 */
export type PageFacts = { url: string; title?: string }

/**
 * What started a navigation of the main frame: the test's `goto`, the page while the input of one of the test's
 * actions was being delivered, or anything else, such as a redirect the page makes on its own, a timer or the
 * browser.
 */
export type NavigationCause = 'goto' | 'action' | 'page'

/**
 * What a navigation of the main frame did to its document: `new` when the frame committed a document, `same` when
 * the page moved to a new path within the document it held, through the history API.
 */
export type NavigationDocument = 'new' | 'same'

/** How many UTF-16 code units of a page's title Retest records. */
export const pageTitleLimit = 300

/**
 * How many code units of `document.title` the page hands over at most, so that no page can send a title of any
 * size. The parent redacts a title before it cleans and cuts it, and drops the start of a value at the end of a
 * title this long, since the page may have cut it there.
 */
export const titleReadLimit = 65_536

export const navigationCauseSchema: Schema<NavigationCause> = s.enum(['goto', 'action', 'page'])

export const navigationDocumentSchema: Schema<NavigationDocument> = s.enum(['new', 'same'])

export const pageFactsSchema: Schema<PageFacts> = s.object({ url: s.string(), title: s.optional(s.string()) })

const controlCharacters = /\p{Cc}/gu

/**
 * A page's title with every control character removed and trimmed, or none when that leaves nothing. The parent
 * cleans a title only once it has redacted it, so nothing cleaning removes can keep a value from being found.
 *
 * @example cleanTitle('  Checkout\u001b[2J ') // 'Checkout[2J'
 */
export function cleanTitle(title: string): string | undefined {
  const cleaned = title.replace(controlCharacters, '').trim()
  return cleaned === '' ? undefined : cleaned
}

/**
 * A title as Retest records it, once the parent has redacted and cleaned it: cut to `pageTitleLimit` code units,
 * never inside a surrogate pair, and never ending on a space.
 *
 * @example recordedTitle(`${'x'.repeat(299)} yz`) // 'x'.repeat(299)
 */
export function recordedTitle(title: string): string {
  return truncateText(title, pageTitleLimit).text.trimEnd()
}
