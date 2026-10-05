import type { CallOptions } from '../api/call-options.ts'
import type { KeyArgument } from '../api/key-argument.ts'
import type { RoleOptions, TextOptions } from '../api/page.ts'
import type { AriaRole } from '../protocol/aria-role.ts'

/**
 * What a Playwright call answers where Retest's answers nothing: the response of a navigation, or the values a select
 * chose. The call resolves to a value that fails by name as soon as anything reads it.
 */
export type Unanswered = unknown

/** An option of a `<select>` as Retest's compatibility takes it: by its label, or by its `value` attribute. */
export type SelectOptionChoice = { readonly label: string } | { readonly value: string }

/**
 * The options `getByRole` takes for `Role`. A table row takes no name, since Chrome gives a row no name from its cells
 * where Playwright does; the call is refused by name when it runs, and its type says so first. A role whose type is a
 * union of several takes a name, and is refused when it runs if it is a row.
 */
export type RoleOptionsFor<Role extends AriaRole> = Role extends 'row' ? Omit<RoleOptions, 'name'> & { readonly name?: undefined } : RoleOptions

/**
 * The finders a Playwright test file uses, on a page and on a locator. On a locator, each finds elements inside those
 * the locator keeps. Text and names match any part, in any case, unless `exact` is true, as Playwright's do.
 */
export interface Finders {
  /**
   * Finds the elements whose `data-testid` equals `testId` exactly.
   *
   * @example await page.getByTestId('save-task').click()
   */
  getByTestId(testId: string): Locator
  /**
   * Finds elements by ARIA role and accessible name. A row by name is refused, since Chrome gives a table row no
   * name from its cells where Playwright does.
   *
   * @example await page.getByRole('button', { name: 'Save' }).click()
   */
  getByRole<const Role extends AriaRole>(role: Role, options?: RoleOptionsFor<Role>): Locator
  /**
   * Finds form fields by their label, and any element its `aria-label` or `aria-labelledby` names.
   *
   * @example await page.getByLabel('Email').fill('qa@tasks.example')
   */
  getByLabel(text: string | RegExp, options?: TextOptions): Locator
  /**
   * Finds the innermost elements whose text holds this text, or matches this `RegExp`.
   *
   * @example await expect(page.getByText('Saved')).toBeVisible()
   */
  getByText(text: string | RegExp, options?: TextOptions): Locator
  /**
   * Finds the elements whose `placeholder` holds this text, or matches this `RegExp`.
   *
   * @example await page.getByPlaceholder('Search tasks').fill('release')
   */
  getByPlaceholder(text: string | RegExp, options?: TextOptions): Locator
  /**
   * Finds the elements a CSS selector matches. XPath and Playwright's selector engines are refused.
   *
   * @example await page.locator('.task-list li').first().click()
   */
  locator(selector: string): Locator
}

/** A locator as a Playwright test file uses it. Every member here runs on Retest; any other fails by name. */
export interface Locator extends Finders {
  /** Keeps the first match. */
  first(): Locator
  /** Keeps the last match. */
  last(): Locator
  /** Keeps the match at `index`, counted from 0, and from the end when negative. */
  nth(index: number): Locator
  /** Replaces the field's value by typing it. */
  fill(value: string, options?: CallOptions): Promise<void>
  /** Clicks the element's centre once it is visible, stable, enabled and not covered. */
  click(options?: CallOptions): Promise<void>
  /** Moves the mouse to the element's centre once it is visible, stable and not covered. */
  hover(options?: CallOptions): Promise<void>
  /** Focuses the element and presses a key on it. */
  press<const K extends string>(key: KeyArgument<K>, options?: CallOptions): Promise<void>
  /** Ticks a checkbox or radio button by clicking it once, unless it is ticked already. */
  check(options?: CallOptions): Promise<void>
  /** Unticks a checkbox by clicking it once, unless it is unticked already. */
  uncheck(options?: CallOptions): Promise<void>
  /**
   * Chooses one option of a `<select>`, named by its label or by its value. A bare string, a list and `{ index }` are
   * refused by name, since Playwright reads a string as a value or a label and Retest has to know which.
   *
   * @example await page.getByLabel('Priority').selectOption({ label: 'High' })
   */
  selectOption(option: SelectOptionChoice, options?: CallOptions): Promise<Unanswered>
}

/** The keyboard of a Playwright test file's page. It presses keys on whatever holds the focus. */
export interface Keyboard {
  /** Presses a key and releases it. */
  press<const K extends string>(key: KeyArgument<K>, options?: CallOptions): Promise<void>
}

/** The page a Playwright test file is handed. Every member here runs on Retest; any other fails by name. */
export interface Page extends Finders {
  /** Opens a URL, relative to the base URL, and waits for the page to load. */
  goto(url: string, options?: CallOptions): Promise<Unanswered>
  /** Reloads the page and waits for it to load. */
  reload(options?: CallOptions): Promise<Unanswered>
  /** Goes back one entry in the page's history. A page with no earlier entry fails. */
  goBack(options?: CallOptions): Promise<Unanswered>
  /** Goes forward one entry in the page's history. A page with no later entry fails. */
  goForward(options?: CallOptions): Promise<Unanswered>
  /** Reads the page's title. */
  title(): Promise<string>
  readonly keyboard: Keyboard
}
