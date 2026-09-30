import { failureSchema, type Failure } from './failures.ts'
import { describeLocator, locatorRecipeSchema, stringLiteral, type LocatorRecipe } from './locator.ts'
import { s, type Schema } from './schema.ts'
import { secretRefSchema, type SecretRef } from './secret.ts'
import { shorten } from './text.ts'

/** What `fill` types: the text itself, or a secret the parent resolves. */
export type FillValue = string | SecretRef

/**
 * A page command from the child. `goto.url` is what the test passed; the parent resolves it against the
 * base URL. `press.key` is the key as the test wrote it, which `parseKey` reads; a `press` without a locator
 * goes to the page's keyboard, to whatever holds the focus. `observe` reads the page once and never waits.
 */
export type PageCommand =
  | { kind: 'goto'; url: string }
  | { kind: 'fill'; locator: LocatorRecipe; value: FillValue }
  | { kind: 'click'; locator: LocatorRecipe }
  | { kind: 'tap'; locator: LocatorRecipe }
  | { kind: 'press'; locator?: LocatorRecipe; key: string }
  | { kind: 'observe'; locator: LocatorRecipe }

export type ActionKind = Exclude<PageCommand['kind'], 'observe'>

/** How many matches an observation lists at most. */
export const observedItemLimit = 100

/** One match as an observation lists it. */
export type ObservedItem = { text: string; visible: boolean }

/**
 * What `observe` saw. `visible`, `text` and `value` are null unless exactly one element matched, and `value`
 * is also null when that element is not a field. `items` lists the first `observedItemLimit` matches in
 * document order, and `itemsTruncated` says when more matched than it lists.
 */
export type Observation = {
  count: number
  visible: boolean | null
  text: string | null
  value: string | null
  items: ObservedItem[]
  itemsTruncated: boolean
}

/**
 * The answer to a page command. After `goto`, `url` is the final page's origin and path. The parent gives each
 * observation it serves an id, `observationId`, which a locator assertion names as the look its verdict rested on.
 */
export type CommandResult =
  | { ok: true; kind: 'goto'; url: string }
  | { ok: true; kind: 'fill' | 'click' | 'tap' | 'press' }
  | { ok: true; kind: 'observe'; observation: Observation; observationId?: string }
  | { ok: false; failure: Failure }

const fillValueSchema: Schema<FillValue> = s.union([s.string(), secretRefSchema])

export const pageCommandSchema: Schema<PageCommand> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('goto'), url: s.string() }),
  s.object({ kind: s.literal('fill'), locator: locatorRecipeSchema, value: fillValueSchema }),
  s.object({ kind: s.literal('click'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('tap'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('press'), locator: s.optional(locatorRecipeSchema), key: s.string() }),
  s.object({ kind: s.literal('observe'), locator: locatorRecipeSchema }),
])

export const actionKindSchema: Schema<ActionKind> = s.enum(['goto', 'fill', 'click', 'tap', 'press'])

export const observationSchema: Schema<Observation> = s.object({
  count: s.number({ integer: true, min: 0 }),
  visible: s.nullable(s.boolean()),
  text: s.nullable(s.string()),
  value: s.nullable(s.string()),
  items: s.array(s.object({ text: s.string(), visible: s.boolean() })),
  itemsTruncated: s.boolean(),
})

export const commandResultSchema: Schema<CommandResult> = s.union([
  s.object({ ok: s.literal(true), kind: s.literal('goto'), url: s.string() }),
  s.object({ ok: s.literal(true), kind: s.enum(['fill', 'click', 'tap', 'press']) }),
  s.object({ ok: s.literal(true), kind: s.literal('observe'), observation: observationSchema, observationId: s.optional(s.string()) }),
  s.object({ ok: s.literal(false), failure: failureSchema }),
])

/**
 * Names a page command the way a test writes it. A `fill` value is never shown; a secret shows its name. A long
 * `press` key is cut short, as messages cut any text.
 *
 * @example describeCommand({ kind: 'click', locator: { by: 'testId', value: 'save-task' } }) // "getByTestId('save-task').click()"
 */
export function describeCommand(command: PageCommand): string {
  switch (command.kind) {
    case 'goto':
      return `page.goto(${JSON.stringify(command.url)})`
    case 'fill':
      return `${describeLocator(command.locator)}.fill(${describeFillValue(command.value)})`
    case 'click':
    case 'tap':
      return `${describeLocator(command.locator)}.${command.kind}()`
    case 'press': {
      const key = stringLiteral(shorten(command.key))
      return command.locator === undefined ? `page.keyboard.press(${key})` : `${describeLocator(command.locator)}.press(${key})`
    }
    case 'observe':
      return `a look at ${describeLocator(command.locator)}`
  }
}

function describeFillValue(value: FillValue): string {
  return typeof value === 'string' ? '' : `secret(${JSON.stringify(value.secret)})`
}
