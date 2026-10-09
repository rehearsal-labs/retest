import type { LoadedConfig, LoadedSecret } from '../../src/config/loaded.ts'
import type { ResolvedSecret } from '../../src/runner/contract.ts'
import type { FillContext, SecretFill } from '../../src/runner/secrets.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { failure } from '../../src/protocol/failures.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { resolveSecrets, SecretFiller, secretValuesProblem, secretVariables } from '../../src/runner/secrets.ts'

const declared = new Map<string, LoadedSecret>([
  ['password', { source: { env: 'TEST_PASSWORD' }, origins: ['https://login.example'] }],
  ['token', { source: { env: 'TEST_TOKEN' }, origins: [] }],
  ['code', { source: { read: async () => 'unused' }, origins: [] }],
])
const config: LoadedConfig = { file: '/work/retest.config.ts', apps: new Map(), runs: [], secrets: declared, timeouts: {} }

const fill = (secret: string): SecretFill => ({ kind: 'fill', locator: { by: 'testId', value: 'password' }, value: { secret } })
const on = (pageUrl: string | undefined, signal = new AbortController().signal): FillContext => ({ pageUrl, appOrigins: ['http://127.0.0.1:4173'], timeoutMs: 500, signal })

describe('resolveSecrets', () => {
  test('reads each env source once and keeps each function source to call on use', () => {
    const resolved = resolveSecrets(config, { TEST_PASSWORD: 'hunter2', TEST_TOKEN: 'abcd' })
    assert.ok(resolved.ok)
    assert.deepEqual(resolved.secrets.get('password'), { value: 'hunter2' })
    assert.deepEqual(resolved.secrets.get('token'), { value: 'abcd' })
    const code = resolved.secrets.get('code')
    assert.ok(code !== undefined && 'read' in code)
  })

  test('a variable that is missing or empty is a setup failure naming every such secret', () => {
    assert.deepEqual(resolveSecrets(config, { TEST_TOKEN: '' }), {
      ok: false,
      failure: {
        class: 'setup_failed',
        message:
          'The secret "password" reads TEST_PASSWORD, which is not set. The secret "token" reads TEST_TOKEN, which is empty. Set them in the environment that runs Retest.',
      },
    })
  })

  test('a value shorter than four characters is a setup failure that never quotes it', () => {
    const resolved = resolveSecrets(config, { TEST_PASSWORD: 'x7z', TEST_TOKEN: 'long enough' })
    assert.deepEqual(resolved, {
      ok: false,
      failure: {
        class: 'setup_failed',
        message: 'The secret "password", read from TEST_PASSWORD, is shorter than 4 characters, too short to redact safely. Use a longer value.',
      },
    })
    assert.ok(!resolved.ok && !resolved.failure.message.includes('x7z'))
    assert.equal(resolveSecrets(config, { TEST_PASSWORD: 'abcd', TEST_TOKEN: 'long enough' }).ok, true)
  })

  test('values given ready are held to the same length', () => {
    assert.deepEqual(secretValuesProblem(new Map([['pin', { value: '123' }], ['code', { read: async () => 'x' }], ['token', { value: 'abcd' }]])), {
      class: 'setup_failed',
      message: 'The secret "pin" is shorter than 4 characters, too short to redact safely. Use a longer value.',
    })
    assert.equal(secretValuesProblem(new Map([['token', { value: 'abcd' }]])), undefined)
  })

  test('names the variables env sources read, which the test process never sees', () => {
    assert.deepEqual(secretVariables(declared), ['TEST_PASSWORD', 'TEST_TOKEN'])
  })
})

describe('SecretFiller', () => {
  function filler(secrets: ReadonlyMap<string, ResolvedSecret>): { filler: SecretFiller; redactor: Redactor } {
    const redactor = new Redactor()
    return { filler: new SecretFiller(secrets, declared, redactor), redactor }
  }

  test('types a value on an origin of the test apps, labelled with its secret, and teaches env values to the redactor at once', async () => {
    const { filler: secrets, redactor } = filler(new Map([['password', { value: 'hunter2' }]]))
    assert.equal(redactor.redact('hunter2'), '{{password}}')
    assert.deepEqual(await secrets.resolve(fill('password'), on('http://127.0.0.1:4173/login')), {
      ok: true,
      command: {
        kind: 'fill',
        locator: { by: 'testId', value: 'password' },
        value: 'hunter2',
        secret: 'password',
        allowedOrigins: ['http://127.0.0.1:4173', 'https://login.example'],
      },
    })
    assert.equal((await secrets.resolve(fill('password'), on('https://login.example/sso'))).ok, true, 'an origin secretOrigins lists')
  })

  // The page checks again as it types, since it may have moved since the navigation the parent last saw.
  test('binds the fill to the same origins it checked, once each', async () => {
    const { filler: secrets } = filler(new Map([['token', { value: 'abcd-1234' }]]))
    const context = { ...on('http://127.0.0.1:4173/'), appOrigins: ['http://127.0.0.1:4173', 'http://127.0.0.1:4173'] }
    const resolved = await secrets.resolve(fill('token'), context)
    assert.ok(resolved.ok)
    assert.deepEqual(resolved.command.allowedOrigins, ['http://127.0.0.1:4173'])
  })

  test('refuses any other origin, and a page that has opened nothing, without reading the value', async () => {
    let reads = 0
    const { filler: secrets } = filler(new Map([['code', { read: async () => `code-${++reads}` }]]))
    const refused = await secrets.resolve(fill('code'), on('https://evil.example/login'))
    assert.deepEqual(refused, {
      ok: false,
      failure: {
        class: 'not_actionable',
        message:
          'Retest did not type the secret "code": the page is on https://evil.example, and it may be typed only on http://127.0.0.1:4173. Add the origin to secretOrigins if it belongs there.',
        details: { origin: 'https://evil.example' },
      },
    })
    const blank = await secrets.resolve(fill('code'), on(undefined))
    assert.ok(!blank.ok)
    assert.match(blank.failure.message, /the page has not opened a web address yet/)
    assert.deepEqual(blank.failure.details, { origin: null })
    assert.equal(reads, 0, 'the source was never called')
  })

  // An Electron app can show its own page under any address, so a base URL of another app never vouches for its window.
  test('an Electron window takes a secret only on an origin secretOrigins lists, never on a base URL, without reading the value', async () => {
    let reads = 0
    const secrets = new SecretFiller(new Map([['password', { read: async () => `pass-${++reads}` }], ['token', { read: async () => `token-${++reads}` }]]), declared, new Redactor())
    const electron = (pageUrl: string): FillContext => ({ ...on(pageUrl), target: 'electron' })
    assert.deepEqual(await secrets.resolve(fill('password'), electron('http://127.0.0.1:4173/login')), {
      ok: false,
      failure: {
        class: 'not_actionable',
        message:
          'Retest did not type the secret "password": the window is on http://127.0.0.1:4173, and in an Electron app it may be typed only on https://login.example, the origins secretOrigins lists for it. An Electron app shows whatever origin it chooses, so no base URL counts there. Add the origin to secretOrigins if it belongs there.',
        details: { origin: 'http://127.0.0.1:4173' },
      },
    })
    assert.deepEqual(await secrets.resolve(fill('token'), electron('http://127.0.0.1:4173/login')), {
      ok: false,
      failure: {
        class: 'not_actionable',
        message:
          'Retest did not type the secret "token": the window is on http://127.0.0.1:4173, and in an Electron app it may be typed only on an origin secretOrigins lists for it, and it lists none. An Electron app shows whatever origin it chooses, so no base URL counts there. Add the origin to secretOrigins if it belongs there.',
        details: { origin: 'http://127.0.0.1:4173' },
      },
    })
    assert.equal(reads, 0, 'no source was called for a refused window')
    const listed = await secrets.resolve(fill('password'), electron('https://login.example/sso'))
    assert.deepEqual(listed.ok ? listed.command.allowedOrigins : listed.failure, ['https://login.example'], 'the fill is bound to the listed origin alone')
    const web = await secrets.resolve(fill('password'), { ...on('http://127.0.0.1:4173/login'), target: 'web' })
    assert.deepEqual(web.ok ? web.command.allowedOrigins : web.failure, ['http://127.0.0.1:4173', 'https://login.example'], 'a web page keeps its base URLs')
  })

  // An Electron app's window can be reached before its first document commits, as one under load was.
  describe('on a window that has opened no address yet', () => {
    const blankWindow = 'Retest did not type the secret "password": the window has not opened a web address yet, and in an Electron app it may be typed only on https://login.example, the origins secretOrigins lists for it. An Electron app shows whatever origin it chooses, so no base URL counts there. Add the origin to secretOrigins if it belongs there.'
    // A window whose address is `first` until `after` ms have passed, then `then`; it counts how often it was read.
    function windowAt(first: string | undefined, then: string, after: number, timeoutMs: number, signal = new AbortController().signal): { context: FillContext; reads: () => number } {
      const opened = performance.now()
      let reads = 0
      const currentUrl = (): string | undefined => { reads += 1; return performance.now() - opened >= after ? then : first }
      return { context: { ...on(first, signal), currentUrl, timeoutMs, target: 'electron' }, reads: () => reads }
    }

    test('waits within the fill\'s time for the first address, and checks that address as any', async () => {
      const { filler: secrets } = filler(new Map([['password', { value: 'hunter2' }]]))
      const started = performance.now()
      const resolved = await secrets.resolve(fill('password'), windowAt(undefined, 'https://login.example/sso', 60, 2000).context)
      assert.ok(performance.now() - started >= 50, 'it waited for the address')
      assert.deepEqual(resolved.ok ? resolved.command.allowedOrigins : resolved.failure, ['https://login.example'])
      const blank = await secrets.resolve(fill('password'), windowAt('about:blank', 'http://127.0.0.1:4173/index.html', 40, 2000).context)
      assert.deepEqual(blank.ok ? blank.command : blank.failure.details, { origin: 'http://127.0.0.1:4173' }, 'the first address is refused when secretOrigins does not list it')
    })

    test('refuses in the same words once its time is spent with no address, without reading the value', async () => {
      let reads = 0
      const secrets = new SecretFiller(new Map([['password', { read: async () => `pass-${++reads}` }]]), declared, new Redactor())
      const started = performance.now()
      const refused = await secrets.resolve(fill('password'), windowAt('about:blank', 'about:blank', 0, 120).context)
      assert.ok(performance.now() - started >= 110, 'it waited out the fill\'s time')
      assert.deepEqual(refused, { ok: false, failure: { class: 'not_actionable', message: blankWindow, details: { origin: null } } })
      assert.equal(reads, 0)
    })

    test('refuses a window on an address secretOrigins does not list at once, without reading its address again', async () => {
      const { filler: secrets } = filler(new Map([['password', { value: 'hunter2' }]]))
      const known = windowAt('http://127.0.0.1:4173/login', 'https://login.example/sso', 0, 2000)
      const started = performance.now()
      const refused = await secrets.resolve(fill('password'), known.context)
      assert.ok(performance.now() - started < 50)
      assert.equal(known.reads(), 0)
      assert.equal(refused.ok ? undefined : refused.failure.message, 'Retest did not type the secret "password": the window is on http://127.0.0.1:4173, and in an Electron app it may be typed only on https://login.example, the origins secretOrigins lists for it. An Electron app shows whatever origin it chooses, so no base URL counts there. Add the origin to secretOrigins if it belongs there.')
    })

    test('a fill stopped while it waits ends as the stop says, and reads nothing', async () => {
      let reads = 0
      const secrets = new SecretFiller(new Map([['password', { read: async () => `pass-${++reads}` }]]), declared, new Redactor())
      const controller = new AbortController()
      const stop = failure('interrupted', 'The run was interrupted.')
      setTimeout(() => controller.abort(stop), 30)
      const stopped = await secrets.resolve(fill('password'), windowAt(undefined, 'https://login.example/sso', 5000, 2000, controller.signal).context)
      assert.deepEqual(stopped, {
        ok: false,
        failure: { class: 'interrupted', message: 'The run was interrupted. Retest stopped waiting for the page to open an address for the secret "password", and typed nothing.', details: { inputSent: false } },
      })
      assert.equal(reads, 0)
    })

    test('reads the value in the time the wait left', async () => {
      const secrets = new SecretFiller(new Map([['password', { read: () => new Promise<string>(() => {}) }]]), declared, new Redactor())
      const resolved = await secrets.resolve(fill('password'), windowAt(undefined, 'https://login.example/sso', 80, 200).context)
      const took = resolved.ok ? undefined : /it took longer than (\d+) ms$/.exec(resolved.failure.message)?.[1]
      assert.ok(took !== undefined && Number(took) <= 130, `the read had what was left of 200 ms after about 80: ${took} ms`)
    })
  })

  test('a refused page whose host secretOrigins lists without a scheme is told that name reads as a bundle id', async () => {
    const native = new Map<string, LoadedSecret>([['pin', { source: { env: 'TEST_PIN' }, origins: ['https://login.example', 'example.com', 'dev.retest.fixtures.taskphone'] }]])
    const secrets = new SecretFiller(new Map([['pin', { value: 'pin-4821' }]]), native, new Redactor())
    const refused = await secrets.resolve(fill('pin'), on('https://Example.com/login'))
    assert.equal(
      refused.ok ? undefined : refused.failure.message,
      'Retest did not type the secret "pin": the page is on https://example.com, and it may be typed only on http://127.0.0.1:4173, https://login.example, example.com, dev.retest.fixtures.taskphone. secretOrigins lists example.com without a scheme, which Retest reads as a native app\'s bundle id: write https://example.com if this page is where it belongs.',
    )
    const elsewhere = await secrets.resolve(fill('pin'), on('https://other.example/login'))
    assert.match(elsewhere.ok ? '' : elsewhere.failure.message, /\. Add the origin to secretOrigins if it belongs there\.$/, 'a page on another host gets the usual advice')
  })

  test('calls a function source on every use and teaches each new value to the redactor', async () => {
    let reads = 0
    const { filler: secrets, redactor } = filler(new Map([['code', { read: async () => `code-${++reads}` }]]))
    const values = []
    for (let use = 0; use < 2; use++) {
      const resolved = await secrets.resolve(fill('code'), on('http://127.0.0.1:4173/'))
      assert.ok(resolved.ok)
      values.push(resolved.command.value)
    }
    assert.deepEqual(values, ['code-1', 'code-2'])
    assert.equal(redactor.redact('code-1 then code-2'), '{{code}} then {{code}}')
  })

  test('a source that throws, rejects, gives no text or takes too long fails the fill as setup, with the value hidden', async () => {
    const sources: [ResolvedSecret, RegExp][] = [
      [{ read: () => { throw new Error('vault is down') } }, /: vault is down$/],
      [{ read: async () => Promise.reject(new Error('expired')) }, /: expired$/],
      [{ read: async () => '' }, /: it gave no text$/],
      [{ read: async () => '42' }, /^The secret "code" is shorter than 4 characters, too short to redact safely\. Use a longer value\.$/],
      [{ read: () => new Promise<string>(() => {}) }, /: it took longer than 500 ms$/],
    ]
    for (const [source, message] of sources) {
      const resolved = await filler(new Map([['code', source]])).filler.resolve(fill('code'), on('http://127.0.0.1:4173/'))
      assert.ok(!resolved.ok)
      assert.equal(resolved.failure.class, 'setup_failed')
      assert.match(resolved.failure.message, message)
    }
    const leaking = new Map<string, ResolvedSecret>([['password', { value: 'hunter2' }], ['code', { read: async () => Promise.reject(new Error('hunter2 rejected')) }]])
    const resolved = await filler(leaking).filler.resolve(fill('code'), on('http://127.0.0.1:4173/'))
    assert.ok(!resolved.ok)
    assert.equal(resolved.failure.message, 'Retest could not read the secret "code": {{password}} rejected')
  })

  test('a secret the config does not declare is a usage failure', async () => {
    const resolved = await filler(new Map()).filler.resolve(fill('missing'), on('http://127.0.0.1:4173/'))
    assert.deepEqual(resolved, { ok: false, failure: { class: 'usage', message: 'secret("missing") is not one of the config\'s secrets.' } })
  })
})

describe("a function source's signal", () => {
  const page = 'http://127.0.0.1:4173/login'
  const reasonName = (signal: AbortSignal | undefined): string | undefined => (signal?.reason instanceof DOMException ? signal.reason.name : undefined)

  function waiting(signals: AbortSignal[]): ReadonlyMap<string, ResolvedSecret> {
    return new Map([['code', { read: ({ signal }) => {
      signals.push(signal)
      return new Promise<string>(() => {})
    } }]])
  }

  test('is aborted once the fill runs out of time, which fails it as before', async () => {
    const signals: AbortSignal[] = []
    const redactor = new Redactor()
    const resolved = await new SecretFiller(waiting(signals), declared, redactor).resolve(fill('code'), { ...on(page), timeoutMs: 30 })
    assert.deepEqual(resolved, { ok: false, failure: { class: 'setup_failed', message: 'Retest could not read the secret "code": it took longer than 30 ms' } })
    assert.deepEqual([signals.length, signals[0]?.aborted, reasonName(signals[0])], [1, true, 'TimeoutError'])
  })

  test('is aborted once the fill is stopped, which ends it as its reason says, typing nothing, and never after the value came', async () => {
    const signals: AbortSignal[] = []
    const stop = new AbortController()
    const resolving = new SecretFiller(waiting(signals), declared, new Redactor()).resolve(fill('code'), on(page, stop.signal))
    await Promise.resolve()
    assert.equal(signals[0]?.aborted, false, 'not before it is stopped')
    stop.abort({ class: 'interrupted', message: 'The run was interrupted.' })
    assert.deepEqual(await resolving, {
      ok: false,
      failure: { class: 'interrupted', message: 'The run was interrupted. Retest stopped reading the secret "code", and typed nothing.', details: { inputSent: false } },
    })
    assert.deepEqual([signals[0]?.aborted, reasonName(signals[0])], [true, 'AbortError'])
    const quick = new Map<string, ResolvedSecret>([['code', { read: async ({ signal }) => {
      signals.push(signal)
      return 'code-5521'
    } }]])
    const later = new AbortController()
    const resolved = await new SecretFiller(quick, declared, new Redactor()).resolve(fill('code'), on(page, later.signal))
    later.abort({ class: 'interrupted', message: 'The run was interrupted.' })
    assert.equal(resolved.ok ? resolved.command.value : undefined, 'code-5521')
    assert.equal(signals[1]?.aborted, false)
  })

  // The source may still give its value after Retest stopped waiting, and the app may show that value afterwards.
  test('a value that arrives after the fill ran out of time, or was stopped, is still taught to the redactor', async () => {
    for (const ending of ['timed out', 'stopped'] as const) {
      const late = Promise.withResolvers<string>()
      const redactor = new Redactor()
      const source = new Map<string, ResolvedSecret>([['code', { read: () => late.promise }]])
      const stop = new AbortController()
      const resolving = new SecretFiller(source, declared, redactor).resolve(fill('code'), { ...on(page, stop.signal), timeoutMs: ending === 'timed out' ? 30 : 5000 })
      if (ending === 'stopped') stop.abort({ class: 'interrupted', message: 'The run was interrupted.' })
      const resolved = await resolving
      assert.equal(resolved.ok, false, ending)
      late.resolve('code-8812')
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(redactor.redact('your code is code-8812'), 'your code is {{code}}', ending)
    }
  })

  test('a late value too short to hide, or a late failure, teaches nothing and is never left unhandled', async () => {
    const short = Promise.withResolvers<string>()
    const failing = Promise.withResolvers<string>()
    const redactor = new Redactor()
    const sources = new Map<string, ResolvedSecret>([['code', { read: () => short.promise }], ['token', { read: () => failing.promise }]])
    const filler = new SecretFiller(sources, declared, redactor)
    await filler.resolve(fill('code'), { ...on(page), timeoutMs: 20 })
    await filler.resolve(fill('token'), { ...on(page), timeoutMs: 20 })
    short.resolve('42')
    failing.reject(new Error('vault is down'))
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(redactor.active, false)
  })

  test('a fill stopped before it began never waits for its source', async () => {
    const signals: AbortSignal[] = []
    const started = performance.now()
    const resolved = await new SecretFiller(waiting(signals), declared, new Redactor()).resolve(fill('code'), { ...on(page, AbortSignal.abort({ class: 'timeout', message: 'The test ran out of time.' })), timeoutMs: 5000 })
    assert.ok(performance.now() - started < 1000)
    assert.equal(resolved.ok ? undefined : resolved.failure.class, 'timeout')
    assert.equal(signals[0]?.aborted, true)
  })
})
