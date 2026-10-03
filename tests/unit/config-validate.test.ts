import type { LoadedConfig } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { app, chrome, chromium, defineConfig, edge, env } from '../../src/config/define.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { maxTimeout } from '../../src/protocol/timeouts.ts'

const path = '/work/retest.config.ts'

function loaded(value: unknown): LoadedConfig {
  const result = validateConfig(value, path)
  assert.ok(result.ok, result.ok ? '' : result.failure.message)
  return result.config
}

/** Every problem the config has, as `key: message` lines. */
function problems(value: unknown): string[] {
  const result = validateConfig(value, path)
  assert.equal(result.ok, false, 'expected the config to be rejected')
  if (result.ok) return []
  assert.equal(result.failure.class, 'usage')
  const lines = result.failure.message.split('\n')
  return lines.length === 1 ? [lines[0]?.slice(`${path}: `.length) ?? ''] : lines.slice(1).map((line) => line.trim())
}

const web = { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) }
const waiting = { signal: new AbortController().signal }

describe('validateConfig: what it reads', () => {
  test('a target on its own is an app with one target, named after its browser', () => {
    const config = loaded({ apps: { web: { browser: 'chromium' } } })
    assert.equal(config.file, path)
    assert.equal(config.defaultApp, 'web')
    assert.deepEqual([...config.apps.keys()], ['web'])
    const only = config.apps.get('web')
    assert.deepEqual(only && [...only.targets.entries()], [['chromium', { name: 'chromium', headless: true, browser: 'chromium' }]])
    assert.deepEqual(config.runs, [])
    assert.equal(config.secrets.size, 0)
    assert.deepEqual(config.timeouts, {})
    assert.equal('tags' in config || 'states' in config, false)
  })

  test('fills in defaults and makes every path absolute from the config folder', () => {
    const config = loaded(
      defineConfig({
        apps: {
          web: app({
            baseUrl: 'http://127.0.0.1:4173',
            start: { command: 'npm run dev', ready: 'http://127.0.0.1:4173/health', cwd: 'site', timeoutMs: 30_000 },
            targets: {
              local: chromium({ executablePath: '../browsers/chrome', headless: false }),
              beta: chrome({ channel: 'beta' }),
              edge: edge(),
            },
          }),
          phone: chrome({ emulate: 'Pixel 9', start: { command: 'npm run mobile', ready: 'https://127.0.0.1:4200' } }),
          tablet: edge({ emulate: { viewport: { width: 800, height: 1280 }, deviceScaleFactor: 2, touch: true } }),
        },
        defaultApp: 'web',
        timeouts: { action: 500 },
      }),
    )
    const webApp = config.apps.get('web')
    assert.equal(webApp?.baseUrl, 'http://127.0.0.1:4173')
    assert.deepEqual(webApp?.start, { command: 'npm run dev', ready: 'http://127.0.0.1:4173/health', cwd: '/work/site', timeoutMs: 30_000 })
    assert.deepEqual(webApp?.targets.get('local'), { name: 'local', headless: false, browser: 'chromium', executablePath: '/browsers/chrome' })
    assert.deepEqual(webApp?.targets.get('beta'), { name: 'beta', headless: true, browser: 'chrome', channel: 'beta' })
    assert.deepEqual(webApp?.targets.get('edge'), { name: 'edge', headless: true, browser: 'edge', channel: 'stable' })
    assert.deepEqual(config.apps.get('phone')?.start, { command: 'npm run mobile', ready: 'https://127.0.0.1:4200', cwd: '/work' })
    assert.equal(config.apps.get('phone')?.targets.get('chrome')?.emulate, 'Pixel 9')
    assert.deepEqual(config.apps.get('tablet')?.targets.get('edge')?.emulate, {
      viewport: { width: 800, height: 1280 },
      deviceScaleFactor: 2,
      touch: true,
      isMobile: false,
    })
    assert.equal(config.defaultApp, 'web')
    assert.deepEqual(config.timeouts, { action: 500 })
  })

  test('several apps with none named leave the default app absent', () => {
    const config = loaded({ apps: { owner: chromium(), member: chromium() } })
    assert.equal('defaultApp' in config, false)
  })

  test('keeps runs, tags and states, and reads secrets with their extra origins', async () => {
    const config = loaded({
      apps: { web: app({ targets: { chromium: chromium(), beta: chrome({ channel: 'beta' }) } }), mobile: chrome({ emulate: 'iPhone 17' }) },
      runs: [{ web: 'beta', mobile: 'chrome' }, { mobile: 'chrome', web: 'chromium' }],
      secrets: { password: env('TEST_PASSWORD'), code: async () => '482913' },
      secretOrigins: { password: ['https://auth.example.test', 'http://127.0.0.1:9000/'] },
      testIds: ['save-task'],
      tags: ['smoke', 'slow'],
      states: ['signed-in'],
    })
    assert.deepEqual(config.runs, [{ web: 'beta', mobile: 'chrome' }, { mobile: 'chrome', web: 'chromium' }])
    assert.deepEqual(config.tags, ['smoke', 'slow'])
    assert.deepEqual(config.states, ['signed-in'])
    assert.deepEqual(config.secrets.get('password'), {
      source: { env: 'TEST_PASSWORD' },
      origins: ['https://auth.example.test', 'http://127.0.0.1:9000'],
    })
    const code = config.secrets.get('code')
    assert.deepEqual(code?.origins, [])
    assert.ok(code !== undefined && 'read' in code.source)
    assert.equal(await code.source.read(waiting), '482913')
  })

  test('a proxy is kept as its scheme, host and port, with its bypass rules as given, none by default', () => {
    const config = loaded(
      defineConfig({
        apps: {
          web: app({
            targets: {
              hosted: chromium({ proxy: { server: 'HTTP://Proxy.Local:8080/', bypass: ['<-loopback>', '*.internal', ' localhost '] } }),
              socks: chrome({ proxy: { server: 'socks5://127.0.0.1:1080' } }),
              local: edge({ proxy: { server: 'https://[::1]:8443', bypass: [] } }),
              direct: chromium(),
            },
          }),
          admin: chromium({ proxy: { server: 'socks4://proxy.internal' } }),
        },
        defaultApp: 'web',
      }),
    )
    const targets = config.apps.get('web')?.targets
    assert.deepEqual(targets?.get('hosted')?.proxy, { server: 'http://proxy.local:8080', bypass: ['<-loopback>', '*.internal', ' localhost '] })
    assert.deepEqual(targets?.get('socks')?.proxy, { server: 'socks5://127.0.0.1:1080', bypass: [] })
    assert.deepEqual(targets?.get('local')?.proxy, { server: 'https://[::1]:8443', bypass: [] })
    assert.equal(targets?.get('direct')?.proxy, undefined)
    assert.deepEqual(config.apps.get('admin')?.targets.get('chromium')?.proxy, { server: 'socks4://proxy.internal', bypass: [] })
  })

  test('a key set to undefined counts as absent, at any depth', () => {
    const config = loaded({
      apps: { web: app({ baseUrl: undefined, targets: { beta: chrome({ channel: undefined, emulate: undefined }) } }) },
      defaultApp: undefined,
      tags: undefined,
      timeouts: { action: undefined, test: 3000 },
    })
    assert.deepEqual(config.apps.get('web'), { name: 'web', targets: new Map([['beta', { name: 'beta', headless: true, browser: 'chrome', channel: 'stable' }]]) })
    assert.deepEqual(config.timeouts, { test: 3000 })
  })

  test('names that are also object methods are ordinary names', () => {
    const config = loaded({ apps: { constructor: chromium(), toString: chromium() } })
    assert.deepEqual([...config.apps.keys()], ['constructor', 'toString'])
    assert.equal(config.apps.get('hasOwnProperty'), undefined)
  })
})

describe('validateConfig: what it rejects', () => {
  test('anything but a config object', () => {
    for (const value of [undefined, null, 'web', [], new Map()]) {
      const result = validateConfig(value, 'retest.config.ts')
      assert.equal(result.ok, false)
      if (result.ok) continue
      assert.match(result.failure.message, /^retest\.config\.ts: expected the object defineConfig\(\) returns, received /)
      assert.deepEqual(result.failure.details, { key: '' })
    }
  })

  test('names the config path and the key in a one-problem message', () => {
    const result = validateConfig({ apps: web, retries: 2 }, 'config/retest.config.ts')
    assert.deepEqual(result, {
      ok: false,
      failure: { class: 'usage', message: 'config/retest.config.ts: retries: unknown key', details: { key: 'retries' } },
    })
  })

  test('lists every problem, each with its key, when there are several', () => {
    const result = validateConfig({ apps: {}, defaultApp: 7, tags: ['and'] }, 'retest.config.ts')
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(
      result.failure.message,
      [
        'retest.config.ts has 3 problems:',
        '  apps: expected at least one app',
        '  defaultApp: expected string, received 7',
        '  tags[0]: "and" cannot be a tag, because --tag reads it as a word',
      ].join('\n'),
    )
    assert.deepEqual(result.failure.details, { key: 'apps' })
  })

  test('apps and their targets', () => {
    assert.deepEqual(problems({}), ['apps: missing required key'])
    assert.deepEqual(problems({ apps: [] }), ['apps: expected object, received array'])
    assert.deepEqual(problems({ apps: { 'my app': chromium(), '9lives': chromium() } }), [
      'apps["my app"]: expected a name of letters, digits, "_" and "-" that starts with a letter, received "my app"',
      'apps["9lives"]: expected a name of letters, digits, "_" and "-" that starts with a letter, received "9lives"',
    ])
    assert.deepEqual(problems({ apps: JSON.parse('{"__proto__":{"browser":"chromium"}}') }), [
      'apps.__proto__: expected a name of letters, digits, "_" and "-" that starts with a letter, received "__proto__"',
    ])
    assert.deepEqual(problems({ apps: { web: app({ targets: {} }) } }), ['apps.web.targets: expected at least one target'])
    assert.deepEqual(problems({ apps: { web: { targets: [] } } }), ['apps.web.targets: expected object, received array'])
    assert.deepEqual(problems({ apps: { web: { targets: { chromium: chromium() }, target: 1 } } }), ['apps.web.target: unknown key'])
    assert.deepEqual(problems({ apps: { web: { browser: 'safari' } } }), [
      'apps.web.browser: expected one of "chromium", "chrome", "edge", "firefox", "webkit", received "safari"',
    ])
    assert.deepEqual(problems({ apps: { web: { baseUrl: 'http://127.0.0.1:4173' } } }), ['apps.web.browser: missing required key'])
    assert.deepEqual(problems({ apps: { web: { targets: { beta: { browser: 'chrome', channel: 'nightly' } } } } }), [
      'apps.web.targets.beta.channel: expected one of "stable", "beta", "dev", "canary", received "nightly"',
    ])
    assert.deepEqual(problems({ apps: { web: { browser: 'chrome', executablePath: '/opt/chrome' } } }), ['apps.web.executablePath: unknown key'])
    assert.deepEqual(problems({ apps: { web: chromium({ executablePath: '' }) } }), ['apps.web.executablePath: expected a path, received ""'])
  })

  test('app settings belong to the app, never to a target inside it', () => {
    const inside = { targets: { beta: { ...chrome({ channel: 'beta' }), baseUrl: 'http://127.0.0.1:4173', start: { command: 'x', ready: 'http://x' } } } }
    assert.deepEqual(problems({ apps: { web: inside } }), [
      'apps.web.targets.beta.baseUrl: baseUrl belongs to the app, not to one of its targets',
      'apps.web.targets.beta.start: start belongs to the app, not to one of its targets',
    ])
  })

  test('base URLs and the start command', () => {
    // Found in the milestone 2 review: a target with a wrong setting hid the checks of its base URL and start.
    assert.deepEqual(problems({ apps: { web: { ...chromium({ baseUrl: 'localhost:3000', start: { command: ' ', ready: 'x' } }), headless: 'yes' } } }), [
      'apps.web.baseUrl: expected an http or https URL, received "localhost:3000"',
      'apps.web.start.command: expected a command, received " "',
      'apps.web.start.ready: expected an http or https URL, received "x"',
      'apps.web.headless: expected boolean, received "yes"',
    ])
    assert.deepEqual(problems({ apps: { web: chromium({ baseUrl: 'localhost:3000' }) } }), [
      'apps.web.baseUrl: expected an http or https URL, received "localhost:3000"',
    ])
    assert.deepEqual(problems({ apps: { web: chromium({ baseUrl: 'file:///tmp/index.html' }) } }), [
      'apps.web.baseUrl: expected an http or https URL, received "file:///tmp/index.html"',
    ])
    const start = { command: '  ', ready: 'ftp://127.0.0.1', cwd: '', timeoutMs: maxTimeout + 1 }
    assert.deepEqual(problems({ apps: { web: chromium({ start }) } }), [
      'apps.web.start.command: expected a command, received "  "',
      'apps.web.start.ready: expected an http or https URL, received "ftp://127.0.0.1"',
      'apps.web.start.cwd: expected a folder, received ""',
      `apps.web.start.timeoutMs: expected integer <= ${maxTimeout}, received ${maxTimeout + 1}`,
    ])
    assert.deepEqual(problems({ apps: { web: { browser: 'chromium', start: { command: 'npm run dev' } } } }), ['apps.web.start.ready: missing required key'])
  })

  test('emulation: an unknown device lists the known ones, and a screen of your own is checked', () => {
    assert.deepEqual(problems({ apps: { phone: { browser: 'chromium', emulate: 'Pixel 99' } } }), [
      'apps.phone.emulate: expected one of "Pixel 9", "Galaxy S24", "iPhone 17", "iPad Pro 11" or object, received "Pixel 99"',
    ])
    assert.deepEqual(problems({ apps: { phone: { browser: 'chromium', emulate: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 } } } }), [
      'apps.phone.emulate.touch: missing required key',
    ])
    const flat = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 0, touch: true, userAgent: '' }
    assert.deepEqual(problems({ apps: { phone: { browser: 'chromium', emulate: flat } } }), [
      'apps.phone.emulate.deviceScaleFactor: expected number > 0, received 0',
      'apps.phone.emulate.userAgent: expected a user agent, received ""',
    ])
    const wide = { viewport: { width: 390.5, height: 0 }, deviceScaleFactor: 3, touch: true, hasTouch: true }
    assert.deepEqual(problems({ apps: { phone: { browser: 'chromium', emulate: wide } } }), [
      'apps.phone.emulate.viewport.width: expected integer >= 1, received 390.5',
      'apps.phone.emulate.viewport.height: expected integer >= 1, received 0',
      'apps.phone.emulate.hasTouch: unknown key',
    ])
  })

  test('a proxy: an address of one of four schemes with a host, never a user name or password, and one rule per bypass entry', () => {
    const at = (proxy: unknown): string[] => problems({ apps: { web: { browser: 'chromium', proxy } } })
    const signIn = 'apps.web.proxy.server: holds a user name or password, and Retest does not sign in to a proxy. Give the address alone'
    for (const server of ['http://ada:hunter2@proxy.local:8080', 'socks5://ada:hunter2@127.0.0.1:1080', 'http://hunter2@proxy.local', 'https://:hunter2@proxy.local']) {
      assert.deepEqual(at({ server }), [signIn], server)
    }
    const address = 'apps.web.proxy.server: expected a proxy address such as http://127.0.0.1:8080: the scheme http, https, socks4 or socks5, and a host'
    for (const server of ['ftp://proxy.local', 'proxy.local:8080', 'ada:hunter2@proxy.local:8080', 'http://proxy.local/hunter2', 'http://proxy.local:8080?key=hunter2', 'http://proxy.local#hunter2', 'socks5://', 'socks5:///hunter2', 'direct://', '']) {
      assert.deepEqual(at({ server }), [address], server)
    }
    assert.deepEqual(at("http://ada:hunter2@proxy.local:8080"), ["apps.web.proxy: expected an object such as { server: 'http://127.0.0.1:8080' }, received a string"])
    assert.deepEqual(at({ server: 'http://proxy.local:8080', bypass: ['', ' ', 'a.test;b.test', 'ok.test'] }), [
      'apps.web.proxy.bypass[0]: expected a rule such as localhost or *.internal, received ""',
      'apps.web.proxy.bypass[1]: expected a rule such as localhost or *.internal, received " "',
      'apps.web.proxy.bypass[2]: expected one rule, received "a.test;b.test". List each rule on its own',
    ])
    assert.deepEqual(at({ bypass: [] }), ['apps.web.proxy.server: missing required key'])
    assert.deepEqual(at({ server: 8080 }), ['apps.web.proxy.server: expected string, received 8080'])
    assert.deepEqual(at({ server: 'http://proxy.local:8080', bypass: 'localhost' }), ['apps.web.proxy.bypass: expected array, received "localhost"'])
    assert.deepEqual(at({ server: 'http://proxy.local:8080', username: 'ada', password: 'hunter2' }), [
      'apps.web.proxy.username: unknown key',
      'apps.web.proxy.password: unknown key',
    ])
    assert.deepEqual(problems({ apps: { web: app({ targets: { hosted: { browser: 'chrome', proxy: { server: 'http://ada:hunter2@p.local' } } } }) } }), [
      'apps.web.targets.hosted.proxy.server: holds a user name or password, and Retest does not sign in to a proxy. Give the address alone',
    ])
  })

  test('no problem with a proxy quotes its address, which may hold a password', () => {
    const servers = ['http://ada:hunter2@proxy.local:8080', 'ada:hunter2@proxy.local:8080', 'ftp://ada:hunter2@p', 'http://p/hunter2', 'socks9://ada:hunter2@p']
    const found = [
      ...servers.flatMap((server) => problems({ apps: { web: { browser: 'chromium', proxy: { server } } } })),
      ...servers.flatMap((server) => problems({ apps: { web: { browser: 'chromium', proxy: server } } })),
    ]
    assert.equal(found.length, servers.length * 2)
    for (const line of found) assert.equal(line.includes('hunter2') || line.includes('ada'), false, line)
  })

  test('the default app must be an app', () => {
    assert.deepEqual(problems({ apps: { web: chromium(), phone: chromium() }, defaultApp: 'admin' }), [
      'defaultApp: expected one of "web", "phone", received "admin"',
    ])
    assert.deepEqual(problems({ apps: { web: { browser: 'safari' } }, defaultApp: 'web' }), [
      'apps.web.browser: expected one of "chromium", "chrome", "edge", "firefox", "webkit", received "safari"',
    ])
  })

  test('runs name apps and their targets, once each', () => {
    const apps = { web: app({ targets: { chromium: chromium(), beta: chrome({ channel: 'beta' }) } }), mobile: chrome({ emulate: 'Pixel 9' }) }
    assert.deepEqual(problems({ apps, runs: [{}] }), ['runs[0]: expected at least one app'])
    assert.deepEqual(problems({ apps, runs: [{ admin: 'chromium' }] }), ['runs[0].admin: unknown app, expected one of "web", "mobile"'])
    assert.deepEqual(problems({ apps, runs: [{ web: 'edge', mobile: 'chrome' }] }), [
      'runs[0].web: expected one of "chromium", "beta", received "edge"',
    ])
    assert.deepEqual(problems({ apps, runs: [{ web: 'beta', mobile: 'chrome' }, { mobile: 'chrome', web: 'beta' }] }), ['runs[1]: repeats runs[0]'])
    assert.deepEqual(problems({ apps, runs: { web: 'beta' } }), ['runs: expected array, received object'])
    assert.deepEqual(problems({ apps, runs: [{ web: 1 }] }), ['runs[0].web: expected string, received 1'])
  })

  test('secrets name where their value comes from, and a misplaced value is never shown', () => {
    const shown = problems({ apps: web, secrets: { password: 'hunter2', pin: 4821, list: ['a'] } })
    assert.deepEqual(shown, [
      'secrets.password: expected env("NAME") or a function that returns the secret, received string',
      'secrets.pin: expected env("NAME") or a function that returns the secret, received number',
      'secrets.list: expected env("NAME") or a function that returns the secret, received array',
    ])
    assert.equal(shown.join('\n').includes('hunter2') || shown.join('\n').includes('4821'), false)
    assert.deepEqual(problems({ apps: web, secrets: 'hunter2' }), ['secrets: expected object, received string'])
    assert.deepEqual(problems({ apps: web, secrets: { password: env('TEST PASSWORD') } }), [
      'secrets.password.env: expected an environment variable name, received "TEST PASSWORD"',
    ])
    assert.deepEqual(problems({ apps: web, secrets: { password: { env: 'A', value: 'hunter2' } } }), ['secrets.password.value: unknown key'])
    assert.deepEqual(problems({ apps: web, secrets: { 'my password': env('A') } }), [
      'secrets["my password"]: expected a name of letters, digits, "_" and "-" that starts with a letter, received "my password"',
    ])
  })

  test('secret origins belong to a declared secret and are origins', () => {
    const secrets = { password: env('TEST_PASSWORD') }
    assert.deepEqual(problems({ apps: web, secrets, secretOrigins: { token: ['https://auth.example.test'] } }), [
      'secretOrigins.token: unknown secret, expected "password"',
    ])
    assert.deepEqual(problems({ apps: web, secretOrigins: { token: [] } }), ['secretOrigins.token: unknown secret, the config declares no secrets'])
    const origins = ['https://auth.example.test/login', 'auth.example.test', 'https://ada@auth.example.test', 'ftp://example.test', 'https://example.test?x=1']
    assert.deepEqual(
      problems({ apps: web, secrets, secretOrigins: { password: origins } }),
      origins.map((origin, index) => `secretOrigins.password[${index}]: expected an origin such as https://example.com, received ${JSON.stringify(origin)}`),
    )
    assert.deepEqual(problems({ apps: web, secrets, secretOrigins: { password: 'https://auth.example.test' } }), [
      'secretOrigins.password: expected array, received "https://auth.example.test"',
    ])
  })

  test('test ids, tags, states and timeouts', () => {
    assert.deepEqual(problems({ apps: web, testIds: { save: 1 } }), ['testIds.save: expected string, received 1'])
    assert.deepEqual(problems({ apps: web, testIds: 'save-task' }), ['testIds: expected object or array, received "save-task"'])
    assert.deepEqual(problems({ apps: web, tags: ['smoke', 'or', 'not', 'smoke', 'two words'] }), [
      'tags[3]: repeats tags[0]',
      'tags[4]: expected a name of letters, digits, "_" and "-" that starts with a letter, received "two words"',
      'tags[1]: "or" cannot be a tag, because --tag reads it as a word',
      'tags[2]: "not" cannot be a tag, because --tag reads it as a word',
    ])
    assert.deepEqual(problems({ apps: web, states: ['signed-in', 'signed-in'] }), ['states[1]: repeats states[0]'])
    assert.deepEqual(problems({ apps: web, timeouts: { acton: 5, test: 0, action: maxTimeout + 1 } }), [
      'timeouts.test: expected integer >= 1, received 0',
      'timeouts.acton: unknown key',
    ])
    assert.deepEqual(problems({ apps: web, timeouts: { action: maxTimeout + 1 } }), [
      `timeouts.action: expected integer <= ${maxTimeout}, received ${maxTimeout + 1}`,
    ])
  })

  test('a config that refers to itself still ends', () => {
    const tags: unknown[] = ['smoke']
    tags.push(tags)
    const target: Record<string, unknown> = { browser: 'chromium' }
    target['self'] = target
    assert.deepEqual(problems({ apps: { web: target }, tags }), [
      'apps.web.self: unknown key',
      'tags[1]: expected string, received array',
    ])
  })
})

describe('function secrets', () => {
  test('are called on each use, and give only non-empty text', async () => {
    let calls = 0
    const config = loaded({
      apps: web,
      secrets: {
        code: () => `code-${++calls}`,
        empty: async () => '',
        number: () => 482913,
        broken: () => Promise.reject(new Error('The vault is locked.')),
      },
    })
    const read = (name: string): Promise<string> => {
      const source = config.secrets.get(name)?.source
      assert.ok(source !== undefined && 'read' in source, name)
      return source.read(waiting)
    }
    assert.equal(await read('code'), 'code-1')
    assert.equal(await read('code'), 'code-2')
    await assert.rejects(read('empty'), { name: 'TypeError', message: 'The function for secret "empty" returned an empty string, not the secret\'s text.' })
    await assert.rejects(read('number'), { name: 'TypeError', message: 'The function for secret "number" returned number, not the secret\'s text.' })
    await assert.rejects(read('broken'), { message: 'The vault is locked.' })
  })

  // A function that waits on a network or an inbox can give up once Retest has stopped waiting for it.
  test('are called with the signal of each read, and nothing more', async () => {
    const calls: unknown[][] = []
    const config = loaded({
      apps: web,
      secrets: {
        code: (...args: unknown[]) => {
          calls.push(args)
          return 'code-1'
        },
      },
    })
    const source = config.secrets.get('code')?.source
    assert.ok(source !== undefined && 'read' in source)
    const reading = new AbortController()
    assert.equal(await source.read({ signal: reading.signal }), 'code-1')
    assert.equal(calls.length, 1)
    const [[context, ...rest] = []] = calls
    assert.deepEqual(rest, [])
    assert.ok(isPlainObject(context))
    assert.equal(context['signal'], reading.signal)
  })
})
