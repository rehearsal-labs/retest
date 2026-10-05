import type { TestContext } from 'node:test'
import type { OwnedBrowser } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { launchFirefox } from '../../src/browser/firefox/launch.ts'
import { byRole, closeMs, observe, openPage, scratchFolder, servePages, setupMs } from './browser-harness.ts'
import { firefoxPath, testFirefoxRoute } from './engines.ts'

// What Firefox refuses by name where the shared suites expect Chrome's answer, each asserted as the refusal it is, so a
// refusal that quietly turns into a different answer fails here. Each names the shared case it stands beside.

const skip = process.platform === 'darwin' && process.arch === 'arm64' ? false : 'Firefox requires macOS on Apple silicon'

// A one-pixel PNG, which loads.
const loaded = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function firefox(t: TestContext): Promise<OwnedBrowser> {
  const folder = await scratchFolder(t)
  const browser = await launchFirefox({ executablePath: firefoxPath(), route: testFirefoxRoute(), headless: true, logFile: join(folder, 'browser.log') }, setupMs)
  t.after(() => browser.close(closeMs))
  return browser
}

function refusal(result: unknown): { class: string; message: string } {
  assert.ok(typeof result === 'object' && result !== null && 'ok' in result && result.ok === false && 'failure' in result, JSON.stringify(result))
  const failure: unknown = result.failure
  assert.ok(typeof failure === 'object' && failure !== null && 'class' in failure && 'message' in failure)
  return { class: String(failure.class), message: String(failure.message) }
}

// Beside browser-locators "img Logo": an image that did not load is refused, by its own names only. Images that loaded,
// and a lookup no failed image could change, are answered as Chrome answers them.
test('an image that did not load refuses the lookups it could change, by name, and no other image lookup', { skip }, async (t) => {
  const browser = await firefox(t)
  const site = await servePages(t, { '/': `<!doctype html><img alt="Broken" src="data:,"><img alt="Shown" src="${loaded}"><svg role="img" aria-label="Badge" width="16" height="16"></svg>` })
  const page = await openPage(t, browser, site.url)
  assert.ok((await page.execute({ kind: 'goto', url: '/' }, setupMs)).ok)
  assert.equal((await observe(page, byRole('img', 'Shown'))).count, 1)
  assert.equal((await observe(page, byRole('img', 'Badge'))).count, 1)
  for (const locator of [byRole('img', 'Broken'), byRole('img'), byRole('img', 'Show', false)]) {
    const failure = refusal(await page.execute({ kind: 'observe', locator }, setupMs))
    assert.equal(failure.class, 'unsupported')
    assert.match(failure.message, /an image that did not load has different accessibility membership\. Retest cannot judge this lookup on Firefox\./)
  }
})

// A native table without data-table cues stays refused: Chrome may read it as layout. The team data table is
// exercised separately in firefox-native-tables.test.ts, including F8.1a's named-cell refusal.
test('a role lookup in a native layout table is refused by name', { skip }, async (t) => {
  const browser = await firefox(t)
  const site = await servePages(t, {
    '/plain': '<!doctype html><table><tr><td>Ada</td></tr></table>',
    '/hidden-header': '<!doctype html><table><tr><th hidden>Name</th><td>Ada</td></tr></table>',
    '/nested-header': '<!doctype html><table><tr><td><table><tr><th>Name</th></tr><tr><td>Ada</td></tr></table></td></tr></table>',
    '/presentation': '<!doctype html><table role="presentation"><tr><th>Name</th></tr><tr><td>Ada</td></tr></table>',
  })
  const page = await openPage(t, browser, site.url)
  for (const url of ['/plain', '/hidden-header', '/nested-header', '/presentation']) {
    assert.ok((await page.execute({ kind: 'goto', url }, setupMs)).ok)
    const failure = refusal(await page.execute({ kind: 'observe', locator: byRole('row') }, setupMs))
    assert.deepEqual(failure, { class: 'unsupported', message: "Could not look up getByRole('row'): native tables can be layout tables in Chrome and data tables in Firefox. Retest cannot judge this lookup on Firefox. Use a test id or text." }, url)
  }
})

// Beside browser-actions "a scroll delta is in CSS pixels, also on a phone page": a phone is refused before any page opens.
test('a page that asks for a phone is refused by name before it opens', { skip }, async (t) => {
  const browser = await firefox(t)
  const opened = await browser.newPage({ emulation: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, touch: true, isMobile: true } }, setupMs).catch((error: unknown) => error)
  assert.ok(opened instanceof Error && 'failure' in opened)
  assert.deepEqual(opened.failure, { class: 'unsupported', message: 'Firefox cannot emulate a touch screen, a mobile layout through WebDriver BiDi in the release Retest drives. A Firefox target takes a viewport, and no device.' })
})
