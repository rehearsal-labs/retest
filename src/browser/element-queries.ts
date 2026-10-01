import type { DocumentFacts } from './document-facts.ts'
import type { Dispatch } from './dispatch.ts'
import type { Point } from './input.ts'
import type { InDocument, IsolatedWorld } from './isolated-world.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { OptionChoiceRecord } from '../protocol/option-choices.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { Schema } from '../protocol/schema.ts'
import { observationSchema, observedItemLimit } from '../protocol/commands.ts'
import { describeLocator } from '../protocol/locator.ts'
import { describeOptionChoice, describeOptionChoices } from '../protocol/option-choices.ts'
import { s } from '../protocol/schema.ts'
import { shorten } from '../protocol/text.ts'
import { documentFactsSchema, pageFactsOf } from './document-facts.ts'
import { locatorArguments } from './locate.ts'
import { armDocumentFunction, checkedFunction, observeFunction, prepareFunction } from './page-scripts.ts'

const checks = ['attached', 'visible', 'enabled', 'editable', 'stable', 'in-view', 'hit-target', 'focused'] as const

/** An actionability check, in the order `prepare` runs them after the element is found. */
export type Check = (typeof checks)[number]

const unsupportedReasons = ['field', 'multiline', 'checkable', 'radio', 'select', 'multiple'] as const

/**
 * Why an element cannot take an action at all: not a field `fill` can use, a line break for a one-line field, not a
 * control `check` can use, a radio button to uncheck, not a `<select>`, or a list for a select that takes one.
 */
export type UnsupportedReason = (typeof unsupportedReasons)[number]

/**
 * How one look at the page went for an action. `detail` describes what covers the element, when something does.
 * `token` names the input guard a ready element armed, or is null for a `select`, which arms none; `point` is where
 * to act, or null for a key, which goes to the focus. `via` is `'label'` when a hidden control is acted on through
 * its label. `scale` is the visual viewport's, and `page` the page the look read. `refused` names the origin a fill
 * bound to origins would have reached: the document's own, or, when `leaving`, the one the page set off to open as
 * the field took focus. `option` names, by its index, a choice of a `select` that matched no option, more than one,
 * or a disabled one. `unchanged` is a `check` or `select` already as asked, and `selected` a selection made.
 */
export type Readiness =
  | { status: 'missing' }
  | { status: 'refused'; origin: string; leaving: boolean }
  | { status: 'ambiguous'; count: number }
  | { status: 'unsupported'; reason: UnsupportedReason; element: string }
  | { status: 'option'; problem: 'missing' | 'ambiguous' | 'disabled'; choice: number; count: number }
  | { status: 'blocked'; check: Check; detail: string | null }
  | { status: 'unchanged'; page: DocumentFacts }
  | { status: 'ready'; point: Point | null; token: number | null; via: 'label' | null; scale: number; page: DocumentFacts }
  | { status: 'selected'; page: DocumentFacts }

/** How a pointer action's input goes: a click, or a tap on a page that emulates a touch screen. */
export type Pointer = 'click' | 'tap'

/**
 * An action on an element, as the page sends its input. `secret` names a `fill` value that is never shown, and
 * `allowedOrigins` are the only origins a `fill` may type into. A `press` names its key as the test wrote it. A
 * `check` or `uncheck` clicks through `pointer`. A `select` names its choices, and `multiple` when the test gave a
 * list. A `scroll` turns the wheel.
 */
export type ActionIntent = { multiline: boolean; secret?: string; allowedOrigins?: readonly string[] } & (
  | { action: Pointer }
  | { action: 'fill' }
  | { action: 'scroll' }
  | { action: 'press'; key: string }
  | { action: 'check' | 'uncheck'; pointer: Pointer }
  | { action: 'select'; choices: readonly OptionChoiceRecord[]; multiple: boolean }
)

/** A look at the page for input that goes to the document, not to an element: a key or the wheel. */
export type DocumentAction = 'press' | 'scroll'

const readySchema = s.object({
  status: s.literal('ready'),
  point: s.nullable(s.object({ x: s.number(), y: s.number() })),
  token: s.nullable(s.number({ integer: true, min: 1 })),
  via: s.nullable(s.literal('label')),
  scale: s.number({ min: 0 }),
  page: documentFactsSchema,
})

const readinessSchema: Schema<Readiness> = s.discriminatedUnion('status', [
  s.object({ status: s.literal('missing') }),
  s.object({ status: s.literal('refused'), origin: s.string(), leaving: s.boolean() }),
  s.object({ status: s.literal('ambiguous'), count: s.number({ integer: true, min: 2 }) }),
  s.object({ status: s.literal('unsupported'), reason: s.enum(unsupportedReasons), element: s.string() }),
  s.object({
    status: s.literal('option'),
    problem: s.enum(['missing', 'ambiguous', 'disabled']),
    choice: s.number({ integer: true, min: 0 }),
    count: s.number({ integer: true, min: 0 }),
  }),
  s.object({ status: s.literal('blocked'), check: s.enum(checks), detail: s.nullable(s.string()) }),
  s.object({ status: s.literal('unchanged'), page: documentFactsSchema }),
  readySchema,
  s.object({ status: s.literal('selected'), page: documentFactsSchema }),
])

const observedSchema = s.object({ observation: observationSchema, page: documentFactsSchema })

/** Resolves the locator once and reads what an assertion needs, and the page it read it on. */
export async function observe(world: IsolatedWorld, locator: LocatorRecipe, deadline: Deadline): Promise<{ observation: Observation; page: PageFacts }> {
  const { observation, page } = await world.call(observeFunction, locatorArguments(locator, [observedItemLimit]), observedSchema, deadline)
  return { observation, page: pageFactsOf(page) }
}

/**
 * Resolves the locator once and runs the checks an action needs, readying a field for `fill` and focusing the
 * element for `press`. Also names the document it looked at, which holds the guard a ready element armed. A
 * `select` is only checked here; `applySelection` makes it.
 */
export function prepare(
  world: IsolatedWorld,
  locator: LocatorRecipe,
  intent: ActionIntent,
  deadline: Deadline,
): Promise<InDocument<Readiness>> {
  return world.enter(prepareFunction, locatorArguments(locator, [pageIntent(intent)]), readinessSchema, deadline)
}

/**
 * Runs a `select`'s checks again in the document a look found it ready in, and sets the selection in the same task
 * as the hit test when they pass. The call is the action's input, so it goes through `dispatch`: once the page
 * says `selected`, or no answer came, the selection may have been made.
 */
export function applySelection(
  world: IsolatedWorld,
  context: number,
  locator: LocatorRecipe,
  intent: Extract<ActionIntent, { action: 'select' }>,
  deadline: Deadline,
  dispatch: Dispatch,
): Promise<Readiness> {
  const args = locatorArguments(locator, [{ ...pageIntent(intent), apply: true }])
  return dispatch.attempt(
    (attempt) => world.callIn(context, prepareFunction, args, readinessSchema, deadline, attempt),
    (readiness) => readiness.status === 'selected',
  )
}

/**
 * Arms the guard for input that goes to the document the page holds now: a key for the page's keyboard, which goes
 * to whatever holds the focus there, or the wheel at the centre of the viewport. Ready as `prepare` is, in that
 * document.
 */
export function armDocument(world: IsolatedWorld, action: DocumentAction, deadline: Deadline): Promise<InDocument<Extract<Readiness, { status: 'ready' }>>> {
  return world.enter(armDocumentFunction, [action], readySchema, deadline)
}

/** Whether the one element the locator finds is checked, or null when no single such control is there. */
export function readChecked(world: IsolatedWorld, locator: LocatorRecipe, deadline: Deadline): Promise<boolean | null> {
  return world.call(checkedFunction, locatorArguments(locator, []), s.nullable(s.boolean()), deadline)
}

/**
 * An action as failure messages name it, the way a test reads: a press names its key, a select its choices, and
 * a key for the page's keyboard or a wheel for the page has no element.
 *
 * @example describeAction({ action: 'press', key: 'Enter', multiline: false }, { by: 'label', text: 'Search' }) // "press Enter on getByLabel('Search')"
 */
export function describeAction(intent: ActionIntent, locator: LocatorRecipe | undefined): string {
  switch (intent.action) {
    case 'press': {
      const verb = `press ${shorten(intent.key)}`
      return locator === undefined ? verb : `${verb} on ${describeLocator(locator)}`
    }
    case 'select':
      return `select ${describeChoices(intent)} in ${locator === undefined ? 'the page' : describeLocator(locator)}`
    default:
      return `${intent.action} ${locator === undefined ? 'the page' : describeLocator(locator)}`
  }
}

/**
 * A select's choices as the test wrote them: a list when it gave one, even of one option.
 *
 * @example describeChoices({ action: 'select', choices: [{ label: 'Red' }], multiple: true, multiline: false }) // "['Red']"
 */
export function describeChoices({ choices, multiple }: Extract<ActionIntent, { action: 'select' }>): string {
  return multiple ? `[${choices.map(describeOptionChoice).join(', ')}]` : describeOptionChoices(choices)
}

// What the page script needs of the intent. A check names the state it asks for; the verb is only for messages.
function pageIntent(intent: ActionIntent): Record<string, unknown> {
  switch (intent.action) {
    case 'fill':
      return { action: 'fill', multiline: intent.multiline, origins: intent.allowedOrigins ?? null }
    case 'check':
    case 'uncheck':
      return { action: 'check', checked: intent.action === 'check', pointer: intent.pointer }
    case 'select':
      return { action: 'select', choices: intent.choices, multiple: intent.multiple, apply: false }
    default:
      return { action: intent.action }
  }
}
