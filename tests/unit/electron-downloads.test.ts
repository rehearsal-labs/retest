import type { TestContext } from 'node:test'
import type { Transport, TransportHandlers } from '../../src/browser/cdp/transport.ts'
import type { DownloadEnd, FilesCapability, PageDownload } from '../../src/browser/contract.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { CdpConnection } from '../../src/browser/cdp/connection.ts'
import { ElectronDownloads } from '../../src/browser/electron-downloads.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { AttemptFiles } from '../../src/runner/files.ts'

// An Electron app's downloads against a connection whose answers the test scripts: what Retest tells Electron of the
// default session, a first window outside it, what a test may wait for, and what is removed once the app has quit.
// The same paths run on Electron 44.5.1 in `tests/integration/electron-downloads.test.ts`.

type Sent = { method: string; params: unknown }
type Answer = { result: object } | { error: { code: number; message: string } }

// Every command succeeds, and the app names D1 its default session, unless `answer` says otherwise for a command.
function scriptedApp(answer: (method: string, params: unknown) => Answer | undefined = () => undefined) {
  let handlers: TransportHandlers | undefined
  const sent: Sent[] = []
  const transport: Transport = {
    listen: (given) => {
      handlers = given
    },
    send: (text) => {
      const command: unknown = JSON.parse(text)
      assert.ok(typeof command === 'object' && command !== null && 'id' in command && 'method' in command && typeof command.method === 'string')
      const { id, method } = command
      const params = 'params' in command ? command.params : undefined
      sent.push({ method, params })
      const answered = answer(method, params) ?? { result: method === 'Target.getBrowserContexts' ? { browserContextIds: [], defaultBrowserContextId: 'D1' } : {} }
      queueMicrotask(() => handlers?.message(JSON.stringify({ id, ...answered })))
      return { written: true, withdraw: () => {} }
    },
    close: () => {},
  }
  const connection = new CdpConnection(transport, { timeoutMs: 1000, onDiagnostic: () => {} })
  const notes: string[] = []
  const lines: string[] = []
  const downloads = new ElectronDownloads({
    connection,
    app: 'desk',
    target: 'electron',
    onListenerError: (error) => {
      throw error
    },
    note: (text) => notes.push(text),
    log: (line) => lines.push(line),
  })
  const emit = (method: string, params: unknown) => handlers?.message(JSON.stringify({ method, params }))
  return { downloads, sent, notes, lines, emit }
}

function behaviors(sent: readonly Sent[]): unknown[] {
  return sent.filter((command) => command.method === 'Browser.setDownloadBehavior').map((command) => command.params)
}

// A window's files as a Chromium page gives them, telling every download to its listeners.
function windowFiles(): FilesCapability & { heard: number } {
  const files = {
    heard: 0,
    armFileChooser: () => ({ opened: new Promise<never>(() => {}), release: () => {} }),
    onDownload(_listener: (download: PageDownload) => void) {
      files.heard += 1
      return () => {}
    },
  }
  return files
}

test('downloads are refused from the launch on, then saved in the folder the page names, each told to Electron naming no session', async () => {
  const { downloads, sent } = scriptedApp()
  await downloads.start(new Deadline(1000))
  downloads.window('D1')
  const files = windowFiles()
  assert.equal(downloads.files(files)?.onDownload, undefined, 'no test can wait for a download before the page names a folder')
  await downloads.save('/run/artifacts/a1/desk-1/downloads', 1000)
  assert.deepEqual(behaviors(sent), [
    { behavior: 'deny' },
    { behavior: 'allowAndName', downloadPath: '/run/artifacts/a1/desk-1/downloads', eventsEnabled: true },
  ])
  const given = downloads.files(files)
  assert.equal(given?.downloadsRefused, undefined)
  given?.onDownload?.(() => {})
  assert.equal(files.heard, 1, 'a test waits on the window\'s own downloads')
})

test('a page given no folder leaves the downloads refused', async () => {
  const { downloads, sent } = scriptedApp()
  await downloads.start(new Deadline(1000))
  downloads.window('D1')
  await downloads.save(undefined, 1000)
  assert.deepEqual(behaviors(sent), [{ behavior: 'deny' }])
  assert.equal(downloads.files(windowFiles())?.onDownload, undefined)
})

test('a first window outside the default session is refused by name, and nothing more is told to Electron', async () => {
  const { downloads, sent, notes } = scriptedApp()
  await downloads.start(new Deadline(1000))
  downloads.window('P7')
  await downloads.save('/run/artifacts/a1/desk-1/downloads', 1000)
  assert.deepEqual(behaviors(sent), [{ behavior: 'deny' }])
  const given = downloads.files(windowFiles())
  assert.equal(given?.onDownload, undefined)
  assert.deepEqual(given?.downloadsRefused, {
    class: 'unsupported',
    message: "The first window of the Electron app desk is in a session of its own, as a partition makes, and Retest sets where downloads go only in the app's default session, so it waited for none.",
    details: { app: 'desk', target: 'electron' },
  })
  assert.deepEqual(notes, ["the first window is not in the app's default session, so Retest neither saves nor refuses its downloads: they go the app's own way"])
})

test('an app that names no default session has its first window refused by name', async () => {
  const { downloads, notes, sent } = scriptedApp((method) => (method === 'Target.getBrowserContexts' ? { result: { browserContextIds: [] } } : undefined))
  await downloads.start(new Deadline(1000))
  downloads.window('D1')
  await downloads.save('/run/downloads', 1000)
  assert.deepEqual(behaviors(sent), [{ behavior: 'deny' }], 'the refusal names no session, so it holds for the default one all the same')
  assert.match(downloads.files(windowFiles())?.downloadsRefused?.message ?? '', /^The first window of the Electron app desk may be in a session of its own: Electron did not say which session is its default/)
  assert.deepEqual(notes, ["Electron did not say which session is its default, so Retest saves none of the first window's downloads"])
})

test('an app that refuses the behavior at its launch runs on, noted, with its downloads refused by name; one that refuses it for the page fails the page', async () => {
  const refusal = { error: { code: -32602, message: 'Failed to find browser context' } }
  const atLaunch = scriptedApp((method) => (method === 'Browser.setDownloadBehavior' ? refusal : undefined))
  await atLaunch.downloads.start(new Deadline(1000))
  atLaunch.downloads.window('D1')
  await atLaunch.downloads.save('/run/downloads', 1000)
  assert.deepEqual(behaviors(atLaunch.sent), [{ behavior: 'deny' }], 'nothing more is asked of an app that refused')
  assert.match(atLaunch.downloads.files(windowFiles())?.downloadsRefused?.message ?? '', /^The Electron app desk did not let Retest set where its downloads go \(.*Failed to find browser context.*\), so Retest waited for none\.$/)
  assert.equal(atLaunch.notes.length, 1)
  assert.match(atLaunch.notes[0] ?? '', /^Electron did not let Retest set where downloads go \(.*\), so Retest neither saves nor refuses the app's downloads: they go the app's own way$/)
  const atPage = scriptedApp((method, params) => (method === 'Browser.setDownloadBehavior' && JSON.stringify(params).includes('allowAndName') ? refusal : undefined))
  await atPage.downloads.start(new Deadline(1000))
  atPage.downloads.window('D1')
  await assert.rejects(atPage.downloads.save('/run/downloads', 1000), (error: unknown) => {
    assert.ok(error instanceof BrowserError)
    assert.equal(error.failure.class, 'setup_failed')
    assert.match(error.failure.message, /^Could not tell the Electron app desk where to save its downloads: .*Failed to find browser context/)
    return true
  })
  assert.equal(atPage.downloads.files(windowFiles())?.onDownload, undefined, 'a page whose folder was refused waits for no download')
})

test('once the app has quit, what Chromium left under a download id is removed, and one it told nothing of is noted', async (t) => {
  const folder = mkdtempSync(join(tmpdir(), 'retest-electron-downloads-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const { downloads, emit, notes, lines } = scriptedApp()
  await downloads.start(new Deadline(1000))
  downloads.window('D1')
  await downloads.save(folder, 1000)
  const told = '11111111-2222-4333-8444-555555555555'
  const unseen = '99999999-8888-4777-8666-555555555555'
  const named = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
  emit('Browser.downloadWillBegin', { frameId: 'F1', guid: told, url: 'http://127.0.0.1/files/a.csv', suggestedFilename: 'a.csv' })
  emit('Browser.downloadWillBegin', { frameId: 'F1', guid: '00000000-0000-4000-8000-000000000000', url: 'http://127.0.0.1/files/id', suggestedFilename: named })
  await new Promise((resolve) => setImmediate(resolve))
  for (const name of [`${told}.crdownload`, unseen, 'tasks.csv', named]) writeFileSync(join(folder, name), 'x')
  assert.deepEqual(downloads.sweep(), [])
  assert.deepEqual(readdirSync(folder).sort(), [named, 'tasks.csv'].sort(), "a kept file stays, even one the page named like an id")
  assert.deepEqual(notes, [`a download Chromium told nothing of, as one the app's main process starts with session.downloadURL(), was saved in the downloads folder as ${unseen}; Retest removed it, since no record names it and nothing read it for secrets`])
  assert.deepEqual(lines, [`Retest removed ${told}.crdownload from the downloads folder: what Chromium left of a download whose test had ended`])
})

// An app's page as the attempt's files see it, whose downloads the test begins itself.
function attemptOn(t: TestContext, page: { electron?: true; downloadsRefused?: Failure }) {
  const runFolder = mkdtempSync(join(tmpdir(), 'retest-electron-attempt-'))
  t.after(() => rmSync(runFolder, { recursive: true, force: true }))
  const listeners: ((download: PageDownload) => void)[] = []
  const files: FilesCapability = {
    armFileChooser: () => ({ opened: new Promise<never>(() => {}), release: () => {} }),
    ...(page.downloadsRefused === undefined ? { onDownload: (listener: (download: PageDownload) => void) => (listeners.push(listener), () => {}) } : { downloadsRefused: page.downloadsRefused }),
  }
  const downloads = { folder: join(runFolder, 'downloads'), reference: 'artifacts/a1/desk-1/downloads' }
  const pages = new Map([['desk', { files, where: 'in an Electron app', sessionId: 'a1:desk', downloads, ...(page.electron === undefined ? {} : { electron: page.electron }) }]])
  const attempt = new AttemptFiles({ pages, runFolder, testId: 'downloads', attemptId: 'a1', emit: () => {} })
  t.after(() => attempt.close())
  const begin = (end: DownloadEnd) => {
    for (const listener of listeners) listener({ guid: 'g1', url: 'http://127.0.0.1/files/tasks.csv', suggestedFilename: 'tasks.csv', ended: Promise.resolve(end), progress: () => ({ receivedBytes: 0, totalBytes: 0 }) })
  }
  return { attempt, begin }
}

const budget = (timeoutMs: number) => ({ timeoutMs, signal: new AbortController().signal })

test("a page whose downloads are refused by name answers page.download() with that refusal", async (t) => {
  const refusal: Failure = { class: 'unsupported', message: 'The first window of the Electron app desk is in a session of its own.' }
  const { attempt } = attemptOn(t, { electron: true, downloadsRefused: refusal })
  assert.deepEqual(await attempt.download('desk', budget(1000)), { ok: false, failure: refusal })
})

test("in an Electron window, a stopped download and a wait that sees none say what the app's main process can do unseen", async (t) => {
  const { attempt, begin } = attemptOn(t, { electron: true })
  const waiting = attempt.download('desk', budget(1000))
  begin({ state: 'canceled', receivedBytes: 0, totalBytes: 0 })
  const answer = await waiting
  assert.ok(answer.ok && answer.kind === 'download', JSON.stringify(answer))
  const saved = await attempt.saved(answer.download, budget(1000))
  assert.deepEqual(saved, {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: "The download of tasks.csv stopped after 0 bytes had arrived, and Chromium gives no reason. The Electron app's main process can cancel a download in its will-download handler, and Retest cannot see whether it did. Retest saved nothing.",
      details: { download: 'tasks.csv', receivedBytes: 0, totalBytes: 0 },
    },
  })
  const none = await attempt.download('desk', budget(20))
  assert.ok(!none.ok)
  assert.equal(none.failure.message, "No download began within 20 ms of page.download(). Check that its action starts one, as a link to a file does. A download the Electron app's main process starts with session.downloadURL() belongs to no window, and Chromium tells Retest nothing of it.")
})

test("a browser's page keeps its own wording for a stopped download", async (t) => {
  const { attempt, begin } = attemptOn(t, {})
  const waiting = attempt.download('desk', budget(1000))
  begin({ state: 'canceled', receivedBytes: 0, totalBytes: 0 })
  const answer = await waiting
  assert.ok(answer.ok && answer.kind === 'download')
  const saved = await attempt.saved(answer.download, budget(1000))
  assert.ok(!saved.ok)
  assert.equal(saved.failure.message, 'The browser stopped the download of tasks.csv after 0 bytes had arrived, and gives no reason. Retest saved nothing.')
})

test('nothing is swept for a page that named no folder', async () => {
  const { downloads } = scriptedApp()
  await downloads.start(new Deadline(1000))
  downloads.window('D1')
  assert.deepEqual(downloads.sweep(), [])
})
