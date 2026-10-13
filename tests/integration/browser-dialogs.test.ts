import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { DialogWait, OpenedDialog, UnwaitedDialog } from '../../src/browser/dialogs.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { launchElectron } from '../../src/browser/electron.ts'
import { assertOk, check, click, failureOf, goto, launch, observe, observeUntil, openApp, openPage, scratchFolder, sharedBrowser, timed, within } from './browser-harness.ts'
import { agentHost, assertActed, openOn, TASK_APP_PASSWORD, waitForText } from './agent-harness.ts'

// JavaScript dialogs on Chrome, against the driver: a page armed for a dialog hands it over while the action that
// opened it waits, and the answer lets the action finish; a dialog nothing waited for fails its action and is answered
// at once, so the page stays usable. Every case reads the page's own status line for what the dialog's answer did.

const browser = sharedBrowser()

async function dialogsPage(t: TestContext): Promise<OwnedPage> {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/dialogs'))
  return page
}

// Arms the page, then starts the click the dialog comes from, as page.dialog() does.
function armAndClick(page: OwnedPage, target: string, timeoutMs = 5000): { opened: Promise<DialogWait>; clicked: Promise<CommandResult> } {
  assert.ok(page.armDialog !== undefined, 'a Chromium page hands its dialogs over')
  const arming = page.armDialog(timeoutMs)
  assert.ok(arming.ok, JSON.stringify(arming))
  return { opened: arming.opened, clicked: click(page, target, timeoutMs) }
}

async function openedDialog(opened: Promise<DialogWait>): Promise<OpenedDialog> {
  const wait = await within(opened, 3000, 'the dialog was not handed over')
  assert.ok(wait.ok, JSON.stringify(wait))
  return wait.dialog
}

async function answer(page: OwnedPage, dialog: OpenedDialog, accept: boolean, promptText?: string): Promise<void> {
  assert.ok(page.answerDialog !== undefined)
  const answered = await page.answerDialog(dialog.id, { accept, ...(promptText === undefined ? {} : { promptText }) }, 2000)
  assert.deepEqual(answered, { ok: true })
}

// Sends the signal the later button waits for, so its alert opens now and not during a command, and waits until the
// page tells the server the alert was answered, which it can only do once Retest has answered it.
async function signalAlert(appUrl: string): Promise<void> {
  const alerted = async (): Promise<number> => Number(await (await fetch(`${appUrl}/dialogs/alerted`)).text())
  const before = await alerted()
  await fetch(`${appUrl}/dialogs/signal`, { method: 'POST' })
  const deadline = performance.now() + 5000
  while ((await alerted()) === before) {
    if (performance.now() > deadline) assert.fail('the alert the signal opens was not answered within 5000 ms')
    await delay(20)
  }
}

// Whether a promise has settled after the page has had time to finish the command, which it must not while a dialog holds it.
async function settledSoon(promise: Promise<unknown>, ms = 200): Promise<boolean> {
  let settled = false
  void promise.then(() => (settled = true))
  await delay(ms)
  return settled
}

test('a confirm the page was armed for is handed over while its click waits, and accepting it lets the click finish', async (t) => {
  const page = await dialogsPage(t)
  const { opened, clicked } = armAndClick(page, 'confirm')
  const dialog = await openedDialog(opened)
  assert.deepEqual({ type: dialog.type, message: dialog.message, defaultValue: dialog.defaultValue }, { type: 'confirm', message: 'Delete this task?', defaultValue: '' })
  assert.equal(await settledSoon(clicked), false, 'the click waits while the dialog holds the page')
  await answer(page, dialog, true)
  assertOk(await within(clicked, 2000, 'the click did not finish once the dialog was answered'))
  assert.equal((await observe(page, 'status')).text, 'Deleted')
})

test('each kind of dialog is accepted and dismissed, and the page shows what the answer did', async (t) => {
  const page = await dialogsPage(t)
  const cases: [string, boolean, string | undefined, string, string][] = [
    ['alert', true, undefined, 'alert', 'Alerted'],
    ['alert', false, undefined, 'alert', 'Alerted'],
    ['confirm', false, undefined, 'confirm', 'Kept'],
    ['confirm', true, undefined, 'confirm', 'Deleted'],
    ['prompt', true, 'Grace', 'prompt', 'Renamed to Grace'],
    ['prompt', true, undefined, 'prompt', 'Renamed to Release checklist'],
    ['prompt', false, undefined, 'prompt', 'No answer'],
  ]
  for (const [button, accept, promptText, type, shown] of cases) {
    await t.test(`${button} ${accept ? 'accepted' : 'dismissed'}${promptText === undefined ? '' : ` with ${promptText}`}`, async () => {
      const { opened, clicked } = armAndClick(page, button)
      const dialog = await openedDialog(opened)
      assert.equal(dialog.type, type)
      assert.equal(dialog.defaultValue, type === 'prompt' ? 'Release checklist' : '')
      await answer(page, dialog, accept, promptText)
      assertOk(await clicked)
      assert.equal((await observe(page, 'status')).text, shown)
    })
  }
})

test('text for a dialog other than a prompt is refused, and the dialog stays open to be answered', async (t) => {
  const page = await dialogsPage(t)
  const { opened, clicked } = armAndClick(page, 'confirm')
  const dialog = await openedDialog(opened)
  assert.ok(page.answerDialog !== undefined)
  assert.deepEqual(await page.answerDialog(dialog.id, { accept: true, promptText: 'yes' }, 2000), {
    ok: false,
    failure: { class: 'usage', message: 'accept() takes text only for a prompt dialog, and this is a confirm dialog.' },
  })
  await answer(page, dialog, false)
  assertOk(await clicked)
  assert.equal((await observe(page, 'status')).text, 'Kept')
  assert.deepEqual(await page.answerDialog(dialog.id, { accept: true }, 2000), { ok: false, failure: { class: 'not_actionable', message: 'The dialog is no longer open, so Retest answered nothing.' } })
})

test('a dialog nothing waited for fails its click at once, is dismissed, and the next command and a screenshot work', async (t) => {
  const page = await dialogsPage(t)
  const heard: UnwaitedDialog[] = []
  page.onUnwaitedDialog?.((dialog) => heard.push(dialog))
  const { value: result, ms } = await timed(click(page, 'confirm', 5000))
  assert.ok(ms < 1500, `the click should fail at once, took ${ms} ms of its 5000`)
  assert.deepEqual(failureOf(result), {
    class: 'not_actionable',
    message: "The page opened a confirm dialog while Retest tried to click getByTestId('confirm'). Retest dismissed it. To answer it, wrap the action in page.dialog().",
    details: { dialog: 'confirm', dialogMessage: 'Delete this task?', answered: 'dismissed', command: "click getByTestId('confirm')", inputSent: true },
  })
  assert.deepEqual(heard, [{ type: 'confirm', message: 'Delete this task?', answered: 'dismissed', during: true }])
  const { value: status, ms: lookMs } = await timed(observe(page, 'status'))
  assert.equal(status.text, 'Kept', 'confirm() answered false, as dismissing it should')
  assert.ok(lookMs < 500, `the next command should not wait, took ${lookMs} ms`)
  assert.ok((await page.screenshot(2000)).byteLength > 0)
})

test('a dialog that opens while no command runs is dismissed and told, and the page goes on', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/dialogs'))
  const heard: UnwaitedDialog[] = []
  page.onUnwaitedDialog?.((dialog) => heard.push(dialog))
  assertOk(await click(page, 'later'))
  await observeUntil(page, 'status', (seen) => seen.text === 'Waiting for the signal')
  await signalAlert(app.url)
  assert.deepEqual(heard, [{ type: 'alert', message: 'Later', answered: 'dismissed', during: false }])
  await observeUntil(page, 'status', (seen) => seen.text === 'After the alert')
  assert.equal(heard.length, 1)
})

test("a command that fails of its own accord keeps its own failure first, and names the dialog Retest answered meanwhile after it", async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/dialogs'))
  // The click waits for a button that is never enabled, and fails of its own accord; then again, while an alert opens.
  const own = failureOf(await click(page, 'never', 1500))
  assertOk(await click(page, 'later'))
  await observeUntil(page, 'status', (seen) => seen.text === 'Waiting for the signal')
  const clicking = click(page, 'never', 1500)
  await delay(200)
  await signalAlert(app.url)
  const failure = failureOf(await clicking)
  assert.deepEqual(failure, {
    ...own,
    message: `${own.message} The page also opened an alert dialog, and Retest dismissed it.`,
    details: { ...own.details, dialog: 'alert', dialogMessage: 'Later', answered: 'dismissed' },
  })
  await observeUntil(page, 'status', (seen) => seen.text === 'After the alert')
})

test('an agent session hears every dialog Retest answered: one during an action fails it in words for an agent, one between calls is named in the next answer', async (t) => {
  const app = await openApp(t)
  const { host } = await agentHost(t)
  const session = await openOn(host, { app: 'web', purpose: 'discovery', baseUrl: app.url })
  assertActed(await session.act({ kind: 'goto', url: '/dialogs' }), 'opened the dialogs page')

  const confirmed = await session.act({ kind: 'click', locator: { by: 'testId', value: 'confirm' } })
  assert.equal(confirmed.input, 'sent')
  assert.deepEqual(confirmed.result, {
    ok: false,
    failure: { class: 'not_actionable', message: "The page showed a confirm dialog that says \"Delete this task?\" while Retest tried to click getByTestId('confirm'). Retest answered no.", details: { dialog: 'confirm', answered: 'dismissed', inputSent: true } },
  })
  assert.equal(confirmed.dialogs, undefined, 'a dialog during an action is named in its failure, and not again')
  await waitForText(session, { by: 'testId', value: 'status' }, 'Kept')

  // The page's text is redacted before it is quoted: an alert that repeats the password shows its name.
  assertActed(await session.act({ kind: 'fill', locator: { by: 'testId', value: 'secret' }, value: { secret: 'password' } }), 'typed the password')
  const echoed = await session.act({ kind: 'click', locator: { by: 'testId', value: 'echo' } })
  assert.ok(!echoed.result.ok)
  assert.equal(echoed.result.failure.message, "The page showed an alert dialog that says \"You typed {{password}}\" while Retest tried to click getByTestId('echo'). Retest closed it.")

  assertActed(await session.act({ kind: 'click', locator: { by: 'testId', value: 'later' } }), 'clicked Later')
  await waitForText(session, { by: 'testId', value: 'status' }, 'Waiting for the signal')
  await signalAlert(app.url)
  const told = await session.observe({ by: 'testId', value: 'status' })
  assert.ok(told.ok, told.ok ? '' : told.failure.message)
  assert.deepEqual(told.dialogs, [{ type: 'alert', message: 'Later', answered: 'dismissed', words: 'The page showed an alert dialog that says "Later" between commands. Retest closed it.' }])
  const next = await session.observe({ by: 'testId', value: 'status' })
  assert.equal(next.dialogs, undefined, 'a dialog is named in one answer only')
  assert.deepEqual(
    session.answeredDialogs.map(({ type, message, answered }) => ({ type, message, answered })),
    [
      { type: 'confirm', message: 'Delete this task?', answered: 'dismissed' },
      { type: 'alert', message: 'You typed {{password}}', answered: 'dismissed' },
      { type: 'alert', message: 'Later', answered: 'dismissed' },
    ],
  )
  const answers = JSON.stringify([confirmed, echoed, told, session.answeredDialogs])
  assert.equal(answers.includes('page.dialog'), false, 'an agent is never told to wrap its action in page.dialog()')
  assert.equal(answers.includes(TASK_APP_PASSWORD), false, 'no answer holds the password')
})

test('two dialogs in a row are handed over by two waits, the second armed while the first is open', async (t) => {
  const page = await dialogsPage(t)
  const { opened, clicked } = armAndClick(page, 'two')
  const first = await openedDialog(opened)
  assert.deepEqual([first.type, first.message], ['alert', 'First of two'])
  assert.ok(page.armDialog !== undefined)
  const second = page.armDialog(5000)
  assert.ok(second.ok)
  await answer(page, first, true)
  const next = await openedDialog(second.opened)
  assert.deepEqual([next.type, next.message], ['confirm', 'Second of two?'])
  assert.equal(await settledSoon(clicked), false, 'the click waits for the second dialog too')
  await answer(page, next, true)
  assertOk(await clicked)
  assert.equal((await observe(page, 'status')).text, 'Second accepted')
})

test('a beforeunload dialog from goto is handed over; accepted, the page leaves, and dismissed, the page stays', async (t) => {
  const page = await dialogsPage(t)
  assertOk(await check(page, 'guard'))
  assert.ok(page.armDialog !== undefined)
  const staying = page.armDialog(5000)
  assert.ok(staying.ok)
  const leaving = goto(page, '/dialogs/next')
  const kept = await openedDialog(staying.opened)
  assert.deepEqual([kept.type, kept.message, kept.defaultValue], ['beforeunload', '', ''])
  await answer(page, kept, false)
  const refused = failureOf(await leaving)
  assert.equal(refused.class, 'not_actionable', JSON.stringify(refused))
  assert.match(refused.message, /^Retest could not open http:\/\/127\.0\.0\.1:\d+\/dialogs\/next: its beforeunload dialog was dismissed, so the page stayed where it was\.$/)
  assert.deepEqual(refused.details, { dialog: 'beforeunload', inputSent: true })
  assert.equal(new URL(page.url ?? '').pathname, '/dialogs')
  assert.equal((await observe(page, 'status')).text, 'Ready')

  const going = page.armDialog(5000)
  assert.ok(going.ok)
  const left = goto(page, '/dialogs/next')
  await answer(page, await openedDialog(going.opened), true)
  assertOk(await left)
  assert.equal((await observe(page, 'arrived')).text, 'Arrived')
})

test('a beforeunload dialog nothing waited for is accepted, so the goto leaves, and the goto fails naming it', async (t) => {
  const page = await dialogsPage(t)
  assertOk(await check(page, 'guard'))
  const failed = failureOf(await goto(page, '/dialogs/next'))
  assert.equal(failed.class, 'not_actionable')
  assert.match(failed.message, /^The page opened a beforeunload dialog while Retest tried to open http:\/\/127\.0\.0\.1:\d+\/dialogs\/next\. Retest accepted it, so the page could leave\. To answer it, wrap the action in page\.dialog\(\)\.$/)
  await observeUntil(page, 'arrived', (seen) => seen.text === 'Arrived')
})

test('a wait that sees no dialog fails when its time runs out, and leaves the page unarmed', async (t) => {
  const page = await dialogsPage(t)
  assert.ok(page.armDialog !== undefined)
  const arming = page.armDialog(300)
  assert.ok(arming.ok)
  assert.deepEqual(await arming.opened, { ok: false, failure: { class: 'timeout', message: 'No dialog opened within 300 ms.' } })
  // Unarmed, the page answers the next dialog itself, and the click that opened it fails.
  assert.deepEqual(failureOf(await click(page, 'alert', 2000)).details?.['answered'], 'dismissed')
  assert.equal((await observe(page, 'status')).text, 'Alerted')
})

test('a dialog the test was given holds the page: a command fails at once, and the click whose time runs out says why', async (t) => {
  const page = await dialogsPage(t)
  const { opened, clicked } = armAndClick(page, 'confirm', 600)
  const dialog = await openedDialog(opened)
  const { value: held, ms } = await timed(page.execute({ kind: 'observe', locator: { by: 'testId', value: 'status' } }, 2000))
  assert.ok(ms < 500, `a held page should refuse at once, took ${ms} ms`)
  assert.deepEqual(failureOf(held), {
    class: 'not_actionable',
    message: "Retest could not read getByTestId('status'): the confirm dialog the test was given still holds the page. Answer it first with dialog.accept() or dialog.dismiss().",
    details: { dialog: 'confirm', inputSent: false },
  })
  assert.deepEqual(failureOf(await clicked), {
    class: 'timeout',
    message: "Retest began to click getByTestId('confirm'), and the confirm dialog the test was given held the page until the time ran out. Answer it with dialog.accept() or dialog.dismiss().",
    details: { dialog: 'confirm', inputSent: true },
  })
  await answer(page, dialog, true)
  await observeUntil(page, 'status', (seen) => seen.text === 'Deleted')
})

test('a second wait on a page that already waits is refused', async (t) => {
  const page = await dialogsPage(t)
  assert.ok(page.armDialog !== undefined)
  const first = page.armDialog(500)
  assert.ok(first.ok)
  assert.deepEqual(page.armDialog(500), { ok: false, failure: { class: 'usage', message: 'page.dialog() is already waiting for a dialog on this page. Await it before the next one.' } })
  assert.equal((await first.opened).ok, false)
})

test('Firefox and WebKit refuse page.dialog(), page.popup() and close() by name, and send nothing', async (t) => {
  for (const [engine, label] of [['firefox', 'Firefox'], ['webkit', 'WebKit']] as const) {
    await t.test(label, async (t) => {
      // The harness launches the engine RETEST_TEST_ENGINE names, read as it launches.
      const previous = process.env['RETEST_TEST_ENGINE']
      process.env['RETEST_TEST_ENGINE'] = engine
      const owned = await launch(t).finally(() => {
        if (previous === undefined) delete process.env['RETEST_TEST_ENGINE']
        else process.env['RETEST_TEST_ENGINE'] = previous
      })
      const page = await openPage(t, owned)
      assert.deepEqual(page.armDialog?.(1000), { ok: false, failure: { class: 'unsupported', message: `Retest hands dialogs to a test on Chrome and Chromium only, and not on ${label} yet.` } })
      assert.deepEqual(await page.armPopup?.({ timeoutMs: 1000, setupMs: 1000 }), { ok: false, failure: { class: 'unsupported', message: `Retest hands a test the pages a page opens on Chrome and Chromium only, and not on ${label} yet.` } })
      assert.deepEqual(failureOf(await page.execute({ kind: 'close' }, 1000)), { class: 'unsupported', message: `Retest closes a page on Chrome and Chromium only, and not on ${label} yet, so it closed nothing.`, details: { inputSent: false } })
    })
  }
})

// The official Electron release the Electron tests use, downloaded outside the repository. On macOS a missing binary
// fails this test; elsewhere Retest has no route to an Electron build yet, so without one given it is skipped by name.
const electronBinary = process.env['RETEST_TEST_ELECTRON'] ?? join(homedir(), 'Library/Caches/retest-proofs/electron/44.5.1/dist/Electron.app/Contents/MacOS/Electron')
const noElectron = process.platform !== 'darwin' && process.env['RETEST_TEST_ELECTRON'] === undefined ? 'unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build here' : false

// A window with a confirm and a button that opens a second window, loaded from a file of the app's own.
const ELECTRON_MAIN = `import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'
app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 640, height: 480 })
  void window.loadFile(fileURLToPath(new URL('./index.html', import.meta.url)))
})
app.on('window-all-closed', () => app.quit())
`
const ELECTRON_PAGE = `<!doctype html><meta charset="utf-8"><title>Desk</title>
<button data-testid="confirm" onclick="document.querySelector('[data-testid=status]').textContent = confirm('Delete this task?') ? 'Deleted' : 'Kept'">Delete</button>
<button data-testid="open" onclick="window.open('about:blank')">Open</button>
<p data-testid="status">Ready</p>`

test("an Electron window hands its dialogs over and answers one nothing waited for, as a Chrome page does, and refuses popup() by name", { skip: noElectron }, async (t) => {
  const folder = await scratchFolder(t)
  const appPath = join(folder, 'app')
  mkdirSync(appPath)
  writeFileSync(join(appPath, 'package.json'), JSON.stringify({ name: 'retest-dialogs-electron', private: true, main: 'main.mjs' }))
  writeFileSync(join(appPath, 'main.mjs'), ELECTRON_MAIN)
  writeFileSync(join(appPath, 'index.html'), ELECTRON_PAGE)
  const electron = await launchElectron({ executablePath: electronBinary, appPath, args: [], windowsFile: join(folder, 'windows.json'), logFile: join(folder, 'electron.log'), app: 'desk', target: 'electron', launch: 1 })
  t.after(() => electron.close(5000))
  const page = await electron.newPage({}, 10_000)
  await observeUntil(page, 'status', (seen) => seen.text === 'Ready')
  const { opened, clicked } = armAndClick(page, 'confirm')
  const dialog = await openedDialog(opened)
  assert.deepEqual([dialog.type, dialog.message], ['confirm', 'Delete this task?'])
  assert.equal(await settledSoon(clicked), false, 'the click waits while the dialog holds the window')
  await answer(page, dialog, true)
  assertOk(await clicked)
  assert.equal((await observe(page, 'status')).text, 'Deleted')
  const unwaited = failureOf(await click(page, 'confirm'))
  assert.deepEqual([unwaited.class, unwaited.details?.['answered']], ['not_actionable', 'dismissed'])
  await observeUntil(page, 'status', (seen) => seen.text === 'Kept')
  assert.deepEqual(await page.armPopup?.({ timeoutMs: 1000, setupMs: 1000 }), { ok: false, failure: { class: 'unsupported', message: 'A test reaches only the first window of the Electron app desk, so page.popup() is for a browser\'s page.' } })
})
