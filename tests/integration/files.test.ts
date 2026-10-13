import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ELECTRON_FILES_MAIN, ELECTRON_FILES_PAGE, TASKS_CSV } from '../../fixtures/task-app/files-page.ts'
import { resultFile } from '../../src/protocol/run-folder.ts'
import { eventArtifactReferences, inventoryArtifacts, resultArtifactReferences } from '../../src/store/artifacts.ts'
import { browserPath } from '../support/test-browser.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, readResult, resultOf, runCli, runProject, scratchFolder, testNamed, writeFiles, writeProject } from './cli-harness.ts'
import { firefoxPath, testFirefoxRoute, webKitPath } from './engines.ts'

// Files through a whole run: a test file uploads by path and by content, catches a file picker, and waits for downloads,
// against the task app's files page on Chrome. The events record each step, the run folder keeps each download where its
// event says, the HTML report links to it, and a failing test's report still shows what it downloaded.

const names = {
  flow: 'uploads by path, by content and through a picker, then downloads a CSV',
  failing: 'a test that downloads and then fails keeps its download in the report',
  picker: 'a picker nobody waited for fails the click that opened it',
  broken: 'a download the server breaks off fails path()',
  missing: 'a path with no file fails usage, naming the path',
  nothing: 'an action that starts no download fails page.download() when its time runs out',
} as const

const tests = (received: string) => `import { readFile } from 'node:fs/promises'
import { expect, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(names.flow)}, async ({ page }) => {
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

test(${JSON.stringify(names.failing)}, async ({ page }) => {
  await page.goto('/files')
  const download = await page.download(() => page.getByTestId('export-script').click())
  expect(download.suggestedFilename).toBe('tasks report.csv')
  await download.path()
  await expect(page.getByTestId('heard')).toHaveText('a line the page never shows', { timeout: 300 })
})

test(${JSON.stringify(names.picker)}, async ({ page }) => {
  await page.goto('/files')
  await page.getByRole('button', { name: 'Upload' }).click()
})

test(${JSON.stringify(names.broken)}, async ({ page }) => {
  await page.goto('/files')
  const download = await page.download(() => page.getByTestId('export-broken').click())
  await download.path()
})

test(${JSON.stringify(names.missing)}, async ({ page }) => {
  await page.goto('/files')
  await page.getByLabel('Attachment').setInputFiles('../fixtures/missing.pdf')
})

test(${JSON.stringify(names.nothing)}, async ({ page }) => {
  await page.goto('/files')
  await page.download(() => page.getByTestId('add-photos').scroll({ y: 10 }), { timeout: 400 })
})
`

test('a run uploads, catches a picker and keeps downloads, and its events and report say so', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chromium({ executablePath: ${JSON.stringify(browserPath())}, baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/files.retest.ts': tests(`${app.url}/files/received`),
    'fixtures/report.pdf': '%PDF-1.4 a small report\n',
    'fixtures/a.png': 'first picture',
    'fixtures/b.png': 'second',
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 2000 }) })
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
  assert.equal(flowDownload.suggestedFilename, 'tasks.csv')
  assert.equal(flowDownload.awaited, true)
  assert.equal(flowDownload.url, `${app.url}/files/tasks.csv`)
  assert.equal(flowDownload.size, Buffer.byteLength(TASKS_CSV))
  assert.match(flowDownload.path ?? '', /^artifacts\/[a-z0-9]+\/web-[a-z0-9]+\/downloads\/tasks\.csv$/)
  assert.equal(readFileSync(join(run.output, flowDownload.path ?? ''), 'utf8'), TASKS_CSV)

  const failing = testNamed(run, names.failing)
  assert.equal(failing.status, 'failed')
  const kept = downloads.find((event) => event.testId === failing.testId)
  assert.ok(kept?.state === 'completed' && kept.path !== undefined, JSON.stringify(kept))
  assert.match(kept.path, /\/downloads\/tasks-report\.csv$/)

  const picker = testNamed(run, names.picker)
  assert.equal(picker.status, 'failed')
  assert.equal(picker.failure?.class, 'not_actionable')
  assert.equal(picker.failure?.message, "The page opened a file picker as Retest went to click getByRole('button', { name: 'Upload' }), and nothing was waiting for one. Retest closed the picker. To give a picker files, wrap the action that opens it in page.fileChooser(), or call setInputFiles() on the file input.")

  const broken = testNamed(run, names.broken)
  assert.equal(broken.status, 'failed')
  assert.match(broken.failure?.message ?? '', /^The browser stopped the download of broken\.csv after \d+ of 100000 bytes had arrived, and gives no reason\. Retest saved nothing\.$/)
  assert.ok(downloads.some((event) => event.testId === broken.testId && event.state === 'canceled'))

  const missing = testNamed(run, names.missing)
  assert.equal(missing.failure?.class, 'usage')
  assert.equal(missing.failure?.message, `setInputFiles() found no file at ${join(realpathSync(root), 'fixtures', 'missing.pdf')}.`)

  const nothing = testNamed(run, names.nothing)
  assert.equal(nothing.failure?.class, 'timeout')
  assert.equal(nothing.failure?.message, 'No download began within 400 ms of page.download(). Check that its action starts one, as a link to a file does.')

  // Every download a test kept is named by its event, so nothing in the run folder is a file no record names.
  const result = resultOf(run)
  const inventory = inventoryArtifacts(run.output, [...eventArtifactReferences(run.events), ...resultArtifactReferences(result)])
  const named = inventory.present.filter((file) => file.namedBy.includes('download')).map((file) => file.reference)
  assert.deepEqual(named.sort(), downloads.flatMap((event) => (event.path === undefined ? [] : [event.path])).sort())
  assert.deepEqual(inventory.unreferenced.filter((file) => file.reference.includes('/downloads/')), [])
  assert.equal(existsSync(join(run.output, 'uploads')), false, 'the files written for inputs went with their attempts')

  const reported = await runCli(t, ['report', run.output])
  assert.equal(reported.exit.code, 0, reported.stderr)
  const html = readFileSync(join(run.output, 'report.html'), 'utf8')
  assert.ok(html.includes(`<a href="${flowDownload.path}" download><code>${flowDownload.path}</code></a> · download tasks.csv, ${Buffer.byteLength(TASKS_CSV)} bytes`), 'the report links the download a passing test kept')
  assert.ok(html.includes(`<a href="${kept.path}" download><code>${kept.path}</code></a> · download tasks report.csv`), 'the report of a failing test still links what it downloaded')
  assert.match(html, /download broken\.csv stopped after \d+ of 100000 bytes/)
})

const engineTests = `import { expect, test } from '@rehearsal-labs/retest'

for (const app of ['fox', 'kit']) {
  test(app + ' finds a field by its label beside a submit input, and a file input by its label alone', { apps: [app] }, async (pages) => {
    const page = pages[app]
    await page.goto('/files/sign-in')
    await page.getByLabel('Email').fill('ada@example.com')
    await expect(page.getByLabel('Email')).toHaveValue('ada@example.com')
    await expect(page.getByLabel('Avatar')).toHaveCount(1)
    await expect(page.getByLabel('Choose File')).toHaveCount(0)
    await expect(page.getByLabel('Browse…')).toHaveCount(0)
  })

  test(app + ' gives no input files', { apps: [app] }, async (pages) => {
    const page = pages[app]
    await page.goto('/files')
    await page.getByLabel('Attachment').setInputFiles({ name: 'notes.txt', content: 'hello' })
  })

  test(app + ' catches no picker', { apps: [app] }, async (pages) => {
    const page = pages[app]
    await page.goto('/files')
    await page.fileChooser(() => page.getByTestId('send').hover())
  })

  test(app + ' saves no download', { apps: [app] }, async (pages) => {
    const page = pages[app]
    await page.goto('/files')
    await page.download(() => page.getByTestId('send').hover())
  })
}
`

test('Firefox and WebKit refuse uploads, the picker and downloads, each naming the engine', async (t) => {
  const app = await openApp(t)
  const baseUrl = JSON.stringify(app.url)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { fox: { browser: 'firefox', executablePath: ${JSON.stringify(firefoxPath())}, baseUrl: ${baseUrl} }, kit: { browser: 'webkit', executablePath: ${JSON.stringify(webKitPath())}, baseUrl: ${baseUrl} } } }`),
    'tests/engines.retest.ts': engineTests,
  })
  const run = await runProject(t, root, { env: { RETEST_FIREFOX_ROUTE: testFirefoxRoute() } })
  for (const [app, engine] of [['fox', 'Firefox'], ['kit', 'WebKit']] as const) {
    const refused = (name: string) => {
      const result = testNamed(run, `${app} ${name}`)
      return [result.status, result.failure?.class, result.failure?.message]
    }
    assert.deepEqual(refused('gives no input files'), ['error', 'unsupported', `Retest gives a file input files on Chrome and Chromium only, and not on ${engine} yet, so it gave none.`])
    assert.deepEqual(refused('catches no picker'), ['error', 'unsupported', `Retest catches a file picker on Chrome and Chromium only, and not on ${engine} yet, so it waited for none.`])
    assert.deepEqual(refused('saves no download'), ['error', 'unsupported', `Retest saves downloads on Chrome and Chromium only, and not on ${engine} yet, so it waited for none.`])
    const labelled = testNamed(run, `${app} finds a field by its label beside a submit input, and a file input by its label alone`)
    assert.equal(labelled.status, 'passed', JSON.stringify(labelled.failure))
  }
  assert.deepEqual(eventsOf(run.events, 'download'), [])
  assert.equal(run.exit.code, 2, run.stderr)
})

const secretTests = `import { secret, test } from '@rehearsal-labs/retest'

test('a download that holds a secret is not kept', async ({ page }) => {
  await page.goto('/files')
  await page.getByLabel('Key').fill(secret('token'))
  const download = await page.download(() => page.getByTestId('download-key').click())
  await download.path()
})
`

test('a download that holds the value of a secret is removed, recorded as withheld, and fails path() by name', async (t) => {
  const app = await openApp(t)
  const token = 'tok-5f8a2c91e4-files'
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chromium({ executablePath: ${JSON.stringify(browserPath())}, baseUrl: ${JSON.stringify(app.url)} }) }, secrets: { token: env('RETEST_FILES_TOKEN') } }`),
    'tests/secret.retest.ts': secretTests,
  })
  const run = await runProject(t, root, { env: { RETEST_FILES_TOKEN: token } })
  const withheld = testNamed(run, 'a download that holds a secret is not kept')
  assert.deepEqual([withheld.status, withheld.failure?.class, withheld.failure?.message], ['error', 'unsupported', 'Retest did not keep the download of key.txt: it holds the value of a secret, and a secret never reaches a file of the run. Retest removed the file.'])
  const downloads = eventsOf(run.events, 'download')
  assert.deepEqual(downloads.map((event) => [event.suggestedFilename, event.state, event.path, event.failure?.class]), [['key.txt', 'withheld', undefined, 'unsupported']])
  assert.deepEqual(filesHolding(run.output, token), [], 'the secret reached no file of the run folder')
  assert.equal(run.exit.code, 2, run.stderr)
})

const playwrightSpec = `import { test } from '@playwright/test'

test('a picker nobody waited for fails its click', async ({ page }) => {
  await page.goto('/files')
  await page.getByTestId('upload-button').click()
})

test('setInputFiles is refused by name', async ({ page }) => {
  await page.goto('/files')
  await page.getByLabel('Attachment').setInputFiles('report.pdf')
})
`

// Playwright reads an upload's path against the folder it runs in, and Retest against the test file's, so the
// compatibility refuses setInputFiles by name, and a picker it closes says the compatibility gives no files.
test('a Playwright test file is told a picker was closed and that its uploads are not supported yet', async (t) => {
  const app = await openApp(t)
  const root = await scratchFolder(t, 'retest-playwright-')
  await writeFiles(root, { 'tests/files.spec.ts': playwrightSpec, 'tests/report.pdf': '%PDF-1.4 a small report\n' })
  const output = join(await scratchFolder(t), 'run')
  const run = await runCli(t, ['run', '--playwright', '--browser', browserPath(), '--base-url', app.url, '--no-agent', '--output', output], { cwd: root })
  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  const result = readResult(readFileSync(join(output, resultFile), 'utf8'))
  const tests = result.files.flatMap((file) => file.tests)
  assert.deepEqual(tests.map((each) => [each.name, each.status, each.failure?.class, each.failure?.message]), [
    ['a picker nobody waited for fails its click', 'failed', 'not_actionable', "The page opened a file picker as Retest went to click getByTestId('upload-button'), and nothing was waiting for one. Retest closed the picker. Retest's Playwright compatibility cannot give a page files yet."],
    ['setInputFiles is refused by name', 'error', 'unsupported', "locator.setInputFiles is not supported yet by Retest's Playwright compatibility. Retest reads a path against the test file's folder, and Playwright against the folder it runs in, so a Playwright test file gives no file input files yet."],
  ])
})

// The official Electron release the Electron tests use, downloaded outside the repository. On macOS a missing binary
// fails this test; elsewhere Retest has no route to an Electron build yet, so without one given it is skipped by name.
const electronBinary = process.env['RETEST_TEST_ELECTRON'] ?? join(homedir(), 'Library/Caches/retest-proofs/electron/44.5.1/dist/Electron.app/Contents/MacOS/Electron')
const noElectron = process.platform !== 'darwin' && process.env['RETEST_TEST_ELECTRON'] === undefined ? 'unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build here' : false

const electronTests = `import { expect, test } from '@rehearsal-labs/retest'

test('the window takes files by label and through its picker', async ({ page }) => {
  await page.getByLabel('Attachment').setInputFiles({ name: 'notes.txt', content: 'hello' })
  const chooser = await page.fileChooser(() => page.getByRole('button', { name: 'Upload' }).click())
  await chooser.setFiles({ name: 'b.txt', content: 'hi' })
  await expect(page.getByTestId('heard')).toHaveText('attachment change notes.txt 5 hidden-upload change b.txt 2')
})

test('the window saves no download', async ({ page }) => {
  await page.download(() => page.getByRole('button', { name: 'Upload' }).hover())
})
`

test('an Electron app takes files through a run and refuses downloads by name', { skip: noElectron }, async (t) => {
  const root = await writeProject(t, {
    'retest.config.ts': `import { defineConfig, electron } from '@rehearsal-labs/retest'\n\nexport default defineConfig({ apps: { desk: electron({ executablePath: ${JSON.stringify(electronBinary)}, appPath: './app' }) } })\n`,
    'app/package.json': JSON.stringify({ name: 'retest-files-electron', private: true, main: 'main.mjs' }),
    'app/main.mjs': ELECTRON_FILES_MAIN,
    'app/index.html': ELECTRON_FILES_PAGE,
    'tests/electron.retest.ts': electronTests,
  })
  const run = await runProject(t, root)
  const taken = testNamed(run, 'the window takes files by label and through its picker')
  assert.equal(taken.status, 'passed', JSON.stringify(taken.failure))
  const refused = testNamed(run, 'the window saves no download')
  assert.deepEqual([refused.status, refused.failure?.class, refused.failure?.message], ['error', 'unsupported', 'Retest saves downloads on Chrome and Chromium only, and not in an Electron app yet, so it waited for none.'])
  assert.equal(run.exit.code, 2, run.stderr)
})
