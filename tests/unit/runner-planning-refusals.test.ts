import type { LoadedApp, LoadedTarget } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { attemptRefusal } from '../../src/runner/target-drivers.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, testNamed } from '../support/run-harness.ts'

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

describe('an attempt refused at planning', () => {
  test('two macOS apps of one test share the one desktop, which drives one app per test', () => {
    const refused = attemptRefusal({ desk: 'macos', notes: 'macos' }, apps)
    assert.equal(refused?.class, 'unsupported')
    assert.equal(refused?.message, "Not run: the apps desk and notes of this test both run on this Mac's desktop, and Retest drives one app there per test. Use one macOS app in a test.")
  })

  test('two iOS apps on one simulator device type and runtime are refused; on two device types they are not', () => {
    assert.match(attemptRefusal({ phone: 'ios', tablet: 'same' }, apps)?.message ?? '', /^Not run: the apps phone and tablet of this test both run on one iPhone 17 simulator on iOS 26\.5/)
    assert.equal(attemptRefusal({ phone: 'ios', tablet: 'other' }, apps), undefined)
  })

  test('one native app beside web apps, and one of each native kind, are not refused', () => {
    assert.equal(attemptRefusal({ phone: 'ios', web: 'chromium', desk: 'macos' }, apps), undefined)
  })

  test('a setup on an Electron app or a native app is refused, since neither can save a browser state; on a browser it is not', () => {
    assert.match(attemptRefusal({ desktop: 'electron' }, apps, { setup: true })?.message ?? '', /^Not run: a setup saves a sign-in state from its app's browser storage, and the Electron app desktop keeps its own storage\./)
    assert.match(attemptRefusal({ phone: 'ios' }, apps, { setup: true })?.message ?? '', /the native app phone has no browser storage\.$/)
    assert.equal(attemptRefusal({ desktop: 'electron' }, apps), undefined, 'an ordinary test on Electron runs')
    assert.equal(attemptRefusal({ web: 'chromium' }, apps, { setup: true }), undefined)
  })
})

describe('in a run', () => {
  test('a test of two macOS apps is not run, by name, and nothing starts for it', async () => {
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
