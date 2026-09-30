import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import {
  assertOk,
  click,
  failureOf,
  goto,
  observe,
  observeUntil,
  openApp,
  openPage,
  servePages,
  sharedBrowser,
  timed,
} from './browser-harness.ts'

const browser = sharedBrowser()

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

test('goto resolves against the base URL and answers with origin and path only', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assert.deepEqual(await goto(page, '/?token=secret#top'), { ok: true, kind: 'goto', url: `${app.url}/` })
})

test('goto accepts a full URL without a base URL', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser())
  assert.deepEqual(await goto(page, `${app.url}/`), { ok: true, kind: 'goto', url: `${app.url}/` })
})

test('main frame navigations are reported as origin and path, including one a click caused', async (t) => {
  const site = await servePages(t, {
    '/': '<!doctype html><a data-testid="next" href="/next?page=2#part">Next</a>',
    '/next?page=2': '<!doctype html><p data-testid="here">Next page</p>',
  })
  const page = await openPage(t, browser(), site.url)
  const seen: string[] = []
  page.onNavigation((url) => seen.push(url))
  assertOk(await goto(page, '/'))
  assertOk(await click(page, 'next'))
  await observeUntil(page, 'here', (observation) => observation.count === 1)
  assert.deepEqual(seen, [`${site.url}/`, `${site.url}/next`])
})

test('a path change within the document is reported, and a fragment change is not', async (t) => {
  const site = await servePages(t, {
    '/': `<!doctype html><button data-testid="route">Route</button><button data-testid="hash">Hash</button>
    <button data-testid="done">Done</button><script>
      document.querySelector('[data-testid="route"]').addEventListener('click', () => history.pushState({}, '', '/tasks?page=2'))
      document.querySelector('[data-testid="hash"]').addEventListener('click', () => { location.hash = 'details' })
      document.querySelector('[data-testid="done"]').addEventListener('click', () => history.pushState({}, '', '/done'))
    </script>`,
  })
  const page = await openPage(t, browser(), site.url)
  const seen: string[] = []
  const stop = page.onNavigation((url) => seen.push(url))
  assertOk(await goto(page, '/'))
  assertOk(await click(page, 'hash'))
  assertOk(await click(page, 'route'))
  assertOk(await click(page, 'hash'))
  // The browser reports a frame's navigations in order, so a wrongly reported fragment change would come before this one.
  assertOk(await click(page, 'done'))
  await observeUntil(page, 'route', () => seen.includes(`${site.url}/done`))
  assert.deepEqual(seen, [`${site.url}/`, `${site.url}/tasks`, `${site.url}/done`])
  stop()
  assertOk(await goto(page, '/'))
  assert.equal(seen.length, 3, 'a removed listener hears nothing')
})

test('a page that sends the browser elsewhere before it loads counts as loaded once the page it sent the browser to loads', async (t) => {
  const site = await servePages(t, {
    '/start': '<!doctype html><script>location.replace("/middle")</script><img src="/hang">',
    '/middle': '<!doctype html><script>location.replace("/final")</script><img src="/hang">',
    '/final': '<!doctype html><p data-testid="here">Final</p>',
  })
  const page = await openPage(t, browser(), site.url)
  const { value, ms } = await timed(goto(page, '/start', 5000))
  assert.deepEqual(value, { ok: true, kind: 'goto', url: `${site.url}/final` })
  assert.ok(ms < 2000, `took ${ms} ms`)
  assert.equal((await observe(page, 'here')).text, 'Final')
})

test('goto to a fragment of the current document is complete at once', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/'))
  const { value, ms } = await timed(goto(page, '/#details'))
  assert.deepEqual(value, { ok: true, kind: 'goto', url: `${app.url}/` })
  assert.ok(ms < 1000, `took ${ms} ms`)
})

test('a page that never finishes loading times out and names the address without its query', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  const { value, ms } = await timed(goto(page, '/hang?session=secret', 700))
  const failure = failureOf(value)
  assert.equal(failure.class, 'timeout')
  assert.equal(failure.message, `${app.url}/hang did not finish loading within 700 ms.`)
  assert.ok(ms >= 690 && ms < 2000, `took ${ms} ms`)
})

test('an address nobody answers fails with the browser navigation error', async (t) => {
  const closed = await startTaskApp()
  await closed.close()
  const page = await openPage(t, browser())
  const failure = failureOf(await goto(page, `${closed.url}/?token=secret`))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.message, `Could not open ${closed.url}/: net::ERR_CONNECTION_REFUSED.`)
  assert.deepEqual(failure.details, { url: `${closed.url}/`, errorText: 'net::ERR_CONNECTION_REFUSED' })
})

test('the error page of a failed navigation can be captured at once', async (t) => {
  const closed = await startTaskApp()
  await closed.close()
  const page = await openPage(t, browser())
  failureOf(await goto(page, `${closed.url}/`))
  const png = await page.screenshot(2000)
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE)
})

test('a relative address without a base URL is a usage failure', async (t) => {
  const page = await openPage(t, browser())
  const failure = failureOf(await goto(page, '/tasks'))
  assert.equal(failure.class, 'usage')
  assert.equal(failure.message, 'goto("/tasks") needs a full URL, because no base URL was given.')
})

test('an invalid base URL is a usage failure that names it', async (t) => {
  const page = await openPage(t, browser(), 'not a url')
  const failure = failureOf(await goto(page, '/tasks'))
  assert.equal(failure.class, 'usage')
  assert.equal(failure.message, 'The base URL "not a url" is not a valid URL.')
})

test('addresses other than http and https are refused before anything loads', async (t) => {
  const page = await openPage(t, browser())
  for (const url of ['data:text/html,<p>hi</p>', 'javascript:alert(1)', 'file:///etc/hosts']) {
    const failure = failureOf(await goto(page, url))
    assert.equal(failure.class, 'unsupported', url)
    assert.match(failure.message, /^goto opens http and https addresses, not [a-z]+: ones\.$/)
  }
})

test('a page that opens a dialog while loading fails at once as unsupported rather than as slow', async (t) => {
  const site = await servePages(t, { '/': '<!doctype html><p>Before</p><script>confirm("Leave?")</script><p>After</p>' })
  const page = await openPage(t, browser(), site.url)
  const { value, ms } = await timed(goto(page, '/', 5000))
  assert.ok(ms < 1500, `waiting for a load the dialog holds should end at once, took ${ms} ms of 5000`)
  const failure = failureOf(value)
  assert.equal(failure.class, 'unsupported')
  assert.deepEqual(failure.details, { dialog: 'confirm', inputSent: true })
  assert.match(failure.message, /^The page opened a confirm dialog while Retest tried to open http:\/\/127\.0\.0\.1:\d+\/\. /)
})

test('a screenshot is a PNG of the page', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/'))
  const png = await page.screenshot(2000)
  assert.deepEqual([...png.subarray(0, 8)], PNG_SIGNATURE)
  assert.ok(png.length > 1000, `${png.length} bytes`)
})
