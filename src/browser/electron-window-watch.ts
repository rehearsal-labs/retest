import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { UnwaitedDialog } from './dialogs.ts'
import type { Deadline } from '../protocol/deadline.ts'
import type { DialogType } from '../protocol/dialogs.ts'
import { waitUntilDeadline } from '../assertions/wait-before-read.ts'
import { isDialogType } from '../protocol/dialogs.ts'
import { s } from '../protocol/schema.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'

// Electron reads its debugging pipe only once the app is ready, by which time the app has usually opened its first
// window, and that window's document may show a dialog as it loads. Chrome tells a session of a dialog only when the
// session's Page domain was on before the dialog opened. Electron shows any other dialog itself, and that one waits for
// a person, holding the app's main thread and every answer on the pipe, so the launch would never finish. So the first
// command the app reads attaches every page it has, holding each new one until Retest lets it run, and the first
// window's Page domain goes on the moment it is attached, before its document can run. Until the window's page is set
// up, a dialog it shows is answered here as a page answers one nothing waited for, and handed over with the page.

/** The app's first window as the watch attached it: its session, its target and its browser context. */
export type AttachedWindow = { readonly session: CdpSession; readonly targetId: string; readonly browserContextId: string }

const attachedSchema = s.object({
  sessionId: s.string(),
  targetInfo: s.object({ targetId: s.string(), type: s.string(), subtype: s.optional(s.string()), browserContextId: s.optional(s.string()) }),
  waitingForDebugger: s.boolean(),
})

// Every part but the kind is read leniently, as a page reads it: a dialog Retest could not read would hold the app.
const openingSchema = s.object({ type: s.string(), message: s.optional(s.string()) })

const ignore = (): void => {}

/**
 * Attaches an Electron app's first window before its document can show a dialog Retest would not hear, and answers
 * the dialogs it shows until its page takes them over with `handOver`. Every other page the app opens is let run at
 * once and let go, as a test reaches only the first window.
 */
export class ElectronWindowWatch {
  readonly #connection: CdpConnection
  readonly #window = Promise.withResolvers<AttachedWindow>()
  readonly #answered: UnwaitedDialog[] = []
  #taken = false
  #stopAnswering: (() => void) | undefined

  constructor(connection: CdpConnection) {
    this.#connection = connection
    connection.on('Target.attachedToTarget', (params) => this.#attached(params))
  }

  /**
   * Asks the app to attach every page it has and hold every new one. Call it before any other command, so it is the
   * first the app reads; it settles once the app answered, within the deadline.
   */
  start(deadline: Deadline): Promise<void> {
    const params = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] }
    return request(this.#connection, 'Target.setAutoAttach', params, s.object({}), sendOptions(deadline)).then(ignore)
  }

  /** The first window, once attached; undefined when the deadline passes or the app goes first. */
  async first(deadline: Deadline): Promise<AttachedWindow | undefined> {
    const timer = new AbortController()
    const ended = Promise.withResolvers<undefined>()
    const stopListening = this.#connection.onDisconnect(() => ended.resolve(undefined))
    if (this.#connection.closeReason !== undefined) ended.resolve(undefined)
    const expired = waitUntilDeadline(deadline, timer.signal).then(() => undefined, () => undefined)
    try {
      return await Promise.race([this.#window.promise, ended.promise, expired])
    } finally {
      timer.abort()
      stopListening()
    }
  }

  /**
   * Stops answering the first window's dialogs, and gives every dialog answered so far, in order. The page that takes
   * the window over answers and tells every dialog from then on.
   */
  handOver(): readonly UnwaitedDialog[] {
    this.#stopAnswering?.()
    this.#stopAnswering = undefined
    return [...this.#answered]
  }

  // The app's first plain page is the test's. A page held as it opened is let run and let go; a page attached without
  // being held, as one open before the watch began, is left as it is.
  #attached(params: unknown): void {
    const { sessionId, targetInfo, waitingForDebugger } = readProtocol(attachedSchema, params, { method: 'Target.attachedToTarget' })
    if (!this.#taken && targetInfo.type === 'page' && targetInfo.subtype === undefined) {
      this.#take(sessionId, { targetId: targetInfo.targetId, browserContextId: targetInfo.browserContextId ?? '' }, waitingForDebugger)
      return
    }
    if (!waitingForDebugger) return
    this.#connection.adopt(sessionId).send('Runtime.runIfWaitingForDebugger').catch(ignore)
    this.#connection.send('Target.detachFromTarget', { sessionId }).catch(ignore)
  }

  // The session is taken on while its attach is handled, so none of its events comes first. The Page domain goes on
  // before the window may run, and a held window is let run only after it.
  #take(sessionId: string, target: { targetId: string; browserContextId: string }, held: boolean): void {
    this.#taken = true
    const session = this.#connection.adopt(sessionId)
    this.#stopAnswering = session.on('Page.javascriptDialogOpening', (params) => this.#answer(session, params))
    session.send('Page.enable').catch(ignore)
    if (held) session.send('Runtime.runIfWaitingForDebugger').catch(ignore)
    this.#window.resolve({ session, ...target })
  }

  // Dismissed, or accepted for a beforeunload, as a page answers a dialog nothing waited for.
  #answer(session: CdpSession, params: unknown): void {
    const { type, message = '' } = readProtocol(openingSchema, params, { method: 'Page.javascriptDialogOpening', sessionId: session.id })
    const kind: DialogType = isDialogType(type) ? type : 'alert'
    const accept = kind === 'beforeunload'
    this.#answered.push({ type: kind, message, answered: accept ? 'accepted' : 'dismissed', during: false })
    session.send('Page.handleJavaScriptDialog', { accept }).catch(ignore)
  }
}
