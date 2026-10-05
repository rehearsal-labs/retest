import type { Observation } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { isDeepStrictEqual } from 'node:util'
import { failure } from '../protocol/failures.ts'
import { describeLocator } from '../protocol/locator.ts'
import { formatObservationId } from '../protocol/observation-record.ts'
import { describeValue, isPlainObject } from '../protocol/schema.ts'

// An agent's looks and the element references they hand out. A look is one read of a locator's matches in one session.
// Each match it lists gets a reference that names the session, the look and the match's place in the list. A reference
// is ephemeral: it is good only in the session that served its look, only while that look is kept, only on the document
// the look read, and only while the page still lists, at its place, the element the look saw there (see `identity.ts`
// for how that is known). A test keeps none of them: a saved test keeps a recipe, which a reference becomes only when a
// read proves the recipe finds its element (see `recipes.ts`).

/**
 * An element a look listed: the session that served the look, the look's id, and the element's place in the look's
 * list, from 0. It names that element only while the look is current; once it is not, using it is refused and sends
 * nothing.
 *
 * @example const ref: ElementRef = { sessionId: 'k3v9q0x2mb:owner', observationId: 'o3', element: 1 }
 */
export type ElementRef = { readonly sessionId: string; readonly observationId: string; readonly element: number }

/**
 * Why a reference was refused: another session's, a look never served, one no longer kept, another document, a list
 * that changed or is shorter, or, on a driver that cannot hold an element, one of several elements or a place.
 */
export type RefRefusal = 'other-session' | 'unknown-look' | 'expired' | 'new-document' | 'changed' | 'no-element' | 'malformed' | 'unpinned'

/**
 * A look a session served: its id, the document it read (counted from 0 as the session's page opens new ones), the
 * locator it read and the observation exactly as the page answered it, unredacted, which never leaves the session.
 * `keys` are the driver's keys of the elements it lists, in the same order, on a driver that gives them.
 */
export type ServedLook = {
  readonly observationId: string
  readonly generation: number
  readonly locator: LocatorRecipe
  readonly observation: Observation
  readonly keys?: readonly string[]
}

/** A reference resolved against its look: the look, and the element's place in its list. */
export type ResolvedRef = { readonly ok: true; readonly look: ServedLook; readonly element: number } | { readonly ok: false; readonly failure: Failure }

/** How many looks a session keeps before the oldest expires with its references. */
export const keptLooks = 32

/** A generation no document has: a look taken while its page opened another document was stale as it was served. */
const bornStale = -1

/**
 * The looks one session served, and the document its page is on. Ids count from `o1` within the session, as a test
 * attempt counts its looks, and never repeat in it. The session keeps its last `keptLooks` looks; an older one expires
 * with every reference it handed out.
 */
export class SessionLooks {
  readonly sessionId: string
  readonly #limit: number
  // Looks at a locator, and the ids of looks at the page itself, which list nothing, in the order they were served.
  readonly #kept = new Map<string, ServedLook | 'page'>()
  #served = 0
  #generation = 0

  constructor(sessionId: string, limit: number = keptLooks) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`A session keeps at least one look, received ${limit}.`)
    this.sessionId = sessionId
    this.#limit = limit
  }

  /** The document the page is on, counted from 0. */
  get generation(): number {
    return this.#generation
  }

  /** The page committed another document: every look taken on an earlier one is stale from now on. */
  nextDocument(): void {
    this.#generation += 1
  }

  /**
   * Keeps a look the session is about to answer with, and gives it the session's next id. `startedOn` is the document
   * the page was on when the look was sent: a look that saw the page open another document meanwhile is kept as stale,
   * so none of its references can be used. `keys` are the driver's keys of the elements the observation lists.
   */
  serve(locator: LocatorRecipe, observation: Observation, startedOn: number, keys?: readonly string[]): ServedLook {
    this.#served += 1
    const observationId = formatObservationId(this.#served)
    const generation = startedOn === this.#generation ? startedOn : bornStale
    const look: ServedLook = { observationId, generation, locator, observation, ...(keys === undefined ? {} : { keys: [...keys] }) }
    this.#keep(observationId, look)
    return look
  }

  /** Gives a look at the page itself its id: it lists no element, so it hands out no reference. */
  servePage(): string {
    this.#served += 1
    const observationId = formatObservationId(this.#served)
    this.#keep(observationId, 'page')
    return observationId
  }

  /**
   * Resolves a reference against the look it names, before the page is asked anything: it must be this session's, of
   * a look this session served and still keeps, taken on the document the page is on, and name a place the look's list
   * has. Whether the page still lists the look's element at its place is the caller's to read.
   *
   * @example looks.resolve({ sessionId: looks.sessionId, observationId: 'o1', element: 0 }).ok // true while o1 is current
   */
  resolve(ref: unknown): ResolvedRef {
    if (!isElementRef(ref)) return refused('malformed', `An element reference is { sessionId, observationId, element }, received ${describeValue(ref)}.`)
    const named = describeElementRef(ref)
    if (ref.sessionId !== this.sessionId) {
      return refused('other-session', `${named} belongs to the session ${JSON.stringify(ref.sessionId)}, not to ${JSON.stringify(this.sessionId)}. A reference is good only in the session whose look served it.`, ref)
    }
    const look = this.#kept.get(ref.observationId)
    if (look === 'page') return refused('unknown-look', `${named} names ${ref.observationId}, a look at the page itself, which lists no element.`, ref)
    if (look === undefined) {
      const served = /^o([1-9]\d*)$/.exec(ref.observationId)
      const number = served?.[1] === undefined ? undefined : Number(served[1])
      if (number !== undefined && number <= this.#served) return refused('expired', `${named} names ${ref.observationId}, which has expired: a session keeps its last ${this.#limit} looks. Look again.`, ref)
      return refused('unknown-look', `${named} names ${ref.observationId}, which this session never served.`, ref)
    }
    if (look.generation !== this.#generation) {
      const when = look.generation === bornStale ? 'while it was taken' : 'since it was taken'
      return refused('new-document', `${named} is stale: the page opened another document ${when}, so ${ref.observationId} no longer names what is on it. Look again.`, ref)
    }
    if (ref.element >= look.observation.items.length) {
      const listed = look.observation.items.length
      return refused('no-element', `${named} names element ${ref.element}, and ${ref.observationId} listed ${listed} ${listed === 1 ? 'element' : 'elements'} of ${describeLocator(look.locator)}, counted from 0.`, ref)
    }
    return { ok: true, look, element: ref.element }
  }

  #keep(observationId: string, look: ServedLook | 'page'): void {
    this.#kept.set(observationId, look)
    for (const oldest of this.#kept.keys()) {
      if (this.#kept.size <= this.#limit) break
      this.#kept.delete(oldest)
    }
  }
}

/**
 * Whether a fresh read of a look's locator still shows what the look saw: as many matches, listed with the same text
 * and visibility in the same order. A field's value and an element's state may change without changing which element
 * it is, so they are not compared.
 *
 * @example sameMatches(look.observation, fresh) // false once an element is added, removed or reworded
 */
export function sameMatches(seen: Observation, now: Observation): boolean {
  return seen.count === now.count && seen.itemsTruncated === now.itemsTruncated && isDeepStrictEqual(listed(seen), listed(now))
}

/**
 * How a fresh read differs from what a look saw, in words a refusal can show; the page text in it is the caller's to
 * redact.
 *
 * @example changedMatches(look, fresh) // 'it saw 3 matches and the page now has 2'
 */
export function changedMatches(seen: Observation, now: Observation): string {
  if (seen.count !== now.count) return `it saw ${matches(seen.count)} and the page now has ${now.count}`
  const index = seen.items.findIndex((item, place) => !isDeepStrictEqual(item, now.items[place]))
  return index === -1 ? 'the list past its first matches changed' : `element ${index} changed`
}

/**
 * The recipe that finds the element a reference names: the look's locator, keeping the match at the element's place.
 * A locator that keeps one match by its own pick listed at most one element, which is that one.
 *
 * @example elementRecipe({ by: 'role', role: 'button' }, 2) // { by: 'role', role: 'button', pick: 2 }
 */
export function elementRecipe(locator: LocatorRecipe, element: number): LocatorRecipe {
  return locator.pick === undefined ? { ...locator, pick: element } : locator
}

/**
 * A reference as a message names it.
 *
 * @example describeElementRef({ sessionId: 'k3v9q0x2mb:owner', observationId: 'o3', element: 1 }) // 'o3.e1 of k3v9q0x2mb:owner'
 */
export function describeElementRef(ref: ElementRef): string {
  return `${ref.observationId}.e${ref.element} of ${ref.sessionId}`
}

/**
 * Whether a value has the shape of an element reference.
 *
 * @example isElementRef({ sessionId: 'a:b', observationId: 'o1', element: 0 }) // true
 */
export function isElementRef(value: unknown): value is ElementRef {
  if (!isPlainObject(value)) return false
  const { sessionId, observationId, element } = value
  const keys = Object.keys(value).every((key) => key === 'sessionId' || key === 'observationId' || key === 'element')
  return keys && typeof sessionId === 'string' && typeof observationId === 'string' && typeof element === 'number' && Number.isSafeInteger(element) && element >= 0
}

function listed(observation: Observation): { text: string; visible: boolean }[] {
  return observation.items.map(({ text, visible }) => ({ text, visible }))
}

function matches(count: number): string {
  return count === 1 ? '1 match' : `${count} matches`
}

function refused(reason: RefRefusal, message: string, ref?: ElementRef): ResolvedRef {
  const named = ref === undefined ? {} : { ref: `${ref.observationId}.e${ref.element}`, sessionId: ref.sessionId }
  return { ok: false, failure: { ...failure('usage', message), details: { refused: reason, ...named } } }
}
