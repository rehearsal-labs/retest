import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { PageDialogs, UnwaitedDialog } from './dialogs.ts'
import type { Dispatch } from './dispatch.ts'
import type { PageNavigation, WebSession } from './contract.ts'
import type { CommandResult } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage, failureSchema } from '../protocol/failures.ts'
import { parse, s } from '../protocol/schema.ts'
import { BrowserError } from './browser-error.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { CdpClosedError, CdpDisconnectedError, CdpProtocolError } from './cdp/errors.ts'
import { keptByBeforeunload } from './dialogs.ts'
import { Listeners } from './listeners.ts'

// A page a test's page opens, by `window.open`, a link with a target or a form that posts to a new window, is a target
// of its own in the same browser context. Chrome holds each new page target from its start once `Target.setAutoAttach`
// asks it to, so Retest sees the popup's first document: an OAuth popup navigates at once, and its first page needs
// Retest's input guard as much as any other. The watch is the browser's, started as its first page opens: it holds every
// new page of the browser until Retest lets it go, and every popup of a test's page stays attached, waited for or not,
// so a dialog it opens is answered and told.

/** Where a page's popups are watched for: the browser's watch, and the target the page is. */
export type PopupHome = { readonly watch: PopupWatch; readonly targetId: string }

/**
 * How a popup's page ended: `closed` when its target ended while the browser stayed, as a page that closes itself does,
 * and `lost` with the reason when the connection to the browser ended, which takes every page with it.
 */
export type PopupEnd = { readonly kind: 'closed' } | { readonly kind: 'lost'; readonly reason: string }

/**
 * A page a page opened, set up before its first document and running: its page; `follow`, which hears its navigations,
 * from its first on, those told before the call included, in order; `first`, which settles with its first navigation
 * once it commits within `timeoutMs`, or undefined when none came; `gone`, which settles with how the page ended; and
 * `closed`, which says at once whether its target ended while the browser stayed.
 */
export type OpenedPopup = {
  readonly page: WebSession
  readonly follow: (listener: (navigation: PageNavigation) => void) => () => void
  readonly first: (timeoutMs: number) => Promise<PageNavigation | undefined>
  readonly gone: Promise<PopupEnd>
  readonly closed: () => boolean
}

/** A wait for the next page a page opens: that page, or why none came. */
export type PopupWait = { readonly ok: true; readonly popup: OpenedPopup } | { readonly ok: false; readonly failure: Failure }

/** A page armed for the next page it opens, with the wait for it; or why it cannot be armed. */
export type PopupArming = { readonly ok: true; readonly opened: Promise<PopupWait> } | { readonly ok: false; readonly failure: Failure }

/**
 * How long a wait for a popup lasts, `timeoutMs`, and how long setting the popup's page up may take once it opened,
 * `setupMs`, as a new page's setup does. `signal` stops the wait, with its reason when that is a `Failure`.
 */
export type PopupWaitOptions = { readonly timeoutMs: number; readonly setupMs: number; readonly signal?: AbortSignal | undefined }

/** A new page target the browser holds, by the flat session it attached and the target it is. */
export type HeldTarget = { readonly sessionId: string; readonly targetId: string }

/** A page whose popups the watch hands over: it takes a new page it opened, or leaves it to run on. */
export interface PopupOpener {
  claim(target: HeldTarget): boolean
}

const attachedSchema = s.object({
  sessionId: s.string(),
  targetInfo: s.object({ targetId: s.string(), type: s.string(), subtype: s.optional(s.string()), openerId: s.optional(s.string()) }),
  waitingForDebugger: s.boolean(),
})

const ignore = (): void => {}

// How long a page nobody waited for may take to set up; past it, the page is let run and let go.
const unwaitedSetupMs = 10_000

/**
 * The browser's watch for the pages its pages open. Once started, Chrome holds every new page target, and the watch
 * hands each to the page that opened it when that page waits for one; it lets every other page run on at once,
 * Retest's own new pages among them.
 */
export class PopupWatch {
  readonly #connection: CdpConnection
  readonly #openers = new Map<string, PopupOpener>()
  #starting: Promise<void> | undefined

  constructor(connection: CdpConnection) {
    this.#connection = connection
    connection.on('Target.attachedToTarget', (params) => this.#attached(params))
  }

  /** Lets the pages target `targetId` opens reach `opener`, until the function it returns is called. */
  register(targetId: string, opener: PopupOpener): () => void {
    this.#openers.set(targetId, opener)
    return () => {
      if (this.#openers.get(targetId) === opener) this.#openers.delete(targetId)
    }
  }

  /** Asks the browser, once, to hold every page target it opens from now on. A start that failed is tried again. */
  start(deadline: Deadline): Promise<void> {
    const params = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] }
    const starting = (this.#starting ??= request(this.#connection, 'Target.setAutoAttach', params, s.object({}), sendOptions(deadline)).then(ignore))
    starting.catch(() => {
      if (this.#starting === starting) this.#starting = undefined
    })
    return starting
  }

  // Retest's own attaches, and the pages already open when the watch began, are attached without being held, and are
  // left as they are. A held page that no opener claims is let run, then let go: detaching alone does not let a popup run,
  // and one window.open made holds its opener with it until it does. Only a plain page is a popup: a target with a
  // subtype, as a prerendered page has, is not one, though Chrome prerenders nothing while Retest is attached.
  #attached(params: unknown): void {
    const { sessionId, targetInfo, waitingForDebugger } = readProtocol(attachedSchema, params, { method: 'Target.attachedToTarget' })
    if (!waitingForDebugger) return
    const opener = targetInfo.openerId === undefined ? undefined : this.#openers.get(targetInfo.openerId)
    if (targetInfo.type === 'page' && targetInfo.subtype === undefined && opener?.claim({ sessionId, targetId: targetInfo.targetId }) === true) return
    this.#connection.adopt(sessionId).send('Runtime.runIfWaitingForDebugger').catch(ignore)
    this.#connection.send('Target.detachFromTarget', { sessionId }).catch(ignore)
  }
}

/** What a page's popups need: the browser's connection, where they are watched for, and a way to open a popup's page. */
export type PagePopupsOptions = {
  readonly connection: CdpConnection
  readonly home: PopupHome
  /**
   * Opens the page of a popup from the session the browser attached it with, held, as its opener was opened, and lets
   * it run. `ready` is given the page before anything is sent to it.
   */
  readonly open: (session: CdpSession, home: PopupHome, deadline: Deadline, ready: (page: WebSession) => void) => Promise<WebSession>
  /** Receives errors thrown by listeners of a popup's navigations. */
  readonly onListenerError: (error: unknown) => void
  /** Tells the opener's dialogs of a dialog Retest answered in a popup nothing waited for. */
  readonly forward: (dialog: UnwaitedDialog) => void
}

/** A wait armed for a popup: how it settles, how it is taken once a popup came, and how long the popup's setup may take. */
type Waiter = { readonly settle: (wait: PopupWait) => void; readonly take: () => void; readonly setupMs: number }

/**
 * The popups of one Chromium page. Armed with `arm`, the page hands the next page it opens to the test: set up as a page
 * of its own in the same browser context while the browser holds it, then let run, its navigations kept from its first.
 * A page it opens while nothing waits is set up the same way and kept: a dialog it opens is answered and told as this
 * page's, and it is closed with this page. A later wait takes only a page opened after it began.
 */
export class PagePopups implements PopupOpener {
  readonly #options: PagePopupsOptions
  readonly #unregister: () => void
  // The pages this page opened while nothing waited, kept until this page is disposed.
  readonly #unwaited = new Set<WebSession>()
  #waiter: Waiter | undefined
  #lostReason: string | undefined

  constructor(options: PagePopupsOptions) {
    this.#options = options
    this.#unregister = options.home.watch.register(options.home.targetId, this)
  }

  /**
   * Arms the page for the next page it opens, once the browser's watch has started. The wait settles with that page, or
   * fails when its time runs out, when `signal` aborts, or when this page goes. One wait at a time.
   */
  async arm({ timeoutMs, setupMs, signal }: PopupWaitOptions): Promise<PopupArming> {
    if (this.#lostReason !== undefined) return { ok: false, failure: lost(this.#lostReason) }
    if (this.#waiter !== undefined) return { ok: false, failure: { class: 'usage', message: 'page.popup() is already waiting for a page on this page. Await it before the next one.' } }
    const deadline = new Deadline(timeoutMs, { signal })
    try {
      await this.#options.home.watch.start(deadline)
    } catch (error) {
      if (signal?.aborted === true) return { ok: false, failure: stopped(signal.reason) }
      return { ok: false, failure: { class: 'setup_failed', message: `Retest could not ask the browser to hold the pages this page opens: ${errorMessage(error)}` } }
    }
    if (this.#lostReason !== undefined) return { ok: false, failure: lost(this.#lostReason) }
    const { promise, resolve } = Promise.withResolvers<PopupWait>()
    const timer = setTimeout(() => settle({ ok: false, failure: { class: 'timeout', message: `No page opened within ${deadline.budgetMs} ms.` } }), deadline.waitToEndMs)
    const stop = (): void => settle({ ok: false, failure: stopped(signal?.reason) })
    // A popup that came is set up without the wait's time or signal: it is the test's from then on, whatever happens.
    const take = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      if (this.#waiter === waiter) this.#waiter = undefined
    }
    const waiter: Waiter = { settle: (wait) => settle(wait), take, setupMs }
    const settle = (wait: PopupWait): void => {
      take()
      resolve(wait)
    }
    this.#waiter = waiter
    if (signal?.aborted === true) stop()
    else signal?.addEventListener('abort', stop, { once: true })
    return { ok: true, opened: promise }
  }

  /**
   * Takes every new page this page opened: for the wait armed, when there is one, and otherwise as a page nothing waited
   * for. The session is taken on at once, before its events.
   */
  claim({ sessionId, targetId }: HeldTarget): boolean {
    if (this.#lostReason !== undefined) return false
    const session = this.#options.connection.adopt(sessionId)
    const waiter = this.#waiter
    if (waiter === undefined) {
      void this.#keepUnwaited(session, targetId)
      return true
    }
    waiter.take()
    void this.#setUp(session, targetId, waiter)
    return true
  }

  /** This page went away: a wait fails with the reason, and the pages it opens from now on run on unwatched. */
  lost(reason: string): void {
    this.#lostReason ??= reason
    this.#unregister()
    this.#waiter?.settle({ ok: false, failure: lost(reason) })
  }

  /** Closes the pages this page opened while nothing waited, within the deadline, as this page is disposed. */
  async disposeUnwaited(deadline: Deadline): Promise<void> {
    const pages = [...this.#unwaited]
    this.#unwaited.clear()
    await Promise.all(pages.map((page) => page.dispose(deadline.commandTimeoutMs).catch(ignore)))
  }

  // A page nothing waited for is set up as a waited one is, so its dialogs are answered, and each is told as this
  // page's. One Retest could not set up is let run and let go, as before the watch.
  async #keepUnwaited(session: CdpSession, targetId: string): Promise<void> {
    const home = { watch: this.#options.home.watch, targetId }
    const ready = (page: WebSession): void => {
      this.#unwaited.add(page)
      page.onUnwaitedDialog?.((dialog) => this.#options.forward({ ...dialog, popup: true }))
    }
    try {
      const page = await this.#options.open(session, home, new Deadline(unwaitedSetupMs), ready)
      void endOf(this.#options.connection, session).then(() => this.#unwaited.delete(page))
    } catch {
      session.send('Runtime.runIfWaitingForDebugger').catch(ignore)
      this.#options.connection.send('Target.detachFromTarget', { sessionId: session.id }).catch(ignore)
    }
  }

  // A popup Retest could not set up is let go, so the app's own flow goes on, and the wait fails with why. Its navigations
  // are kept from the first, since it runs before whoever waits for it can listen.
  async #setUp(session: CdpSession, targetId: string, waiter: Waiter): Promise<void> {
    const { connection } = this.#options
    const gone = endOf(connection, session)
    const home = { watch: this.#options.home.watch, targetId }
    const told: PageNavigation[] = []
    const heard = new Listeners<PageNavigation>(this.#options.onListenerError)
    const ready = (page: WebSession): void => {
      page.onNavigation((navigation) => {
        told.push(navigation)
        heard.emit(navigation)
      })
    }
    const follow = (listener: (navigation: PageNavigation) => void): (() => void) => {
      for (const navigation of told) listener(navigation)
      return heard.add(listener)
    }
    try {
      const page = await this.#options.open(session, home, new Deadline(waiter.setupMs), ready)
      const closed = (): boolean => session.detachReason !== undefined && connection.closeReason === undefined
      waiter.settle({ ok: true, popup: { page, follow, first: (timeoutMs) => firstNavigation(follow, gone, timeoutMs), gone, closed } })
    } catch (error) {
      session.send('Runtime.runIfWaitingForDebugger').catch(ignore)
      this.#options.connection.send('Target.detachFromTarget', { sessionId: session.id }).catch(ignore)
      waiter.settle({ ok: false, failure: { class: 'setup_failed', message: `The page opened a new page, and Retest could not set it up: ${errorMessage(error)}` } })
    }
  }
}

/**
 * A popup's first navigation, which the page tells when it commits, within `timeoutMs`. Undefined when none came in time,
 * or the popup went first.
 */
async function firstNavigation(follow: OpenedPopup['follow'], gone: Promise<PopupEnd>, timeoutMs: number): Promise<PageNavigation | undefined> {
  const { promise, resolve } = Promise.withResolvers<PageNavigation | undefined>()
  const stop = follow(resolve)
  const timer = setTimeout(() => resolve(undefined), timeoutMs)
  void gone.then(() => resolve(undefined))
  try {
    return await promise
  } finally {
    stop()
    clearTimeout(timer)
  }
}

/**
 * How a session's page ends: its target closed while the connection stayed, or the connection ended, which closes every
 * session it held after it has set its own reason.
 *
 * @example await endOf(connection, session) // { kind: 'closed' }
 */
export function endOf(connection: CdpConnection, session: CdpSession): Promise<PopupEnd> {
  return new Promise((resolve) => {
    session.onDetach((reason) => resolve(connection.closeReason === undefined ? { kind: 'closed' } : { kind: 'lost', reason }))
  })
}

/**
 * Keeps a page focused as far as its own scripts can tell, whatever window is in front: a page another window covers
 * gets no animation frames, and every action waits for one to see its element stand still. So the page that opened a
 * popup still acts as it did.
 */
export async function keepFocus(session: CdpSession, deadline: Deadline): Promise<void> {
  await request(session, 'Emulation.setFocusEmulationEnabled', { enabled: true }, s.object({}), sendOptions(deadline))
}

/** What closing a page needs: its session, its dialogs, the command's time and the dispatch that records its input. */
export type Closing = { readonly session: CdpSession; readonly dialogs: PageDialogs; readonly deadline: Deadline; readonly dispatch: Dispatch }

/**
 * Closes a page through `Page.close`, which runs its `beforeunload` handlers first, and waits for its target to go. A
 * `beforeunload` dialog dismissed keeps the page open, and the close fails at once, saying so. A page that stays open
 * past the command's time fails as a timeout, with its input sent.
 */
export async function closePage({ session, dialogs, deadline, dispatch }: Closing): Promise<CommandResult> {
  if (session.detachReason !== undefined) return { ok: false, failure: { class: 'not_actionable', message: 'Retest could not close the page: it was closed already.', details: { inputSent: false } } }
  const { promise, resolve } = Promise.withResolvers<CommandResult>()
  const stopDetach = session.onDetach(() => resolve({ ok: true, kind: 'close' }))
  const stopDialog = dialogs.onClosed(({ type, accepted }) => {
    if (type === 'beforeunload' && !accepted) resolve({ ok: false, failure: keptByBeforeunload('close the page', true) })
  })
  const timer = setTimeout(() => resolve({ ok: false, failure: { class: 'timeout', message: `Retest asked the page to close, and it was still open after ${deadline.budgetMs} ms.`, details: { inputSent: true } } }), deadline.waitToEndMs)
  try {
    await dispatch.send(session, 'Page.close', {}, deadline)
  } catch (error) {
    // A page that went as it was asked to close may take the answer with it.
    if (session.detachReason === undefined) throw error
  }
  try {
    return await promise
  } finally {
    stopDetach()
    stopDialog()
    clearTimeout(timer)
  }
}

/**
 * Closes a popup's own target as its test ends, without running its `beforeunload` handlers, and waits within the
 * deadline for it to go. Its opener's browser context stays. A popup that is gone already, or a browser that is, needs
 * nothing.
 */
export async function disposeTarget(connection: CdpConnection, session: CdpSession, targetId: string, deadline: Deadline): Promise<void> {
  if (session.detachReason !== undefined || connection.closeReason !== undefined) return
  const gone = new Promise<void>((resolve) => session.onDetach(() => resolve()))
  try {
    await connection.send('Target.closeTarget', { targetId }, sendOptions(deadline))
  } catch (error) {
    if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError || session.detachReason !== undefined) return
    // A target that closed between the check and the call is gone, as asked.
    if (error instanceof CdpProtocolError && /No target with given id/i.test(error.protocolMessage)) return
    throw new BrowserError({ class: 'cleanup_failed', message: `Could not close the popup: ${errorMessage(error)}` }, { cause: error })
  }
  let timer: NodeJS.Timeout | undefined
  await Promise.race([gone, new Promise<void>((resolve) => (timer = setTimeout(resolve, deadline.waitToEndMs)))])
  clearTimeout(timer)
  if (session.detachReason === undefined && connection.closeReason === undefined) {
    throw new BrowserError({ class: 'cleanup_failed', message: `Could not close the popup: it was still open ${deadline.budgetMs} ms after Retest asked.` })
  }
}

function lost(reason: string): Failure {
  return { class: 'session_lost', message: `The page went away before it opened another page: ${reason}.` }
}

// A wait stopped by its test or its caller says why, with the class the reason gives.
function stopped(reason: unknown): Failure {
  const parsed = parse(failureSchema, reason)
  return parsed.ok ? parsed.value : { class: 'interrupted', message: 'Retest stopped waiting for a page to open.' }
}

/**
 * The refusal of `page.popup()` on a page of an engine that cannot hand a test the pages it opens yet.
 *
 * @example popupsUnsupported('WebKit').class // 'unsupported'
 */
export function popupsUnsupported(engine: string): Failure {
  return { class: 'unsupported', message: `Retest hands a test the pages a page opens on Chrome and Chromium only, and not on ${engine} yet.` }
}

/**
 * The refusal of `close()` on a page of an engine that cannot close one yet.
 *
 * @example closeUnsupported('Firefox').class // 'unsupported'
 */
export function closeUnsupported(engine: string): Failure {
  return { class: 'unsupported', message: `Retest closes a page on Chrome and Chromium only, and not on ${engine} yet, so it closed nothing.`, details: { inputSent: false } }
}
