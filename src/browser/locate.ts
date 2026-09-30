import type { WorldArguments } from './isolated-world.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import { chromeRolesFor, elementsByRole, labelledRoles, type RoleQuery } from './accessibility.ts'

/**
 * How a page function finds a locator's elements. Test ids and text are found in the page itself. Role and
 * label take the elements Chrome's accessibility tree names, found afresh in each document the call reaches.
 */
type PageQuery = { by: 'testId'; value: string } | { by: 'text'; text: string; exact: boolean } | { by: 'elements' }

const foundAlready: PageQuery = { by: 'elements' }

/**
 * The arguments of a page function that takes `values` and then finds a locator's elements.
 *
 * @example await world.call(observeFunction, locatorArguments({ by: 'label', text: 'Email' }, [limit]), schema, deadline)
 */
export function locatorArguments(locator: LocatorRecipe, values: readonly unknown[]): WorldArguments {
  if (locator.by === 'testId' || locator.by === 'text') return [...values, pageQuery(locator)]
  const query = roleQuery(locator)
  return async (scope, deadline) => [
    ...[...values, foundAlready].map((value) => ({ value })),
    ...(await elementsByRole(scope, query, deadline)),
  ]
}

function pageQuery(locator: Extract<LocatorRecipe, { by: 'testId' | 'text' }>): PageQuery {
  if (locator.by === 'testId') return { by: 'testId', value: locator.value }
  return { by: 'text', text: locator.text, exact: locator.exact ?? true }
}

function roleQuery(locator: Extract<LocatorRecipe, { by: 'role' | 'label' }>): RoleQuery {
  const exact = locator.exact ?? true
  if (locator.by === 'label') return { roles: labelledRoles.flatMap(chromeRolesFor), name: locator.text, exact }
  const roles = chromeRolesFor(locator.role)
  return locator.name === undefined ? { roles, exact } : { roles, name: locator.name, exact }
}
