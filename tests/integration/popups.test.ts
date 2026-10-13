import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'

// The pages a test's page opens, through `retest run`, on Chrome: a link's page read and acted on, a partner's sign-in on
// another origin that answers its opener and closes itself, a page that closes itself, a popup's beforeunload on
// close(), and a failed check in a popup, whose screenshot is the popup's own. Events, the HTML report and `inspect`
// name each popup's steps as its own.

function tests(appUrl: string, partner: string): string {
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

test("answers a popup's beforeunload on close", async ({ page }) => {
  await page.goto('/popups')
  const draft = await page.popup(() => page.getByRole('button', { name: 'Open dialogs' }).click())
  await draft.getByTestId('guard').check()
  const dialog = await draft.dialog(() => draft.close())
  expect(dialog.type).toBe('beforeunload')
  await dialog.accept()
  await expect(page.getByRole('status')).toHaveText('Ready')
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

test("closes a popup whose beforeunload Retest answers", async ({ page }) => {
  await page.goto('/popups')
  const draft = await page.popup(() => page.getByRole('button', { name: 'Open dialogs' }).click())
  await draft.getByTestId('guard').check()
  await draft.close().catch(() => undefined)
  await draft.getByTestId('status').click()
})

test('a dialog in a page opened while nothing waited fails the test', async ({ page }) => {
  await page.goto('/popups')
  await page.getByRole('button', { name: 'Open alerting' }).click()
  await signalAlerting()
  await expect(page.getByRole('status')).toHaveText('Ready')
})

// Waits until the alerting page is ready for the signal, sends it, and returns once the page says its alert was answered.
async function signalAlerting() {
  const count = async (path) => Number(await (await fetch(${JSON.stringify(appUrl)} + path)).text())
  while ((await count('/popups/alerting/ready')) < 1) await new Promise((resolve) => setTimeout(resolve, 20))
  const before = await count('/dialogs/alerted')
  await fetch(${JSON.stringify(appUrl)} + '/dialogs/signal', { method: 'POST' })
  while ((await count('/dialogs/alerted')) === before) await new Promise((resolve) => setTimeout(resolve, 20))
}
`
}

test('popups are handed to the test as pages of their own, written down, pictured and closed', async (t) => {
  const app = await openApp(t)
  const partner = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/popups.retest.ts': tests(app.url, partner.url),
  })
  const run = await runProject(t, root, { timeouts: budgets({ action: 3000, assertion: 2000 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  for (const name of ['drives the page a link opens', 'signs in through a partner popup', "answers a popup's beforeunload on close"]) {
    const found = testNamed(run, name)
    assert.deepEqual([found.status, found.failure?.message ?? null], ['passed', null], name)
  }
  const scoped = <T extends { testId: string }>(events: readonly T[], name: string): T[] => events.filter((event) => event.testId === testNamed(run, name).testId)

  // Opening a popup is a step with its first address and title; the popup's steps carry its own app and session.
  const linked = testNamed(run, 'drives the page a link opens')
  const [opened, ...others] = scoped(eventsOf(run.events, 'popup.opened'), linked.name)
  assert.equal(others.length, 0)
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
  // The help page the opener opened while nothing waited is no popup of the test.
  assert.equal(scoped(eventsOf(run.events, 'popup.opened'), linked.name).length, 1)

  const signedIn = testNamed(run, 'signs in through a partner popup')
  const [partnerOpened] = scoped(eventsOf(run.events, 'popup.opened'), signedIn.name)
  // The partner's first page sends the popup on before its title can be read, so it has none, as any such page has.
  assert.deepEqual([partnerOpened?.url, partnerOpened?.title], [`${partner.url}/popups/partner`, undefined])
  const partnerNavigations = scoped(eventsOf(run.events, 'navigation'), signedIn.name).filter((event) => event.session === 'web/popup-1').map((event) => event.url)
  assert.deepEqual(partnerNavigations, [`${partner.url}/popups/partner`, `${partner.url}/popups/partner/sign-in`])

  const flash = testNamed(run, 'a popup that closes itself')
  assert.deepEqual([flash.status, flash.failure?.class, flash.failure?.message], ['failed', 'not_actionable', 'This page closed itself, so Retest sent nothing to it.'])
  assert.deepEqual(scoped(eventsOf(run.events, 'popup.closed'), flash.name).map((event) => event.session), ['web/popup-1'])
  // A closed popup is no page to picture: only the opener's screenshot was taken, and nothing is missing.
  assert.deepEqual(scoped(eventsOf(run.events, 'evidence.captured'), flash.name).map((event) => event.session), ['web'])
  assert.deepEqual(scoped(eventsOf(run.events, 'evidence.failed'), flash.name), [])

  const unload = testNamed(run, "answers a popup's beforeunload on close")
  assert.deepEqual(scoped(eventsOf(run.events, 'dialog'), unload.name).map((event) => [event.session, event.dialog, event.answer, event.by]), [['web/popup-1', 'beforeunload', 'accepted', 'test']])
  assert.deepEqual(scoped(eventsOf(run.events, 'popup.closed'), unload.name), [])

  // A failed check in a popup takes a screenshot of the popup, beside its opener's, each named by its app.
  const failed = testNamed(run, 'a failed check in a popup')
  assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'check_failed'])
  const pictured = scoped(eventsOf(run.events, 'evidence.captured'), failed.name)
  assert.deepEqual(pictured.map((event) => event.session).sort(), ['web', 'web/popup-1'])
  for (const picture of pictured) assert.ok(existsSync(join(run.output, picture.path)), picture.path)
  assert.deepEqual(failed.evidence?.map((item) => item.app).sort(), ['web', 'web/popup-1'])
  const failedCheck = scoped(eventsOf(run.events, 'assertion.failed'), failed.name)
  assert.deepEqual(failedCheck.map((event) => [event.session, event.sessionId?.endsWith(':web/popup-1')]), [['web/popup-1', true]])

  // A popup is neither watched for diagnostics nor recorded, and its record says so.
  const popupDiagnostics = linked.diagnostics?.find((summary) => summary.sessionId.endsWith(':web/popup-1'))
  assert.deepEqual([popupDiagnostics?.console, popupDiagnostics?.network], [{ state: 'unavailable', reason: 'popups are not captured' }, { state: 'unavailable', reason: 'popups are not captured' }])
  assert.equal(linked.diagnostics?.find((summary) => summary.sessionId.endsWith(':web'))?.console.state, 'complete')

  // A close whose beforeunload Retest answered fails, as no dialog is answered as a pass, and the popup still went:
  // it is closed by the test, so the next command is refused as one after close(), and it is neither pictured nor
  // closed again.
  const answered = testNamed(run, 'closes a popup whose beforeunload Retest answers')
  assert.deepEqual([answered.status, answered.failure?.class, answered.failure?.message], ['failed', 'not_actionable', 'The page opened a beforeunload dialog while Retest tried to close the page. Retest accepted it, so the page could leave. To answer it, wrap the action in page.dialog().'])
  assert.deepEqual(scoped(eventsOf(run.events, 'dialog'), answered.name).map((event) => [event.session, event.dialog, event.answer, event.by]), [['web/popup-1', 'beforeunload', 'accepted', 'retest']])
  const refusedAfter = scoped(eventsOf(run.events, 'action.failed'), answered.name).filter((event) => event.session === 'web/popup-1' && event.command === 'click')
  assert.deepEqual(refusedAfter.map((event) => [event.failure.class, event.failure.message]), [['usage', 'This page was closed by close() at tests/popups.retest.ts:57, so Retest sent nothing to it.']])
  assert.deepEqual(scoped(eventsOf(run.events, 'popup.closed'), answered.name), [])
  assert.deepEqual(scoped(eventsOf(run.events, 'evidence.captured'), answered.name).map((event) => event.session), ['web'])
  assert.deepEqual(answered.cleanupFailures ?? [], [])

  // A page opened while nothing waited is kept: its alert is answered, and fails the test as its opener's.
  const alerting = testNamed(run, 'a dialog in a page opened while nothing waited fails the test')
  assert.deepEqual([alerting.status, alerting.failure?.class], ['failed', 'not_actionable'])
  assert.equal(alerting.failure?.message, 'A page this page opened showed an alert dialog that says "From the page it opened" while no action was running. Retest dismissed it. To answer it, take that page with page.popup() and wrap its action in dialog().')
  assert.deepEqual(scoped(eventsOf(run.events, 'dialog'), alerting.name).map((event) => [event.session, event.dialog, event.message, event.answer, event.by]), [['web', 'alert', 'From the page it opened', 'dismissed', 'retest']])
  assert.equal(scoped(eventsOf(run.events, 'popup.opened'), alerting.name).length, 0, 'a page nothing waited for is no popup of the test')

  const own = testNamed(run, "close() on the test's own page")
  assert.deepEqual([own.status, own.failure?.class, own.failure?.message], ['failed', 'usage', "close() closes a page the app opened, which page.popup() gave. Retest closes the test's own pages when the test ends."])

  // The report shows each popup's steps under its own app, after the step that opened it.
  const report = await runCli(t, ['report', run.output])
  assert.equal(report.exit.code, 0, report.stderr)
  const html = await readFile(join(run.output, 'report.html'), 'utf8')
  assert.match(html, /popup web\/popup-1 opened &quot;Terms&quot; at http:\/\/127\.0\.0\.1:\d+\/popups\/terms/)
  assert.ok(html.includes('<td class="app">web/popup-1</td>'), 'the report names the popup as the app of its rows')
  const inspected = await runCli(t, ['inspect', run.output, '--test', 'tests/popups.retest.ts > drives the page a link opens'])
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.match(inspected.stdout, /web\/popup-1 {2}fill getByLabel\('Email'\)/)
})

const popupPassword = 'popup-secret-7c41d2'
const partnerPassword = 'partner-secret-0b9e55'

// A popup in a run whose app is emulated, records, allows no screenshots, and holds two secrets, one of which may also
// be typed on the partner's origin.
function capturedTests(partner: string): string {
  const partnerPath = JSON.stringify(`/popups?partner=${encodeURIComponent(partner)}`)
  return `import { expect, secret, test } from '@rehearsal-labs/retest'

test('a popup has the emulation of the page that opened it', async ({ page }) => {
  await page.goto('/popups')
  const sized = await page.popup(() => page.getByRole('button', { name: 'Open size' }).click())
  await expect(sized.getByTestId('size')).toHaveText('640x480')
})

test('a popup of a popup is named after it, and follows the capture rules of the app that opened the first', async ({ page }) => {
  await page.goto('/popups')
  const again = await page.popup(() => page.getByRole('button', { name: 'Open popups' }).click())
  const help = await again.popup(() => again.getByRole('button', { name: 'Open help' }).click())
  await expect(help.getByTestId('help-text')).toHaveText('We never answer.')
})

test('types a secret on a popup whose origin the secret allows', async ({ page }) => {
  await page.goto(${partnerPath})
  const partner = await page.popup(() => page.getByRole('button', { name: 'Sign in with Partner' }).click())
  await partner.getByLabel('Email').fill('alice@example.com')
  await partner.getByLabel('Password').fill(secret('partner'))
  await partner.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('status')).toHaveText('Signed in as alice@example.com')
})

test('refuses a secret on a popup whose origin the secret does not allow', async ({ page }) => {
  await page.goto(${partnerPath})
  const partner = await page.popup(() => page.getByRole('button', { name: 'Sign in with Partner' }).click())
  await partner.getByLabel('Password').fill(secret('password'))
})
`
}

test("a popup has its opener's emulation and capture rules, a secret is typed on it only where allowed, and a popup's popup is named after it", async (t) => {
  const app = await openApp(t)
  const partner = await openApp(t)
  const config = `{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)}, viewport: { width: 640, height: 480 } }) },
  secrets: { password: env('RETEST_POPUP_PASSWORD'), partner: env('RETEST_PARTNER_PASSWORD') },
  secretOrigins: { partner: [${JSON.stringify(partner.url)}] },
  pixels: { web: { screenshots: 'never' } },
  recording: { record: true, fps: 10, size: { width: 320, height: 240 } },
}`
  const root = await writeProject(t, { 'retest.config.ts': configSource(config), 'tests/captured.retest.ts': capturedTests(partner.url) })
  const run = await runProject(t, root, { timeouts: budgets({ action: 3000, assertion: 2000 }), env: { RETEST_POPUP_PASSWORD: popupPassword, RETEST_PARTNER_PASSWORD: partnerPassword } })
  assert.equal(run.exit.code, 1, run.stderr)
  const scoped = <T extends { testId: string }>(events: readonly T[], name: string): T[] => events.filter((event) => event.testId === testNamed(run, name).testId)

  const sized = testNamed(run, 'a popup has the emulation of the page that opened it')
  assert.deepEqual([sized.status, sized.failure?.message ?? null], ['passed', null])

  // A popup's own popup is named after it, and its steps carry that name.
  const nested = testNamed(run, 'a popup of a popup is named after it, and follows the capture rules of the app that opened the first')
  assert.deepEqual([nested.status, nested.failure?.class], ['failed', 'check_failed'])
  assert.deepEqual(scoped(eventsOf(run.events, 'popup.opened'), nested.name).map((event) => [event.session, event.popup, event.popupSessionId.endsWith(`:${event.popup}`)]), [
    ['web', 'web/popup-1', true],
    ['web/popup-1', 'web/popup-1/popup-1', true],
  ])
  assert.deepEqual(scoped(eventsOf(run.events, 'assertion.failed'), nested.name).map((event) => event.session), ['web/popup-1/popup-1'])
  // The app allows no screenshots, so neither it nor a popup of it is pictured when the test fails.
  assert.deepEqual(scoped(eventsOf(run.events, 'evidence.captured'), nested.name), [])
  assert.deepEqual(nested.evidence ?? [], [])

  // The run records the app, and each popup has a recording that never began, which says why; so the attempt's
  // evidence is partial, never complete.
  const recordings = nested.recordings ?? []
  assert.deepEqual(recordings.map((recording) => [recording.app, recording.status]), [
    ['web', 'complete'],
    ['web/popup-1', 'unavailable'],
    ['web/popup-1/popup-1', 'unavailable'],
  ])
  assert.deepEqual(recordings[1]?.gaps, [{ code: 'no_frame_source', message: 'Popups are not captured, so Retest did not record this page.', app: 'web/popup-1', sessionId: `${nested.attemptId}:web/popup-1` }])
  assert.equal(nested.evidenceStatus?.state, 'partial')
  assert.deepEqual(nested.diagnostics?.map((summary) => [summary.sessionId.slice(summary.sessionId.indexOf(':') + 1), summary.console.state]), [
    ['web', 'complete'],
    ['web/popup-1', 'unavailable'],
    ['web/popup-1/popup-1', 'unavailable'],
  ])

  // A secret the partner's origin is allowed is typed there; one it is not allowed is refused, and nothing is typed.
  const allowed = testNamed(run, 'types a secret on a popup whose origin the secret allows')
  assert.deepEqual([allowed.status, allowed.failure?.message ?? null], ['passed', null])
  const refused = testNamed(run, 'refuses a secret on a popup whose origin the secret does not allow')
  assert.deepEqual([refused.status, refused.failure?.class], ['failed', 'not_actionable'])
  assert.ok(refused.failure?.message.includes(partner.url), refused.failure?.message)
  assert.deepEqual(scoped(eventsOf(run.events, 'action.completed'), refused.name).filter((event) => event.command === 'fill'), [])
  assert.deepEqual(filesHolding(run.output, popupPassword), [])
  assert.deepEqual(filesHolding(run.output, partnerPassword), [])
})
