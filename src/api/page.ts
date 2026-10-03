import type { RetestTypeError, TestIdValue } from '../config/register.ts'
import type { NativePlatform } from '../config/types.ts'
import type { AriaRole } from '../protocol/aria-role.ts'
import type { CallOptions } from './call-options.ts'
import type { KeyArgument } from './key-argument.ts'
import type { Secret } from './secret.ts'

/**
 * How `getByRole` reads the accessible name: whole and case-sensitive, or with `exact: false` a case-insensitive
 * part. A `RegExp` name is searched for in the name with its own flags, and takes no `exact`.
 */
export type RoleOptions = { readonly name?: string | RegExp | undefined; readonly exact?: boolean | undefined }

/** `exact: false` matches a case-insensitive part of the text instead of the whole text. A `RegExp` takes no `exact`. */
export type TextOptions = { readonly exact?: boolean | undefined }

/**
 * The ways a page and a locator find elements. On a locator, each finds elements inside those the locator keeps,
 * never those elements themselves.
 */
export interface Finders<Touch extends boolean = boolean> {
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
   * Finds the form field whose accessible name is this label, or matches this `RegExp`.
   *
   * @example await page.getByLabel('Email').fill('qa@tasks.example')
   */
  getByLabel(text: string | RegExp, options?: TextOptions): Locator<Touch>
  /**
   * Finds the innermost element whose whole text is this text, or matches this `RegExp`.
   *
   * @example await expect(page.getByText('Saved')).toBeVisible()
   */
  getByText(text: string | RegExp, options?: TextOptions): Locator<Touch>
  /**
   * Finds the element whose `placeholder` is this text, or matches this `RegExp`.
   *
   * @example await page.getByPlaceholder('Search tasks').fill('release')
   */
  getByPlaceholder(text: string | RegExp, options?: TextOptions): Locator<Touch>
  /**
   * Finds the elements a CSS selector matches, as `querySelectorAll` matches it. XPath and Playwright's selector
   * engines are refused.
   *
   * @example await page.locator('.task-list li').first().click()
   */
  locator(selector: string): Locator<Touch>
}

/**
 * An app's page in a test. Every method sends one command to it; await each one, because an app takes one
 * command at a time. `Touch` says whether every target of the app has a touch screen, which gives its
 * locators `tap()`. `goto` and every action take `{ timeout }` in milliseconds, which shortens the navigation or
 * action budget for that call and never lengthens it.
 */
export interface Page<Touch extends boolean = boolean> extends Finders<Touch> {
  /**
   * Opens a URL and waits for the page to load. A relative URL resolves against the app's base URL.
   *
   * @example await page.goto('/')
   */
  goto(url: string, options?: CallOptions): Promise<void>
  /**
   * Reloads the page and waits for it to load.
   *
   * @example await page.reload()
   */
  reload(options?: CallOptions): Promise<void>
  /**
   * Goes back one entry in the page's history and waits for that page, as the browser's back button does. A page
   * with no earlier entry fails, and nothing is sent.
   *
   * @example await page.goBack()
   */
  goBack(options?: CallOptions): Promise<void>
  /**
   * Goes forward one entry in the page's history and waits for that page. A page with no later entry fails.
   *
   * @example await page.goForward()
   */
  goForward(options?: CallOptions): Promise<void>
  /**
   * Reads the page's address as Retest records it: its origin and path, with no query or fragment. To wait for an
   * address, use `expect(page).toHaveURL()`.
   *
   * @example const address = await page.url()
   */
  url(): Promise<string>
  /**
   * Reads the page's title, trimmed and cut to 300 code units, waiting for a document on its way to arrive. It is
   * empty for a page with no title.
   *
   * @example const title = await page.title()
   */
  title(): Promise<string>
  /** The keyboard of this app's page. It presses keys on whatever holds the keyboard focus. */
  readonly keyboard: Keyboard
  /**
   * Turns the mouse wheel once at the centre of the viewport, by `x` and `y` CSS pixels. It passes once the page
   * received the wheel, and does not wait for the page to finish moving.
   *
   * @example await page.scroll({ y: 600 })
   */
  scroll(delta: ScrollDelta, options?: CallOptions): Promise<void>
}

/** An app's keyboard. Await each press, because an app takes one command at a time. */
export interface Keyboard {
  /**
   * Presses a key and releases it on whatever holds the keyboard focus, or on the page's body when nothing does.
   * It takes a named key such as `Enter` or `ArrowDown`, one character, or modifiers and a key, such as `Control+A`,
   * which hold Shift, Control, Alt or Meta down around the key.
   *
   * @example await page.keyboard.press('Shift+Tab')
   */
  press<const K extends string>(key: KeyArgument<K>, options?: CallOptions): Promise<void>
}

/**
 * A way to find elements on an app's page. It holds a recipe, not an element: it is found again for every
 * action and every look. An action needs exactly one match; none waits until the action's time runs out,
 * and more than one fails at once.
 */
export interface Locator<Touch extends boolean = boolean> extends Finders<Touch> {
  /**
   * Keeps the first match. Only an action that needs one element cares; a matcher that counts sees one.
   *
   * @example await page.getByRole('listitem').first().click()
   */
  first(): Locator<Touch>
  /**
   * Keeps the last match.
   *
   * @example await expect(page.getByRole('listitem').last()).toHaveText('Newest')
   */
  last(): Locator<Touch>
  /**
   * Keeps the match at `index`, counted from 0, and from the end when negative. An index past the matches keeps none.
   *
   * @example await page.getByRole('listitem').nth(1).click()
   */
  nth(index: number): Locator<Touch>
  /**
   * Replaces the field's value by typing, as a person would. A secret is typed by the process that runs Retest.
   *
   * @example await page.getByLabel('Password').fill(secret('password'))
   */
  fill(value: string | Secret, options?: CallOptions): Promise<void>
  /**
   * Clicks the element's centre once it is visible, stable, enabled and not covered. On a touch screen it taps.
   *
   * @example await page.getByTestId('save-task').click({ timeout: 2000 })
   */
  click(options?: CallOptions): Promise<void>
  /**
   * Moves the mouse to the element's centre once it is visible, stable and not covered. A disabled element can be
   * hovered.
   *
   * @example await page.getByRole('button', { name: 'Share' }).hover()
   */
  hover(options?: CallOptions): Promise<void>
  /**
   * Focuses the element once it is visible and enabled, then presses a key on it and releases it. It takes a named
   * key such as `Enter` or `ArrowDown`, one character, or modifiers and a key, such as `Control+A`. An uppercase
   * letter is typed with Shift.
   *
   * @example await page.getByLabel('Search').press('Enter')
   */
  press<const K extends string>(key: KeyArgument<K>, options?: CallOptions): Promise<void>
  /**
   * Chooses options in a `<select>` once it is visible, stable, enabled and not covered, with the keyboard, as a person
   * can: it types the start of the option's label, or for a `<select multiple>` moves to each option and toggles it.
   * The page hears the keys and the browser's own `input` and `change` events. A string names an option by its label,
   * `{ value }` by its `value` attribute, and a list chooses exactly those options in a `<select multiple>`.
   *
   * @example await page.getByLabel('Country').select('Canada')
   */
  select(choice: OptionChoice | readonly OptionChoice[], options?: CallOptions): Promise<void>
  /**
   * Ticks a checkbox, radio button or switch by clicking it once, unless it is ticked already. A hidden native
   * control is clicked through its label. It fails if the click leaves it unticked, and never clicks again.
   *
   * @example await page.getByRole('checkbox', { name: 'Remember me' }).check()
   */
  check(options?: CallOptions): Promise<void>
  /**
   * Unticks a checkbox or switch by clicking it once, unless it is unticked already. A radio button is unticked by
   * choosing another one.
   *
   * @example await page.getByLabel('Newsletter').uncheck()
   */
  uncheck(options?: CallOptions): Promise<void>
  /**
   * Turns the mouse wheel once over the element's centre, by `x` and `y` CSS pixels, once it is visible, stable,
   * enabled and not covered. Every action already brings its element into view: scroll for what the page does on
   * scroll, such as loading more items.
   *
   * @example await page.getByTestId('terms').scroll({ y: 600 })
   */
  scroll(delta: ScrollDelta, options?: CallOptions): Promise<void>
  /**
   * Taps the element's centre, on an app whose every target has a touch screen.
   *
   * @example await phone.getByRole('button', { name: 'Save' }).tap()
   */
  readonly tap: Touch extends true ? (options?: CallOptions) => Promise<void> : RetestTypeError<"One of this app's targets has no touch screen. Use click().">
}

/**
 * A native app's handle in a test: an app on an iOS simulator, or a macOS app. It finds elements as a web page does,
 * by test id, which is the element's accessibility identifier, by role, label and text, and it has a keyboard and a
 * scroll. It has no address and no browser storage. Retest has no native driver yet: a run refuses every test that
 * needs a native target before starting anything for it, so no test body receives one.
 */
export interface NativePage<Platform extends NativePlatform = NativePlatform> {
  readonly goto: RetestTypeError<'A native app has no address. goto() is for web apps.'>
  /** Finds the element whose accessibility identifier equals `id` exactly. */
  getByTestId(id: TestIdValue): NativeLocator<Platform>
  /** Finds the element with this role and, when given, this name. */
  getByRole(role: AriaRole, options?: RoleOptions): NativeLocator<Platform>
  /** Finds the field whose label is this text. */
  getByLabel(text: string, options?: TextOptions): NativeLocator<Platform>
  /** Finds the element whose whole text is this text. */
  getByText(text: string, options?: TextOptions): NativeLocator<Platform>
  /** The app's keyboard. It presses keys on whatever holds the keyboard focus. */
  readonly keyboard: Keyboard
  /** Scrolls the app's window by `x` and `y` points. */
  scroll(delta: ScrollDelta): Promise<void>
}

/**
 * A way to find elements in a native app. An iOS app's elements take `tap()`, and a macOS app's `click()`. The
 * methods of a web page's form controls, `select`, `check` and `uncheck`, are not here.
 */
export interface NativeLocator<Platform extends NativePlatform = NativePlatform> {
  /** Replaces the field's value by typing. A secret is typed by the process that runs Retest. */
  fill(value: string | Secret): Promise<void>
  /** Presses a key on the element and releases it. */
  press<const K extends string>(key: KeyArgument<K>): Promise<void>
  /** Scrolls over the element by `x` and `y` points. */
  scroll(delta: ScrollDelta): Promise<void>
  readonly tap: Platform extends 'ios-simulator' ? () => Promise<void> : RetestTypeError<'A macOS app has no touch screen. Use click().'>
  readonly click: Platform extends 'macos' ? () => Promise<void> : RetestTypeError<'An iOS app takes taps. Use tap().'>
  readonly select: RetestTypeError<"select() is for a web page's <select>. A native app has none.">
  readonly check: RetestTypeError<'check() is for a web page. Tap or click the native control instead.'>
  readonly uncheck: RetestTypeError<'uncheck() is for a web page. Tap or click the native control instead.'>
}

/** An option by its label, as a person reads it, or by its `value` attribute. */
export type OptionChoice = string | { readonly value: string }

/** CSS pixels. Positive is right and down. An axis not given is 0. */
export type ScrollDelta = { readonly x?: number | undefined; readonly y?: number | undefined }
