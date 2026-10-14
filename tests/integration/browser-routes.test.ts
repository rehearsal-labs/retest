import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { DiagnosticSink, Observation } from '../../src/diagnostics/observations.ts'
import type { RouteAnswerRecord, RoutePattern } from '../../src/protocol/routes.ts'
import type { RouteCounts } from '../../fixtures/task-app/routes-page.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROXY_HEADER, startProxy } from '../../fixtures/proxy/server.ts'
import { MOCKED_IMAGE } from '../../fixtures/task-app/routes-page.ts'
import { assertOk, byTestId, click, goto, launch, observe, observeUntil, openApp, openPage, sharedBrowser } from './browser-harness.ts'
import { engineAbsence } from './engines.ts'

// Mocked responses on Chrome, driven at the driver: a route answers the page's request, or refuses it, before it leaves
// the browser, and the server counts what reached it, so a test sees both sides. Routes answer the page and the frames
// in its process, the latest route first; a request no route matches goes on, through the proxy as any request does;
// the diagnostics name the route that answered. routes.test.ts runs routes through a whole run, events and report.

const browser = sharedBrowser()

type RoutesPage = { page: OwnedPage; app: TaskApp; counts: () => Promise<RouteCounts> }

async function routesPage(t: TestContext, options: { proxy?: string } = {}): Promise<RoutesPage> {
  const app = await openApp(t, options.proxy === undefined ? {} : { requireHeader: PROXY_HEADER })
  const page = await openPage(t, browser(), app.url, options.proxy === undefined ? {} : { proxy: { server: options.proxy, bypass: ['<-loopback>'] } })
  // The app takes only requests that carry the proxy's header when a proxy is given, and this one comes from the test.
  const counts = async (): Promise<RouteCounts> => (await (await fetch(`${app.url}/routes/counts`, { headers: { [PROXY_HEADER]: 'the test' } })).json()) as RouteCounts
  return { page, app, counts }
}

async function addRoute(page: OwnedPage, pattern: RoutePattern, answer: RouteAnswerRecord): Promise<void> {
  assert.ok(page.addRoute !== undefined, 'a Chrome page answers requests with routes')
  assert.deepEqual(await page.addRoute(pattern, answer, 2000), { ok: true })
}

async function removeRoute(page: OwnedPage, pattern: RoutePattern): Promise<number> {
  assert.ok(page.removeRoute !== undefined)
  const removed = await page.removeRoute(pattern, 2000)
  assert.ok(removed.ok, JSON.stringify(removed))
  return removed.removed
}

async function textOf(page: OwnedPage, testId: string): Promise<string | null> {
  return (await observe(page, testId)).text
}

const stubbed = { contentType: 'application/json', body: JSON.stringify([{ title: 'Stubbed' }]) }

test('a JSON answer renders on the page, and the server never saw the request it answered', async (t) => {
  const { page, counts } = await routesPage(t)
  await addRoute(page, '**/api/tasks', stubbed)
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'tasks-status', (seen) => seen.text === 'loaded 1')
  assert.equal(await textOf(page, 'tasks'), 'Stubbed')
  await observeUntil(page, 'frame-status', (seen) => seen.text === 'frame got from the server')
  await observeUntil(page, 'image-status', (seen) => seen.text === '2x1')
  assert.deepEqual(await counts(), { 'GET /routes/api/frame': 1, 'GET /routes/api/image.png': 1 })
})

test("a refusal fails the page's request with the error it names, and nothing reaches the server", async (t) => {
  const { page, counts } = await routesPage(t)
  await addRoute(page, '**/api/slow', { abort: 'connectionrefused' })
  assertOk(await goto(page, '/routes'))
  assertOk(await click(page, 'slow'))
  await observeUntil(page, 'slow-status', (seen) => seen.text === 'slow failed: Failed to fetch')
  await observeUntil(page, 'tasks-status', (seen) => seen.text === 'loaded 1')
  const reached = await counts()
  assert.equal(reached['GET /routes/api/slow'], undefined)
  assert.equal(reached['GET /routes/api/tasks'], 1, 'a request no route matches goes on to the server')
})

test('a regular expression answers the addresses it matches, with the status and body it gives', async (t) => {
  const { page, counts } = await routesPage(t)
  await addRoute(page, { pattern: '\\/api\\/tasks\\/\\d+$', flags: '' }, { status: 404, body: 'Not found' })
  assertOk(await goto(page, '/routes'))
  assertOk(await click(page, 'task-7'))
  await observeUntil(page, 'task-status', (seen) => seen.text === '404 Not found')
  await observeUntil(page, 'tasks-status', (seen) => seen.text === 'loaded 1')
  assert.equal(await textOf(page, 'tasks'), 'Real task')
  assert.equal((await counts())['GET /routes/api/tasks/7'], undefined)
})

test('a body of bytes arrives as those bytes, and a posted form gets the status and headers the route gives', async (t) => {
  const { page, counts } = await routesPage(t)
  await addRoute(page, '**/api/image.png', { contentType: 'image/png', base64: Buffer.from(MOCKED_IMAGE).toString('base64') })
  await addRoute(page, '**/routes/api/tasks', { status: 201, headers: { 'x-saved-by': 'the route' }, contentType: 'application/json', body: '[]' })
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'image-status', (seen) => seen.text === '3x2')
  assertOk(await click(page, 'post'))
  await observeUntil(page, 'post-status', (seen) => seen.text === 'posted 201 the route')
  assert.deepEqual(await counts(), { 'GET /routes/api/frame': 1 })
})

test('a later route answers before an earlier one, and unroute takes away the routes of its pattern', async (t) => {
  const { page, counts } = await routesPage(t)
  await addRoute(page, '**/api/tasks', { contentType: 'application/json', body: JSON.stringify([{ title: 'Earlier' }]) })
  await addRoute(page, 'http://*/routes/api/tasks', { contentType: 'application/json', body: JSON.stringify([{ title: 'Later' }]) })
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'tasks', (seen) => seen.text === 'Later')
  assert.equal(await removeRoute(page, 'http://*/routes/api/tasks'), 1)
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'tasks', (seen) => seen.text === 'Earlier')
  assert.equal(await removeRoute(page, '**/api/tasks'), 1)
  assert.equal(await removeRoute(page, '**/api/tasks'), 0, 'a pattern no route was added with takes nothing away')
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'tasks', (seen) => seen.text === 'Real task')
  assert.equal((await counts())['GET /routes/api/tasks'], 1)
})

test("a frame of the page's own process is answered by the page's routes", async (t) => {
  const { page, counts } = await routesPage(t)
  await addRoute(page, '**/api/frame', { body: 'mocked frame' })
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'frame-status', (seen) => seen.text === 'frame got mocked frame')
  assert.equal((await counts())['GET /routes/api/frame'], undefined)
})

test("a frame of another site makes its requests past the page's routes", async (t) => {
  const { page, app, counts } = await routesPage(t)
  await addRoute(page, '**/api/frame', { body: 'mocked frame' })
  // localhost is another site than 127.0.0.1, which Chrome keeps apart from the page's own.
  const other = `${app.url.replace('127.0.0.1', 'localhost')}/routes/frame`
  assertOk(await goto(page, `/routes/cross?frame=${encodeURIComponent(other)}`))
  await observeUntil(page, 'frame-status', (seen) => seen.text === 'frame got from the server')
  assert.equal((await counts())['GET /routes/api/frame'], 1)
})

test('a request no route matches goes on through the proxy, and one a route answers reaches neither the proxy nor the server', async (t) => {
  const proxy = await startProxy()
  t.after(() => proxy.close())
  const { page, app, counts } = await routesPage(t, { proxy: proxy.url })
  await addRoute(page, '**/api/tasks', stubbed)
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'tasks-status', (seen) => seen.text === 'loaded 1')
  await observeUntil(page, 'frame-status', (seen) => seen.text === 'frame got from the server')
  assert.equal(app.refused(), 0, 'every request that reached the app came through the proxy')
  const carried = proxy.requests().map(({ method, target }) => `${method} ${target}`)
  assert.ok(carried.includes(`GET ${app.url}/routes/api/frame`), carried.join('\n'))
  assert.ok(!carried.some((request) => request.includes('/routes/api/tasks')), carried.join('\n'))
  const reached = await counts()
  assert.equal(reached['GET /routes/api/tasks'], undefined)
  assert.equal(reached['GET /routes/api/frame'], 1)
})

test("the page's diagnostics name the route that answered or refused a request, and no other", async (t) => {
  const { page } = await routesPage(t)
  const observations: Observation[] = []
  const sink: DiagnosticSink = { observe: (observation) => observations.push(observation), unreadable: () => undefined, lost: () => undefined }
  assert.ok(page.collectDiagnostics !== undefined)
  const collection = await page.collectDiagnostics(sink, 2000)
  t.after(() => collection.stop())
  await addRoute(page, '**/api/tasks', stubbed)
  await addRoute(page, '**/api/slow', { abort: 'connectionrefused' })
  assertOk(await goto(page, '/routes'))
  assertOk(await click(page, 'slow'))
  await observeUntil(page, 'slow-status', (seen) => seen.text === 'slow failed: Failed to fetch')
  await observeUntil(page, 'frame-status', (seen) => seen.text === 'frame got from the server')
  const keyOf = (path: string): string => {
    const sent = observations.find((observation) => observation.kind === 'request' && observation.url.endsWith(path))
    assert.ok(sent?.kind === 'request', `the collector heard ${path} sent`)
    return sent.key
  }
  const ended = (path: string): Observation[] => observations.filter((observation) => (observation.kind === 'response' || observation.kind === 'failed') && observation.key === keyOf(path))
  assert.deepEqual(ended('/routes/api/tasks').map((observation) => [observation.kind, 'route' in observation ? observation.route : undefined]), [['response', "'**/api/tasks'"]])
  assert.deepEqual(ended('/routes/api/slow').map((observation) => [observation.kind, 'route' in observation ? observation.route : undefined]), [['failed', "'**/api/slow'"]])
  assert.deepEqual(ended('/routes/api/frame').map((observation) => [observation.kind, 'route' in observation ? observation.route : undefined]), [['response', undefined]])
})

test("a service worker that answers for the page fetches past the page's routes, as Chrome sends its requests", async (t) => {
  const { page, counts } = await routesPage(t)
  assertOk(await goto(page, '/routes/worker'))
  await observeUntil(page, 'worker-status', (seen) => seen.text === 'controlled', 5000)
  await addRoute(page, '**/api/worker', { body: 'mocked' })
  assertOk(await click(page, byTestId('worker-fetch')))
  await observeUntil(page, 'worker-answer', (seen) => seen.text === '200 from the network')
  assert.equal((await counts())['GET /routes/api/worker'], 1)
})

test('Firefox and WebKit refuse routes by name, and hold none', async (t) => {
  for (const [engine, label] of [['firefox', 'Firefox'], ['webkit', 'WebKit']] as const) {
    await t.test(label, async (t) => {
      const absent = engineAbsence(engine)
      if (absent !== undefined) {
        t.skip(absent)
        return
      }
      // The harness launches the engine RETEST_TEST_ENGINE names, read as it launches.
      const previous = process.env['RETEST_TEST_ENGINE']
      process.env['RETEST_TEST_ENGINE'] = engine
      const owned = await launch(t).finally(() => {
        if (previous === undefined) delete process.env['RETEST_TEST_ENGINE']
        else process.env['RETEST_TEST_ENGINE'] = previous
      })
      const page = await openPage(t, owned)
      const refusal = { ok: false, failure: { class: 'unsupported', message: `page.route() is not available on ${label} yet. Retest answers requests on Chrome, Chromium and Edge.` } }
      assert.deepEqual(await page.addRoute?.('**/api/tasks', stubbed, 1000), refusal)
      assert.deepEqual(await page.removeRoute?.('**/api/tasks', 1000), refusal)
    })
  }
})

test('a status Chrome has no phrase of its own for still answers the request, with a plain phrase', async (t) => {
  const { page, counts } = await routesPage(t)
  assertOk(await goto(page, '/routes'))
  for (const status of [299, 520, 599]) {
    await addRoute(page, '**/api/status', { status, body: 'mocked' })
    assertOk(await click(page, 'status'))
    await observeUntil(page, 'status-status', (seen) => seen.text === `${status} Status ${status}`)
  }
  await addRoute(page, '**/api/status', { status: 404, body: 'mocked' })
  assertOk(await click(page, 'status'))
  await observeUntil(page, 'status-status', (seen) => seen.text === '404 Not Found')
  assert.equal((await counts())['GET /routes/api/status'], undefined)
})

test('a redirect a route answers is marked on its own hop, and the page that follows it is not', async (t) => {
  const { page, counts } = await routesPage(t)
  const observations: Observation[] = []
  const sink: DiagnosticSink = { observe: (observation) => observations.push(observation), unreadable: () => undefined, lost: () => undefined }
  assert.ok(page.collectDiagnostics !== undefined)
  const collection = await page.collectDiagnostics(sink, 2000)
  t.after(() => collection.stop())
  await addRoute(page, '**/api/jump', { status: 302, headers: { location: '/routes/api/tasks' } })
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'tasks-status', (seen) => seen.text === 'loaded 1')
  assertOk(await click(page, 'jump'))
  await observeUntil(page, 'jump-status', (seen) => seen.text === '200 /routes/api/tasks [{"title":"Real task"}]')
  const sent = observations.find((observation) => observation.kind === 'request' && observation.url.endsWith('/routes/api/jump'))
  assert.ok(sent?.kind === 'request')
  const answers = observations.filter((observation) => observation.kind === 'response' && observation.key.startsWith(sent.key.replace(/#\d+$/, '#')))
  assert.deepEqual(answers.map((observation) => (observation.kind === 'response' ? [observation.status, observation.route] : [])), [
    [302, "'**/api/jump'"],
    [200, undefined],
  ])
  assert.equal((await counts())['GET /routes/api/jump'], undefined)
  assert.equal((await counts())['GET /routes/api/tasks'], 2, 'the page load and the jump each reached the server for the task list')
})

test('a page the page opens while nothing waits for it shares its routes, as a popup a test waited for does', async (t) => {
  const { page, counts } = await routesPage(t)
  await addRoute(page, '**/api/tasks', { abort: 'connectionrefused' })
  assertOk(await goto(page, '/routes'))
  await observeUntil(page, 'tasks-status', (seen) => seen.text === 'tasks failed: Failed to fetch')
  assertOk(await click(page, 'open-popup'))
  // The popup is the routes page again: it fetches its frame's text from the server, and its task list is refused.
  for (let tries = 0; (await counts())['GET /routes/api/frame'] !== 2; tries += 1) {
    assert.ok(tries < 100, 'the page the link opened never fetched its frame')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.equal((await counts())['GET /routes/api/tasks'], undefined)
})
