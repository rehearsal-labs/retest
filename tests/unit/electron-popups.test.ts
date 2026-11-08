import type { OutgoingMessage, Transport, TransportHandlers } from '../../src/browser/cdp/transport.ts'
import type { BrowserCommand, DispatchedCommand, PageNavigation, PageReading, SessionIdentity, WebSession } from '../../src/browser/contract.ts'
import type { DialogReply } from '../../src/browser/dialogs.ts'
import type { AppWindowWaits } from '../../src/browser/electron-window-watch.ts'
import type { HeldTarget, PopupArming, PopupOpener, PopupSource, PopupWait } from '../../src/browser/popups.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { StorageState } from '../../src/protocol/storage-state.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { dragListenerScript } from '../../src/browser/drag.ts'
import { acts, armWindow, ElectronPopupWindow } from '../../src/browser/electron-popups.ts'
import { ElectronWindowWatch } from '../../src/browser/electron-window-watch.ts'
import { AppWindows } from '../../src/browser/electron.ts'
import { ChromiumPage, documentListenerTypes } from '../../src/browser/page.ts'
import { guardScript } from '../../src/browser/page-scripts.ts'
import { PagePopups } from '../../src/browser/popups.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { functionsCalled, scriptedSession } from './browser-fixtures.ts'

// The windows an Electron app opens after its first, over scripted connections and fake windows: which window the app's
// watch hands each new one to, a window named by the one that opened it or one the main process made; the one wait an
// app holds at a time; what a popup window refuses by name and what it passes on; the windows record; and the scripts a
// window held before its first document runs again when that document reused its window. The real app is driven in
// tests/integration/electron-popups.test.ts.

/** A transport that answers every command at once with an empty result, and keeps each command it was sent. */
class ScriptedTransport implements Transport {
  readonly calls: { method: string; sessionId?: string; params: unknown }[] = []
  #handlers: TransportHandlers | undefined

  listen(handlers: TransportHandlers): void {
    this.#handlers = handlers
  }

  send(text: string): OutgoingMessage {
    const message: unknown = JSON.parse(text)
    if (isRecord(message) && typeof message['id'] === 'number' && typeof message['method'] === 'string') {
      this.calls.push({ method: message['method'], params: message['params'], ...(typeof message['sessionId'] === 'string' ? { sessionId: message['sessionId'] } : {}) })
      const reply = JSON.stringify({ id: message['id'], result: {}, ...(typeof message['sessionId'] === 'string' ? { sessionId: message['sessionId'] } : {}) })
      queueMicrotask(() => this.#handlers?.message(reply))
    }
    return { written: true, withdraw: () => undefined }
  }

  close(): void {
    this.#handlers?.close('the test closed the connection')
  }

  event(method: string, params: object, sessionId?: string): void {
    this.#handlers?.message(JSON.stringify({ method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  }
}

function scriptedConnection(): { connection: CdpConnection; transport: ScriptedTransport } {
  const transport = new ScriptedTransport()
  return { connection: new CdpConnection(transport, { timeoutMs: 1000, onDiagnostic: () => undefined }), transport }
}

const settled = () => new Promise((resolve) => setImmediate(resolve))

/** A window's popups as the watch sees them: every target it was handed, and through which call. */
class Opener implements PopupOpener {
  readonly claimed: string[] = []
  readonly claimedWaited: string[] = []
  waiting = true

  claim(target: HeldTarget): boolean {
    this.claimed.push(target.targetId)
    return true
  }

  claimWaited(target: HeldTarget): boolean {
    if (!this.waiting) return false
    this.claimedWaited.push(target.targetId)
    return true
  }
}

const attached = (sessionId: string, targetId: string, options: { openerId?: string; held?: boolean } = {}) => ({
  sessionId,
  targetInfo: { targetId, type: 'page', browserContextId: 'C1', ...(options.openerId === undefined ? {} : { openerId: options.openerId }) },
  waitingForDebugger: options.held ?? true,
})

// What the watch sent each target it let go: run, then detach.
const letGo = (transport: ScriptedTransport, sessionId: string) =>
  transport.calls.filter((call) => call.sessionId === sessionId || (call.method === 'Target.detachFromTarget' && isRecord(call.params) && call.params['sessionId'] === sessionId)).map((call) => call.method)

describe("an Electron app's watch of its windows", () => {
  test('a window a window of the test opened goes to that window, waited for or not; one whose opener no window holds is let go', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    transport.event('Target.attachedToTarget', attached('S1', 'T1', { held: false }))
    const opener = new Opener()
    watch.register('T1', opener)
    transport.event('Target.attachedToTarget', attached('S2', 'T2', { openerId: 'T1' }))
    transport.event('Target.attachedToTarget', attached('S3', 'T3', { openerId: 'T9' }))
    await settled()
    assert.deepEqual(opener.claimed, ['T2'], 'the window that opened it took it, though nothing waited')
    assert.deepEqual(letGo(transport, 'S2'), [])
    assert.deepEqual(letGo(transport, 'S3'), ['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget'])
  })

  test('a window the main process made goes only to the window waiting, once a command acted in the app after its wait began', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    transport.event('Target.attachedToTarget', attached('S1', 'T1', { held: false }))
    const opener = new Opener()
    watch.register('T1', opener)
    // Nothing waits: no window of the test is told of it.
    watch.acted()
    transport.event('Target.attachedToTarget', attached('S2', 'T2'))
    // A wait began, and no command acted since: nothing the test asked for can have opened it.
    const done = watch.wait('T1')
    assert.ok(done !== undefined)
    transport.event('Target.attachedToTarget', attached('S3', 'T3'))
    watch.acted()
    transport.event('Target.attachedToTarget', attached('S4', 'T4'))
    // Its wait is over.
    done()
    watch.acted()
    transport.event('Target.attachedToTarget', attached('S5', 'T5'))
    await settled()
    assert.deepEqual(opener.claimedWaited, ['T4'])
    assert.deepEqual(opener.claimed, [], 'a window that names no opener is never kept as one nothing waited for')
    for (const session of ['S2', 'S3', 'S5']) assert.deepEqual(letGo(transport, session), ['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget'], session)
  })

  test('a window waiting whose page holds no wait any more lets the main process window go', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    transport.event('Target.attachedToTarget', attached('S1', 'T1', { held: false }))
    const opener = new Opener()
    opener.waiting = false
    watch.register('T1', opener)
    watch.wait('T1')
    watch.acted()
    transport.event('Target.attachedToTarget', attached('S2', 'T2'))
    await settled()
    assert.deepEqual(letGo(transport, 'S2'), ['Runtime.runIfWaitingForDebugger', 'Target.detachFromTarget'])
  })

  test('one window of an app waits at a time, and a page attached unheld is left as it is', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    const first = watch.wait('T1')
    assert.ok(first !== undefined)
    assert.equal(watch.wait('T2'), undefined, 'a main process window could answer either wait')
    first()
    assert.ok(watch.wait('T2') !== undefined, 'the next wait may begin once the first is over')
    transport.event('Target.attachedToTarget', attached('S1', 'T1', { held: false }))
    transport.event('Target.attachedToTarget', attached('S2', 'T2', { held: false }))
    await settled()
    assert.deepEqual(letGo(transport, 'S2'), [])
  })

  test('the app is asked once to hold its new windows, however often a window arms', async () => {
    const { connection, transport } = scriptedConnection()
    const watch = new ElectronWindowWatch(connection)
    await Promise.all([watch.start(new Deadline(1000)), watch.start(new Deadline(1000))])
    await watch.start(new Deadline(1000))
    assert.deepEqual(transport.calls.map((call) => call.method), ['Target.setAutoAttach'])
  })
})

/** A window that answers every command with `answer`, and keeps every command and call it got. */
class FakeWindow implements WebSession {
  url: string | undefined = 'file:///work/desktop/settings.html'
  readonly commands: BrowserCommand[] = []
  readonly answered: string[] = []
  readonly named: SessionIdentity[] = []
  answer: DispatchedCommand = { result: { ok: true, kind: 'click' }, input: 'sent' }
  arming: PopupArming | undefined
  disposed: number[] = []

  async dispatch(command: BrowserCommand): Promise<DispatchedCommand> {
    this.commands.push(command)
    return this.answer
  }

  async execute(command: BrowserCommand): Promise<CommandResult> {
    return (await this.dispatch(command)).result
  }

  identify(session: SessionIdentity): void {
    this.named.push(session)
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89])
  }

  async readPage(): Promise<PageReading> {
    return { url: this.url, navigating: false, found: [] }
  }

  onNavigation(_listener: (navigation: PageNavigation) => void): () => void {
    return () => undefined
  }

  async answerDialog(id: string, _reply: DialogReply): Promise<{ ok: true }> {
    this.answered.push(id)
    return { ok: true }
  }

  async armPopup(): Promise<PopupArming> {
    return this.arming ?? { ok: false, failure: { class: 'setup_failed', message: 'no arming was scripted' } }
  }

  async captureState(): Promise<StorageState> {
    return { cookies: [], origins: [] }
  }

  async dispose(timeoutMs: number): Promise<void> {
    this.disposed.push(timeoutMs)
  }
}

/** The waits of one app, kept as calls. */
class Waits implements AppWindowWaits {
  acts = 0
  readonly waiting: string[] = []
  busy = false

  wait(targetId: string): (() => void) | undefined {
    if (this.busy) return undefined
    this.busy = true
    this.waiting.push(targetId)
    return () => {
      this.busy = false
    }
  }

  acted(): void {
    this.acts += 1
  }
}

const app = { app: 'desktop', target: 'electron', targetId: 'T2' }

describe('a window page.popup() gave a test', () => {
  test('goto, a frame, a route and a saved state are refused by name, and nothing reaches the window', async () => {
    const window = new FakeWindow()
    const popup = new ElectronPopupWindow({ ...app, window, waits: new Waits(), reached: () => undefined })
    assert.deepEqual(await popup.dispatch({ kind: 'goto', url: 'https://example.test/' }, 1000), {
      input: 'not_sent',
      result: {
        ok: false,
        failure: {
          class: 'unsupported',
          message: 'goto() is not available on a window of the Electron app desktop (target electron): the app has no address, and the window shows what the app opened in it.',
          details: { app: 'desktop', target: 'electron', command: 'goto' },
        },
      },
    })
    const framed = await popup.execute({ kind: 'click', locator: { by: 'testId', value: 'pay', frame: [{ by: 'css', selector: '#checkout' }] } }, 1000)
    assert.ok(!framed.ok)
    assert.equal(framed.failure.class, 'unsupported')
    assert.match(framed.failure.message, /not on a window of the Electron app desktop yet/)
    assert.deepEqual(await popup.addRoute(), { ok: false, failure: { class: 'unsupported', message: 'page.route() is not available in an Electron app yet. Retest answers requests on Chrome, Chromium and Edge.' } })
    await assert.rejects(popup.captureState(1000), (error: unknown) => error instanceof BrowserError && error.failure.class === 'unsupported' && /keeps its own storage/.test(error.failure.message))
    assert.deepEqual(window.commands, [])
  })

  test('every other command goes to the window, an action and an answer note they acted, and a look does not', async () => {
    const window = new FakeWindow()
    const waits = new Waits()
    const popup = new ElectronPopupWindow({ ...app, window, waits, reached: () => undefined })
    const click: BrowserCommand = { kind: 'click', locator: { by: 'testId', value: 'save' } }
    const look: BrowserCommand = { kind: 'observe', locator: { by: 'testId', value: 'saved' } }
    assert.deepEqual(await popup.dispatch(click, 1000), window.answer)
    assert.deepEqual(await popup.dispatch(look, 1000), window.answer)
    assert.deepEqual(await popup.answerDialog('D1', { accept: true }, 1000), { ok: true })
    assert.deepEqual(window.commands, [click, look])
    assert.deepEqual(window.answered, ['D1'])
    assert.equal(waits.acts, 2)
    assert.deepEqual([acts(click), acts(look), acts({ kind: 'observePage' }), acts({ kind: 'close' })], [true, false, false, true])
  })

  test('naming it tells the windows record the page it became, and disposing it closes the window alone', async () => {
    const window = new FakeWindow()
    const reached: [string, string][] = []
    const popup = new ElectronPopupWindow({ ...app, window, waits: new Waits(), reached: (targetId, page) => reached.push([targetId, page]) })
    const session: SessionIdentity = {
      sessionId: 'k3v9q0x2mb:desktop/popup-1',
      owner: { runId: 'run', testId: 'tests/windows.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'desktop/popup-1' },
      runtime: { kind: 'web', engine: 'chromium', product: 'Electron', version: '44.5.1', executablePath: '/opt/Electron', processIds: [7001] },
    }
    popup.identify(session)
    assert.deepEqual(window.named, [session])
    assert.deepEqual(reached, [['T2', 'desktop/popup-1']])
    await popup.dispose(3000)
    assert.deepEqual(window.disposed, [3000])
  })

  test('a second wait in one app is refused by name before the window is armed, and the app may wait again once the first is over', async () => {
    const window = new FakeWindow()
    const waits = new Waits()
    const opened = Promise.withResolvers<PopupWait>()
    window.arming = { ok: true, opened: opened.promise }
    const first = await armWindow(window, waits, app, { timeoutMs: 1000, setupMs: 1000 })
    assert.equal(first.ok, true)
    const second = await armWindow(new FakeWindow(), waits, { ...app, targetId: 'T3' }, { timeoutMs: 1000, setupMs: 1000 })
    assert.deepEqual(second, {
      ok: false,
      failure: {
        class: 'usage',
        message: "page.popup() is already waiting on another window of the Electron app desktop. A window the app's main process opens names no window that opened it, so Retest could not tell which wait it answers. Await the first page.popup() before the next.",
      },
    })
    opened.resolve({ ok: false, failure: { class: 'timeout', message: 'No page opened within 1000 ms.' } })
    await settled()
    assert.equal(waits.busy, false, 'the wait is over once its page settled')
    window.arming = { ok: false, failure: { class: 'session_lost', message: 'The page went away.' } }
    assert.deepEqual(await armWindow(window, waits, app, { timeoutMs: 1000, setupMs: 1000 }), window.arming)
    assert.equal(waits.busy, false, 'a wait the window refused is over at once')
    assert.deepEqual(waits.waiting, ['T2', 'T2'])
  })
})

describe("an Electron app's windows record", () => {
  test('names the window that opened each one, marks the one a test was given, and tells the log', () => {
    const { connection, transport } = scriptedConnection()
    const lines: string[] = []
    const windows = new AppWindows(connection, performance.now(), (line) => lines.push(line))
    const created = (targetId: string, openerId?: string) => transport.event('Target.targetCreated', { targetInfo: { targetId, type: 'page', browserContextId: 'C1', ...(openerId === undefined ? {} : { openerId }) } })
    created('T1')
    created('T2', 'T1')
    created('T3')
    windows.reached('T2', 'desktop/popup-1')
    // A window given before discovery told of it is marked once it is.
    windows.reached('T4', 'desktop/popup-2')
    created('T4')
    assert.deepEqual(
      windows.records.map(({ window, reachable, opener, page }) => ({ window, reachable, opener, page })),
      [
        { window: 1, reachable: true, opener: undefined, page: undefined },
        { window: 2, reachable: true, opener: 1, page: 'desktop/popup-1' },
        { window: 3, reachable: false, opener: undefined, page: undefined },
        { window: 4, reachable: true, opener: undefined, page: 'desktop/popup-2' },
      ],
    )
    assert.deepEqual(lines, [
      'the app opened window 2, from window 1; a test reaches it only through page.popup()',
      'the app opened window 3, from its main process; a test reaches it only through page.popup()',
      "window 2 is the test's page desktop/popup-1",
      'the app opened window 4, from its main process; a test reaches it only through page.popup()',
      "window 4 is the test's page desktop/popup-2",
    ])
  })
})

describe("a page's popups, for a window the main process made", () => {
  // A page whose popups open as fake windows, and whose given popup is wrapped by `present`.
  function popupsOf(): { popups: PagePopups; opened: FakeWindow[]; presented: string[] } {
    const { connection } = scriptedConnection()
    const opened: FakeWindow[] = []
    const presented: string[] = []
    const watch: PopupSource = { register: () => () => undefined, start: async () => undefined }
    const popups = new PagePopups({
      connection,
      home: { watch, targetId: 'T1' },
      open: async (_session, _home, _deadline, ready) => {
        const window = new FakeWindow()
        opened.push(window)
        ready(window)
        return window
      },
      onListenerError: (error) => assert.fail(String(error)),
      forward: () => undefined,
      present: (page, targetId) => {
        presented.push(targetId)
        return new ElectronPopupWindow({ ...app, targetId, window: page, waits: new Waits(), reached: () => undefined })
      },
    })
    return { popups, opened, presented }
  }

  test('is taken only for a wait armed, and given wrapped; without a wait it is left to run on', async () => {
    const { popups, opened, presented } = popupsOf()
    assert.equal(popups.claimWaited({ sessionId: 'S2', targetId: 'T2' }), false)
    await settled()
    assert.equal(opened.length, 0, 'a window nothing waited for is not set up as one of the page\'s')
    const arming = await popups.arm({ timeoutMs: 1000, setupMs: 1000 })
    assert.ok(arming.ok)
    assert.equal(popups.claimWaited({ sessionId: 'S3', targetId: 'T3' }), true)
    const wait = await arming.opened
    assert.ok(wait.ok)
    assert.ok(wait.popup.page instanceof ElectronPopupWindow)
    assert.deepEqual(presented, ['T3'])
    assert.equal(popups.claimWaited({ sessionId: 'S4', targetId: 'T4' }), false, 'its wait was taken')
  })
})

describe('the scripts of a page held before its first document', () => {
  test('wake the listeners of every window event the guard and the drag listener hear from the start of a document', () => {
    const tables = [...guardScript.matchAll(/(\w+): \{ events: \[([^\]]*)\]([^}]*)\}/g)]
    assert.ok(tables.length >= 6, 'the guard script lists the events of each action')
    const fromStart = tables.filter(([, , , rest]) => rest?.includes('whileArmed') !== true).flatMap(([, , events]) => [...(events ?? '').matchAll(/'(\w+)'/g)].map(([, type]) => type))
    const others = [...guardScript.matchAll(/for \(const type of \[([^\]]*)\]\) window\.addEventListener\(type, selectChanged/g), ...dragListenerScript.matchAll(/for \(const type of \[([^\]]*)\]\) addEventListener/g)]
    assert.equal(others.length, 2, 'the select listener and the drag listener list their events')
    const heard = new Set([...fromStart, ...others.flatMap(([, events]) => [...(events ?? '').matchAll(/'(\w+)'/g)].map(([, type]) => type))])
    assert.deepEqual([...heard].filter((type) => type !== undefined && !documentListenerTypes.includes(type)), [], 'every type is woken')
  })

  test('mark the document they ran in, and run again in the first document that commits, once', async () => {
    const scripted = scriptedSession(async (method) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: '1' }
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 5 }
      if (method === 'Runtime.callFunctionOn') return { result: { value: true } }
      return {}
    })
    const { connection } = scriptedConnection()
    const options = { connection, session: scripted.session, browserContextId: 'C1', baseUrl: undefined, emulation: undefined, restoredOrigins: [], proxyServer: undefined, onListenerError: (error: unknown) => assert.fail(String(error)) }
    await ChromiumPage.openHeld(options, 'T2', new Deadline(1000), () => undefined)
    const scripts = scripted.sent.filter(({ method }) => method === 'Page.addScriptToEvaluateOnNewDocument').map(({ params }) => (isRecord(params) ? params['source'] : undefined))
    assert.equal(scripts.at(-1), 'globalThis.retestScriptsDocument = document', 'the mark comes after every script it vouches for')
    const commit = (loaderId: string) => scripted.emit('Page.frameNavigated', { frame: { id: 'T2', url: 'file:///work/desktop/notes.html', loaderId } })
    commit('L1')
    await settled()
    commit('L2')
    await settled()
    const reruns = functionsCalled(scripted.sent).filter((source) => typeof source === 'string' && source.startsWith('function rerunScripts()'))
    assert.equal(reruns.length, 1, 'only the first document can have taken over the empty one\'s window')
    for (const type of documentListenerTypes) assert.ok(String(reruns[0]).includes(`"${type}"`), type)
  })
})
