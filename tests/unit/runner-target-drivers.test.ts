import type { LoadedConfig, LoadedTarget } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { runChecks } from '../../src/cli/doctor/checks.ts'
import { app, chromium } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { targetDriver } from '../../src/runner/target-drivers.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, runProject, tempProject } from '../support/project.ts'
import { eventsOfType, quickTimeouts } from '../support/run-harness.ts'

const path = '/work/retest.config.ts'

const firefox: LoadedTarget = { name: 'firefox', browser: 'firefox', headless: true }
const webkit: LoadedTarget = { name: 'webkit', browser: 'webkit', headless: true, executablePath: '/opt/webkit/MiniBrowser' }
const iphone: LoadedTarget = { name: 'iphone', platform: 'ios-simulator', appPath: '/work/build/Tasks.app', device: 'iPhone 17', runtime: '26.0' }
const mac: LoadedTarget = { name: 'mac', platform: 'macos', appPath: '/work/build/Tasks.app' }
const refused: [LoadedTarget, string, string][] = [
  [firefox, 'firefox', 'Retest has no driver for Firefox yet, so it cannot start the target firefox of the app web.'],
  [webkit, 'webkit', 'Retest has no driver for WebKit yet, so it cannot start the target webkit of the app web.'],
  [iphone, 'ios-simulator', 'Retest has no driver for iOS simulator apps yet, so it cannot start the target iphone of the app web.'],
  [mac, 'macos', 'Retest has no driver for macOS apps yet, so it cannot start the target mac of the app web.'],
]

function loaded(value: unknown): LoadedConfig {
  const result = validateConfig(value, path)
  assert.ok(result.ok, result.ok ? '' : result.failure.message)
  return result.config
}

function problems(value: unknown): string {
  const result = validateConfig(value, path)
  assert.ok(!result.ok, 'expected the config to be rejected')
  assert.equal(result.failure.class, 'usage')
  return result.failure.message
}

describe('the driver a target needs', () => {
  test('Chromium, Chrome and Edge run on the Chromium driver', () => {
    for (const target of [
      { name: 'chromium', browser: 'chromium', headless: true },
      { name: 'chrome', browser: 'chrome', channel: 'stable', headless: true },
      { name: 'edge', browser: 'edge', channel: 'beta', headless: true },
    ] as const) {
      assert.deepEqual(targetDriver('web', target), { ok: true, driver: 'chromium', target })
    }
  })

  test('every target with no driver yet is refused at setup, naming its driver, its app and its target', () => {
    for (const [target, driver, message] of refused) {
      assert.deepEqual(targetDriver('web', target), { ok: false, failure: { class: 'setup_failed', message, details: { app: 'web', target: target.name, driver } } })
    }
  })

  test('the pool refuses such a target without launching anything, and keeps refusing it', async () => {
    const launched = fakeLauncher()
    const pool = new BrowserPool({
      launch: launched.launch,
      findExecutable: fakeExecutable,
      logFile: (appName, target) => `/logs/${appName}-${target}.log`,
      headless: true,
      named: true,
      timeouts: quickTimeouts,
      stopped: new Promise(() => {}),
      interruption: () => undefined,
      onStarted: () => {},
      onLost: () => {},
    })
    for (const [target, , message] of refused) {
      const web = { name: 'web', targets: new Map([[target.name, target]]) }
      pool.warm(web, target)
      for (const attempt of [1, 2]) {
        const ensured = await pool.ensure(web, target)
        assert.ok(!ensured.ok, `${target.name}, attempt ${attempt}`)
        assert.equal(ensured.failure.message, message)
      }
    }
    assert.deepEqual(launched.browsers, [], 'no browser stands in for a target with no driver')
    assert.deepEqual(pool.started, [])
  })
})

describe('the config accepts targets that have no driver yet', () => {
  test('Firefox and WebKit targets, and iOS simulator and macOS apps, with their paths made absolute', () => {
    const config = loaded({
      apps: {
        browsers: app({ baseUrl: 'http://127.0.0.1:4173', targets: { chromium: chromium(), firefox: { browser: 'firefox' }, webkit: { browser: 'webkit', executablePath: 'webkit/MiniBrowser', headless: false } } }),
        iphone: { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.0' },
        mac: { platform: 'macos', appPath: 'build/Tasks.app', start: { command: 'node service.ts', ready: 'http://127.0.0.1:4100/' } },
      },
      defaultApp: 'browsers',
    })
    assert.deepEqual([...(config.apps.get('browsers')?.targets.values() ?? [])], [
      { name: 'chromium', headless: true, browser: 'chromium' },
      { name: 'firefox', headless: true, browser: 'firefox' },
      { name: 'webkit', headless: false, browser: 'webkit', executablePath: '/work/webkit/MiniBrowser' },
    ])
    assert.deepEqual([...(config.apps.get('iphone')?.targets.entries() ?? [])], [
      ['ios-simulator', { name: 'ios-simulator', platform: 'ios-simulator', appPath: '/work/build/Tasks.app', device: 'iPhone 17', runtime: '26.0' }],
    ])
    assert.deepEqual([...(config.apps.get('mac')?.targets.entries() ?? [])], [['macos', { name: 'macos', platform: 'macos', appPath: '/work/build/Tasks.app' }]])
    assert.deepEqual(config.apps.get('mac')?.start, { command: 'node service.ts', ready: 'http://127.0.0.1:4100/', cwd: '/work' })
  })

  test('an app whose targets are of two kinds is refused, as is a native app with an address', () => {
    const iosTarget = { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.0' } as const
    assert.match(
      problems({ apps: { tasks: app({ targets: { web: chromium(), phone: iosTarget } }) } }),
      /apps\.tasks\.targets: mixes browsers and iOS simulators\. An app's targets are all browsers, all iOS simulators or all macOS apps: give each kind an app of its own$/,
    )
    assert.match(problems({ apps: { mac: { platform: 'macos', appPath: 'build/Tasks.app', baseUrl: 'http://127.0.0.1:4173' } } }), /apps\.mac\.baseUrl: a native app has no address, so it takes no baseUrl$/)
    assert.match(problems({ apps: { phones: app({ baseUrl: 'http://127.0.0.1:4173', targets: { small: iosTarget } }) } }), /apps\.phones\.baseUrl: a native app has no address, so it takes no baseUrl$/)
  })

  test('a web app whose only target has a typo reports the typo alone, and nothing of its kind', () => {
    const typo = { apps: { web: { baseUrl: 'http://127.0.0.1:4173', targets: { chrome: { browser: 'chrome', headles: false } } } } }
    assert.equal(problems(typo), `${path}: apps.web.targets.chrome.headles: unknown key`)
  })

  test('a native target takes no browser settings, and needs its app, device and runtime', () => {
    const message = problems({
      apps: {
        mac: { platform: 'macos', appPath: 'build/Tasks.app', emulate: 'Pixel 9' },
        phone: { platform: 'ios-simulator', appPath: ' ', device: '', runtime: '26.0' },
        tablet: { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPad Pro 11' },
        android: { platform: 'android', appPath: 'build/app.apk' },
      },
    })
    assert.match(message, /apps\.mac\.emulate: unknown key/)
    assert.match(message, /apps\.phone\.appPath: expected a path, received " "/)
    assert.match(message, /apps\.phone\.device: expected a device type such as "iPhone 17", received ""/)
    assert.match(message, /apps\.tablet\.runtime: missing required key/)
    assert.match(message, /apps\.android\.platform: expected one of "ios-simulator", "macos", received "android"/)
  })
})

describe('a run refuses at planning each attempt whose target has no driver yet', async () => {
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173' }),
    firefox: { browser: 'firefox', baseUrl: 'http://127.0.0.1:4173' },
    webkit: { browser: 'webkit', baseUrl: 'http://127.0.0.1:4173' },
    iphone: { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.0' },
    mac: { platform: 'macos', appPath: 'build/Tasks.app' },
  },
  defaultApp: 'web',
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('runs on Chromium', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('task-title')).toBeVisible()
})
for (const app of ['firefox', 'webkit', 'iphone', 'mac'] as const) {
  test(\`runs on \${app}\`, { apps: [app] }, async () => {})
}
`
  const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/targets.retest.ts': tests }), { files: ['tests/targets.retest.ts'] })
  const results = record.result.files.flatMap((file) => file.tests)

  test('every refused attempt ends first, not run, with the setup failure that names its target, and the Chromium test runs', () => {
    // result.json lists the tests as the file declares them, as a result rebuilt from the events does; the events
    // below show the refusals ended first.
    assert.deepEqual(
      results.map((result) => [result.name, result.status, result.failure?.class, result.failure?.message]),
      [
        ['runs on Chromium', 'passed', undefined, undefined],
        ['runs on firefox', 'not_run', 'setup_failed', 'Retest has no driver for Firefox yet, so it cannot start the target firefox of the app firefox.'],
        ['runs on webkit', 'not_run', 'setup_failed', 'Retest has no driver for WebKit yet, so it cannot start the target webkit of the app webkit.'],
        ['runs on iphone', 'not_run', 'setup_failed', 'Retest has no driver for iOS simulator apps yet, so it cannot start the target ios-simulator of the app iphone.'],
        ['runs on mac', 'not_run', 'setup_failed', 'Retest has no driver for macOS apps yet, so it cannot start the target macos of the app mac.'],
      ],
    )
    const finished = eventsOfType(record.events, 'test.finished').map((event) => event.status)
    const started = eventsOfType(record.events, 'browser.started')
    assert.deepEqual(finished.slice(0, 4), ['not_run', 'not_run', 'not_run', 'not_run'], 'the refusals are written before anything runs')
    assert.ok(record.events.findIndex((event) => event.type === 'browser.started') > record.events.findIndex((event) => event.type === 'test.finished'))
    assert.equal(started.length, 1)
  })

  test('only Chromium launched, and the run is not a pass', () => {
    assert.equal(record.browsers.length, 1)
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.result.status, 'error')
    assert.deepEqual(record.result.counts, { passed: 1, failed: 0, error: 0, notRun: 4, inconclusive: 0 })
  })
})

describe('a refused attempt starts nothing', () => {
  test('a native app’s start command is never run, and the refusal is the failure', async () => {
    const config = `import { defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    mac: {
      platform: 'macos',
      appPath: 'build/Tasks.app',
      start: { command: 'node -e "require(\\'node:fs\\').writeFileSync(\\'started\\', \\'\\')"', ready: 'http://127.0.0.1:9/' },
    },
  },
})
`
    const tests = `import { test } from '@rehearsal-labs/retest'

test('syncs on the Mac', async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/mac.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/mac.retest.ts'] })
    const [result] = record.result.files.flatMap((file) => file.tests)
    assert.deepEqual([result?.status, result?.failure?.message], ['not_run', 'Retest has no driver for macOS apps yet, so it cannot start the target macos of the app mac.'])
    assert.equal(existsSync(join(root, 'started')), false, 'the start command never ran')
    assert.deepEqual(record.events.filter((event) => event.type.startsWith('app.')), [], 'no server started, failed or was reused')
    assert.deepEqual([record.browsers.length, record.result.browser], [0, null])
  })

  test('a test on a web app and a native app launches no browser for the web app', async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }), mac: { platform: 'macos', appPath: 'build/Tasks.app' } },
  defaultApp: 'web',
})
`
    const tests = `import { test } from '@rehearsal-labs/retest'

test('creates on the web, checks on the Mac', { apps: ['web', 'mac'] }, async () => {})
`
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/mixed.retest.ts': tests }), { files: ['tests/mixed.retest.ts'] })
    const [result] = record.result.files.flatMap((file) => file.tests)
    assert.deepEqual([result?.status, result?.failure?.message], ['not_run', 'Retest has no driver for macOS apps yet, so it cannot start the target macos of the app mac.'])
    assert.equal(record.browsers.length, 0, 'Chromium never launched')
    assert.deepEqual(eventsOfType(record.events, 'browser.started'), [])
    assert.equal(record.result.browser, null)
    assert.equal(record.result.browsers?.length ?? 0, 0)
  })

  test('refused attempts take no share of the browsers the run spreads a target’s tests over', async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }), firefox: { browser: 'firefox', baseUrl: 'http://127.0.0.1:4173' } },
  defaultApp: 'web',
})
`
    const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('runs on Chromium', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('task-title')).toBeVisible()
})
for (const name of ['one', 'two', 'three']) test(\`runs on Firefox \${name}\`, { apps: ['firefox'] }, async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': tests, 'tests/b.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/a.retest.ts', 'tests/b.retest.ts'], workers: 2, browsers: 2 })
    const results = record.result.files.flatMap((file) => file.tests)
    assert.deepEqual(results.filter((result) => result.status === 'passed').map((result) => result.name), ['runs on Chromium', 'runs on Chromium'])
    // Counted with the six refused attempts, Chromium's two of eight would earn one browser of the two.
    assert.equal(record.browsers.length, 2, 'Chromium keeps both browsers')
    assert.deepEqual(eventsOfType(record.events, 'browser.started').map((event) => event.instances ?? event.instance), [2, 2])
  })
})

describe('a setup only refused tests need', () => {
  const config = `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    web: chromium({
      baseUrl: 'http://127.0.0.1:4173',
      start: { command: 'node -e "require(\\'node:fs\\').writeFileSync(\\'started\\', \\'\\')"', ready: 'http://127.0.0.1:9/' },
    }),
    mac: { platform: 'macos', appPath: 'build/Tasks.app' },
  },
  defaultApp: 'web',
  secrets: { password: env('TASK_APP_PASSWORD') },
  states: ['signed-in'],
})
`
  const setup = `import { expect, secret, test } from '@rehearsal-labs/retest'

test.setup('signed-in', { apps: ['web'] }, async ({ web }) => {
  await web.goto('/login')
  await web.getByTestId('task-title').fill(secret('password'))
  await expect(web.getByTestId('missing')).toBeVisible()
})
`
  const sync = `import { test } from '@rehearsal-labs/retest'

test('syncs', { apps: ['web', 'mac'], state: { web: 'signed-in' } }, async () => {})
`

  test('does not run: no server starts, no browser launches, and the run exits 2 for the refusal alone', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/setup.retest.ts': setup, 'tests/sync.retest.ts': sync })
    const record = await runProject(root, {
      files: ['tests/setup.retest.ts', 'tests/sync.retest.ts'],
      selection: { grep: 'syncs' },
      env: { TASK_APP_PASSWORD: 'hunter2-long-enough' },
    })
    const results = record.result.files.flatMap((file) => file.tests)
    assert.deepEqual(
      results.map((result) => [result.name, result.status, result.failure?.message]),
      [['syncs', 'not_run', 'Retest has no driver for macOS apps yet, so it cannot start the target macos of the app mac.']],
    )
    assert.equal(existsSync(join(root, 'started')), false, 'the web server never started')
    assert.deepEqual(record.events.filter((event) => event.type.startsWith('app.') || event.type === 'test.started' || event.type === 'action.completed'), [])
    assert.deepEqual([record.browsers.length, record.result.browser], [0, null])
    assert.deepEqual([record.result.exitCode, record.result.counts], [2, { passed: 0, failed: 0, error: 0, notRun: 1, inconclusive: 0 }])
  })

  test('still starts when the selection chose it for itself', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/setup.retest.ts': setup, 'tests/sync.retest.ts': sync })
    const record = await runProject(root, { files: ['tests/setup.retest.ts', 'tests/sync.retest.ts'], env: { TASK_APP_PASSWORD: 'hunter2-long-enough' } })
    const names = record.result.files.flatMap((file) => file.tests).map((result) => result.name)
    assert.deepEqual(names.sort(), ['signed-in', 'syncs'])
    assert.equal(existsSync(join(root, 'started')), true, 'the setup asked for its app server')
  })
})

describe('doctor', () => {
  test('refuses each target that has no driver yet, as a run does, and launches nothing for it', async () => {
    const config = loaded({
      apps: {
        web: app({ targets: { chromium: chromium({ executablePath: '/fake/chromium' }), firefox: { browser: 'firefox' } } }),
        iphone: { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.0' },
        mac: { platform: 'macos', appPath: 'build/Tasks.app' },
      },
    })
    const launched = fakeLauncher()
    const checks = await runChecks(config, {
      dependencies: {
        resolveExecutable: (target) => ({ ok: true, path: target.browser === 'chromium' ? (target.executablePath ?? '/fake/chromium') : `/fake/${target.browser}` }),
        launchBrowser: (options, timeoutMs) => launched.launch(options, timeoutMs),
        probeReady: async () => true,
        startAppServer: () => Promise.reject(new Error('no server is started')),
        env: {},
        signal: new AbortController().signal,
      },
      timeouts: defaultTimeouts,
      logFolder: '/tmp/retest-doctor-unused',
    })
    assert.deepEqual(
      checks.map(({ group, subject, ok, text }) => [group, subject, ok, ok ? '' : text]),
      [
        ['web', 'chromium()', true, ''],
        ['web', "{ browser: 'firefox' }", false, 'Retest has no driver for Firefox yet, so it cannot start the target firefox of the app web.'],
        ['iphone', "{ platform: 'ios-simulator', device: 'iPhone 17', runtime: '26.0' }", false, 'Retest has no driver for iOS simulator apps yet, so it cannot start the target ios-simulator of the app iphone.'],
        ['mac', "{ platform: 'macos' }", false, 'Retest has no driver for macOS apps yet, so it cannot start the target macos of the app mac.'],
      ],
    )
    assert.equal(launched.browsers.length, 1, 'only the Chromium target launched')
  })
})
