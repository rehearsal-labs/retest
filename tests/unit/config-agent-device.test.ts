import type { LoadedConfig, LoadedNativeTarget } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { agentDeviceTarget, describeAndroidDevice, nativeRuntimeKey } from '../../src/config/native-targets.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { resetPolicyFor } from '../../src/native/reset-policy.ts'
import { attemptRefusal, targetDriver } from '../../src/runner/target-drivers.ts'

// The config shape for phones driven through agent-device: an iOS simulator target that opts in with
// `driver: 'agent-device'`, which keeps WebDriverAgent as the default, and an Android target, which runs through
// agent-device alone and names its device by name or by adb serial.

const path = '/work/retest.config.ts'
const phone = { platform: 'ios-simulator', appPath: 'TaskPhone.app', device: 'iPhone 17', runtime: '26.5' }
const android = { platform: 'android', appPath: 'app-debug.apk', package: 'dev.retest.fixtures.tasks', serial: 'emulator-5554' }

function loaded(value: unknown): LoadedConfig {
  const result = validateConfig(value, path)
  assert.ok(result.ok, result.ok ? '' : result.failure.message)
  return result.config
}

function problems(value: unknown): string[] {
  const result = validateConfig(value, path)
  assert.equal(result.ok, false, 'expected the config to be rejected')
  if (result.ok) return []
  const lines = result.failure.message.split('\n')
  return lines.length === 1 ? [lines[0]?.slice(`${path}: `.length) ?? ''] : lines.slice(1).map((line) => line.trim())
}

function only(config: LoadedConfig, app: string): LoadedNativeTarget {
  const target = [...(config.apps.get(app)?.targets.values() ?? [])][0]
  assert.ok(target !== undefined && 'platform' in target)
  return target
}

describe('an iOS simulator target through agent-device', () => {
  test('WebDriverAgent stays the default, and naming it is the same as leaving it out', () => {
    for (const driver of [undefined, 'webdriveragent']) {
      const target = only(loaded({ apps: { phone: { ...phone, ...(driver === undefined ? {} : { driver }) } } }), 'phone')
      assert.equal(target.driver, undefined)
      assert.equal(agentDeviceTarget(target), undefined)
    }
  })

  test("driver: 'agent-device' opts in, and keeps the arguments", () => {
    const target = only(loaded({ apps: { phone: { ...phone, driver: 'agent-device', arguments: ['-reset'] } } }), 'phone')
    assert.deepEqual(target, { name: 'ios-simulator', platform: 'ios-simulator', appPath: '/work/TaskPhone.app', device: 'iPhone 17', runtime: '26.5', driver: 'agent-device', arguments: ['-reset'] })
    assert.equal(agentDeviceTarget(target)?.driver, 'agent-device')
    assert.equal(nativeRuntimeKey(target), 'iPhone 17 (26.5)')
    assert.equal(resetPolicyFor('ios-simulator', 'agent-device').contract.appData, 'reset')
    assert.match(resetPolicyFor('ios-simulator', 'agent-device').cleared.map((item) => item.how).join(' '), /agent-device's runner app/)
  })

  test('an environment and diagnostics are refused by name, since agent-device launches with arguments only', () => {
    const found = problems({ apps: { phone: { ...phone, driver: 'agent-device', environment: { MODE: 'test' }, diagnostics: { logs: 'none' } } } })
    assert.ok(found.some((line) => line.startsWith('apps.phone.environment:') && /arguments only/.test(line)), found.join('\n'))
    assert.ok(found.some((line) => line.startsWith('apps.phone.diagnostics:') && /keeps no app output/.test(line)), found.join('\n'))
  })

  test('another driver name is refused', () => {
    const found = problems({ apps: { phone: { ...phone, driver: 'appium' } } })
    assert.ok(found.some((line) => line.startsWith('apps.phone.driver')), found.join('\n'))
  })
})

describe('an Android target', () => {
  test('reads its APK, package and serial, and runs through agent-device', () => {
    const target = only(loaded({ apps: { tasks: android } }), 'tasks')
    assert.deepEqual(target, { name: 'android', platform: 'android', appPath: '/work/app-debug.apk', package: 'dev.retest.fixtures.tasks', device: { serial: 'emulator-5554' }, driver: 'agent-device' })
    assert.equal(nativeRuntimeKey(target), 'android serial emulator-5554')
    assert.equal(resetPolicyFor('android').contract.appData, 'reset')
    const driver = targetDriver('tasks', target, { native: true, platform: 'darwin' })
    assert.ok(driver.ok && driver.driver === 'android')
    // A driver name is accepted when it is the one Android has.
    assert.equal(only(loaded({ apps: { tasks: { ...android, driver: 'agent-device' } } }), 'tasks').driver, 'agent-device')
  })

  test('names its device by name instead', () => {
    const target = only(loaded({ apps: { tasks: { platform: 'android', appPath: 'app.apk', package: 'dev.retest.tasks', device: 'Pixel_9_API_36' } } }), 'tasks')
    assert.ok(target.platform === 'android')
    assert.deepEqual(target.device, { name: 'Pixel_9_API_36' })
    assert.equal(describeAndroidDevice(target.device), 'device Pixel_9_API_36')
  })

  test('a device named twice, or not at all, is refused', () => {
    assert.ok(problems({ apps: { tasks: { ...android, device: 'Pixel_9' } } }).some((line) => /names its device twice/.test(line)))
    const { serial: _serial, ...unnamed } = android
    assert.ok(problems({ apps: { tasks: unnamed } }).some((line) => /names no device/.test(line)))
  })

  test('a package that is not an application id is refused', () => {
    assert.ok(problems({ apps: { tasks: { ...android, package: 'tasks' } } }).some((line) => line.startsWith('apps.tasks.package:')))
    assert.ok(problems({ apps: { tasks: { ...android, package: '' } } }).some((line) => line.startsWith('apps.tasks.package:')))
  })

  test('launch arguments, an environment and diagnostics are refused by name', () => {
    const found = problems({ apps: { tasks: { ...android, arguments: ['--es', 'mode', 'test'], environment: { MODE: 'test' }, diagnostics: { logs: 'none' } } } })
    for (const key of ['arguments', 'environment', 'diagnostics']) assert.ok(found.some((line) => line.startsWith(`apps.tasks.${key}:`) && /not pass them through agent-device/.test(line)), found.join('\n'))
  })

  test('an app may not mix Android targets with iOS ones', () => {
    const found = problems({ apps: { phone: { targets: { ios: phone, android } } } })
    assert.ok(found.some((line) => /mixes iOS simulators and Android apps/.test(line)), found.join('\n'))
  })

  test('two apps of one test on one Android device are refused before anything starts', () => {
    const config = loaded({ apps: { tasks: android, notes: { ...android, package: 'dev.retest.fixtures.notes' } } })
    const refusal = attemptRefusal({ tasks: 'android', notes: 'android' }, config.apps, { platform: 'darwin' })
    assert.equal(refusal?.class, 'unsupported')
    assert.match(refusal?.message ?? '', /the Android serial emulator-5554/)
  })

  test('on Windows an Android target is refused at its setup, by its key', () => {
    const target = only(loaded({ apps: { tasks: android } }), 'tasks')
    const driver = targetDriver('tasks', target, { native: true, platform: 'win32' })
    assert.ok(!driver.ok)
    assert.match(driver.failure.message, /^apps\.tasks is an Android app/)
  })
})
