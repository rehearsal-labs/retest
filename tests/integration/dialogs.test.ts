import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, inspectJson, runCli, runProject, testNamed, writeFiles, writeProject } from './cli-harness.ts'

// JavaScript dialogs through `retest run`, on Chrome: each kind answered by the test, two in a row, a beforeunload from
// a goto, a dialog nothing waited for, a wait that sees none, and a dialog that shows a secret. The events, the HTML
// report and `inspect` say what each dialog was and who answered it.

const password = 'dialog-secret-3f9a1c'

// The test's file, which signals the task app at `appUrl` to open a dialog while nothing runs.
const testsFor = (appUrl: string): string => `import { expect, secret, test } from '@rehearsal-labs/retest'

test('accepts a confirm', async ({ page }) => {
  await page.goto('/dialogs')
  const dialog = await page.dialog(() => page.getByTestId('confirm').click())
  expect([dialog.type, dialog.message, dialog.defaultValue]).toEqual(['confirm', 'Delete this task?', ''])
  await dialog.accept()
  await expect(page.getByRole('status')).toHaveText('Deleted')
})

test('dismisses a confirm', async ({ page }) => {
  await page.goto('/dialogs')
  const dialog = await page.dialog(() => page.getByTestId('confirm').click())
  await dialog.dismiss()
  await expect(page.getByRole('status')).toHaveText('Kept')
})

test('answers a prompt', async ({ page }) => {
  await page.goto('/dialogs')
  const dialog = await page.dialog(() => page.getByRole('button', { name: 'Rename' }).click())
  expect([dialog.type, dialog.message, dialog.defaultValue]).toEqual(['prompt', 'New name?', 'Release checklist'])
  await dialog.accept('Grace')
  await expect(page.getByRole('status')).toHaveText('Renamed to Grace')
})

test('accepts an alert', async ({ page }) => {
  await page.goto('/dialogs')
  const dialog = await page.dialog(() => page.getByRole('button', { name: 'Save' }).click())
  expect([dialog.type, dialog.message]).toEqual(['alert', 'Saved the task'])
  await dialog.accept()
  await expect(page.getByRole('status')).toHaveText('Alerted')
})

test('answers two dialogs in a row', async ({ page }) => {
  await page.goto('/dialogs')
  const first = await page.dialog(() => page.getByTestId('two').click())
  const second = await page.dialog(() => first.accept())
  expect([first.message, second.type, second.message]).toEqual(['First of two', 'confirm', 'Second of two?'])
  await second.dismiss()
  await expect(page.getByRole('status')).toHaveText('Second dismissed')
})

test('leaves through a beforeunload dialog', async ({ page }) => {
  await page.goto('/dialogs')
  await page.getByTestId('guard').check()
  const dialog = await page.dialog(() => page.goto('/dialogs/next'))
  expect(dialog.type).toBe('beforeunload')
  await dialog.accept()
  await expect(page.getByTestId('arrived')).toHaveText('Arrived')
})

test('shows a secret in a dialog only as its name', async ({ page }) => {
  await page.goto('/dialogs')
  await page.getByTestId('secret').fill(secret('password'))
  const dialog = await page.dialog(() => page.getByTestId('echo').click())
  expect(dialog.message).toBe('You typed {{password}}')
  await dialog.accept()
  await expect(page.getByRole('status')).toHaveText('Ready')
})

test('a dialog nothing waited for fails its click, and the page goes on', async ({ page }) => {
  await page.goto('/dialogs')
  await page.getByTestId('confirm').click().catch(() => undefined)
  await expect(page.getByRole('status')).toHaveText('Kept')
})

test('a dialog that opens while nothing runs fails the test', async ({ page }) => {
  await page.goto('/dialogs')
  await page.getByTestId('later').click()
  await expect(page.getByRole('status')).toHaveText('Waiting for the signal')
  await signalAlert()
  await expect(page.getByRole('status')).toHaveText('After the alert')
})

test('a wait that sees no dialog fails', async ({ page }) => {
  await page.goto('/dialogs')
  await page.dialog(() => page.getByRole('heading', { name: 'Dialogs' }).click(), { timeout: 500 })
})

test('a dialog left open fails the test', async ({ page }) => {
  await page.goto('/dialogs')
  const dialog = await page.dialog(() => page.getByTestId('confirm').click())
  expect(dialog.type).toBe('confirm')
})

// Opens the alert the later button waits for, now, and returns once the page says it was answered.
async function signalAlert() {
  const alerted = async () => Number(await (await fetch(${JSON.stringify(appUrl)} + '/dialogs/alerted')).text())
  const before = await alerted()
  await fetch(${JSON.stringify(appUrl)} + '/dialogs/signal', { method: 'POST' })
  while ((await alerted()) === before) await new Promise((resolve) => setTimeout(resolve, 20))
}
`

test('dialogs are handed to the test, answered, written down, and a dialog nothing waited for fails its test', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) }, secrets: { password: env('RETEST_DIALOG_PASSWORD') } }`),
    'tests/dialogs.retest.ts': testsFor(app.url),
  })
  const run = await runProject(t, root, { timeouts: budgets({ action: 3000, assertion: 2000 }), env: { RETEST_DIALOG_PASSWORD: password } })
  assert.equal(run.exit.code, 1, run.stderr)

  for (const name of ['accepts a confirm', 'dismisses a confirm', 'answers a prompt', 'accepts an alert', 'answers two dialogs in a row', 'leaves through a beforeunload dialog', 'shows a secret in a dialog only as its name']) {
    const found = testNamed(run, name)
    assert.deepEqual([found.status, found.failure?.message ?? null], ['passed', null], name)
  }
  const dialogsOf = (name: string) => eventsOf(run.events, 'dialog').filter((event) => event.testId === testNamed(run, name).testId)
  const written = (name: string) => dialogsOf(name).map(({ session, dialog, message, answer, by, typed }) => ({ session, dialog, message, answer, by, ...(typed === undefined ? {} : { typed }) }))
  assert.deepEqual(written('accepts a confirm'), [{ session: 'web', dialog: 'confirm', message: 'Delete this task?', answer: 'accepted', by: 'test' }])
  assert.deepEqual(written('dismisses a confirm'), [{ session: 'web', dialog: 'confirm', message: 'Delete this task?', answer: 'dismissed', by: 'test' }])
  assert.deepEqual(written('answers a prompt'), [{ session: 'web', dialog: 'prompt', message: 'New name?', answer: 'accepted', by: 'test', typed: 5 }])
  assert.deepEqual(written('answers two dialogs in a row'), [
    { session: 'web', dialog: 'alert', message: 'First of two', answer: 'accepted', by: 'test' },
    { session: 'web', dialog: 'confirm', message: 'Second of two?', answer: 'dismissed', by: 'test' },
  ])
  assert.deepEqual(written('leaves through a beforeunload dialog'), [{ session: 'web', dialog: 'beforeunload', message: '', answer: 'accepted', by: 'test' }])
  assert.deepEqual(written('shows a secret in a dialog only as its name'), [{ session: 'web', dialog: 'alert', message: 'You typed {{password}}', answer: 'accepted', by: 'test' }])
  // Each answer is a step at the line that answered it, and the click it let finish passed after it.
  const accepted = dialogsOf('accepts a confirm')[0]
  assert.equal(accepted?.location?.line, 7)
  const clicks = eventsOf(run.events, 'action.completed').filter((event) => event.testId === testNamed(run, 'accepts a confirm').testId && event.command === 'click')
  assert.equal(clicks.length, 1)
  assert.ok((clicks[0]?.sequence ?? 0) > (accepted?.sequence ?? Infinity), 'the click completes after its dialog is answered')

  const unwaited = testNamed(run, 'a dialog nothing waited for fails its click, and the page goes on')
  assert.deepEqual([unwaited.status, unwaited.failure?.class], ['failed', 'not_actionable'])
  assert.equal(unwaited.failure?.message, "The page opened a confirm dialog that says \"Delete this task?\" while Retest tried to click getByTestId('confirm'). Retest dismissed it. To answer it, wrap the action in page.dialog().")
  assert.deepEqual(unwaited.failure?.details, { dialog: 'confirm', answered: 'dismissed', inputSent: true })
  assert.deepEqual(written(unwaited.name), [{ session: 'web', dialog: 'confirm', message: 'Delete this task?', answer: 'dismissed', by: 'retest' }])
  assert.equal(eventsOf(run.events, 'assertion.passed').filter((event) => event.testId === unwaited.testId).length, 1, 'the check after the dismissed dialog passed')

  const timer = testNamed(run, 'a dialog that opens while nothing runs fails the test')
  assert.deepEqual([timer.status, timer.failure?.class], ['failed', 'not_actionable'])
  assert.equal(timer.failure?.message, 'The page opened an alert dialog that says "Later" while no action was running. Retest dismissed it. To answer it, wrap the action that opens it in page.dialog().')
  assert.deepEqual(written(timer.name), [{ session: 'web', dialog: 'alert', message: 'Later', answer: 'dismissed', by: 'retest' }])

  const unseen = testNamed(run, 'a wait that sees no dialog fails')
  assert.deepEqual([unseen.status, unseen.failure?.class, unseen.failure?.message], ['failed', 'timeout', 'No dialog opened within 500 ms.'])
  assert.equal(unseen.failure?.location?.line, 77)

  const left = testNamed(run, 'a dialog left open fails the test')
  assert.deepEqual([left.status, left.failure?.class], ['failed', 'not_awaited'])
  assert.equal(left.failure?.message, 'The confirm dialog page.dialog() gave on line 82 was still open when the test returned. Answer it with dialog.accept() or dialog.dismiss().')
  assert.deepEqual(written(left.name), [{ session: 'web', dialog: 'confirm', message: 'Delete this task?', answer: 'dismissed', by: 'retest' }])
  // The dialog was dismissed before the failure screenshot, which a dialog would have held.
  assert.equal(eventsOf(run.events, 'evidence.captured').filter((event) => event.testId === left.testId).length, 1)

  // The secret never reached the run folder: not in the dialog's text, its events, or the report.
  assert.deepEqual(filesHolding(run.output, password), [])

  const report = await runCli(t, ['report', run.output])
  assert.equal(report.exit.code, 0, report.stderr)
  const html = await readFile(join(run.output, 'report.html'), 'utf8')
  assert.ok(html.includes('confirm &quot;Delete this task?&quot; accepted'), 'the report shows the dialog the test accepted')
  assert.ok(html.includes('confirm &quot;Delete this task?&quot; dismissed by Retest'), 'the report shows the dialog Retest dismissed')
  const inspected = await runCli(t, ['inspect', run.output, '--test', 'tests/dialogs.retest.ts > answers a prompt'])
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.match(inspected.stdout, /prompt "New name\?" accepted with 5 characters/)
  const { result } = await inspectJson(t, run.output)
  assert.equal(result.counts.failed, 4)
})

// The official Electron release the Electron tests use, downloaded outside the repository. On macOS a missing binary
// fails this test; elsewhere Retest has no route to an Electron build yet, so without one given it is skipped by name.
const electronBinary = process.env['RETEST_TEST_ELECTRON'] ?? join(homedir(), 'Library/Caches/retest-proofs/electron/44.5.1/dist/Electron.app/Contents/MacOS/Electron')
const noElectron = process.platform !== 'darwin' && process.env['RETEST_TEST_ELECTRON'] === undefined ? 'unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build here' : false

// An app whose window shows an alert as its page loads, before any test can ask for anything.
const STARTUP_MAIN = `import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 640, height: 480 })
  void window.loadFile(fileURLToPath(new URL('./index.html', import.meta.url)))
})
app.on('window-all-closed', () => app.quit())
`
const STARTUP_PAGE = `<!doctype html><meta charset="utf-8"><title>Desk</title>
<p data-testid="status">Starting</p>
<script>alert('Welcome back'); document.querySelector('[data-testid=status]').textContent = 'After the alert'</script>`

test("an Electron app's alert at start, answered before the test's first command, is written down and fails nothing", { skip: noElectron }, async (t) => {
  const root = await writeProject(t, {
    'app/package.json': JSON.stringify({ name: 'retest-startup-alert', private: true, main: 'main.mjs' }),
    'app/main.mjs': STARTUP_MAIN,
    'app/index.html': STARTUP_PAGE,
    'tests/start.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('starts past its alert', async ({ page }) => {
  await expect(page.getByTestId('status')).toHaveText('After the alert')
})
`,
  })
  await writeFiles(root, { 'retest.config.ts': `import { defineConfig, electron } from '@rehearsal-labs/retest'\n\nexport default defineConfig({ apps: { desk: electron({ executablePath: ${JSON.stringify(electronBinary)}, appPath: ${JSON.stringify(join(root, 'app'))} }) } })\n` })
  const run = await runProject(t, root, { timeouts: budgets({ action: 5000, assertion: 5000 }) })
  assert.equal(run.exit.code, 0, run.stderr)
  const started = testNamed(run, 'starts past its alert')
  assert.deepEqual([started.status, started.failure ?? null], ['passed', null])
  assert.deepEqual(eventsOf(run.events, 'dialog').map((event) => [event.session, event.dialog, event.message, event.answer, event.by]), [['desk', 'alert', 'Welcome back', 'dismissed', 'retest']])
})
