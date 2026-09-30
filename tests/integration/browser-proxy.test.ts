import type { TestContext } from 'node:test'
import type { FixtureProxy, ProxyOptions } from '../../fixtures/proxy/server.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import type { OwnedPage } from '../../src/browser/contract.ts'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { PROXY_HEADER, startProxy } from '../../fixtures/proxy/server.ts'
import { PROXY_CHECK_PATH } from '../../fixtures/task-app/proxy-page.ts'
import { assertOk, failureOf, goto, observeUntil, openApp, openPage, sharedBrowser } from './browser-harness.ts'

const browser = sharedBrowser()

async function proxyFor(t: TestContext, options?: ProxyOptions): Promise<FixtureProxy> {
  const proxy = await startProxy(options)
  t.after(() => proxy.close())
  return proxy
}

// A loopback port nothing listens on, as a proxy that is not running leaves.
async function closedPort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  await new Promise((resolve) => server.close(resolve))
  return address.port
}

// Waits for every kind of request the proxy check page makes to have been answered.
async function everyRequestAnswered(page: OwnedPage): Promise<void> {
  await observeUntil(page, 'page-fetch', (seen) => seen.text === 'answered')
  await observeUntil(page, 'worker-fetch', (seen) => seen.text === 'answered by the worker')
  await observeUntil(page, 'frame-status', (seen) => seen.text === 'loaded')
}

// The requests the proxy carried to the app, on either of its loopback names. The browser's own requests, such
// as a CONNECT to a search engine, go through the proxy too, and the fixture proxy refuses them.
function carriedTo(proxy: FixtureProxy, app: TaskApp): string[] {
  const { port } = new URL(app.url)
  return proxy
    .requests()
    .map(({ method, target }) => `${method} ${target}`)
    .filter((request) => request.includes(`127.0.0.1:${port}`) || request.includes(`localhost:${port}`))
}

test('with <-loopback> in the bypass rules, every request of the page goes through the proxy, a service worker and a frame of another site included', async (t) => {
  const proxy = await proxyFor(t)
  const app = await openApp(t, { requireHeader: PROXY_HEADER })
  const page = await openPage(t, browser(), app.url, { proxy: { server: proxy.url, bypass: ['<-loopback>'] } })
  assertOk(await goto(page, PROXY_CHECK_PATH))
  await everyRequestAnswered(page)
  assert.equal(app.refused(), 0, 'the app refused no request, so every one carried the proxy header')
  const { port } = new URL(app.url)
  const carried = carriedTo(proxy, app)
  for (const path of ['', 'data', 'worker.js', 'from-worker']) assert.ok(carried.includes(`GET ${app.url}${PROXY_CHECK_PATH}${path}`), path)
  assert.ok(carried.includes(`GET http://localhost:${port}${PROXY_CHECK_PATH}frame`), 'the frame of another site')
})

test('without <-loopback>, loopback addresses go around the proxy, as Chrome sends them, and with it they go through', async (t) => {
  const proxy = await proxyFor(t)
  const app = await openApp(t)
  const around = await openPage(t, browser(), app.url, { proxy: { server: proxy.url, bypass: [] } })
  assertOk(await goto(around, PROXY_CHECK_PATH))
  await everyRequestAnswered(around)
  assert.deepEqual(carriedTo(proxy, app), [])
  const through = await openPage(t, browser(), app.url, { proxy: { server: proxy.url, bypass: ['<-loopback>'] } })
  assertOk(await goto(through, PROXY_CHECK_PATH))
  assert.ok(carriedTo(proxy, app).includes(`GET ${app.url}${PROXY_CHECK_PATH}`))
})

test('a host in the bypass rules goes around the proxy, and the rest go through it', async (t) => {
  const proxy = await proxyFor(t)
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url, { proxy: { server: proxy.url, bypass: ['<-loopback>', 'localhost'] } })
  assertOk(await goto(page, PROXY_CHECK_PATH))
  await everyRequestAnswered(page)
  const carried = carriedTo(proxy, app)
  assert.ok(carried.includes(`GET ${app.url}${PROXY_CHECK_PATH}`), JSON.stringify(carried))
  assert.deepEqual(
    carried.filter((request) => request.includes('localhost')),
    [],
  )
})

test('each page has its own proxy: two pages share one, and a page without one in the same browser goes direct', async (t) => {
  const proxy = await proxyFor(t)
  const app = await openApp(t, { requireHeader: PROXY_HEADER })
  const settings = { proxy: { server: proxy.url, bypass: ['<-loopback>'] } }
  const first = await openPage(t, browser(), app.url, settings)
  const second = await openPage(t, browser(), app.url, settings)
  const direct = await openPage(t, browser(), app.url)
  for (const page of [first, second]) {
    assertOk(await goto(page, PROXY_CHECK_PATH))
    await everyRequestAnswered(page)
  }
  assert.equal(app.refused(), 0)
  assertOk(await goto(direct, PROXY_CHECK_PATH))
  assert.deepEqual((await direct.readPage([{ text: `Refused: the request has no ${PROXY_HEADER} header.`, ignoreCase: false }], 1000)).found, [true])
  assert.ok(app.refused() >= 1)
})

test('a proxy that refuses the connection fails goto as setup_failed, naming the proxy and the error', async (t) => {
  const app = await openApp(t)
  const server = `http://127.0.0.1:${await closedPort()}`
  const page = await openPage(t, browser(), app.url, { proxy: { server, bypass: ['<-loopback>'] } })
  assert.deepEqual(failureOf(await goto(page, '/')), {
    class: 'setup_failed',
    message: `Could not open ${app.url}/ through the proxy ${server}: net::ERR_PROXY_CONNECTION_FAILED. The proxy failed, not the app.`,
    details: { url: `${app.url}/`, errorText: 'net::ERR_PROXY_CONNECTION_FAILED', proxy: server },
  })
  assert.equal(app.requests(), 0)
})

test('a proxy that cannot open the tunnel to an https address fails goto as setup_failed', async (t) => {
  const proxy = await proxyFor(t)
  const page = await openPage(t, browser(), undefined, { proxy: { server: proxy.url, bypass: ['<-loopback>'] } })
  const address = `https://127.0.0.1:${await closedPort()}/`
  const failure = failureOf(await goto(page, address))
  assert.equal(failure.class, 'setup_failed')
  assert.deepEqual(failure.details, { url: address, errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED', proxy: proxy.url })
  assert.ok(proxy.requests().some(({ method, target }) => method === 'CONNECT' && address.includes(target)))
})

// Retest does not sign in to a proxy. Chrome gives up on the challenge with the same error it gives a site's own
// challenge, so the failure is the page's, as for any address that would not open.
test('a proxy that asks for credentials gets none, and goto fails as for a site that asks for them', async (t) => {
  const proxy = await proxyFor(t, { challenge: true })
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url, { proxy: { server: proxy.url, bypass: ['<-loopback>'] } })
  assert.deepEqual(failureOf(await goto(page, '/')), {
    class: 'not_actionable',
    message: `Could not open ${app.url}/: net::ERR_INVALID_AUTH_CREDENTIALS.`,
    details: { url: `${app.url}/`, errorText: 'net::ERR_INVALID_AUTH_CREDENTIALS' },
  })
  assert.equal(app.requests(), 0)
})
