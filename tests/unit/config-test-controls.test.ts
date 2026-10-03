import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { isContinuousIntegration, onlyInContinuousIntegration } from '../../src/cli/continuous-integration.ts'
import { chromium } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { fakeCli, playing } from './cli-fixtures.ts'
import { browserPath, file, passingRun, projectFolder } from './reporters-fixtures.ts'

const path = '/work/retest.config.ts'

function problems(value: unknown): string[] {
  const result = validateConfig(value, path)
  assert.equal(result.ok, false, 'expected the config to be rejected')
  if (result.ok) return []
  assert.equal(result.failure.class, 'usage')
  const lines = result.failure.message.split('\n')
  return lines.length === 1 ? [lines[0]?.slice(`${path}: `.length) ?? ''] : lines.slice(1).map((line) => line.trim())
}

describe('the viewport key', () => {
  test('a viewport alone is a custom emulation with no touch screen and a pixel ratio of 1', () => {
    const result = validateConfig({ apps: { web: chromium({ viewport: { width: 1280, height: 720 } }) } }, path)
    assert.ok(result.ok, result.ok ? '' : result.failure.message)
    assert.deepEqual(result.config.apps.get('web')?.targets.get('chromium')?.emulate, {
      viewport: { width: 1280, height: 720 },
      deviceScaleFactor: 1,
      touch: false,
      isMobile: false,
    })
  })

  test('a viewport needs a whole width and height in pixels', () => {
    assert.deepEqual(problems({ apps: { web: { browser: 'chromium', viewport: { width: 0, height: 720 } } } }), [
      'apps.web.viewport.width: expected integer >= 1, received 0',
    ])
    assert.deepEqual(problems({ apps: { web: { browser: 'chromium', viewport: { width: 1280 } } } }), ['apps.web.viewport.height: missing required key'])
  })

  test('viewport and emulate together are refused, since both set the screen', () => {
    // Written as a JavaScript caller would, since the types refuse it before it runs.
    assert.deepEqual(problems({ apps: { web: { browser: 'edge', emulate: 'Pixel 9', viewport: { width: 1280, height: 720 } } } }), [
      'apps.web.viewport: emulate already sets the screen, so give viewport or emulate, not both',
    ])
  })

  test('a native app takes no viewport', () => {
    assert.deepEqual(problems({ apps: { mac: { platform: 'macos', appPath: 'Tasks.app', viewport: { width: 800, height: 600 } } } }), [
      'apps.mac.viewport: unknown key',
    ])
  })
})

describe('the locks key', () => {
  test('lists the locks tests may hold, by name', () => {
    const result = validateConfig({ apps: { web: chromium() }, locks: ['inbox', 'staging-account'] }, path)
    assert.ok(result.ok, result.ok ? '' : result.failure.message)
    assert.deepEqual(result.config.locks, ['inbox', 'staging-account'])
  })

  test('is absent when the config does not list it', () => {
    const result = validateConfig({ apps: { web: chromium() } }, path)
    assert.ok(result.ok)
    assert.equal(result.config.locks, undefined)
  })

  test('names follow the rules of tags and states, each once', () => {
    assert.deepEqual(problems({ apps: { web: chromium() }, locks: ['inbox', 'inbox', '1st'] }), [
      'locks[1]: repeats locks[0]',
      'locks[2]: expected a name of letters, digits, "_" and "-" that starts with a letter, received "1st"',
    ])
    assert.deepEqual(problems({ apps: { web: chromium() }, locks: 'inbox' }), ['locks: expected array, received "inbox"'])
  })
})

describe('continuous integration', () => {
  test('CI set to anything but nothing, 0 or false means a CI run', () => {
    assert.equal(isContinuousIntegration({ CI: 'true' }), true)
    assert.equal(isContinuousIntegration({ CI: '1' }), true)
    assert.equal(isContinuousIntegration({}), false)
    assert.equal(isContinuousIntegration({ CI: '' }), false)
    assert.equal(isContinuousIntegration({ CI: '0' }), false)
    assert.equal(isContinuousIntegration({ CI: ' False ' }), false)
  })

  const root = projectFolder()
  async function runWith(env: Record<string, string>, args: readonly string[] = []) {
    const fake = fakeCli({ cwd: root, env, runFiles: playing(passingRun(root)) })
    const code = await fake.cli(['run', file, '--browser', browserPath, '--output', join('out', String(Math.random())), ...args])
    return { code, options: fake.runs[0]?.options, stderr: fake.stderr.text }
  }

  test('a run in CI forbids test.only, saying how to allow it', async () => {
    const { options } = await runWith({ CI: 'true' })
    assert.equal(options?.forbidOnly, onlyInContinuousIntegration)
    assert.equal(onlyInContinuousIntegration, 'CI is set: remove test.only, or pass --allow-only to run it anyway.')
  })

  test('--allow-only lets a CI run narrow, and outside CI nothing forbids it', async () => {
    assert.equal((await runWith({ CI: 'true' }, ['--allow-only'])).options?.forbidOnly, undefined)
    assert.equal((await runWith({})).options?.forbidOnly, undefined)
    assert.equal((await runWith({ CI: 'false' })).options?.forbidOnly, undefined)
  })
})
