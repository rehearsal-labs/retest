import type { LoadedConfig, LoadedSecret } from '../../src/config/loaded.ts'
import type { ResolvedSecret } from '../../src/runner/contract.ts'
import type { FillContext, SecretFill } from '../../src/runner/secrets.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
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

  test('a fill stopped before it began never waits for its source', async () => {
    const signals: AbortSignal[] = []
    const started = performance.now()
    const resolved = await new SecretFiller(waiting(signals), declared, new Redactor()).resolve(fill('code'), { ...on(page, AbortSignal.abort({ class: 'timeout', message: 'The test ran out of time.' })), timeoutMs: 5000 })
    assert.ok(performance.now() - started < 1000)
    assert.equal(resolved.ok ? undefined : resolved.failure.class, 'timeout')
    assert.equal(signals[0]?.aborted, true)
  })
})
