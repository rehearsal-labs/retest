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

/**
 * An Electron app's page in a test: the first window the app opens. It finds, acts and checks as a web page does, and
 * reloads and moves through its history, but it has no address to go to.
 */
export type ElectronPage = Omit<Page<false>, 'goto'> & {
  readonly goto: RetestTypeError<'An Electron app has no address. Its page is the first window the app opens.'>
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
 * One step of a native locator written as data, as `locator(step)` takes it: the step `getByTestId`, `getByRole`,
 * `getByLabel` or `getByText` makes, read by that finder's rules, and with `pick` the match `first()`, `last()` or
 * `nth(index)` would keep. CSS and placeholder steps are for web pages.
 */
export type NativeLocatorStep =
  | { readonly by: 'testId'; readonly value: TestIdValue; readonly pick?: NativeStepPick | undefined }
  | { readonly by: 'role'; readonly role: AriaRole; readonly name?: string | RegExp | undefined; readonly exact?: boolean | undefined; readonly pick?: NativeStepPick | undefined }
  | { readonly by: 'label' | 'text'; readonly text: string | RegExp; readonly exact?: boolean | undefined; readonly pick?: NativeStepPick | undefined }

/** The match a step keeps: the first, the last, or the one at an index from 0, counted from the end when negative. */
export type NativeStepPick = 'first' | 'last' | number

/** Which way a swipe moves across the screen. */
export type SwipeDirection = 'up' | 'down' | 'left' | 'right'

/** Finders scoped to the owned native tree; identifiers are accessibility identifiers. */
export interface NativeFinders<Platform extends NativePlatform> {
  getByTestId(id: TestIdValue): NativeLocator<Platform>
  getByRole(role: AriaRole, options?: RoleOptions): NativeLocator<Platform>
  getByLabel(text: string | RegExp, options?: TextOptions): NativeLocator<Platform>
  getByText(text: string | RegExp, options?: TextOptions): NativeLocator<Platform>
  /**
   * Finds elements by one step written as data, as the finder it names finds them.
   *
   * @example await phone.locator({ by: 'role', role: 'button', name: 'Save', pick: 'last' }).tap()
   */
  locator(step: NativeLocatorStep): NativeLocator<Platform>
}

/**
 * A native app's keyboard. `press` works on both platforms. The software keyboard's own controls are an iOS app's,
 * since a macOS app has none; each waits within the action's time.
 */
export interface NativeKeyboard<Platform extends NativePlatform = NativePlatform> extends Keyboard {
  /**
   * Waits for the software keyboard to come up. It presses nothing.
   *
   * @example await phone.keyboard.wait()
   */
  readonly wait: Platform extends 'ios-simulator' ? (options?: CallOptions) => Promise<void> : RetestTypeError<'A macOS app has no software keyboard.'>
  /**
   * Dismisses the software keyboard by pressing its return key once, after the first-run card about sliding to type
   * when it shows, and waits for the keyboard to go. A keyboard that is not up passes and presses nothing; one whose
   * return key leaves it up fails, and nothing more is pressed.
   *
   * @example await phone.keyboard.dismiss()
   */
  readonly dismiss: Platform extends 'ios-simulator' ? (options?: CallOptions) => Promise<void> : RetestTypeError<'A macOS app has no software keyboard.'>
  /**
   * Presses Continue once on the keyboard's first-run card about sliding to type, when it shows, and waits for the card
   * to go. Without the card it passes and presses nothing.
   *
   * @example await phone.keyboard.dismissFirstRunCard()
   */
  readonly dismissFirstRunCard: Platform extends 'ios-simulator' ? (options?: CallOptions) => Promise<void> : RetestTypeError<'A macOS app has no software keyboard.'>
}

/**
 * The alert in front of a native app. An answer presses the one button whose label is exactly this text, once, and
 * waits for the alert to close. With no alert open, or with no button or several carrying the label, it fails and
 * presses nothing.
 */
export interface Alert {
  /**
   * Presses the named button through the alert's accept route on iOS; on macOS it clicks the button.
   *
   * @example await phone.alert.accept('Allow')
   */
  accept(button: string, options?: CallOptions): Promise<void>
  /**
   * Presses the named button through the alert's dismiss route on iOS; on macOS it clicks the button.
   *
   * @example await phone.alert.dismiss('Not Now')
   */
  dismiss(button: string, options?: CallOptions): Promise<void>
}

/** A native app's handle. Web commands are absent; forged commands are refused by the parent. */
export interface NativePage<Platform extends NativePlatform = NativePlatform> extends NativeFinders<Platform> {
  readonly goto: RetestTypeError<'A native app has no address. goto() is for web apps.'>
  readonly keyboard: NativeKeyboard<Platform>
  /** The alert in front of the app. */
  readonly alert: Alert
  scroll(delta: ScrollDelta, options?: CallOptions): Promise<void>
  /**
   * Swipes once from the centre of the app's window: one touch drag a third of the window's extent in the direction.
   *
   * @example await phone.swipe('up')
   */
  readonly swipe: Platform extends 'ios-simulator' ? (direction: SwipeDirection, options?: CallOptions) => Promise<void> : RetestTypeError<'A macOS app takes no swipe. Use scroll().'>
}

/** A recipe looked up afresh for each action and check in the owned app's tree. */
export interface NativeLocator<Platform extends NativePlatform = NativePlatform> extends NativeFinders<Platform> {
  first(): NativeLocator<Platform>
  last(): NativeLocator<Platform>
  nth(index: number): NativeLocator<Platform>
  fill(value: string | Secret, options?: CallOptions): Promise<void>
  press<const K extends string>(key: KeyArgument<K>, options?: CallOptions): Promise<void>
  scroll(delta: ScrollDelta, options?: CallOptions): Promise<void>
  /**
   * Swipes once from the element's centre, once it is visible, stable and not covered: one touch drag a third of its
   * extent in the direction.
   *
   * @example await phone.getByTestId('task-list').swipe('left')
   */
  readonly swipe: Platform extends 'ios-simulator' ? (direction: SwipeDirection, options?: CallOptions) => Promise<void> : RetestTypeError<'A macOS app takes no swipe. Use scroll().'>
  readonly tap: Platform extends 'ios-simulator' ? (options?: CallOptions) => Promise<void> : RetestTypeError<'A macOS app has no touch screen. Use click().'>
  readonly click: Platform extends 'macos' ? (options?: CallOptions) => Promise<void> : RetestTypeError<'An iOS app takes taps. Use tap().'>
  readonly select: RetestTypeError<"select() is for a web page's <select>. A native app has none.">
  readonly check: RetestTypeError<'check() is for a web page. Tap or click the native control instead.'>
  readonly uncheck: RetestTypeError<'uncheck() is for a web page. Tap or click the native control instead.'>
}

/** An option by its label, as a person reads it, or by its `value` attribute. */
export type OptionChoice = string | { readonly value: string }

/** CSS pixels. Positive is right and down. An axis not given is 0. */
export type ScrollDelta = { readonly x?: number | undefined; readonly y?: number | undefined }
