import type { PageFacts } from '../protocol/page-facts.ts'
import { readPageTitle } from '../protocol/page-facts.ts'
import { s, type Schema } from '../protocol/schema.ts'
import { originAndPath } from './page-url.ts'

/** A page's address and title as the page itself has them, read in Retest's world. Both are page text. */
export type DocumentFacts = { href: string; title: string }

export const documentFactsSchema: Schema<DocumentFacts> = s.object({ href: s.string(), title: s.string() })

/**
 * The page facts a result carries to the parent: the address as its origin and path, and the title as
 * `readPageTitle` cleans it, absent when it leaves nothing. The parent redacts the title before it cuts it short.
 *
 * @example pageFactsOf({ href: 'https://app.test/done?order=7', title: ' Done ' }) // { url: 'https://app.test/done', title: 'Done' }
 */
export function pageFactsOf({ href, title }: DocumentFacts): PageFacts {
  const url = URL.parse(href)
  if (url === null) throw new Error("Retest's page script read an address that is not a URL")
  const cleaned = readPageTitle(title)
  return cleaned === undefined ? { url: originAndPath(url) } : { url: originAndPath(url), title: cleaned }
}
