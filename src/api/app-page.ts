import type { LocatorRecipe } from '../protocol/locator.ts'
import type { BuiltRecipe } from './locator-recipes.ts'
import type { Keyboard, Locator, Page } from './page.ts'
import type { TestRun } from './test-run.ts'
import { withLocation } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { readScrollArgument, readSelectArgument } from './action-arguments.ts'
import { formatValue } from './format-value.ts'
import { roleRecipe, testIdRecipe, textRecipe } from './locator-recipes.ts'
import { misuse } from './misuse.ts'
import { Secret } from './secret.ts'

/** The test, app and recipe behind a locator, for assertions. */
export type LocatorTarget = { readonly run: TestRun; readonly app: string; readonly recipe: LocatorRecipe }

/**
 * Where a key or the wheel goes: a locator's element, or, without a recipe, the app's page: whatever holds the focus
 * for a key, and the viewport's centre for the wheel.
 */
type InputTarget = Omit<LocatorTarget, 'recipe'> & { readonly recipe?: LocatorRecipe }

let readTarget: ((locator: AppLocator) => LocatorTarget) | undefined

// Types decide which apps offer `tap()`; at run time every page has it, and a page without a touch screen refuses it.

/** An app's page as a test drives it: every command it sends names the app. */
export class AppPage implements Page<true> {
  readonly keyboard: AppKeyboard
  readonly #run: TestRun
  readonly #app: string

  constructor(run: TestRun, app: string) {
    this.#run = run
    this.#app = app
    this.keyboard = new AppKeyboard({ run, app })
  }

  goto(url: string): Promise<void> {
    const location = this.#run.location()
    if (typeof url !== 'string') throw misuse(`goto() takes a URL string, received ${formatValue(url)}.`, this.#run)
    return this.#run.action(this.#app, { kind: 'goto', url }, location)
  }

  getByTestId(id: string): AppLocator {
    return this.#locator(testIdRecipe(id))
  }

  getByRole(role: string, options?: unknown): AppLocator {
    return this.#locator(roleRecipe(role, options))
  }

  getByLabel(text: string, options?: unknown): AppLocator {
    return this.#locator(textRecipe('label', text, options))
  }

  getByText(text: string, options?: unknown): AppLocator {
    return this.#locator(textRecipe('text', text, options))
  }

  scroll(delta: unknown): Promise<void> {
    return scroll({ run: this.#run, app: this.#app }, delta)
  }

  #locator(built: BuiltRecipe): AppLocator {
    if ('problem' in built) throw misuse(built.problem, this.#run)
    return new AppLocator({ run: this.#run, app: this.#app, recipe: built.recipe })
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

  fill(value: string | Secret): Promise<void> {
    const { run, app, recipe } = this.#target
    const location = run.location()
    if (value instanceof Secret) return run.action(app, { kind: 'fill', locator: recipe, value: { secret: value.name } }, location)
    if (typeof value !== 'string') throw misuse(`fill() takes a string, received ${formatValue(value)}.`, run)
    return run.action(app, { kind: 'fill', locator: recipe, value }, location)
  }

  click(): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'click', locator: recipe }, run.location())
  }

  press(key: unknown): Promise<void> {
    return press(this.#target, key)
  }

  select(choice: unknown): Promise<void> {
    const { run, app, recipe } = this.#target
    const location = run.location()
    const read = readSelectArgument(choice)
    if (!read.ok) throw run.fail(withLocation(read.failure, location))
    return run.action(app, { kind: 'select', locator: recipe, ...read.value }, location)
  }

  check(): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'check', locator: recipe }, run.location())
  }

  uncheck(): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'uncheck', locator: recipe }, run.location())
  }

  scroll(delta: unknown): Promise<void> {
    return scroll(this.#target, delta)
  }

  tap(): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'tap', locator: recipe }, run.location())
  }
}

/** An app's keyboard, which presses keys on whatever holds the focus in its page. */
export class AppKeyboard implements Keyboard {
  readonly #target: InputTarget

  constructor(target: InputTarget) {
    this.#target = target
  }

  press(key: unknown): Promise<void> {
    return press(this.#target, key)
  }
}

/** The test, app and recipe behind a value, when it is a locator. */
export function locatorTarget(value: unknown): LocatorTarget | undefined {
  return value instanceof AppLocator ? readTarget?.(value) : undefined
}

// A key `parseKey` refuses is never sent. The parent reads the key again, since it trusts nothing the test process checked.
function press({ run, app, recipe }: InputTarget, key: unknown): Promise<void> {
  const location = run.location()
  if (typeof key !== 'string') throw misuse(`press() takes a key as text, such as 'Enter', received ${formatValue(key)}.`, run)
  const parsed = parseKey(key)
  if (!parsed.ok) throw run.fail(withLocation(parsed.failure, location))
  return run.action(app, { kind: 'press', ...(recipe === undefined ? {} : { locator: recipe }), key }, location)
}

function scroll({ run, app, recipe }: InputTarget, delta: unknown): Promise<void> {
  const location = run.location()
  const read = readScrollArgument(delta)
  if (!read.ok) throw run.fail(withLocation(read.failure, location))
  return run.action(app, { kind: 'scroll', ...(recipe === undefined ? {} : { locator: recipe }), ...read.value }, location)
}
