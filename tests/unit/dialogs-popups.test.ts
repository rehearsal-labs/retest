import type { OutgoingMessage, Transport, TransportHandlers } from '../../src/browser/cdp/transport.ts'
import type { BrowserCommand, DispatchedCommand, OwnedPage } from '../../src/browser/contract.ts'
import type { UnwaitedDialog } from '../../src/browser/dialogs.ts'
import type { OpenedPopup, PopupArming, PopupEnd, PopupWait, PopupWaitOptions } from '../../src/browser/popups.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { ParentMessage } from '../../src/protocol/messages.ts'
import type { PopupHost, PopupRegistry } from '../../src/runner/popups.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { Channel } from '../../src/browser/cdp/channel.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { CdpSession } from '../../src/browser/cdp/session.ts'
import { heldByDialog, keptByBeforeunload, PageDialogs, unwaitedDialogFailure, withKeptPage, withUnwaitedDialog } from '../../src/browser/dialogs.ts'
import { ElectronWindowWatch } from '../../src/browser/electron-window-watch.ts'
import { disposeTarget, endOf } from '../../src/browser/popups.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { isDialogType, unwaitedDialogMessage, withDialogWords } from '../../src/protocol/dialogs.ts'
import { popupAppName } from '../../src/protocol/popups.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { describeDialog, describePopupClosed, describePopupOpened } from '../../src/reporters/dialogs-popups.ts'
import { TestDialogs, withDialogText } from '../../src/runner/dialogs.ts'
import { TestPopups } from '../../src/runner/popups.ts'
import { FakeBrowser, FakePage } from '../support/fake-browser.ts'

// The pure parts of dialogs and popups: the sentences a test author reads, how the parent names a dialog's text, how a
// popup is named, how reports word each, the dialog state of a page over a scripted session, how a popup's page ends
// over a scripted connection, and the parent's side of dialogs and popups over a scripted host. The real browser
// behaviour is proven in tests/integration/browser-dialogs.test.ts and browser-popups.test.ts.

describe('the sentence for a dialog nothing waited for', () => {
  test('names its kind, its text, the command and how Retest answered it', () => {
    assert.equal(
      unwaitedDialogMessage({ type: 'confirm', text: 'Delete this task?', answered: 'dismissed', command: "click getByTestId('delete')" }),
      'The page opened a confirm dialog that says "Delete this task?" while Retest tried to click getByTestId(\'delete\'). Retest dismissed it. To answer it, wrap the action in page.dialog().',
    )
  })

  test('leaves out text a dialog does not have, and says a beforeunload was accepted so the page could leave', () => {
    assert.equal(
      unwaitedDialogMessage({ type: 'beforeunload', text: '', answered: 'accepted', command: 'open http://127.0.0.1:4173/next' }),
      'The page opened a beforeunload dialog while Retest tried to open http://127.0.0.1:4173/next. Retest accepted it, so the page could leave. To answer it, wrap the action in page.dialog().',
    )
  })

  test('says no action was running when none was, with an article for a kind that starts with a vowel', () => {
    assert.equal(
      unwaitedDialogMessage({ type: 'alert', text: 'Later', answered: 'dismissed' }),
      'The page opened an alert dialog that says "Later" while no action was running. Retest dismissed it. To answer it, wrap the action that opens it in page.dialog().',
    )
  })
})

describe('a failed command names the dialog that opened during it', () => {
  const dialog: UnwaitedDialog = { type: 'confirm', message: 'Delete hunter2?', answered: 'dismissed', during: true }

  test('the page keeps the text apart, and the parent quotes it once every value is hidden', () => {
    const failure = unwaitedDialogFailure("click getByTestId('delete')", dialog, true)
    assert.equal(failure.message, "The page opened a confirm dialog while Retest tried to click getByTestId('delete'). Retest dismissed it. To answer it, wrap the action in page.dialog().")
    assert.equal(failure.details?.['dialogMessage'], 'Delete hunter2?')
    const told = withDialogText({ ok: false, failure }, (text) => text.replaceAll('hunter2', '{{password}}'))
    assert.deepEqual(told, {
      ok: false,
      failure: {
        class: 'not_actionable',
        message: 'The page opened a confirm dialog that says "Delete {{password}}?" while Retest tried to click getByTestId(\'delete\'). Retest dismissed it. To answer it, wrap the action in page.dialog().',
        details: { dialog: 'confirm', answered: 'dismissed', inputSent: true },
      },
    })
  })

  test("a command that failed of its own accord keeps its class, message and details first, and the dialog follows", () => {
    const own: Failure = { class: 'timeout', message: "Retest could not click getByTestId('save') within 1000 ms.", details: { inputSent: false } }
    const alert: UnwaitedDialog = { type: 'alert', message: 'Saved hunter2', answered: 'dismissed', during: true }
    const failed = withUnwaitedDialog(own, alert)
    assert.deepEqual(failed, {
      class: 'timeout',
      message: "Retest could not click getByTestId('save') within 1000 ms. The page also opened an alert dialog, and Retest dismissed it.",
      details: { inputSent: false, dialog: 'alert', dialogMessage: 'Saved hunter2', answered: 'dismissed' },
    })
    const redact = (text: string): string => text.replaceAll('hunter2', '{{password}}')
    assert.deepEqual(withDialogWords(failed, redact), {
      class: 'timeout',
      message: "Retest could not click getByTestId('save') within 1000 ms. The page also opened an alert dialog that says \"Saved {{password}}\", and Retest dismissed it.",
      details: { inputSent: false, dialog: 'alert', answered: 'dismissed' },
    })
    // An agent reads the same outcome first, and what a person would have seen of the dialog after it.
    assert.equal(
      withDialogWords(failed, redact, 'agent').message,
      "Retest could not click getByTestId('save') within 1000 ms. The page also showed an alert dialog that says \"Saved {{password}}\", and Retest closed it.",
    )
    // A kept page follows a failure of another kind in the same way.
    assert.deepEqual(withKeptPage(own), { class: 'timeout', message: "Retest could not click getByTestId('save') within 1000 ms. Its beforeunload dialog was dismissed, so the page stayed where it was.", details: { inputSent: false, dialog: 'beforeunload' } })
  })

  test('an agent is told what the page showed and what Retest answered, and never to wrap its action in page.dialog()', () => {
    const failure = unwaitedDialogFailure("click getByTestId('delete')", { type: 'confirm', message: 'Delete this task?', answered: 'dismissed', during: true }, true)
    assert.deepEqual(withDialogWords(failure, (text) => text, 'agent'), {
      class: 'not_actionable',
      message: "The page showed a confirm dialog that says \"Delete this task?\" while Retest tried to click getByTestId('delete'). Retest answered no.",
      details: { dialog: 'confirm', answered: 'dismissed', inputSent: true },
    })
    assert.equal(unwaitedDialogMessage({ type: 'beforeunload', text: '', answered: 'accepted', reader: 'agent' }), 'The page showed a beforeunload dialog between commands. Retest answered yes, so the page could leave.')
    assert.equal(unwaitedDialogMessage({ type: 'alert', text: 'Hi', answered: 'dismissed', popup: true, reader: 'agent' }), 'A page this page opened showed an alert dialog that says "Hi" between commands. Retest closed it.')
  })

  test('any other answer is given back as it is', () => {
    const passed = { ok: true, kind: 'click' } as const
    assert.equal(withDialogText(passed, (text) => text), passed)
    const other = { ok: false, failure: { class: 'timeout', message: 'Out of time.', details: { dialog: 'confirm', inputSent: true } } } as const
    assert.equal(withDialogText(other, (text) => text), other)
  })

  test('a page a dialog holds, and a page a dismissed beforeunload kept, say so', () => {
    assert.deepEqual(heldByDialog('read the page', 'prompt', false), {
      class: 'not_actionable',
      message: 'Retest could not read the page: the prompt dialog the test was given still holds the page. Answer it first with dialog.accept() or dialog.dismiss().',
      details: { dialog: 'prompt', inputSent: false },
    })
    assert.equal(heldByDialog("click getByTestId('delete')", 'confirm', true).class, 'timeout')
    assert.deepEqual(keptByBeforeunload('go back', true), {
      class: 'not_actionable',
      message: 'Retest could not go back: its beforeunload dialog was dismissed, so the page stayed where it was.',
      details: { dialog: 'beforeunload', inputSent: true },
    })
  })
})

test('a popup is named after the page that opened it, with the first number no app of the test goes by', () => {
  assert.equal(popupAppName('web', new Set(['web'])), 'web/popup-1')
  assert.equal(popupAppName('web', new Set(['web', 'web/popup-1', 'web/popup-2'])), 'web/popup-3')
  assert.equal(popupAppName('web/popup-1', new Set(['web', 'web/popup-1'])), 'web/popup-1/popup-1')
  // A config may name an app as a popup would be named; the popup passes it over.
  assert.equal(popupAppName('page', new Set(['page', 'page/popup-1'])), 'page/popup-2')
})

test('the four kinds of dialog are known, and nothing else', () => {
  assert.deepEqual(['alert', 'confirm', 'prompt', 'beforeunload', 'print', ''].map(isDialogType), [true, true, true, true, false, false])
})

test('reports word a dialog and a popup as the test sees them, page text quoted and escaped', () => {
  assert.equal(describeDialog({ dialog: 'confirm', message: 'Delete this task?', answer: 'accepted', by: 'test' }), 'confirm "Delete this task?" accepted')
  assert.equal(describeDialog({ dialog: 'prompt', message: 'Name?', answer: 'accepted', by: 'test', typed: 1 }), 'prompt "Name?" accepted with 1 character')
  assert.equal(describeDialog({ dialog: 'beforeunload', message: '', answer: 'accepted', by: 'retest' }), 'beforeunload dialog accepted by Retest')
  assert.equal(describeDialog({ dialog: 'alert', message: 'line\none', answer: 'dismissed', by: 'retest' }), 'alert "line\\none" dismissed by Retest')
  assert.equal(describePopupOpened({ popup: 'web/popup-1', url: 'http://127.0.0.1:4173/terms', title: 'Terms' }), 'popup web/popup-1 opened "Terms" at http://127.0.0.1:4173/terms')
  assert.equal(describePopupOpened({ popup: 'web/popup-1', url: 'about:blank' }), 'popup web/popup-1 opened about:blank')
  assert.equal(describePopupClosed({ session: 'web/popup-1' }), 'popup web/popup-1 closed itself')
  // A control character JSON leaves as it is, as the C1 introducer of a terminal sequence, is escaped too.
  const escaped = describeDialog({ dialog: 'alert', message: 'red\u009b31m', answer: 'dismissed', by: 'retest' })
  assert.equal(escaped, 'alert "red\\u009b31m" dismissed by Retest')
  assert.equal(escaped.includes('\u009b'), false)
})

describe("a page's dialogs, over a scripted session", () => {
  function scripted(): { dialogs: PageDialogs; sent: { method: string; params: unknown }[]; heard: UnwaitedDialog[] } {
    const sent: { method: string; params: unknown }[] = []
    const channel = new Channel('S1', () => undefined)
    const session = new CdpSession('S1', channel, async (method, params) => {
      sent.push({ method, params })
      return {}
    })
    const dialogs = new PageDialogs(session, (error) => assert.fail(String(error)))
    const heard: UnwaitedDialog[] = []
    dialogs.onUnwaited((dialog) => heard.push(dialog))
    return { dialogs, sent, heard }
  }

  test('an armed page hands its next dialog over, holds it until answered, and sends the answer it was given', async () => {
    const { dialogs, sent } = scripted()
    const arming = dialogs.arm(1000)
    assert.ok(arming.ok)
    dialogs.opened({ type: 'prompt', message: 'New name?', defaultPrompt: 'Release checklist' })
    assert.deepEqual(await arming.opened, { ok: true, dialog: { id: 'dialog-1', type: 'prompt', message: 'New name?', defaultValue: 'Release checklist' } })
    assert.equal(dialogs.held?.id, 'dialog-1')
    assert.deepEqual(await dialogs.answer('dialog-1', { accept: true }, 1000), { ok: true })
    // A prompt accepted with no text gets its default, as a person pressing OK gives it.
    assert.deepEqual(sent, [{ method: 'Page.handleJavaScriptDialog', params: { accept: true, promptText: 'Release checklist' } }])
    assert.equal(dialogs.held, undefined, 'a dialog being answered holds the page no more')
    dialogs.closed({ result: true, userInput: 'Release checklist' })
    assert.equal(dialogs.open, undefined)
  })

  test('a dialog nothing waited for is answered at once and told, and fails the command it opened during', () => {
    const { dialogs, sent, heard } = scripted()
    const ended = dialogs.commandStarted()
    dialogs.opened({ type: 'confirm', message: 'Delete this task?' })
    dialogs.closed({ result: false })
    dialogs.opened({ type: 'beforeunload', message: '' })
    assert.deepEqual(sent.map((each) => each.params), [{ accept: false }, { accept: true }])
    assert.deepEqual(ended(), { unwaited: { type: 'confirm', message: 'Delete this task?', answered: 'dismissed', during: true }, kept: false })
    assert.deepEqual(heard.map((each) => [each.type, each.answered, each.during]), [['confirm', 'dismissed', true], ['beforeunload', 'accepted', true]])
    // A listener that comes later hears the dialogs before it, as a popup's does.
    const late: UnwaitedDialog[] = []
    dialogs.onUnwaited((dialog) => late.push(dialog))
    assert.equal(late.length, 2)
  })

  test('a beforeunload the test dismisses keeps the page, which the command it held hears at once', async () => {
    const { dialogs } = scripted()
    const ended = dialogs.commandStarted()
    const arming = dialogs.arm(1000)
    assert.ok(arming.ok)
    dialogs.opened({ type: 'beforeunload', message: '' })
    const wait = await arming.opened
    assert.ok(wait.ok)
    assert.deepEqual(await dialogs.answer(wait.dialog.id, { accept: false }, 1000), { ok: true })
    assert.deepEqual(ended(), { unwaited: undefined, kept: true })
  })

  test('text for a dialog other than a prompt, a second answer and a second wait are refused, and a wait runs out', async () => {
    const { dialogs, sent } = scripted()
    const arming = dialogs.arm(1000)
    assert.ok(arming.ok)
    assert.deepEqual(dialogs.arm(1000), { ok: false, failure: { class: 'usage', message: 'page.dialog() is already waiting for a dialog on this page. Await it before the next one.' } })
    dialogs.opened({ type: 'alert', message: 'Saved' })
    const wait = await arming.opened
    assert.ok(wait.ok)
    assert.equal((await dialogs.answer(wait.dialog.id, { accept: true, promptText: 'x' }, 1000)).ok, false)
    assert.deepEqual(await dialogs.answer(wait.dialog.id, { accept: true }, 1000), { ok: true })
    assert.equal((await dialogs.answer(wait.dialog.id, { accept: true }, 1000)).ok, false)
    assert.equal(sent.length, 1, 'only the one answer went to the browser')
    const short = dialogs.arm(20)
    assert.ok(short.ok)
    assert.deepEqual(await short.opened, { ok: false, failure: { class: 'timeout', message: 'No dialog opened within 20 ms.' } })
  })

  test('a wait stopped by its caller ends with the reason it was given, and a page that went ends every wait', async () => {
    const { dialogs } = scripted()
    const stop = new AbortController()
    const arming = dialogs.arm(1000, stop.signal)
    assert.ok(arming.ok)
    stop.abort({ class: 'interrupted', message: 'The action failed first.' })
    assert.deepEqual(await arming.opened, { ok: false, failure: { class: 'interrupted', message: 'The action failed first.' } })
    const later = dialogs.arm(1000)
    assert.ok(later.ok)
    dialogs.lost('the page was closed')
    assert.deepEqual(await later.opened, { ok: false, failure: { class: 'session_lost', message: 'The page went away before a dialog was answered: the page was closed.' } })
    assert.equal(dialogs.arm(1000).ok, false)
  })
})

// A browser connection whose transport answers every command at once, and whose events and end the test tells.
class ScriptedTransport implements Transport {
  readonly sent: string[] = []
  /** Every command sent, with the session it went to and its parameters. */
  readonly calls: { method: string; sessionId?: string; params: unknown }[] = []
  #handlers: TransportHandlers | undefined

  listen(handlers: TransportHandlers): void {
    this.#handlers = handlers
  }

  send(text: string): OutgoingMessage {
    const message: unknown = JSON.parse(text)
    if (isRecord(message) && typeof message['id'] === 'number' && typeof message['method'] === 'string') {
      this.sent.push(message['method'])
      this.calls.push({ method: message['method'], params: message['params'], ...(typeof message['sessionId'] === 'string' ? { sessionId: message['sessionId'] } : {}) })
      const reply = JSON.stringify({ id: message['id'], result: {}, ...(typeof message['sessionId'] === 'string' ? { sessionId: message['sessionId'] } : {}) })
      queueMicrotask(() => this.#handlers?.message(reply))
    }
    return { written: true, withdraw: () => undefined }
  }

  close(): void {
    this.end('the test closed the connection')
  }

  /** Tells an event of the browser, or of one session when `sessionId` names it. */
  event(method: string, params: object, sessionId?: string): void {
    this.#handlers?.message(JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  }

  detach(sessionId: string): void {
    this.#handlers?.message(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId } }))
  }

  end(reason: string): void {
    this.#handlers?.close(reason)
  }
}

function scriptedConnection(): { connection: CdpConnection; transport: ScriptedTransport } {
  const transport = new ScriptedTransport()
  return { connection: new CdpConnection(transport, { timeoutMs: 1000, onDiagnostic: () => undefined }), transport }
}

describe("how a popup's page ends, over a scripted connection", () => {
  test('a target that detached while the browser stayed closed itself, and a connection that ended lost its pages', async () => {
    const { connection, transport } = scriptedConnection()
    const closing = endOf(connection, connection.adopt('S1'))
    const losing = endOf(connection, connection.adopt('S2'))
    transport.detach('S1')
    assert.deepEqual(await closing, { kind: 'closed' })
    transport.end('the browser crashed')
    assert.deepEqual(await losing, { kind: 'lost', reason: 'the browser crashed' })
  })

  test('disposing a popup waits for its target to go, and fails as cleanup when it is still there at the deadline', async () => {
    const { connection, transport } = scriptedConnection()
    const going = connection.adopt('S1')
    const disposed = disposeTarget(connection, going, 'T1', new Deadline(1000))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(transport.sent, ['Target.closeTarget'])
    transport.detach('S1')
    await disposed
    const staying = connection.adopt('S2')
    await assert.rejects(disposeTarget(connection, staying, 'T2', new Deadline(50)), (error: unknown) => {
      assert.ok(error instanceof BrowserError)
      assert.deepEqual(error.failure, { class: 'cleanup_failed', message: 'Could not close the popup: it was still open 50 ms after Retest asked.' })
      return true
    })
    // A browser that is gone took the popup with it, and nothing is asked of it.
    transport.end('the browser closed')
    await disposeTarget(connection, staying, 'T2', new Deadline(50))
    assert.equal(transport.sent.length, 2)
  })
})

// A page that opens popups when the test says so: each wait it is armed for settles with the popup the test hands it,
// or with the reason its signal was stopped.
class OpeningPage extends FakePage {
  readonly #waits = new Set<(wait: PopupWait) => void>()

  async armPopup({ signal }: PopupWaitOptions): Promise<PopupArming> {
    const { promise, resolve } = Promise.withResolvers<PopupWait>()
    signal?.addEventListener('abort', () => {
      this.#waits.delete(resolve)
      resolve({ ok: false, failure: { class: 'interrupted', message: 'The wait was stopped.' } })
    }, { once: true })
    this.#waits.add(resolve)
    return { ok: true, opened: promise }
  }

  /** Opens a popup for the oldest wait still armed, as the browser hands the page a new one. */
  open(popup: OpenedPopup): void {
    const [settle] = this.#waits
    assert.ok(settle !== undefined, 'the page was armed for a popup')
    this.#waits.delete(settle)
    settle({ ok: true, popup })
  }
}

// A popup's page, a web session of its own as the browser hands it over.
class PopupPage extends FakePage {
  async dispatch(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal, commandToken?: number): Promise<DispatchedCommand> {
    const result = await this.execute(command, timeoutMs, signal, commandToken)
    return { result, input: result.ok ? 'sent' : 'not_sent' }
  }
}

// A popup's page as the browser hands it over: `end` ends it, as its target closing or its browser going does.
function scriptedPopup(page: PopupPage): { popup: OpenedPopup; end: (end: PopupEnd) => void } {
  const { promise, resolve } = Promise.withResolvers<PopupEnd>()
  let closed = false
  const popup: OpenedPopup = { page, follow: () => () => undefined, first: async () => undefined, gone: promise, closed: () => closed }
  return {
    popup,
    end: (end) => {
      closed = end.kind === 'closed'
      resolve(end)
    },
  }
}

type Scripted = {
  host: PopupHost
  registry: PopupRegistry
  state: { answerable: boolean; commandsSent: boolean }
  sent: ParentMessage[]
  emitted: EventBody[]
  observed: Failure[]
  pages: Map<string, OwnedPage>
  browser: FakeBrowser
}

// The running test as the parent's dialogs and popups see it: its one app `web`, answerable until the test says not.
function scriptedHost(): Scripted {
  const browser = new FakeBrowser({}, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
  const pages = new Map<string, OwnedPage>([['web', new OpeningPage(browser, {})]])
  const state = { answerable: true, commandsSent: true }
  const sent: ParentMessage[] = []
  const emitted: EventBody[] = []
  const observed: Failure[] = []
  const host: PopupHost = {
    testId: 'test-1',
    attemptId: 'attempt-1',
    timeouts: defaultTimeouts,
    page: (app) => pages.get(app),
    refusal: () => (state.answerable ? undefined : { class: 'interrupted', message: 'The test is over.' }),
    remainingMs: () => undefined,
    answerable: () => state.answerable,
    commandsSent: () => state.commandsSent,
    stepId: () => undefined,
    send: (message) => sent.push(message),
    emit: (body) => emitted.push(body),
    observe: (problem) => observed.push(problem),
    violation: (problem) => assert.fail(problem),
    redact: (text) => text,
    adopt: (app, page) => pages.set(app, page),
  }
  const registry: PopupRegistry = { add: (opener) => ({ app: `${opener}/popup-1`, sessionId: `attempt-1:${opener}/popup-1` }), closed: () => undefined }
  return { host, registry, state, sent, emitted, observed, pages, browser }
}

function opener(scripted: Scripted): OpeningPage {
  const page = scripted.pages.get('web')
  assert.ok(page instanceof OpeningPage)
  return page
}

// Waits for every answer and event already on its way.
async function settledWork(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

const lostPage: CommandResult = { ok: false, failure: { class: 'session_lost', message: 'The page went away: the target detached.' } }

describe("the parent's side of a test's popups, over a scripted host", () => {
  async function given(scripted: Scripted): Promise<{ popups: TestPopups; end: (end: PopupEnd) => void }> {
    const popups = new TestPopups(scripted.host, scripted.registry)
    popups.receive({ type: 'popup', testId: 'test-1', attemptId: 'attempt-1', id: 1, app: 'web', request: { kind: 'wait' }, timeoutMs: 1000 })
    await settledWork()
    const { popup, end } = scriptedPopup(new PopupPage(scripted.browser, {}))
    opener(scripted).open(popup)
    await settledWork()
    assert.deepEqual(scripted.sent.at(-1), { type: 'popup-result', id: 1, answer: { kind: 'opened', popup: { app: 'web/popup-1' } } })
    return { popups, end }
  }

  test('a popup whose target ended while the browser stayed closed itself: its commands are refused as such, and it is written down', async () => {
    const scripted = scriptedHost()
    const { popups, end } = await given(scripted)
    end({ kind: 'closed' })
    await settledWork()
    assert.deepEqual(popups.settled('web/popup-1', lostPage), { ok: false, failure: { class: 'not_actionable', message: 'This page closed itself, so Retest sent nothing to it.', details: { inputSent: false } } })
    assert.deepEqual(popups.refusal('web/popup-1', { kind: 'observePage' }), { class: 'not_actionable', message: 'This page closed itself, so Retest sent nothing to it.', details: { inputSent: false } })
    assert.deepEqual(scripted.emitted.filter((event) => event.type === 'popup.closed').length, 1)
  })

  test('a popup whose browser was lost stays a lost page: no closing is written, and its commands keep the loss', async () => {
    const scripted = scriptedHost()
    const { popups, end } = await given(scripted)
    end({ kind: 'lost', reason: 'the browser crashed' })
    await settledWork()
    assert.equal(popups.settled('web/popup-1', lostPage), lostPage)
    assert.equal(popups.refusal('web/popup-1', { kind: 'observePage' }), undefined)
    assert.deepEqual(scripted.emitted.filter((event) => event.type === 'popup.closed'), [])
  })

  test("a popup the test closed is closed by the test, even when the close failed for a dialog Retest answered as the page went", async () => {
    const scripted = scriptedHost()
    const { popups, end } = await given(scripted)
    const location = { file: 'tests/popups.retest.ts', line: 9, column: 3 }
    const failed: CommandResult = { ok: false, failure: { class: 'not_actionable', message: 'The page opened a beforeunload dialog while Retest tried to close the page.' } }
    const closing = popups.close('web/popup-1', location, async () => {
      end({ kind: 'closed' })
      await settledWork()
      return failed
    })
    assert.equal(await closing, failed)
    assert.deepEqual(popups.refusal('web/popup-1', { kind: 'observePage' }), { class: 'usage', message: 'This page was closed by close() at tests/popups.retest.ts:9, so Retest sent nothing to it.' })
    assert.deepEqual(scripted.emitted.filter((event) => event.type === 'popup.closed'), [], 'a page the test closed did not close itself')
  })

  test('a wait the test stopped as it ended is stopped and not answered, and a popup that comes after the end is closed unwritten', async () => {
    const scripted = scriptedHost()
    const popups = new TestPopups(scripted.host, scripted.registry)
    popups.receive({ type: 'popup', testId: 'test-1', attemptId: 'attempt-1', id: 1, app: 'web', request: { kind: 'wait' }, timeoutMs: 1000 })
    await settledWork()
    assert.deepEqual(scripted.sent, [{ type: 'popup-result', id: 1, answer: { kind: 'armed' } }])
    popups.stop({ class: 'interrupted', message: 'The test ended before the page opened another page.' })
    await settledWork()
    assert.equal(scripted.sent.length, 1, 'a stopped wait is not answered')

    popups.receive({ type: 'popup', testId: 'test-1', attemptId: 'attempt-1', id: 2, app: 'web', request: { kind: 'wait' }, timeoutMs: 1000 })
    await settledWork()
    scripted.state.answerable = false
    const late = new PopupPage(scripted.browser, {})
    opener(scripted).open(scriptedPopup(late).popup)
    // The fake page closes on a timer of its own.
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(late.disposed, true, 'the late popup was closed')
    assert.equal(scripted.pages.has('web/popup-1'), false, 'the late popup is no page of the test')
    assert.deepEqual(scripted.emitted, [])
    assert.deepEqual(scripted.sent.map((message) => (message.type === 'popup-result' ? message.answer.kind : message.type)), ['armed', 'armed'])
  })
})

describe("the parent's side of a test's dialogs, over a scripted host", () => {
  // A page whose dialogs Retest answered itself, which the test tells.
  class AnsweringPage extends FakePage {
    readonly #listeners: ((dialog: UnwaitedDialog) => void)[] = []

    onUnwaitedDialog(listener: (dialog: UnwaitedDialog) => void): () => void {
      this.#listeners.push(listener)
      return () => undefined
    }

    answered(dialog: UnwaitedDialog): void {
      for (const listener of this.#listeners) listener(dialog)
    }
  }

  test("a dialog answered before the test's first command is written down and fails nothing; one between commands later fails the test", () => {
    const scripted = scriptedHost()
    const page = new AnsweringPage(scripted.browser, {})
    const dialogs = new TestDialogs(scripted.host)
    dialogs.watch('web', page)
    scripted.state.commandsSent = false
    page.answered({ type: 'alert', message: 'Welcome back', answered: 'dismissed', during: false })
    assert.deepEqual(scripted.observed, [])
    assert.deepEqual(scripted.emitted.map((event) => (event.type === 'dialog' ? [event.dialog, event.message, event.by] : event.type)), [['alert', 'Welcome back', 'retest']])
    scripted.state.commandsSent = true
    page.answered({ type: 'alert', message: 'Later', answered: 'dismissed', during: false })
    assert.deepEqual(scripted.observed, [
      { class: 'not_actionable', message: 'The page opened an alert dialog that says "Later" while no action was running. Retest dismissed it. To answer it, wrap the action that opens it in page.dialog().', details: { dialog: 'alert', answered: 'dismissed' } },
    ])
  })
})

describe("an Electron app's first window, over a scripted connection", () => {
  const attached = (sessionId: string, targetId: string, waitingForDebugger: boolean) => ({ sessionId, targetInfo: { targetId, type: 'page', browserContextId: 'C1' }, waitingForDebugger })

  test('the watch asks to attach every page first, turns the first window\'s Page domain on before letting it run, and lets every other page go', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    await watch.start(new Deadline(1000))
    assert.deepEqual(transport.calls[0], { method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] } })
    transport.event('Target.attachedToTarget', attached('S1', 'T1', true))
    transport.event('Target.attachedToTarget', attached('S2', 'T2', true))
    const window = await watch.first(new Deadline(1000))
    assert.deepEqual([window?.session.id, window?.targetId, window?.browserContextId], ['S1', 'T1', 'C1'])
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(transport.calls.slice(1).map(({ method, sessionId }) => [method, sessionId]), [
      ['Page.enable', 'S1'],
      ['Runtime.runIfWaitingForDebugger', 'S1'],
      ['Runtime.runIfWaitingForDebugger', 'S2'],
      ['Target.detachFromTarget', undefined],
    ])
  })

  test('a dialog the first window shows before its page is set up is answered and handed over; after the handover the page answers', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    transport.event('Target.attachedToTarget', attached('S1', 'T1', false))
    transport.event('Page.javascriptDialogOpening', { type: 'alert', message: 'Welcome back' }, 'S1')
    transport.event('Page.javascriptDialogOpening', { type: 'beforeunload', message: '' }, 'S1')
    await new Promise((resolve) => setImmediate(resolve))
    const answers = transport.calls.filter((call) => call.method === 'Page.handleJavaScriptDialog')
    assert.deepEqual(answers.map(({ sessionId, params }) => [sessionId, params]), [['S1', { accept: false }], ['S1', { accept: true }]])
    assert.deepEqual(watch.handOver(), [
      { type: 'alert', message: 'Welcome back', answered: 'dismissed', during: false },
      { type: 'beforeunload', message: '', answered: 'accepted', during: false },
    ])
    transport.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Later' }, 'S1')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(transport.calls.filter((call) => call.method === 'Page.handleJavaScriptDialog').length, 2, 'the watch answers nothing once its page took over')
  })

  test('no first window is undefined at the deadline, and when the app goes first', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    assert.equal(await watch.first(new Deadline(30)), undefined)
    transport.end('the app quit')
    assert.equal(await watch.first(new Deadline(1000)), undefined)
  })
})

test('a page takes over the dialogs answered before it was set up, and its listeners hear them first', () => {
  const channel = new Channel('S1', () => undefined)
  const session = new CdpSession('S1', channel, async () => ({}))
  const dialogs = new PageDialogs(session, (error) => assert.fail(String(error)))
  dialogs.answeredBefore([{ type: 'alert', message: 'Welcome back', answered: 'dismissed', during: false }])
  const heard: UnwaitedDialog[] = []
  dialogs.onUnwaited((dialog) => heard.push(dialog))
  assert.deepEqual(heard, [{ type: 'alert', message: 'Welcome back', answered: 'dismissed', during: false }])
})
