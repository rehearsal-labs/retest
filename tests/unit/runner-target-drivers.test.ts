import type { LoadedConfig, LoadedTarget } from '../../src/config/loaded.ts'
import type { NativeTools } from '../../src/native/processes.ts'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { buildPlatform } from '../../src/browser/builds.ts'
import { runChecks } from '../../src/cli/doctor/checks.ts'
import { app, chromium } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { BrowserPool } from '../../src/runner/browser-pool.ts'
import { targetDriver } from '../../src/runner/target-drivers.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, runProject, tempProject } from '../support/project.ts'
import { eventsOfType, quickTimeouts } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { fakeTools } from './native-fake-tools.ts'

const path = '/work/retest.config.ts'

// Retest runs WebKit on macOS only; on any other host a WebKit target fails its setup for that, whatever build it names.
const webKitHostRefusal = process.platform === 'darwin' ? undefined : `Retest runs WebKit on macOS only, and this host is ${process.platform}.`

const firefox: LoadedTarget = { name: 'firefox', browser: 'firefox', headless: true }
const webkit: LoadedTarget = { name: 'webkit', browser: 'webkit', headless: true, executablePath: '/opt/webkit/MiniBrowser' }
const iphone: LoadedTarget = { name: 'iphone', platform: 'ios-simulator', appPath: '/work/build/Tasks.app', device: 'iPhone 17', runtime: '26.0' }
const mac: LoadedTarget = { name: 'mac', platform: 'macos', appPath: '/work/build/Tasks.app' }
const refused: [LoadedTarget, string, string][] = [
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

  test('Firefox runs on the Firefox driver', () => {
    assert.deepEqual(targetDriver('web', firefox), { ok: true, driver: 'firefox', target: firefox })
  })

  test('WebKit runs on the WebKit driver', () => {
    assert.deepEqual(targetDriver('web', webkit), { ok: true, driver: 'webkit', target: webkit })
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

// WebKit has a driver now, so its attempts are not refused at planning: one whose build is missing fails its setup by
// name, as a native app with no bundle does, and nothing stands in for it.
describe('a run refuses at planning each attempt whose target has no driver yet', async () => {
  const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173' }),
    webkit: { browser: 'webkit', executablePath: 'no-webkit-build', baseUrl: 'http://127.0.0.1:4173' },
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
for (const app of ['webkit', 'iphone', 'mac'] as const) {
  test(\`runs on \${app}\`, { apps: [app] }, async () => {})
}
`
  const root = tempProject({ 'retest.config.ts': config, 'tests/targets.retest.ts': tests })
  const record = await runProject(root, { files: ['tests/targets.retest.ts'] })
  const results = record.result.files.flatMap((file) => file.tests)

  test('a WebKit attempt whose build is missing ends at its setup naming the path, before it starts, and the Chromium test runs', { skip: webKitHostRefusal === undefined ? false : `unverified: ${webKitHostRefusal} A WebKit target is refused for its host before any build is looked for.` }, () => {
    assert.deepEqual(
      results.slice(0, 2).map((result) => [result.name, result.status, result.failure?.class]),
      [
        ['runs on Chromium', 'passed', undefined],
        ['runs on webkit', 'not_run', 'setup_failed'],
      ],
    )
    const webkit = results[1]
    assert.equal(webkit?.failure?.message, `No WebKit build at ${join(root, 'no-webkit-build')}, the path executablePath gives: nothing is there. Give executablePath the folder of an unpacked Playwright WebKit build 2359 for mac26-arm64, or the executable inside it.`)
    const own = record.events.filter((event) => 'testId' in event && event.testId === webkit?.testId).map((event) => event.type)
    assert.deepEqual(own, ['test.finished'], 'the WebKit attempt ended at its setup, before it started')
    assert.equal(eventsOfType(record.events, 'browser.started').length, 1, 'only Chromium started; no browser stood in for WebKit')
  })

  // Native targets have a driver now: their attempts are not refused at planning. Each takes its lease, then starts its
  // app, which here fails because the project holds no app bundle.
  test('a native app is not refused at planning: it takes its lease and starts, and an app with no bundle fails its setup by name', () => {
    assert.deepEqual(
      results.slice(2).map((result) => [result.name, result.status, result.failure?.class]),
      [
        ['runs on iphone', 'not_run', 'setup_failed'],
        ['runs on mac', 'not_run', 'setup_failed'],
      ],
    )
    const [iphone, mac] = results.slice(2)
    assert.ok(iphone?.failure?.message.startsWith(`Retest cannot read the app's Info.plist at ${join(root, 'build/Tasks.app/Info.plist')}: `), iphone?.failure?.message)
    assert.ok(mac?.failure?.message.startsWith(`Retest cannot read the app's Info.plist at ${join(root, 'build/Tasks.app/Contents/Info.plist')}: `), mac?.failure?.message)
    for (const result of [iphone, mac]) {
      const own = record.events.filter((event) => 'testId' in event && event.testId === result?.testId).map((event) => event.type)
      assert.deepEqual(own, ['resource.acquired', 'lease.taken', 'test.finished'], `${result?.name} took its lease before it ended`)
    }
    assert.deepEqual(eventsOfType(record.events, 'native.started'), [], 'no app was started')
  })

  test('only Chromium launched, and the run is not a pass', () => {
    assert.equal(record.browsers.length, 1)
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.result.status, 'error')
    assert.deepEqual(record.result.counts, { passed: 1, failed: 0, error: 0, notRun: 3, inconclusive: 0 })
  })
})

describe('a refused attempt starts nothing', () => {
  const writesStarted = `node -e "require(\\'node:fs\\').writeFileSync(\\'started\\', \\'\\')"`

  // WebKit has a driver now, so its app's start command runs as a web app's does, beside the browser it asks for; here
  // the server never answers, and that is the failure, whatever became of the build.
  test('a WebKit app’s start command runs as a web app’s does, and a server that never answers is the failure', async () => {
    const config = `import { defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    webkit: { browser: 'webkit', executablePath: 'no-webkit-build', baseUrl: 'http://127.0.0.1:4173', start: { command: '${writesStarted}', ready: 'http://127.0.0.1:9/' } },
  },
})
`
    const tests = `import { test } from '@rehearsal-labs/retest'

test('syncs on WebKit', async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/webkit.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/webkit.retest.ts'] })
    const [result] = record.result.files.flatMap((file) => file.tests)
    assert.equal(result?.status, 'not_run')
    assert.match(result?.failure?.message ?? '', /^The server for webkit exited with exit code 0 before http:\/\/127\.0\.0\.1:9\/ answered\. Its output is in \S+\.log\.$/)
    assert.equal(existsSync(join(root, 'started')), true, 'the start command ran')
    assert.deepEqual(eventsOfType(record.events, 'test.started'), [], 'the test never started')
    assert.deepEqual([record.browsers.length, record.result.browser], [0, null])
  })

  // Native apps are no longer refused, so their start command runs as a web app's does: inside the attempt's lease,
  // before the app it serves, which does not start once its server fails.
  test('a native app’s start command runs inside its lease, before its app, and a server that never answers is the failure', async () => {
    const config = `import { defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    mac: { platform: 'macos', appPath: 'build/Tasks.app', start: { command: '${writesStarted}', ready: 'http://127.0.0.1:9/' } },
  },
})
`
    const tests = `import { test } from '@rehearsal-labs/retest'

test('syncs on the Mac', async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/mac.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/mac.retest.ts'] })
    const [result] = record.result.files.flatMap((file) => file.tests)
    assert.equal(result?.status, 'not_run')
    assert.match(result?.failure?.message ?? '', /^The server for mac exited with exit code 0 before http:\/\/127\.0\.0\.1:9\/ answered\. Its output is in \S+\.log\.$/)
    assert.equal(existsSync(join(root, 'started')), true, 'the start command ran')
    const types = record.events.map((event) => event.type)
    assert.ok(types.indexOf('lease.taken') >= 0 && types.indexOf('lease.taken') < types.indexOf('app.failed'), types.join(', '))
    assert.deepEqual(eventsOfType(record.events, 'native.started'), [], 'the app never started')
    assert.deepEqual([record.browsers.length, record.result.browser], [0, null])
  })

  // WebKit has a driver now, so a test on a web app and a WebKit app readies each in the order the test names them: here
  // Chromium, then WebKit, whose missing build keeps the test from running; the browser launched for the web app is closed.
  test('a test on a web app and a WebKit app whose build is missing readies Chromium, fails at WebKit, and closes the browser it launched', async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }), webkit: { browser: 'webkit', executablePath: 'no-webkit-build', baseUrl: 'http://127.0.0.1:4173' } },
  defaultApp: 'web',
})
`
    const tests = `import { test } from '@rehearsal-labs/retest'

test('creates on Chromium, checks on WebKit', { apps: ['web', 'webkit'] }, async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/mixed.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/mixed.retest.ts'] })
    const [result] = record.result.files.flatMap((file) => file.tests)
    assert.equal(result?.status, 'not_run')
    if (webKitHostRefusal === undefined) assert.ok(result?.failure?.message.startsWith(`No WebKit build at ${join(root, 'no-webkit-build')}, the path executablePath gives: `), result?.failure?.message)
    else assert.equal(result?.failure?.message, webKitHostRefusal)
    assert.deepEqual(eventsOfType(record.events, 'test.started'), [], 'the test never started')
    assert.equal(record.browsers.length, 1, 'only Chromium launched; nothing stood in for WebKit')
    assert.equal(record.browsers[0]?.closed, true, 'the browser launched for the web app was closed')
  })

  // A native app has a driver now, so a test on a web app and a native app takes its lease and makes each app ready in
  // the order the test names them: here Chromium, then the Mac app, whose missing bundle keeps the test from running.
  test('a test on a web app and a native app takes its lease, then readies each app in turn, and closes the browser it launched', async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }), mac: { platform: 'macos', appPath: 'build/Tasks.app' } },
  defaultApp: 'web',
})
`
    const tests = `import { test } from '@rehearsal-labs/retest'

test('creates on the web, checks on the Mac', { apps: ['web', 'mac'] }, async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/mixed.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/mixed.retest.ts'] })
    const [result] = record.result.files.flatMap((file) => file.tests)
    assert.equal(result?.status, 'not_run')
    assert.ok(result?.failure?.message.startsWith(`Retest cannot read the app's Info.plist at ${join(root, 'build/Tasks.app/Contents/Info.plist')}: `), result?.failure?.message)
    const types = record.events.map((event) => event.type)
    assert.ok(types.indexOf('lease.taken') >= 0 && types.indexOf('lease.taken') < types.indexOf('browser.started'), types.join(', '))
    assert.deepEqual([types.includes('test.started'), types.includes('native.started')], [false, false])
    assert.equal(record.browsers.length, 1)
    assert.equal(record.browsers[0]?.closed, true, 'the browser launched for the web app was closed')
  })

  // WebKit has a driver now, so its attempts are real attempts of their own target and take that target's share of the
  // browsers; a WebKit target with no build launches none of them, and Chromium's tests still pass in theirs.
  test('a WebKit target with no build takes its own share of the browsers, launches none, and Chromium’s tests still pass', async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }), webkit: { browser: 'webkit', executablePath: 'no-webkit-build', baseUrl: 'http://127.0.0.1:4173' } },
  defaultApp: 'web',
})
`
    const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('runs on Chromium', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('task-title')).toBeVisible()
})
for (const name of ['one', 'two', 'three']) test(\`runs on WebKit \${name}\`, { apps: ['webkit'] }, async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': tests, 'tests/b.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/a.retest.ts', 'tests/b.retest.ts'], workers: 2, browsers: 2 })
    const results = record.result.files.flatMap((file) => file.tests)
    assert.deepEqual(results.filter((result) => result.status === 'passed').map((result) => result.name), ['runs on Chromium', 'runs on Chromium'])
    assert.deepEqual(new Set(results.filter((result) => result.status !== 'passed').map((result) => result.failure?.class)), new Set(['setup_failed']))
    assert.equal(results.filter((result) => result.status === 'not_run').length, 6)
    // Of the two browsers, WebKit's attempts earn one, which never launches, and Chromium's tests share the other.
    assert.equal(record.browsers.length, 1, 'Chromium launched its share of the browsers, and no browser stood in for WebKit')
    assert.equal(eventsOfType(record.events, 'browser.started').length, 1)
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
    webkit: { browser: 'webkit', executablePath: 'no-webkit-build', baseUrl: 'http://127.0.0.1:4173' },
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

test('syncs', { apps: ['web', 'webkit'], state: { web: 'signed-in' } }, async () => {})
`
  const syncOnMac = `import { test } from '@rehearsal-labs/retest'

test('syncs on the Mac', { apps: ['web', 'mac'], state: { web: 'signed-in' } }, async () => {})
`

  // WebKit is not refused either, so a test on Chromium and WebKit needs its setup as one on a native app does: the setup
  // starts its server, which here never answers, so the setup and the test that needs it do not run.
  test('runs for a test on Chromium and WebKit, which is not refused', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/setup.retest.ts': setup, 'tests/sync.retest.ts': sync })
    const record = await runProject(root, {
      files: ['tests/setup.retest.ts', 'tests/sync.retest.ts'],
      selection: { grep: 'syncs' },
      env: { TASK_APP_PASSWORD: 'hunter2-long-enough' },
    })
    const results = record.result.files.flatMap((file) => file.tests)
    assert.deepEqual(results.map((result) => [result.name, result.status]), [['signed-in', 'not_run'], ['syncs', 'not_run']])
    assert.match(results[0]?.failure?.message ?? '', /^The server for web exited with exit code 0 before http:\/\/127\.0\.0\.1:9\/ answered\./)
    assert.match(results[1]?.failure?.message ?? '', /^Not run: the setup "signed-in" did not pass on chromium\. The server for web exited/)
    assert.equal(existsSync(join(root, 'started')), true, 'the setup asked for its app server')
    assert.deepEqual(eventsOfType(record.events, 'test.started'), [], 'neither started')
  })

  // A native app is not refused, so a test on one needs its setup like any other: the setup starts its server, which here
  // never answers, so the setup and the test that needs it do not run.
  test('runs for a test on a native app, which is not refused', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/setup.retest.ts': setup, 'tests/sync.retest.ts': syncOnMac })
    const record = await runProject(root, {
      files: ['tests/setup.retest.ts', 'tests/sync.retest.ts'],
      selection: { grep: 'syncs' },
      env: { TASK_APP_PASSWORD: 'hunter2-long-enough' },
    })
    const results = record.result.files.flatMap((file) => file.tests)
    assert.deepEqual(results.map((result) => [result.name, result.status]), [['signed-in', 'not_run'], ['syncs on the Mac', 'not_run']])
    assert.match(results[0]?.failure?.message ?? '', /^The server for web exited with exit code 0 before http:\/\/127\.0\.0\.1:9\/ answered\./)
    assert.match(results[1]?.failure?.message ?? '', /^Not run: the setup "signed-in" did not pass on chromium\. The server for web exited/)
    assert.equal(existsSync(join(root, 'started')), true, 'the setup asked for its app server')
    assert.deepEqual(eventsOfType(record.events, 'native.started'), [], 'the Mac app never started')
  })

  test('still starts when the selection chose it for itself', async () => {
    const root = tempProject({ 'retest.config.ts': config, 'tests/setup.retest.ts': setup, 'tests/sync.retest.ts': sync })
    const record = await runProject(root, { files: ['tests/setup.retest.ts', 'tests/sync.retest.ts'], env: { TASK_APP_PASSWORD: 'hunter2-long-enough' } })
    const names = record.result.files.flatMap((file) => file.tests).map((result) => result.name)
    assert.deepEqual(names.sort(), ['signed-in', 'syncs'])
    assert.equal(existsSync(join(root, 'started')), true, 'the setup asked for its app server')
  })
})

// An iOS simulator or macOS target has the driver a run gives it, so doctor reads the executor that driver needs from
// Retest's cache under HOME, as a run finds it, and starts nothing; a target no driver can start is refused as a run
// refuses it. A valid executor build is not written here: its licence files must carry the pinned upstream texts, which
// only a real build has, so that row is held by builds-doctor-native.test.ts with stand-in pins.
describe('doctor', () => {
  const config = (): LoadedConfig => loaded({
    apps: {
      web: app({ targets: { chromium: chromium({ executablePath: '/fake/chromium' }), webkit: { browser: 'webkit' } } }),
      iphone: { platform: 'ios-simulator', appPath: 'build/Tasks.app', device: 'iPhone 17', runtime: '26.0' },
      mac: { platform: 'macos', appPath: 'build/Tasks.app' },
    },
  })

  async function doctor(env: Readonly<Record<string, string>>, tools?: NativeTools): Promise<{ readonly rows: [string, string, boolean, string, string][]; readonly launches: number }> {
    const launched = fakeLauncher()
    const checks = await runChecks(config(), {
      ...(tools === undefined ? {} : { tools }),
      dependencies: {
        resolveExecutable: (target) => ({ ok: true, path: target.browser === 'chromium' ? (target.executablePath ?? '/fake/chromium') : `/fake/${target.browser}` }),
        launchBrowser: (options, timeoutMs) => launched.launch(options, timeoutMs),
        probeReady: async () => true,
        startAppServer: () => Promise.reject(new Error('no server is started')),
        env,
        signal: new AbortController().signal,
      },
      timeouts: defaultTimeouts,
      logFolder: '/tmp/retest-doctor-unused',
    })
    return { rows: checks.map(({ group, subject, ok, text, fix }) => [group, subject, ok, ok ? '' : text, fix ?? '']), launches: launched.browsers.length }
  }

  const webkitRefused = 'A WebKit target needs a build. Give its executablePath, or set RETEST_WEBKIT_BUILD, to an unpacked Playwright WebKit build 2359, the folder or the executable inside it.'

  test('reads an iOS simulator and a macOS target from an empty executor cache under HOME, with the command that builds each, refuses a WebKit target with no build by name, and launches only the Chromium target', { skip: buildPlatform() === 'mac-arm64' ? false : `unverified here: the executors are pinned for macOS arm64, and this machine is ${process.platform} ${process.arch}` }, async (t) => {
    const home = tempFolder('retest-doctor-home-')
    const { rows, launches } = await doctor({ HOME: home }, (await fakeTools(t)).tools)
    const webkitBuild = rows.find(([group, subject]) => group === 'builds' && subject === 'webkit')
    assert.deepEqual(rows.filter((row) => row !== webkitBuild), [
      ['web', 'chromium()', true, '', ''],
      ['web', "{ browser: 'webkit' }", false, webkitRefused, ''],
      ['iphone', "{ platform: 'ios-simulator', device: 'iPhone 17', runtime: '26.0' }", false, "WebDriverAgent 16.13.6 is not built in Retest's cache", 'Run npx retest install webdriveragent to build it from its pinned commit; otherwise the first run builds it.'],
      ['mac', "{ platform: 'macos' }", false, "WebDriverAgentMac (appium-mac2-driver) 4.3.6 is not built in Retest's cache", 'Run npx retest install mac2 to build it from its pinned commit; otherwise the first run builds it.'],
      ['macos', 'Screen Recording', true, '', ''],
    ])
    assert.equal(webkitBuild?.[3], 'WebKit (Playwright build) 26.6 (build 2359) is not installed, and the target names no build')
    assert.equal(webkitBuild?.[4], 'Run npx retest install webkit, then give the target its executablePath or set RETEST_WEBKIT_BUILD.')
    assert.equal(launches, 1, 'only the Chromium target launched')
    assert.deepEqual(readdirSync(home), [], 'doctor built, installed and wrote nothing under HOME')
  })

  test('says a native target has no executor cache to read when HOME is not set, and starts nothing', async (t) => {
    const { rows, launches } = await doctor({}, (await fakeTools(t)).tools)
    assert.deepEqual(rows.filter(([group]) => group === 'iphone' || group === 'mac'), [
      ['iphone', "{ platform: 'ios-simulator', device: 'iPhone 17', runtime: '26.0' }", false, 'HOME is not set to an absolute folder, so Retest has no cache to read the WebDriverAgent 16.13.6 build from.', ''],
      ['mac', "{ platform: 'macos' }", false, 'HOME is not set to an absolute folder, so Retest has no cache to read the WebDriverAgentMac (appium-mac2-driver) 4.3.6 build from.', ''],
    ])
    assert.deepEqual(rows.filter(([group]) => group === 'builds'), [], 'without HOME no builds row is read either')
    assert.equal(launches, 1, 'only the Chromium target launched')
  })
})
