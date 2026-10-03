import type {
  BrowserCommand,
  LaunchOptions,
  NewPageOptions,
  OwnedBrowser,
  OwnedPage,
  PageNavigation,
  PageReading,
  TextQuery,
} from '../../src/browser/contract.ts'
import type { ObserveAfter, CommandResult, Observation } from '../../src/protocol/commands.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { OptionChoiceRecord } from '../../src/protocol/option-choices.ts'
import type { NavigationCause, PageFacts } from '../../src/protocol/page-facts.ts'
import type { StorageState, StoredCookie } from '../../src/protocol/storage-state.ts'
import type { LaunchBrowser } from '../../src/runner/run.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { LaunchError } from '../../src/browser/contract.ts'
import { describeCommand } from '../../src/protocol/commands.ts'
import { failureSchema } from '../../src/protocol/failures.ts'
import { pageTextHolds } from '../../src/protocol/host-check.ts'
import { describeLocator } from '../../src/protocol/locator.ts'
import { describeOptionChoice } from '../../src/protocol/option-choices.ts'
import { parse } from '../../src/protocol/schema.ts'
import { observationOf } from './observation.ts'

/**
 * How the page answers a command during which the browser is lost: it had sent the command's input, it
 * had not, or it gives no answer until the command's timeout.
 */
export type DisconnectStage = 'after_input' | 'before_input' | 'no_answer'

/** Faults and timings for the fake browser. Every switch is off by default. */
export type FakeOptions = {
  /** How long the task app takes to show a saved task. */
  saveDelayMs?: number
  /** Commands of this kind never answer before their timeout, unless they are stopped. */
  hang?: BrowserCommand['kind']
  /** How long past its timeout a hanging command answers, as a page that found its element at the deadline does. */
  overrunMs?: number
  /** The page keeps waiting after it is told to stop, as a page that no longer answers would. */
  ignoresStop?: boolean
  /** The browser is lost while a command of this kind runs. */
  disconnect?: { on: BrowserCommand['kind']; stage: DisconnectStage }
  disposeFails?: boolean
  /** How long closing a page takes. */
  disposeDelayMs?: number
  /** `newPage` waits for this before it opens a page. Pages are counted from 0 across the run. */
  holdOpening?: (index: number) => Promise<void>
  /** A page waits for this before it closes. */
  holdClosing?: (index: number) => Promise<void>
  screenshotFails?: boolean
  launchFails?: string
  /** The version each browser reports, which an emulated device's user agent carries. */
  version?: string
  /** Reading a page's sign-in state fails. */
  captureFails?: boolean
  /** Called with each command as it arrives, before it runs. */
  onCommand?: (command: BrowserCommand) => void
  /** Each command's answer waits for this, as the answer of a page that is slow to reply, whatever stopped it meanwhile. */
  holdAnswer?: (command: BrowserCommand) => Promise<void>
  /**
   * Called as each `readPage` begins, with the page and how many reads it answered before, so a test can change
   * what the page shows, lose the browser, or throw as a read that fails.
   */
  onRead?: (page: FakePage, earlierReads: number) => void | Promise<void>
  /** The title each path shows, such as `{ '/tasks': 'Tasks' }`. A path not listed has none. */
  titles?: Readonly<Record<string, string>>
  /**
   * How long after its commit a new document's title settles, as a page whose `DOMContentLoaded` comes late,
   * unless the next command to the page or the next commit settles it first. A `goto` settles its own before it
   * answers, as it answers after `load`. Absent, every title settles at once.
   */
  titleDelayMs?: number
}

type Element = { text: string; visible: boolean }
type Press = Extract<BrowserCommand, { kind: 'press' }>
type Select = Extract<BrowserCommand, { kind: 'select' }>
type Check = Extract<BrowserCommand, { kind: 'check' | 'uncheck' }>
type Scroll = Extract<BrowserCommand, { kind: 'scroll' }>

/** An option of a fake `<select>`. */
export type FakeOption = { label: string; value: string }

/** A fake `<select>`: its options, whether it takes several, and the values chosen. */
export type FakeSelect = { options: FakeOption[]; multiple: boolean; selected: string[] }

/**
 * A fake checkbox or radio button. A hidden one is ticked through its label; a stuck one takes the click and
 * stays as it was.
 */
export type FakeCheckbox = { role: 'checkbox' | 'radio'; checked: boolean; hidden?: true; stuck?: true }

/** The input a `check` or `uncheck` sent: a click or a tap, on the control or on its label. */
export type Ticked = { testId: string; input: 'click' | 'tap'; via?: 'label' }

/** A wheel a `scroll` turned, at an element or at the viewport's centre. */
export type Scrolled = { testId?: string; x: number; y: number }

/** What a `fill` typed, and the secret it came from, if it did. */
export type Typed = { value: string; secret?: string; url: string | undefined }

/** A key a `press` sent, and the element it went to; none for the page's keyboard. */
export type Pressed = { key: string; testId?: string }

const sessionCookie = 'session'

/**
 * A page holding a small task app: a title field, a save button and the saved task. `sign-in` sets a session
 * cookie and `session` shows whether one is there; `typed-value` shows the last text typed, as a page that echoes
 * its input would. A page that emulates a touch screen taps where it is asked to click, and says so. Enter in
 * the title field saves the task, as a form would. Its visible text is the save button's and the saved task's.
 * `tasks-link` opens `/tasks` when clicked. `country` is a select of one and `toppings` a select of several;
 * `remember-me` is a checkbox, `styled-terms` a hidden one with a label, `sticky-box` one that ignores its click
 * and `plan-monthly` a radio button; `terms` is a box that scrolls. Each command that passes names the page it
 * went to, read before its input, and every title a navigation told settles before a command begins.
 */
export class FakePage implements OwnedPage {
  readonly #browser: FakeBrowser
  /** The options the runner opened the page with. */
  readonly options: NewPageOptions
  readonly #navigation = new Set<(navigation: PageNavigation) => void>()
  /** Settles the title of each navigation told whose title has not settled yet. */
  #unsettledTitles: (() => void)[] = []
  title = ''
  /** The document's title, as `document.title` reads it, which a test may change as an app does. */
  documentTitle = ''
  saved: Element = { text: '', visible: false }
  clicks = 0
  disposed = false
  /** The origin and path the page is on. */
  url: string | undefined
  cookies: StoredCookie[]
  /** Everything each `fill` typed into the page. */
  readonly typed: Typed[] = []
  /** The commands that were stopped before they sent any input. */
  readonly stopped: BrowserCommand[] = []
  /** Every key a `press` sent, in order. */
  readonly pressed: Pressed[] = []
  /** The queries of each `readPage`, in order. */
  readonly reads: TextQuery[][] = []
  /** Whether a read finds the frame opening another document. */
  navigating = false
  /** Whether the document has a body to read text from, as an XML or SVG document does not. */
  hasBody = true
  /** The token the runner gave each command, in the order the commands arrived. */
  readonly commandTokens: (number | undefined)[] = []
  /** The page's selects, by test id. */
  readonly selects: Map<string, FakeSelect> = new Map([
    ['country', { options: [option('Canada', 'ca'), option('France', 'fr'), option('Mexico', 'mx')], multiple: false, selected: ['ca'] }],
    ['toppings', { options: [option('Cheese', 'cheese'), option('Olives', 'olives'), option('Basil', 'basil')], multiple: true, selected: [] }],
  ])
  /** The page's checkboxes and radio buttons, by test id. */
  readonly checkboxes: Map<string, FakeCheckbox> = new Map<string, FakeCheckbox>([
    ['remember-me', { role: 'checkbox', checked: false }],
    ['styled-terms', { role: 'checkbox', checked: false, hidden: true }],
    ['sticky-box', { role: 'checkbox', checked: false, stuck: true }],
    ['plan-monthly', { role: 'radio', checked: false }],
  ])
  /** Every click or tap a `check` or `uncheck` sent, in order. */
  readonly ticked: Ticked[] = []
  /** Every wheel a `scroll` turned, in order. */
  readonly scrolled: Scrolled[] = []
  /** How many times the document changed, as the real page's observer would count: every command that took effect, and every move. */
  changes = 0
  readonly #changeWaiters = new Set<() => void>()

  constructor(browser: FakeBrowser, options: NewPageOptions) {
    this.#browser = browser
    this.options = options
    this.cookies = options.storageState?.cookies.map((cookie) => ({ ...cookie })) ?? []
  }

  /** The base URL the page resolves against, as the runner passed it. */
  get baseUrl(): string | undefined {
    return this.options.baseUrl
  }

  /** The browser the page belongs to. */
  get browser(): FakeBrowser {
    return this.#browser
  }

  /** The page's text as `document.body.innerText` reads it: the save button and the saved task while it shows. */
  get visibleText(): string {
    return ['Save', ...(this.saved.visible ? [this.saved.text] : [])].join('\n')
  }

  // A browser about to be lost settles no title first.
  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult> {
    const options = this.#browser.options
    if (options.disconnect?.on !== command.kind) this.#settleTitles()
    this.#browser.commands.push(command)
    this.commandTokens.push(commandToken)
    options.onCommand?.(command)
    const result = await this.#run(command, timeoutMs, signal, commandToken)
    if (result.ok && command.kind !== 'observe') this.changed()
    await options.holdAnswer?.(command)
    return result
  }

  /** The document changed, as a test changes `saved` by hand: every look waiting for a change is answered. */
  changed(): void {
    this.changes += 1
    for (const wake of [...this.#changeWaiters]) wake()
  }

  async #awaitChange(after: ObserveAfter, timeoutMs: number, signal: AbortSignal | undefined): Promise<number> {
    const waitMs = Math.min(after.waitMs, timeoutMs)
    if (this.changes > after.changes || waitMs <= 0) return 0
    const startedAt = Date.now()
    await new Promise<void>((resolve) => {
      const wake = (): void => {
        this.#changeWaiters.delete(wake)
        clearTimeout(timer)
        signal?.removeEventListener('abort', wake)
        resolve()
      }
      const timer = setTimeout(wake, waitMs)
      this.#changeWaiters.add(wake)
      signal?.addEventListener('abort', wake, { once: true })
    })
    return Date.now() - startedAt
  }

  async #run(command: BrowserCommand, timeoutMs: number, signal: AbortSignal | undefined, commandToken: number | undefined): Promise<CommandResult> {
    const options = this.#browser.options
    if (signal?.aborted === true) return this.#stop(command, signal)
    if (options.hang === command.kind) {
      if (await this.#waitUnlessStopped(timeoutMs + (options.overrunMs ?? 0), signal)) return this.#stop(command, signal)
      return { ok: false, failure: { class: 'timeout', message: `${command.kind} took longer than ${timeoutMs} ms.` } }
    }
    if (options.disconnect?.on === command.kind) return this.#lose(command, options.disconnect.stage, timeoutMs)
    switch (command.kind) {
      case 'goto':
        return this.#goto(command.url, commandToken)
      case 'press':
        return this.#press(command, timeoutMs, signal)
      case 'select':
        return this.#select(command, timeoutMs, signal)
      case 'check':
      case 'uncheck':
        return this.#check(command, timeoutMs, signal)
      case 'scroll':
        return this.#scroll(command, timeoutMs, signal)
      case 'observePage': {
        const title = this.#rawTitle()
        const observation = { url: this.url ?? null, title: this.navigating ? null : (title ?? '') }
        const base = this.baseUrl === undefined ? {} : { baseUrl: this.baseUrl }
        return { ok: true, kind: 'observePage', observation, changes: this.changes, ...base, ...this.#facts() }
      }
      case 'reload':
      case 'goBack':
      case 'goForward':
      case 'hover':
        return { ok: false, failure: { class: 'unsupported', message: `The fake page cannot ${describeCommand(command)}.` } }
    }
    const testId = command.locator.by === 'testId' ? command.locator.value : undefined
    const touch = this.options.emulation?.touch === true
    if (testId === undefined || (command.kind === 'tap' && !touch)) {
      return { ok: false, failure: { class: 'unsupported', message: `The fake page cannot ${describeCommand(command)}.` } }
    }
    if (command.kind === 'observe') {
      const waitedMs = command.after === undefined ? 0 : await this.#awaitChange(command.after, timeoutMs, signal)
      const waited = waitedMs > 0 ? { waitedMs } : {}
      return { ok: true, kind: 'observe', observation: this.#observe(testId), changes: this.changes, ...waited, ...this.#facts() }
    }
    const action = command.kind === 'fill' ? command : { kind: touch ? 'tap' : 'click', locator: command.locator } as const
    const missing = await this.#find(action, action.locator, timeoutMs, signal)
    if (missing !== undefined) return missing
    const facts = this.#facts()
    if (action.kind === 'fill') this.#fill(action)
    else this.#click(testId, commandToken)
    return { ok: true, kind: action.kind, ...facts }
  }

  /**
   * The page moves by itself, as a redirect or a timer moves it, or, with `action`, as a link the test clicked
   * does, naming the token of the command whose input it was. The address moves at once; the title settles as
   * `titleDelayMs` says.
   */
  navigate(path: string, cause: NavigationCause = 'page', commandToken?: number): void {
    const url = URL.parse(path, this.url ?? this.baseUrl)
    if (url === null) throw new Error(`The fake page cannot open ${path}.`)
    this.#commit(url, { cause, commandToken }, false)
  }

  async captureState(): Promise<StorageState> {
    if (this.#browser.options.captureFails === true) throw new Error('The cookies could not be read.')
    return { cookies: this.cookies.map((cookie) => ({ ...cookie })), origins: [] }
  }

  async screenshot(): Promise<Uint8Array> {
    if (this.#browser.options.screenshotFails === true) throw new Error('The page could not be captured.')
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  }

  async readPage(queries: readonly TextQuery[]): Promise<PageReading> {
    const earlier = this.reads.push([...queries]) - 1
    await this.#browser.options.onRead?.(this, earlier)
    if (!this.#browser.connected) throw new BrowserError({ class: 'session_lost', message: 'The page lost its browser.' })
    const text = this.hasBody ? this.visibleText : ''
    const title = this.#rawTitle()
    const body = this.hasBody ? {} : { body: false as const }
    return { url: this.url, ...(title === undefined ? {} : { title }), navigating: this.navigating, found: queries.map((query) => pageTextHolds(text, query)), ...body }
  }

  onNavigation(listener: (navigation: PageNavigation) => void): () => void {
    this.#navigation.add(listener)
    return () => this.#navigation.delete(listener)
  }

  async dispose(): Promise<void> {
    await this.#browser.options.holdClosing?.(this.#browser.pages.indexOf(this))
    await sleep(this.#browser.options.disposeDelayMs ?? 0)
    if (this.#browser.options.disposeFails === true) throw new Error('The browser context would not close.')
    this.disposed = true
  }

  #goto(url: string, commandToken: number | undefined): CommandResult {
    const resolved = URL.parse(url, this.baseUrl)
    if (resolved === null) return { ok: false, failure: { class: 'usage', message: `Cannot open ${url}.` } }
    const page = this.#commit(resolved, { cause: 'goto', commandToken }, true)
    return { ok: true, kind: 'goto', url: page, ...this.#facts() }
  }

  // A later commit settles the title of the one before, with the title it had then. The page hands over its title
  // as it has it, and the parent cleans it.
  #commit(url: URL, started: { cause: NavigationCause; commandToken: number | undefined }, settleAtOnce: boolean): string {
    this.#settleTitles()
    const address = `${url.origin}${url.pathname}`
    this.url = address
    this.documentTitle = this.#browser.options.titles?.[url.pathname] ?? ''
    const title = Promise.withResolvers<string | undefined>()
    const settle = (): void => title.resolve(this.#rawTitle())
    const delay = this.#browser.options.titleDelayMs
    if (settleAtOnce || delay === undefined) settle()
    else {
      this.#unsettledTitles.push(settle)
      setTimeout(settle, delay).unref()
    }
    const token = started.commandToken === undefined ? {} : { commandToken: started.commandToken }
    for (const listener of this.#navigation) listener({ url: address, title: title.promise, cause: started.cause, document: 'new', ...token })
    return address
  }

  // The title as `document.title` reads it, and none when it is empty.
  #rawTitle(): string | undefined {
    return this.documentTitle === '' ? undefined : this.documentTitle
  }

  #settleTitles(): void {
    const unsettled = this.#unsettledTitles
    this.#unsettledTitles = []
    for (const settle of unsettled) settle()
  }

  // The page as the command found it, before its input: its address, and its title when it has one.
  #facts(): { page?: PageFacts } {
    if (this.url === undefined) return {}
    const title = this.#rawTitle()
    return { page: title === undefined ? { url: this.url } : { url: this.url, title } }
  }

  // A key on the page's keyboard goes to whatever has the focus, which the fake does not track.
  async #press(command: Press, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandResult> {
    const { locator, key } = command
    if (locator === undefined) {
      const facts = this.#facts()
      this.pressed.push({ key })
      return { ok: true, kind: 'press', ...facts }
    }
    if (locator.by !== 'testId') return { ok: false, failure: { class: 'unsupported', message: `The fake page cannot ${describeCommand(command)}.` } }
    const missing = await this.#find(command, locator, timeoutMs, signal)
    if (missing !== undefined) return missing
    const facts = this.#facts()
    this.pressed.push({ key, testId: locator.value })
    if (key === 'Enter' && locator.value === 'task-title') this.#click('save-task')
    return { ok: true, kind: 'press', ...facts }
  }

  // Chooses exactly the options named, as a script in the page does, or says why it cannot.
  async #select(command: Select, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandResult> {
    const { locator, choices } = command
    const missing = await this.#find(command, locator, timeoutMs, signal)
    if (missing !== undefined) return missing
    const select = locator.by === 'testId' ? this.selects.get(locator.value) : undefined
    const described = describeLocator(locator)
    if (select === undefined) return { ok: false, failure: { class: 'unsupported', message: `${described} is not a <select>.` } }
    if (command.multiple === true && !select.multiple) {
      return { ok: false, failure: { class: 'usage', message: `${described} takes one option, and select() was given a list.` } }
    }
    const values: string[] = []
    for (const choice of choices) {
      const matches = select.options.filter((each) => matchesChoice(each, choice))
      const [only] = matches
      if (only === undefined) return { ok: false, failure: { class: 'not_found', message: `${described} has no option ${describeOptionChoice(choice)}.` } }
      if (matches.length > 1) return { ok: false, failure: { class: 'ambiguous', message: `${described} has ${matches.length} options ${describeOptionChoice(choice)}.` } }
      values.push(only.value)
    }
    const facts = this.#facts()
    const changed = values.length !== select.selected.length || values.some((value) => !select.selected.includes(value))
    select.selected = values
    return { ok: true, kind: 'select', changed, ...facts }
  }

  // Clicks, or taps, a control once when it is not as asked, through its label when it is hidden.
  async #check(command: Check, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandResult> {
    const { locator, kind } = command
    const missing = await this.#find(command, locator, timeoutMs, signal)
    if (missing !== undefined) return missing
    const testId = locator.by === 'testId' ? locator.value : undefined
    const control = testId === undefined ? undefined : this.checkboxes.get(testId)
    const described = describeLocator(locator)
    if (testId === undefined || control === undefined) return { ok: false, failure: { class: 'unsupported', message: `${described} is not a checkbox or a radio button.` } }
    if (kind === 'uncheck' && control.role === 'radio') {
      return { ok: false, failure: { class: 'unsupported', message: `${described} is a radio button; choose another to uncheck it.` } }
    }
    const wanted = kind === 'check'
    const facts = this.#facts()
    if (control.checked === wanted) return { ok: true, kind, changed: false, ...facts }
    const via = control.hidden === true ? ({ via: 'label' } as const) : {}
    this.ticked.push({ testId, input: this.options.emulation?.touch === true ? 'tap' : 'click', ...via })
    if (control.stuck === true) {
      const message = `Retest clicked ${described} once, and it stayed ${wanted ? 'unchecked' : 'checked'}. Retest does not click again.`
      return { ok: false, failure: { class: 'not_actionable', message, details: { check: 'state', inputSent: true } } }
    }
    control.checked = wanted
    return { ok: true, kind, changed: true, ...via, ...facts }
  }

  // Turns the wheel at an element, or at the viewport's centre when there is no locator.
  async #scroll(command: Scroll, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandResult> {
    const { locator, x, y } = command
    if (locator === undefined) {
      const facts = this.#facts()
      this.scrolled.push({ x, y })
      return { ok: true, kind: 'scroll', ...facts }
    }
    const missing = await this.#find(command, locator, timeoutMs, signal)
    if (missing !== undefined) return missing
    const facts = this.#facts()
    this.scrolled.push({ ...(locator.by === 'testId' ? { testId: locator.value } : {}), x, y })
    return { ok: true, kind: 'scroll', ...facts }
  }

  #fill(command: Extract<BrowserCommand, { kind: 'fill' }>): void {
    this.typed.push({ value: command.value, ...(command.secret === undefined ? {} : { secret: command.secret }), url: this.url })
    this.title = command.value
  }

  // The page answers from what it knows about its own input, as a real page does once its connection is gone.
  async #lose(command: BrowserCommand, stage: DisconnectStage, timeoutMs: number): Promise<CommandResult> {
    const reason = 'The browser process exited.'
    this.#browser.disconnect(reason)
    const described = describeCommand(command)
    if (stage === 'after_input') {
      return { ok: false, failure: { class: 'outcome_unknown', message: `The page lost its browser after ${described} sent its input: ${reason}` } }
    }
    if (stage === 'no_answer') await sleep(timeoutMs)
    return { ok: false, failure: { class: 'session_lost', message: `The page lost its browser before ${described} sent any input: ${reason}` } }
  }

  #click(testId: string, commandToken?: number): void {
    if (testId === 'tasks-link') {
      this.navigate('/tasks', 'action', commandToken)
      return
    }
    if (testId === 'sign-in') {
      const value = `signed-in-${this.#browser.pages.indexOf(this)}`
      this.cookies = [{ name: sessionCookie, value, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false }]
      return
    }
    if (testId !== 'save-task') return
    this.clicks++
    const title = this.title
    this.saved = { text: 'Saving…', visible: true }
    setTimeout(() => {
      this.saved = { text: title, visible: true }
    }, this.#browser.options.saveDelayMs ?? 0)
  }

  #elements(testId: string): Element[] {
    if (testId === 'repeated-task') return [{ text: 'One', visible: true }, { text: 'One', visible: true }]
    const found = this.#element(testId)
    return found === undefined ? [] : [found]
  }

  #element(testId: string): Element | undefined {
    switch (testId) {
      case 'task-title':
        return { text: this.title, visible: true }
      case 'save-task':
      case 'sign-in':
        return { text: testId === 'sign-in' ? 'Sign in' : 'Save', visible: true }
      case 'saved-task':
        return this.saved
      case 'hidden-note':
        return { text: 'Hidden', visible: false }
      case 'spaced-title':
        return { text: '  Release\n   checklist  ', visible: true }
      case 'session':
        return { text: this.cookies.some((cookie) => cookie.name === sessionCookie) ? 'Signed in' : 'Signed out', visible: true }
      case 'typed-value':
        return { text: this.typed.at(-1)?.value ?? '', visible: true }
      case 'password':
        return { text: '', visible: true }
      case 'tasks-link':
        return { text: 'Tasks', visible: true }
      case 'terms':
        return { text: 'Terms of use', visible: true }
      default:
        return this.#control(testId)
    }
  }

  // A select shows its chosen options' labels; a control its own state, which a hidden one shows through its label.
  #control(testId: string): Element | undefined {
    const select = this.selects.get(testId)
    if (select !== undefined) {
      const labels = select.options.filter((each) => select.selected.includes(each.value)).map((each) => each.label)
      return { text: labels.join(', '), visible: true }
    }
    const control = this.checkboxes.get(testId)
    if (control === undefined) return undefined
    return { text: control.checked ? 'checked' : 'unchecked', visible: control.hidden !== true }
  }

  #observe(testId: string): Observation {
    return observationOf(this.#elements(testId), testId === 'task-title' ? this.title : null)
  }

  // Undefined when exactly one element matches; otherwise the failure an action gets.
  async #find(action: BrowserCommand, recipe: LocatorRecipe, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandResult | undefined> {
    const locator = describeLocator(recipe)
    const count = recipe.by === 'testId' ? this.#elements(recipe.value).length : 0
    if (count > 1) return { ok: false, failure: { class: 'ambiguous', message: `${locator} matched ${count} elements.` } }
    if (count === 1) return undefined
    if (await this.#waitUnlessStopped(timeoutMs, signal)) return this.#stop(action, signal)
    return { ok: false, failure: { class: 'not_found', message: `${locator} matched no element in ${timeoutMs} ms.` } }
  }

  // True when the wait ended because the command was stopped.
  async #waitUnlessStopped(timeoutMs: number, signal: AbortSignal | undefined): Promise<boolean> {
    const listening = this.#browser.options.ignoresStop === true ? undefined : signal
    return sleep(timeoutMs, false, { signal: listening }).catch(() => true)
  }

  // A stopped command sends nothing, and its failure takes its class and first words from the reason.
  #stop(command: BrowserCommand, signal: AbortSignal | undefined): CommandResult {
    this.stopped.push(command)
    const reason = parse(failureSchema, signal?.reason)
    const cause: Failure = reason.ok ? reason.value : { class: 'timeout', message: 'The time ran out.' }
    const message = `${cause.message} ${describeCommand(command)} was stopped before it sent any input.`
    return { ok: false, failure: { class: cause.class, message, details: { ...cause.details, inputSent: false } } }
  }
}

function option(label: string, value: string): FakeOption {
  return { label, value }
}

function matchesChoice(each: FakeOption, choice: OptionChoiceRecord): boolean {
  return 'label' in choice ? each.label === choice.label : each.value === choice.value
}

// Above any process id an operating system hands out, so nothing can mistake a fake for a real process.
const firstFakePid = 2 ** 31 - 1

export class FakeBrowser implements OwnedBrowser {
  readonly product = 'FakeChromium'
  readonly version: string
  readonly userAgent: string
  readonly pid: number
  readonly executablePath: string
  readonly options: FakeOptions
  readonly launchOptions: LaunchOptions
  readonly pages: FakePage[] = []
  readonly commands: BrowserCommand[] = []
  /** The budget each `newPage` was given. */
  readonly pageBudgets: number[] = []
  readonly #listeners = new Set<(reason: string) => void>()
  connected = true
  closed = false
  /** The budget `close` was given. */
  closeBudget: number | undefined

  constructor(options: FakeOptions, launchOptions: LaunchOptions, pid: number = firstFakePid) {
    this.options = options
    this.launchOptions = launchOptions
    this.executablePath = launchOptions.executablePath
    this.pid = pid
    this.version = options.version ?? '140.0.0.0'
    this.userAgent = `FakeChromium/${this.version}`
  }

  async newPage(options: NewPageOptions, timeoutMs: number): Promise<FakePage> {
    const index = this.pageBudgets.push(timeoutMs) - 1
    await this.options.holdOpening?.(index)
    if (!this.connected) throw new Error('The browser is not connected.')
    const page = new FakePage(this, options)
    this.pages.push(page)
    return page
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(timeoutMs: number): Promise<void> {
    this.closeBudget ??= timeoutMs
    this.closed = true
    this.disconnect('The browser was closed.')
  }

  disconnect(reason: string): void {
    if (!this.connected) return
    this.connected = false
    for (const listener of this.#listeners) listener(reason)
  }
}

/** A launcher that records every fake browser it starts. Each browser gets a process id of its own. */
export function fakeLauncher(options: FakeOptions = {}): { launch: LaunchBrowser; browsers: FakeBrowser[] } {
  const browsers: FakeBrowser[] = []
  const launch: LaunchBrowser = async (launchOptions) => {
    if (options.launchFails !== undefined) throw new LaunchError(options.launchFails)
    const browser = new FakeBrowser(options, launchOptions, firstFakePid - browsers.length)
    browsers.push(browser)
    return browser
  }
  return { launch, browsers }
}
