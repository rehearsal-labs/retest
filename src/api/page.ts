import type { RetestTypeError, TestIdValue } from '../config/register.ts'
import type { NativePlatform } from '../config/types.ts'
import type { AriaRole } from '../protocol/aria-role.ts'
import type { DialogType } from '../protocol/dialogs.ts'
import type { AbortReason } from '../protocol/routes.ts'
import type { CallOptions } from './call-options.ts'
import type { DragOptions } from './drag.ts'
import type { InboxLink } from './inbox.ts'
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
   * Opens a URL and waits for the page to load. A relative URL resolves against the app's base URL. A link from an
   * inbox's message is opened by the process that runs Retest, which never hands its address to the test.
   *
   * @example await page.goto('/')
   */
  goto(url: string | InboxLink, options?: CallOptions): Promise<void>
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
  /**
   * The frame shown by the `<iframe>` or `<frame>` element `locator` finds on this page, a frame of another site
   * included. The element is found again for every use, so a frame that is removed and added again is found again. Its
   * finders find elements inside the frame's document.
   *
   * @example const payment = page.frame(page.locator('iframe[title="Secure payment"]'))
   */
  frame(locator: Locator<Touch>): Frame<Touch>
  /** The keyboard of this app's page. It presses keys on whatever holds the keyboard focus. */
  readonly keyboard: Keyboard
  /**
   * Turns the mouse wheel once at the centre of the viewport, by `x` and `y` CSS pixels. It passes once the page
   * received the wheel, and does not wait for the page to finish moving.
   *
   * @example await page.scroll({ y: 600 })
   */
  scroll(delta: ScrollDelta, options?: CallOptions): Promise<void>
  /**
   * Runs `action` and gives the JavaScript dialog it opens, as soon as it opens: an alert, a confirm, a prompt or a
   * `beforeunload` confirmation. The page is armed before the action runs. A dialog holds the page, so the action is
   * still waiting when this resolves, and finishes once the test answers the dialog: await this, then await
   * `dialog.accept()` or `dialog.dismiss()`, which resolves once the action is over too. The wait lasts the action budget,
   * or a shorter `{ timeout }`. A dialog nothing waited for fails the action that opened it, and Retest dismisses it.
   *
   * @example
   * const dialog = await page.dialog(() => page.getByRole('button', { name: 'Delete' }).click())
   * await dialog.accept()
   */
  dialog(action: () => Promise<unknown>, options?: CallOptions): Promise<Dialog>
  /**
   * Runs `action` and gives the page it opens, by `window.open`, a link with a target or a form, as a page of its own:
   * its commands, checks and failure screenshot are its own, and it closes when the test ends. The page is armed before
   * the action runs, and this resolves once the new page has opened its first document and the action is over. The wait
   * lasts the action budget, or a shorter `{ timeout }`. A page opened while nothing waited runs on unwatched.
   *
   * @example const terms = await page.popup(() => page.getByRole('link', { name: 'Terms' }).click())
   */
  popup(action: () => Promise<unknown>, options?: CallOptions): Promise<Page<Touch>>
  /**
   * Closes a page the app opened, which `page.popup()` gave, and waits for it to go. Its `beforeunload` handlers run
   * first; answer their dialog with `page.dialog()`. The test's own pages close when the test ends.
   *
   * @example await terms.close()
   */
  close(options?: CallOptions): Promise<void>
  /**
   * Runs `action` and gives the file picker it opens, which is never shown, so its input can be given files. The wait
   * for the picker starts before the action, and lasts the action budget or a shorter `{ timeout }`. A picker the test
   * did not wait for fails the action that opened it.
   *
   * @example const chooser = await page.fileChooser(() => page.getByRole('button', { name: 'Upload' }).click())
   */
  fileChooser(action: () => Promise<unknown>, options?: CallOptions): Promise<FileChooser>
  /**
   * Runs `action` and gives the download it starts. The wait for it starts before the action, and lasts the action
   * budget or a shorter `{ timeout }`. The run folder keeps every download a page makes, under the name the page
   * suggested, whether or not a test waits for it.
   *
   * @example const download = await page.download(() => page.getByRole('link', { name: 'Export CSV' }).click())
   */
  download(action: () => Promise<unknown>, options?: CallOptions): Promise<Download>
  /**
   * Answers every request of the page whose whole address `pattern` matches with `answer`, in the network's place, from
   * now on: a response, or a refusal. A later route answers before an earlier one. It resolves once the page holds the
   * route, so the next `goto` meets it. A popup shares the routes of the page that opened it.
   *
   * @example await page.route('http://127.0.0.1:4173/api/tasks', { contentType: 'application/json', body: JSON.stringify([{ title: 'Stubbed' }]) })
   */
  route(pattern: RoutePattern, answer: RouteAnswer): Promise<void>
  /**
   * Removes every route added with `pattern`, written as it was added. A pattern that matches no route fails.
   *
   * @example await page.unroute(/\/api\/tasks$/)
   */
  unroute(pattern: RoutePattern): Promise<void>
}

/**
 * A frame of an app's page: the document an `<iframe>` or `<frame>` element shows, found again by that element's
 * locator for every use. Its finders find elements inside that document, through its open shadow roots, and `frame()`
 * a frame inside it. It has no address of its own to go to: `goto`, `toHaveURL` and `toHaveTitle` are the page's.
 */
export interface Frame<Touch extends boolean = boolean> extends Finders<Touch> {
  /**
   * The frame shown by the `<iframe>` or `<frame>` element `locator` finds in this frame's document.
   *
   * @example const notes = order.frame(order.locator('iframe'))
   */
  frame(locator: Locator<Touch>): Frame<Touch>
}

/**
 * A JavaScript dialog an action opened: an alert, a confirm, a prompt or a `beforeunload` confirmation. It holds the page
 * until the test answers it, and the action that opened it finishes only then, so `accept()` and `dismiss()` each
 * resolve once the dialog is answered and that action is over. Answer each dialog once.
 */
export interface Dialog {
  /** The kind of dialog the page opened. */
  readonly type: DialogType
  /** The text the page showed, with every value the run hides replaced. A `beforeunload` dialog's is empty. */
  readonly message: string
  /** A prompt's default answer, and empty for any other dialog. */
  readonly defaultValue: string
  /**
   * Accepts the dialog, as its OK button does. A prompt takes the text to answer with, and without it answers with its
   * default. A `beforeunload` dialog accepted lets the page leave.
   *
   * @example await dialog.accept('Ada')
   */
  accept(promptText?: string): Promise<void>
  /**
   * Dismisses the dialog, as its Cancel button does. A prompt dismissed answers `null`; a `beforeunload` dialog
   * dismissed keeps the page where it is, so the navigation that asked fails.
   *
   * @example await dialog.dismiss()
   */
  dismiss(): Promise<void>
}

/**
 * A file picker a `page.fileChooser()` caught: the operating system's picker was never shown, and the page waits for
 * the files its input is given here.
 */
export interface FileChooser {
  /** Whether the picker's input takes several files, as its `multiple` attribute says. */
  readonly multiple: boolean
  /**
   * Gives the picker's input the files, as a person choosing them would, so the page hears its `input` and `change`
   * events. A path is read against the folder of the file that makes the call.
   *
   * @example await chooser.setFiles('./fixtures/report.pdf')
   */
  setFiles(files: InputFiles, options?: CallOptions): Promise<void>
}

/**
 * A download a `page.download()` caught. The process that runs Retest saves it in the run folder, under the name the
 * page suggested, whether or not the test asks for it.
 */
export interface Download {
  /** The name the browser suggested for the file, from the page's `download` attribute or the server's answer. */
  readonly suggestedFilename: string
  /**
   * Waits for the download to be saved, within the navigation budget or a shorter `{ timeout }`, and gives the absolute
   * path of its file in the run folder. A download the browser stopped fails, saying how much of it arrived.
   *
   * @example const csv = await readFile(await download.path(), 'utf8')
   */
  path(options?: CallOptions): Promise<string>
  /**
   * Waits for the download to be saved, as `path()` does, then copies its file to `path`, read against the folder of the
   * file that makes the call, making the folders it needs. The run folder keeps its own copy.
   *
   * @example await download.saveAs('./out/tasks.csv')
   */
  saveAs(path: string, options?: CallOptions): Promise<void>
}

/**
 * A file given by its content rather than a path: the name the page reads, its bytes or its text, which is written as
 * UTF-8, and, when given, the type the page must read for it. The browser types a file by the end of its name, so a
 * `mimeType` it does not give the file fails the call.
 */
export type FilePayload = { readonly name: string; readonly mimeType?: string | undefined; readonly content: string | Uint8Array }

/**
 * The files an input takes: a path, read against the folder of the file that makes the call, as an import is; a file by
 * its content; or a list of them. An empty list clears the input.
 */
export type InputFiles = string | FilePayload | readonly (string | FilePayload)[]

/**
 * Which requests a route answers: a glob of the whole address, query included, where `**` matches any run of characters
 * and `*` any run without a `/`; or a `RegExp` searched for in the address.
 */
export type RoutePattern = string | RegExp

/**
 * A response a route gives in the network's place: `status`, 200 unless given, `headers`, `contentType`, which sets the
 * `Content-Type` header, and `body`, text written as UTF-8, or bytes.
 */
export type RouteFulfil = {
  readonly status?: number | undefined
  readonly headers?: Readonly<Record<string, string>> | undefined
  readonly contentType?: string | undefined
  readonly body?: string | Uint8Array | undefined
  readonly abort?: never
}

/** A refusal: the request fails as Chrome's network error `abort` names, such as `'connectionrefused'`. */
export type RouteAbort = {
  readonly abort: AbortReason
  readonly status?: never
  readonly headers?: never
  readonly contentType?: never
  readonly body?: never
}

/** What a route answers each request it matches with: a response, or a refusal. Never both. */
export type RouteAnswer = RouteFulfil | RouteAbort

/**
 * An Electron app's page in a test: the first window the app opens. It finds, acts and checks as a web page does, and
 * reloads and moves through its history, but it has no address to go to.
 */
export type ElectronPage = Omit<Page<false>, 'goto' | 'popup' | 'route' | 'unroute'> & {
  readonly goto: RetestTypeError<'An Electron app has no address. Its page is the first window the app opens.'>
  readonly popup: RetestTypeError<"A test reaches only an Electron app's first window. popup() is for a browser's page.">
  readonly route: RetestTypeError<"Retest does not answer an Electron app's requests yet. route() is for a browser's page.">
  readonly unroute: RetestTypeError<"Retest does not answer an Electron app's requests yet. unroute() is for a browser's page.">
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
   * Replaces the field's value by typing, as a person would. A secret, or a code from an inbox's message, is typed by
   * the process that runs Retest.
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
   * Gives an `<input type="file">` the files, in place of those it held, as a person choosing them in the picker
   * would: the page hears its `input` and `change` events. The input must be there and enabled, and need not be
   * visible. A path is read against the folder of the file that makes the call; an empty list clears the input.
   *
   * @example await page.getByLabel('Attachment').setInputFiles('./fixtures/report.pdf')
   */
  setInputFiles(files: InputFiles, options?: CallOptions): Promise<void>
  /**
   * Drags the element onto the element `target` finds, once both are visible, stable and not covered, in view
   * together: it presses the mouse at the element's centre, moves it through `steps` positions, 5 unless given, to the
   * target's centre, and releases it there. When the page begins an HTML drag, the browser's drag events carry it to
   * the target, so the page's `drop` handler reads its `dataTransfer`.
   *
   * @example await page.getByText('Write release notes').dragTo(page.getByTestId('done-column'))
   */
  dragTo(target: Locator, options?: DragOptions): Promise<void>
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
