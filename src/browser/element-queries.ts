import type { Point } from './input.ts'
import type { InDocument, IsolatedWorld } from './isolated-world.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { Schema } from '../protocol/schema.ts'
import { observationSchema, observedItemLimit } from '../protocol/commands.ts'
import { describeLocator } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { shorten } from '../protocol/text.ts'
import { locatorArguments } from './locate.ts'
import { armKeyboardFunction, observeFunction, prepareFunction } from './page-scripts.ts'

const checks = ['attached', 'visible', 'enabled', 'editable', 'stable', 'in-view', 'hit-target', 'focused'] as const

/** An actionability check, in the order `prepare` runs them after the element is found. */
export type Check = (typeof checks)[number]

/**
 * How one look at the page went for an action. `detail` describes what covers the element, when something does.
 * `token` names the input guard a ready element armed, and `point` is where to press it, or null for a key, which
 * goes to the focus. `refused` names the origin a fill bound to origins would have reached: the document's own,
 * or, when `leaving`, the one the page set off to open as the field took focus.
 */
export type Readiness =
  | { status: 'missing' }
  | { status: 'refused'; origin: string; leaving: boolean }
  | { status: 'ambiguous'; count: number }
  | { status: 'unsupported'; reason: 'field' | 'multiline'; field: string }
  | { status: 'blocked'; check: Check; detail: string | null }
  | { status: 'ready'; point: Point | null; token: number }

/**
 * An action on an element, as the page sends its input. `secret` names a `fill` value that is never shown, and
 * `allowedOrigins` are the only origins a `fill` may type into. A `press` names its key as the test wrote it.
 */
export type ActionIntent = { multiline: boolean; secret?: string; allowedOrigins?: readonly string[] } & (
  | { action: 'click' | 'tap' | 'fill' }
  | { action: 'press'; key: string }
)

const readinessSchema: Schema<Readiness> = s.discriminatedUnion('status', [
  s.object({ status: s.literal('missing') }),
  s.object({ status: s.literal('refused'), origin: s.string(), leaving: s.boolean() }),
  s.object({ status: s.literal('ambiguous'), count: s.number({ integer: true, min: 2 }) }),
  s.object({ status: s.literal('unsupported'), reason: s.enum(['field', 'multiline']), field: s.string() }),
  s.object({ status: s.literal('blocked'), check: s.enum(checks), detail: s.nullable(s.string()) }),
  s.object({ status: s.literal('ready'), point: s.nullable(s.object({ x: s.number(), y: s.number() })), token: s.number({ integer: true, min: 1 }) }),
])

/** Resolves the locator once and reads what an assertion needs. */
export function observe(world: IsolatedWorld, locator: LocatorRecipe, deadline: Deadline): Promise<Observation> {
  return world.call(observeFunction, locatorArguments(locator, [observedItemLimit]), observationSchema, deadline)
}

/**
 * Resolves the locator once and runs the checks an action needs, readying a field for `fill` and focusing the
 * element for `press`. Also names the document it looked at, which holds the guard a ready element armed.
 */
export function prepare(
  world: IsolatedWorld,
  locator: LocatorRecipe,
  intent: ActionIntent,
  deadline: Deadline,
): Promise<InDocument<Readiness>> {
  const args = locatorArguments(locator, [intent.action, intent.multiline, intent.allowedOrigins ?? null])
  return world.enter(prepareFunction, args, readinessSchema, deadline)
}

/**
 * Arms the guard for a key sent to the page's keyboard, in the document the page holds now: the key goes to
 * whatever holds the focus there. Returns the arming's token and the document it is in.
 */
export function armKeyboard(world: IsolatedWorld, deadline: Deadline): Promise<InDocument<number>> {
  return world.enter(armKeyboardFunction, [], s.number({ integer: true, min: 1 }), deadline)
}

/**
 * An action as failure messages name it, the way a test reads: a press names its key, and a key for the page's
 * keyboard has no element.
 *
 * @example describeAction({ action: 'press', key: 'Enter', multiline: false }, { by: 'label', text: 'Search' }) // "press Enter on getByLabel('Search')"
 */
export function describeAction(intent: ActionIntent, locator: LocatorRecipe | undefined): string {
  const verb = intent.action === 'press' ? `press ${shorten(intent.key)}` : intent.action
  if (locator === undefined) return verb
  return `${verb}${intent.action === 'press' ? ' on' : ''} ${describeLocator(locator)}`
}
