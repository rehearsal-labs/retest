import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { TASKS_CSV } from '../../fixtures/task-app/files-page.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { firefoxHostSkip, firefoxPath, testFirefoxRoute } from './engines.ts'

// Uploads, the file picker, downloads and popups through a whole run on Firefox 158: a test file takes them as it does
// on Chrome, and the events and the run folder say what happened. Elements are found by test id, since Firefox refuses
// a button looked up by its role on the files page (docs/compatibility/firefox.md, item 6).

const skip = firefoxHostSkip()

const names = {
  flow: 'uploads by path, by content and through a picker, then downloads a CSV',
  picker: 'a picker nobody waited for fails the click that opened it',
  broken: 'a download the server breaks off fails path()',
  popup: 'a popup is handed over, driven and closed',
  closing: 'a popup that closes itself refuses the next command',
} as const

const tests = (received: string) => `import { readFile } from 'node:fs/promises'
import { expect, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(names.flow)}, async ({ page }) => {
  await page.goto('/files')
  await page.getByLabel('Attachment').setInputFiles('../fixtures/report.pdf')
  await page.getByLabel('Photos').setInputFiles(['../fixtures/a.png', '../fixtures/b.png'])
  await page.getByLabel('Notes').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', content: 'hello' })
  const chooser = await page.fileChooser(() => page.getByTestId('upload-button').click())
  expect(chooser.multiple).toBe(false)
  await chooser.setFiles('../fixtures/report.pdf')
  await page.getByTestId('send').click()
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
  const download = await page.download(() => page.getByTestId('export').click())
  expect(download.suggestedFilename).toBe('tasks.csv')
  expect(await readFile(await download.path(), 'utf8')).toBe(${JSON.stringify(TASKS_CSV)})
  await download.saveAs('../out/tasks.csv')
})

test(${JSON.stringify(names.picker)}, async ({ page }) => {
  await page.goto('/files')
  await page.getByTestId('upload-button').click()
})

test(${JSON.stringify(names.broken)}, async ({ page }) => {
  await page.goto('/files')
  const download = await page.download(() => page.getByTestId('export-broken').click())
  await download.path()
})

test(${JSON.stringify(names.popup)}, async ({ page }) => {
  await page.goto('/popups')
  const terms = await page.popup(() => page.getByTestId('terms').click())
  await expect(terms.getByTestId('email')).toBeVisible()
  await terms.getByTestId('email').fill('alice@example.com')
  await terms.getByTestId('save').click()
  await expect(terms.getByTestId('saved')).toHaveText('Saved alice@example.com')
  await terms.close()
  await expect(page.getByTestId('status')).toHaveText('Ready')
})

test(${JSON.stringify(names.closing)}, async ({ page }) => {
  await page.goto('/popups')
  const closing = await page.popup(() => page.getByTestId('flash').click())
  await expect(page.getByTestId('status')).toHaveText('Popup closed')
  await closing.getByTestId('anything').click()
})
`

test('a Firefox run uploads, catches a picker, keeps downloads and drives a popup, and its events say so', { skip }, async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: { browser: 'firefox', executablePath: ${JSON.stringify(firefoxPath())}, baseUrl: ${JSON.stringify(app.url)} } } }`),
    'tests/files.retest.ts': tests(`${app.url}/files/received`),
    'fixtures/report.pdf': '%PDF-1.4 a small report\n',
    'fixtures/a.png': 'first picture',
    'fixtures/b.png': 'second',
  })
  const run = await runProject(t, root, { env: { RETEST_FIREFOX_ROUTE: testFirefoxRoute() }, timeouts: budgets({ assertion: 3000, action: defaultTimeouts.action }) })
  assert.equal(run.exit.code, 1, run.stderr)

  const flow = testNamed(run, names.flow)
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
  assert.equal(existsSync(join(run.output, 'uploads')), false, 'the files written for inputs went with their attempts')

  const picker = testNamed(run, names.picker)
  assert.deepEqual([picker.status, picker.failure?.class, picker.failure?.message], ['failed', 'not_actionable', "The page opened a file picker as Retest went to click getByTestId('upload-button'), and nothing was waiting for one. Retest closed the picker. To give a picker files, wrap the action that opens it in page.fileChooser(), or call setInputFiles() on the file input."])

  const broken = testNamed(run, names.broken)
  assert.deepEqual([broken.status, broken.failure?.message], ['failed', 'The browser stopped the download of broken.csv, and says neither why nor how much of it had arrived. Retest saved nothing.'])
  const stopped = downloads.find((event) => event.testId === broken.testId)
  assert.deepEqual([stopped?.state, stopped?.receivedBytes, stopped?.totalBytes], ['canceled', undefined, undefined])

  const popup = testNamed(run, names.popup)
  assert.equal(popup.status, 'passed', JSON.stringify(popup.failure))
  const opened = eventsOf(run.events, 'popup.opened').filter((event) => event.testId === popup.testId)
  assert.deepEqual(opened.map((event) => [event.session, event.popup, new URL(event.url).pathname, event.title]), [['web', 'web/popup-1', '/popups/terms', 'Terms']])
  const onPopup = eventsOf(run.events, 'action.completed').filter((event) => event.testId === popup.testId && event.sessionId === opened[0]?.popupSessionId).map((event) => event.command)
  assert.deepEqual(onPopup, ['fill', 'click', 'close'])
  assert.deepEqual(eventsOf(run.events, 'popup.closed').filter((event) => event.testId === popup.testId), [], 'a popup the test closed is not told as closing itself')

  const closing = testNamed(run, names.closing)
  assert.deepEqual([closing.status, closing.failure?.class, closing.failure?.message], ['failed', 'not_actionable', 'This page closed itself, so Retest sent nothing to it.'])
  assert.deepEqual(eventsOf(run.events, 'popup.closed').filter((event) => event.testId === closing.testId).map((event) => event.session), ['web/popup-1'])
})
