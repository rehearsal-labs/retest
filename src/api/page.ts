import type { RetestTypeError, TestIdValue } from '../config/register.ts'
import type { AriaRole } from '../protocol/aria-role.ts'
import type { Secret } from './secret.ts'

/** How `getByRole` reads the accessible name: whole and case-sensitive, or with `exact: false` a case-insensitive part. */
export type RoleOptions = { readonly name?: string | undefined; readonly exact?: boolean | undefined }

/** `exact: false` matches a case-insensitive part of the text instead of the whole text. */
export type TextOptions = { readonly exact?: boolean | undefined }

/**
 * An app's page in a test. Every method sends one command to it; await each one, because an app takes one
 * command at a time. `Touch` says whether every target of the app has a touch screen, which gives its
 * locators `tap()`.
 */
export interface Page<Touch extends boolean = boolean> {
  /**
   * Opens a URL and waits for the page to load. A relative URL resolves against the app's base URL.
   *
   * @example await page.goto('/')
   */
  goto(url: string): Promise<void>
  /**
   * Finds the element whose `data-testid` equals `id` exactly.
   *
   * @example await page.getByTestId('save-task').click()
   */
  getByTestId(id: TestIdValue): Locator<Touch>
  /**
   * Finds the element with this ARIA role and, when given, this accessible name.
   *
   * @example await page.getByRole('button', { name: 'Save' }).click()
   */
  getByRole(role: AriaRole, options?: RoleOptions): Locator<Touch>
  /**
   * Finds the form field whose accessible name is this label.
   *
   * @example await page.getByLabel('Email').fill('qa@tasks.example')
   */
  getByLabel(text: string, options?: TextOptions): Locator<Touch>
  /**
   * Finds the innermost element whose whole text is this text.
   *
   * @example await expect(page.getByText('Saved')).toBeVisible()
   */
  getByText(text: string, options?: TextOptions): Locator<Touch>
}

/**
 * A way to find elements on an app's page. It holds a recipe, not an element: it is found again for every
 * action and every look. An action needs exactly one match; none waits until the action's time runs out,
 * and more than one fails at once.
 */
export interface Locator<Touch extends boolean = boolean> {
  /**
   * Replaces the field's value by typing, as a person would. A secret is typed by the process that runs Retest.
   *
   * @example await page.getByLabel('Password').fill(secret('password'))
   */
  fill(value: string | Secret): Promise<void>
  /**
   * Clicks the element's centre once it is visible, stable, enabled and not covered. On a touch screen it taps.
   *
   * @example await page.getByTestId('save-task').click()
   */
  click(): Promise<void>
  /**
   * Taps the element's centre, on an app whose every target has a touch screen.
   *
   * @example await phone.getByRole('button', { name: 'Save' }).tap()
   */
  readonly tap: Touch extends true ? () => Promise<void> : RetestTypeError<"One of this app's targets has no touch screen. Use click().">
}
