import type { PageNavigation } from '../browser/contract.ts'
import type { NavigationCause } from '../protocol/page-facts.ts'
import { bounded } from './bounded.ts'

/** A document an app's page committed: its origin and path, and its title once its navigation is written. */
export type PageDocument = { readonly url: string; title?: string }

/** A navigation ready to write: its app, its document, the step the test was in when it committed, and its cause. */
export type NotedNavigation = { app: string; document: PageDocument; stepId: string | undefined; cause: NavigationCause }

type Entry = NotedNavigation & { written: boolean }

/**
 * The browser settles a title within a second of its commit. One it has not settled in twice that is written as
 * none, so a browser that never settles one holds nothing up.
 */
const titleWaitMs = 2000

/**
 * The navigations of one test's pages. Each is noted at its commit, with the step the test was in then, and
 * written once its title settles, in the order its page committed them. A navigation still waiting when the test
 * ends is written then, with no title.
 */
export class PageNavigations {
  readonly #write: (navigation: NotedNavigation) => void
  /** Per app, settles once every navigation noted so far is written. */
  readonly #written = new Map<string, Promise<void>>()
  /** Every navigation noted and not yet written, in the order they committed. */
  readonly #waiting = new Set<Entry>()

  constructor(write: (navigation: NotedNavigation) => void) {
    this.#write = write
  }

  /** Notes a navigation as its page commits it, and returns its document, whose title comes once it is written. */
  note(app: string, navigation: PageNavigation, stepId: string | undefined): PageDocument {
    const entry: Entry = { app, document: { url: navigation.url }, stepId, cause: navigation.cause, written: false }
    this.#waiting.add(entry)
    const title = bounded(navigation.title, titleWaitMs).then((read) => (read.status === 'done' ? read.value : undefined))
    const earlier = this.#written.get(app) ?? Promise.resolve()
    this.#written.set(
      app,
      Promise.all([earlier, title]).then(([, settled]) => this.#settle(entry, settled)),
    )
    return entry.document
  }

  /** Settles once every navigation of `app` noted so far is written, or undefined when none is waiting. */
  waiting(app: string): Promise<void> | undefined {
    for (const entry of this.#waiting) if (entry.app === app) return this.#written.get(app)
    return undefined
  }

  /** Waits up to `timeoutMs` for the titles still to come, then writes every navigation still waiting, with none. */
  async flush(timeoutMs: number): Promise<void> {
    if (this.#waiting.size > 0) await bounded(Promise.all(this.#written.values()), timeoutMs)
    this.writeWaiting()
  }

  /** Writes every navigation still waiting at once, in order, each without the title it has not settled. */
  writeWaiting(): void {
    for (const entry of this.#waiting) this.#settle(entry, undefined)
  }

  #settle(entry: Entry, title: string | undefined): void {
    if (entry.written) return
    entry.written = true
    this.#waiting.delete(entry)
    if (title !== undefined) entry.document.title = title
    const { app, document, stepId, cause } = entry
    this.#write({ app, document, stepId, cause })
  }
}
