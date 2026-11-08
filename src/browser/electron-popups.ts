import type { BrowserCommand, DispatchedCommand, FilesCapability, PageNavigation, PageReading, RequestResult, SessionIdentity, TextQuery, WebSession } from './contract.ts'
import type { DialogArming, DialogReply, UnwaitedDialog } from './dialogs.ts'
import type { AppWindowWaits } from './electron-window-watch.ts'
import type { PopupArming, PopupWaitOptions } from './popups.ts'
import type { RouteRemoval } from './routes.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import { BrowserError } from './browser-error.ts'
import { browserCommandLocators, framesUnreached } from './frames.ts'
import { routesRefused } from './routes.ts'

// The windows an Electron app opens after its first, which `page.popup()` gives a test. Each is a Chromium page Retest set
// up while the app held it, as a Chrome popup is, and refuses by name what the app's first window refuses: an address to
// go to, a frame, a route and a saved state. Closing one closes that window alone; the app quits when the test's page,
// its first window, is disposed.

/** Which Electron app and target a window belongs to, as the config names them, and the target the window is. */
export type AppWindow = { readonly app: string; readonly target: string; readonly targetId: string }

/**
 * What a window `page.popup()` gave a test is made of: its page as Retest set it up, the app it belongs to, the app's
 * waits, and `reached`, which tells the app's windows record the name the test reaches it by.
 */
export type ElectronPopupParts = AppWindow & {
  readonly window: WebSession
  readonly waits: AppWindowWaits
  readonly reached: (targetId: string, page: string) => void
}

/**
 * True for a command that may act on the app: any but a look. A window the app's main process opens is given to a wait
 * only once such a command began after the wait did.
 *
 * @example acts({ kind: 'observe', locator }) // false
 */
export function acts(command: BrowserCommand): boolean {
  return !command.kind.startsWith('observe')
}

/**
 * Arms a window of an Electron app for the next window it opens: a window it opened from its document, which its page
 * hands over as a Chrome page hands over a popup, or a window the app's main process opened while the wait lasted, once
 * a command acted in the app. One window of an app waits at a time, since a window the main process opens names none
 * that opened it.
 *
 * @example await armWindow(window, waits, { app: 'desktop', target: 'electron', targetId }, { timeoutMs: 5000, setupMs: 10_000 })
 */
export async function armWindow(window: WebSession, waits: AppWindowWaits, { app, targetId }: AppWindow, options: PopupWaitOptions): Promise<PopupArming> {
  if (window.armPopup === undefined) return { ok: false, failure: { class: 'unsupported', message: `The window of the Electron app ${app} cannot hand a test the windows it opens.` } }
  const done = waits.wait(targetId)
  if (done === undefined) {
    const message = `page.popup() is already waiting on another window of the Electron app ${app}. A window the app's main process opens names no window that opened it, so Retest could not tell which wait it answers. Await the first page.popup() before the next.`
    return { ok: false, failure: { class: 'usage', message } }
  }
  const arming = await window.armPopup(options)
  if (!arming.ok) {
    done()
    return arming
  }
  void arming.opened.then(done, done)
  return arming
}

/**
 * A window an Electron app opened after its first, given to a test by `page.popup()`. Every command, read and check goes
 * to it as to a Chrome popup, and so do its own dialogs and popups; `goto`, a frame, a route and a saved state are
 * refused by name, as on the app's first window. Disposing it closes the window, and leaves the app running.
 *
 * @example new ElectronPopupWindow({ window, app: 'desktop', target: 'electron', targetId, waits, reached: (id, page) => windows.reached(id, page) })
 */
export class ElectronPopupWindow implements WebSession {
  readonly #window: WebSession
  readonly #app: AppWindow
  readonly #waits: AppWindowWaits
  readonly #reached: (targetId: string, page: string) => void

  constructor(parts: ElectronPopupParts) {
    this.#window = parts.window
    this.#app = { app: parts.app, target: parts.target, targetId: parts.targetId }
    this.#waits = parts.waits
    this.#reached = parts.reached
  }

  get url(): string | undefined {
    return this.#window.url
  }

  /** The window's file pickers, caught as a Chrome popup's are. */
  get files(): FilesCapability | undefined {
    return this.#window.files
  }

  /** Names the window as the runner holds it, and tells the app's windows record which page of the test it became. */
  identify(session: SessionIdentity): void {
    this.#window.identify?.(session)
    this.#reached(this.#app.targetId, session.owner.app)
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<CommandResult> {
    return (await this.dispatch(command, timeoutMs, signal, commandToken)).result
  }

  async dispatch(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand> {
    const { app, target } = this.#app
    if (command.kind === 'goto') {
      const message = `goto() is not available on a window of the Electron app ${app} (target ${target}): the app has no address, and the window shows what the app opened in it.`
      return { result: { ok: false, failure: { class: 'unsupported', message, details: { app, target, command: 'goto' } } }, input: 'not_sent' }
    }
    // No test has looked inside a frame of an Electron window yet, so a frame there is refused by name.
    const unreached = framesUnreached(browserCommandLocators(command), `a window of the Electron app ${app}`)
    if (unreached !== undefined) return { result: { ok: false, failure: unreached }, input: 'not_sent' }
    if (acts(command)) this.#waits.acted()
    return this.#window.dispatch(command, timeoutMs, signal, commandToken)
  }

  capture(timeoutMs: number): ReturnType<NonNullable<WebSession['capture']>> {
    return this.#window.capture === undefined ? Promise.resolve({ ok: false, failure: { class: 'unsupported', message: 'The window provides no attributed capture.' } }) : this.#window.capture(timeoutMs)
  }

  screenshot(timeoutMs: number): Promise<Uint8Array> {
    return this.#window.screenshot(timeoutMs)
  }

  readPage(queries: readonly TextQuery[], timeoutMs: number): Promise<PageReading> {
    return this.#window.readPage(queries, timeoutMs)
  }

  onNavigation(listener: (navigation: PageNavigation) => void): () => void {
    return this.#window.onNavigation(listener)
  }

  armDialog(timeoutMs: number, signal?: AbortSignal): DialogArming {
    return this.#window.armDialog?.(timeoutMs, signal) ?? { ok: false, failure: { class: 'unsupported', message: `A window of the Electron app ${this.#app.app} cannot hand its dialogs to a test.` } }
  }

  // An answer is input to the app, which its main process may answer with a window.
  answerDialog(id: string, reply: DialogReply, timeoutMs: number): Promise<RequestResult> {
    if (this.#window.answerDialog === undefined) return Promise.resolve({ ok: false, failure: { class: 'unsupported', message: `A window of the Electron app ${this.#app.app} cannot answer a dialog for a test.` } })
    this.#waits.acted()
    return this.#window.answerDialog(id, reply, timeoutMs)
  }

  onUnwaitedDialog(listener: (dialog: UnwaitedDialog) => void): () => void {
    return this.#window.onUnwaitedDialog?.(listener) ?? (() => undefined)
  }

  armPopup(options: PopupWaitOptions): Promise<PopupArming> {
    return armWindow(this.#window, this.#waits, this.#app, options)
  }

  // The app's windows hold no route: Retest has not checked how an app's own requests meet a window's Fetch domain.
  async addRoute(): Promise<RequestResult> {
    return { ok: false, failure: routesRefused('in an Electron app') }
  }

  async removeRoute(): Promise<RouteRemoval> {
    return { ok: false, failure: routesRefused('in an Electron app') }
  }

  async captureState(_timeoutMs: number): Promise<StorageState> {
    const { app, target } = this.#app
    const message = `Retest cannot save a sign-in state from the Electron app ${app}: the app keeps its own storage. Set userDataDir to keep the app's data from one launch to the next.`
    throw new BrowserError({ class: 'unsupported', message, details: { app, target } })
  }

  /** Closes the window, without its `beforeunload` handlers, and the windows it opened while nothing waited first. */
  dispose(timeoutMs: number): Promise<void> {
    return this.#window.dispose(timeoutMs)
  }
}
