import type { PageObservation } from '../protocol/commands.ts'
import type { SourceLocation } from '../protocol/failures.ts'
import type { LocatorDialect, LocatorRecipe } from '../protocol/locator.ts'
import type { BuiltRecipe } from './locator-recipes.ts'
import type { Alert, Locator, NativeKeyboard, NativeLocatorStep, Page, SwipeDirection } from './page.ts'
import type { TestRun } from './test-run.ts'
import { Deadline } from '../protocol/deadline.ts'
import { withLocation } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { pageAddress } from '../protocol/locator-checks.ts'
import { recordedTitle } from '../protocol/page-facts.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { listWords } from '../shared/list-words.ts'
import { readScrollArgument, readSelectArgument } from './action-arguments.ts'
import { formatValue } from './format-value.ts'
import { cssRecipe, pickedRecipe, roleRecipe, scopedRecipe, testIdRecipe, textRecipe } from './locator-recipes.ts'
import { misuse } from './misuse.ts'
import { Secret } from './secret.ts'

/** The test, app and recipe behind a locator, for assertions. */
export type LocatorTarget = { readonly run: TestRun; readonly app: string; readonly recipe: LocatorRecipe }

/** The test and app behind a page, for page assertions. */
export type PageTarget = { readonly run: TestRun; readonly app: string }

/**
 * Where a key or the wheel goes: a locator's element, or, without a recipe, the app's page: whatever holds the focus
 * for a key, and the viewport's centre for the wheel.
 */
type InputTarget = Omit<LocatorTarget, 'recipe'> & { readonly recipe?: LocatorRecipe }

let readTarget: ((locator: AppLocator) => LocatorTarget) | undefined
let readPageTarget: ((page: AppPage) => PageTarget) | undefined
let pageByPlaywrightRules: ((page: AppPage) => AppPage) | undefined

// While another document is on its way the page's title is unknown; `title()` looks again this often until it is known.
const titlePauseMs = 50

const swipeDirections: ReadonlySet<unknown> = new Set<SwipeDirection>(['up', 'down', 'left', 'right'])

// Types decide which apps offer `tap()`, and a native app's `swipe()`, keyboard controls, alerts and locator steps; at
// run time every page has them all, and the parent refuses what the app's page cannot do.

/** An app's page as a test drives it: every command it sends names the app. */
export class AppPage implements Page<true> {
  readonly keyboard: AppKeyboard
  readonly alert: AppAlert
  readonly #run: TestRun
  readonly #app: string
  readonly #dialect: LocatorDialect | undefined

  static {
    readPageTarget = (page) => ({ run: page.#run, app: page.#app })
    pageByPlaywrightRules = (page) => new AppPage(page.#run, page.#app, 'playwright')
  }

  constructor(run: TestRun, app: string, dialect?: LocatorDialect) {
    this.#run = run
    this.#app = app
    this.#dialect = dialect
    this.keyboard = new AppKeyboard({ run, app })
    this.alert = new AppAlert({ run, app })
  }


  goto(url: string, options?: unknown): Promise<void> {
    const location = this.#run.location()
    if (typeof url !== 'string') throw misuse(`goto() takes a URL string, received ${formatValue(url)}.`, this.#run)
    return this.#run.action(this.#app, { kind: 'goto', url }, location, options)
  }

  getByTestId(id: string): AppLocator {
    return this.#locator(testIdRecipe(id))
  }

  getByRole(role: string, options?: unknown): AppLocator {
    return this.#locator(roleRecipe(role, options))
  }

  getByLabel(text: string | RegExp, options?: unknown): AppLocator {
    return this.#locator(textRecipe('label', text, options))
  }

  getByText(text: string | RegExp, options?: unknown): AppLocator {
    return this.#locator(textRecipe('text', text, options))
  }

  getByPlaceholder(text: string | RegExp, options?: unknown): AppLocator {
    return this.#locator(textRecipe('placeholder', text, options))
  }

  locator(selector: string | NativeLocatorStep): AppLocator {
    return this.#locator(selectorRecipe(selector))
  }

  reload(options?: unknown): Promise<void> {
    return this.#run.action(this.#app, { kind: 'reload' }, this.#run.location(), options)
  }

  goBack(options?: unknown): Promise<void> {
    return this.#run.action(this.#app, { kind: 'goBack' }, this.#run.location(), options)
  }

  goForward(options?: unknown): Promise<void> {
    return this.#run.action(this.#app, { kind: 'goForward' }, this.#run.location(), options)
  }

  // A look reads the page's whole address and title; the reads give them as Retest records a page.
  url(): Promise<string> {
    const location = this.#run.location()
    return this.#run.read(this.#app, 'page.url()', location, async () => {
      const { url } = await this.#look(location, this.#readBudget())
      const parsed = url === null ? null : URL.parse(url)
      return parsed === null ? '' : pageAddress(parsed)
    })
  }

  title(): Promise<string> {
    const location = this.#run.location()
    return this.#run.read(this.#app, 'page.title()', location, () => this.#title(location))
  }

  scroll(delta: unknown, options?: unknown): Promise<void> {
    return scroll({ run: this.#run, app: this.#app }, delta, options)
  }

  swipe(direction: unknown, options?: unknown): Promise<void> {
    return swipe({ run: this.#run, app: this.#app }, direction, options)
  }

  #locator(built: BuiltRecipe): AppLocator {
    if ('problem' in built) throw misuse(built.problem, this.#run)
    const recipe = this.#dialect === undefined ? built.recipe : { ...built.recipe, dialect: this.#dialect }
    return new AppLocator({ run: this.#run, app: this.#app, recipe })
  }

  // A read waits no longer than an action may, within the test's time.
  #readBudget(): number {
    return this.#run.assertionBudget(this.#run.timeouts.action)
  }

  async #look(location: SourceLocation | undefined, timeoutMs: number): Promise<PageObservation> {
    const result = await this.#run.readPage(this.#app, timeoutMs, location)
    if (!result.ok) throw this.#run.fail(withLocation(result.failure, location))
    if (result.kind !== 'observePage') throw new Error(`Retest answered a look at the page with ${result.kind}`)
    return result.observation
  }

  async #title(location: SourceLocation | undefined): Promise<string> {
    const { now, sleep } = this.#run.time
    const deadline = new Deadline(this.#readBudget(), { startedAt: now(), clock: now })
    for (;;) {
      const { title } = await this.#look(location, deadline.commandTimeoutMs)
      if (title !== null) return recordedTitle(title)
      if (deadline.expired) {
        const message = `page.title() could not read the title within ${deadline.budgetMs} ms: the page was still opening another document.`
        throw this.#run.fail({ class: 'timeout', message, ...(location === undefined ? {} : { location }) })
      }
      await sleep(Math.min(titlePauseMs, deadline.remainingMs))
    }
  }
}

/** A locator on one app's page. */
export class AppLocator implements Locator<true> {
  readonly #target: LocatorTarget

  static {
    readTarget = (locator) => locator.#target
  }

  constructor(target: LocatorTarget) {
    this.#target = target
  }

  fill(value: string | Secret, options?: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    const location = run.location()
    if (value instanceof Secret) return run.action(app, { kind: 'fill', locator: recipe, value: { secret: value.name } }, location, options)
    if (typeof value !== 'string') throw misuse(`fill() takes a string, received ${formatValue(value)}.`, run)
    return run.action(app, { kind: 'fill', locator: recipe, value }, location, options)
  }

  click(options?: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'click', locator: recipe }, run.location(), options)
  }

  hover(options?: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'hover', locator: recipe }, run.location(), options)
  }

  getByTestId(id: string): AppLocator {
    return this.#inside(testIdRecipe(id))
  }

  getByRole(role: string, options?: unknown): AppLocator {
    return this.#inside(roleRecipe(role, options))
  }

  getByLabel(text: string | RegExp, options?: unknown): AppLocator {
    return this.#inside(textRecipe('label', text, options))
  }

  getByText(text: string | RegExp, options?: unknown): AppLocator {
    return this.#inside(textRecipe('text', text, options))
  }

  getByPlaceholder(text: string | RegExp, options?: unknown): AppLocator {
    return this.#inside(textRecipe('placeholder', text, options))
  }

  locator(selector: string | NativeLocatorStep): AppLocator {
    return this.#inside(selectorRecipe(selector))
  }

  first(): AppLocator {
    return this.#choose(pickedRecipe(this.#target.recipe, 'first()'))
  }

  last(): AppLocator {
    return this.#choose(pickedRecipe(this.#target.recipe, 'last()'))
  }

  nth(index: number): AppLocator {
    return this.#choose(pickedRecipe(this.#target.recipe, 'nth(index)', index))
  }

  press(key: unknown, options?: unknown): Promise<void> {
    return press(this.#target, key, options)
  }

  select(choice: unknown, options?: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    const location = run.location()
    const read = readSelectArgument(choice)
    if (!read.ok) throw run.fail(withLocation(read.failure, location))
    return run.action(app, { kind: 'select', locator: recipe, ...read.value }, location, options)
  }

  check(options?: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'check', locator: recipe }, run.location(), options)
  }

  uncheck(options?: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'uncheck', locator: recipe }, run.location(), options)
  }

  scroll(delta: unknown, options?: unknown): Promise<void> {
    return scroll(this.#target, delta, options)
  }

  tap(options?: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'tap', locator: recipe }, run.location(), options)
  }

  swipe(direction: unknown, options?: unknown): Promise<void> {
    return swipe(this.#target, direction, options)
  }

  // A finder on a locator looks inside the elements it keeps.
  #inside(built: BuiltRecipe): AppLocator {
    if ('problem' in built) throw misuse(built.problem, this.#target.run)
    return new AppLocator({ ...this.#target, recipe: scopedRecipe(this.#target.recipe, built.recipe) })
  }

  #choose(built: BuiltRecipe): AppLocator {
    if ('problem' in built) throw misuse(built.problem, this.#target.run)
    return new AppLocator({ ...this.#target, recipe: built.recipe })
  }
}

/**
 * An app's keyboard, which presses keys on whatever holds the focus in its page, and on an iOS app waits for and
 * dismisses the software keyboard.
 */
export class AppKeyboard implements NativeKeyboard<'ios-simulator'> {
  readonly #target: InputTarget

  constructor(target: InputTarget) {
    this.#target = target
  }

  press(key: unknown, options?: unknown): Promise<void> {
    return press(this.#target, key, options)
  }

  wait(options?: unknown): Promise<void> {
    return this.#native('wait', options)
  }

  dismiss(options?: unknown): Promise<void> {
    return this.#native('dismiss', options)
  }

  dismissFirstRunCard(options?: unknown): Promise<void> {
    return this.#native('dismissFirstRunCard', options)
  }

  #native(operation: 'wait' | 'dismiss' | 'dismissFirstRunCard', options: unknown): Promise<void> {
    const { run, app } = this.#target
    return run.action(app, { kind: 'nativeKeyboard', operation }, run.location(), options)
  }
}

/** The alert in front of a native app's page, answered by pressing one button it names exactly. */
export class AppAlert implements Alert {
  readonly #target: InputTarget

  constructor(target: InputTarget) {
    this.#target = target
  }

  accept(button: unknown, options?: unknown): Promise<void> {
    return this.#answer('accept', button, options)
  }

  dismiss(button: unknown, options?: unknown): Promise<void> {
    return this.#answer('dismiss', button, options)
  }

  // A label with nothing but spaces names no button, so it is refused at the call rather than sent to look for one.
  #answer(operation: 'accept' | 'dismiss', button: unknown, options: unknown): Promise<void> {
    const { run, app } = this.#target
    const location = run.location()
    if (typeof button !== 'string' || button.trim() === '') {
      throw misuse(`alert.${operation}() takes the label of the button to press, word for word, received ${formatValue(button)}.`, run)
    }
    return run.action(app, { kind: 'nativeAlert', operation, button }, location, options)
  }
}

/** The test, app and recipe behind a value, when it is a locator. */
export function locatorTarget(value: unknown): LocatorTarget | undefined {
  return value instanceof AppLocator ? readTarget?.(value) : undefined
}

/** The test and app behind a value, when it is an app's page. */
export function pageTarget(value: unknown): PageTarget | undefined {
  return value instanceof AppPage ? readPageTarget?.(value) : undefined
}

/**
 * The page as Retest's Playwright compatibility hands it to a test file: the same app's page, whose locators find by
 * Playwright's rules where Retest's own differ and Retest can follow. Anything else is handed back as it is.
 *
 * @example const page = withPlaywrightRules(context.page)
 */
export function withPlaywrightRules(value: object): object {
  return value instanceof AppPage ? (pageByPlaywrightRules?.(value) ?? value) : value
}

// A key `parseKey` refuses is never sent. The parent reads the key again, since it trusts nothing the test process checked.
function press({ run, app, recipe }: InputTarget, key: unknown, options: unknown): Promise<void> {
  const location = run.location()
  if (typeof key !== 'string') throw misuse(`press() takes a key as text, such as 'Enter', received ${formatValue(key)}.`, run)
  const parsed = parseKey(key)
  if (!parsed.ok) throw run.fail(withLocation(parsed.failure, location))
  return run.action(app, { kind: 'press', ...(recipe === undefined ? {} : { locator: recipe }), key }, location, options)
}

function scroll({ run, app, recipe }: InputTarget, delta: unknown, options: unknown): Promise<void> {
  const location = run.location()
  const read = readScrollArgument(delta)
  if (!read.ok) throw run.fail(withLocation(read.failure, location))
  return run.action(app, { kind: 'scroll', ...(recipe === undefined ? {} : { locator: recipe }), ...read.value }, location, options)
}

function swipe({ run, app, recipe }: InputTarget, direction: unknown, options: unknown): Promise<void> {
  const location = run.location()
  if (!isSwipeDirection(direction)) throw misuse(`swipe() takes 'up', 'down', 'left' or 'right', received ${formatValue(direction)}.`, run)
  return run.action(app, { kind: 'swipe', ...(recipe === undefined ? {} : { locator: recipe }), direction }, location, options)
}

function isSwipeDirection(value: unknown): value is SwipeDirection {
  return swipeDirections.has(value)
}

// A string is a CSS selector. An object is a native step written as data, read by the rules of the finder it names and
// of the pick it carries, so it finds what that finder finds. Anything else goes to the CSS reader, which refuses it.
function selectorRecipe(selector: unknown): BuiltRecipe {
  if (typeof selector === 'string' || !isPlainObject(selector)) return cssRecipe(selector)
  const { pick, ...step } = selector
  const built = stepRecipe(step, selector)
  if ('problem' in built || pick === undefined) return built
  if (pick === 'first') return pickedRecipe(built.recipe, 'first()')
  if (pick === 'last') return pickedRecipe(built.recipe, 'last()')
  if (typeof pick === 'number') return pickedRecipe(built.recipe, 'nth(index)', pick)
  return { problem: `A locator step's pick is 'first', 'last' or an index from 0, received ${formatValue(pick)}.` }
}

function stepRecipe(step: Record<string, unknown>, written: Record<string, unknown>): BuiltRecipe {
  const { by, ...rest } = step
  const unknownKey = (allowed: readonly string[]): BuiltRecipe | undefined => {
    if (Object.keys(rest).every((key) => allowed.includes(key))) return undefined
    return { problem: `A locator step by ${String(by)} takes only ${listWords([...allowed, 'pick'], 'and')}, received ${formatValue(written)}.` }
  }
  switch (by) {
    case 'testId':
      return unknownKey(['value']) ?? testIdRecipe(rest['value'])
    case 'role':
      return unknownKey(['role', 'name', 'exact']) ?? roleRecipe(rest['role'], definedOptions({ name: rest['name'], exact: rest['exact'] }))
    case 'label':
    case 'text':
      return unknownKey(['text', 'exact']) ?? textRecipe(by, rest['text'], definedOptions({ exact: rest['exact'] }))
    default:
      return { problem: `locator() takes a CSS selector, or on a native app a step by testId, role, label or text, received ${formatValue(written)}.` }
  }
}

// A finder's options say only what the step gave, as a test would write them.
function definedOptions(options: Record<string, unknown>): Record<string, unknown> | undefined {
  const given = Object.entries(options).filter(([, value]) => value !== undefined)
  return given.length === 0 ? undefined : Object.fromEntries(given)
}
