import type { BrowserCommand, LaunchOptions, NewPageOptions, OwnedBrowser, OwnedPage } from '../../src/browser/contract.ts'
import type { CommandResult, Observation } from '../../src/protocol/commands.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { StorageState, StoredCookie } from '../../src/protocol/storage-state.ts'
import type { LaunchBrowser } from '../../src/runner/run.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { LaunchError } from '../../src/browser/contract.ts'
import { describeCommand } from '../../src/protocol/commands.ts'
import { failureSchema } from '../../src/protocol/failures.ts'
import { describeLocator } from '../../src/protocol/locator.ts'
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
}

type Element = { text: string; visible: boolean }
type ElementAction = Extract<BrowserCommand, { kind: 'click' | 'tap' | 'fill' }>

/** What a `fill` typed, and the secret it came from, if it did. */
export type Typed = { value: string; secret?: string; url: string | undefined }

const sessionCookie = 'session'

/**
 * A page holding a small task app: a title field, a save button and the saved task. `sign-in` sets a session
 * cookie and `session` shows whether one is there; `typed-value` shows the last text typed, as a page that echoes
 * its input would. A page that emulates a touch screen taps where it is asked to click, and says so.
 */
export class FakePage implements OwnedPage {
  readonly #browser: FakeBrowser
  /** The options the runner opened the page with. */
  readonly options: NewPageOptions
  readonly #navigation = new Set<(url: string) => void>()
  title = ''
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

  constructor(browser: FakeBrowser, options: NewPageOptions) {
    this.#browser = browser
    this.options = options
    this.cookies = options.storageState?.cookies.map((cookie) => ({ ...cookie })) ?? []
  }

  /** The base URL the page resolves against, as the runner passed it. */
  get baseUrl(): string | undefined {
    return this.options.baseUrl
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    const options = this.#browser.options
    this.#browser.commands.push(command)
    options.onCommand?.(command)
    if (signal?.aborted === true) return this.#stop(command, signal)
    if (options.hang === command.kind) {
      if (await this.#waitUnlessStopped(timeoutMs + (options.overrunMs ?? 0), signal)) return this.#stop(command, signal)
      return { ok: false, failure: { class: 'timeout', message: `${command.kind} took longer than ${timeoutMs} ms.` } }
    }
    if (options.disconnect?.on === command.kind) return this.#lose(command, options.disconnect.stage, timeoutMs)
    if (command.kind === 'goto') return this.#goto(command.url)
    const testId = command.locator.by === 'testId' ? command.locator.value : undefined
    const touch = this.options.emulation?.touch === true
    if (testId === undefined || (command.kind === 'tap' && !touch)) {
      return { ok: false, failure: { class: 'unsupported', message: `The fake page cannot ${describeCommand(command)}.` } }
    }
    if (command.kind === 'observe') return { ok: true, kind: 'observe', observation: this.#observe(testId) }
    const action = command.kind === 'fill' ? command : { kind: touch ? 'tap' : 'click', locator: command.locator } as const
    const missing = await this.#find(action, testId, timeoutMs, signal)
    if (missing !== undefined) return missing
    if (action.kind === 'fill') this.#fill(action)
    else this.#click(testId)
    return { ok: true, kind: action.kind }
  }

  async captureState(): Promise<StorageState> {
    if (this.#browser.options.captureFails === true) throw new Error('The cookies could not be read.')
    return { cookies: this.cookies.map((cookie) => ({ ...cookie })), origins: [] }
  }

  async screenshot(): Promise<Uint8Array> {
    if (this.#browser.options.screenshotFails === true) throw new Error('The page could not be captured.')
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  }

  onNavigation(listener: (url: string) => void): () => void {
    this.#navigation.add(listener)
    return () => this.#navigation.delete(listener)
  }

  async dispose(): Promise<void> {
    await this.#browser.options.holdClosing?.(this.#browser.pages.indexOf(this))
    await sleep(this.#browser.options.disposeDelayMs ?? 0)
    if (this.#browser.options.disposeFails === true) throw new Error('The browser context would not close.')
    this.disposed = true
  }

  #goto(url: string): CommandResult {
    const resolved = URL.parse(url, this.baseUrl)
    if (resolved === null) return { ok: false, failure: { class: 'usage', message: `Cannot open ${url}.` } }
    const page = `${resolved.origin}${resolved.pathname}`
    this.url = page
    for (const listener of this.#navigation) listener(page)
    return { ok: true, kind: 'goto', url: page }
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

  #click(testId: string): void {
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
      default:
        return undefined
    }
  }

  #observe(testId: string): Observation {
    return observationOf(this.#elements(testId), testId === 'task-title' ? this.title : null)
  }

  // Undefined when exactly one element matches; otherwise the failure an action gets.
  async #find(action: ElementAction, testId: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<CommandResult | undefined> {
    const locator = describeLocator(action.locator)
    const count = this.#elements(testId).length
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
