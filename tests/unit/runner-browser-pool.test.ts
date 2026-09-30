import type { LoadedApp, LoadedTarget } from '../../src/config/loaded.ts'
import type { BrowserPoolOptions, StartedTarget } from '../../src/runner/browser-pool.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LaunchError } from '../../src/browser/contract.ts'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable } from '../support/project.ts'
import { quickTimeouts } from '../support/run-harness.ts'

function appOf(name: string, ...targets: LoadedTarget[]): LoadedApp {
  return { name, targets: new Map(targets.map((target) => [target.name, target])) }
}

const stable: LoadedTarget = { name: 'stable', browser: 'chromium', headless: true, executablePath: '/fake/stable' }
const beta: LoadedTarget = { name: 'beta', browser: 'chromium', headless: true, executablePath: '/fake/beta' }
const phone: LoadedTarget = { ...stable, name: 'phone', emulate: 'Pixel 9' }

function pool(overrides: Partial<BrowserPoolOptions> = {}): { pool: BrowserPool; started: StartedTarget[]; lost: string[]; launched: ReturnType<typeof fakeLauncher> } {
  const launched = fakeLauncher()
  const started: StartedTarget[] = []
  const lost: string[] = []
  const options: BrowserPoolOptions = {
    launch: launched.launch,
    findExecutable: fakeExecutable,
    logFile: (app, target) => `/logs/${app}-${target}.log`,
    headless: true,
    named: true,
    timeouts: quickTimeouts,
    stopped: new Promise(() => {}),
    interruption: () => undefined,
    onStarted: (entry) => void started.push(entry),
    onLost: (_browser, reason) => void lost.push(reason),
    ...overrides,
  }
  return { pool: new BrowserPool(options), started, lost, launched }
}

describe('BrowserPool', () => {
  test('launches each distinct target once, and tells of each app target the first time it is used', async () => {
    const { pool: browsers, started, launched } = pool()
    const web = appOf('web', stable, beta)
    const admin = appOf('admin', stable)
    const first = await browsers.ensure(web, stable)
    const again = await browsers.ensure(web, stable)
    const shared = await browsers.ensure(admin, stable)
    await browsers.ensure(web, beta)
    assert.ok(first.ok && again.ok && shared.ok)
    assert.equal(first.value.browser, shared.value.browser, 'apps on the same target share its browser')
    assert.deepEqual(launched.browsers.map((browser) => [browser.executablePath, browser.launchOptions.logFile]), [
      ['/fake/stable', '/logs/web-stable.log'],
      ['/fake/beta', '/logs/web-beta.log'],
    ])
    assert.deepEqual(started.map(({ info, pid }) => [info.app, info.target?.name, pid]), [
      ['web', 'stable', launched.browsers[0]?.pid],
      ['admin', 'stable', launched.browsers[0]?.pid],
      ['web', 'beta', launched.browsers[1]?.pid],
    ])
    assert.equal(browsers.started.length, 3)
  })

  test('an emulated target is a browser of its own, and its pages get the emulation for that browser version', async () => {
    const { pool: browsers, started, launched } = pool()
    const web = appOf('web', stable, phone)
    await browsers.ensure(web, stable)
    const emulated = await browsers.ensure(web, phone)
    assert.ok(emulated.ok)
    assert.equal(launched.browsers.length, 2)
    assert.match(emulated.value.emulation?.userAgent ?? '', /Chrome\/140\.0\.0\.0 Mobile/)
    assert.deepEqual(started[1]?.info.target, { name: 'phone', emulation: emulated.value.emulation, device: 'Pixel 9' })
  })

  test('--headed shows every browser; otherwise each target keeps its own setting', async () => {
    const headed = { ...stable, name: 'headed', headless: false }
    const shown = pool({ headless: false })
    await shown.pool.ensure(appOf('web', stable), stable)
    assert.equal(shown.launched.browsers[0]?.launchOptions.headless, false)
    const own = pool()
    await own.pool.ensure(appOf('web', headed), headed)
    assert.equal(own.launched.browsers[0]?.launchOptions.headless, false)
  })

  test('a browser that fails to launch, or cannot be found, fails every app target that needs it without trying again', async () => {
    let attempts = 0
    const failing = pool({
      launch: async () => {
        attempts++
        throw new LaunchError('No browser at /fake/stable.')
      },
    })
    const web = appOf('web', stable)
    const first = await failing.pool.ensure(web, stable)
    const second = await failing.pool.ensure(appOf('admin', stable), stable)
    assert.deepEqual([first, second].map((opened) => (opened.ok ? undefined : opened.failure)), [
      { class: 'setup_failed', message: 'No browser at /fake/stable.' },
      { class: 'setup_failed', message: 'No browser at /fake/stable.' },
    ])
    assert.equal(attempts, 1)
    const missing = pool({ findExecutable: async () => ({ ok: false, failure: { class: 'setup_failed', message: 'Chrome Beta is not installed.' } }) })
    const opened = await missing.pool.ensure(web, stable)
    assert.deepEqual(opened, { ok: false, failure: { class: 'setup_failed', message: 'Chrome Beta is not installed.' } })
    assert.equal(missing.launched.browsers.length, 0)
  })

  test('a lost browser is not launched again: later tests are told it was lost, and the pool says so once', async () => {
    const { pool: browsers, lost, launched } = pool()
    const web = appOf('web', stable)
    await browsers.ensure(web, stable)
    const [browser] = launched.browsers
    assert.ok(browser && browsers.connected(browser))
    browser.disconnect('The browser process exited.')
    browser.disconnect('again')
    const later = await browsers.ensure(web, stable)
    assert.deepEqual(later, { ok: false, failure: { class: 'session_lost', message: 'Not run: the browser was lost earlier in this run. The browser process exited.' } })
    assert.deepEqual(lost, ['The browser process exited.'])
    assert.equal(browsers.connected(browser), false)
    assert.equal(launched.browsers.length, 1)
  })

  test("milestone 1's browser names no app or target", async () => {
    const { pool: browsers, started } = pool({ named: false })
    await browsers.ensure(appOf('page', stable), stable)
    assert.deepEqual(started[0]?.info, { product: 'FakeChromium', version: '140.0.0.0', executablePath: '/fake/stable' })
  })

  test('closes every browser once, including one that was lost, and refuses targets afterwards', async () => {
    const { pool: browsers, launched } = pool()
    await browsers.ensure(appOf('web', stable, beta), stable)
    await browsers.ensure(appOf('web', stable, beta), beta)
    launched.browsers[1]?.disconnect('gone')
    await Promise.all([browsers.close(), browsers.close()])
    assert.deepEqual(launched.browsers.map((browser) => [browser.closed, browser.closeBudget]), [[true, quickTimeouts.cleanup], [true, quickTimeouts.cleanup]])
    const after = await browsers.ensure(appOf('web', stable), stable)
    assert.equal(after.ok, false)
  })
})
