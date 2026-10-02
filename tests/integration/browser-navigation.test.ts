import type { TestContext } from 'node:test'
import type { OwnedPage, PageNavigation } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { startTaskApp } from '../../fixtures/task-app/server.ts'
import { titleReadLimit } from '../../src/protocol/page-facts.ts'
import {
  assertOk,
  click,
  failureOf,
  fill,
  goto,
  observe,
  observeUntil,
  openApp,
  openPage,
  press,
  select,
  servePages,
  sharedBrowser,
  timed,
} from './browser-harness.ts'

const browser = sharedBrowser()

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

test('goto resolves against the base URL and answers with origin and path only', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assert.deepEqual(await goto(page, '/?token=secret#top'), { ok: true, kind: 'goto', url: `${app.url}/`, page: { url: `${app.url}/`, title: 'Tasks' } })
})

test('goto accepts a full URL without a base URL', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser())
  assert.deepEqual(await goto(page, `${app.url}/`), { ok: true, kind: 'goto', url: `${app.url}/`, page: { url: `${app.url}/`, title: 'Tasks' } })
})

test('main frame navigations are reported as origin and path, including one a click caused', async (t) => {
  const site = await servePages(t, {
    '/': '<!doctype html><a data-testid="next" href="/next?page=2#part">Next</a>',
    '/next?page=2': '<!doctype html><p data-testid="here">Next page</p>',
  })
  const page = await openPage(t, browser(), site.url)
  const seen: string[] = []
  page.onNavigation((navigation) => seen.push(navigation.url))
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
  const stop = page.onNavigation((navigation) => seen.push(navigation.url))
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
  assert.deepEqual(value, { ok: true, kind: 'goto', url: `${site.url}/final`, page: { url: `${site.url}/final` } })
  assert.ok(ms < 2000, `took ${ms} ms`)
  assert.equal((await observe(page, 'here')).text, 'Final')
})

test('goto to a fragment of the current document is complete at once', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/'))
  const { value, ms } = await timed(goto(page, '/#details'))
  assert.deepEqual(value, { ok: true, kind: 'goto', url: `${app.url}/`, page: { url: `${app.url}/`, title: 'Tasks' } })
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

type Told = { path: string; cause: string; title: string | undefined }

// Every navigation of the page, as told: its path, its cause, and its title once it settles.
function recordNavigations(page: OwnedPage): { told: () => Promise<Told[]>; count: () => number } {
  const seen: PageNavigation[] = []
  page.onNavigation((navigation) => void seen.push(navigation))
  const told = () => Promise.all(seen.map(async ({ url, cause, title }) => ({ path: new URL(url).pathname, cause, title: await title })))
  return { told, count: () => seen.length }
}

async function titlesPage(t: TestContext) {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  return { app, page, ...recordNavigations(page) }
}

test("a server page's title is read when its content has loaded, and the goto that opened it names it and says so", async (t) => {
  const { app, page, told } = await titlesPage(t)
  const started = performance.now()
  assert.deepEqual(await goto(page, '/titles?token=1'), { ok: true, kind: 'goto', url: `${app.url}/titles`, page: { url: `${app.url}/titles`, title: 'Titles' } })
  assert.deepEqual(await told(), [{ path: '/titles', cause: 'goto', title: 'Titles' }])
  assert.ok(performance.now() - started < 900, 'the title came from DOMContentLoaded, not the one-second wait')
  assert.equal(page.url, `${app.url}/titles`)
})

test('a redirect chain gives each document its own title, and a redirect the page makes on its own is its own', async (t) => {
  const { page, told } = await titlesPage(t)
  assertOk(await goto(page, '/titles/chain'))
  await observeUntil(page, 'arrived', (seen) => seen.count === 1)
  assert.deepEqual(await told(), [
    { path: '/titles/redirect', cause: 'goto', title: 'Redirecting' },
    { path: '/titles/next', cause: 'page', title: 'Next' },
  ])
})

test('a link clicked, Enter in a form and a new path set by a click listener are each the action that caused them', async (t) => {
  const { page, told } = await titlesPage(t)
  assertOk(await goto(page, '/titles'))
  assertOk(await click(page, 'next'))
  await observeUntil(page, 'arrived', (seen) => seen.count === 1)
  assertOk(await goto(page, '/titles'))
  assertOk(await fill(page, 'query', 'release'))
  assertOk(await press(page, 'query', 'Enter'))
  await observeUntil(page, 'arrived', (seen) => seen.count === 1)
  assertOk(await goto(page, '/titles'))
  assertOk(await click(page, 'push'))
  await observeUntil(page, 'push', () => page.url?.endsWith('/titles/pushed') === true)
  assert.deepEqual(await told(), [
    { path: '/titles', cause: 'goto', title: 'Titles' },
    { path: '/titles/next', cause: 'action', title: 'Next' },
    { path: '/titles', cause: 'goto', title: 'Titles' },
    { path: '/titles/next', cause: 'action', title: 'Next' },
    { path: '/titles', cause: 'goto', title: 'Titles' },
    { path: '/titles/pushed', cause: 'action', title: 'Pushed' },
  ])
})

test('a title the page writes after it loads is no navigation, and the next look reads it', async (t) => {
  const { app, page, count } = await titlesPage(t)
  assertOk(await goto(page, '/titles'))
  assertOk(await click(page, 'retitle'))
  const end = performance.now() + 3000
  for (;;) {
    const result = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'next' } }, 1000)
    assert.ok(result.ok && result.kind === 'observe')
    if (result.page?.title === 'Retitled') {
      assert.deepEqual(result.page, { url: `${app.url}/titles`, title: 'Retitled' })
      break
    }
    assert.ok(performance.now() < end, 'the new title never showed')
  }
  assert.equal(count(), 1)
})

// The parent redacts a title before it cleans it or cuts it to the 300 code units it records, so the browser hands
// it over as the page has it. Chrome's own `document.title` already reads each C0 control character and DEL as a
// space, joins runs of spaces and trims the ends; a C1 control character, such as U+009B, reaches Retest as it is.
test('a title reaches the parent as the page has it, a C1 control character and all, and an empty one is none', async (t) => {
  const { app, page, told } = await titlesPage(t)
  const echo = (title: string) => `/titles/echo?title=${encodeURIComponent(title)}`
  const raw = await goto(page, echo('\u009bBell\t tab \u001b[2J '))
  assert.deepEqual(raw, { ok: true, kind: 'goto', url: `${app.url}/titles/echo`, page: { url: `${app.url}/titles/echo`, title: '\u009bBell tab [2J' } })
  assert.deepEqual(await goto(page, echo('   ')), { ok: true, kind: 'goto', url: `${app.url}/titles/echo`, page: { url: `${app.url}/titles/echo` } })
  const longer = `${'a'.repeat(299)}😀tail`
  assertOk(await goto(page, echo(longer)))
  const longest = `${'b'.repeat(4095)}😀tail`
  assertOk(await goto(page, echo(longest)))
  assert.deepEqual(
    (await told()).map(({ title }) => title),
    ['\u009bBell tab [2J', undefined, longer, longest],
  )
  const reading = await page.readPage([{ text: 'Titled', ignoreCase: false }], 1000)
  assert.deepEqual(reading, { url: `${app.url}/titles/echo`, title: longest, navigating: false, found: [true] })
})

test(`a title a script makes longer than ${titleReadLimit} code units reaches the parent cut there, and no longer`, async (t) => {
  const site = await servePages(t, { '/': `<!doctype html><title>Short</title><body><script>document.title = 'x'.repeat(${titleReadLimit + 100})</script></body>` })
  const page = await openPage(t, browser(), site.url)
  const opened = await goto(page, '/')
  assert.ok(opened.ok && opened.kind === 'goto')
  assert.equal(opened.page?.title, 'x'.repeat(titleReadLimit))
  assert.equal((await page.readPage([], 1000)).title, 'x'.repeat(titleReadLimit))
})

// The runner gives each command a token; the navigation the command's input or goto started carries it back, so
// the parent can name that command's step however late the navigation commits.
test('a navigation names the token of the command that started it, and says whether it opened a document', async (t) => {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  const seen: PageNavigation[] = []
  page.onNavigation((navigation) => void seen.push(navigation))
  assertOk(await page.execute({ kind: 'goto', url: '/titles' }, 5000, undefined, 1))
  assertOk(await page.execute({ kind: 'click', locator: { by: 'testId', value: 'next' } }, 2000, undefined, 2))
  await observeUntil(page, 'arrived', (look) => look.count === 1)
  assertOk(await page.execute({ kind: 'goto', url: '/titles' }, 5000, undefined, 3))
  assertOk(await page.execute({ kind: 'click', locator: { by: 'testId', value: 'push' } }, 2000, undefined, 4))
  await observeUntil(page, 'push', () => page.url?.endsWith('/titles/pushed') === true)
  assert.deepEqual(
    seen.map(({ url, cause, document, commandToken }) => [new URL(url).pathname, cause, document, commandToken]),
    [
      ['/titles', 'goto', 'new', 1],
      ['/titles/next', 'action', 'new', 2],
      ['/titles', 'goto', 'new', 3],
      ['/titles/pushed', 'action', 'same', 4],
    ],
  )
})

test("a document replaced while it parses, or by a refresh as it loads, never takes the title of the one that replaced it", async (t) => {
  const site = await servePages(t, {
    '/parse-leave': '<!doctype html><title>Leaving</title><script>location.replace("/after")</script><p>Leaving</p>',
    '/refresh': '<!doctype html><title>Refreshing</title><meta http-equiv="refresh" content="0;url=/after"><p>Refreshing</p>',
    '/after': '<!doctype html><title>After</title><p data-testid="after">After</p>',
  })
  const page = await openPage(t, browser(), site.url)
  const { told } = recordNavigations(page)
  for (const path of ['/parse-leave', '/refresh']) {
    assertOk(await goto(page, path))
    await observeUntil(page, 'after', (seen) => seen.count === 1)
  }
  const titles = await told()
  assert.deepEqual(titles.map(({ path, cause }) => `${path} ${cause}`), ['/parse-leave goto', '/after page', '/refresh goto', '/after page'])
  const [leaving, afterLeaving, refreshing, afterRefresh] = titles
  assert.ok(leaving?.title === undefined || leaving.title === 'Leaving', JSON.stringify(leaving))
  assert.ok(refreshing?.title === undefined || refreshing.title === 'Refreshing', JSON.stringify(refreshing))
  assert.equal(afterLeaving?.title, 'After')
  assert.equal(afterRefresh?.title, 'After')
})

test("a select whose change listener opens another page passes, and the navigation is the select's", async (t) => {
  const site = await servePages(t, {
    '/': `<!doctype html><title>Pick</title><select data-testid="plan"><option>Free</option><option>Team</option></select><script>
      document.querySelector('[data-testid="plan"]').addEventListener('change', (event) => { location.href = '/chosen?plan=' + event.target.value })
    </script>`,
    '/chosen?plan=Team': '<!doctype html><title>Chosen</title><p data-testid="chosen">Chosen</p>',
  })
  const page = await openPage(t, browser(), site.url)
  const { told } = recordNavigations(page)
  assertOk(await goto(page, '/'))
  assert.deepEqual(await select(page, 'plan', 'Team'), { ok: true, kind: 'select', changed: true, page: { url: `${site.url}/`, title: 'Pick' } })
  await observeUntil(page, 'chosen', (seen) => seen.count === 1)
  assert.deepEqual(await told(), [
    { path: '/', cause: 'goto', title: 'Pick' },
    { path: '/chosen', cause: 'action', title: 'Chosen' },
  ])
})
