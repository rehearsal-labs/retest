import { Deadline } from '../protocol/deadline.ts'

/** Where titles are read from: the document the page holds now. */
export type TitleSource = {
  /** False while a read would not be answered in that document, as while the frame opens another one. */
  readonly readable: () => boolean
  /** Reads the current document's title as the page has it, or undefined when it has none. */
  readonly read: (deadline: Deadline) => Promise<string | undefined>
}

/** How long a new document's title waits for its DOMContentLoaded before it is read anyway. */
export const titleWaitMs = 1000

// A read that does not answer within this gives no title; the page may be busy, and the title can wait no longer.
const readBudgetMs = 1000

type Entry = {
  readonly generation: number
  readonly loaderId: string | undefined
  // Every navigation this entry answers: its own, and earlier ones of the same document it took over.
  readonly settles: ((title: string | undefined) => void)[]
  reading: Promise<void> | undefined
  settled: boolean
  timer: NodeJS.Timeout | undefined
}

/**
 * Settles the title of each navigation of the main frame, by the rule of fact F7: a new document's title is read
 * when its DOMContentLoaded fires, when the next command to the page begins, or one second after it committed,
 * whichever comes first. A navigation within the document is read at once. Each title settles once and never
 * rejects: with the title read, or with none when it has none or could not be read.
 *
 * A document can be replaced before any of these, as by a redirect that begins while it parses, which never fires
 * DOMContentLoaded; its title settles with none at the next commit. A read sent just before another navigation
 * begins is answered only after that navigation commits, and then by the new document, so an answer that arrives
 * after a later commit is not taken.
 */
export class NavigationTitles {
  readonly #source: TitleSource
  #generation = 0
  #entry: Entry | undefined

  constructor(source: TitleSource) {
    this.#source = source
  }

  /** A new document committed, with its loader. Returns its title, as it settles. */
  committed(loaderId: string): Promise<string | undefined> {
    this.#generation += 1
    this.#end()
    const { promise, entry } = this.#open(loaderId, [])
    entry.timer = setTimeout(() => void this.#settleNow(entry, new Deadline(readBudgetMs)), titleWaitMs)
    entry.timer.unref()
    return promise
  }

  /**
   * The page moved to a new path within its document. Its title is read at once, and settles any earlier
   * navigation of the same document still waiting, with the title the document had then.
   */
  movedWithinDocument(): Promise<string | undefined> {
    const earlier = this.#entry
    if (earlier !== undefined) clearTimeout(earlier.timer)
    const { promise, entry } = this.#open(undefined, earlier?.settles ?? [])
    void this.#settleNow(entry, new Deadline(readBudgetMs))
    return promise
  }

  /** The document of `loaderId` fired DOMContentLoaded. A title that cannot be read yet waits for the next chance. */
  contentLoaded(loaderId: string): void {
    const entry = this.#entry
    if (entry === undefined || entry.loaderId !== loaderId || entry.settled || entry.reading !== undefined) return
    void this.#startRead(entry, new Deadline(readBudgetMs), false)
  }

  /** Settles every title still waiting, within `deadline`, as the next command to the page begins. */
  async settle(deadline: Deadline): Promise<void> {
    const entry = this.#entry
    if (entry === undefined || entry.settled) return
    const budget = new Deadline(Math.min(readBudgetMs, deadline.remainingMs), { signal: deadline.signal })
    await this.#settleNow(entry, budget)
  }

  /** Settles every title still waiting with none, for a page that closed. */
  dispose(): void {
    this.#end()
    this.#entry = undefined
  }

  #open(loaderId: string | undefined, earlier: Entry['settles']): { promise: Promise<string | undefined>; entry: Entry } {
    const { promise, resolve } = Promise.withResolvers<string | undefined>()
    const entry: Entry = { generation: this.#generation, loaderId, settles: [...earlier, resolve], reading: undefined, settled: false, timer: undefined }
    this.#entry = entry
    return { promise, entry }
  }

  // The document the waiting titles belong to has gone: they settle with none.
  #end(): void {
    const entry = this.#entry
    if (entry !== undefined) this.#finish(entry, undefined)
  }

  async #settleNow(entry: Entry, deadline: Deadline): Promise<void> {
    if (!this.#source.readable()) {
      this.#finish(entry, undefined)
      return
    }
    await entry.reading
    if (!entry.settled) await this.#startRead(entry, deadline, true)
  }

  #startRead(entry: Entry, deadline: Deadline, final: boolean): Promise<void> {
    const reading: Promise<void> = this.#read(entry, deadline, final).finally(() => {
      if (entry.reading === reading) entry.reading = undefined
    })
    entry.reading = reading
    return reading
  }

  // Reads the current document's title for `entry`. A read that cannot be made or answered settles it with none only
  // when `final`; otherwise it waits for its next chance.
  async #read(entry: Entry, deadline: Deadline, final: boolean): Promise<void> {
    try {
      if (!this.#source.readable()) {
        if (final) this.#finish(entry, undefined)
        return
      }
      const title = await this.#source.read(deadline)
      if (entry.generation === this.#generation) this.#finish(entry, title)
    } catch {
      if (final) this.#finish(entry, undefined)
    }
  }

  #finish(entry: Entry, title: string | undefined): void {
    clearTimeout(entry.timer)
    if (entry.settled) return
    entry.settled = true
    for (const settle of entry.settles) settle(title)
  }
}
