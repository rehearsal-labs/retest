import type { FirefoxLaunchOptions } from '../../src/browser/firefox/launch.ts'
import type { LoadedApp, LoadedTarget } from '../../src/config/loaded.ts'
import type { BrowserPoolOptions, FindFirefox, StartedTarget } from '../../src/runner/browser-pool.ts'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable } from '../support/project.ts'
import { quickTimeouts } from '../support/run-harness.ts'

// The pool's Firefox branch with fakes: the Firefox a target finds is launched once by the machine's route, a target
// with no Firefox fails setup by name and launches nothing, a route the machine names wrongly is refused, and the
// runtime it hands out is named a Firefox one.

const firefox: LoadedTarget = { name: 'firefox', browser: 'firefox', headless: true }
const shown: LoadedTarget = { name: 'shown', browser: 'firefox', headless: false }

function appOf(...targets: LoadedTarget[]): LoadedApp {
  return { name: 'web', targets: new Map(targets.map((target) => [target.name, target])) }
}

const savedRoute = process.env['RETEST_FIREFOX_ROUTE']

afterEach(() => {
  if (savedRoute === undefined) delete process.env['RETEST_FIREFOX_ROUTE']
  else process.env['RETEST_FIREFOX_ROUTE'] = savedRoute
})

function pool(find: FindFirefox): { pool: BrowserPool; started: StartedTarget[]; launches: FirefoxLaunchOptions[] } {
  const fake = fakeLauncher()
  const launches: FirefoxLaunchOptions[] = []
  const started: StartedTarget[] = []
  const options: BrowserPoolOptions = {
    launch: async () => assert.fail('a Firefox target never launches Chromium'),
    findExecutable: fakeExecutable,
    launchFirefox: async (given, timeoutMs) => {
      launches.push(given)
      return fake.launch(given, timeoutMs)
    },
    findFirefox: find,
    logFile: (app, target) => `/logs/${app}-${target}.log`,
    headless: true,
    named: true,
    timeouts: quickTimeouts,
    stopped: new Promise(() => {}),
    interruption: () => undefined,
    onStarted: (entry) => void started.push(entry),
    onLost: () => {},
  }
  return { pool: new BrowserPool(options), started, launches }
}

const found: FindFirefox = async () => ({ ok: true, path: '/Applications/Firefox.app/Contents/MacOS/firefox' })

describe("the pool's Firefox targets", () => {
  test('a Firefox target launches the Firefox it found, once, by the route the machine names, and its runtime is a Firefox one', async () => {
    // Launch Services starts an app only on macOS, so elsewhere the one route a machine can name is spawn.
    const named = process.platform === 'darwin' ? 'launch-services' : 'spawn'
    process.env['RETEST_FIREFOX_ROUTE'] = named
    const { pool: browsers, started, launches } = pool(found)
    const first = await browsers.ensure(appOf(firefox), firefox)
    const again = await browsers.ensure(appOf(firefox), firefox)
    assert.ok(first.ok && again.ok)
    assert.equal(first.value.browser, again.value.browser)
    assert.equal(first.value.runtime.engine, 'firefox')
    assert.equal(launches.length, 1)
    assert.deepEqual([launches[0]?.executablePath, launches[0]?.route, launches[0]?.headless, launches[0]?.logFile], ['/Applications/Firefox.app/Contents/MacOS/firefox', named, true, '/logs/web-firefox.log'])
    assert.equal(started.length, 1)
    await browsers.close()
  })

  test('the spawn route is the default, and a target shown on screen launches a Firefox of its own', async () => {
    delete process.env['RETEST_FIREFOX_ROUTE']
    const { pool: browsers, launches } = pool(found)
    assert.ok((await browsers.ensure(appOf(firefox, shown), firefox)).ok)
    assert.ok((await browsers.ensure(appOf(firefox, shown), shown)).ok)
    assert.deepEqual(launches.map((launch) => [launch.route, launch.headless]), [['spawn', true], ['spawn', false]])
    await browsers.close()
  })

  test('a target with no Firefox fails setup with the reason it was given, and nothing launches', async () => {
    const missing: FindFirefox = async (target, app) => ({ ok: false, failure: { class: 'setup_failed', message: `No Firefox for the target ${target.name} of the app ${app}.` } })
    const { pool: browsers, launches } = pool(missing)
    const ready = await browsers.ensure(appOf(firefox), firefox)
    assert.deepEqual(ready, { ok: false, failure: { class: 'setup_failed', message: 'No Firefox for the target firefox of the app web.' } })
    assert.equal(launches.length, 0)
    await browsers.close()
  })

  test('a route the machine names that Retest does not know is refused by name before anything is found or launched', async () => {
    process.env['RETEST_FIREFOX_ROUTE'] = 'teleport'
    let asked = false
    const { pool: browsers, launches } = pool(async (target, app, env) => {
      asked = true
      return found(target, app, env)
    })
    const ready = await browsers.ensure(appOf(firefox), firefox)
    assert.ok(!ready.ok)
    assert.equal(ready.failure.class, 'setup_failed')
    assert.match(ready.failure.message, /RETEST_FIREFOX_ROUTE/)
    assert.deepEqual([asked, launches.length], [false, 0])
    await browsers.close()
  })
})
