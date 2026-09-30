import { failureSchema, type Failure } from './failures.ts'
import { describeLocator, locatorRecipeSchema, type LocatorRecipe } from './locator.ts'
import { s, type Schema } from './schema.ts'

/**
 * A page command from the child. `goto.url` is what the test passed; the parent resolves it against the
 * base URL. `observe` reads the page once and never waits.
 */
export type PageCommand =
  | { kind: 'goto'; url: string }
  | { kind: 'fill'; locator: LocatorRecipe; value: string }
  | { kind: 'click'; locator: LocatorRecipe }
  | { kind: 'observe'; locator: LocatorRecipe }

export type ActionKind = Exclude<PageCommand['kind'], 'observe'>

/** What `observe` saw. `visible` and `text` are null unless exactly one element matched. */
export type Observation = { count: number; visible: boolean | null; text: string | null }

/** The answer to a page command. After `goto`, `url` is the final page's origin and path. */
export type CommandResult =
  | { ok: true; kind: 'goto'; url: string }
  | { ok: true; kind: 'fill' | 'click' }
  | { ok: true; kind: 'observe'; observation: Observation }
  | { ok: false; failure: Failure }

export const pageCommandSchema: Schema<PageCommand> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('goto'), url: s.string() }),
  s.object({ kind: s.literal('fill'), locator: locatorRecipeSchema, value: s.string() }),
  s.object({ kind: s.literal('click'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('observe'), locator: locatorRecipeSchema }),
])

export const actionKindSchema: Schema<ActionKind> = s.enum(['goto', 'fill', 'click'])

export const observationSchema: Schema<Observation> = s.object({
  count: s.number({ integer: true, min: 0 }),
  visible: s.nullable(s.boolean()),
  text: s.nullable(s.string()),
})

export const commandResultSchema: Schema<CommandResult> = s.union([
  s.object({ ok: s.literal(true), kind: s.literal('goto'), url: s.string() }),
  s.object({ ok: s.literal(true), kind: s.enum(['fill', 'click']) }),
  s.object({ ok: s.literal(true), kind: s.literal('observe'), observation: observationSchema }),
  s.object({ ok: s.literal(false), failure: failureSchema }),
])

/**
 * Names a page command the way a test writes it. A `fill` value is never shown.
 *
 * @example describeCommand({ kind: 'click', locator: { by: 'testId', value: 'save-task' } }) // "getByTestId('save-task').click()"
 */
export function describeCommand(command: PageCommand): string {
  switch (command.kind) {
    case 'goto':
      return `page.goto(${JSON.stringify(command.url)})`
    case 'fill':
      return `${describeLocator(command.locator)}.fill()`
    case 'click':
      return `${describeLocator(command.locator)}.click()`
    case 'observe':
      return `a look at ${describeLocator(command.locator)}`
  }
}
