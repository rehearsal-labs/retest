import type { TestContext } from 'node:test'
import type { FixtureProxy, ProxyOptions } from '../../fixtures/proxy/server.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PROXY_HEADER, startProxy } from '../../fixtures/proxy/server.ts'
import { PROXY_CHECK_PATH } from '../../fixtures/task-app/proxy-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, freePort, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'

// Acceptance check 5: a target's proxy server and bypass list, through the command line against real Chrome, the
// fixture proxy and the task app, which refuses every request that does not carry the header the proxy adds.

async function proxyFor(t: TestContext, options?: ProxyOptions): Promise<FixtureProxy> {
  const proxy = await startProxy(options)
  t.after(() => proxy.close())
  return proxy
}

function carried(proxy: FixtureProxy): string[] {
  return proxy.requests().map(({ method, target }) => `${method} ${target}`)
}

test('every request goes through the proxy, a host in the bypass list goes around it, and a proxy that fails is named', async (t) => {
  const app = await openApp(t, { requireHeader: PROXY_HEADER })
  const [proxy, challenging] = [await proxyFor(t), await proxyFor(t, { challenge: true })]
  const closed = `http://127.0.0.1:${await freePort()}`
  const { port } = new URL(app.url)
  const bypassed = `http://localhost:${port}/actions`
  const target = (server: string, bypass: readonly string[]) => `chrome({ baseUrl: ${JSON.stringify(app.url)}, proxy: { server: ${JSON.stringify(server)}, bypass: ${JSON.stringify(bypass)} } })`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    web: ${target(proxy.url, ['<-loopback>'])},
    aside: ${target(proxy.url, ['<-loopback>', 'localhost'])},
    closed: ${target(closed, ['<-loopback>'])},
    challenged: ${target(challenging.url, ['<-loopback>'])},
  },
  defaultApp: 'web',
}`),
    'tests/proxy.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('sends every request of the page through the proxy', async ({ page }) => {
  await page.goto('${PROXY_CHECK_PATH}')
  await expect(page.getByTestId('page-fetch')).toHaveText('answered')
  await expect(page.getByTestId('worker-fetch')).toHaveText('answered by the worker')
  await expect(page.getByTestId('frame-status')).toHaveText('loaded')
})

test('sends a host in the bypass list around the proxy', { apps: ['aside'] }, async ({ aside }) => {
  await aside.goto('${bypassed}')
  await expect(aside.getByText('Refused: the request has no ${PROXY_HEADER} header.')).toBeVisible()
})

test('opens nothing through a proxy that refuses the connection', { apps: ['closed'] }, async ({ closed }) => {
  await closed.goto('/')
})

test('opens nothing through a proxy that asks for credentials', { apps: ['challenged'] }, async ({ challenged }) => {
  await challenged.goto('/')
})
`,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 5000 }) })

  assert.equal(run.exit.code, 1, run.stderr)
  const outcome = (name: string) => {
    const found = testNamed(run, name)
    return [found.status, found.failure?.class]
  }

  // The app refuses a request without the proxy's header, so the page, its fetch, its service worker's fetch and its
  // frame of another site each answered only because the proxy carried them.
  assert.deepEqual(outcome('sends every request of the page through the proxy'), ['passed', undefined])
  for (const path of ['', 'data', 'worker.js', 'from-worker']) {
    assert.ok(carried(proxy).includes(`GET ${app.url}${PROXY_CHECK_PATH}${path}`), `the proxy carried ${PROXY_CHECK_PATH}${path}`)
  }
  assert.ok(carried(proxy).includes(`GET http://localhost:${port}${PROXY_CHECK_PATH}frame`), 'the proxy carried the frame of another site')

  // The app answered the bypassed address with its refusal, so the request reached it without the proxy's header.
  assert.deepEqual(outcome('sends a host in the bypass list around the proxy'), ['passed', undefined])
  assert.ok(!carried(proxy).includes(`GET ${bypassed}`), 'the proxy never saw the bypassed address')
  assert.ok(app.refused() >= 1)

  assert.deepEqual(outcome('opens nothing through a proxy that refuses the connection'), ['error', 'setup_failed'])
  assert.equal(
    testNamed(run, 'opens nothing through a proxy that refuses the connection').failure?.message,
    `Could not open ${app.url}/ through the proxy ${closed}: net::ERR_PROXY_CONNECTION_FAILED. The proxy failed, not the app.`,
  )

  // Retest answers no challenge. Chrome then gives the error it gives for a site's own, so the failure is the page's.
  assert.deepEqual(outcome('opens nothing through a proxy that asks for credentials'), ['failed', 'not_actionable'])
  assert.equal(
    testNamed(run, 'opens nothing through a proxy that asks for credentials').failure?.message,
    `Could not open ${app.url}/: net::ERR_INVALID_AUTH_CREDENTIALS.`,
  )
  assert.ok(carried(challenging).includes(`GET ${app.url}/`), 'the challenging proxy saw the request, and answered 407')

  const started = eventsOf(run.events, 'browser.started')
  assert.deepEqual(
    started.map((event) => [event.app, event.target?.proxy]),
    [
      ['web', { server: proxy.url, bypass: ['<-loopback>'] }],
      ['aside', { server: proxy.url, bypass: ['<-loopback>', 'localhost'] }],
      ['closed', { server: closed, bypass: ['<-loopback>'] }],
      ['challenged', { server: challenging.url, bypass: ['<-loopback>'] }],
    ],
  )
  assert.equal(new Set(started.map((event) => event.pid)).size, 1, 'targets that differ only by proxy share one browser')

  // The report replayed from the folder shows each target's proxy where its browser started.
  const report = await runCli(t, ['inspect', run.output], { env: { NO_COLOR: '1' } })
  assert.equal(report.exit.code, 0, report.stderr)
  assert.ok(report.stdout.includes(`· proxy ${proxy.url} · bypass <-loopback>, localhost\n`), report.stdout)
  assert.ok(report.stdout.includes(`· proxy ${closed} · bypass <-loopback>\n`), report.stdout)
})

test('doctor names each target’s proxy, and does not check it', async (t) => {
  const app = await openApp(t)
  const closed = `http://127.0.0.1:${await freePort()}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)}, proxy: { server: ${JSON.stringify(closed)}, bypass: ['<-loopback>'] } }) } }`),
  })
  const doctor = await runCli(t, ['doctor'], { cwd: root, env: { NO_COLOR: '1' } })

  assert.equal(doctor.exit.code, 0, `${doctor.stdout}\n${doctor.stderr}`)
  assert.ok(doctor.stdout.includes(`· proxy ${closed} · bypass <-loopback>`), doctor.stdout)
})
