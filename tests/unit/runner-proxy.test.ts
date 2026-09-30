import type { LoadedConfig } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { runFiles } from '../../src/runner/run.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, runProject, tempProject } from '../support/project.ts'
import { eventsOfType, newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'

const config = `import { app, chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: app({
      baseUrl: 'http://127.0.0.1:4173',
      targets: {
        proxied: chromium({ executablePath: '/fake/chromium', proxy: { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal'] } }),
        direct: chromium({ executablePath: '/fake/chromium' }),
      },
    }),
    admin: chromium({ baseUrl: 'http://127.0.0.1:4174', executablePath: '/fake/chromium', proxy: { server: 'socks5://127.0.0.1:1080' } }),
  },
  defaultApp: 'web',
})
`

const tests = `import { expect, test } from '@rehearsal-labs/retest'
test('opens both', { apps: ['web', 'admin'] }, async ({ web, admin }) => {
  await web.goto('/')
  await admin.goto('/')
  expect(true).toBe(true)
})
`

describe('a proxy for each target', async () => {
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/proxy.retest.ts': tests }), { files: ['tests/proxy.retest.ts'] })
  const pages = record.browsers.flatMap((browser) => browser.pages)

  test("each app's page gets a browser context with its own target's proxy, and none without one; one browser serves them all", () => {
    assert.equal(record.result.exitCode, 0)
    assert.equal(record.browsers.length, 1, 'targets that differ only by proxy share one browser')
    assert.deepEqual(
      pages.map((page) => [page.baseUrl, page.options.proxy]),
      [
        ['http://127.0.0.1:4173', { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal'] }],
        ['http://127.0.0.1:4174', { server: 'socks5://127.0.0.1:1080', bypass: [] }],
        ['http://127.0.0.1:4173', undefined],
        ['http://127.0.0.1:4174', { server: 'socks5://127.0.0.1:1080', bypass: [] }],
      ],
    )
  })

  test('browser.started records each app target with its server and bypass list', () => {
    assert.deepEqual(
      eventsOfType(record.events, 'browser.started').map((event) => [event.app, event.target]),
      [
        ['web', { name: 'proxied', proxy: { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal'] } }],
        ['admin', { name: 'chromium', proxy: { server: 'socks5://127.0.0.1:1080' } }],
        ['web', { name: 'direct' }],
      ],
    )
    assert.deepEqual(record.result.browsers?.map((browser) => browser.target?.proxy?.server), ['http://127.0.0.1:8080', 'socks5://127.0.0.1:1080', undefined])
  })
})

describe('a proxy address that holds credentials', () => {
  test('is never recorded with them, even from a config built without validation', async () => {
    const folder = newRunFolder()
    const { launch, browsers } = fakeLauncher()
    const proxy = { server: 'http://ada:hunter2-7391@127.0.0.1:8080', bypass: [] }
    const target = { name: 'chromium', browser: 'chromium', executablePath: '/fake/chromium', headless: true, proxy } as const
    const loaded: LoadedConfig = {
      file: '/work/retest.config.ts',
      apps: new Map([['web', { name: 'web', baseUrl: 'http://127.0.0.1:4173', targets: new Map([['chromium', target]]) }]]),
      defaultApp: 'web',
      runs: [],
      secrets: new Map(),
      timeouts: {},
    }
    const root = tempProject({ 'tests/a.retest.ts': "import { expect, test } from '@rehearsal-labs/retest'\ntest('runs', () => expect(1).toBe(1))\n" })
    const result = await runFiles(
      { files: ['tests/a.retest.ts'], rootDir: root, apps: { kind: 'config', config: loaded, secrets: new Map() }, timeouts: quickTimeouts, outputDir: folder, headless: true, signal: new AbortController().signal },
      [],
      launch,
      fakeExecutable,
    )
    const { lines } = readEvents(folder)
    assert.equal(result.exitCode, 0)
    assert.equal(browsers[0]?.pages[0]?.options.proxy?.server, proxy.server, 'the browser context is given the address it was configured with')
    assert.equal(result.browsers?.[0]?.target?.proxy?.server, 'http://127.0.0.1:8080/')
    assert.ok(!lines.some((line) => line.includes('hunter2-7391') || line.includes('ada:')))
  })
})
