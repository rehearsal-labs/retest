import type { TestContext } from 'node:test'
import type { WebRuntime } from '../../src/browser/contract.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { signalGroup } from '../../src/browser/chromium-process.ts'
import { launchBrowser } from '../../src/browser/launch.ts'
import { awaitPosts, browserPath, byTestId, closeMs, groupExists, openApp, scratchFolder, servePages, setupMs } from './browser-harness.ts'

// Posts to /pressed with a synchronous request, so the server knows the press arrived, then never returns.
const FREEZE_ON_PRESS = `<!doctype html><button data-testid="freeze" style="width: 200px; height: 60px">Freeze</button><script>
  document.querySelector('[data-testid="freeze"]').addEventListener('mousedown', () => {
    const request = new XMLHttpRequest()
    request.open('POST', '/pressed', false)
    request.send()
    for (;;) {}
  })
</script>`

// Tells the server the press arrived, then keeps the page busy long enough for Retest to be stopped mid-click. The
// status says what the button heard.
const BUSY_ON_PRESS = `<!doctype html><button data-testid="hold" style="width: 200px; height: 60px">Hold</button>
<p data-testid="status">idle</p><script>
  const hold = document.querySelector('[data-testid="hold"]')
  const status = document.querySelector('[data-testid="status"]')
  hold.addEventListener('mousedown', () => {
    status.textContent = 'pressed'
    const request = new XMLHttpRequest()
    request.open('POST', '/pressed', false)
    request.send()
    const end = performance.now() + 1500
    while (performance.now() < end) {}
  })
  hold.addEventListener('mouseup', () => { status.textContent += ' released' })
  hold.addEventListener('click', () => { status.textContent += ' clicked' })
</script>`

const interrupted: Failure = { class: 'interrupted', message: 'The run was interrupted.' }

// A browser launched as a web runtime, closed and its process group checked after the test.
async function runtime(t: TestContext): Promise<WebRuntime> {
  const folder = await scratchFolder(t)
  const browser = await launchBrowser({ executablePath: browserPath(), logFile: join(folder, 'browser.log'), headless: true })
  t.after(async () => {
    await browser.close(closeMs)
    assert.equal(groupExists(browser.pid), false, `process group ${browser.pid} should be gone`)
  })
  return browser
}

test('a Chromium browser is a web runtime that names what it runs on', async (t) => {
  const browser = await runtime(t)
  const { product, version, executablePath, pid } = browser
  assert.deepEqual(browser.identity, { kind: 'web', engine: 'chromium', product, version, executablePath, processIds: [pid] })
  assert.match(version, /^\d+\.\d+\.\d+\.\d+$/)
  assert.equal(executablePath, browserPath())
})

test('a Chromium page says how far each command’s input got: none for a look, all of it for input the browser took', async (t) => {
  const browser = await runtime(t)
  const app = await openApp(t)
  const page = await browser.newPage({ baseUrl: app.url }, setupMs)
  t.after(() => page.dispose(closeMs))
  const opened = await page.dispatch({ kind: 'goto', url: '/' }, 5000)
  assert.deepEqual([opened.result.ok, opened.input], [true, 'sent'])
  const look = await page.dispatch({ kind: 'observe', locator: byTestId('saved-task') }, 2000)
  assert.deepEqual([look.result.ok, look.input], [true, 'not_sent'])
  const typed = await page.dispatch({ kind: 'fill', locator: byTestId('task-title'), value: 'Release checklist' }, 2000)
  assert.deepEqual([typed.result.ok, typed.input], [true, 'sent'])
  const stop = new AbortController()
  stop.abort(interrupted)
  const stopped = await page.dispatch({ kind: 'click', locator: byTestId('save-task') }, 2000, stop.signal)
  assert.deepEqual([stopped.result.ok, stopped.input], [false, 'not_sent'])
  const saved = await page.dispatch({ kind: 'click', locator: byTestId('save-task') }, 2000)
  assert.deepEqual([saved.result.ok, saved.input], [true, 'sent'])
})

test('a click stopped while its press is unanswered leaves the input unknown, and is never released', async (t) => {
  const site = await servePages(t, { '/': BUSY_ON_PRESS })
  const browser = await runtime(t)
  const page = await browser.newPage({ baseUrl: site.url }, setupMs)
  t.after(() => page.dispose(closeMs))
  assert.equal((await page.dispatch({ kind: 'goto', url: '/' }, 5000)).result.ok, true)
  const stop = new AbortController()
  const clicking = page.dispatch({ kind: 'click', locator: byTestId('hold') }, 10_000, stop.signal)
  await awaitPosts(site, '/pressed', 1)
  stop.abort(interrupted)
  const { result, input } = await clicking
  assert.equal(input, 'unknown')
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'interrupted')
  assert.match(result.failure.message, /Input it sent is not taken back, so it may have taken effect\.$/)
  // The page answers once its press handler returns; a release sent before the stop would have been handled first.
  for (const look of [1, 2]) {
    const status = await page.dispatch({ kind: 'observe', locator: byTestId('status') }, 5000)
    assert.ok(status.result.ok && status.result.kind === 'observe', `look ${look}`)
    assert.equal(status.result.observation.text, 'pressed', `look ${look}`)
    assert.equal(status.input, 'not_sent')
  }
})

test('a browser killed after the press was sent answers outcome unknown, with the input unknown', async (t) => {
  const site = await servePages(t, { '/': FREEZE_ON_PRESS })
  const browser = await runtime(t)
  const page = await browser.newPage({ baseUrl: site.url }, setupMs)
  assert.equal((await page.dispatch({ kind: 'goto', url: '/' }, 5000)).result.ok, true)
  const clicking = page.dispatch({ kind: 'click', locator: byTestId('freeze') }, 10_000)
  await awaitPosts(site, '/pressed', 1)
  // This process launched the browser, so its own launch record ends the group, each process checked first.
  signalGroup(browser.pid, 'SIGKILL')
  const { result, input } = await clicking
  assert.equal(input, 'unknown')
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'outcome_unknown')
  assert.match(result.failure.message, /^Retest lost the page after it began to click getByTestId\('freeze'\), so it cannot tell/)
  assert.equal(site.posts('/pressed'), 1, 'the press was never sent again')
})
