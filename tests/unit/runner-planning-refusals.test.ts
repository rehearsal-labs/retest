import type { LoadedApp, LoadedTarget } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { attemptRefusal } from '../../src/runner/target-drivers.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, testNamed } from '../support/run-harness.ts'
import { unixOnly, windowsOnly } from '../support/platform-skip.ts'

// A run of a native app: on Windows each native app is refused at its setup, by its key, before anything starts for it.
const nativeApps = { skip: unixOnly('Windows refuses a native app at its setup, before anything starts for it') }

// What the run refuses for an attempt by name at planning, before any server starts, browser launches or native runtime
// starts for it: two apps of one test on one native runtime, and a setup whose app cannot save its state.

function app(name: string, targets: Record<string, LoadedTarget>): LoadedApp {
  return { name, targets: new Map(Object.entries(targets)) }
}

const desk = app('desk', { macos: { name: 'macos', platform: 'macos', appPath: '/fixture/TaskDesk.app' } })
const notes = app('notes', { macos: { name: 'macos', platform: 'macos', appPath: '/fixture/Notes.app' } })
const phone = app('phone', { ios: { name: 'ios', platform: 'ios-simulator', appPath: '/fixture/TaskPhone.app', device: 'iPhone 17', runtime: '26.5' } })
const tablet = app('tablet', {
  same: { name: 'same', platform: 'ios-simulator', appPath: '/fixture/TaskPad.app', device: 'iPhone 17', runtime: '26.5' },
  other: { name: 'other', platform: 'ios-simulator', appPath: '/fixture/TaskPad.app', device: 'iPad Air', runtime: '26.5' },
})
const desktop = app('desktop', { electron: { name: 'electron', browser: 'electron', executablePath: '/opt/Electron.app/Contents/MacOS/Electron', appPath: '/work/desktop', args: [] } })
const web = app('web', { chromium: { name: 'chromium', browser: 'chromium', headless: true } })
const apps = new Map([desk, notes, phone, tablet, desktop, web].map((each) => [each.name, each]))
// These are planned as on a Mac, where native apps run; Windows refuses each native app first, as its own case shows.
const onMac = { platform: 'darwin' } as const

describe('an attempt refused at planning', () => {
  test('two macOS apps of one test share the one desktop, which drives one app per test', () => {
    const refused = attemptRefusal({ desk: 'macos', notes: 'macos' }, apps, onMac)
    assert.equal(refused?.class, 'unsupported')
    assert.equal(refused?.message, "Not run: the apps desk and notes of this test both run on this Mac's desktop, and Retest drives one app there per test. Use one macOS app in a test.")
  })

  test('two iOS apps on one simulator device type and runtime are refused; on two device types they are not', () => {
    assert.match(attemptRefusal({ phone: 'ios', tablet: 'same' }, apps, onMac)?.message ?? '', /^Not run: the apps phone and tablet of this test both run on one iPhone 17 simulator on iOS 26\.5/)
    assert.equal(attemptRefusal({ phone: 'ios', tablet: 'other' }, apps, onMac), undefined)
  })

  test('one native app beside web apps, and one of each native kind, are not refused', () => {
    assert.equal(attemptRefusal({ phone: 'ios', web: 'chromium', desk: 'macos' }, apps, onMac), undefined)
  })

  test('on Windows each native app is refused at its setup by its key, one sentence, and a web app is not', () => {
    const onWindows = { platform: 'win32' } as const
    assert.deepEqual(attemptRefusal({ desk: 'macos' }, apps, onWindows), { class: 'setup_failed', message: 'apps.desk is a macOS app, which Retest runs only on a Mac.', details: { app: 'desk', target: 'macos', driver: 'macos' } })
    assert.equal(attemptRefusal({ phone: 'ios' }, apps, onWindows)?.message, 'apps.phone.targets.ios is an iOS simulator app, which Retest runs only on a Mac with Xcode.')
    assert.equal(attemptRefusal({ web: 'chromium', desk: 'macos' }, apps, onWindows)?.message, 'apps.desk is a macOS app, which Retest runs only on a Mac.')
    assert.equal(attemptRefusal({ desk: 'macos', notes: 'macos' }, apps, onWindows)?.message, 'apps.desk is a macOS app, which Retest runs only on a Mac.', 'the app is refused before any runtime is shared')
    assert.equal(attemptRefusal({ web: 'chromium' }, apps, onWindows), undefined)
    assert.equal(attemptRefusal({ desktop: 'electron' }, apps, onWindows), undefined)
  })

  test('a setup on an Electron app or a native app is refused, since neither can save a browser state; on a browser it is not', () => {
    assert.match(attemptRefusal({ desktop: 'electron' }, apps, { setup: true, ...onMac })?.message ?? '', /^Not run: a setup saves a sign-in state from its app's browser storage, and the Electron app desktop keeps its own storage\./)
    assert.match(attemptRefusal({ phone: 'ios' }, apps, { setup: true, ...onMac })?.message ?? '', /the native app phone has no browser storage\.$/)
    assert.equal(attemptRefusal({ desktop: 'electron' }, apps, onMac), undefined, 'an ordinary test on Electron runs')
    assert.equal(attemptRefusal({ web: 'chromium' }, apps, { setup: true, ...onMac }), undefined)
  })
})

describe('in a run', () => {
  test('a test of two macOS apps is not run, by name, and nothing starts for it', nativeApps, async () => {
    const config = `import { defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { desk: { platform: 'macos', appPath: '/fixture/TaskDesk.app' }, notes: { platform: 'macos', appPath: '/fixture/Notes.app' } } })
`
    const tests = `import { test } from '@rehearsal-labs/retest'
test('uses two desktop apps', { apps: ['desk', 'notes'] }, async () => {})
`
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': tests }), { files: ['tests/a.retest.ts'] })
    const result = testNamed(record.result, 'uses two desktop apps')
    assert.deepEqual([result.status, result.failure?.class], ['not_run', 'unsupported'])
    assert.match(result.failure?.message ?? '', /the apps desk and notes of this test both run on this Mac's desktop/)
    assert.deepEqual(eventsOfType(record.events, 'resource.acquired'), [], 'it took no lease')
    assert.deepEqual(eventsOfType(record.events, 'native.started'), [])
  })

  test('on Windows a test of a macOS app is not run, by its key, its start command never runs, and the web test beside it runs', { skip: windowsOnly('the refusal reads the machine it runs on') }, async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }),
    desk: { platform: 'macos', appPath: '/fixture/TaskDesk.app', start: { command: 'node -e "require(\\'node:fs\\').writeFileSync(\\'started\\', \\'\\')"', ready: 'http://127.0.0.1:9/' } },
  },
  defaultApp: 'web',
})
`
    const tests = `import { expect, test } from '@rehearsal-labs/retest'
test('opens the tasks', async ({ page }) => {
  await page.goto('/tasks')
  await expect(page.getByTestId('task-title')).toBeVisible()
})
test('uses the desk', { apps: ['desk'] }, async () => {})
`
    const root = tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': tests })
    const record = await runProject(root, { files: ['tests/a.retest.ts'] })
    assert.equal(testNamed(record.result, 'opens the tasks').status, 'passed')
    const desk = testNamed(record.result, 'uses the desk')
    assert.deepEqual([desk.status, desk.failure?.class, desk.failure?.message], ['not_run', 'setup_failed', 'apps.desk is a macOS app, which Retest runs only on a Mac.'])
    assert.equal(existsSync(join(root, 'started')), false, 'the macOS app’s start command never ran')
    const own = record.events.filter((event) => 'testId' in event && event.testId === desk.testId).map((event) => event.type)
    assert.deepEqual(own, ['test.finished'], 'nothing started for it, not even its lease')
    assert.deepEqual(eventsOfType(record.events, 'native.started'), [])
  })

  test('a setup on an Electron app is refused before its body runs, and the test that starts from its state is not run', async () => {
    const config = `import { defineConfig, electron } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { desktop: electron({ executablePath: '/opt/Electron.app/Contents/MacOS/Electron', appPath: '/work/desktop' }) } })
`
    const tests = `import { test } from '@rehearsal-labs/retest'
test.setup('signed in', async () => {
  throw new Error('the body of a refused setup never runs')
})
test('starts signed in', { state: 'signed in' }, async () => {})
`
    const record = await runProject(tempProject({ 'retest.config.ts': config, 'tests/a.retest.ts': tests }), { files: ['tests/a.retest.ts'] })
    const setup = testNamed(record.result, 'signed in')
    assert.deepEqual([setup.status, setup.failure?.class], ['not_run', 'unsupported'])
    assert.match(setup.failure?.message ?? '', /the Electron app desktop keeps its own storage/)
    assert.deepEqual(eventsOfType(record.events, 'test.started'), [], 'no body started')
    assert.equal(testNamed(record.result, 'starts signed in').status, 'not_run')
  })
})
