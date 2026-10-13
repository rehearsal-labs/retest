import type { TestContext } from 'node:test'
import type { FilesCapability, OwnedPage, ResolvedInputFiles } from '../../src/browser/contract.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { InputFileRecord } from '../../src/protocol/files.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ReceivedFile } from '../../fixtures/task-app/files-page.ts'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ELECTRON_FILES_MAIN, ELECTRON_FILES_PAGE, TASKS_CSV } from '../../fixtures/task-app/files-page.ts'
import { launchElectron } from '../../src/browser/electron.ts'
import { AttemptFiles } from '../../src/runner/files.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { agentHost, openOn } from './agent-harness.ts'
import { assertOk, byLabel, byRole, byTestId, click, failureOf, goto, observe, observeUntil, openApp, openPage, scratchFolder, sharedBrowser, within } from './browser-harness.ts'

// File inputs, the file picker and downloads on Chrome, driven at the driver: what reaches the page and the server, what
// the page hears, and what the browser saves. The runner's half, the files given by content and the downloads it keeps,
// runs here through the attempt's own files on the real browser; files.test.ts runs it through a whole run.

const browser = sharedBrowser()
const report = Buffer.from('%PDF-1.4 a small report\n')

type FilesPage = { page: OwnedPage; url: string; received: () => Promise<ReceivedFile[]> }

async function filesPage(t: TestContext, downloads?: string): Promise<FilesPage> {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url, downloads === undefined ? {} : { downloads })
  assertOk(await goto(page, '/files'))
  const received = async (): Promise<ReceivedFile[]> => {
    const response = await fetch(`${app.url}/files/received`)
    return (await response.json()) as ReceivedFile[]
  }
  return { page, url: app.url, received }
}

function filesOf(page: OwnedPage): FilesCapability {
  const { files } = page
  assert.ok(files !== undefined, 'a Chrome page catches its file pickers')
  return files
}

function give(page: OwnedPage, locator: LocatorRecipe, paths: readonly string[], timeoutMs = 2000): Promise<CommandResult> {
  const files: InputFileRecord[] = paths.map((path) => ({ path, folder: '/' }))
  const command: ResolvedInputFiles = { kind: 'setInputFiles', locator, files, paths, mimeTypes: paths.map(() => null) }
  return page.execute(command, timeoutMs)
}

function giveChooser(page: OwnedPage, chooser: string, paths: readonly string[]): Promise<CommandResult> {
  const files: InputFileRecord[] = paths.map((path) => ({ path, folder: '/' }))
  return page.execute({ kind: 'setChooserFiles', chooser, files, paths, mimeTypes: paths.map(() => null) }, 2000)
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

// The attempt's files on a page of this browser, writing what they make into `runFolder` and their events into `events`,
// and hiding what `redactor` knows.
function attemptFiles(page: OwnedPage, runFolder: string, events: EventBody[], downloads?: string, redactor?: Redactor): AttemptFiles {
  const pages = new Map([['web', { files: page.files, where: 'on this browser', sessionId: 'attempt1:web', ...(downloads === undefined ? {} : { downloads: { folder: downloads, reference: 'artifacts/attempt1/web/downloads' } }) }]])
  return new AttemptFiles({ pages, runFolder, testId: 'files', attemptId: 'attempt1', emit: (body) => events.push(body), ...(redactor === undefined ? {} : { redactor }) })
}

// Waits for the download events the attempt's files wrote, up to `count` of them.
async function downloadEvents(events: readonly EventBody[], count: number): Promise<Extract<EventBody, { type: 'download' }>[]> {
  const written = () => events.filter((event): event is Extract<EventBody, { type: 'download' }> => event.type === 'download')
  const end = performance.now() + 5000
  while (written().length < count && performance.now() < end) await delay(20)
  return written()
}

test('a file by path reaches the input and the server with its name, type and bytes', async (t) => {
  const { page, received } = await filesPage(t)
  const path = await writeReport(t)
  const result = await give(page, byLabel('Attachment'), [path])
  assert.ok(result.ok && result.kind === 'setInputFiles', JSON.stringify(result))
  assert.deepEqual(result.files, [{ name: 'report.pdf', size: report.length, type: 'application/pdf' }])
  assert.equal(result.page?.title, 'Files')
  assert.equal(await heard(page), `attachment input: report.pdf ${report.length}\nattachment change: report.pdf ${report.length}\n`)
  await send(page, 1)
  assert.deepEqual(await received(), [{ field: 'attachment', name: 'report.pdf', type: 'application/pdf', size: report.length, sha256: sha256(report) }])
})

test('a file given by content is written for the input, typed by its name, and removed when the attempt closes', async (t) => {
  const { page, received } = await filesPage(t)
  const runFolder = await scratchFolder(t)
  const files = attemptFiles(page, runFolder, [])
  const staged = files.stage([{ name: 'notes.txt', mimeType: 'text/plain', base64: Buffer.from('hello').toString('base64') }], 'setInputFiles')
  assert.ok(staged.ok, JSON.stringify(staged))
  assert.equal(readFileSync(staged.paths[0] ?? '', 'utf8'), 'hello')
  const command: ResolvedInputFiles = { kind: 'setInputFiles', locator: byLabel('Notes'), files: [{ name: 'notes.txt', mimeType: 'text/plain', base64: '' }], paths: staged.paths, mimeTypes: staged.mimeTypes }
  const result = await page.execute(command, 2000)
  assert.ok(result.ok && result.kind === 'setInputFiles', JSON.stringify(result))
  assert.deepEqual(result.files, [{ name: 'notes.txt', size: 5, type: 'text/plain' }])
  await send(page, 1)
  assert.deepEqual(await received(), [{ field: 'notes', name: 'notes.txt', type: 'text/plain', size: 5, sha256: sha256('hello') }])
  files.close()
  assert.deepEqual(readdirSync(runFolder), [], 'the folder written for the input went with the attempt')
})

test('a type the browser does not give the file fails, after the input took it', async (t) => {
  const { page } = await filesPage(t)
  const path = await writeReport(t, 'notes.txt', Buffer.from('hello'))
  const command: ResolvedInputFiles = { kind: 'setInputFiles', locator: byLabel('Notes'), files: [{ name: 'notes.txt', base64: '' }], paths: [path], mimeTypes: ['application/json'] }
  const failure = failureOf(await page.execute(command, 2000))
  assert.equal(failure.class, 'usage')
  assert.equal(failure.message, 'The browser gave notes.txt the type text/plain, not application/json: it types a file by the end of its name. Name the file so its type comes out as asked.')
  assert.equal(failure.details?.['inputSent'], true)
})

test('a path with no file at it fails usage, naming the path, and the input gets nothing', async (t) => {
  const { page } = await filesPage(t)
  const folder = await scratchFolder(t)
  const staged = attemptFiles(page, folder, []).stage([{ path: './missing.pdf', folder }], 'setInputFiles')
  assert.deepEqual(staged, { ok: false, failure: { class: 'usage', message: `setInputFiles() found no file at ${join(folder, 'missing.pdf')}.`, details: { path: join(folder, 'missing.pdf'), inputSent: false } } })
  assert.equal(await heard(page), '')
})

test('an empty list clears the input, and the form sends no file', async (t) => {
  const { page, received } = await filesPage(t)
  assertOk(await give(page, byLabel('Attachment'), [await writeReport(t)]))
  const cleared = await give(page, byLabel('Attachment'), [])
  assert.ok(cleared.ok && cleared.kind === 'setInputFiles')
  assert.deepEqual(cleared.files, [])
  assert.match(await heard(page), /attachment change: report\.pdf 24\nattachment input\nattachment change\n$/)
  await send(page, 0)
  assert.deepEqual(await received(), [])
})

test('an input that takes several files gets each, and one that takes one refuses two before it gets any', async (t) => {
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

test('a hidden input gets files, and a disabled one is waited for and refused', async (t) => {
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

test('an element that is not a file input fails at once by name, and a label stands for its input', async (t) => {
  const { page } = await filesPage(t)
  const path = await writeReport(t)
  const button = failureOf(await give(page, byRole('button', 'Send'), [path]))
  assert.equal(button.class, 'not_actionable')
  assert.equal(button.message, `Could not set the files of getByRole('button', { name: 'Send' }): it is <button data-testid="send">, and setInputFiles() gives files to an <input type="file">. For a button that opens a file picker, use page.fileChooser().`)
  const label = await page.execute({ kind: 'setInputFiles', locator: { by: 'text', text: 'Attachment' }, files: [], paths: [path], mimeTypes: [null] }, 2000)
  assertOk(label)
  assert.match(await heard(page), /attachment change: report\.pdf 24/)
})

test('an armed picker is caught, never shown, and its input gets the files', async (t) => {
  const { page } = await filesPage(t)
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'upload-button'))
  const caught = await within(arm.opened, 2000, 'the page opened no file picker')
  assert.deepEqual({ multiple: caught.multiple }, { multiple: false })
  const given = await giveChooser(page, caught.id, [await writeReport(t)])
  assert.ok(given.ok && given.kind === 'setChooserFiles', JSON.stringify(given))
  assert.deepEqual(given.files, [{ name: 'report.pdf', size: report.length, type: 'application/pdf' }])
  assert.match(await heard(page), /^hidden-upload input: report\.pdf 24\nhidden-upload change: report\.pdf 24\n$/)
})

test('a picker for several files says so, and takes several', async (t) => {
  const { page } = await filesPage(t)
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'add-photos'))
  const caught = await within(arm.opened, 2000, 'the page opened no file picker')
  assert.equal(caught.multiple, true)
  const given = await giveChooser(page, caught.id, [await writeReport(t, 'a.png', Buffer.from('a')), await writeReport(t, 'b.png', Buffer.from('bb'))])
  assert.ok(given.ok && given.kind === 'setChooserFiles')
  assert.deepEqual(given.files?.map((file) => file.name), ['a.png', 'b.png'])
})

test('a picker nobody waited for fails the click that opened it, is cancelled, and leaves the page usable', async (t) => {
  const { page } = await filesPage(t)
  const failure = failureOf(await click(page, 'upload-button'))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.message, "The page opened a file picker as Retest went to click getByTestId('upload-button'), and nothing was waiting for one. Retest closed the picker.")
  assert.deepEqual(failure.details, { picker: 'file', inputSent: true })
  await observeUntil(page, 'heard', (observation) => observation.text === 'hidden-upload cancel\n')
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'upload-button'))
  const caught = await within(arm.opened, 2000, 'the page opened no second file picker')
  assertOk(await giveChooser(page, caught.id, [await writeReport(t)]))
  assert.match(await heard(page), /hidden-upload change: report\.pdf 24/)
})

test('a picker that opens after its action answered fails the next action before it sends anything', async (t) => {
  const { page } = await filesPage(t)
  assertOk(await click(page, 'late-picker'))
  await observeUntil(page, 'heard', (observation) => observation.text === 'hidden-upload cancel\n')
  const next = failureOf(await click(page, 'add-photos'))
  assert.equal(next.class, 'not_actionable')
  assert.equal(next.message, "The page opened a file picker after the action before this one, and nothing was waiting for one. Retest closed the picker, and did not click getByTestId('add-photos').")
  assert.equal(next.details?.['inputSent'], false)
  await delay(100)
  assert.equal(await heard(page), 'hidden-upload cancel\n')
})

test('a page arms for one picker at a time, and a released arm catches nothing', async (t) => {
  const { page } = await filesPage(t)
  const files = filesOf(page)
  const first = files.armFileChooser()
  const second = files.armFileChooser()
  await assert.rejects(second.opened, (error: unknown) => error instanceof Error && 'failure' in error && JSON.stringify(error.failure).includes('already waiting'))
  first.release()
  const failure = failureOf(await click(page, 'upload-button'))
  assert.equal(failure.details?.['picker'], 'file')
})

test('a link download is saved under its suggested name with the bytes the server sent', async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const waiting = files.download('web', { timeoutMs: 2000, signal })
  assertOk(await click(page, 'export'))
  const began = await waiting
  assert.deepEqual(began, { ok: true, kind: 'download', download: 'download-1', suggestedFilename: 'tasks.csv' })
  const saved = await files.saved('download-1', { timeoutMs: 5000, signal })
  assert.deepEqual(saved, { ok: true, kind: 'saved', path: join(folder, 'tasks.csv'), size: Buffer.byteLength(TASKS_CSV) })
  assert.equal(readFileSync(join(folder, 'tasks.csv'), 'utf8'), TASKS_CSV)
  assert.deepEqual(readdirSync(folder), ['tasks.csv'])
  const [event] = events
  assert.ok(event?.type === 'download')
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

test('a download a script starts from a blob is saved too, under a name a file can hold, and a second takes a number', async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  for (const expected of ['tasks-report.csv', 'tasks-report-2.csv']) {
    const waiting = files.download('web', { timeoutMs: 2000, signal })
    assertOk(await click(page, 'export-script'))
    const began = await waiting
    assert.ok(began.ok && began.kind === 'download')
    assert.equal(began.suggestedFilename, 'tasks report.csv')
    const saved = await files.saved(began.download, { timeoutMs: 5000, signal })
    assert.ok(saved.ok && saved.kind === 'saved', JSON.stringify(saved))
    assert.equal(saved.path, join(folder, expected))
    assert.equal(readFileSync(saved.path, 'utf8'), TASKS_CSV)
  }
  assert.deepEqual(events.map((event) => (event.type === 'download' ? event.url : event.type)), ['blob:', 'blob:'])
})

test('a download the server breaks off fails, saying how much arrived, and leaves no file', async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const waiting = files.download('web', { timeoutMs: 2000, signal })
  assertOk(await click(page, 'export-broken'))
  const began = await waiting
  assert.ok(began.ok && began.kind === 'download')
  const saved = await files.saved(began.download, { timeoutMs: 10_000, signal })
  assert.ok(!saved.ok, JSON.stringify(saved))
  assert.equal(saved.failure.class, 'not_actionable')
  assert.match(saved.failure.message, /^The browser stopped the download of broken\.csv after \d+ of 100000 bytes had arrived, and gives no reason\. Retest saved nothing\.$/)
  const [event] = events
  assert.ok(event?.type === 'download' && event.state === 'canceled', JSON.stringify(event))
  assert.equal(event.totalBytes, 100000)
  assert.deepEqual(existsSync(folder) ? readdirSync(folder) : [], [])
})

test('a download nobody waits for is still saved and written down, and one still on its way at the end is unfinished', async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  assertOk(await click(page, 'export'))
  const end = performance.now() + 5000
  while (!existsSync(join(folder, 'tasks.csv')) && performance.now() < end) await delay(20)
  assert.equal(readFileSync(join(folder, 'tasks.csv'), 'utf8'), TASKS_CSV)
  assert.equal(events.length, 1)
  assert.ok(events[0]?.type === 'download' && events[0].state === 'completed' && events[0].awaited === undefined)
  assertOk(await click(page, 'export-broken'))
  await delay(100)
  files.close()
  const unfinished = events.at(-1)
  assert.ok(unfinished?.type === 'download' && unfinished.state === 'unfinished', JSON.stringify(unfinished))
  assert.equal(unfinished.suggestedFilename, 'broken.csv')
  assert.equal(events.length, 2)
})

test('a page opened without a downloads folder refuses downloads, and the refusal names where it ran', async (t) => {
  const { page } = await filesPage(t)
  assert.equal(filesOf(page).onDownload, undefined)
  const answer = await attemptFiles(page, await scratchFolder(t), []).download('web', { timeoutMs: 500, signal: new AbortController().signal })
  assert.deepEqual(answer, { ok: false, failure: { class: 'unsupported', message: 'Retest saves downloads on Chrome and Chromium only, and not on this browser yet, so it waited for none.' } })
})

test('a label finds a file input only through a label the page wrote, never through the browser\'s own button text', async (t) => {
  const { page } = await filesPage(t)
  assert.equal((await observe(page, byLabel('Attachment'))).count, 1)
  assert.equal((await observe(page, byLabel('Choose File'))).count, 0, "Chrome's own name for an unlabelled file input names nothing")
  assert.equal((await observe(page, byLabel('No file chosen'))).count, 0)
  assert.equal((await observe(page, byLabel('Upload', false))).count, 0, 'the hidden input behind the upload button is labelled by nothing')
  assertOk(await goto(page, '/files/sign-in'))
  assert.equal((await observe(page, byLabel('Email'))).count, 1, 'a submit input beside the field changes nothing')
  assert.equal((await observe(page, byLabel('Avatar'))).count, 1)
  assert.equal((await observe(page, byLabel('Sign in'))).count, 0)
})

test('an input whose page clears it once it heard the change still took the files, and the result says what it kept', async (t) => {
  const { page } = await filesPage(t)
  const path = await writeReport(t)
  const given = await give(page, byLabel('Clears'), [path])
  assert.ok(given.ok && given.kind === 'setInputFiles', JSON.stringify(given))
  assert.deepEqual([given.files, given.kept], [[{ name: 'report.pdf', size: report.length, type: 'application/pdf' }], []])
  assert.match(await heard(page), /clears change: report\.pdf 24\n/)
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'clears-button'))
  const caught = await within(arm.opened, 2000, 'the page opened no file picker')
  const chosen = await giveChooser(page, caught.id, [path])
  assert.ok(chosen.ok && chosen.kind === 'setChooserFiles', JSON.stringify(chosen))
  assert.deepEqual([chosen.files, chosen.kept], [[{ name: 'report.pdf', size: report.length, type: 'application/pdf' }], []])
})

test('a caught picker of a frame inside the page is read in Retest\'s world of that frame, whatever the page says its files are', async (t) => {
  const { page } = await filesPage(t)
  assertOk(await goto(page, '/files/framed'))
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'framed-upload'))
  const caught = await within(arm.opened, 2000, 'the frame opened no file picker')
  const given = await giveChooser(page, caught.id, [await writeReport(t)])
  assert.ok(given.ok && given.kind === 'setChooserFiles', JSON.stringify(given))
  assert.deepEqual(given.files, [{ name: 'report.pdf', size: report.length, type: 'application/pdf' }])
  assert.equal(given.kept, undefined, 'the frame\'s own empty answer for files is not what the input holds')
})

test('a download a target=_blank link starts in a new tab is the page\'s, saved and recorded as begun in a page it opened', async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const waiting = files.download('web', { timeoutMs: 3000, signal })
  assertOk(await click(page, 'export-new-tab'))
  const began = await waiting
  assert.deepEqual(began, { ok: true, kind: 'download', download: 'download-1', suggestedFilename: 'tasks.csv' })
  assert.deepEqual(await files.saved('download-1', { timeoutMs: 5000, signal }), { ok: true, kind: 'saved', path: join(folder, 'tasks.csv'), size: Buffer.byteLength(TASKS_CSV) })
  const [event] = await downloadEvents(events, 1)
  assert.deepEqual([event?.state, event?.startedIn, event?.awaited], ['completed', 'popup', true])
})

test('a download a frame of another site starts is the page\'s own, and one from a frame of a page it opened is taken as begun in a popup', async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder)
  const signal = new AbortController().signal
  const framed = files.download('web', { timeoutMs: 3000, signal })
  assertOk(await click(page, 'export-frame'))
  const fromFrame = await framed
  assert.ok(fromFrame.ok && fromFrame.kind === 'download', JSON.stringify(fromFrame))
  assert.ok((await files.saved(fromFrame.download, { timeoutMs: 5000, signal })).ok)
  const [frameEvent] = await downloadEvents(events, 1)
  assert.deepEqual([frameEvent?.state, frameEvent?.startedIn, frameEvent?.awaited], ['completed', undefined, true])
  // The page it opened is held by Retest from its first document, so the frame inside it is known as that page's.
  const opened = files.download('web', { timeoutMs: 3000, signal })
  assertOk(await click(page, 'export-opened'))
  const fromOpened = await opened
  assert.ok(fromOpened.ok && fromOpened.kind === 'download', JSON.stringify(fromOpened))
  assert.ok((await files.saved(fromOpened.download, { timeoutMs: 5000, signal })).ok)
  const [, openedEvent] = await downloadEvents(events, 2)
  assert.deepEqual([openedEvent?.state, openedEvent?.startedIn, openedEvent?.awaited, openedEvent?.path], ['completed', 'popup', true, 'artifacts/attempt1/web/downloads/tasks-2.csv'])
  assert.deepEqual(readdirSync(folder).sort(), ['tasks-2.csv', 'tasks.csv'])
})

test('a download that holds the value of a secret is removed, recorded as withheld, and gives no path', async (t) => {
  const folder = join(await scratchFolder(t), 'downloads')
  const { page } = await filesPage(t, folder)
  const redactor = new Redactor()
  redactor.learn('api-token', 'tok-5f8a2c91e4')
  const events: EventBody[] = []
  const files = attemptFiles(page, folder, events, folder, redactor)
  const signal = new AbortController().signal
  assertOk(await page.execute({ kind: 'fill', locator: byTestId('key-value'), value: 'key=tok-5f8a2c91e4' }, 2000))
  const waiting = files.download('web', { timeoutMs: 3000, signal })
  assertOk(await click(page, 'download-key'))
  const began = await waiting
  assert.ok(began.ok && began.kind === 'download', JSON.stringify(began))
  const saved = await files.saved(began.download, { timeoutMs: 5000, signal })
  assert.deepEqual(saved, { ok: false, failure: { class: 'unsupported', message: 'Retest did not keep the download of key.txt: it holds the value of a secret, and a secret never reaches a file of the run. Retest removed the file.', details: { download: 'key.txt' } } })
  assert.deepEqual(readdirSync(folder), [])
  const [event] = await downloadEvents(events, 1)
  assert.deepEqual([event?.state, event?.path, event?.failure?.class], ['withheld', undefined, 'unsupported'])
})

test('an agent session told of a picker nobody waited for says the session cannot give a page files', async (t) => {
  const app = await openApp(t)
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: app.url })
  assert.ok((await session.act({ kind: 'goto', url: '/files' })).result.ok)
  const { result } = await session.act({ kind: 'click', locator: byTestId('upload-button') })
  assert.ok(!result.ok)
  assert.equal(result.failure.message, "The page opened a file picker as Retest went to click getByTestId('upload-button'), and nothing was waiting for one. Retest closed the picker. This agent session cannot give a page files.")
})

// The official Electron release the Electron tests use, downloaded outside the repository. On macOS a missing binary
// fails this test; elsewhere Retest has no route to an Electron build yet, so without one given it is skipped by name.
const electronBinary = process.env['RETEST_TEST_ELECTRON'] ?? join(homedir(), 'Library/Caches/retest-proofs/electron/44.5.1/dist/Electron.app/Contents/MacOS/Electron')
const noElectron = process.platform !== 'darwin' && process.env['RETEST_TEST_ELECTRON'] === undefined ? 'unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build here' : false

test('an Electron window takes files by label and through a caught picker, as a Chrome page does, and saves no downloads', { skip: noElectron }, async (t) => {
  const folder = await scratchFolder(t)
  const appPath = join(folder, 'app')
  mkdirSync(appPath)
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ name: 'retest-files-electron', private: true, main: 'main.mjs' }))
  writeFileSync(join(appPath, 'main.mjs'), ELECTRON_FILES_MAIN)
  writeFileSync(join(appPath, 'index.html'), ELECTRON_FILES_PAGE)
  const electron = await launchElectron({ executablePath: electronBinary, appPath, args: [], windowsFile: join(folder, 'windows.json'), logFile: join(folder, 'electron.log'), app: 'desk', target: 'electron', launch: 1 })
  t.after(() => electron.close(5000))
  const page = await electron.newPage({}, 10_000)
  const path = await writeReport(t)
  await observeUntil(page, 'attachment', (observation) => observation.count === 1)
  const given = await give(page, byLabel('Attachment'), [path])
  assert.ok(given.ok && given.kind === 'setInputFiles', JSON.stringify(given))
  assert.deepEqual(given.files, [{ name: 'report.pdf', size: report.length, type: 'application/pdf' }])
  const arm = filesOf(page).armFileChooser()
  assertOk(await click(page, 'upload-button'))
  const caught = await within(arm.opened, 2000, 'the Electron window opened no file picker')
  assertOk(await giveChooser(page, caught.id, [path]))
  assert.equal(await heard(page), `attachment change report.pdf ${report.length}\nhidden-upload change report.pdf ${report.length}\n`)
  assert.equal(filesOf(page).onDownload, undefined)
})
