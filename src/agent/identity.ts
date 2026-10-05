import type { ElementIdentity, OwnedPage } from '../browser/contract.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { isDeepStrictEqual } from 'node:util'
import { locatorSteps } from '../protocol/locator.ts'

export type { ElementIdentity, KeyedRead, KeyedReading } from '../browser/contract.ts'

// How an agent session tells one element from another. Text never does: two elements can show the same, and an app can
// put another element showing the same in an element's place between two calls. Only a driver sees nodes, so a session
// asks it through its keyed read and acts through its pinned dispatch, the contract's `ElementIdentity`. On a driver
// that offers neither, a session accepts only what one read proves by itself: a reference acts through its look's own
// locator when that look listed that one element, and a recipe is the look's own locator. Everything else is refused
// by name.

/**
 * Whether a page's driver offers element identity. Chromium's page does; Firefox's and WebKit's do not yet.
 *
 * @example hasElementIdentity(page) // true on a Chromium page
 */
export function hasElementIdentity(page: OwnedPage): page is OwnedPage & ElementIdentity {
  return 'readElements' in page && typeof page.readElements === 'function' && 'dispatchTo' in page && typeof page.dispatchTo === 'function'
}

/**
 * Whether a locator keeps a match by its place at any step (`first()`, `last()`, `nth()`), so that another element can
 * take that place.
 *
 * @example keepsPlace({ by: 'role', role: 'button', pick: 1 }) // true
 */
export function keepsPlace(locator: LocatorRecipe): boolean {
  return locatorSteps(locator).some((step) => step.pick !== undefined)
}

/**
 * Whether two recipes are the same recipe, whatever the order of their keys and however an absent option is written.
 *
 * @example sameRecipe({ by: 'testId', value: 'save' }, { value: 'save', by: 'testId', within: undefined }) // true
 */
export function sameRecipe(first: LocatorRecipe, second: LocatorRecipe): boolean {
  return isDeepStrictEqual(written(first), written(second))
}

// A recipe as JSON writes it, which drops options left undefined.
function written(locator: LocatorRecipe): unknown {
  return JSON.parse(JSON.stringify(locator))
}
