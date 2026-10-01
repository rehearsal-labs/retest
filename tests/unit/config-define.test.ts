import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { app, chrome, chromium, defineConfig, edge, env } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'

// Holds only when both types are the same, so a widened literal fails the type check of this file.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
function sameType<A, B>(check: Same<A, B>): void {
  assert.equal(check, true)
}

describe('defineConfig and app', () => {
  test('return what they are given', () => {
    const options = { targets: { chromium: chromium() } }
    assert.equal(app(options), options)
    const config = { apps: { web: app(options) } }
    assert.equal(defineConfig(config), config)
  })

  test('keep every name a literal type', () => {
    const config = defineConfig({
      apps: {
        web: app({ baseUrl: 'http://127.0.0.1:4173', targets: { chromium: chromium(), beta: chrome({ channel: 'beta' }) } }),
        phone: chromium({ emulate: 'Pixel 9' }),
        tablet: edge({ emulate: { viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, touch: true } }),
      },
      defaultApp: 'web',
      runs: [{ web: 'beta', phone: 'chromium' }],
      secrets: { password: env('TEST_PASSWORD'), code: async () => '123456' },
      testIds: { save: 'save-task', title: 'task-title' },
      tags: ['smoke', 'slow'],
      states: ['signed-in'],
    })
    sameType<keyof typeof config.apps, 'web' | 'phone' | 'tablet'>(true)
    sameType<keyof typeof config.apps.web.targets, 'chromium' | 'beta'>(true)
    sameType<typeof config.apps.web.targets.beta.channel, 'beta'>(true)
    sameType<typeof config.apps.phone.emulate, 'Pixel 9'>(true)
    sameType<typeof config.apps.tablet.emulate.touch, true>(true)
    sameType<typeof config.defaultApp, 'web'>(true)
    sameType<typeof config.secrets.password.env, 'TEST_PASSWORD'>(true)
    sameType<keyof typeof config.secrets, 'password' | 'code'>(true)
    sameType<(typeof config.testIds)[keyof typeof config.testIds], 'save-task' | 'task-title'>(true)
    sameType<(typeof config.tags)[number], 'smoke' | 'slow'>(true)
    sameType<(typeof config.states)[number], 'signed-in'>(true)
  })
})

describe('secret functions', () => {
  // In a project with Node's types or the DOM's, the signal is the project's own AbortSignal, so it can go to fetch.
  test("take a context whose signal is the project's own AbortSignal", async () => {
    const config = defineConfig({
      apps: { web: chromium() },
      secrets: {
        code: async ({ signal }) => {
          signal.throwIfAborted()
          return signal.aborted ? 'never' : 'code-1'
        },
        plain: () => 'written-in-place',
      },
    })
    type Context = Parameters<typeof config.secrets.code>[0]
    sameType<Context['signal'], AbortSignal>(true)
    assert.equal(await config.secrets.code({ signal: new AbortController().signal }), 'code-1')
    const stopped = new AbortController()
    stopped.abort(new Error('Retest stopped waiting.'))
    await assert.rejects(config.secrets.code({ signal: stopped.signal }), { message: 'Retest stopped waiting.' })
  })
})

describe('target constructors', () => {
  test('tag a copy of their options with the browser', () => {
    const options = { headless: false, emulate: 'Pixel 9' } as const
    const target = chromium(options)
    assert.deepEqual(target, { headless: false, emulate: 'Pixel 9', browser: 'chromium' })
    assert.notEqual(target, options)
    assert.deepEqual(options, { headless: false, emulate: 'Pixel 9' })
    assert.deepEqual(chrome({ channel: 'canary' }), { channel: 'canary', browser: 'chrome' })
    assert.deepEqual(edge(), { browser: 'edge' })
    assert.deepEqual(chromium(), { browser: 'chromium' })
  })

  test('the tag wins over a browser key a JavaScript caller passes', () => {
    const target: unknown = Reflect.apply(chrome, undefined, [{ browser: 'firefox' }])
    assert.deepEqual(target, { browser: 'chrome' })
  })

  test('env names the variable and nothing else', () => {
    assert.deepEqual(env('TEST_PASSWORD'), { env: 'TEST_PASSWORD' })
  })

  test('what the constructors make is a valid config', () => {
    const config = defineConfig({
      apps: {
        web: app({ baseUrl: 'http://127.0.0.1:4173', targets: { chromium: chromium({ executablePath: '/opt/chromium/chrome' }), edge: edge() } }),
        phone: chrome({ emulate: 'iPhone 17', baseUrl: 'http://127.0.0.1:4173' }),
      },
      runs: [{ web: 'edge', phone: 'chrome' }],
      secrets: { password: env('TEST_PASSWORD') },
    })
    const result = validateConfig(config, '/work/retest.config.ts')
    assert.equal(result.ok, true, result.ok ? '' : result.failure.message)
  })
})
