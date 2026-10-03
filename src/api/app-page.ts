import type { PageObservation } from '../protocol/commands.ts'
import type { SourceLocation } from '../protocol/failures.ts'
import type { LocatorDialect, LocatorRecipe } from '../protocol/locator.ts'
import type { BuiltRecipe } from './locator-recipes.ts'
import type { Keyboard, Locator, Page } from './page.ts'
import type { TestRun } from './test-run.ts'
import { Deadline } from '../protocol/deadline.ts'
import { withLocation } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { pageAddress } from '../protocol/locator-checks.ts'
import { recordedTitle } from '../protocol/page-facts.ts'
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

// Types decide which apps offer `tap()`; at run time every page has it, and a page without a touch screen refuses it.

/** An app's page as a test drives it: every command it sends names the app. */
export class AppPage implements Page<true> {
  readonly keyboard: AppKeyboard
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

  locator(selector: string): AppLocator {
    return this.#locator(cssRecipe(selector))
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
    const result = await this.#run.observePage(this.#app, timeoutMs, location)
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

  locator(selector: string): AppLocator {
    return this.#inside(cssRecipe(selector))
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

/** An app's keyboard, which presses keys on whatever holds the focus in its page. */
export class AppKeyboard implements Keyboard {
  readonly #target: InputTarget

  constructor(target: InputTarget) {
    this.#target = target
  }

  press(key: unknown, options?: unknown): Promise<void> {
    return press(this.#target, key, options)
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
