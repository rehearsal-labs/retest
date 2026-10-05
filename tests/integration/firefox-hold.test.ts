import type { TestContext } from 'node:test'
import type { FirefoxBrowser } from '../../src/browser/firefox/browser.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { byTestId, closeMs, observe, openPage, scratchFolder, servePages, setupMs } from './browser-harness.ts'
import { firefoxPath, testFirefoxRoute } from './engines.ts'

// The navigation hold a Firefox fill bound to origins keeps while it types, on the real browser (review F-3 and F-10):
// it holds only a navigation of the tab's own document, lets every other request go on at once, releases everything it
// paused, and is armed only right before the input, so the page's own navigation during the wait for the field is let go.

const onFirefoxHost = process.platform === 'darwin' && process.arch === 'arm64'
const skip = onFirefoxHost ? false : 'Retest runs Firefox on macOS on Apple silicon only'
const secretValue = 'correct-horse-battery-staple-held'

async function firefox(t: TestContext): Promise<FirefoxBrowser> {
  const folder = await scratchFolder(t)
  const browser = await launchFirefox({ executablePath: firefoxPath(), logFile: join(folder, 'browser.log'), headless: true, route: testFirefoxRoute() }, setupMs * 3)
  t.after(() => browser.close(closeMs).catch(() => undefined))
  return browser
}

// A frame that posts every 40 ms and counts the posts it started and the ones that settled, as a captcha, payment or
// sign-in frame polls beside a password field.
const POLLING_FRAME = `<!doctype html><p>frame</p><script>
  window.stats = { started: 0, settled: 0 }
  setInterval(() => {
    window.stats.started += 1
    fetch('/ping', { method: 'POST' }).then(() => { window.stats.settled += 1 }, () => { window.stats.settled += 1 })
  }, 40)
</script>`

const SIGN_IN_WITH_FRAME = `<!doctype html><input data-testid="password" type="password" style="width: 300px">
<p data-testid="stats">none</p>
<iframe src="/frame" style="width: 300px; height: 80px"></iframe>
<script>
  setInterval(() => {
    const stats = frames[0] && frames[0].stats
    if (stats) document.querySelector('[data-testid="stats"]').textContent = stats.started + ' ' + stats.settled
  }, 50)
</script>`

test("every request a frame makes while a secret fill bound to origins types arrives, and none is left paused", { skip }, async (t) => {
  const browser = await firefox(t)
  const site = await servePages(t, { '/': SIGN_IN_WITH_FRAME, '/frame': POLLING_FRAME })
  const page = await openPage(t, browser, site.url)
  const went = await page.execute({ kind: 'goto', url: '/' }, setupMs)
  assert.ok(went.ok, JSON.stringify(went))
  await delay(500)
  for (let round = 0; round < 3; round += 1) {
    const filled = await page.execute({ kind: 'fill', locator: byTestId('password'), value: secretValue, secret: 'password', allowedOrigins: [site.url] }, setupMs)
    assert.ok(filled.ok, JSON.stringify(filled))
  }
  // Everything the frame started settles at once once the fills are done: none waits on a hold that has gone.
  await delay(1000)
  const stats = (await observe(page, 'stats')).text ?? ''
  const [started, settled] = stats.split(' ').map(Number)
  assert.ok(started !== undefined && settled !== undefined && started > 20, `the frame kept posting: ${stats}`)
  assert.ok(started - settled <= 2, `at most the posts on their way are unsettled, not ones the hold kept: ${stats}`)
  assert.ok(site.posts('/ping') >= settled - 2, `the server received what settled: ${site.posts('/ping')} of ${settled}`)
  assert.equal((await observe(page, 'password')).value?.length, secretValue.length, 'the field holds the whole value')
})

// The page opens the next step of its sign-in on its own 100 ms after loading, while its field is still disabled; the
// field of the first document would be enabled only after 300 ms.
const REDIRECTING_SIGN_IN = `<!doctype html><input data-testid="password" type="password" disabled style="width: 300px">
<script>
  setTimeout(() => location.replace('/login?step=2'), 100)
  setTimeout(() => { document.querySelector('[data-testid="password"]').disabled = false }, 300)
</script>`
const SECOND_STEP = `<!doctype html><p data-testid="step">second step</p><input data-testid="password" type="password" style="width: 300px">`

test('a navigation the page starts while a secret fill waits for its field is the page’s own, and the fill types into the document it opened', { skip }, async (t) => {
  const browser = await firefox(t)
  const site = await servePages(t, { '/login': REDIRECTING_SIGN_IN, '/login?step=2': SECOND_STEP })
  const page = await openPage(t, browser, site.url)
  for (let round = 0; round < 3; round += 1) {
    const went = await page.execute({ kind: 'goto', url: '/login' }, setupMs)
    assert.ok(went.ok, JSON.stringify(went))
    const filled = await page.execute({ kind: 'fill', locator: byTestId('password'), value: secretValue, secret: 'password', allowedOrigins: [site.url] }, setupMs)
    assert.ok(filled.ok, `round ${round}: ${JSON.stringify(filled)}`)
    assert.equal((await observe(page, 'step')).text, 'second step', 'the page went where it was going')
    assert.equal((await observe(page, 'password')).value?.length, secretValue.length, 'the next document holds the whole value')
  }
})
