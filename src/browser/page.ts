import type { CdpConnection } from './cdp/connection.ts'
import type { CdpSession } from './cdp/session.ts'
import type { OwnedPage } from './contract.ts'
import type { ActionIntent } from './element-queries.ts'
import type { CommandResult, PageCommand } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { describeLocator } from '../protocol/locator.ts'
import { s } from '../protocol/schema.ts'
import { waitUntilActionable } from './actionability.ts'
import { BrowserError } from './browser-error.ts'
import { CdpClosedError, CdpDisconnectedError, CdpProtocolError, CdpTimeoutError } from './cdp/errors.ts'
import { readProtocol, request, sendOptions } from './cdp-results.ts'
import { commandStopped, connectionEnded, dialogOpened, failureFromError } from './command-failures.ts'
import { Dispatch } from './dispatch.ts'
import { observe } from './element-queries.ts'
import { clickAt, replaceSelection, type Point } from './input.ts'
import { guardFailure, guardInput } from './input-guard.ts'
import { IsolatedWorld } from './isolated-world.ts'
import { Listeners } from './listeners.ts'
import { navigate } from './navigation.ts'
import { guardScript } from './page-scripts.ts'
import { originAndPath } from './page-url.ts'

export type PageOptions = {
  connection: CdpConnection
  session: CdpSession
  browserContextId: string
  baseUrl: string | undefined
  /** Receives errors thrown by navigation listeners. */
  onListenerError: (error: unknown) => void
}

type ElementAction = Extract<PageCommand, { kind: 'click' | 'fill' }>

const retryPauseMs = 20
const screenshotCommand = 'take a screenshot'

const frameTreeSchema = s.object({ frameTree: s.object({ frame: s.object({ id: s.string(), url: s.string() }) }) })
const frameNavigatedSchema = s.object({
  frame: s.object({ id: s.string(), parentId: s.optional(s.string()), url: s.string() }),
})
const sameDocumentSchema = s.object({ frameId: s.string(), url: s.string() })
const screenshotSchema = s.object({ data: s.string() })
const dialogSchema = s.object({ type: s.string() })

/** One page in a browser context of its own. */
export class ChromiumPage implements OwnedPage {
  readonly #connection: CdpConnection
  readonly #session: CdpSession
  readonly #browserContextId: string
  readonly #baseUrl: string | undefined
  readonly #world: IsolatedWorld
  readonly #navigations: Listeners<string>
  #mainFrameId: string
  #url: URL | undefined
  #lostReason: string | undefined
  #dialog: string | undefined
  #disposing: Promise<void> | undefined

  /**
   * Reads the page's main frame, then follows it through the events this enables, and has every document it
   * opens install Retest's input guard before the page's own scripts run.
   *
   * @example const page = await ChromiumPage.open({ connection, session, browserContextId, baseUrl, onListenerError }, deadline)
   */
  static async open(options: PageOptions, deadline: Deadline): Promise<ChromiumPage> {
    const { session } = options
    const { frameTree } = await request(session, 'Page.getFrameTree', undefined, frameTreeSchema, sendOptions(deadline))
    const page = new ChromiumPage(options, frameTree.frame)
    await request(session, 'Page.enable', undefined, s.object({}), sendOptions(deadline))
    await request(session, 'Page.setLifecycleEventsEnabled', { enabled: true }, s.object({}), sendOptions(deadline))
    await page.#world.addScript(guardScript, deadline)
    return page
  }

  constructor(options: PageOptions, mainFrame: { id: string; url: string }) {
    this.#connection = options.connection
    this.#session = options.session
    this.#browserContextId = options.browserContextId
    this.#baseUrl = options.baseUrl
    this.#mainFrameId = mainFrame.id
    this.#url = URL.parse(mainFrame.url) ?? undefined
    this.#navigations = new Listeners(options.onListenerError)
    this.#world = new IsolatedWorld(this.#session, () => this.#mainFrameId)
    this.#session.on('Page.frameNavigated', (params) => this.#frameNavigated(params))
    this.#session.on('Page.navigatedWithinDocument', (params) => this.#navigatedWithinDocument(params))
    // A crashed page and one a dialog holds answer nothing, so commands waiting on them fail at once.
    this.#session.on('Inspector.targetCrashed', () => {
      this.#lostReason ??= 'the page crashed'
      this.#session.block('the page crashed')
    })
    this.#session.on('Page.javascriptDialogOpening', (params) => {
      const { type } = readProtocol(dialogSchema, params, { method: 'Page.javascriptDialogOpening', sessionId: this.#session.id })
      this.#dialog = type
      this.#session.block(`a JavaScript ${type} dialog holds the page`)
    })
    this.#session.on('Page.javascriptDialogClosed', () => {
      this.#dialog = undefined
      if (this.#lostReason === undefined) this.#session.unblock()
    })
    this.#session.onDetach((reason) => {
      this.#lostReason ??= reason
    })
  }

  async execute(command: PageCommand, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    const deadline = new Deadline(timeoutMs, { signal })
    const described = this.#describe(command)
    const dispatch = new Dispatch()
    try {
      signal?.throwIfAborted()
      const blocked = this.#blocked(described, false)
      if (blocked !== undefined) return { ok: false, failure: blocked }
      const result = await this.#run(command, deadline, dispatch)
      return result.ok ? result : { ok: false, failure: this.#blocked(described, dispatch.sent) ?? result.failure }
    } catch (error) {
      if (signal?.aborted === true) return { ok: false, failure: commandStopped(described, dispatch.sent, signal.reason) }
      const failure = this.#blocked(described, dispatch.sent) ?? failureFromError(error, { command: described, timeoutMs, inputSent: dispatch.sent })
      return { ok: false, failure }
    }
  }

  async screenshot(timeoutMs: number): Promise<Uint8Array> {
    const deadline = new Deadline(timeoutMs)
    for (;;) {
      const blocked = this.#blocked(screenshotCommand, false)
      if (blocked !== undefined) throw new BrowserError(blocked)
      try {
        const params = { format: 'png' }
        const { data } = await request(this.#session, 'Page.captureScreenshot', params, screenshotSchema, sendOptions(deadline))
        return Buffer.from(data, 'base64')
      } catch (error) {
        if (!isBetweenDocuments(error) || deadline.expired) throw this.#screenshotError(error)
        await sleep(Math.min(retryPauseMs, deadline.remainingMs))
      }
    }
  }

  onNavigation(listener: (url: string) => void): () => void {
    return this.#navigations.add(listener)
  }

  dispose(timeoutMs: number): Promise<void> {
    this.#disposing ??= this.#dispose(new Deadline(timeoutMs))
    return this.#disposing
  }

  async #run(command: PageCommand, deadline: Deadline, dispatch: Dispatch): Promise<CommandResult> {
    switch (command.kind) {
      case 'goto': {
        const context = {
          session: this.#session,
          baseUrl: this.#baseUrl,
          mainFrameId: () => this.#mainFrameId,
          currentUrl: () => this.#url,
        }
        return navigate(context, command.url, deadline, dispatch)
      }
      case 'observe':
        return { ok: true, kind: 'observe', observation: await observe(this.#world, command.locator, deadline) }
      case 'click':
        return this.#act(command, { action: 'click', multiline: false }, deadline, (point) =>
          clickAt(this.#session, point, deadline, dispatch),
        )
      case 'fill': {
        const intent: ActionIntent = { action: 'fill', multiline: /[\n\r]/.test(command.value) }
        return this.#act(command, intent, deadline, () => replaceSelection(this.#session, command.value, deadline, dispatch))
      }
    }
  }

  async #act(
    command: ElementAction,
    intent: ActionIntent,
    deadline: Deadline,
    input: (point: Point) => Promise<void>,
  ): Promise<CommandResult> {
    const target = await waitUntilActionable(this.#world, command.locator, intent, deadline)
    if (!target.ok) return target
    const verdict = await guardInput(this.#world, target.guard, deadline, () => input(target.point))
    const failure = guardFailure(verdict, intent, command.locator)
    return failure === undefined ? { ok: true, kind: command.kind } : { ok: false, failure }
  }

  // A page that crashed, closed or is held by a dialog stops answering, which says nothing about how fast it is.
  #blocked(command: string, inputSent: boolean): Failure | undefined {
    if (this.#lostReason !== undefined) return connectionEnded(command, inputSent, this.#lostReason)
    if (this.#dialog !== undefined) return dialogOpened(command, this.#dialog, inputSent)
    return undefined
  }

  #describe(command: PageCommand): string {
    if (command.kind !== 'goto') return `${command.kind === 'observe' ? 'read' : command.kind} ${describeLocator(command.locator)}`
    const target = URL.parse(command.url, this.#baseUrl)
    return `open ${target === null ? JSON.stringify(command.url) : originAndPath(target)}`
  }

  async #dispose(deadline: Deadline): Promise<void> {
    this.#lostReason ??= 'the page was closed'
    if (this.#connection.closeReason !== undefined) return
    try {
      const params = { browserContextId: this.#browserContextId }
      await this.#connection.send('Target.disposeBrowserContext', params, sendOptions(deadline))
    } catch (error) {
      // A browser that went away took the context with it.
      if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) return
      throw new BrowserError(
        { class: 'cleanup_failed', message: `Could not close the page's browser context: ${errorMessage(error)}` },
        { cause: error },
      )
    }
  }

  #screenshotError(error: unknown): unknown {
    const blocked = this.#blocked(screenshotCommand, false)
    if (blocked !== undefined) return new BrowserError(blocked, { cause: error })
    if (error instanceof CdpDisconnectedError || error instanceof CdpClosedError) {
      return new BrowserError(connectionEnded(screenshotCommand, false, error.reason), { cause: error })
    }
    if (error instanceof CdpTimeoutError) {
      const message = `Could not take a screenshot within ${error.timeoutMs} ms.`
      return new BrowserError({ class: 'timeout', message }, { cause: error })
    }
    return error
  }

  #frameNavigated(params: unknown): void {
    const { frame } = readProtocol(frameNavigatedSchema, params, { method: 'Page.frameNavigated', sessionId: this.#session.id })
    if (frame.parentId !== undefined) return
    this.#mainFrameId = frame.id
    this.#world.reset()
    this.#moveTo(frame.url, true)
  }

  #navigatedWithinDocument(params: unknown): void {
    const source = { method: 'Page.navigatedWithinDocument', sessionId: this.#session.id }
    const { frameId, url } = readProtocol(sameDocumentSchema, params, source)
    if (frameId === this.#mainFrameId) this.#moveTo(url, false)
  }

  // A new document is always news; within a document only a new path is, since a fragment is never reported.
  #moveTo(address: string, newDocument: boolean): void {
    const url = URL.parse(address)
    if (url === null) throw new Error('The browser reported a main frame address that is not a URL')
    const previous = this.#url
    this.#url = url
    const path = originAndPath(url)
    if (newDocument || previous === undefined || originAndPath(previous) !== path) this.#navigations.emit(path)
  }
}

// Between a failed navigation and its error page, the page has no document to capture.
function isBetweenDocuments(error: unknown): boolean {
  return error instanceof CdpProtocolError && error.protocolMessage === 'Not attached to an active page'
}
