import type { WindowsRecord } from '../../src/browser/electron.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { slug, targetBrowserLogFile } from '../../src/protocol/run-folder.ts'
import { parse, s } from '../../src/protocol/schema.ts'
import { variantKey } from '../../src/protocol/variant.ts'
import { budgets, eventsOf, filesHolding, repositoryRoot, runProject, testNamed, writeProject } from './cli-harness.ts'

// The windows an Electron app opens after its first, given to a test by page.popup() on a real Electron binary: a window
// the first window's document opens by window.open, one a link with a target opens, a popup of that popup, and a
// BrowserWindow the app's main process makes when the window asks. Each is driven, checked and closed as a page of its
// own, with its own dialog and failure screenshot; a window opened while nothing waited is never handed to a later wait;
// a secret follows the Electron rule there; and every window is recorded with what opened it and the page it became.

// One official Electron release, downloaded outside the repository as the proof record says. Never a dependency.
const electronVersion = '44.5.1'
const givenBinary = process.env['RETEST_TEST_ELECTRON']
const electronBinary = givenBinary ?? join(homedir(), 'Library/Caches/retest-proofs/electron', electronVersion, 'dist/Electron.app/Contents/MacOS/Electron')
// On macOS a missing binary fails these tests. Elsewhere, without one given, they are skipped by name, never in silence.
const unverified =
  process.platform !== 'darwin' && givenBinary === undefined
    ? `unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build on ${process.platform}, so no Electron app was run`
    : false
const fixtureApp = join(repositoryRoot, 'fixtures/electron-windows')
const addressOf = (name: string) => pathToFileURL(join(fixtureApp, 'renderer', name)).href
const password = 'electron-popup-secret-3f9a'

const names = {
  opened: 'drives a window the page opens with window.open, and its own popup',
  linked: 'drives a window a link with a target opens, and Retest closes it',
  main: 'drives a window the main process makes, with its own dialog',
  failed: 'a failed check in a window the main process made',
  unwaited: 'a window opened while nothing waited is not given to a later wait',
  early: 'a window the main process makes before the action reaches the app is not given',
  secret: 'a secret is not typed in a popup window on a file address',
  goto: 'goto in a popup window is refused by name',
} as const

const config = `import { defineConfig, electron, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { desktop: electron({ executablePath: ${JSON.stringify(electronBinary)}, appPath: ${JSON.stringify(fixtureApp)} }) },
  secrets: { password: env('RETEST_ELECTRON_POPUP_PASSWORD') },
})
`

const tests = `import { setTimeout as sleep } from 'node:timers/promises'
import { expect, secret, test } from '@rehearsal-labs/retest'

test(${JSON.stringify(names.opened)}, async ({ page }) => {
  const notes = await page.popup(() => page.getByRole('button', { name: 'Open notes' }).click())
  await expect(notes).toHaveTitle('Notes')
  await expect(notes).toHaveURL(${JSON.stringify(addressOf('notes.html'))})
  await notes.getByLabel('Note').fill('Ship on Friday')
  await notes.getByRole('button', { name: 'Send' }).click()
  await expect(notes.getByTestId('sent')).toHaveText('Sent: Ship on Friday')
  await expect(page.getByTestId('status')).toHaveText('Note: Ship on Friday')
  const help = await notes.popup(() => notes.getByRole('link', { name: 'Help' }).click())
  await expect(help.getByRole('heading', { name: 'Help' })).toBeVisible()
  await help.close()
  await notes.close()
  await expect(page.getByTestId('status')).toHaveText('Notes closed')
})

test(${JSON.stringify(names.linked)}, async ({ page }) => {
  const help = await page.popup(() => page.getByRole('link', { name: 'Help' }).click())
  await expect(help.getByTestId('help-text')).toHaveText('Open settings to change the theme.')
  await expect(help).toHaveTitle('Help')
})

test(${JSON.stringify(names.main)}, async ({ page }) => {
  const settings = await page.popup(() => page.getByRole('button', { name: 'Open settings' }).click())
  await expect(settings).toHaveTitle('Settings')
  await settings.getByLabel('Dark mode').check()
  await settings.getByRole('button', { name: 'Save' }).click()
  await expect(settings.getByTestId('saved')).toHaveText('Saved: dark')
  await expect(page.getByTestId('theme')).toHaveText('Theme: dark')
  const dialog = await settings.dialog(() => settings.getByRole('button', { name: 'Reset' }).click())
  expect([dialog.type, dialog.message]).toEqual(['confirm', 'Reset settings?'])
  await dialog.accept()
  await expect(page.getByTestId('theme')).toHaveText('Theme: light')
  await settings.close()
  await page.getByRole('button', { name: 'Open notes' }).click()
})

test(${JSON.stringify(names.failed)}, async ({ page }) => {
  const settings = await page.popup(() => page.getByRole('button', { name: 'Open settings' }).click())
  await expect(settings.getByTestId('settings-title')).toHaveText('Preferences')
})

test(${JSON.stringify(names.unwaited)}, async ({ page }) => {
  await page.getByRole('button', { name: 'Open settings' }).click()
  await page.getByRole('button', { name: 'Open notes' }).click()
  await sleep(1000)
  const help = await page.popup(() => page.getByRole('link', { name: 'Help' }).click())
  await expect(help).toHaveTitle('Help')
})

test(${JSON.stringify(names.early)}, async ({ page }) => {
  await page.getByRole('button', { name: 'Open settings later' }).click()
  const notes = await page.popup(async () => {
    await sleep(1500)
    await page.getByRole('button', { name: 'Open notes' }).click()
  })
  await expect(notes).toHaveTitle('Notes')
})

test(${JSON.stringify(names.secret)}, async ({ page }) => {
  const notes = await page.popup(() => page.getByRole('button', { name: 'Open notes' }).click())
  await notes.getByLabel('Note').fill(secret('password'))
})

test(${JSON.stringify(names.goto)}, async ({ page }) => {
  const notes = await page.popup(() => page.getByRole('button', { name: 'Open notes' }).click())
  // A type error in a checked test; a caller without types still reaches the refusal.
  await notes.goto('https://example.test/')
})
`

function launchesFolder(run: FinishedRun): string {
  return join(run.output, 'electron', slug(variantKey({ desktop: 'electron' })))
}

const count = s.number({ integer: true, min: 0 })
const windowsSchema = s.object({
  app: s.string(),
  target: s.string(),
  launch: count,
  pid: count,
  windows: s.array(
    s.object({
      window: count,
      reachable: s.boolean(),
      openedMs: count,
      existing: s.optional(s.literal(true)),
      opener: s.optional(count),
      page: s.optional(s.string()),
      closedMs: s.optional(count),
    }),
  ),
  notes: s.optional(s.array(s.string())),
})

// Each launch's windows, as the app's quit wrote them, checked against the shape the driver writes.
function windowsRecords(run: FinishedRun): WindowsRecord[] {
  const folder = launchesFolder(run)
  const records = readdirSync(folder).map((launch) => {
    const file = join(folder, launch, 'windows.json')
    const parsed = parse(windowsSchema, JSON.parse(readFileSync(file, 'utf8')))
    assert.ok(parsed.ok, `${file} holds a windows record: ${parsed.ok ? '' : JSON.stringify(parsed.issues)}`)
    return parsed.value
  })
  return records.sort((first, second) => first.launch - second.launch)
}

function processesNaming(path: string): string {
  try {
    return execFileSync('pgrep', ['-fl', path], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

test("page.popup() gives a test the windows an Electron app opens, from its document or its main process, and closes them", { timeout: 240_000, skip: unverified }, async (t) => {
  assert.ok(
    existsSync(electronBinary),
    `No Electron binary at ${electronBinary}. Unpack the darwin-arm64 release of Electron ${electronVersion} into its dist folder with ditto -x -k, or set RETEST_TEST_ELECTRON to an Electron binary, such as the one retest install electron prints.`,
  )
  const root = await writeProject(t, { 'retest.config.ts': config, 'tests/windows.retest.ts': tests })
  const run = await runProject(t, root, { env: { RETEST_ELECTRON_POPUP_PASSWORD: password }, timeouts: budgets({ action: 5000, assertion: 3000, test: 30_000 }) })
  const outcome = (name: string) => [testNamed(run, name).status, testNamed(run, name).failure?.class ?? null, testNamed(run, name).failure?.message ?? null]
  const outcomes = Object.fromEntries(Object.values(names).map((name) => [name, outcome(name).slice(0, 2)]))
  assert.deepEqual(
    outcomes,
    {
      [names.opened]: ['passed', null],
      [names.linked]: ['passed', null],
      [names.main]: ['passed', null],
      [names.failed]: ['failed', 'check_failed'],
      [names.unwaited]: ['passed', null],
      [names.early]: ['passed', null],
      [names.secret]: ['failed', 'not_actionable'],
      [names.goto]: ['error', 'unsupported'],
    },
    JSON.stringify(Object.fromEntries(Object.values(names).map((name) => [name, outcome(name)])), null, 2),
  )
  assert.equal(run.exit.code, 1, run.stderr)
  const scoped = <T extends { testId: string }>(events: readonly T[], name: string): T[] => events.filter((event) => event.testId === testNamed(run, name).testId)

  // A window the document opened is a page of its own, named after the window that opened it, as is its own popup.
  const opened = testNamed(run, names.opened)
  assert.deepEqual(
    scoped(eventsOf(run.events, 'popup.opened'), opened.name).map((event) => [event.session, event.popup, event.popupSessionId, event.url, event.title]),
    [
      ['desktop', 'desktop/popup-1', `${opened.attemptId}:desktop/popup-1`, addressOf('notes.html'), 'Notes'],
      ['desktop/popup-1', 'desktop/popup-1/popup-1', `${opened.attemptId}:desktop/popup-1/popup-1`, addressOf('help.html'), 'Help'],
    ],
  )
  assert.deepEqual(
    scoped(eventsOf(run.events, 'action.completed'), opened.name).map((event) => [event.session, event.command]),
    [
      ['desktop', 'click'],
      ['desktop/popup-1', 'fill'],
      ['desktop/popup-1', 'click'],
      ['desktop/popup-1', 'click'],
      ['desktop/popup-1/popup-1', 'close'],
      ['desktop/popup-1', 'close'],
    ],
  )
  assert.deepEqual(scoped(eventsOf(run.events, 'popup.closed'), opened.name), [], 'the test closed both windows itself')
  // A popup window is not captured, as a Chrome popup is not, and its record says so.
  const notCaptured = { state: 'unavailable', reason: 'popups are not captured' }
  const popupDiagnostics = (opened.diagnostics ?? []).filter((summary) => !summary.sessionId.endsWith(':desktop'))
  assert.deepEqual(
    popupDiagnostics.map((summary) => [summary.sessionId.slice(summary.sessionId.indexOf(':') + 1), summary.console, summary.network]),
    [
      ['desktop/popup-1', notCaptured, notCaptured],
      ['desktop/popup-1/popup-1', notCaptured, notCaptured],
    ],
  )

  // A window the main process made is given to the wait, and its dialog is the test's to answer.
  const main = testNamed(run, names.main)
  const [settings] = scoped(eventsOf(run.events, 'popup.opened'), main.name)
  assert.deepEqual([settings?.session, settings?.popup, settings?.url, settings?.title], ['desktop', 'desktop/popup-1', addressOf('settings.html'), 'Settings'])
  assert.deepEqual(scoped(eventsOf(run.events, 'dialog'), main.name).map((event) => [event.session, event.dialog, event.message, event.answer, event.by]), [['desktop/popup-1', 'confirm', 'Reset settings?', 'accepted', 'test']])
  // The notes window it opened after the settings window closed, while nothing waited, is no popup of the test.
  assert.equal(scoped(eventsOf(run.events, 'popup.opened'), main.name).length, 1)

  // A failed check in the main process's window pictures that window beside the first, each named by its app.
  const failed = testNamed(run, names.failed)
  assert.deepEqual(scoped(eventsOf(run.events, 'assertion.failed'), failed.name).map((event) => [event.session, event.matcher]), [['desktop/popup-1', 'toHaveText']])
  const pictured = scoped(eventsOf(run.events, 'evidence.captured'), failed.name)
  assert.deepEqual(pictured.map((event) => event.session).sort(), ['desktop', 'desktop/popup-1'])
  for (const picture of pictured) assert.deepEqual([...readFileSync(join(run.output, picture.path)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], picture.path)

  // Windows opened while nothing waited, from the document and from the main process, are not handed to a later wait.
  for (const name of [names.unwaited, names.early]) {
    const popups = scoped(eventsOf(run.events, 'popup.opened'), name)
    assert.deepEqual(popups.map((event) => [event.popup, event.title]), [['desktop/popup-1', name === names.unwaited ? 'Help' : 'Notes']], name)
  }

  // The Electron rule holds in a popup window: no base URL counts, and a file address has no origin.
  assert.match(testNamed(run, names.secret).failure?.message ?? '', /^Retest did not type the secret "password": the window has not opened a web address yet, and in an Electron app it may be typed only on an origin secretOrigins lists for it/)
  assert.deepEqual(filesHolding(run.output, password), [])
  assert.match(testNamed(run, names.goto).failure?.message ?? '', /^goto\(\) is not available on a window of the Electron app desktop \(target electron\): the app has no address/)

  // Every window is recorded with the window that opened it, or none for the main process's, and the page it became.
  const records = windowsRecords(run)
  assert.equal(records.length, Object.keys(names).length, 'each test launched the app once')
  const windowsOf = (index: number) => records[index]?.windows.map(({ window, reachable, opener, page: name }) => ({ window, reachable, ...(opener === undefined ? {} : { opener }), ...(name === undefined ? {} : { page: name }) }))
  assert.deepEqual(windowsOf(0), [
    { window: 1, reachable: true },
    { window: 2, reachable: true, opener: 1, page: 'desktop/popup-1' },
    { window: 3, reachable: true, opener: 2, page: 'desktop/popup-1/popup-1' },
  ])
  assert.deepEqual(windowsOf(2), [
    { window: 1, reachable: true },
    { window: 2, reachable: true, page: 'desktop/popup-1' },
    { window: 3, reachable: false, opener: 1 },
  ])
  assert.deepEqual(windowsOf(4), [
    { window: 1, reachable: true },
    { window: 2, reachable: false },
    { window: 3, reachable: false, opener: 1 },
    { window: 4, reachable: true, opener: 1, page: 'desktop/popup-1' },
  ])
  assert.deepEqual(windowsOf(5), [
    { window: 1, reachable: true },
    { window: 2, reachable: false },
    { window: 3, reachable: true, opener: 1, page: 'desktop/popup-1' },
  ])
  // Every window a test was given closed before the app quit: by close(), or by Retest as the test ended.
  for (const record of records) {
    for (const window of record.windows) if (window.page !== undefined) assert.notEqual(window.closedMs, undefined, `window ${window.window} of launch ${record.launch} closed`)
  }
  const log = readFileSync(join(run.output, targetBrowserLogFile(variantKey({ desktop: 'electron' }))), 'utf8')
  assert.match(log, /\[retest\] the app opened window 2, from window 1; a test reaches it only through page\.popup\(\)/)
  assert.match(log, /\[retest\] the app opened window 2, from its main process; a test reaches it only through page\.popup\(\)/)
  assert.match(log, /\[retest\] window 2 is the test's page desktop\/popup-1/)

  // Nothing of the app is left running.
  for (const { pid } of eventsOf(run.events, 'browser.started')) {
    assert.throws(() => process.kill(pid, 0), (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ESRCH', `launch ${pid} is gone`)
  }
  assert.equal(processesNaming(fixtureApp), '', 'no process of the app is left')
})
