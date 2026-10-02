import type { PageFacts } from '../protocol/page-facts.ts'
import { s, type Schema } from '../protocol/schema.ts'
import { originAndPath } from './page-url.ts'

/** A page's address and title as the page itself has them, read in Retest's world. Both are page text. */
export type DocumentFacts = { href: string; title: string }

export const documentFactsSchema: Schema<DocumentFacts> = s.object({ href: s.string(), title: s.string() })

/**
 * The page facts a result carries to the parent: the address as its origin and path, and the title as the page has
 * it, absent when it is empty. The parent redacts the title before it cleans and cuts it, so nothing is taken from
 * it here.
 *
 * @example pageFactsOf({ href: 'https://app.test/done?order=7', title: ' Done ' }) // { url: 'https://app.test/done', title: ' Done ' }
 */
export function pageFactsOf({ href, title }: DocumentFacts): PageFacts {
  const url = URL.parse(href)
  if (url === null) throw new Error("Retest's page script read an address that is not a URL")
  const shown = pageTitleOf(title)
  return shown === undefined ? { url: originAndPath(url) } : { url: originAndPath(url), title: shown }
}

/**
 * A title as the browser hands it to the parent: as the page has it, or none when it is empty.
 *
 * @example pageTitleOf('') // undefined
 */
export function pageTitleOf(title: string): string | undefined {
  return title === '' ? undefined : title
}
