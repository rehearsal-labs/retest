import type { LoadedApp, LoadedTarget } from '../../src/config/loaded.ts'
import type { BrowserPoolOptions, StartedTarget } from '../../src/runner/browser-pool.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { LaunchError } from '../../src/browser/contract.ts'
import { BrowserError } from '../../src/browser/browser-error.ts'
import { ProcessLaunchError } from '../../src/browser/chromium-process.ts'
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
  test('a pipe disconnect holds the browser lease until its close succeeds', async () => {
    const { pool: browsers, launched } = pool()
    const ready = await browsers.ensure(appOf('web', stable), stable)
    assert.ok(ready.ok)
    let free = false
    const proof = browsers.whenFree(ready.value.browser).then(() => { free = true })
    launched.browsers[0]?.disconnect('the pipe closed before the process stopped')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(free, false)
    await browsers.close()
    await proof
    assert.equal(free, true)
  })

  test('a failed browser cleanup is reported and its free proof stays pending', async () => {
    const { pool: browsers, launched } = pool()
    const ready = await browsers.ensure(appOf('web', stable), stable)
    assert.ok(ready.ok)
    const browser = launched.browsers[0]
    assert.ok(browser !== undefined)
    browser.close = async () => { throw new BrowserError({ class: 'cleanup_failed', message: 'The owned process could not be stopped.' }) }
    let free = false
    void browsers.whenFree(browser).then(() => { free = true })
    await assert.rejects(browsers.close(), (error: unknown) => error instanceof BrowserError && error.failure.class === 'cleanup_failed')
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.equal(free, false)
  })

  test('a runtime process proof frees the lease even when closing reports another cleanup failure', async () => {
    const { pool: browsers, launched } = pool()
    const ready = await browsers.ensure(appOf('web', stable), stable)
    assert.ok(ready.ok)
    const browser = launched.browsers[0]
    assert.ok(browser !== undefined)
    const gone = Promise.withResolvers<void>()
    Object.defineProperty(browser, 'gone', { value: gone.promise })
    browser.close = async () => { throw new BrowserError({ class: 'cleanup_failed', message: 'The process stopped but closing its log failed.' }) }
    let free = false
    const proof = browsers.whenFree(browser).then(() => { free = true })
    await assert.rejects(browsers.close(), /closing its log failed/)
    assert.equal(free, false)
    gone.resolve()
    await proof
    assert.equal(free, true)
  })

  test('a rejected Chromium launch stays in cleanup while its owned processes remain', async () => {
    const gone = Promise.withResolvers<void>()
    const { pool: browsers } = pool({
      launch: async () => { throw new ProcessLaunchError('The launch failed and its process remained.', gone.promise, { failureClass: 'cleanup_failed' }) },
      timeouts: { setup: 100, cleanup: 10 },
    })
    const ready = await browsers.ensure(appOf('web', stable), stable)
    assert.ok(!ready.ok)
    assert.equal(ready.failure.class, 'cleanup_failed')
    await assert.rejects(browsers.close(), /abandoned browser or Electron launch did not finish cleanup/)
    gone.resolve()
  })

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

  test('a setup queued or in flight when the pool closes launches nothing the close leaves behind', async () => {
    const gate = Promise.withResolvers<void>()
    const fake = fakeLauncher()
    const launches: string[] = []
    const { pool: browsers, started } = pool({
      launch: async (options, timeoutMs) => {
        launches.push(options.executablePath)
        if (options.executablePath === '/fake/beta') await gate.promise
        return fake.launch(options, timeoutMs)
      },
    })
    const web = appOf('web', stable, beta, phone)
    const first = await browsers.ensure(web, stable)
    assert.ok(first.ok)
    // The second launch is in flight and the third queued behind it when the pool closes.
    const second = browsers.ensure(web, beta)
    const third = browsers.ensure(web, phone)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const closing = browsers.close()
    gate.resolve()
    const [beta2, phone3] = await Promise.all([second, third])
    await closing
    assert.deepEqual([beta2.ok, phone3.ok], [false, false], 'neither target is handed a browser')
    assert.deepEqual(launches, ['/fake/stable', '/fake/beta'], 'the queued launch never starts')
    assert.deepEqual(fake.browsers.map((browser) => [browser.executablePath, browser.closed]), [['/fake/stable', true], ['/fake/beta', true]], 'the launch in flight is closed with the rest')
    assert.deepEqual(started.map(({ info }) => info.target?.name), ['stable'], 'nothing is announced after the close')
  })
})

describe('a target spread over several browsers', () => {
  test('each worker keeps to one browser, the first is told with how many there are, and the result lists the target once', async () => {
    const { pool: browsers, started, launched } = pool({ logFile: (app, target, instance) => `/logs/${app}-${target}-${instance}.log` })
    const web = appOf('web', stable)
    browsers.spread(web, stable, 2)
    const [zero, one, two] = await Promise.all([browsers.ensure(web, stable, 0), browsers.ensure(web, stable, 1), browsers.ensure(web, stable, 2)])
    assert.ok(zero.ok && one.ok && two.ok)
    assert.notEqual(zero.value.browser, one.value.browser)
    assert.equal(two.value.browser, zero.value.browser, 'the third worker shares the first browser')
    assert.deepEqual(launched.browsers.map((browser) => browser.launchOptions.logFile), ['/logs/web-stable-0.log', '/logs/web-stable-1.log'])
    assert.deepEqual(started.map(({ instance, instances, pid }) => [instance, instances, pid]), [
      [undefined, 2, launched.browsers[0]?.pid],
      [2, undefined, launched.browsers[1]?.pid],
    ])
    assert.equal(browsers.started.length, 1)
  })

  test('warming launches every browser of the target, which a later test finds ready', async () => {
    const { pool: browsers, launched } = pool()
    const web = appOf('web', stable)
    browsers.spread(web, stable, 3)
    browsers.warm(web, stable)
    const last = await browsers.ensure(web, stable, 2)
    assert.ok(last.ok)
    assert.equal(launched.browsers.length, 3)
    await browsers.ensure(web, stable, 0)
    await browsers.ensure(web, stable, 5)
    assert.equal(launched.browsers.length, 3, 'nothing launches twice')
  })

  test('a lost browser keeps only its own workers from running; the others go on in theirs', async () => {
    const { pool: browsers, launched, lost } = pool()
    const web = appOf('web', stable)
    browsers.spread(web, stable, 2)
    await browsers.ensure(web, stable, 0)
    await browsers.ensure(web, stable, 1)
    launched.browsers[1]?.disconnect('The browser process exited.')
    const onLost = await browsers.ensure(web, stable, 1)
    const onOther = await browsers.ensure(web, stable, 0)
    assert.deepEqual(onLost, { ok: false, failure: { class: 'session_lost', message: 'Not run: the browser was lost earlier in this run. The browser process exited.' } })
    assert.ok(onOther.ok)
    assert.deepEqual(lost, ['The browser process exited.'])
    await browsers.close()
    assert.deepEqual(launched.browsers.map((browser) => browser.closed), [true, true])
  })

  test('one browser is the default, and a count that is not a whole number from 1 is refused', async () => {
    const { pool: browsers, started, launched } = pool()
    const web = appOf('web', stable)
    const [zero, one] = await Promise.all([browsers.ensure(web, stable, 0), browsers.ensure(web, stable, 1)])
    assert.ok(zero.ok && one.ok)
    assert.equal(zero.value.browser, one.value.browser)
    assert.equal(launched.browsers.length, 1)
    assert.deepEqual([started[0]?.instance, started[0]?.instances], [undefined, undefined])
    assert.throws(() => browsers.spread(web, stable, 0), /A target runs in a whole number of browsers from 1, received 0\./)
    assert.throws(() => browsers.spread(web, stable, 1.5), /received 1\.5\./)
  })
})

describe('targets with spreads of their own', () => {
  test('one target spread over two browsers leaves another in one, whichever worker asks', async () => {
    const { pool: browsers, launched } = pool()
    const web = appOf('web', stable, beta)
    browsers.spread(web, stable, 2)
    const stableOnes = await Promise.all([browsers.ensure(web, stable, 0), browsers.ensure(web, stable, 1)])
    const betaOnes = await Promise.all([browsers.ensure(web, beta, 0), browsers.ensure(web, beta, 1)])
    assert.ok(stableOnes.every((ready) => ready.ok) && betaOnes.every((ready) => ready.ok))
    assert.deepEqual(launched.browsers.map((browser) => browser.executablePath), ['/fake/stable', '/fake/stable', '/fake/beta'])
  })
})
