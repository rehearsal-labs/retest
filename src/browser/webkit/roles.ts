import type { RoleDoubt } from './accessibility-reading.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { LocatorRecipe, LocatorStep, TextMatch } from '../../protocol/locator.ts'
import { describeLocator, locatorSteps } from '../../protocol/locator.ts'
import { labelledRoles } from '../accessibility.ts'
import { matchesText } from '../text-match.ts'

// The shared role lookup asks for elements by the role names Chrome's accessibility tree uses (`chromeRolesFor` in
// `accessibility.ts`). WebKit computes each element's role itself, through `DOM.getAccessibilityPropertiesForNode`, and
// names it as its own accessibility code does. Read against build 2359 beside Chrome, kind by kind
// (`webkit-roles.test.ts`), the names agree for most elements. Where WebKit names an element its own way and the page
// itself says what Chrome names it, the element's kind settles it here, by the HTML element and never by an
// approximation of the ARIA rules: a `<select>` that shows one option is `button` to WebKit and `combobox` to Chrome;
// an `<input type="number">` is `textbox` to WebKit and `spinbutton` to Chrome; an input whose suggestion list exists
// is a text field to WebKit and `combobox` to Chrome, unless it is a range or a colour; a date or time field and a
// `<div>` or `<span>` a person can edit are `textbox` to WebKit and no role a lookup can ask for to Chrome; a
// `<figcaption>` is `caption` to WebKit and nothing a lookup asks for to Chrome. MathML's `<math>` is `math`, which
// Chrome may also call `MathMLMath`. Every other difference the reading reports as a doubt (`accessibility-reading.ts`).

const queryRoles: Readonly<Record<string, readonly string[]>> = {
  MathMLMath: ['math'],
}

/** What the driver knows of an element besides its WebKit role, each from the element itself. */
export type ElementKind = {
  /** A `<select>` that shows one option. */
  readonly select: boolean
  /** An `<input type="number">`. */
  readonly numberField: boolean
  /** An input with no role attribute whose suggestion list exists, and that is not a range or a colour. */
  readonly suggests?: boolean
  /** A date, time, date-and-time, month or week input with no role attribute. */
  readonly dateField?: boolean
  /** A `<div>` or `<span>` a person can edit, with no role attribute. */
  readonly plainEditor?: boolean
  /** A `<figcaption>`. */
  readonly figureCaption?: boolean
}

/** The role Chrome's tree gives an element WebKit names on its own terms and a lookup can never ask for. */
const noLookupRole = ''

/**
 * The roles, as `chromeRoleOf` names them, that a Chrome tree query for `role` asks for.
 *
 * @example webKitRolesFor('MathMLMath') // ['math']
 */
export function webKitRolesFor(role: string): readonly string[] {
  return queryRoles[role] ?? [role]
}

/**
 * An element's role as Chrome's tree names it, from WebKit's role and what the element is.
 *
 * @example chromeRoleOf('button', { select: true, numberField: false }) // 'combobox'
 */
export function chromeRoleOf(role: string, kind: ElementKind): string {
  if (kind.suggests === true && (role === 'textbox' || role === 'searchbox')) return 'combobox'
  if (role === 'button' && kind.select) return 'combobox'
  if (role === 'textbox' && kind.numberField) return 'spinbutton'
  if (role === 'textbox' && (kind.dateField === true || kind.plainEditor === true)) return noLookupRole
  if (role === 'caption' && kind.figureCaption === true) return noLookupRole
  return role
}

/** One role a locator step looks up, with the name it asks for, if any. */
type Lookup = { readonly role: string; readonly name: TextMatch | undefined; readonly exact: boolean }

/**
 * The role of the first lookup of `locator` that `doubt` could change, if any: a role step, or each of the roles a
 * label step looks through, by their name.
 *
 * @example doubtedRole({ by: 'role', role: 'cell', name: 'Ada' }, { role: 'cell', lookups: 'named', reason: '', fewer: true }) // 'cell'
 */
export function doubtedRole(locator: LocatorRecipe, doubt: RoleDoubt): string | undefined {
  for (const lookup of locatorSteps(locator).flatMap(lookupsOf)) if (doubtChanges(doubt, lookup)) return lookup.role
  return undefined
}

/**
 * The refusal of a lookup a doubt of the page could change, naming the role it asked for and what on the page caused it.
 * `inputSent` is told when an action's input had already gone when the doubt came.
 *
 * @example roleRefusal({ by: 'role', role: 'cell', name: 'Ada' }, 'cell', doubt, false).class // 'unsupported'
 */
export function roleRefusal(locator: LocatorRecipe, role: string, doubt: Pick<RoleDoubt, 'reason' | 'fewer'>, inputSent: boolean): Failure {
  const instead = role === 'option'
    ? 'Choose an option with select(), or find it with getByText() or getByTestId().'
    : contentNamed.has(role)
      ? 'Find it with getByText() or getByTestId(), or by its position with nth().'
      : 'Find it with getByText(), getByTestId() or a CSS locator.'
  const sent = inputSent ? ' Retest had already begun to act on it, and input it sent is not taken back.' : ''
  return {
    class: 'unsupported',
    message: `Could not look up ${describeLocator(locator)}: ${doubt.reason}, so Retest refuses the lookup rather than find ${doubt.fewer ? 'less' : 'a different set'} on WebKit. ${instead}${sent}`,
    details: inputSent ? { role, inputSent: true } : { role },
  }
}

/**
 * The refusal, before anything is sent, of a lookup no page can make exact on WebKit: the role `generic`, which Chrome's
 * tree gives an element with no role of its own by rules of its layout that WebKit's tree does not follow.
 *
 * @example genericRefusal({ by: 'role', role: 'generic' })?.class // 'unsupported'
 */
export function genericRefusal(locator: LocatorRecipe): Failure | undefined {
  if (!locatorSteps(locator).some((step) => step.by === 'role' && step.role === 'generic')) return undefined
  const reason = "Chrome's tree keeps an element with no role of its own as generic by rules of its own layout, which WebKit's accessibility tree does not follow"
  return roleRefusal(locator, 'generic', { reason, fewer: false }, false)
}

const contentNamed: ReadonlySet<string> = new Set(['cell', 'gridcell', 'columnheader', 'rowheader', 'tooltip'])

// As the shared lookup reads a step (`roleQuery` in `locate.ts`): exact unless the step says otherwise.
function lookupsOf(step: LocatorStep): Lookup[] {
  if (step.by === 'role') return [{ role: step.role, name: step.name, exact: step.exact ?? true }]
  if (step.by === 'label') return labelledRoles.map((role) => ({ role, name: step.text, exact: step.exact ?? true }))
  return []
}

function doubtChanges(doubt: RoleDoubt, lookup: Lookup): boolean {
  if (doubt.role !== '*' && doubt.role !== lookup.role) return false
  switch (doubt.lookups) {
    case 'all':
      return true
    case 'named':
      return lookup.name !== undefined
    case 'unnamed':
      return lookup.name === undefined
    case 'names': {
      const { name } = lookup
      return name !== undefined && doubt.names.some((candidate) => matchesText(candidate, name, lookup.exact))
    }
  }
}
