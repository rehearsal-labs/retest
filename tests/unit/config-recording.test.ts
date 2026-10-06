import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { Problems } from '../../src/config/problems.ts'
import { defaultRecordingSettings, readPixels, readRecording, recordsApp, resolveRecording } from '../../src/config/read-recording.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { defaultAppPixelRules } from '../../src/media/policy.ts'

const apps = ['web', 'desk']
const allowed = new Map<string, typeof defaultAppPixelRules>()

function read(value: unknown, pixels = allowed): { settings: ReturnType<typeof readRecording>; issues: string[] } {
  const problems = new Problems()
  const settings = readRecording(value, problems, apps, pixels)
  return { settings, issues: problems.issues.map(({ key, message }) => `${key}: ${message}`) }
}

describe('the recording block', () => {
  test('is absent unless written, and its defaults record nothing', () => {
    assert.equal(read(undefined).settings, undefined)
    assert.deepEqual(read({}).settings, { record: false, nativeWithholding: false, apps: new Map(), required: false, keep: 'all', fps: 10, size: { width: 1280, height: 720 } })
    assert.equal(defaultRecordingSettings.record, false)
    assert.equal(recordsApp(defaultRecordingSettings, 'web', allowed), false)
  })

  test('records the run, and an app named on its own overrides it either way', () => {
    const { settings } = read({ record: true, apps: { desk: false } })
    assert.ok(settings !== undefined)
    assert.equal(recordsApp(settings, 'web', allowed), true)
    assert.equal(recordsApp(settings, 'desk', allowed), false)
    const one = read({ apps: { desk: true } }).settings
    assert.ok(one !== undefined)
    assert.equal(recordsApp(one, 'web', allowed), false)
    assert.equal(recordsApp(one, 'desk', allowed), true)
  })

  test('never records an app whose pixel rules forbid recordings, and refuses to name one', () => {
    const pixels = new Map([['desk', { screenshots: 'allowed' as const, recordings: 'never' as const }]])
    const { settings } = read({ record: true }, pixels)
    assert.ok(settings !== undefined)
    assert.equal(recordsApp(settings, 'desk', pixels), false)
    assert.equal(recordsApp(settings, 'web', pixels), true)
    assert.deepEqual(read({ apps: { desk: true } }, pixels).issues, ['recording.apps.desk: cannot be true while pixels.desk.recordings is never'])
  })

  test('refuses evidence required while nothing is recorded', () => {
    assert.deepEqual(read({ required: true }).issues, ['recording.required: cannot be true while no app is recorded'])
    assert.equal(read({ required: true, apps: { web: true } }).settings?.required, true)
  })

  test('names every key at fault', () => {
    const { settings, issues } = read({ record: 'yes', apps: { phone: true }, keep: 'some', fps: 60, size: { width: 1281, height: 8 }, extra: 1 })
    assert.equal(settings, undefined)
    const keys = issues.map((line) => line.slice(0, line.indexOf(':')))
    assert.deepEqual(keys.sort(), ['recording.apps.phone', 'recording.extra', 'recording.fps', 'recording.keep', 'recording.record', 'recording.size.height'])
    assert.ok(issues.includes('recording.fps: expected integer <= 30, received 60'), issues.join('\n'))
    assert.ok(issues.includes('recording.apps.phone: unknown app, expected one of "web", "desk"'), issues.join('\n'))
  })

  test('takes an even size within the media process\'s bounds', () => {
    assert.deepEqual(read({ size: { width: 800, height: 600 } }).settings?.size, { width: 800, height: 600 })
    assert.deepEqual(read({ size: { width: 801, height: 600 } }).issues, ['recording.size.width: expected an even number, since video encoders need one, received 801'])
    assert.deepEqual(read({ size: { width: 8192, height: 600 } }).issues, ['recording.size.width: expected integer <= 4096, received 8192'])
  })

  test('a host block replaces the config\'s whole, and one that cannot be read is a usage failure', () => {
    const configured = read({ record: true }).settings
    const inherited = resolveRecording(undefined, configured, apps, allowed)
    assert.ok(inherited.ok)
    assert.equal(inherited.settings, configured)
    const replaced = resolveRecording({ record: false }, configured, apps, allowed)
    assert.ok(replaced.ok)
    assert.equal(replaced.settings.record, false)
    const refused = resolveRecording({ fps: 0 }, configured, apps, allowed)
    assert.ok(!refused.ok)
    assert.equal(refused.failure.class, 'usage')
    assert.match(refused.failure.message, /^RunOptions\.recording has a problem: recording\.fps: /)
  })
})

describe('native withholding settings', () => {
  test('keeps native pixels by default and validates the opt-in even with recording off', () => {
    assert.equal(read({}).settings?.nativeWithholding, false)
    assert.equal(defaultRecordingSettings.nativeWithholding, false)
    assert.equal(read({ nativeWithholding: true }).settings?.nativeWithholding, true)
    assert.deepEqual(read({ nativeWithholding: 'true' }).issues, ['recording.nativeWithholding: expected boolean, received "true"'])
  })

  test('the environment overrides the selected recording block and refuses invalid values', () => {
    for (const [value, expected] of [['true', true], ['false', false]] as const) {
      const resolved = resolveRecording(undefined, read({ record: true, nativeWithholding: !expected }).settings, apps, allowed, { RETEST_NATIVE_WITHHOLDING: value })
      assert.ok(resolved.ok)
      assert.equal(resolved.settings.nativeWithholding, expected)
      assert.equal(resolved.settings.record, true)
    }
    const enabled = resolveRecording(undefined, undefined, apps, allowed, { RETEST_NATIVE_WITHHOLDING: 'true' })
    assert.ok(enabled.ok)
    assert.equal(enabled.settings.record, false)
    assert.equal(enabled.settings.nativeWithholding, true)
    for (const value of ['', 'on', 'off', '1', 'TRUE']) {
      const refused = resolveRecording(undefined, undefined, apps, allowed, { RETEST_NATIVE_WITHHOLDING: value })
      assert.ok(!refused.ok)
      assert.equal(refused.failure.class, 'usage')
      assert.equal(refused.failure.details?.['key'], 'RETEST_NATIVE_WITHHOLDING')
    }
  })
})

describe('the pixels block', () => {
  test('reads each app\'s rules and refuses an app the config lacks', () => {
    const problems = new Problems()
    const pixels = readPixels({ web: { screenshots: 'never' }, phone: { recordings: 'never' } }, problems, apps)
    assert.deepEqual(pixels?.get('web'), { screenshots: 'never', recordings: 'allowed' })
    assert.deepEqual(problems.issues.map(({ key }) => key), ['pixels.phone'])
  })
})

describe('a config with recording and pixels', () => {
  test('loads both, and a config without them has neither', () => {
    const base = { apps: { web: { browser: 'chromium', baseUrl: 'http://127.0.0.1:4173' } } }
    const plain = validateConfig(base, 'retest.config.ts')
    assert.ok(plain.ok)
    assert.equal(plain.config.recording, undefined)
    assert.equal(plain.config.pixels, undefined)
    const recorded = validateConfig({ ...base, recording: { record: true, required: true, keep: 'failures' }, pixels: { web: { screenshots: 'never' } } }, 'retest.config.ts')
    assert.ok(recorded.ok, recorded.ok ? '' : recorded.failure.message)
    assert.equal(recorded.config.recording?.record, true)
    assert.equal(recorded.config.recording?.keep, 'failures')
    assert.deepEqual(recorded.config.pixels?.get('web'), { screenshots: 'never', recordings: 'allowed' })
  })

  test('refuses a recording block that names an unknown app, at load', () => {
    const refused = validateConfig({ apps: { web: { browser: 'chromium' } }, recording: { apps: { phone: true } } }, 'retest.config.ts')
    assert.ok(!refused.ok)
    assert.match(refused.failure.message, /recording\.apps\.phone: unknown app/)
  })
})
