import type { Failure } from './failures.ts'
import { ariaRoles, type AriaRole } from './aria-role.ts'
import { s, type Schema } from './schema.ts'
import { quoteText } from './text.ts'

/** A regular expression as a recipe carries it: its source and its flags, as a `RegExp` gives them. */
export type TextPattern = { pattern: string; flags: string }

/** What a locator's name or text is compared with: a string, read as `exact` says, or a pattern searched for in it. */
export type TextMatch = string | TextPattern

/** Which of a step's matches it keeps: the first, the last, or the one at an index from 0, counted from the end when negative. */
export type LocatorPick = 'first' | 'last' | number

/**
 * One step of a recipe: how to find elements, and which of them to keep. `name` and `text` match with whitespace
 * normalised: `exact`, the default, is a case-sensitive match on the whole string, and `exact: false` a
 * case-insensitive substring match. A pattern is searched for in the normalised text with its own flags, and takes
 * no `exact`. `css` is a CSS selector, matched as `querySelectorAll` matches it.
 */
export type LocatorStep =
  | { by: 'testId'; value: string; pick?: LocatorPick }
  | { by: 'role'; role: AriaRole; name?: TextMatch; exact?: boolean; pick?: LocatorPick }
  | { by: 'label'; text: TextMatch; exact?: boolean; pick?: LocatorPick }
  | { by: 'text'; text: TextMatch; exact?: boolean; pick?: LocatorPick }
  | { by: 'placeholder'; text: TextMatch; exact?: boolean; pick?: LocatorPick }
  | { by: 'css'; selector: string; pick?: LocatorPick }

/** Whose rules a recipe finds by where Retest's own differ: Playwright's, for a test file Retest runs under `--playwright`. */
export type LocatorDialect = 'playwright'

/**
 * The `<iframe>` or `<frame>` element of a frame, found as a locator finds an element: its last step, and in `within`
 * the steps it is scoped to, in the document of the frame around it.
 */
export type FrameRecipe = LocatorStep & { within?: LocatorStep[] }

/**
 * How to find an element again: its last step, and in `within` the steps it is scoped to, outermost first. Each step
 * after the first finds elements inside those the step before it kept, never those elements themselves. A recipe
 * without `within` or `pick` is the flat recipe Retest has always written. With `dialect: 'playwright'`, `getByLabel`
 * also finds any element whose `aria-label` or `aria-labelledby` names it, as Playwright's does. `frame` names the
 * frames the element is inside, outermost first, each by the element that holds it in the document before; a recipe
 * without it finds in the page's own document. Every step looks through open shadow roots.
 */
export type LocatorRecipe = LocatorStep & { within?: LocatorStep[]; dialect?: LocatorDialect; frame?: FrameRecipe[] }

const exact = s.optional(s.boolean())
const pick = s.optional(s.union([s.literal('first'), s.literal('last'), s.number({ integer: true })]))

export const textPatternSchema: Schema<TextPattern> = s.object({ pattern: s.string(), flags: s.string() })

const textMatch = s.union([s.string(), textPatternSchema])

const testIdStep = { by: s.literal('testId'), value: s.string(), pick }
const roleStep = { by: s.literal('role'), role: s.enum(ariaRoles), name: s.optional(textMatch), exact, pick }
const labelStep = { by: s.literal('label'), text: textMatch, exact, pick }
const textStep = { by: s.literal('text'), text: textMatch, exact, pick }
const placeholderStep = { by: s.literal('placeholder'), text: textMatch, exact, pick }
const cssStep = { by: s.literal('css'), selector: s.string(), pick }

export const locatorStepSchema: Schema<LocatorStep> = s.discriminatedUnion('by', [
  s.object(testIdStep),
  s.object(roleStep),
  s.object(labelStep),
  s.object(textStep),
  s.object(placeholderStep),
  s.object(cssStep),
])

const within = s.optional(s.array(locatorStepSchema))
const dialect = s.optional(s.literal('playwright'))

export const frameRecipeSchema: Schema<FrameRecipe> = s.discriminatedUnion('by', [
  s.object({ ...testIdStep, within }),
  s.object({ ...roleStep, within }),
  s.object({ ...labelStep, within }),
  s.object({ ...textStep, within }),
  s.object({ ...placeholderStep, within }),
  s.object({ ...cssStep, within }),
])

const frame = s.optional(s.array(frameRecipeSchema))

export const locatorRecipeSchema: Schema<LocatorRecipe> = s.discriminatedUnion('by', [
  s.object({ ...testIdStep, within, dialect, frame }),
  s.object({ ...roleStep, within, dialect, frame }),
  s.object({ ...labelStep, within, dialect, frame }),
  s.object({ ...textStep, within, dialect, frame }),
  s.object({ ...placeholderStep, within, dialect, frame }),
  s.object({ ...cssStep, within, dialect, frame }),
])

/**
 * The steps of a recipe in the order the page resolves them, outermost first, each without `within`.
 *
 * @example locatorSteps({ by: 'text', text: 'Save', within: [{ by: 'testId', value: 'dialog' }] }).length // 2
 */
export function locatorSteps(recipe: LocatorRecipe): LocatorStep[] {
  const { within: scope, dialect: _dialect, frame: _frame, ...last } = recipe
  return [...(scope ?? []), last]
}

/**
 * Every step a recipe matches against a page, those of the frames it is in first, then its own: what a guard that reads
 * a recipe's text, such as the refusal of a secret's value, must read whole.
 *
 * @example everyStep({ by: 'text', text: 'Paid', frame: [{ by: 'css', selector: '#pay' }] }).length // 2
 */
export function everyStep(recipe: LocatorRecipe): LocatorStep[] {
  return [...(recipe.frame ?? []).flatMap(locatorSteps), ...locatorSteps(recipe)]
}

/**
 * The frame path of a frame whose element `locator` finds: the frames that element is inside, then the element itself.
 *
 * @example framePathOf({ by: 'css', selector: 'iframe', frame: [{ by: 'testId', value: 'outer' }] }).length // 2
 */
export function framePathOf(locator: LocatorRecipe): FrameRecipe[] {
  const { dialect: _dialect, frame: path, ...element } = locator
  return [...(path ?? []), element]
}

/**
 * A frame's element as a recipe of its own, found by the rules of the locator whose path holds it.
 *
 * @example frameLocator({ by: 'css', selector: 'iframe' }, { by: 'text', text: 'Pay', dialect: 'playwright' }).dialect // 'playwright'
 */
export function frameLocator(frame: FrameRecipe, locator: LocatorRecipe): LocatorRecipe {
  return locator.dialect === undefined ? frame : { ...frame, dialect: locator.dialect }
}

/**
 * Whether two frame paths name the same frames, step for step: two recipes without one are both the page itself.
 *
 * @example sameFramePath(undefined, []) // true
 */
export function sameFramePath(first: readonly FrameRecipe[] | undefined, second: readonly FrameRecipe[] | undefined): boolean {
  return JSON.stringify(first ?? []) === JSON.stringify(second ?? [])
}

/**
 * Writes a recipe as the calls that make it. `exact` is written only when it is false, since true is the default; by
 * Playwright's rules, where false is the default, only when it is true.
 *
 * @example describeLocator({ by: 'role', role: 'button', name: 'Save' }) // "getByRole('button', { name: 'Save' })"
 * @example describeLocator({ by: 'role', role: 'listitem', pick: 'last', within: [{ by: 'testId', value: 'tasks' }] }) // "getByTestId('tasks').getByRole('listitem').last()"
 * @example describeLocator({ by: 'label', text: 'Card number', frame: [{ by: 'css', selector: 'iframe#pay' }] }) // "frame(locator('iframe#pay')).getByLabel('Card number')"
 */
export function describeLocator(recipe: LocatorRecipe): string {
  return `${describeFrames(recipe.frame ?? [], recipe.dialect)}${describeSteps(locatorSteps(recipe), recipe.dialect)}`
}

/**
 * Writes a frame path as the calls that reach it, each frame by its element's locator, with the dot that follows, or
 * nothing for the page itself.
 *
 * @example describeFrames([{ by: 'css', selector: 'iframe#pay' }]) // "frame(locator('iframe#pay'))."
 */
export function describeFrames(path: readonly FrameRecipe[], dialect?: LocatorDialect): string {
  return path.map((frame) => `frame(${describeSteps(locatorSteps(frame), dialect)}).`).join('')
}

function describeSteps(steps: readonly LocatorStep[], dialect: LocatorDialect | undefined): string {
  return steps.map((step, index) => `${index === 0 ? '' : '.'}${describeStep(step, dialect)}`).join('')
}

/**
 * Writes one step as the call that makes it, with the pick that follows it.
 *
 * @example describeStep({ by: 'css', selector: '.task', pick: 2 }) // "locator('.task').nth(2)"
 */
export function describeStep(step: LocatorStep, dialect?: LocatorDialect): string {
  return `${describeFinder(step, dialect)}${describePick(step.pick)}`
}

function describeFinder(step: LocatorStep, dialect: LocatorDialect | undefined): string {
  switch (step.by) {
    case 'testId':
      return `getByTestId(${stringLiteral(step.value)})`
    case 'role':
      return `getByRole(${stringLiteral(step.role)}${describeOptions(step.name, step.exact, dialect)})`
    case 'label':
      return `getByLabel(${describeTextMatch(step.text)}${describeOptions(undefined, step.exact, dialect)})`
    case 'text':
      return `getByText(${describeTextMatch(step.text)}${describeOptions(undefined, step.exact, dialect)})`
    case 'placeholder':
      return `getByPlaceholder(${describeTextMatch(step.text)}${describeOptions(undefined, step.exact, dialect)})`
    case 'css':
      return `locator(${stringLiteral(step.selector)})`
  }
}

function describePick(choice: LocatorPick | undefined): string {
  if (choice === undefined) return ''
  return typeof choice === 'number' ? `.nth(${choice})` : `.${choice}()`
}

function describeOptions(name: TextMatch | undefined, exact: boolean | undefined, dialect: LocatorDialect | undefined): string {
  const written = dialect === 'playwright' ? exact === true : exact === false
  const options = [...(name === undefined ? [] : [`name: ${describeTextMatch(name)}`]), ...(written ? [`exact: ${String(exact)}`] : [])]
  return options.length === 0 ? '' : `, { ${options.join(', ')} }`
}

/**
 * Writes text as a test writes it: a string as a single-quoted string, a pattern as a regular expression literal.
 *
 * @example describeTextMatch({ pattern: '^Save', flags: 'i' }) // '/^Save/i'
 */
export function describeTextMatch(text: TextMatch): string {
  return typeof text === 'string' ? stringLiteral(text) : `/${text.pattern}/${text.flags}`
}

/**
 * A `RegExp` as a recipe or a check carries it. `source` already escapes each slash, so it writes back as it was.
 *
 * @example textPatternOf(/^save/i) // { pattern: '^save', flags: 'i' }
 */
export function textPatternOf(regex: RegExp): TextPattern {
  return { pattern: regex.source, flags: regex.flags }
}

/**
 * Whether a pattern finds a match anywhere in the text, with its own flags. A new expression each time, so a `g` or
 * `y` flag never carries a position from one text to the next.
 *
 * @example patternMatches('Saved 3 tasks', { pattern: '\\d tasks', flags: '' }) // true
 */
export function patternMatches(text: string, { pattern, flags }: TextPattern): boolean {
  return new RegExp(pattern, flags).test(text)
}

/**
 * Why a pattern cannot be read as a JavaScript regular expression, or undefined when it can.
 *
 * @example patternProblem({ pattern: '(', flags: '' }) // 'Invalid regular expression: /(/: Unterminated group'
 */
export function patternProblem({ pattern, flags }: TextPattern): string | undefined {
  try {
    new RegExp(pattern, flags)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The first step of a recipe that kept no element, by its index from 0, and how many elements it matched before its
 * pick, which is more than 0 only when the pick kept none of them. With `frame`, the step is one of the recipe of the
 * frame at that place in the recipe's frame path, whose element was not there, so nothing inside it was looked for.
 */
export type EmptyStep = { step: number; matched: number; frame?: number }

export const emptyStepSchema: Schema<EmptyStep> = s.object({
  step: s.number({ integer: true, min: 0 }),
  matched: s.number({ integer: true, min: 0 }),
  frame: s.optional(s.number({ integer: true, min: 0 })),
})

/**
 * Says which step of a recipe that matched nothing kept nothing, as a sentence, or undefined when that is the last
 * step and it matched no element, which the recipe as a whole already says. A frame whose element is not there is
 * always named, since the recipe as a whole names the element inside it.
 *
 * @example describeEmptyStep({ by: 'role', role: 'button', within: [{ by: 'testId', value: 'tasks' }] }, { step: 0, matched: 0 }) // "getByTestId('tasks') matched no element."
 * @example describeEmptyStep({ by: 'text', text: 'Paid', frame: [{ by: 'css', selector: '#pay' }] }, { frame: 0, step: 0, matched: 0 }) // "frame(locator('#pay')) found no frame."
 */
export function describeEmptyStep(recipe: LocatorRecipe, empty: EmptyStep): string | undefined {
  if (empty.frame !== undefined) return describeMissingFrame(recipe, empty.frame, empty)
  const steps = locatorSteps(recipe)
  const step = steps[empty.step]
  if (step === undefined || (empty.matched === 0 && empty.step === steps.length - 1)) return undefined
  return describeKeptNothing(steps, empty, recipe.dialect)
}

// A frame's element that is not there, and, when an earlier step of its recipe kept nothing, that step.
function describeMissingFrame(recipe: LocatorRecipe, place: number, empty: EmptyStep): string | undefined {
  const path = recipe.frame ?? []
  const frame = path[place]
  if (frame === undefined) return undefined
  const named = `${describeFrames(path.slice(0, place + 1), recipe.dialect).slice(0, -1)} found no frame.`
  const steps = locatorSteps(frame)
  if (steps[empty.step] === undefined || (empty.matched === 0 && empty.step === steps.length - 1)) return named
  return `${named} ${describeKeptNothing(steps, empty, recipe.dialect)}`
}

function describeKeptNothing(steps: readonly LocatorStep[], empty: EmptyStep, dialect: LocatorDialect | undefined): string {
  const step = steps[empty.step]
  if (step === undefined) throw new Error(`A locator has no step ${empty.step}`)
  const before = steps.slice(0, empty.step).map((each) => `${describeStep(each, dialect)}.`)
  const where = `${before.join('')}${describeFinder(step, dialect)}`
  if (empty.matched === 0) return `${where} matched no element.`
  const elements = empty.matched === 1 ? '1 element' : `${empty.matched} elements`
  return `${where} matched ${elements}, and ${describePick(step.pick).slice(1)} keeps none of them.`
}

// Playwright's selector syntax that is not CSS: XPath, and engines such as `text=` or `internal:role=`, and `>>`.
const xpathStart = /^\s*(?:\.\.|\/\/|\(\s*\/\/)/
const enginePrefix = /^\s*(?:[a-z][\w-]*\s*=|internal:)/i
const enginesChained = /\s>>\s/

/**
 * What the test process and the parent both refuse, as `usage`, in a recipe before it reaches the page, in its own
 * steps and in those of its frames: a pattern that is not a regular expression, `exact` beside a pattern, a CSS
 * selector that is empty or written in another syntax, such as XPath, and an index that is not a safe integer. Whether
 * CSS is valid is for the page to tell.
 *
 * @example locatorProblem({ by: 'css', selector: '//button' })?.class // 'usage'
 */
export function locatorProblem(recipe: LocatorRecipe): Failure | undefined {
  for (const step of everyStep(recipe)) {
    const problem = stepProblem(step)
    if (problem !== undefined) return { class: 'usage', message: problem }
  }
  return undefined
}

function stepProblem(step: LocatorStep): string | undefined {
  if (typeof step.pick === 'number' && !Number.isSafeInteger(step.pick)) {
    return `nth() takes a whole number, counted from 0, received ${step.pick}.`
  }
  switch (step.by) {
    case 'testId':
      return undefined
    case 'css':
      return selectorProblem(step.selector)
    case 'role':
      return step.name === undefined ? undefined : textMatchProblem('getByRole', step.name, step.exact)
    default:
      return textMatchProblem(finderName(step.by), step.text, step.exact)
  }
}

function finderName(by: 'label' | 'text' | 'placeholder'): string {
  return by === 'label' ? 'getByLabel' : by === 'text' ? 'getByText' : 'getByPlaceholder'
}

function textMatchProblem(call: string, text: TextMatch, exactness: boolean | undefined): string | undefined {
  if (typeof text === 'string') return undefined
  const problem = patternProblem(text)
  if (problem !== undefined) return `${call}() received a RegExp the page cannot read: ${problem}.`
  if (exactness !== undefined) return `${call}() takes exact only with text. A RegExp says itself how it matches, so leave exact out.`
  return undefined
}

/**
 * Why `locator()` refuses a selector before the page sees it: one that is empty, or written as XPath or with one of
 * Playwright's selector engines. Anything else goes to the page, which says whether it is valid CSS.
 *
 * @example selectorProblem('text=Save') // "locator() takes a CSS selector, received \"text=Save\". …"
 */
export function selectorProblem(selector: string): string | undefined {
  if (selector.trim() === '') return 'locator() takes a CSS selector, received an empty one.'
  if (!xpathStart.test(selector) && !enginePrefix.test(selector) && !enginesChained.test(selector)) return undefined
  return `locator() takes a CSS selector, received ${quoteText(selector)}. XPath and Playwright's selector engines, such as text= or >>, are not supported.`
}

const requote: Record<string, string> = { '\\"': '"', "'": "\\'", '\u2028': '\\u2028', '\u2029': '\\u2029' }

/**
 * Writes text as a single-quoted JavaScript string, as a test would write it.
 *
 * @example stringLiteral("Ada's task") // "'Ada\\'s task'"
 */
export function stringLiteral(text: string): string {
  // JSON escapes what a JavaScript string needs, except the quote swap and two characters that end a line.
  const escaped = JSON.stringify(text)
    .slice(1, -1)
    .replace(/\\"|['\u2028\u2029]/g, (match) => requote[match] ?? match)
  return `'${escaped}'`
}
