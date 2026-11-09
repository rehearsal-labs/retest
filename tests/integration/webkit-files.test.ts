import type { TestContext } from 'node:test'
import type { FilesCapability, OwnedPage, ResolvedInputFiles } from '../../src/browser/contract.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { InputFileRecord } from '../../src/protocol/files.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ReceivedFile } from '../../fixtures/task-app/files-page.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TASKS_CSV } from '../../fixtures/task-app/files-page.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { AttemptFiles } from '../../src/runner/files.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { eventArtifactReferences, inventoryArtifacts, resultArtifactReferences } from '../../src/store/artifacts.ts'
import { agentHost, openOn } from './agent-harness.ts'
import { assertOk, byLabel, byRole, byTestId, click, failureOf, goto, observe, observeUntil, openApp, openPage, scratchFolder, sharedBrowser, within } from './browser-harness.ts'
import { budgets, configSource, eventsOf, resultOf, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'
import { engineAbsence, webKitPath } from './engines.ts'

// File inputs, the file picker and downloads on WebKit build 2359, against the driver and through a whole run: the same
// fixture pages and the same cases as browser-files.test.ts and files.test.ts on Chrome, each held to what WebKit does.
// Where WebKit ends a case otherwise, the case asserts exactly what WebKit gives and docs/compatibility/webkit.md says
// why: a picker nobody waited for is never shown and the page hears no cancel; a download WebKit stops comes with its own
// reason, the bytes that arrived read from its file, and no total; and a download a link with a target starts in the
// page it opens is told as the page's own. WebKit runs on macOS only.

const absent = engineAbsence('webkit')
// The harness launches the engine RETEST_TEST_ENGINE names, read as it launches.
if (absent === undefined) process.env['RETEST_TEST_ENGINE'] = 'webkit'
const skip = absent ?? false

const browser = sharedBrowser()
const report = Buffer.from('%PDF-1.4 a small report\n')

type FilesPage = { page: OwnedPage; url: string; received: () => Promise<ReceivedFile[]> }

async function filesPage(t: TestContext, downloads?: string): Promise<FilesPage> {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url, downloads === undefined ? {} : { downloads })
  assertOk(await goto(page, '/files'))
  const received = async (): Promise<ReceivedFile[]> => (await (await fetch(`${app.url}/files/received`)).json()) as ReceivedFile[]
  return { page, url: app.url, received }
}

function filesOf(page: OwnedPage): FilesCapability {
  const { files } = page
  assert.ok(files !== undefined, 'a WebKit page catches its file pickers')
  return files
}

function give(page: OwnedPage, locator: LocatorRecipe, paths: readonly string[], timeoutMs: number = defaultTimeouts.action): Promise<CommandResult> {
  const files: InputFileRecord[] = paths.map((path) => ({ path, folder: '/' }))
  return page.execute({ kind: 'setInputFiles', locator, files, paths, mimeTypes: paths.map(() => null) }, timeoutMs)
}

function giveChooser(page: OwnedPage, chooser: string, paths: readonly string[]): Promise<CommandResult> {
  const files: InputFileRecord[] = paths.map((path) => ({ path, folder: '/' }))
  return page.execute({ kind: 'setChooserFiles', chooser, files, paths, mimeTypes: paths.map(() => null) }, defaultTimeouts.action)
}

async function writeReport(t: TestContext, name = 'report.pdf', bytes: Buffer = report): Promise<string> {
  const path = join(await scratchFolder(t), name)
  writeFileSync(path, bytes)
  return path
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function heard(page: OwnedPage): Promise<string> {
  return (await observe(page, 'heard')).text ?? ''
}

async function send(page: OwnedPage, files: number): Promise<void> {
  assertOk(await click(page, 'send'))
  await observeUntil(page, 'received-count', (observation) => observation.text === String(files))
}

function attemptFiles(page: OwnedPage, runFolder: string, events: EventBody[], downloads?: string, redactor?: Redactor): AttemptFiles {
  const pages = new Map([['web', { files: page.files, where: 'on WebKit', sessionId: 'attempt1:web', ...(downloads === undefined ? {} : { downloads: { folder: downloads, reference: 'artifacts/attempt1/web/downloads' } }) }]])
  return new AttemptFiles({ pages, runFolder, testId: 'files', attemptId: 'attempt1', emit: (body) => events.push(body), ...(redactor === undefined ? {} : { redactor }) })
}

async function downloadEvents(events: readonly EventBody[], count: number): Promise<Extract<EventBody, { type: 'download' }>[]> {
  const written = () => events.filter((event): event is Extract<EventBody, { type: 'download' }> => event.type === 'download')
  const end = performance.now() + 5000
  while (written().length < count && performance.now() < end) await delay(20)
  return written()
}

// A download the server starts and never finishes: a page whose link downloads `slow.csv`, of which the server sends
// `sent` bytes and then holds the response open until the test ends, as a large file on a slow line does.
async function slowDownloads(t: TestContext, sent: string): Promise<string> {
  const server = createServer((request, response) => {
    if (request.url === '/slow.csv') {
      response.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="slow.csv"', 'content-length': '100000', 'cache-control': 'no-store' })
      response.write(sent)
      return
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>Slow</title><a href="/slow.csv" data-testid="slow">Slow CSV</a>')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  return `http://127.0.0.1:${address.port}`
}

test('a file by path reaches the input and the server with its name, type and bytes', { skip }, async (t) => {
  const { page, received } = await filesPage(t)
  const path = await writeReport(t)
  const result = await give(page, byLabel('Attachment'), [path], defaultTimeouts.action)
  assert.ok(result.ok && result.kind === 'setInputFiles', JSON.stringify(result))
  assert.deepEqual(result.files, [{ name: 'report.pdf', size: report.length, type: 'application/pdf' }])
  assert.equal(result.page?.title, 'Files')
  assert.equal(await heard(page), `attachment input: report.pdf ${report.length}\nattachment change: report.pdf ${report.length}\n`)
  await send(page, 1)
  assert.deepEqual(await received(), [{ field: 'attachment', name: 'report.pdf', type: 'application/pdf', size: report.length, sha256: sha256(report) }])
})

test('a file given by content is written for the input, typed by its name, sent, and removed when the attempt closes', { skip }, async (t) => {
  const { page, received } = await filesPage(t)
  const runFolder = await scratchFolder(t)
  const files = attemptFiles(page, runFolder, [])
  const staged = files.stage([{ name: 'notes.txt', mimeType: 'text/plain', base64: Buffer.from('hello').toString('base64') }], 'setInputFiles')
  assert.ok(staged.ok, JSON.stringify(staged))
  const command: ResolvedInputFiles = { kind: 'setInputFiles', locator: byLabel('Notes'), files: [{ name: 'notes.txt', mimeType: 'text/plain', base64: '' }], paths: staged.paths, mimeTypes: staged.mimeTypes }
  const result = await page.execute(command, defaultTimeouts.action)
  assert.ok(result.ok && result.kind === 'setInputFiles', JSON.stringify(result))
  assert.deepEqual(result.files, [{ name: 'notes.txt', size: 5, type: 'text/plain' }])
  await send(page, 1)
  assert.deepEqual(await received(), [{ field: 'notes', name: 'notes.txt', type: 'text/plain', size: 5, sha256: sha256('hello') }])
  files.close()
  assert.deepEqual(readdirSync(runFolder), [], 'the folder written for the input went with the attempt')
})

test('a type the browser does not give the file fails, after the input took it', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const path = await writeReport(t, 'notes.txt', Buffer.from('hello'))
  const command: ResolvedInputFiles = { kind: 'setInputFiles', locator: byLabel('Notes'), files: [{ name: 'notes.txt', base64: '' }], paths: [path], mimeTypes: ['application/json'] }
  const failure = failureOf(await page.execute(command, 2000))
  assert.equal(failure.class, 'usage')
  assert.equal(failure.message, 'The browser gave notes.txt the type text/plain, not application/json: it types a file by the end of its name. Name the file so its type comes out as asked.')
  assert.equal(failure.details?.['inputSent'], true)
})

test('an empty list clears the input, and the form sends no file', { skip }, async (t) => {
  const { page, received } = await filesPage(t)
  assertOk(await give(page, byLabel('Attachment'), [await writeReport(t)]))
  const cleared = await give(page, byLabel('Attachment'), [])
  assert.ok(cleared.ok && cleared.kind === 'setInputFiles')
  assert.deepEqual(cleared.files, [])
  assert.match(await heard(page), /attachment change: report\.pdf 24\nattachment input\nattachment change\n$/)
  await send(page, 0)
  assert.deepEqual(await received(), [])
})

test('an input that takes several files gets each, and one that takes one refuses two before it gets any', { skip }, async (t) => {
  const { page, received } = await filesPage(t)
  const first = await writeReport(t, 'a.png', Buffer.from('first picture'))
  const second = await writeReport(t, 'b.png', Buffer.from('second'))
  const many = await give(page, byLabel('Photos'), [first, second])
  assert.ok(many.ok && many.kind === 'setInputFiles')
  assert.deepEqual(many.files, [{ name: 'a.png', size: 13, type: 'image/png' }, { name: 'b.png', size: 6, type: 'image/png' }])
  const refused = failureOf(await give(page, byLabel('Attachment'), [first, second]))
  assert.equal(refused.class, 'usage')
  assert.equal(refused.message, "Could not set the files of getByLabel('Attachment'): it takes one file, and it was given 2. Pass one file, or add the multiple attribute to the input.")
  assert.equal(refused.details?.['inputSent'], false)
  assert.doesNotMatch(await heard(page), /attachment/)
  await send(page, 2)
  assert.deepEqual((await received()).map((file) => `${file.field} ${file.name} ${file.size}`), ['photos a.png 13', 'photos b.png 6'])
})

test('a hidden input gets files, and a disabled one is waited for and refused', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const path = await writeReport(t)
  assertOk(await give(page, byTestId('hidden-upload'), [path]))
  assert.match(await heard(page), /hidden-upload change: report\.pdf 24/)
  const started = performance.now()
  const disabled = failureOf(await give(page, byLabel('Locked'), [path], 300))
  assert.ok(performance.now() - started >= 290, 'a disabled input is waited for until the time runs out')
  assert.equal(disabled.class, 'not_actionable')
  assert.equal(disabled.message, "Could not set the files of getByLabel('Locked') within 300 ms: it is disabled.")
})

test('an element that is not a file input fails at once by name, and a label stands for its input', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const path = await writeReport(t)
  const button = failureOf(await give(page, byRole('button', 'Send'), [path]))
  assert.equal(button.class, 'not_actionable')
  assert.equal(button.message, `Could not set the files of getByRole('button', { name: 'Send' }): it is <button data-testid="send">, and setInputFiles() gives files to an <input type="file">. For a button that opens a file picker, use page.fileChooser().`)
  assertOk(await page.execute({ kind: 'setInputFiles', locator: { by: 'text', text: 'Attachment' }, files: [], paths: [path], mimeTypes: [null] }, defaultTimeouts.action))
  assert.match(await heard(page), /attachment change: report\.pdf 24/)
})

test('an armed picker is caught, never shown, and its input gets the files, which reach the server', { skip }, async (t) => {
  const { page, received } = await filesPage(t)
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'upload-button'))
  const caught = await within(arm.opened, defaultTimeouts.action, 'the page opened no file picker')
  assert.equal(caught.multiple, false)
  const given = await giveChooser(page, caught.id, [await writeReport(t)])
  assert.ok(given.ok && given.kind === 'setChooserFiles', JSON.stringify(given))
  assert.deepEqual(given.files, [{ name: 'report.pdf', size: report.length, type: 'application/pdf' }])
  assert.equal(await heard(page), 'hidden-upload input: report.pdf 24\nhidden-upload change: report.pdf 24\n')
  await send(page, 1)
  assert.deepEqual(await received(), [{ field: 'hidden', name: 'report.pdf', type: 'application/pdf', size: report.length, sha256: sha256(report) }])
})

test('a picker for several files says so, and takes several', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'add-photos'))
  const caught = await within(arm.opened, defaultTimeouts.action, 'the page opened no file picker')
  assert.equal(caught.multiple, true)
  const given = await giveChooser(page, caught.id, [await writeReport(t, 'a.png', Buffer.from('a')), await writeReport(t, 'b.png', Buffer.from('bb'))])
  assert.ok(given.ok && given.kind === 'setChooserFiles')
  assert.deepEqual(given.files?.map((file) => file.name), ['a.png', 'b.png'])
  const one = filesOf(page).armFileChooser()
  assertOk(await click(page, 'upload-button'))
  const single = await within(one.opened, defaultTimeouts.action, 'the page opened no second file picker')
  assert.equal(failureOf(await giveChooser(page, single.id, [await writeReport(t, 'c.png'), await writeReport(t, 'd.png')])).message, "Could not give the file picker files: it takes one file, and it was given 2. Pass one file, or add the multiple attribute to the input.")
})

// WebKit difference 13: the build never shows an intercepted picker and tells the page nothing of it.
test('a picker nobody waited for fails the click that opened it, is never shown, the page hears nothing of it, and the page stays usable', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const failure = failureOf(await click(page, 'upload-button'))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.message, "The page opened a file picker as Retest went to click getByTestId('upload-button'), and nothing was waiting for one. WebKit did not show it, and tells the page nothing of it, not even cancel.")
  assert.deepEqual(failure.details, { picker: 'file', inputSent: true })
  await delay(300)
  assert.equal(await heard(page), '', 'the page heard no cancel')
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'upload-button'))
  const caught = await within(arm.opened, defaultTimeouts.action, 'the page opened no second file picker')
  assertOk(await giveChooser(page, caught.id, [await writeReport(t)]))
  assert.match(await heard(page), /^hidden-upload input: report\.pdf 24\nhidden-upload change: report\.pdf 24\n$/)
})

test('a picker that opens after its action answered fails the next action before it sends anything', { skip }, async (t) => {
  const { page } = await filesPage(t)
  assertOk(await click(page, 'late-picker'))
  // The page opens the picker 300 ms after the click, and WebKit tells the page nothing of it, so the case waits past that.
  await delay(1000)
  const next = failureOf(await click(page, 'add-photos'))
  assert.equal(next.class, 'not_actionable')
  assert.equal(next.message, "The page opened a file picker after the action before this one, and nothing was waiting for one. WebKit did not show it, and Retest did not click getByTestId('add-photos').")
  assert.equal(next.details?.['inputSent'], false)
  await delay(100)
  assert.equal(await heard(page), '')
})

test('a page arms for one picker at a time, and a released arm catches nothing', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const files = filesOf(page)
  const first = files.armFileChooser()
  const second = files.armFileChooser()
  await assert.rejects(second.opened, (error: unknown) => error instanceof Error && 'failure' in error && JSON.stringify(error.failure).includes('already waiting'))
  first.release()
  assert.equal(failureOf(await click(page, 'upload-button')).details?.['picker'], 'file')
})

test('an input whose page clears it once it heard the change still took the files, and the result says what it kept', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const path = await writeReport(t)
  const given = await give(page, byLabel('Clears'), [path])
  assert.ok(given.ok && given.kind === 'setInputFiles', JSON.stringify(given))
  assert.deepEqual([given.files, given.kept], [[{ name: 'report.pdf', size: report.length, type: 'application/pdf' }], []])
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'clears-button'))
  const caught = await within(arm.opened, defaultTimeouts.action, 'the page opened no file picker')
  const chosen = await giveChooser(page, caught.id, [path])
  assert.ok(chosen.ok && chosen.kind === 'setChooserFiles', JSON.stringify(chosen))
  assert.deepEqual([chosen.files, chosen.kept], [[{ name: 'report.pdf', size: report.length, type: 'application/pdf' }], []])
})

test("a caught picker of a frame inside the page is read in Retest's world of that frame, whatever the page says its files are", { skip }, async (t) => {
  const { page } = await filesPage(t)
  assertOk(await goto(page, '/files/framed'))
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'framed-upload'))
  const caught = await within(arm.opened, defaultTimeouts.action, 'the frame opened no file picker')
  const given = await giveChooser(page, caught.id, [await writeReport(t)])
  assert.ok(given.ok && given.kind === 'setChooserFiles', JSON.stringify(given))
  assert.deepEqual(given.files, [{ name: 'report.pdf', size: report.length, type: 'application/pdf' }])
  assert.equal(given.kept, undefined, "the frame's own empty answer for files is not what the input holds")
})

test('a picker caught before its page moved on gives no files to the document that replaced it', { skip }, async (t) => {
  const { page } = await filesPage(t)
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'upload-button'))
  const caught = await within(arm.opened, defaultTimeouts.action, 'the page opened no file picker')
  assertOk(await goto(page, '/files'))
  assert.deepEqual(failureOf(await giveChooser(page, caught.id, [await writeReport(t)])), { class: 'not_actionable', message: 'Could not give the file picker files: the input it opened for is gone from the page, so Retest gave it nothing.', details: { inputSent: false } })
  assert.equal(await heard(page), '')
})

test("a label finds a file input only through a label the page wrote, never through the browser's own button text", { skip }, async (t) => {
  const { page } = await filesPage(t)
  assert.equal((await observe(page, byLabel('Attachment'))).count, 1)
  assert.equal((await observe(page, byLabel('Choose File'))).count, 0)
  assert.equal((await observe(page, byLabel('No file chosen'))).count, 0)
  assert.equal((await observe(page, byLabel('Upload', false))).count, 0, 'the hidden input behind the upload button is labelled by nothing')
})

test('a link download is saved under its suggested name with the bytes the server sent', { skip }, async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const waiting = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
  assertOk(await click(page, 'export'))
  assert.deepEqual(await waiting, { ok: true, kind: 'download', download: 'download-1', suggestedFilename: 'tasks.csv' })
  assert.deepEqual(await files.saved('download-1', { timeoutMs: defaultTimeouts.action, signal }), { ok: true, kind: 'saved', path: join(folder, 'tasks.csv'), size: Buffer.byteLength(TASKS_CSV) })
  assert.equal(readFileSync(join(folder, 'tasks.csv'), 'utf8'), TASKS_CSV)
  assert.deepEqual(readdirSync(folder), ['tasks.csv'])
  const [event] = events
  assert.deepEqual({ ...event }, {
    type: 'download',
    testId: 'files',
    attemptId: 'attempt1',
    session: 'web',
    sessionId: 'attempt1:web',
    suggestedFilename: 'tasks.csv',
    url: `${new URL(page.url ?? '').origin}/files/tasks.csv`,
    state: 'completed',
    path: 'artifacts/attempt1/web/downloads/tasks.csv',
    size: Buffer.byteLength(TASKS_CSV),
    awaited: true,
  })
})

test('a download a script starts from a blob is saved too, under a name a file can hold, and a second takes a number', { skip }, async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  for (const expected of ['tasks-report.csv', 'tasks-report-2.csv']) {
    const waiting = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
    assertOk(await click(page, 'export-script'))
    const began = await waiting
    assert.ok(began.ok && began.kind === 'download')
    assert.equal(began.suggestedFilename, 'tasks report.csv')
    const saved = await files.saved(began.download, { timeoutMs: defaultTimeouts.action, signal })
    assert.ok(saved.ok && saved.kind === 'saved', JSON.stringify(saved))
    assert.equal(saved.path, join(folder, expected))
    assert.equal(readFileSync(saved.path, 'utf8'), TASKS_CSV)
  }
  assert.deepEqual(events.map((event) => (event.type === 'download' ? event.url : event.type)), ['blob:', 'blob:'])
})

// WebKit difference 14: the build counts no bytes and gives no total, and says why it stopped a download.
test("a download the server breaks off fails in WebKit's words, saying how much arrived, and leaves no file", { skip }, async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const waiting = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
  assertOk(await click(page, 'export-broken'))
  const began = await waiting
  assert.ok(began.ok && began.kind === 'download')
  const saved = await files.saved(began.download, { timeoutMs: 10_000, signal })
  assert.ok(!saved.ok, JSON.stringify(saved))
  const [event] = await downloadEvents(events, 1)
  assert.ok(event?.state === 'canceled', JSON.stringify(event))
  const arrived = event.receivedBytes ?? -1
  // The server sends 11 bytes before it breaks off; the file WebKit wrote held what had arrived of them.
  assert.ok(arrived >= 0 && arrived <= 11, JSON.stringify(event))
  assert.equal(event.totalBytes, 0, 'WebKit gives no total')
  assert.deepEqual(saved.failure, {
    class: 'not_actionable',
    message: `The browser stopped the download of broken.csv after ${arrived} bytes had arrived: The network connection was lost. Retest saved nothing.`,
    details: { download: 'broken.csv', receivedBytes: arrived, totalBytes: 0 },
  })
  assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], [])
})

test('a download still on its way says how much arrived when its wait runs out, is unfinished when the attempt ends, and leaves no file', { skip }, async (t) => {
  const sent = 'title,done\nRelease checklist,false\n'
  const bytes = Buffer.byteLength(sent)
  const site = await slowDownloads(t, sent)
  const folder = join(await scratchFolder(t), 'downloads')
  const page = await openPage(t, browser(), site, { downloads: folder })
  assertOk(await goto(page, '/'))
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const waiting = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
  assertOk(await click(page, 'slow'))
  const began = await waiting
  assert.ok(began.ok && began.kind === 'download', JSON.stringify(began))
  assert.equal(began.suggestedFilename, 'slow.csv')
  const end = performance.now() + 5000
  let late = await files.saved(began.download, { timeoutMs: 300, signal })
  while (!late.ok && !late.failure.message.endsWith(`: ${bytes} bytes had arrived.`) && performance.now() < end) late = await files.saved(began.download, { timeoutMs: 300, signal })
  assert.deepEqual(late, { ok: false, failure: { class: 'timeout', message: `The download of slow.csv was not saved within 300 ms: ${bytes} bytes had arrived.`, details: { timeoutMs: 300 } } })
  files.close()
  const [unfinished] = await downloadEvents(events, 1)
  assert.deepEqual([unfinished?.state, unfinished?.suggestedFilename, unfinished?.state === 'unfinished' ? [unfinished.receivedBytes, unfinished.totalBytes] : []], ['unfinished', 'slow.csv', [bytes, 0]])
  // The page's end stops the download, and what had arrived of it goes with it.
  await page.dispose(defaultTimeouts.cleanup)
  assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], [])
})

test('a page opened without a downloads folder refuses downloads, and the refusal names where it ran', { skip }, async (t) => {
  const { page } = await filesPage(t)
  assert.equal(filesOf(page).onDownload, undefined)
  const answer = await attemptFiles(page, await scratchFolder(t), []).download('web', { timeoutMs: 500, signal: new AbortController().signal })
  assert.deepEqual(answer, { ok: false, failure: { class: 'unsupported', message: 'Retest saves downloads on Chrome, Chromium, Firefox and WebKit only, and not on WebKit yet, so it waited for none.' } })
})

// WebKit difference 15: the build names the page whose link opened the new page as the download's own.
test("a download a target=_blank link starts in a new tab is the page's, saved, and told as begun in the page itself", { skip }, async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const waiting = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
  assertOk(await click(page, 'export-new-tab'))
  assert.deepEqual(await waiting, { ok: true, kind: 'download', download: 'download-1', suggestedFilename: 'tasks.csv' })
  assert.deepEqual(await files.saved('download-1', { timeoutMs: defaultTimeouts.action, signal }), { ok: true, kind: 'saved', path: join(folder, 'tasks.csv'), size: Buffer.byteLength(TASKS_CSV) })
  const [event] = await downloadEvents(events, 1)
  assert.deepEqual([event?.state, event?.startedIn, event?.awaited], ['completed', undefined, true])
})

test("a download a frame of another site starts is the page's own, and one from a frame of a page it opened is taken as begun in a popup", { skip }, async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const framed = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
  assertOk(await click(page, 'export-frame'))
  const fromFrame = await framed
  assert.ok(fromFrame.ok && fromFrame.kind === 'download', JSON.stringify(fromFrame))
  assert.ok((await files.saved(fromFrame.download, { timeoutMs: defaultTimeouts.action, signal })).ok)
  const [frameEvent] = await downloadEvents(events, 1)
  assert.deepEqual([frameEvent?.state, frameEvent?.startedIn, frameEvent?.awaited, frameEvent?.url], ['completed', undefined, true, `${new URL(page.url ?? '').origin.replace('127.0.0.1', 'localhost')}/files/tasks.csv`])
  const opened = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
  assertOk(await click(page, 'export-opened'))
  const fromOpened = await opened
  assert.ok(fromOpened.ok && fromOpened.kind === 'download', JSON.stringify(fromOpened))
  assert.ok((await files.saved(fromOpened.download, { timeoutMs: defaultTimeouts.action, signal })).ok)
  const [, openedEvent] = await downloadEvents(events, 2)
  assert.deepEqual([openedEvent?.state, openedEvent?.startedIn, openedEvent?.awaited, openedEvent?.path], ['completed', 'popup', true, 'artifacts/attempt1/web/downloads/tasks-2.csv'])
  assert.deepEqual(readdirSync(folder).sort(), ['tasks-2.csv', 'tasks.csv'])
})

test('a download that holds the value of a secret is removed, recorded as withheld, and gives no path', { skip }, async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const redactor = new Redactor()
  redactor.learn('api-token', 'tok-5f8a2c91e4')
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder, redactor)
  const signal = new AbortController().signal
  assertOk(await page.execute({ kind: 'fill', locator: byTestId('key-value'), value: 'key=tok-5f8a2c91e4' }, defaultTimeouts.action))
  const waiting = files.download('web', { timeoutMs: defaultTimeouts.action, signal })
  assertOk(await click(page, 'download-key'))
  const began = await waiting
  assert.ok(began.ok && began.kind === 'download', JSON.stringify(began))
  assert.deepEqual(await files.saved(began.download, { timeoutMs: 5000, signal }), { ok: false, failure: { class: 'unsupported', message: 'Retest did not keep the download of key.txt: it holds the value of a secret, and a secret never reaches a file of the run. Retest removed the file.', details: { download: 'key.txt' } } })
  assert.deepEqual(readdirSync(folder), [])
  const [event] = await downloadEvents(events, 1)
  assert.deepEqual([event?.state, event?.path, event?.failure?.class], ['withheld', undefined, 'unsupported'])
})

test('an agent session told of a picker nobody waited for says the session cannot give a page files', { skip }, async (t) => {
  const app = await openApp(t)
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: app.url })
  assert.ok((await session.act({ kind: 'goto', url: '/files' })).result.ok)
  const { result } = await session.act({ kind: 'click', locator: byTestId('upload-button') })
  assert.ok(!result.ok)
  assert.equal(result.failure.message, "The page opened a file picker as Retest went to click getByTestId('upload-button'), and nothing was waiting for one. WebKit did not show it, and tells the page nothing of it, not even cancel. This agent session cannot give a page files.")
})

const runTests = (received: string) => `import { readFile } from 'node:fs/promises'
import { expect, test } from '@rehearsal-labs/retest'

test('uploads by path, by content and through a picker, then downloads a CSV', async ({ page }) => {
  await page.goto('/files')
  await page.getByLabel('Attachment').setInputFiles('../fixtures/report.pdf')
  await page.getByLabel('Photos').setInputFiles(['../fixtures/a.png', '../fixtures/b.png'])
  await page.getByLabel('Notes').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', content: 'hello' })
  const chooser = await page.fileChooser(() => page.getByRole('button', { name: 'Upload' }).click())
  expect(chooser.multiple).toBe(false)
  await chooser.setFiles('../fixtures/report.pdf')
  await page.getByRole('button', { name: 'Send' }).click()
  await expect(page.getByTestId('received-count')).toHaveText('5')
  const received = await (await fetch(${JSON.stringify(received)})).json()
  expect(received.map((file) => file.field + ' ' + file.name + ' ' + file.type + ' ' + file.size)).toEqual([
    'attachment report.pdf application/pdf 24',
    'photos a.png image/png 13',
    'photos b.png image/png 6',
    'notes notes.txt text/plain 5',
    'hidden report.pdf application/pdf 24',
  ])
  await page.goto('/files')
  const download = await page.download(() => page.getByRole('link', { name: 'Export CSV' }).click())
  expect(download.suggestedFilename).toBe('tasks.csv')
  expect(await readFile(await download.path(), 'utf8')).toBe(${JSON.stringify(TASKS_CSV)})
  await download.saveAs('../out/tasks.csv')
  expect(await readFile(new URL('../out/tasks.csv', import.meta.url), 'utf8')).toBe(${JSON.stringify(TASKS_CSV)})
})

test('a picker nobody waited for fails the click that opened it', async ({ page }) => {
  await page.goto('/files')
  await page.getByRole('button', { name: 'Upload' }).click()
})

test('a download the server breaks off fails path()', async ({ page }) => {
  await page.goto('/files')
  const download = await page.download(() => page.getByTestId('export-broken').click())
  await download.path()
})

test('a path with no file fails usage, naming the path', async ({ page }) => {
  await page.goto('/files')
  await page.getByLabel('Attachment').setInputFiles('../fixtures/missing.pdf')
})
`

test('a run on WebKit uploads, catches a picker and keeps downloads, and its events and run folder say so', { skip }, async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: { browser: 'webkit', executablePath: ${JSON.stringify(webKitPath())}, baseUrl: ${JSON.stringify(app.url)} } } }`),
    'tests/files.retest.ts': runTests(`${app.url}/files/received`),
    'fixtures/report.pdf': '%PDF-1.4 a small report\n',
    'fixtures/a.png': 'first picture',
    'fixtures/b.png': 'second',
  })
  const run = await runProject(t, root, { timeouts: budgets({ action: defaultTimeouts.action }) })
  assert.equal(run.exit.code, 1, run.stderr)

  const flow = testNamed(run, 'uploads by path, by content and through a picker, then downloads a CSV')
  assert.equal(flow.status, 'passed', JSON.stringify(flow.failure))
  assert.equal(readFileSync(join(root, 'out', 'tasks.csv'), 'utf8'), TASKS_CSV)
  const actions = eventsOf(run.events, 'action.completed').filter((event) => event.testId === flow.testId && (event.command === 'setInputFiles' || event.command === 'setChooserFiles'))
  assert.deepEqual(actions.map((event) => [event.command, event.files]), [
    ['setInputFiles', [{ name: 'report.pdf', size: 24, type: 'application/pdf' }]],
    ['setInputFiles', [{ name: 'a.png', size: 13, type: 'image/png' }, { name: 'b.png', size: 6, type: 'image/png' }]],
    ['setInputFiles', [{ name: 'notes.txt', size: 5, type: 'text/plain' }]],
    ['setChooserFiles', [{ name: 'report.pdf', size: 24, type: 'application/pdf' }]],
  ])
  const downloads = eventsOf(run.events, 'download')
  const flowDownload = downloads.find((event) => event.testId === flow.testId)
  assert.ok(flowDownload !== undefined && flowDownload.state === 'completed', JSON.stringify(downloads))
  assert.deepEqual([flowDownload.suggestedFilename, flowDownload.awaited, flowDownload.url, flowDownload.size], ['tasks.csv', true, `${app.url}/files/tasks.csv`, Buffer.byteLength(TASKS_CSV)])
  assert.match(flowDownload.path ?? '', /^artifacts\/[a-z0-9]+\/web-[a-z0-9]+\/downloads\/tasks\.csv$/)
  assert.equal(readFileSync(join(run.output, flowDownload.path ?? ''), 'utf8'), TASKS_CSV)

  const picker = testNamed(run, 'a picker nobody waited for fails the click that opened it')
  assert.deepEqual([picker.status, picker.failure?.class, picker.failure?.message], ['failed', 'not_actionable', "The page opened a file picker as Retest went to click getByRole('button', { name: 'Upload' }), and nothing was waiting for one. WebKit did not show it, and tells the page nothing of it, not even cancel. To give a picker files, wrap the action that opens it in page.fileChooser(), or call setInputFiles() on the file input."])

  const broken = testNamed(run, 'a download the server breaks off fails path()')
  assert.equal(broken.status, 'failed')
  assert.match(broken.failure?.message ?? '', /^The browser stopped the download of broken\.csv after \d+ bytes had arrived: The network connection was lost\. Retest saved nothing\.$/)
  assert.ok(downloads.some((event) => event.testId === broken.testId && event.state === 'canceled'))

  const missing = testNamed(run, 'a path with no file fails usage, naming the path')
  assert.deepEqual([missing.failure?.class, missing.failure?.message], ['usage', `setInputFiles() found no file at ${join(realpathSync(root), 'fixtures', 'missing.pdf')}.`])

  // Every download a test kept is named by its event, so nothing in the run folder is a file no record names.
  const inventory = inventoryArtifacts(run.output, [...eventArtifactReferences(run.events), ...resultArtifactReferences(resultOf(run))])
  const named = inventory.present.filter((file) => file.namedBy.includes('download')).map((file) => file.reference)
  assert.deepEqual(named.sort(), downloads.flatMap((event) => (event.path === undefined ? [] : [event.path])).sort())
  assert.deepEqual(inventory.unreferenced.filter((file) => file.reference.includes('/downloads/')), [])
  assert.equal(existsSync(join(run.output, 'uploads')), false, 'the files written for inputs went with their attempts')

  const reported = await runCli(t, ['report', run.output])
  assert.equal(reported.exit.code, 0, reported.stderr)
  const html = readFileSync(join(run.output, 'report.html'), 'utf8')
  assert.ok(html.includes(`<a href="${flowDownload.path}" download><code>${flowDownload.path}</code></a> · download tasks.csv, ${Buffer.byteLength(TASKS_CSV)} bytes`), 'the report links the download a passing test kept')
  assert.match(html, /download broken\.csv stopped after \d+ bytes/)
})
