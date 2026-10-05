import type { BrowserCommand, DispatchedCommand } from './contract.ts'
import type { DocumentFacts } from './document-facts.ts'
import type { Point } from './input.ts'
import type { InDocument, IsolatedWorld } from './isolated-world.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { EmptyStep, LocatorRecipe } from '../protocol/locator.ts'
import type { OptionChoiceRecord } from '../protocol/option-choices.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { Schema } from '../protocol/schema.ts'
import { AsyncLocalStorage } from 'node:async_hooks'
import { observationSchema, observedItemLimit } from '../protocol/commands.ts'
import { describeLocator, emptyStepSchema } from '../protocol/locator.ts'
import { describeOptionChoice, describeOptionChoices } from '../protocol/option-choices.ts'
import { s } from '../protocol/schema.ts'
import { shorten } from '../protocol/text.ts'
import { documentFactsSchema, pageFactsOf } from './document-facts.ts'
import { isGoneContext } from './isolated-world.ts'
import { locatorArguments, locatorsArguments } from './locate.ts'
import { armDocumentFunction, checkedFunction, keyedObserveFunction, observeFunction, prepareFunction, selectionFunction, setOffFunction } from './page-scripts.ts'

const checks = ['attached', 'visible', 'enabled', 'editable', 'stable', 'in-view', 'hit-target', 'focused'] as const

/** An actionability check, in the order `prepare` runs them after the element is found. */
export type Check = (typeof checks)[number]

const unsupportedReasons = ['field', 'multiline', 'checkable', 'radio', 'select', 'multiple'] as const

/**
 * Why an element cannot take an action at all: not a field `fill` can use, a line break for a one-line field, not a
 * control `check` can use, a radio button to uncheck, not a `<select>`, or a list for a select that takes one.
 */
export type UnsupportedReason = (typeof unsupportedReasons)[number]

/** One key of a select's plan: a character to type, or `Home`, `ArrowDown` or `Space`, with the modifier that leaves the selection alone. */
export type PlannedKey = { key: string; toggle: boolean }

/**
 * The keys that choose a select's options. Keys typed into a select that takes one option must reach it within a
 * second of each other, and after a second with none: `quietMs` is how much of that second is still to come since
 * Retest last readied the select for a key. A select that takes several has no type-ahead, and no quiet to wait for.
 */
export type SelectPlan = { quietMs: number; keys: PlannedKey[] }

/**
 * How one look at the page went for an action. `detail` describes what covers the element, when something does.
 * `token` names the input guard a ready element armed, or is null for a `select`'s look, which arms none; `point` is
 * where to act, or null for a key, which goes to the focus. `via` is `'label'` when a hidden control is acted on
 * through its label. `scale` is the visual viewport's, and `page` the page the look read. `plan` is a select's keys.
 * `refused` names the origin a fill bound to origins would have reached: the document's own, or, when `leaving`, the
 * one the page set off to open as the field took focus. `option` names, by its index, a choice of a `select` that
 * matched no option, more than one, or a disabled one, and `unreachable` a select whose options no key reaches.
 * `missing` names the step of a scoped locator that kept nothing, and `invalid` a CSS selector the page could not
 * read. `shadow` names the host of an open shadow root a locator by Playwright's rules refuses to look past.
 * `unchanged` is a `check` or `select` already as asked. `moved` is an action pinned to one node whose locator now
 * finds another.
 */
export type Readiness =
  | { status: 'missing'; empty: EmptyStep | null }
  | { status: 'invalid'; step: number; message: string }
  | { status: 'shadow'; host: string }
  | { status: 'refused'; origin: string; leaving: boolean }
  | { status: 'ambiguous'; count: number }
  | { status: 'moved' }
  | { status: 'unsupported'; reason: UnsupportedReason; element: string }
  | { status: 'option'; problem: 'missing' | 'ambiguous' | 'disabled'; choice: number; count: number }
  | { status: 'unreachable'; element: string }
  | { status: 'blocked'; check: Check; detail: string | null }
  | { status: 'unchanged'; page: DocumentFacts }
  | { status: 'ready'; point: Point | null; token: number | null; via: 'label' | null; scale: number; page: DocumentFacts; plan: SelectPlan | null }

/** How a pointer action's input goes: a click, or a tap on a page that emulates a touch screen. */
export type Pointer = 'click' | 'tap'

/**
 * An action on an element, as the page sends its input. `secret` names a `fill` value that is never shown, and
 * `allowedOrigins` are the only origins a `fill` may type into. A `press` names its key as the test wrote it, and how
 * many keys it holds and presses. A `check` or `uncheck` clicks through `pointer`. A `select` names its choices, and
 * `multiple` when the test gave a list; with `typing`, it is one key of the select's plan, which holds `strokes` keys.
 * A `scroll` turns the wheel, and a `hover` moves the mouse.
 */
export type ActionIntent = { multiline: boolean; secret?: string; allowedOrigins?: readonly string[] } & (
  | { action: Pointer }
  | { action: 'fill' }
  | { action: 'scroll' }
  | { action: 'hover' }
  | { action: 'press'; key: string; strokes: number }
  | { action: 'check' | 'uncheck'; pointer: Pointer }
  | { action: 'select'; choices: readonly OptionChoiceRecord[]; multiple: boolean; typing?: { strokes: number } }
)

/** A look at the page for input that goes to the document, not to an element: a key or the wheel. */
export type DocumentAction = 'press' | 'scroll'

const pageFacts = documentFactsSchema

const planSchema: Schema<SelectPlan> = s.object({
  quietMs: s.number({ integer: true, min: 0 }),
  keys: s.array(s.object({ key: s.string(), toggle: s.boolean() })),
})

const readySchema = s.object({
  status: s.literal('ready'),
  point: s.nullable(s.object({ x: s.number(), y: s.number() })),
  token: s.nullable(s.number({ integer: true, min: 1 })),
  via: s.nullable(s.literal('label')),
  scale: s.number({ min: 0 }),
  page: pageFacts,
  plan: s.nullable(planSchema),
})

const readinessSchema: Schema<Readiness> = s.discriminatedUnion('status', [
  s.object({ status: s.literal('missing'), empty: s.nullable(emptyStepSchema) }),
  s.object({ status: s.literal('invalid'), step: s.number({ integer: true, min: 0 }), message: s.string() }),
  s.object({ status: s.literal('shadow'), host: s.string() }),
  s.object({ status: s.literal('refused'), origin: s.string(), leaving: s.boolean() }),
  s.object({ status: s.literal('ambiguous'), count: s.number({ integer: true, min: 2 }) }),
  s.object({ status: s.literal('moved') }),
  s.object({ status: s.literal('unsupported'), reason: s.enum(unsupportedReasons), element: s.string() }),
  s.object({
    status: s.literal('option'),
    problem: s.enum(['missing', 'ambiguous', 'disabled']),
    choice: s.number({ integer: true, min: 0 }),
    count: s.number({ integer: true, min: 0 }),
  }),
  s.object({ status: s.literal('unreachable'), element: s.string() }),
  s.object({ status: s.literal('blocked'), check: s.enum(checks), detail: s.nullable(s.string()) }),
  s.object({ status: s.literal('unchanged'), page: pageFacts }),
  readySchema,
])

/** A CSS selector of a locator's step that the page could not read, with the browser's reason. */
export type InvalidSelector = { step: number; message: string }

const invalidSchema = s.object({ step: s.number({ integer: true, min: 0 }), message: s.string() })

const observedSchema = s.union([
  s.object({ observation: observationSchema, page: pageFacts }),
  s.object({ invalid: invalidSchema }),
  s.object({ shadow: s.string() }),
])

/**
 * What one look at a locator read: the observation and the page, a CSS selector the page could not read, or the host
 * of an open shadow root a locator by Playwright's rules refuses to look past.
 */
export type Observed = { observation: Observation; page: PageFacts } | { invalid: InvalidSelector } | { shadow: string }

/** Resolves the locator once and reads what an assertion needs, and the page it read it on. */
export async function observe(world: IsolatedWorld, locator: LocatorRecipe, deadline: Deadline): Promise<Observed> {
  const observed = await world.call(observeFunction, locatorArguments(locator, [observedItemLimit]), observedSchema, deadline)
  return 'observation' in observed ? { observation: observed.observation, page: pageFactsOf(observed.page) } : observed
}

/** One locator's read in a keyed look: its observation, and the key of each element it lists, in the same order. */
export type KeyedLook = { observation: Observation; keys: string[] }

/**
 * What one keyed look at several locators read: a read per locator and the page, or, with the place of the locator
 * it names, a CSS selector the page could not read or the host of an open shadow root a locator refuses to look past.
 */
export type KeyedObserved = { reads: KeyedLook[]; page: PageFacts } | { invalid: InvalidSelector; locator: number } | { shadow: string; locator: number }

const keyedSchema = s.union([
  s.object({ reads: s.array(s.object({ observation: observationSchema, keys: s.array(s.string()) })), page: pageFacts }),
  s.object({ invalid: invalidSchema, query: s.number({ integer: true, min: 0 }) }),
  s.object({ shadow: s.string(), query: s.number({ integer: true, min: 0 }) }),
])

/**
 * Resolves each locator once, all in one call of the world, reads what `observe` reads of each, and keys every element
 * listed with the key the document's world keeps for that node. An answer that does not read each locator once, or
 * does not key each element it lists, is not Retest's page function answering, and throws. Sends no input.
 */
export async function observeKeyed(world: IsolatedWorld, locators: readonly LocatorRecipe[], deadline: Deadline): Promise<KeyedObserved> {
  const observed = await world.call(keyedObserveFunction, locatorsArguments(locators, [observedItemLimit]), keyedSchema, deadline)
  if ('invalid' in observed) return { invalid: observed.invalid, locator: observed.query }
  if ('shadow' in observed) return { shadow: observed.shadow, locator: observed.query }
  const whole = observed.reads.length === locators.length && observed.reads.every((read) => read.keys.length === read.observation.items.length)
  if (!whole) throw new Error(`Retest's keyed look answered ${observed.reads.length} reads for ${locators.length} locators, or left an element it listed without a key`)
  return { reads: observed.reads, page: pageFactsOf(observed.page) }
}

// The node an action is pinned to, for every look that readies its element. A driver's `dispatchTo` runs its own
// `dispatch` inside it, so the look that readies the element checks the node in the task of the hit test on every
// engine, without each driver's action code carrying the key through every path that readies an element.
const pinnedElement = new AsyncLocalStorage<string>()

/**
 * Sends one command through `dispatch` with every look that readies its element pinned to the node `key` names: a
 * look whose locator finds another node answers `moved`, which fails the command at once with no input sent. A command
 * that acts on no element, or only reads one, is refused with `usage` and sends nothing, since there is no node to hold
 * it to. The shared body of every driver's `dispatchTo`.
 *
 * @example return dispatchPinned(command, key, () => this.dispatch(command, timeoutMs, signal, commandToken))
 */
export function dispatchPinned(command: BrowserCommand, key: string, dispatch: () => Promise<DispatchedCommand>): Promise<DispatchedCommand> {
  const locator = command.kind === 'observe' || !('locator' in command) ? undefined : command.locator
  if (locator === undefined) {
    const message = `Retest pins only an action that sends input to an element it names by a locator, and this ${command.kind} is not one, so Retest sent nothing.`
    return Promise.resolve({ result: { ok: false, failure: { class: 'usage', message, details: { inputSent: false } } }, input: 'not_sent' })
  }
  return pinnedElement.run(key, dispatch)
}

/**
 * The key of the node the command now running is pinned to, inside `dispatchPinned`, or undefined. A driver passes it
 * to a page function of its own that must read only that node, as `locatorArguments`'s `pinned`.
 *
 * @example locatorArguments(locator, [choices], pinnedKey())
 */
export function pinnedKey(): string | undefined {
  return pinnedElement.getStore()
}

/**
 * Resolves the locator once and runs the checks an action needs, readying a field for `fill` and focusing the
 * element for `press`, or for one key of a `select`'s plan. Also names the document it looked at, which holds the
 * guard a ready element armed. A `select` that is not yet typing is only checked here, and planned. Inside
 * `dispatchPinned` the one match must be the pinned node.
 */
export function prepare(
  world: IsolatedWorld,
  locator: LocatorRecipe,
  intent: ActionIntent,
  deadline: Deadline,
): Promise<InDocument<Readiness>> {
  const pinned = pinnedElement.getStore()
  const asked = pinned === undefined ? pageIntent(intent) : { ...pageIntent(intent), element: pinned }
  return world.enter(prepareFunction, locatorArguments(locator, [asked]), readinessSchema, deadline)
}

/** Whether a select holds exactly the options its choices name, the labels of those it holds, and the page it is on. */
export type Selection = { status: 'selected' | 'other' | 'lost'; selected: string[]; page: PageFacts }

/** A selection as the page reads it, with the page's own address. */
export type PageSelection = { status: Selection['status']; selected: string[]; page: DocumentFacts }

export const pageSelectionSchema: Schema<PageSelection> = s.object({
  status: s.enum(['selected', 'other', 'lost']),
  selected: s.array(s.string()),
  page: pageFacts,
})

/**
 * A selection the page read, with the page's address cut to what Retest keeps.
 *
 * @example selectionOf({ status: 'selected', selected: ['Team'], page: { href: 'https://example.com/a?b', title: 'Pick' } }).page.url // 'https://example.com/a'
 */
export function selectionOf({ status, selected, page }: PageSelection): Selection {
  return { status, selected, page: pageFactsOf(page) }
}

/** The select a `select` typed to: its locator, the options it was asked to hold, and the document it is in. */
export type TypedSelect = { locator: LocatorRecipe; choices: readonly OptionChoiceRecord[]; document: number }

/**
 * Reads the selection of the one select the locator finds in the document the keys of a `select` went to, or
 * undefined once that document has gone: a select another document holds is never read in its place. Inside
 * `dispatchPinned` it reads the pinned select only, and another in its place is `lost`. Sends no input.
 */
export async function readSelection(world: IsolatedWorld, { locator, choices, document }: TypedSelect, deadline: Deadline): Promise<Selection | undefined> {
  try {
    return selectionOf(await world.callIn(document, selectionFunction, locatorArguments(locator, [choices], pinnedKey()), pageSelectionSchema, deadline))
  } catch (error) {
    if (isGoneContext(error)) return undefined
    throw error
  }
}

/**
 * Whether `document` set off for another document since the arming `token` began, or has gone already. A select's
 * next key goes only into a document that is staying. Sends no input.
 */
export async function pageSetOff(world: IsolatedWorld, { document, token }: { document: number; token: number }, deadline: Deadline): Promise<boolean> {
  try {
    return await world.callIn(document, setOffFunction, [token], s.boolean(), deadline)
  } catch (error) {
    if (isGoneContext(error)) return true
    throw error
  }
}

/**
 * Arms the guard for input that goes to the document the page holds now: a key for the page's keyboard, which goes
 * to whatever holds the focus there, with the keys it holds and presses, or the wheel at the centre of the viewport.
 * Ready as `prepare` is, in that document.
 */
export function armDocument(world: IsolatedWorld, action: DocumentAction, strokes: number, deadline: Deadline): Promise<InDocument<Extract<Readiness, { status: 'ready' }>>> {
  return world.enter(armDocumentFunction, [action, strokes], readySchema, deadline)
}

/**
 * Whether the one element the locator finds is checked, or null when no single such control is there. Inside
 * `dispatchPinned` it reads the pinned element only, and another in its place is null.
 */
export function readChecked(world: IsolatedWorld, locator: LocatorRecipe, deadline: Deadline): Promise<boolean | null> {
  return world.call(checkedFunction, locatorArguments(locator, [], pinnedKey()), s.nullable(s.boolean()), deadline)
}

/**
 * An action as failure messages name it, the way a test reads: a press names its key, a select its choices, and
 * a key for the page's keyboard or a wheel for the page has no element.
 *
 * @example describeAction({ action: 'press', key: 'Enter', strokes: 1, multiline: false }, { by: 'label', text: 'Search' }) // "press Enter on getByLabel('Search')"
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
    case 'select': {
      const typing = intent.typing === undefined ? {} : { typing: true, strokes: intent.typing.strokes }
      return { action: 'select', choices: intent.choices, multiple: intent.multiple, ...typing }
    }
    case 'press':
      return { action: 'press', strokes: intent.strokes }
    default:
      return { action: intent.action }
  }
}
