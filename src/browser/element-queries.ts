import type { InDocument, IsolatedWorld } from './isolated-world.ts'
import type { Observation } from '../protocol/commands.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { Schema } from '../protocol/schema.ts'
import { observationSchema } from '../protocol/commands.ts'
import { s } from '../protocol/schema.ts'
import { observeFunction, prepareFunction } from './page-scripts.ts'

const checks = ['attached', 'visible', 'enabled', 'editable', 'stable', 'in-view', 'hit-target', 'focused'] as const

/** An actionability check, in the order `prepare` runs them after the element is found. */
export type Check = (typeof checks)[number]

/**
 * How one look at the page went for an action. `detail` describes what covers the element, when something does.
 * `token` names the input guard a ready element armed.
 */
export type Readiness =
  | { status: 'missing' }
  | { status: 'ambiguous'; count: number }
  | { status: 'unsupported'; reason: 'field' | 'multiline'; field: string }
  | { status: 'blocked'; check: Check; detail: string | null }
  | { status: 'ready'; x: number; y: number; token: number }

export type ActionIntent = { action: 'click' | 'fill'; multiline: boolean }

const readinessSchema: Schema<Readiness> = s.discriminatedUnion('status', [
  s.object({ status: s.literal('missing') }),
  s.object({ status: s.literal('ambiguous'), count: s.number({ integer: true, min: 2 }) }),
  s.object({ status: s.literal('unsupported'), reason: s.enum(['field', 'multiline']), field: s.string() }),
  s.object({ status: s.literal('blocked'), check: s.enum(checks), detail: s.nullable(s.string()) }),
  s.object({ status: s.literal('ready'), x: s.number(), y: s.number(), token: s.number({ integer: true, min: 1 }) }),
])

/** Resolves the locator once and reads what an assertion needs. */
export function observe(world: IsolatedWorld, locator: LocatorRecipe, deadline: Deadline): Promise<Observation> {
  return world.call(observeFunction, [locator.value], observationSchema, deadline)
}

/**
 * Resolves the locator once and runs the checks an action needs, readying a field for `fill`. Also names the
 * document it looked at, which holds the guard a ready element armed.
 */
export function prepare(
  world: IsolatedWorld,
  locator: LocatorRecipe,
  intent: ActionIntent,
  deadline: Deadline,
): Promise<InDocument<Readiness>> {
  return world.enter(prepareFunction, [locator.value, intent.action, intent.multiline], readinessSchema, deadline)
}
