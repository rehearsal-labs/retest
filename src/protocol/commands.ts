import { failureSchema, type Failure } from './failures.ts'
import { describeLocator, locatorRecipeSchema, stringLiteral, type LocatorRecipe } from './locator.ts'
import { describeOptionChoice, describeOptionChoices, optionChoiceRecordSchema, type OptionChoiceRecord } from './option-choices.ts'
import { pageFactsSchema, type PageFacts } from './page-facts.ts'
import { s, type Schema } from './schema.ts'
import { describeScrollDelta } from './scroll-delta.ts'
import { secretRefSchema, type SecretRef } from './secret.ts'
import { shorten } from './text.ts'

/** What `fill` types: the text itself, or a secret the parent resolves. */
export type FillValue = string | SecretRef

/**
 * A page command from the child. `goto.url` is what the test passed; the parent resolves it against the
 * base URL. `press.key` is the key as the test wrote it, which `parseKey` reads; a `press` without a locator
 * goes to the page's keyboard, to whatever holds the focus. `select.choices` are the options to choose, in the
 * order the test named them, which `optionChoicesProblem` checks. `select.multiple` is present when the test passed
 * a list, which only a `<select multiple>` takes, even a list of one. `scroll` turns the mouse wheel by `x` and `y`
 * CSS pixels, which `scrollProblem` checks: at the element's centre, or without a locator at the viewport's.
 * `observe` reads the page once. With `after`, it first waits until the page's document has changed since
 * `after.changes`, as the page counts its changes, or until `after.waitMs` have passed, and never past its own time.
 */
export type PageCommand =
  | { kind: 'goto'; url: string }
  | { kind: 'fill'; locator: LocatorRecipe; value: FillValue }
  | { kind: 'click'; locator: LocatorRecipe }
  | { kind: 'tap'; locator: LocatorRecipe }
  | { kind: 'press'; locator?: LocatorRecipe; key: string }
  | { kind: 'select'; locator: LocatorRecipe; choices: OptionChoiceRecord[]; multiple?: true }
  | { kind: 'check'; locator: LocatorRecipe }
  | { kind: 'uncheck'; locator: LocatorRecipe }
  | { kind: 'scroll'; locator?: LocatorRecipe; x: number; y: number }
  | { kind: 'observe'; locator: LocatorRecipe; after?: ObserveAfter }

/** What an `observe` waits for first: a change after the page's `changes` count, or `waitMs`, whichever comes first. */
export type ObserveAfter = { changes: number; waitMs: number }

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
 * The answer to a page command. After `goto`, `url` is the final page's origin and path. `page` is the page the
 * command went to, as the browser read it. `changed` is false when the element already was as a `select`,
 * `check` or `uncheck` asked, and nothing was sent. `via: 'label'` marks a `check` or `uncheck` that clicked the
 * control's own label, because the control is hidden. The parent gives each observation it serves an id,
 * `observationId`, which a locator assertion names as the look its verdict rested on. `changes` is how many times
 * the page's document had changed when the look was taken, as the page counts them, so the next look can wait for
 * the next change; a page that does not count them leaves it out. `waitedMs` is how long the look waited first.
 */
export type CommandResult =
  | { ok: true; kind: 'goto'; url: string; page?: PageFacts }
  | { ok: true; kind: 'fill' | 'click' | 'tap' | 'press' | 'scroll'; page?: PageFacts }
  | { ok: true; kind: 'select'; changed: boolean; page?: PageFacts }
  | { ok: true; kind: 'check' | 'uncheck'; changed: boolean; via?: 'label'; page?: PageFacts }
  | { ok: true; kind: 'observe'; observation: Observation; observationId?: string; changes?: number; waitedMs?: number; page?: PageFacts }
  | { ok: false; failure: Failure }

const fillValueSchema: Schema<FillValue> = s.union([s.string(), secretRefSchema])

export const pageCommandSchema: Schema<PageCommand> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('goto'), url: s.string() }),
  s.object({ kind: s.literal('fill'), locator: locatorRecipeSchema, value: fillValueSchema }),
  s.object({ kind: s.literal('click'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('tap'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('press'), locator: s.optional(locatorRecipeSchema), key: s.string() }),
  s.object({
    kind: s.literal('select'),
    locator: locatorRecipeSchema,
    choices: s.array(optionChoiceRecordSchema),
    multiple: s.optional(s.literal(true)),
  }),
  s.object({ kind: s.literal('check'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('uncheck'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('scroll'), locator: s.optional(locatorRecipeSchema), x: s.number(), y: s.number() }),
  s.object({
    kind: s.literal('observe'),
    locator: locatorRecipeSchema,
    after: s.optional(s.object({ changes: s.number({ integer: true, min: 0 }), waitMs: s.number({ integer: true, min: 0 }) })),
  }),
])

export const actionKindSchema: Schema<ActionKind> = s.enum(['goto', 'fill', 'click', 'tap', 'press', 'select', 'check', 'uncheck', 'scroll'])

export const observationSchema: Schema<Observation> = s.object({
  count: s.number({ integer: true, min: 0 }),
  visible: s.nullable(s.boolean()),
  text: s.nullable(s.string()),
  value: s.nullable(s.string()),
  items: s.array(s.object({ text: s.string(), visible: s.boolean() })),
  itemsTruncated: s.boolean(),
})

const page = s.optional(pageFactsSchema)

export const commandResultSchema: Schema<CommandResult> = s.union([
  s.object({ ok: s.literal(true), kind: s.literal('goto'), url: s.string(), page }),
  s.object({ ok: s.literal(true), kind: s.enum(['fill', 'click', 'tap', 'press', 'scroll']), page }),
  s.object({ ok: s.literal(true), kind: s.literal('select'), changed: s.boolean(), page }),
  s.object({ ok: s.literal(true), kind: s.enum(['check', 'uncheck']), changed: s.boolean(), via: s.optional(s.literal('label')), page }),
  s.object({
    ok: s.literal(true),
    kind: s.literal('observe'),
    observation: observationSchema,
    observationId: s.optional(s.string()),
    changes: s.optional(s.number({ integer: true, min: 0 })),
    waitedMs: s.optional(s.number({ integer: true, min: 0 })),
    page,
  }),
  s.object({ ok: s.literal(false), failure: failureSchema }),
])

/**
 * Names a page command the way a test writes it. A `fill` value is never shown; a secret shows its name. A long
 * `press` key or option is cut short, as messages cut any text.
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
    case 'check':
    case 'uncheck':
      return `${describeLocator(command.locator)}.${command.kind}()`
    case 'press': {
      const key = stringLiteral(shorten(command.key))
      return command.locator === undefined ? `page.keyboard.press(${key})` : `${describeLocator(command.locator)}.press(${key})`
    }
    case 'select': {
      const { choices } = command
      const described = command.multiple === true ? `[${choices.map(describeOptionChoice).join(', ')}]` : describeOptionChoices(choices)
      return `${describeLocator(command.locator)}.select(${described})`
    }
    case 'scroll': {
      const target = command.locator === undefined ? 'page' : describeLocator(command.locator)
      return `${target}.scroll(${describeScrollDelta(command)})`
    }
    case 'observe':
      return `a look at ${describeLocator(command.locator)}`
  }
}

function describeFillValue(value: FillValue): string {
  return typeof value === 'string' ? '' : `secret(${JSON.stringify(value.secret)})`
}
