import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage, PageNavigation, WebSession } from '../../src/browser/contract.ts'
import type { Transport, TransportHandlers } from '../../src/browser/cdp/transport.ts'
import type { UnwaitedDialog } from '../../src/browser/dialogs.ts'
import type { OpenedPopup } from '../../src/browser/popups.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { PipeTransport } from '../../src/browser/cdp/transport.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { assertOk, browserPath, check, click, closeMs, failureOf, fill, goto, groupExists, observe, observeUntil, openApp, openPage, scratchFolder, setupMs, sharedBrowser, timed, within } from './browser-harness.ts'

// The pages a page opens, on Chrome, against the driver: a page armed for a popup hands over the next page it opens,
// held before its first document, so the popup's first page has Retest's input guard as much as any other. The popup
// is then driven as a page of its own, and closes by its own target, leaving its opener's context.

const browser = sharedBrowser()

async function popupsPage(t: TestContext, on: OwnedBrowser = browser(), partner?: TaskApp): Promise<{ app: TaskApp; page: OwnedPage }> {
  const app = await openApp(t)
  const page = await openPage(t, on, app.url)
  assertOk(await goto(page, partner === undefined ? '/popups' : `/popups?partner=${encodeURIComponent(partner.url)}`))
  return { app, page }
}

// Arms the page for a popup, then clicks what opens it, as page.popup() does. The click is awaited only once the popup
// is set up: a popup window.open made shares its opener's renderer, which is held with it until it runs.
async function popupFrom(page: OwnedPage, target: string, timeoutMs = 5000): Promise<{ popup: OpenedPopup; first: PageNavigation | undefined }> {
  assert.ok(page.armPopup !== undefined, 'a Chromium page hands over the pages it opens')
  const arming = await page.armPopup({ timeoutMs, setupMs })
  assert.ok(arming.ok, JSON.stringify(arming))
  const clicked = click(page, target, timeoutMs)
  const wait = await within(arming.opened, timeoutMs, 'no popup was handed over')
  assert.ok(wait.ok, JSON.stringify(wait))
  const first = await wait.popup.first(timeoutMs)
  assertOk(await clicked)
  return { popup: wait.popup, first }
}

// Waits until the alerting page a page opened has read the signal count, then sends the signal its alert waits for,
// and waits until the page tells the server the alert was answered, which it can only do once Retest has answered it.
async function signalAlerting(appUrl: string): Promise<void> {
  const count = async (path: string): Promise<number> => Number(await (await fetch(`${appUrl}${path}`)).text())
  await waitFor(async () => (await count('/popups/alerting/ready')) === 1, 'the alerting page to be ready')
  const before = await count('/dialogs/alerted')
  await fetch(`${appUrl}/dialogs/signal`, { method: 'POST' })
  await waitFor(async () => (await count('/dialogs/alerted')) > before, 'the alerting page to hear its alert was answered', 5000)
}

// The path of a page's address. A page Chrome holds before its first document has no address yet: its target's URL is
// empty until that document commits, and so is its path.
function pathOf(url: string | undefined): string {
  return url === undefined || url === '' ? '' : new URL(url).pathname
}

test('a link with a target opens a page that is handed over before its first document, and is driven as a page of its own', async (t) => {
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
  await popup.page.dispose(2000)
})

test('a page window.open opens on the same origin is handed over with its first address and title', async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'help')
  assert.equal(pathOf(first?.url), '/popups/help')
  assert.equal(await first?.title, 'Help')
  assert.equal((await observe(popup.page, 'help-text')).text, 'Ask us anything.')
  await popup.page.dispose(2000)
})

test("a sign-in popup on another origin redirects at once, answers its opener and closes itself", async (t) => {
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
  // The page is gone with its target, so a look at it fails as a lost page, at once.
  assert.equal(failureOf(await popup.page.execute({ kind: 'observe', locator: { by: 'testId', value: 'sign-in' } }, 1000)).class, 'session_lost')
})

test('a popup that closes itself is told gone, and its opener sees it closed', async (t) => {
  const { page } = await popupsPage(t)
  const { popup, first } = await popupFrom(page, 'flash')
  assert.equal(pathOf(first?.url), '/popups/closing')
  await within(popup.gone, 3000, 'the popup did not close itself')
  await observeUntil(page, 'status', (seen) => seen.text === 'Popup closed')
  // A popup that went is disposed with nothing left to do.
  await popup.page.dispose(2000)
})

test("close runs the popup's beforeunload: dismissed, the popup stays open; accepted, it closes and its target goes", async (t) => {
  const { page } = await popupsPage(t)
  const { popup } = await popupFrom(page, 'dialogs')
  assertOk(await check(popup.page, 'guard'))
  const dialogs = popup.page
  assert.ok(dialogs.armDialog !== undefined && dialogs.answerDialog !== undefined)
  const staying = dialogs.armDialog(3000)
  assert.ok(staying.ok)
  const closing = dialogs.execute({ kind: 'close' }, 3000)
  const kept = await staying.opened
  assert.ok(kept.ok)
  assert.equal(kept.dialog.type, 'beforeunload')
  assert.deepEqual(await dialogs.answerDialog(kept.dialog.id, { accept: false }, 2000), { ok: true })
  assert.deepEqual(failureOf(await closing), { class: 'not_actionable', message: 'Retest could not close the page: its beforeunload dialog was dismissed, so the page stayed where it was.', details: { dialog: 'beforeunload', inputSent: true } })
  assert.equal((await observe(dialogs, 'status')).text, 'Ready')

  const leaving = dialogs.armDialog(3000)
  assert.ok(leaving.ok)
  const closed = dialogs.execute({ kind: 'close' }, 3000)
  const asked = await leaving.opened
  assert.ok(asked.ok)
  assert.deepEqual(await dialogs.answerDialog(asked.dialog.id, { accept: true }, 2000), { ok: true })
  assert.deepEqual(await closed, { ok: true, kind: 'close' })
  assert.deepEqual(await within(popup.gone, 2000, 'the closed popup is not gone'), { kind: 'closed' })
  assert.equal((await observe(page, 'status')).text, 'Ready')
})

test('a wait that sees no page fails when its time runs out', async (t) => {
  const { page } = await popupsPage(t)
  assert.ok(page.armPopup !== undefined)
  const arming = await page.armPopup({ timeoutMs: 300, setupMs })
  assert.ok(arming.ok)
  assert.deepEqual(await arming.opened, { ok: false, failure: { class: 'timeout', message: 'No page opened within 300 ms.' } })
})

test('a page opened while nothing waited runs on, and a later wait is given only the page opened after it began', async (t) => {
  const { page } = await popupsPage(t)
  assertOk(await click(page, 'help'))
  const { popup, first } = await popupFrom(page, 'terms')
  assert.equal(pathOf(first?.url), '/popups/terms')
  assert.equal((await observe(popup.page, 'email')).count, 1)
  await popup.page.dispose(2000)
})

test("a page opened while nothing waited is kept: its dialog is answered and told as its opener's, and it closes with its opener", async (t) => {
  const { browser: owned, targets } = await launchWithTargets(t)
  const { app, page } = await popupsPage(t, owned)
  const heard: UnwaitedDialog[] = []
  page.onUnwaitedDialog?.((dialog) => heard.push(dialog))
  assertOk(await click(page, 'alerting'))
  await signalAlerting(app.url)
  assert.deepEqual(heard, [{ type: 'alert', message: 'From the page it opened', answered: 'dismissed', during: false, popup: true }])
  // The page it opened shares its renderer, which the alert would hold until answered; the opener goes on at once.
  const { value: status, ms } = await timed(observe(page, 'status'))
  assert.equal(status.text, 'Ready')
  assert.ok(ms < 1000, `the opener answered in ${ms} ms`)
  assert.deepEqual((await popupTargets(targets)).map(pathOf), ['/popups/alerting'])
  await page.dispose(2000)
  await waitFor(async () => (await popupTargets(targets)).length === 0, 'the page it opened to close with it')
})

test('disposing pages leaves no popup target behind: a popup closes its own target, and an opener takes the rest with its context', async (t) => {
  const { browser: owned, targets } = await launchWithTargets(t)
  const { page } = await popupsPage(t, owned)
  const handed = await popupFrom(page, 'help')
  // One more popup nobody waited for, opened in a renderer of its own, whose target has an address once its first
  // document commits.
  assertOk(await click(page, 'terms'))
  await waitFor(async () => (await popupTargets(targets)).map(pathOf).sort().join(' ') === '/popups/help /popups/terms', 'the two popups to open their first documents')
  await handed.popup.page.dispose(2000)
  await within(handed.popup.gone, 2000, 'the disposed popup is not gone')
  assert.deepEqual((await popupTargets(targets)).map(pathOf), ['/popups/terms'])
  await page.dispose(2000)
  await waitFor(async () => (await popupTargets(targets)).length === 0, 'the popups of a disposed page to go')
})

test('a popup is a web session of its own: it can be named and pictured, apart from its opener', async (t) => {
  const { page } = await popupsPage(t)
  const { popup } = await popupFrom(page, 'help')
  const session: WebSession = popup.page
  const png = await session.screenshot(2000)
  assert.ok(png.byteLength > 0)
  await popup.page.dispose(2000)
  await within(popup.gone, 2000, 'the disposed popup is not gone')
  // The opener's context stays: the opener still answers.
  assert.equal((await observe(page, 'status')).text, 'Ready')
})

/** The addresses of every page target another page opened in a browser, read with the browser's own `Target.getTargets`. */
async function popupTargets(targets: () => Promise<TargetInfo[]>): Promise<string[]> {
  return (await targets()).filter((target) => target.type === 'page' && target.openerId !== undefined).map((target) => target.url)
}

type TargetInfo = { type: string; url: string; openerId?: string }

async function waitFor(condition: () => Promise<boolean>, what: string, timeoutMs = 3000): Promise<void> {
  const end = performance.now() + timeoutMs
  while (!(await condition())) {
    if (performance.now() > end) assert.fail(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

// A browser of its own, whose pipe also answers this test's own `Target.getTargets`, under ids Retest never uses. It is
// closed, and its process group checked, after the test, as the harness's own browsers are.
async function launchWithTargets(t: TestContext): Promise<{ browser: OwnedBrowser; targets: () => Promise<TargetInfo[]> }> {
  const folder = await scratchFolder(t)
  const waiting = new Map<number, (result: unknown) => void>()
  let next = 1_000_000_000
  let pipe: Transport | undefined
  const owned = await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'browser.log'), headless: true }, undefined, (streams) => {
    const inner = new PipeTransport(streams)
    pipe = inner
    return {
      listen(handlers: TransportHandlers) {
        inner.listen({
          ...handlers,
          message(text) {
            const message: unknown = JSON.parse(text)
            const id = isRecord(message) ? message['id'] : undefined
            const answer = typeof id === 'number' ? waiting.get(id) : undefined
            if (answer === undefined || typeof id !== 'number' || !isRecord(message)) return handlers.message(text)
            waiting.delete(id)
            answer(message['result'])
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
  const targets = async (): Promise<TargetInfo[]> => {
    const id = next++
    const { promise, resolve } = Promise.withResolvers<unknown>()
    waiting.set(id, resolve)
    pipe?.send(JSON.stringify({ id, method: 'Target.getTargets' }))
    const result = await within(promise, 2000, 'Target.getTargets did not answer')
    const infos = isRecord(result) && Array.isArray(result['targetInfos']) ? result['targetInfos'] : []
    return infos.flatMap((info: unknown) => (isRecord(info) && typeof info['type'] === 'string' && typeof info['url'] === 'string' ? [{ type: info['type'], url: info['url'], ...(typeof info['openerId'] === 'string' ? { openerId: info['openerId'] } : {}) }] : []))
  }
  return { browser: owned, targets }
}
