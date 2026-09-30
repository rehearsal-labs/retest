import type { SourceLocation } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { TestRun } from './test-run.ts'
import { failure } from '../protocol/failures.ts'
import { formatValue } from './format-value.ts'

/** The test and recipe behind a locator, for assertions. */
export type LocatorTarget = { readonly run: TestRun; readonly recipe: LocatorRecipe }

let readTarget: ((locator: Locator) => LocatorTarget) | undefined

/**
 * The browser page a test drives. Every method sends one command to the page; await each one, because
 * a page takes one command at a time.
 */
export class Page {
  readonly #run: TestRun

  constructor(run: TestRun) {
    this.#run = run
  }

  /**
   * Opens a URL and waits for the page to load. A relative URL resolves against the run's base URL.
   *
   * @example await page.goto('/')
   */
  goto(url: string): Promise<void> {
    const location = this.#run.location()
    if (typeof url !== 'string') throw this.#misuse(`page.goto() takes a URL string, received ${formatValue(url)}.`, location)
    return this.#run.action({ kind: 'goto', url }, location)
  }

  /**
   * Finds the element whose `data-testid` equals `id` exactly. The element is found again for every
   * action and every look an assertion takes, so it always refers to the page as it is now.
   *
   * @example await page.getByTestId('save-task').click()
   */
  getByTestId(id: string): Locator {
    if (typeof id !== 'string') throw this.#misuse(`getByTestId() takes a string, received ${formatValue(id)}.`, this.#run.location())
    return new Locator(this.#run, { by: 'testId', value: id })
  }

  #misuse(message: string, location: SourceLocation | undefined): Error {
    return this.#run.fail(failure('usage', message, location))
  }
}

/**
 * A way to find one element on the page. It holds a recipe, not an element. An action needs exactly one
 * match: none waits until the action's time runs out, and more than one fails at once.
 */
export class Locator {
  readonly #target: LocatorTarget

  static {
    readTarget = (locator) => locator.#target
  }

  constructor(run: TestRun, recipe: LocatorRecipe) {
    this.#target = { run, recipe }
  }

  /**
   * Replaces the field's value by typing, as a person would. Works on text-like inputs and textareas.
   *
   * @example await page.getByTestId('task-title').fill('Release checklist')
   */
  fill(value: string): Promise<void> {
    const { run, recipe } = this.#target
    const location = run.location()
    if (typeof value !== 'string') throw run.fail(failure('usage', `fill() takes a string, received ${formatValue(value)}.`, location))
    return run.action({ kind: 'fill', locator: recipe, value }, location)
  }

  /**
   * Clicks the element's centre with the mouse, once it is visible, stable, enabled and not covered.
   *
   * @example await page.getByTestId('save-task').click()
   */
  click(): Promise<void> {
    const { run, recipe } = this.#target
    return run.action({ kind: 'click', locator: recipe }, run.location())
  }
}

/** The test and recipe behind a value, when it is a locator. */
export function locatorTarget(value: unknown): LocatorTarget | undefined {
  return value instanceof Locator ? readTarget?.(value) : undefined
}
