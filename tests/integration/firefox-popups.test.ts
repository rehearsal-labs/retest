import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage, PageNavigation, WebSession } from '../../src/browser/contract.ts'
import type { OpenedPopup } from '../../src/browser/popups.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { assertOk, check, click, closeMs, failureOf, fill, goto, observe, observeUntil, openApp, openPage, scratchFolder, servePages, setupMs, sharedBrowser, within } from './browser-harness.ts'
import { firefoxHostSkip, firefoxPath, testFirefoxRoute } from './engines.ts'

// The pages a page opens, on Firefox 158, against the driver, case by case beside browser-popups.test.ts, which runs
// them on Chrome. Firefox cannot hold a new page before its first document; Retest's script, its subscriptions and the
// viewport are the user context's instead, so the page Retest makes for a popup the moment Firefox tells of it hears
// everything from the popup's first document, which has Retest's input guard as much as any other. Each popup opens in
// a window of its own, and closes by its own browsing context, leaving its opener's user context. A dialog holds a
// Firefox page, so a popup's close that meets a beforeunload dialog fails by name.

const skip = firefoxHostSkip()
// The harness launches the engine RETEST_TEST_ENGINE names.
process.env['RETEST_TEST_ENGINE'] = 'firefox'
const browser = sharedBrowser()

async function popupsPage(t: TestContext, on: OwnedBrowser = browser(), partner?: TaskApp, viewport?: { width: number; height: number }): Promise<{ app: TaskApp; page: OwnedPage }> {
  const app = await openApp(t)
  const page = await openPage(t, on, app.url, viewport === undefined ? {} : { emulation: { viewport, deviceScaleFactor: 1, touch: false, isMobile: false } })
  assertOk(await goto(page, partner === undefined ? '/popups' : `/popups?partner=${encodeURIComponent(partner.url)}`))
  return { app, page }
}

// Arms the page for a popup, then clicks what opens it, as page.popup() does.
async function popupFrom(page: OwnedPage, target: string, timeoutMs = 5000): Promise<{ popup: OpenedPopup; first: PageNavigation | undefined }> {
  assert.ok(page.armPopup !== undefined, 'a Firefox page hands over the pages it opens')
  const arming = await page.armPopup({ timeoutMs, setupMs })
  assert.ok(arming.ok, JSON.stringify(arming))
  const clicked = click(page, target, timeoutMs)
  const wait = await within(arming.opened, timeoutMs, 'no popup was handed over')
  assert.ok(wait.ok, JSON.stringify(wait))
  const first = await wait.popup.first(timeoutMs)
  assertOk(await clicked)
  return { popup: wait.popup, first }
}

function pathOf(url: string | undefined): string {
  return url === undefined || url === '' ? '' : new URL(url).pathname
}

test('a link with a target opens a page that is handed over with its first document, and is driven as a page of its own', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'terms')
  assert.equal(pathOf(first?.url), '/popups/terms')
  assert.equal(await first?.title, 'Terms')
  assert.equal(first?.document, 'new')
  assertOk(await fill(popup.page, 'email', 'alice@example.com'))
  assertOk(await click(popup.page, 'save'))
  assert.equal((await observe(popup.page, 'saved')).text, 'Saved alice@example.com')
  // The opener keeps its own page: a command to it still acts on it.
  assert.equal((await observe(page, 'status')).text, 'Ready')
  assertOk(await click(page, 'help'))
  await popup.page.dispose(2000)
})

test('a page window.open opens on the same origin is handed over with its first address and title', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'help')
  assert.equal(pathOf(first?.url), '/popups/help')
  assert.equal(await first?.title, 'Help')
  assert.equal((await observe(popup.page, 'help-text')).text, 'Ask us anything.')
  await popup.page.dispose(2000)
})

// Firefox keeps the window of a popup's first, empty document for the first document of its opener's origin, and runs no
// preload script there; Retest's script runs in it once it commits, so the popup is followed, guarded and typed into.
test("a popup window.open sends to its opener's origin takes typing, keys and clicks in the document that replaced its first", { skip }, async (t) => {
  // The form's own capturing listener on its window stops every key from going further, so only a guard whose relays
  // came before it, on the window the popup kept, hears the keys.
  const site = await servePages(t, {
    '/': '<!doctype html><title>Opener</title><button data-testid="open" onclick="window.open(\'/form\')">Open</button>',
    '/form': '<!doctype html><title>Form</title><script>for (const type of [\'keydown\', \'keyup\']) addEventListener(type, (event) => event.stopImmediatePropagation(), true)</script><input data-testid="name" autocomplete="off"><button data-testid="show" onclick="document.querySelector(\'[data-testid=shown]\').textContent = document.querySelector(\'[data-testid=name]\').value">Show</button><p data-testid="shown"></p>',
  })
  const page = await openPage(t, browser(), site.url)
  assertOk(await goto(page, '/'))
  const { popup, first } = await popupFrom(page, 'open')
  assert.equal(pathOf(first?.url), '/form')
  assert.equal(await first?.title, 'Form')
  assertOk(await fill(popup.page, 'name', 'Ada Lovelace'))
  assertOk(await popup.page.execute({ kind: 'press', locator: { by: 'testId', value: 'name' }, key: 'Backspace' }, 5000))
  assertOk(await click(popup.page, 'show'))
  assert.equal((await observe(popup.page, 'shown')).text, 'Ada Lovelac')
  assert.equal(popup.page.url, `${site.url}/form`)
  await popup.page.dispose(2000)
})

test('a sign-in popup on another origin sends itself on at once, answers its opener and closes itself', { skip }, async (t) => {
  const partner = await openApp(t)
  const { page } = await popupsPage(t, browser(), partner)
  const { popup, first } = await popupFrom(page, 'partner')
  // The first document is the partner's own first page, which sends the popup on to its sign-in.
  assert.equal(first?.url, `${partner.url}/popups/partner`)
  await observeUntil(popup.page, 'partner-email', (seen) => seen.count === 1)
  assert.equal(popup.page.url, `${partner.url}/popups/partner/sign-in`)
  assertOk(await fill(popup.page, 'partner-email', 'alice@example.com'))
  assertOk(await fill(popup.page, 'partner-password', 'correct horse'))
  assertOk(await click(popup.page, 'sign-in'))
  await observeUntil(page, 'status', (seen) => seen.text === 'Signed in as alice@example.com')
  assert.deepEqual(await within(popup.gone, 3000, 'the popup did not close itself'), { kind: 'closed' })
  assert.equal(popup.closed(), true)
  // The page is gone with its browsing context, so a look at it fails as a lost page, at once.
  assert.equal(failureOf(await popup.page.execute({ kind: 'observe', locator: { by: 'testId', value: 'sign-in' } }, 1000)).class, 'session_lost')
})

test('a popup that closes itself is told gone, and its opener sees it closed', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'flash')
  assert.equal(pathOf(first?.url), '/popups/closing')
  await within(popup.gone, 3000, 'the popup did not close itself')
  await observeUntil(page, 'status', (seen) => seen.text === 'Popup closed')
  // A popup that went is disposed with nothing left to do.
  await popup.page.dispose(2000)
})

test('close closes a popup and its browsing context goes; one whose beforeunload handler asks is held by the dialog, refused by name, and closed at disposal', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const help = await popupFrom(page, 'help')
  assert.deepEqual(await help.popup.page.execute({ kind: 'close' }, 3000), { ok: true, kind: 'close' })
  assert.deepEqual(await within(help.popup.gone, 2000, 'the closed popup is not gone'), { kind: 'closed' })
  assert.equal((await observe(page, 'status')).text, 'Ready')

  const { popup } = await popupFrom(page, 'dialogs')
  assertOk(await check(popup.page, 'guard'))
  const asked = await popup.page.dispatch({ kind: 'close' }, 3000)
  assert.deepEqual(asked.result, { ok: false, failure: { class: 'unsupported', message: 'The page opened a beforeunload dialog while Retest tried to close the page. Retest does not answer dialogs yet, and the dialog blocks the page.', details: { dialog: 'beforeunload', inputSent: true } } })
  assert.notEqual(asked.input, 'not_sent')
  assert.equal(popup.closed(), false, 'the dialog keeps the popup open')
  await popup.page.dispose(3000)
  assert.deepEqual(await within(popup.gone, 3000, 'the disposed popup is not gone'), { kind: 'closed' })
  assert.equal((await observe(page, 'status')).text, 'Ready')
})

test('a wait that sees no page fails when its time runs out', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  assert.ok(page.armPopup !== undefined)
  const arming = await page.armPopup({ timeoutMs: 300, setupMs })
  assert.ok(arming.ok)
  assert.deepEqual(await arming.opened, { ok: false, failure: { class: 'timeout', message: 'No page opened within 300 ms.' } })
})

test('a page waits for one popup at a time', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  assert.ok(page.armPopup !== undefined)
  const first = await page.armPopup({ timeoutMs: 300, setupMs })
  assert.ok(first.ok)
  assert.deepEqual(await page.armPopup({ timeoutMs: 300, setupMs }), { ok: false, failure: { class: 'usage', message: 'page.popup() is already waiting for a page on this page. Await it before the next one.' } })
  await first.opened
})

test('a page opened while nothing waited runs on, and a later wait is given only the page opened after it began', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  assertOk(await click(page, 'help'))
  const { popup, first } = await popupFrom(page, 'terms')
  assert.equal(pathOf(first?.url), '/popups/terms')
  assert.equal((await observe(popup.page, 'email')).count, 1)
  await popup.page.dispose(2000)
})

test('a popup has the viewport of the page that opened it from its first document, and its opener stays shown', { skip }, async (t) => {
  const { page } = await popupsPage(t, browser(), undefined, { width: 640, height: 480 })
  const { popup } = await popupFrom(page, 'size')
  assert.equal((await observe(popup.page, 'size')).text, '640x480')
  const shown = await servePages(t, {
    '/': '<!doctype html><title>Shown</title><button data-testid="open" onclick="window.open(\'/other\')">Open</button><p data-testid="seen">visible</p><script>document.addEventListener(\'visibilitychange\', () => { document.querySelector(\'[data-testid=seen]\').textContent += \' \' + document.visibilityState })</script>',
    '/other': '<!doctype html><title>Other</title><p>Other</p>',
  })
  const opener = await openPage(t, browser(), shown.url)
  assertOk(await goto(opener, '/'))
  const other = await popupFrom(opener, 'open')
  assertOk(await click(other.popup.page, { by: 'text', text: 'Other' }))
  assert.equal((await observe(opener, 'seen')).text, 'visible', 'the opener was never hidden by the window its popup opened in')
  await other.popup.page.dispose(2000)
  await popup.page.dispose(2000)
})

test("a popup's own popup is handed over by the popup, and each is a web session apart from its opener", { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup } = await popupFrom(page, 'again')
  const session: WebSession = popup.page
  assert.ok((await session.screenshot(2000)).byteLength > 0)
  const nested = await popupFrom(popup.page, 'help')
  assert.equal(pathOf(nested.first?.url), '/popups/help')
  assert.equal((await observe(nested.popup.page, 'help-text')).text, 'Ask us anything.')
  await nested.popup.page.dispose(2000)
  await popup.page.dispose(2000)
  await within(popup.gone, 2000, 'the disposed popup is not gone')
  // The opener's user context stays: the opener still answers.
  assert.equal((await observe(page, 'status')).text, 'Ready')
})

test('disposing pages leaves no popup behind: a popup closes its own browsing context, and an opener takes the rest with its user context', { skip }, async (t) => {
  const { browser: owned, contexts } = await launchWatched(t)
  const { page } = await popupsPage(t, owned)
  const handed = await popupFrom(page, 'help')
  assertOk(await click(page, 'terms'))
  await waitFor(() => contexts().map(pathOf).sort().join(' ') === '/popups/help /popups/terms', 'the two popups to open their first documents')
  await handed.popup.page.dispose(2000)
  await within(handed.popup.gone, 2000, 'the disposed popup is not gone')
  assert.deepEqual(contexts().map(pathOf), ['/popups/terms'])
  await page.dispose(2000)
  await waitFor(() => contexts().length === 0, 'the popups of a disposed page to go')
})

/** A Firefox of the test's own, whose WebDriver BiDi socket also tells the test the address of every popup still open. */
async function launchWatched(t: TestContext): Promise<{ browser: OwnedBrowser; contexts: () => string[] }> {
  const folder = await scratchFolder(t)
  const open = new Map<string, string>()
  class WatchedSocket extends WebSocket {
    constructor(url: string) {
      super(url)
      this.addEventListener('message', (event) => {
        const message: unknown = typeof event.data === 'string' ? JSON.parse(event.data) : undefined
        if (!isRecord(message) || !isRecord(message['params'])) return
        const { context, url, originalOpener, parent } = message['params']
        if (typeof context !== 'string') return
        if (message['method'] === 'browsingContext.contextDestroyed') open.delete(context)
        if (message['method'] === 'browsingContext.contextCreated' && typeof originalOpener === 'string' && parent === null) open.set(context, typeof url === 'string' ? url : '')
        if (message['method'] === 'browsingContext.navigationCommitted' && open.has(context) && typeof url === 'string') open.set(context, url)
      })
    }
  }
  const owned = await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), headless: true, logFile: join(folder, 'browser.log') }, setupMs * 3, (url) => new WatchedSocket(url))
  t.after(() => owned.close(closeMs))
  return { browser: owned, contexts: () => [...open.values()] }
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() > end) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}
