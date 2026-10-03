import type { WorldArgument, WorldArguments } from './isolated-world.ts'
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

/** The steps of a locator as a page function takes them, and, by Playwright's rules, a refusal of open shadow roots. */
type PageQuery = { steps: PageStep[]; shadow?: 'refused' }

type RoleStep = Extract<LocatorStep, { by: 'role' | 'label' }>

/**
 * The arguments of a page function that takes `values` and then finds a locator's elements, through its steps in
 * order. A locator with a role or label step has its elements found in the world of each document the call reaches.
 *
 * @example await world.call(observeFunction, locatorArguments({ by: 'label', text: 'Email' }, [limit]), schema, deadline)
 */
export function locatorArguments(locator: LocatorRecipe, values: readonly unknown[]): WorldArguments {
  const steps = locatorSteps(locator)
  const playwright = locator.dialect === 'playwright'
  const query = (pageSteps: PageStep[]): PageQuery => (playwright ? { steps: pageSteps, shadow: 'refused' } : { steps: pageSteps })
  const found = steps.flatMap((step) => (isRoleStep(step) ? [] : [pageStep(step)]))
  if (found.length === steps.length) return [...values, query(found)]
  return async (scope, deadline) => {
    const elements: WorldArgument[] = []
    const pageSteps: PageStep[] = []
    for (const step of steps) {
      if (!isRoleStep(step)) {
        pageSteps.push(pageStep(step))
        continue
      }
      const found = await elementsByRole(scope, roleQuery(step), deadline)
      const labelled = playwright && step.by === 'label' ? { labelled: { text: step.text, exact: step.exact ?? true } } : {}
      pageSteps.push({ by: 'elements', from: elements.length, count: found.length, pick: step.pick ?? null, ...labelled })
      elements.push(...found)
    }
    return [...[...values, query(pageSteps)].map((value) => ({ value })), ...elements]
  }
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
