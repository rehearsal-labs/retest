import type { WebEngine } from '../browser/contract.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { KeyedRead } from './identity.ts'
import type { ServedLook } from './looks.ts'
import { failure } from '../protocol/failures.ts'
import { describeLocator, locatorProblem } from '../protocol/locator.ts'
import { quoteText } from '../protocol/text.ts'
import { keepsPlace, sameRecipe } from './identity.ts'

// A durable recipe is what a saved test keeps: how to find an element by what it is, a test id, a role and name, a
// label, a text, a placeholder or a CSS selector, never by where a look happened to list it. An agent turns a reference
// into one only when a read proves the recipe finds the referenced element itself. Showing the same text proves
// nothing, since another element can show it too. On a driver that keys elements, one read resolves the look's element
// at its place and the recipe, and compares the two nodes. On a driver that cannot, the only recipe one read proves is
// the look's own locator, when that read finds exactly one element: then the read of the look is the read of the
// recipe, and both find the same node by construction.

/**
 * What keeps a recipe from being durable, as one usage failure, or undefined: a step that keeps a match by its place
 * (`first()`, `last()`, `nth()`), since a place is what makes a reference ephemeral, or a recipe the page cannot read.
 *
 * @example durableRecipeProblem({ by: 'role', role: 'button', pick: 2 })?.class // 'usage'
 */
export function durableRecipeProblem(locator: LocatorRecipe): Failure | undefined {
  const problem = locatorProblem(locator)
  if (problem !== undefined) return problem
  if (!keepsPlace(locator)) return undefined
  const message = `${describeLocator(locator)} keeps a match by its place. A durable recipe names its element by what it is, never by where a look listed it; name it by a test id, a role and name, a label, a text, a placeholder or a scope.`
  return { ...failure('usage', message), details: { refused: 'placed' } }
}

/** What a keyed read of a reference's look and a recipe, taken at once, saw. */
export type KeyedRecipeReads = { readonly look: ServedLook; readonly element: number; readonly lookRead: KeyedRead; readonly recipeRead: KeyedRead; readonly locator: LocatorRecipe }

/**
 * Whether a keyed read proves that a recipe finds the element a reference names: in that one read the look's locator
 * still lists, at the reference's place, the node the look listed there, and the recipe finds exactly that node.
 * Undefined when it does; otherwise the refusal, whose page text the caller redacts.
 *
 * @example keyedRecipeProblem({ look, element: 1, lookRead, recipeRead, locator: { by: 'testId', value: 'save' } }) // undefined when both name one node
 */
export function keyedRecipeProblem({ look, element, lookRead, recipeRead, locator }: KeyedRecipeReads): Failure | undefined {
  const ref = `${look.observationId}.e${element}`
  const key = look.keys?.[element]
  if (key === undefined || lookRead.keys[element] !== key) {
    const message = `${ref} is stale: the element ${look.observationId} listed at place ${element} of ${describeLocator(look.locator)} is no longer there. Look again.`
    return { ...failure('usage', message), details: { refused: 'changed' } }
  }
  const counted = countProblem(recipeRead.observation, locator, ref)
  if (counted !== undefined) return counted
  if (recipeRead.keys[0] === key) return undefined
  const found = recipeRead.observation.items[0]
  const referenced = look.observation.items[element]
  const shows = found === undefined ? 'another element' : `an element showing ${quoteText(found.text)}`
  const names = referenced === undefined ? '' : `, which shows ${quoteText(referenced.text)}`
  const message = `${describeLocator(locator)} finds ${shows}, and it is not the element ${ref} names${names}. Showing the same text does not make two elements one.`
  return { ...failure('usage', message), details: { refused: 'other-element' } }
}

/** What one read of a reference's look saw on a driver that cannot compare two elements. */
export type OneReadRecipe = { readonly look: ServedLook; readonly element: number; readonly fresh: Observation; readonly locator: LocatorRecipe; readonly engine: WebEngine }

/**
 * Whether one read proves a recipe on a driver that cannot compare two elements: only when the recipe is the look's own
 * locator, so the read of the look is the read of the recipe, and that read finds exactly one element. Any other
 * recipe is refused by name, since nothing the driver says ties the element it finds to the referenced one.
 *
 * @example oneReadRecipeProblem({ look, element: 0, fresh, locator: look.locator, engine: 'firefox' }) // undefined when the look lists one element
 */
export function oneReadRecipeProblem({ look, element, fresh, locator, engine }: OneReadRecipe): Failure | undefined {
  const ref = `${look.observationId}.e${element}`
  if (!sameRecipe(locator, look.locator)) {
    const message = `Retest cannot tell whether ${describeLocator(locator)} finds the element ${ref} names: the ${engine} driver cannot compare two elements. On ${engine} a recipe from a reference is the locator of the look that listed it, and only when that look listed it alone. Look with ${describeLocator(locator)}, then ask for the recipe of the element that look lists.`
    return { ...failure('usage', message), details: { refused: 'unproven', engine } }
  }
  return countProblem(fresh, locator, ref)
}

function countProblem(found: Observation, locator: LocatorRecipe, ref: string): Failure | undefined {
  const described = describeLocator(locator)
  if (found.count === 0) return { ...failure('not_found', `${described} finds no element, so it cannot name ${ref}.`), details: { refused: 'not-found' } }
  if (found.count > 1) return { ...failure('ambiguous', `${described} finds ${found.count} elements. A durable recipe finds exactly one, so it cannot name ${ref}.`), details: { refused: 'ambiguous', count: found.count } }
  return undefined
}
