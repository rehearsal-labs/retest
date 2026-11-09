import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage, PageNavigation, WebSession } from '../../src/browser/contract.ts'
import type { OpenedPopup } from '../../src/browser/popups.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { launchWebKit } from '../../src/browser/webkit/browser.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { assertOk, check, click, closeMs, failureOf, fill, goto, groupExists, observe, observeUntil, openApp, openPage, scratchFolder, setupMs, sharedBrowser, timed, within } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { engineAbsence, webKitPath } from './engines.ts'

// The pages a page opens, on WebKit build 2359, against the driver and through a whole run: the same fixture pages and
// the same cases as browser-popups.test.ts and popups.test.ts on Chrome, each held to what WebKit does. The build names
// each new page's opener and starts its first target paused, so a popup is handed over before its first document and
// driven as a page of its own. Where WebKit ends a case otherwise, the case asserts exactly what WebKit gives and
// docs/compatibility/webkit.md says why: Retest answers no dialog on WebKit, so a popup's beforeunload holds it and its
// close fails by name, and a popup's dialog holds every page of its web process. WebKit runs on macOS only.

const absent = engineAbsence('webkit')
// The harness launches the engine RETEST_TEST_ENGINE names, read as it launches.
if (absent === undefined) process.env['RETEST_TEST_ENGINE'] = 'webkit'
const skip = absent ?? false

const browser = sharedBrowser()

async function popupsPage(t: TestContext, on: OwnedBrowser = browser(), partner?: TaskApp, options: Parameters<typeof openPage>[3] = {}): Promise<{ app: TaskApp; page: OwnedPage }> {
  const app = await openApp(t)
  const page = await openPage(t, on, app.url, options)
  assertOk(await goto(page, partner === undefined ? '/popups' : `/popups?partner=${encodeURIComponent(partner.url)}`))
  return { app, page }
}

// Arms the page for a popup, then clicks what opens it, as page.popup() does. The click is awaited only once the popup
// is set up: a page `window.open` opens shares its opener's web process, which runs nothing while the popup is held.
async function popupFrom(page: OwnedPage, target: string, timeoutMs: number = defaultTimeouts.action): Promise<{ popup: OpenedPopup; first: PageNavigation | undefined }> {
  assert.ok(page.armPopup !== undefined, 'a WebKit page hands over the pages it opens')
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

async function waitFor(condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number = defaultTimeouts.assertion): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!(await condition())) {
    if (performance.now() > end) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('a link with a target opens a page that is handed over before its first document, and is driven as a page of its own', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'terms')
  assert.equal(pathOf(first?.url), '/popups/terms')
  assert.equal(await first?.title, 'Terms')
  assert.equal(first?.document, 'new')
  assertOk(await fill(popup.page, 'email', 'alice@example.com'))
  assertOk(await click(popup.page, 'save'))
  assert.equal((await observe(popup.page, 'saved')).text, 'Saved alice@example.com')
  // The opener keeps its own page and focus: a command to it still acts on it.
  assert.equal((await observe(page, 'status')).text, 'Ready')
  assertOk(await click(page, 'help'))
  await popup.page.dispose(defaultTimeouts.cleanup)
  assert.deepEqual(await within(popup.gone, defaultTimeouts.cleanup, 'the disposed popup is not gone'), { kind: 'closed' })
})

test('a page window.open opens on the same origin is handed over with its first address and title', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'help')
  assert.equal(pathOf(first?.url), '/popups/help')
  assert.equal(await first?.title, 'Help')
  assert.equal((await observe(popup.page, 'help-text')).text, 'Ask us anything.')
  await popup.page.dispose(defaultTimeouts.cleanup)
})

test('a sign-in popup on another origin redirects at once, answers its opener and closes itself', { skip }, async (t) => {
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
  assert.deepEqual(await within(popup.gone, defaultTimeouts.assertion, 'the popup did not close itself'), { kind: 'closed' })
  assert.equal(popup.closed(), true)
  // The page is gone, so a look at it fails as a lost page, at once.
  assert.equal(failureOf(await popup.page.execute({ kind: 'observe', locator: { by: 'testId', value: 'sign-in' } }, 1000)).class, 'session_lost')
})

test('a popup that closes itself is told gone, and its opener sees it closed', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'flash')
  assert.equal(pathOf(first?.url), '/popups/closing')
  assert.deepEqual(await within(popup.gone, defaultTimeouts.assertion, 'the popup did not close itself'), { kind: 'closed' })
  await observeUntil(page, 'status', (seen) => seen.text === 'Popup closed')
  // A popup that went is disposed with nothing left to do, and closing it again is refused.
  assert.deepEqual(failureOf(await popup.page.execute({ kind: 'close' }, 1000)).class, 'session_lost')
  await popup.page.dispose(defaultTimeouts.cleanup)
})

test('close closes a popup and waits for it to go, and the opener stays', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup } = await popupFrom(page, 'help')
  assert.deepEqual(await popup.page.execute({ kind: 'close' }, defaultTimeouts.cleanup), { ok: true, kind: 'close' })
  assert.deepEqual(await within(popup.gone, defaultTimeouts.cleanup, 'the closed popup is not gone'), { kind: 'closed' })
  assert.equal(popup.closed(), true)
  assert.equal((await observe(page, 'status')).text, 'Ready')
})

// WebKit difference 11: Retest answers no dialog on WebKit, so the beforeunload dialog a close opens holds the popup.
test("close runs the popup's beforeunload, whose dialog holds the popup and fails the close by name, and the popup still goes when it is disposed", { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup } = await popupFrom(page, 'dialogs')
  assertOk(await check(popup.page, 'guard'))
  assert.deepEqual(popup.page.armDialog?.(1000), { ok: false, failure: { class: 'unsupported', message: 'Retest hands dialogs to a test on Chrome and Chromium only, and not on WebKit yet.' } })
  const { value: closing, ms } = await timed(popup.page.execute({ kind: 'close' }, 3000))
  assert.deepEqual(failureOf(closing), {
    class: 'unsupported',
    message: 'The page opened a beforeunload dialog while Retest tried to close the page. Retest does not answer dialogs yet, and the dialog blocks the page.',
    details: { dialog: 'beforeunload', inputSent: true },
  })
  assert.ok(ms < 2000, `the close failed in ${ms} ms, as the dialog opened`)
  assert.equal(popup.closed(), false, 'the popup stayed open behind its dialog')
  await popup.page.dispose(defaultTimeouts.cleanup)
  assert.deepEqual(await within(popup.gone, defaultTimeouts.cleanup, 'the disposed popup is not gone'), { kind: 'closed' })
})

test('a wait that sees no page fails when its time runs out, and a page waits for one popup at a time', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  assert.ok(page.armPopup !== undefined)
  const arming = await page.armPopup({ timeoutMs: 300, setupMs })
  assert.ok(arming.ok)
  assert.deepEqual(await page.armPopup({ timeoutMs: 300, setupMs }), { ok: false, failure: { class: 'usage', message: 'page.popup() is already waiting for a page on this page. Await it before the next one.' } })
  assert.deepEqual(await arming.opened, { ok: false, failure: { class: 'timeout', message: 'No page opened within 300 ms.' } })
})

test('a wait its caller stops ends with the reason it was given', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  assert.ok(page.armPopup !== undefined)
  const stop = new AbortController()
  const arming = await page.armPopup({ timeoutMs: 3000, setupMs, signal: stop.signal })
  assert.ok(arming.ok)
  stop.abort({ class: 'interrupted', message: 'The action failed before a page opened.' })
  assert.deepEqual(await arming.opened, { ok: false, failure: { class: 'interrupted', message: 'The action failed before a page opened.' } })
})

test('a page opened while nothing waited runs on, and a later wait is given only the page opened after it began', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  assertOk(await click(page, 'help'))
  const { popup, first } = await popupFrom(page, 'terms')
  assert.equal(pathOf(first?.url), '/popups/terms')
  assert.equal((await observe(popup.page, 'email')).count, 1)
  await popup.page.dispose(defaultTimeouts.cleanup)
})

test('a popup has the screen of the page that opened it, and opens popups of its own', { skip }, async (t) => {
  const { page } = await popupsPage(t, browser(), undefined, { emulation: { viewport: { width: 640, height: 480 }, deviceScaleFactor: 1, touch: false, isMobile: false } })
  const { popup } = await popupFrom(page, 'size')
  assert.equal((await observe(popup.page, 'size')).text, '640x480')
  const { popup: again } = await popupFrom(page, 'again')
  const { popup: nested, first } = await popupFrom(again.page, 'help')
  assert.equal(pathOf(first?.url), '/popups/help')
  assert.equal((await observe(nested.page, 'help-text')).text, 'Ask us anything.')
  await nested.page.dispose(defaultTimeouts.cleanup)
  await again.page.dispose(defaultTimeouts.cleanup)
  await popup.page.dispose(defaultTimeouts.cleanup)
})

test('a popup is a web session of its own: it can be named and pictured, apart from its opener', { skip }, async (t) => {
  const { page } = await popupsPage(t)
  const { popup } = await popupFrom(page, 'help')
  const session: WebSession = popup.page
  session.identify?.({ sessionId: 'attempt1:web/popup-1', owner: { runId: 'run1', testId: 'popups', attemptId: 'attempt1', app: 'web/popup-1' }, runtime: { kind: 'web', engine: 'webkit', product: 'WebKit', version: '2359', executablePath: webKitPath(), processIds: [] } })
  const png = await session.screenshot(defaultTimeouts.action)
  assert.ok(png.byteLength > 0)
  await popup.page.dispose(defaultTimeouts.cleanup)
  await within(popup.gone, defaultTimeouts.cleanup, 'the disposed popup is not gone')
  // The opener's context stays: the opener still answers.
  assert.equal((await observe(page, 'status')).text, 'Ready')
})

// WebKit difference 11: a dialog holds every page of its web process, and a page `window.open` opened to its own site
// shares its opener's, so a look at the opener waits out its time and says which dialog another page shows.
test("a dialog in a page opened while nothing waited holds its opener, whose look times out naming the dialog", { skip }, async (t) => {
  const { app, page } = await popupsPage(t)
  assertOk(await click(page, 'alerting'))
  const count = async (path: string): Promise<number> => Number(await (await fetch(`${app.url}${path}`)).text())
  await waitFor(async () => (await count('/popups/alerting/ready')) === 1, 'the alerting page to be ready')
  await fetch(`${app.url}/dialogs/signal`, { method: 'POST' })
  const result = await waitForHeld(page)
  assert.deepEqual(result, {
    class: 'timeout',
    message: "The page did not answer within 500 ms while Retest tried to read getByTestId('status'). Another page of this test shows an alert dialog, and WebKit holds every page of a web process while one of them shows a dialog, which Retest does not answer on WebKit yet.",
    details: { inputSent: false, dialogElsewhere: 'alert' },
  })
  assert.equal(await count('/dialogs/alerted'), 0, 'nothing answered the alert')
})

// The opener answers until the alert opens, a moment after the signal; from then on a look waits out its time.
async function waitForHeld(page: OwnedPage): Promise<unknown> {
  const end = performance.now() + 5000
  for (;;) {
    const result = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'status' } }, 500)
    if (!result.ok) return result.failure
    if (performance.now() > end) assert.fail('the opener still answered 5 s after the alert was signalled')
  }
}

test('disposing pages leaves no popup page behind: a popup closes its own page, and an opener takes the rest with its context', { skip }, async (t) => {
  const { browser: owned, pages } = await launchCounting(t)
  const { page } = await popupsPage(t, owned)
  const before = pages().size
  const handed = await popupFrom(page, 'help')
  // One more popup nobody waited for.
  assertOk(await click(page, 'terms'))
  await waitFor(() => pages().size === before + 2, 'the two popups to open')
  await handed.popup.page.dispose(defaultTimeouts.cleanup)
  await within(handed.popup.gone, defaultTimeouts.cleanup, 'the disposed popup is not gone')
  assert.equal(pages().size, before + 1)
  await page.dispose(defaultTimeouts.cleanup)
  await waitFor(() => pages().size === before - 1, 'the popups of a disposed page to go')
})

// A WebKit browser of its own whose pipe this test also reads, counting the page proxies the build announces and
// destroys. It is closed, and its process group checked, after the test.
async function launchCounting(t: TestContext): Promise<{ browser: OwnedBrowser; pages: () => ReadonlySet<string> }> {
  const folder = await scratchFolder(t)
  const open = new Set<string>()
  const owned = await launchWebKit({ buildPath: webKitPath(), buildSource: 'RETEST_TEST_WEBKIT', logFile: join(folder, 'webkit.log'), headless: true }, setupMs, (streams) => {
    const inner = new PipeTransport(streams)
    return {
      listen(handlers) {
        inner.listen({
          ...handlers,
          message(text) {
            const message: unknown = JSON.parse(text)
            const params = isRecord(message) && isRecord(message['params']) ? message['params'] : undefined
            const id = typeof params?.['pageProxyId'] === 'string' ? params['pageProxyId'] : undefined
            if (isRecord(message) && message['method'] === 'Playwright.pageProxyCreated' && id !== undefined) open.add(id)
            if (isRecord(message) && message['method'] === 'Playwright.pageProxyDestroyed' && id !== undefined) open.delete(id)
            handlers.message(text)
          },
        })
      },
      send: (text) => inner.send(text),
      close: () => inner.close(),
    }
  })
  t.after(async () => {
    await owned.close(closeMs)
    assert.equal(groupExists(owned.pid), false, `process group ${owned.pid} should be gone`)
  })
  return { browser: owned, pages: () => open }
}

function runTests(partner: string): string {
  return `import { expect, test } from '@rehearsal-labs/retest'

test('drives the page a link opens', async ({ page }) => {
  await page.goto('/popups')
  const terms = await page.popup(() => page.getByRole('link', { name: 'Terms' }).click())
  await expect(terms.getByRole('heading', { name: 'Terms' })).toBeVisible()
  await expect(terms).toHaveTitle('Terms')
  await terms.getByLabel('Email').fill('alice@example.com')
  await terms.getByRole('button', { name: 'Save' }).click()
  await expect(terms.getByTestId('saved')).toHaveText('Saved alice@example.com')
  await expect(page.getByRole('status')).toHaveText('Ready')
  await page.getByRole('button', { name: 'Open help' }).click()
  await terms.close()
})

test('signs in through a partner popup', async ({ page }) => {
  await page.goto(${JSON.stringify(`/popups?partner=${encodeURIComponent(partner)}`)})
  const partner = await page.popup(() => page.getByRole('button', { name: 'Sign in with Partner' }).click())
  await partner.getByLabel('Email').fill('alice@example.com')
  await partner.getByLabel('Password').fill('correct horse')
  await partner.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('status')).toHaveText('Signed in as alice@example.com')
})

test('a popup that closes itself', async ({ page }) => {
  await page.goto('/popups')
  const flash = await page.popup(() => page.getByRole('button', { name: 'Open and close' }).click())
  await expect(page.getByRole('status')).toHaveText('Popup closed')
  await flash.getByRole('heading').click()
})

test('a failed check in a popup', async ({ page }) => {
  await page.goto('/popups')
  const help = await page.popup(() => page.getByRole('button', { name: 'Open help' }).click())
  await expect(help.getByTestId('help-text')).toHaveText('We never answer.')
})

test("close() on the test's own page", async ({ page }) => {
  await page.goto('/popups')
  await page.close()
})

test("a popup's beforeunload on close", async ({ page }) => {
  await page.goto('/popups')
  const draft = await page.popup(() => page.getByRole('button', { name: 'Open dialogs' }).click())
  await draft.getByTestId('guard').check()
  await draft.close()
})
`
}

test('a run on WebKit drives popups, writes their opening and closing, pictures a failed one and closes each as the test ends', { skip }, async (t) => {
  const app = await openApp(t)
  const partner = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: { browser: 'webkit', executablePath: ${JSON.stringify(webKitPath())}, baseUrl: ${JSON.stringify(app.url)} } } }`),
    'tests/popups.retest.ts': runTests(partner.url),
  })
  const run = await runProject(t, root, { timeouts: budgets() })
  assert.equal(run.exit.code, 1, run.stderr)
  const scoped = <T extends { testId: string }>(events: readonly T[], name: string): T[] => events.filter((event) => event.testId === testNamed(run, name).testId)

  for (const name of ['drives the page a link opens', 'signs in through a partner popup']) {
    const found = testNamed(run, name)
    assert.deepEqual([found.status, found.failure?.message ?? null], ['passed', null], name)
  }
  const linked = testNamed(run, 'drives the page a link opens')
  const [opened, ...others] = scoped(eventsOf(run.events, 'popup.opened'), linked.name)
  assert.equal(others.length, 0, 'the help page the opener opened while nothing waited is no popup of the test')
  assert.deepEqual([opened?.session, opened?.popup, opened?.url, opened?.title, opened?.location?.line], ['web', 'web/popup-1', `${app.url}/popups/terms`, 'Terms', 5])
  assert.equal(opened?.popupSessionId, `${opened?.attemptId}:web/popup-1`)
  const actions = scoped(eventsOf(run.events, 'action.completed'), linked.name).map((event) => [event.session, event.command, event.sessionId?.endsWith(`:${event.session}`)])
  assert.deepEqual(actions, [
    ['web', 'goto', true],
    ['web', 'click', true],
    ['web/popup-1', 'fill', true],
    ['web/popup-1', 'click', true],
    ['web', 'click', true],
    ['web/popup-1', 'close', true],
  ])
  const popupNavigations = scoped(eventsOf(run.events, 'navigation'), linked.name).filter((event) => event.session === 'web/popup-1')
  assert.deepEqual(popupNavigations.map((event) => [event.url, event.title]), [[`${app.url}/popups/terms`, 'Terms']])

  const signedIn = testNamed(run, 'signs in through a partner popup')
  const [partnerOpened] = scoped(eventsOf(run.events, 'popup.opened'), signedIn.name)
  assert.equal(partnerOpened?.url, `${partner.url}/popups/partner`)
  const partnerNavigations = scoped(eventsOf(run.events, 'navigation'), signedIn.name).filter((event) => event.session === 'web/popup-1').map((event) => event.url)
  assert.deepEqual(partnerNavigations, [`${partner.url}/popups/partner`, `${partner.url}/popups/partner/sign-in`])

  const flash = testNamed(run, 'a popup that closes itself')
  assert.deepEqual([flash.status, flash.failure?.class, flash.failure?.message], ['failed', 'not_actionable', 'This page closed itself, so Retest sent nothing to it.'])
  assert.deepEqual(scoped(eventsOf(run.events, 'popup.closed'), flash.name).map((event) => event.session), ['web/popup-1'])
  assert.deepEqual(scoped(eventsOf(run.events, 'evidence.captured'), flash.name).map((event) => event.session), ['web'])

  // A failed check in a popup takes a screenshot of the popup, beside its opener's, each named by its app.
  const failed = testNamed(run, 'a failed check in a popup')
  assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'check_failed'])
  const pictured = scoped(eventsOf(run.events, 'evidence.captured'), failed.name)
  assert.deepEqual(pictured.map((event) => event.session).sort(), ['web', 'web/popup-1'])
  for (const picture of pictured) assert.ok(existsSync(join(run.output, picture.path)), picture.path)
  assert.deepEqual(scoped(eventsOf(run.events, 'assertion.failed'), failed.name).map((event) => event.session), ['web/popup-1'])

  const own = testNamed(run, "close() on the test's own page")
  assert.deepEqual([own.status, own.failure?.class, own.failure?.message], ['failed', 'usage', "close() closes a page the app opened, which page.popup() gave. Retest closes the test's own pages when the test ends."])

  // WebKit difference 11: the beforeunload dialog the close opens holds the popup, and the close fails by name.
  const guarded = testNamed(run, "a popup's beforeunload on close")
  assert.deepEqual([guarded.failure?.class, guarded.failure?.message], ['unsupported', 'The page opened a beforeunload dialog while Retest tried to close the page. Retest does not answer dialogs yet, and the dialog blocks the page.'])
  assert.deepEqual(scoped(eventsOf(run.events, 'popup.closed'), guarded.name), [])
  assert.deepEqual(guarded.cleanupFailures ?? [], [])
})
