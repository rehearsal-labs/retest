import type { WorldArgument, WorldArguments, WorldScope } from './isolated-world.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { LocatorPick, LocatorRecipe, LocatorStep, TextMatch } from '../protocol/locator.ts'
import { locatorSteps } from '../protocol/locator.ts'
import { chromeRolesFor, elementsByRole, labelledRoles, type RoleQuery } from './accessibility.ts'

type Picked = { pick: LocatorPick | null }

/**
 * One step as a page function finds it. Test ids, text, placeholders and CSS are found in the page itself. Role and
 * label take the elements Chrome's accessibility tree names, found afresh in each document the call reaches and
 * passed after the query: `from` and `count` say which of them are this step's. A label step by Playwright's rules
 * adds, in `labelled`, the elements whose `aria-label` or `aria-labelledby` names them, found in the page.
 */
type PageStep = Picked &
  (
    | { by: 'testId'; value: string }
    | { by: 'text' | 'placeholder'; text: TextMatch; exact: boolean }
    | { by: 'css'; selector: string }
    | { by: 'elements'; from: number; count: number; labelled?: { text: TextMatch; exact: boolean } }
  )

/**
 * The steps of a locator as a page function takes them, by Playwright's rules a refusal of open shadow roots, and the
 * key of the one node a pinned read may find.
 */
type PageQuery = { steps: PageStep[]; shadow?: 'refused'; element?: string }

type RoleStep = Extract<LocatorStep, { by: 'role' | 'label' }>

/**
 * The arguments of a page function that takes `values` and then finds a locator's elements, through its steps in
 * order. A locator with a role or label step has its elements found in the world of each document the call reaches.
 * `pinned`, a key a keyed look gave one node, goes with the query as `element`, for a page function that reads only
 * that node.
 *
 * @example await world.call(observeFunction, locatorArguments({ by: 'label', text: 'Email' }, [limit]), schema, deadline)
 */
export function locatorArguments(locator: LocatorRecipe, values: readonly unknown[], pinned?: string): WorldArguments {
  const held = (query: PageQuery): PageQuery => (pinned === undefined ? query : { ...query, element: pinned })
  const found = queryInPage(locator)
  if (found !== undefined) return [...values, held(found)]
  return async (scope, deadline) => {
    const elements: WorldArgument[] = []
    const query = held(await queryIn(locator, scope, deadline, elements))
    return [...[...values, query].map((value) => ({ value })), ...elements]
  }
}

/**
 * The arguments of a page function that takes `values` and then finds the elements of several locators in one call:
 * their queries go as one list, in order. The elements Chrome names for every role and label step of every locator
 * are found in the same document's world, one locator after another, and follow the list; each step names which of
 * them are its own.
 *
 * @example await world.call(keyedObserveFunction, locatorsArguments([look, recipe], [limit]), schema, deadline)
 */
export function locatorsArguments(locators: readonly LocatorRecipe[], values: readonly unknown[]): WorldArguments {
  const found = locators.map(queryInPage)
  if (found.every((query): query is PageQuery => query !== undefined)) return [...values, found]
  return async (scope, deadline) => {
    const elements: WorldArgument[] = []
    const queries: PageQuery[] = []
    for (const locator of locators) queries.push(await queryIn(locator, scope, deadline, elements))
    return [...[...values, queries].map((value) => ({ value })), ...elements]
  }
}

// A locator's query when every step is found in the page itself, or undefined when a role or label step needs the
// elements Chrome's tree names.
function queryInPage(locator: LocatorRecipe): PageQuery | undefined {
  const steps = locatorSteps(locator)
  const found = steps.flatMap((step) => (isRoleStep(step) ? [] : [pageStep(step)]))
  return found.length === steps.length ? queryOf(locator, found) : undefined
}

// A locator's query in one document's world, with the elements each role and label step takes added to `elements`,
// after those already there.
async function queryIn(locator: LocatorRecipe, scope: WorldScope, deadline: Deadline, elements: WorldArgument[]): Promise<PageQuery> {
  const playwright = locator.dialect === 'playwright'
  const pageSteps: PageStep[] = []
  for (const step of locatorSteps(locator)) {
    if (!isRoleStep(step)) {
      pageSteps.push(pageStep(step))
      continue
    }
    const found = await elementsByRole(scope, roleQuery(step), deadline)
    const labelled = playwright && step.by === 'label' ? { labelled: { text: step.text, exact: step.exact ?? true } } : {}
    pageSteps.push({ by: 'elements', from: elements.length, count: found.length, pick: step.pick ?? null, ...labelled })
    elements.push(...found)
  }
  return queryOf(locator, pageSteps)
}

function queryOf(locator: LocatorRecipe, pageSteps: PageStep[]): PageQuery {
  return locator.dialect === 'playwright' ? { steps: pageSteps, shadow: 'refused' } : { steps: pageSteps }
}

function isRoleStep(step: LocatorStep): step is RoleStep {
  return step.by === 'role' || step.by === 'label'
}

function pageStep(step: Exclude<LocatorStep, RoleStep>): PageStep {
  const pick = step.pick ?? null
  switch (step.by) {
    case 'testId':
      return { by: 'testId', value: step.value, pick }
    case 'css':
      return { by: 'css', selector: step.selector, pick }
    default:
      return { by: step.by, text: step.text, exact: step.exact ?? true, pick }
  }
}

function roleQuery(step: RoleStep): RoleQuery {
  const exact = step.exact ?? true
  if (step.by === 'label') return { roles: labelledRoles.flatMap(chromeRolesFor), name: step.text, exact }
  const roles = chromeRolesFor(step.role)
  return step.name === undefined ? { roles, exact } : { roles, name: step.name, exact }
}
