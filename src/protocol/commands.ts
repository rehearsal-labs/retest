import { describeDragArguments, dragThroughSchema, type DragThrough } from './drag.ts'
import { failureSchema, type Failure } from './failures.ts'
import { describeInputFiles, fileRecordSchema, inputFileRecordSchema, type FileRecord, type InputFileRecord } from './files.ts'
import { describeInboxReference, inboxCodeRefSchema, inboxLinkRefSchema, type InboxCodeRef, type InboxLinkRef } from './inbox.ts'
import { layoutLookSchema, type LayoutLook } from './layout.ts'
import { describeLocator, emptyStepSchema, locatorRecipeSchema, stringLiteral, type EmptyStep, type LocatorRecipe } from './locator.ts'
import { describeOptionChoice, describeOptionChoices, optionChoiceRecordSchema, type OptionChoiceRecord } from './option-choices.ts'
import { pageFactsSchema, type PageFacts } from './page-facts.ts'
import { s, type Schema } from './schema.ts'
import { screenshotLookSchema, type ScreenshotLook } from './screenshot.ts'
import { describeScrollDelta } from './scroll-delta.ts'
import { secretRefSchema, type SecretRef } from './secret.ts'
import { shorten } from './text.ts'

/** What `fill` types: the text itself, or a secret or a code from an inbox, which the parent resolves. */
export type FillValue = string | SecretRef | InboxCodeRef

/** Where `goto` goes: an address, or a link from an inbox, which the parent resolves. */
export type GotoTarget = string | InboxLinkRef

/**
 * A page command from the child. `goto.url` is what the test passed, an address the parent resolves against the
 * base URL, or a link from an inbox, which only the parent can read. `reload`, `goBack` and `goForward` reload the
 * page and move through its history. `press.key` is the key as the test wrote it, which `parseKey` reads; a `press`
 * without a locator goes to the page's keyboard, to whatever holds the focus. `select.choices` are the options to
 * choose, in the order the test named them, which `optionChoicesProblem` checks. `select.multiple` is present when
 * the test passed a list, which only a
 * `<select multiple>` takes, even a list of one. `scroll` turns the mouse wheel by `x` and `y` CSS pixels, which
 * `scrollProblem` checks: at the element's centre, or without a locator at the viewport's. `hover` moves the mouse to
 * the element's centre. `observe` reads a locator's elements once, and `observePage` the page's address and title. `observeLayout`
 * measures the page's layout once, with the one element `locator` finds and the one `other` finds, each when given,
 * and with how much of their words a container cuts off when `words` is set.
 * With `after`, a look first waits until the page's document has changed since `after.changes`, as the page counts
 * its changes, or until `after.waitMs` have passed, and never past its own time. `check` marks a look a check sends
 * while it polls, which reports an assertion once it ends; a plain read, such as `page.url()`, sends none.
 */
export type PageCommand =
  | { kind: 'goto'; url: GotoTarget }
  | { kind: 'reload' }
  | { kind: 'goBack' }
  | { kind: 'goForward' }
  | { kind: 'fill'; locator: LocatorRecipe; value: FillValue }
  | { kind: 'click'; locator: LocatorRecipe }
  | { kind: 'tap'; locator: LocatorRecipe }
  | { kind: 'hover'; locator: LocatorRecipe }
  | { kind: 'press'; locator?: LocatorRecipe; key: string }
  | { kind: 'select'; locator: LocatorRecipe; choices: OptionChoiceRecord[]; multiple?: true }
  | { kind: 'check'; locator: LocatorRecipe }
  | { kind: 'uncheck'; locator: LocatorRecipe }
  | { kind: 'scroll'; locator?: LocatorRecipe; x: number; y: number }
  /**
   * Gives a file input the files, as `inputFilesProblem` checks them, in place of those it held; none clears it.
   * `list` is present when the test passed a list, even of one or of none.
   */
  | { kind: 'setInputFiles'; locator: LocatorRecipe; files: InputFileRecord[]; list?: true }
  /** Gives the input of a file picker a `page.fileChooser()` caught the files, by the id the parent gave the picker. */
  | { kind: 'setChooserFiles'; chooser: string; files: InputFileRecord[]; list?: true }
  /**
   * Presses the mouse on the element `locator` finds, moves it through `steps` positions, 5 when absent, to the centre
   * of the element `target` finds, and releases it there; `dragProblem` checks `steps`.
   */
  | { kind: 'dragTo'; locator: LocatorRecipe; target: LocatorRecipe; steps?: number }
  | { kind: 'swipe'; locator?: LocatorRecipe; direction: 'up' | 'down' | 'left' | 'right' }
  | { kind: 'nativeKeyboard'; operation: 'dismiss' | 'dismissFirstRunCard' | 'wait' }
  | { kind: 'nativeAlert'; operation: 'accept' | 'dismiss'; button?: string }
  /** Closes a page the app opened, running its `beforeunload` handlers, and waits for it to go. */
  | { kind: 'close' }
  | { kind: 'observe'; locator: LocatorRecipe; after?: ObserveAfter; check?: true }
  | { kind: 'observePage'; after?: ObserveAfter; check?: true }
  | { kind: 'observeLayout'; locator?: LocatorRecipe; other?: LocatorRecipe; words?: true; after?: ObserveAfter; check?: true }
  /**
   * Takes a picture of the page's viewport, or of the one element `locator` finds, for `toHaveScreenshot`, and says how
   * it stands against the baseline `name`, counting pixels further apart than `threshold`. `previous` names the look
   * before it in the same check, whose picture this one must match to have settled.
   */
  | { kind: 'observeScreenshot'; locator?: LocatorRecipe; name: string; threshold?: number; previous?: string; check?: true }

/** What an `observe` waits for first: a change after the page's `changes` count, or `waitMs`, whichever comes first. */
export type ObserveAfter = { changes: number; waitMs: number }

/** The commands that act, as against the three that only look. */
export type ActionKind = Exclude<PageCommand['kind'], 'observe' | 'observePage' | 'observeLayout' | 'observeScreenshot'>

/** The actions that open a document in the page, as `goto` does, and answer with the address it ended on. */
export type NavigationKind = Extract<ActionKind, 'goto' | 'reload' | 'goBack' | 'goForward'>

/** The kinds of command that open a document. */
export const navigationKinds: readonly NavigationKind[] = ['goto', 'reload', 'goBack', 'goForward']

/**
 * Whether a command's kind opens a document, as `goto` does.
 *
 * @example isNavigationKind('goBack') // true
 */
export function isNavigationKind(kind: PageCommand['kind']): kind is NavigationKind {
  return navigationKinds.some((each) => each === kind)
}

/** How many matches an observation lists at most. */
export const observedItemLimit = 100

/** One match as an observation lists it. */
export type ObservedItem = { text: string; visible: boolean }

/**
 * What `observe` saw. `visible`, `text`, `value`, `checked` and `enabled` are null unless exactly one element
 * matched. `value` is also null when that element is not a field, and `checked` when it is not a checkbox, a radio
 * button or an element with a checkable role. `enabled` is false for a disabled native control, and for an element
 * whose nearest `aria-disabled`, on it or an ancestor, is true. `items` lists the first `observedItemLimit` matches
 * in document order, and `itemsTruncated` says when more matched than it lists. When nothing matched, `emptyStep`
 * names the first step of the locator that kept nothing.
 */
export type Observation = {
  count: number
  visible: boolean | null
  text: string | null
  value: string | null
  checked: boolean | null
  enabled: boolean | null
  selected?: boolean | null
  items: ObservedItem[]
  itemsTruncated: boolean
  emptyStep?: EmptyStep
}

/** A part of a look at the page: its address or its title. */
export type PageLookPart = 'url' | 'title'

/**
 * What `observePage` saw: the page's whole address and its title, as the page has them, each read up to
 * `titleReadLimit` code units, until the parent redacts both and cleans the title. Each is null when the page has
 * none, and the title while another document is on its way. `cut` names each part the page held more of than Retest
 * read, and `hidden`, which only the parent sets, each part that holds the placeholder of a secret it hid.
 */
export type PageObservation = { url: string | null; title: string | null; cut?: PageLookPart[]; hidden?: PageLookPart[] }

/**
 * The answer to a page command. After `goto`, `reload`, `goBack` or `goForward`, `url` is the final page's origin and
 * path, and `firstFrame` is false when the page had drawn no frame by the time Retest stopped waiting for one; it is
 * left out when the page was drawn, and by an engine that does not wait. `observePage` carries the app's base URL,
 * its origin and path, in `baseUrl`, when the app has one. `page` is the page the command went to, as the browser
 * read it. `changed` is false when the element already was as a
 * `select`, `check` or `uncheck` asked, and nothing was sent. `via: 'label'` marks a `check` or `uncheck` that clicked
 * the control's own label, because the control is hidden. The parent gives each observation it serves an id,
 * `observationId`, and names the session that served it, `sessionId`; a locator or page assertion sends both back to
 * name the look its verdict rested on. `changes` is how many times the page's document had changed when the look was
 * taken, as the page counts them, so the next look can wait for the next change; a page that does not count them
 * leaves it out. `waitedMs` is how long the look waited first.
 */
export type CommandResult =
  | { ok: true; kind: NavigationKind; url: string; page?: PageFacts; firstFrame?: boolean }
  | { ok: true; kind: 'fill' | 'click' | 'tap' | 'hover' | 'press' | 'scroll' | 'swipe' | 'nativeKeyboard' | 'nativeAlert'; page?: PageFacts }
  | { ok: true; kind: 'select'; changed: boolean; page?: PageFacts }
  | { ok: true; kind: 'check' | 'uncheck'; changed: boolean; via?: 'label'; page?: PageFacts }
  /** The page closed, so it names no page. */
  | { ok: true; kind: 'close'; page?: PageFacts }
  /**
   * The files the input's `change` carried, as the browser read them, and in `kept` what the input holds once the page's
   * own listeners ran, when that differs, as when a page clears an input it has read. A page that read nothing back
   * leaves both out.
   */
  | { ok: true; kind: 'setInputFiles' | 'setChooserFiles'; files?: FileRecord[]; kept?: FileRecord[]; page?: PageFacts }
  /** A drag that dropped on its target: through mouse events alone, or through the browser's drag events. */
  | { ok: true; kind: 'dragTo'; through: DragThrough; page?: PageFacts }
  | {
      ok: true
      kind: 'observe'
      observation: Observation
      observationId?: string
      sessionId?: string
      changes?: number
      waitedMs?: number
      page?: PageFacts
    }
  | {
      ok: true
      kind: 'observePage'
      observation: PageObservation
      baseUrl?: string
      observationId?: string
      sessionId?: string
      changes?: number
      waitedMs?: number
      page?: PageFacts
    }
  | {
      ok: true
      kind: 'observeLayout'
      observation: LayoutLook
      observationId?: string
      sessionId?: string
      changes?: number
      waitedMs?: number
      page?: PageFacts
    }
  | { ok: true; kind: 'observeScreenshot'; observation: ScreenshotLook; observationId?: string; sessionId?: string; page?: PageFacts }
  | { ok: false; failure: Failure }

const fillValueSchema: Schema<FillValue> = s.union([s.string(), secretRefSchema, inboxCodeRefSchema])

const after = s.optional(s.object({ changes: s.number({ integer: true, min: 0 }), waitMs: s.number({ integer: true, min: 0 }) }))

export const pageCommandSchema: Schema<PageCommand> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('goto'), url: s.union([s.string(), inboxLinkRefSchema]) }),
  s.object({ kind: s.literal('reload') }),
  s.object({ kind: s.literal('goBack') }),
  s.object({ kind: s.literal('goForward') }),
  s.object({ kind: s.literal('fill'), locator: locatorRecipeSchema, value: fillValueSchema }),
  s.object({ kind: s.literal('click'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('tap'), locator: locatorRecipeSchema }),
  s.object({ kind: s.literal('hover'), locator: locatorRecipeSchema }),
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
  s.object({ kind: s.literal('setInputFiles'), locator: locatorRecipeSchema, files: s.array(inputFileRecordSchema), list: s.optional(s.literal(true)) }),
  s.object({ kind: s.literal('setChooserFiles'), chooser: s.string(), files: s.array(inputFileRecordSchema), list: s.optional(s.literal(true)) }),
  s.object({ kind: s.literal('dragTo'), locator: locatorRecipeSchema, target: locatorRecipeSchema, steps: s.optional(s.number({ integer: true, min: 1 })) }),
  s.object({ kind: s.literal('swipe'), locator: s.optional(locatorRecipeSchema), direction: s.enum(['up', 'down', 'left', 'right']) }),
  s.object({ kind: s.literal('nativeKeyboard'), operation: s.enum(['dismiss', 'dismissFirstRunCard', 'wait']) }),
  s.object({ kind: s.literal('nativeAlert'), operation: s.enum(['accept', 'dismiss']), button: s.optional(s.string()) }),
  s.object({ kind: s.literal('close') }),
  s.object({ kind: s.literal('observe'), locator: locatorRecipeSchema, after, check: s.optional(s.literal(true)) }),
  s.object({ kind: s.literal('observePage'), after, check: s.optional(s.literal(true)) }),
  s.object({
    kind: s.literal('observeLayout'),
    locator: s.optional(locatorRecipeSchema),
    other: s.optional(locatorRecipeSchema),
    words: s.optional(s.literal(true)),
    after,
    check: s.optional(s.literal(true)),
  }),
  s.object({
    kind: s.literal('observeScreenshot'),
    locator: s.optional(locatorRecipeSchema),
    name: s.string(),
    threshold: s.optional(s.number({ min: 0 })),
    previous: s.optional(s.string()),
    check: s.optional(s.literal(true)),
  }),
])

export const actionKindSchema: Schema<ActionKind> = s.enum([
  'goto',
  'reload',
  'goBack',
  'goForward',
  'fill',
  'click',
  'tap',
  'hover',
  'press',
  'select',
  'check',
  'uncheck',
  'scroll',
  'swipe',
  'nativeKeyboard',
  'nativeAlert',
  'close',
  'setInputFiles',
  'setChooserFiles',
  'dragTo',
])

export const observationSchema: Schema<Observation> = s.object({
  count: s.number({ integer: true, min: 0 }),
  visible: s.nullable(s.boolean()),
  text: s.nullable(s.string()),
  value: s.nullable(s.string()),
  checked: s.nullable(s.boolean()),
  enabled: s.nullable(s.boolean()),
  selected: s.optional(s.nullable(s.boolean())),
  items: s.array(s.object({ text: s.string(), visible: s.boolean() })),
  itemsTruncated: s.boolean(),
  emptyStep: s.optional(emptyStepSchema),
})

const pageLookPartSchema: Schema<PageLookPart> = s.enum(['url', 'title'])

export const pageObservationSchema: Schema<PageObservation> = s.object({
  url: s.nullable(s.string()),
  title: s.nullable(s.string()),
  cut: s.optional(s.array(pageLookPartSchema)),
  hidden: s.optional(s.array(pageLookPartSchema)),
})

const page = s.optional(pageFactsSchema)

export const commandResultSchema: Schema<CommandResult> = s.union([
  s.object({ ok: s.literal(true), kind: s.enum(['goto', 'reload', 'goBack', 'goForward']), url: s.string(), page, firstFrame: s.optional(s.boolean()) }),
  s.object({ ok: s.literal(true), kind: s.enum(['fill', 'click', 'tap', 'hover', 'press', 'scroll', 'swipe', 'nativeKeyboard', 'nativeAlert']), page }),
  s.object({ ok: s.literal(true), kind: s.literal('select'), changed: s.boolean(), page }),
  s.object({ ok: s.literal(true), kind: s.enum(['check', 'uncheck']), changed: s.boolean(), via: s.optional(s.literal('label')), page }),
  s.object({ ok: s.literal(true), kind: s.literal('close'), page }),
  s.object({ ok: s.literal(true), kind: s.enum(['setInputFiles', 'setChooserFiles']), files: s.optional(s.array(fileRecordSchema)), kept: s.optional(s.array(fileRecordSchema)), page }),
  s.object({ ok: s.literal(true), kind: s.literal('dragTo'), through: dragThroughSchema, page }),
  s.object({
    ok: s.literal(true),
    kind: s.literal('observe'),
    observation: observationSchema,
    observationId: s.optional(s.string()),
    sessionId: s.optional(s.string()),
    changes: s.optional(s.number({ integer: true, min: 0 })),
    waitedMs: s.optional(s.number({ integer: true, min: 0 })),
    page,
  }),
  s.object({
    ok: s.literal(true),
    kind: s.literal('observePage'),
    observation: pageObservationSchema,
    baseUrl: s.optional(s.string()),
    observationId: s.optional(s.string()),
    sessionId: s.optional(s.string()),
    changes: s.optional(s.number({ integer: true, min: 0 })),
    waitedMs: s.optional(s.number({ integer: true, min: 0 })),
    page,
  }),
  s.object({
    ok: s.literal(true),
    kind: s.literal('observeLayout'),
    observation: layoutLookSchema,
    observationId: s.optional(s.string()),
    sessionId: s.optional(s.string()),
    changes: s.optional(s.number({ integer: true, min: 0 })),
    waitedMs: s.optional(s.number({ integer: true, min: 0 })),
    page,
  }),
  s.object({
    ok: s.literal(true),
    kind: s.literal('observeScreenshot'),
    observation: screenshotLookSchema,
    observationId: s.optional(s.string()),
    sessionId: s.optional(s.string()),
    page,
  }),
  s.object({ ok: s.literal(false), failure: failureSchema }),
])

/**
 * Names a page command the way a test writes it. A `fill` value is never shown; a secret shows its name, and a code
 * or a link from an inbox its placeholder. A long `press` key or option is cut short, as messages cut any text.
 *
 * @example describeCommand({ kind: 'click', locator: { by: 'testId', value: 'save-task' } }) // "getByTestId('save-task').click()"
 */
export function describeCommand(command: PageCommand): string {
  switch (command.kind) {
    case 'goto':
      return `page.goto(${typeof command.url === 'string' ? JSON.stringify(command.url) : describeInboxReference(command.url)})`
    case 'reload':
    case 'goBack':
    case 'goForward':
      return `page.${command.kind}()`
    case 'fill':
      return `${describeLocator(command.locator)}.fill(${describeFillValue(command.value)})`
    case 'click':
    case 'tap':
    case 'hover':
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
    case 'setInputFiles':
      return `${describeLocator(command.locator)}.setInputFiles(${describeInputFiles(command.files, command.list === true)})`
    case 'dragTo':
      return `${describeLocator(command.locator)}.dragTo(${describeDragArguments(command)})`
    case 'setChooserFiles':
      return `fileChooser.setFiles(${describeInputFiles(command.files, command.list === true)})`
    case 'swipe':
      return `${command.locator === undefined ? 'page' : describeLocator(command.locator)}.swipe(${stringLiteral(command.direction)})`
    case 'nativeKeyboard':
      return `page.keyboard.${command.operation}()`
    case 'nativeAlert':
      return `page.alert.${command.operation}(${command.button === undefined ? '' : stringLiteral(command.button)})`
    case 'close':
      return 'page.close()'
    case 'observe':
      return `a look at ${describeLocator(command.locator)}`
    case 'observePage':
      return 'a look at the page'
    case 'observeLayout': {
      const { locator, other } = command
      if (locator === undefined) return "a look at the page's layout"
      return `a look at the layout of ${describeLocator(locator)}${other === undefined ? '' : ` and ${describeLocator(other)}`}`
    }
    case 'observeScreenshot':
      return command.locator === undefined ? 'a picture of the page' : `a picture of ${describeLocator(command.locator)}`
  }
}

function describeFillValue(value: FillValue): string {
  if (typeof value === 'string') return ''
  return 'secret' in value ? `secret(${JSON.stringify(value.secret)})` : describeInboxReference(value)
}

/**
 * Every locator a command names: the one an action or a look acts on, the other element a layout look measures, the
 * element a drag drops on, and the element of each frame either is inside, before it.
 *
 * @example commandLocators({ kind: 'observeLayout', locator: save, other: help }) // [save, help]
 */
export function commandLocators(command: PageCommand): LocatorRecipe[] {
  const own = 'locator' in command && command.locator !== undefined ? [command.locator] : []
  const named = command.kind === 'observeLayout' && command.other !== undefined ? [...own, command.other] : command.kind === 'dragTo' ? [...own, command.target] : own
  return named.flatMap((locator) => [...(locator.frame ?? []), locator])
}
