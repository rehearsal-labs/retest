import type { LocatorRecipe } from '../protocol/locator.ts'
import type { BuiltRecipe } from './locator-recipes.ts'
import type { Locator, Page } from './page.ts'
import type { TestRun } from './test-run.ts'
import { formatValue } from './format-value.ts'
import { roleRecipe, testIdRecipe, textRecipe } from './locator-recipes.ts'
import { misuse } from './misuse.ts'
import { Secret } from './secret.ts'

/** The test, app and recipe behind a locator, for assertions. */
export type LocatorTarget = { readonly run: TestRun; readonly app: string; readonly recipe: LocatorRecipe }

let readTarget: ((locator: AppLocator) => LocatorTarget) | undefined

// Types decide which apps offer `tap()`; at run time every page has it, and a page without a touch screen refuses it.

/** An app's page as a test drives it: every command it sends names the app. */
export class AppPage implements Page<true> {
  readonly #run: TestRun
  readonly #app: string

  constructor(run: TestRun, app: string) {
    this.#run = run
    this.#app = app
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

  tap(): Promise<void> {
    const { run, app, recipe } = this.#target
    return run.action(app, { kind: 'tap', locator: recipe }, run.location())
  }
}

/** The test, app and recipe behind a value, when it is a locator. */
export function locatorTarget(value: unknown): LocatorTarget | undefined {
  return value instanceof AppLocator ? readTarget?.(value) : undefined
}

