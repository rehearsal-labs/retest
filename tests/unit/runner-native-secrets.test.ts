import type { TestContext } from 'node:test'
import type { LoadedNativeTarget, LoadedSecret } from '../../src/config/loaded.ts'
import type { CommandResult, PageCommand } from '../../src/protocol/commands.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { ResolvedSecret } from '../../src/runner/contract.ts'
import type { NativePoolRuntime, StartNative } from '../../src/runner/native-pool.ts'
import type { ResourceNeed } from '../../src/runner/resources.ts'
import type { FakeElement, FakeInteraction } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { SharedLocks } from '../../src/runner/locks.ts'
import { NativePageAdapter, NativePool } from '../../src/runner/native-pool.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { ResourceLease } from '../../src/runner/resources.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { SecretFiller } from '../../src/runner/secrets.ts'
import { ScriptedProcess } from '../support/scripted-process.ts'
import { deskSignIn, openFake, phoneSignIn } from './native-interaction-fake.ts'

// A secret reaches a native app only when `secretOrigins` names that app's bundle id, as the installed app names it.
// These run the parent's path as the run session wires it: the test process sends the secret's name, `RunningTest`
// asks the `SecretFiller` with the page's destination, and the native page types what comes back. Each value is fresh
// and compared only through booleans, so a failure message never prints it.

const budgets = { collection: 2000, setup: 2000, action: 3000, assertion: 2000, navigation: 2000, cleanup: 2000, test: 8000 }
const phoneBundle = 'dev.retest.fixtures.taskphone'
const deskBundle = 'dev.retest.fixtures.taskdesk'
// A web app's base URL in the same test: its origin never makes a native app a destination.
const appOrigins = ['http://127.0.0.1:4310']
const password = { by: 'testId', value: 'password-field' } as const
// The executor routes that carry input. A refused fill sends none of them.
const inputRoutes = ['POST /session/:session/element/:element/click', 'POST /session/:session/wda/keys', 'POST /session/:session/actions', 'POST /session/:session/wda/element/:element/scroll']

type Fill = { readonly answer: CommandResult; readonly events: readonly EventBody[]; readonly sent: string }

function freshValue(): string {
  return `native-${randomBytes(12).toString('hex')}`
}

function declared(origins: readonly string[]): Map<string, LoadedSecret> {
  return new Map([['password', { source: { env: 'RETEST_UNIT_NATIVE_PASSWORD' }, origins }]])
}

// One secret fill through `RunningTest`, then the test ends; what the parent emitted and sent to the child is kept.
async function fillThroughParent(fake: FakeInteraction, app: string, filler: SecretFiller, redactor: Redactor): Promise<Fill> {
  const child = new ScriptedProcess()
  const events: EventBody[] = []
  const running = new RunningTest({
    process: child,
    pages: new Map([[app, new NativePageAdapter(fake.interaction)]]),
    testId: 'test',
    attemptId: 'attempt',
    timeouts: budgets,
    emit: (event) => events.push(event),
    fillSecret: (command, context) => filler.resolve(command, { ...context, appOrigins }),
    redactor,
  })
  const report = running.run()
  const command: PageCommand = { kind: 'fill', locator: password, value: { secret: 'password' } }
  child.deliver({ type: 'command', ...child.scope, id: 1, app, command, timeoutMs: 3000 })
  const answer = await child.answer(1)
  child.deliver({ type: 'test-finished', testId: 'test', attemptId: 'attempt', status: answer.ok ? 'passed' : 'failed', assertionCount: 0, durationMs: 0 })
  await report
  running.close()
  return { answer, events, sent: JSON.stringify(child.sent) }
}

async function openWithRedactor(t: TestContext, platform: 'ios-simulator' | 'macos', screen: () => FakeElement[]): Promise<{ readonly fake: FakeInteraction; readonly redactor: Redactor }> {
  const redactor = new Redactor()
  const fake = await openFake(t, { platform, screen, redact: (text) => redactor.redact(text) })
  return { fake, redactor }
}

function inputRequests(fake: FakeInteraction): string[] {
  return fake.app.requests.filter((request) => inputRoutes.includes(request.route)).map((request) => request.route)
}

for (const [platform, app, bundle, screen] of [['ios-simulator', 'phone', phoneBundle, phoneSignIn], ['macos', 'desk', deskBundle, deskSignIn]] as const) {
  test(`${platform}: a secret is typed into the app whose bundle id secretOrigins names, and recorded by name`, async (t) => {
    const { fake, redactor } = await openWithRedactor(t, platform, screen)
    const value = freshValue()
    const filler = new SecretFiller(new Map<string, ResolvedSecret>([['password', { value }]]), declared([...appOrigins, bundle]), redactor)
    const { answer, events, sent } = await fillThroughParent(fake, app, filler, redactor)

    assert.equal(answer.ok, true, answer.ok ? '' : answer.failure.message)
    assert.equal(fake.app.find('password-field').text === value, true, 'the field holds the value the parent typed')
    assert.equal(inputRequests(fake).length > 0, true, 'the fill sent input to the executor')
    const action = events.find((event) => event.type === 'action.completed')
    assert.equal(action?.type === 'action.completed' ? action.secret : undefined, 'password', 'the fill is recorded by the secret it typed')
    assert.equal(action?.type === 'action.completed' ? action.valueLength : undefined, undefined, 'and never by the length of the text')
    assert.equal(JSON.stringify(events).includes(value), false, 'no event holds the value')
    assert.equal(sent.includes(value), false, 'nothing the child is sent holds the value')
  })

  test(`${platform}: a secret is refused, before its value is read, for an app whose bundle id secretOrigins does not name`, async (t) => {
    for (const origins of [[...appOrigins], [...appOrigins, bundle === phoneBundle ? deskBundle : phoneBundle]]) {
      const { fake, redactor } = await openWithRedactor(t, platform, screen)
      let reads = 0
      const value = freshValue()
      const source: ResolvedSecret = { read: async () => { reads += 1; return value } }
      const filler = new SecretFiller(new Map([['password', source]]), declared(origins), redactor)
      const { answer, events, sent } = await fillThroughParent(fake, app, filler, redactor)

      assert.equal(answer.ok ? undefined : answer.failure.class, 'not_actionable')
      const named = origins.filter((origin) => !origin.includes('://'))
      const permitted = named.length === 0 ? 'no native app, since secretOrigins names no bundle id for it' : named.join(', ')
      assert.equal(answer.ok ? undefined : answer.failure.message, `Retest did not type the secret "password": the app is ${bundle}, and it may be typed only into ${permitted}. Add the app's bundle id to secretOrigins if it belongs there.`)
      assert.deepEqual(answer.ok ? undefined : answer.failure.details, { bundleId: bundle })
      assert.equal(reads, 0, 'the function source was never called')
      assert.deepEqual(inputRequests(fake), [], 'no input reached the executor')
      assert.equal(fake.app.find('password-field').text, '')
      assert.equal(events.find((event) => event.type === 'action.failed')?.type, 'action.failed')
      assert.equal(sent.includes(value), false)
    }
  })
}

test('the native page refuses a resolved secret fill that names another app, and sends nothing', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const page = new NativePageAdapter(fake.interaction)
  assert.equal(page.bundleId, phoneBundle)
  for (const allowedOrigins of [undefined, [deskBundle], ['http://127.0.0.1:4310']]) {
    const answer = await page.execute({ kind: 'fill', locator: password, value: 'withheld-value', secret: 'password', ...(allowedOrigins === undefined ? {} : { allowedOrigins }) }, 2000)
    assert.equal(answer.ok ? undefined : answer.failure.class, 'unsupported')
    assert.equal(answer.ok ? undefined : answer.failure.message, `Retest typed no secret into ${phoneBundle}: a secret reaches a native app only after Retest has checked that secretOrigins names its bundle id.`)
  }
  assert.deepEqual(fake.app.requests, [], 'the executor received nothing')
})

const target: LoadedNativeTarget = { name: 'phone', platform: 'ios-simulator', appPath: '/fixture/TaskPhone.app', device: 'iPhone 17', runtime: '26.5' }
const need: ResourceNeed = { kind: 'device', name: 'iPhone 17 on 26.5', key: 'native-device', apps: ['phone'] }

function lease(): ResourceLease {
  return new ResourceLease({ request: { attemptId: 'attempt', holder: 'test', scope: 'run', position: 0, needs: [need], pastLeaseMs: 2000, releaseWithinMs: 2000, locks: new SharedLocks(), resources: new SharedLocks() }, locks: undefined, resources: undefined, sessions: undefined })
}

// A runtime over the stand-in, whose `openSession` hands over what `handover` gives, or nothing. Its executor port is
// `port`, which a test points at a listener of its own to see whether anything asks the executor there directly.
function runtimeOver(fake: FakeInteraction, handover: (() => { readonly client: ExecutorClient }) | undefined, port = 1): NativePoolRuntime {
  const identity = fake.session.identity.runtime
  if (identity.kind === 'web') throw new Error('expected a native runtime')
  return {
    identity,
    execution: fake.session.execution,
    bundle: { appPath: target.appPath, bundleId: fake.app.bundleId, executable: 'TaskPhone', sha256: 'a'.repeat(64), platforms: ['iPhoneSimulator'] },
    port,
    connected: true,
    onDisconnect: () => () => undefined,
    openSession: async () => (handover === undefined ? { ok: true, session: fake.session } : { ok: true, session: fake.session, ...handover(), executor: fake.executor }),
    close: async () => undefined,
  }
}

function pool(runtime: NativePoolRuntime): NativePool {
  const start: StartNative = async () => ({ ok: true, value: { runtime, close: async () => undefined } })
  return new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: [], redact: (text) => text, onLost: () => undefined, start })
}

// A listener standing at the runtime's executor port, answering as an executor with a different active session would.
async function decoyExecutor(t: TestContext): Promise<{ readonly port: number; readonly asked: string[] }> {
  const asked: string[] = []
  const server = createServer((request, response) => {
    asked.push(`${request.method ?? 'GET'} ${request.url ?? ''}`)
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: { ready: true }, sessionId: 'another-session' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const address = server.address()
  if (address === null || typeof address !== 'object') throw new Error('the decoy has no port')
  return { port: address.port, asked }
}

test('the native pool drives the executor session the runtime handed over and asks no executor for its active session', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', launch: false, screen: () => [{ type: 'StaticText', identifier: 'state', label: 'Open' }] })
  const decoy = await decoyExecutor(t)
  // The handed-over client's port answers nothing, so every request the interaction sends goes through the handed-over
  // session; the runtime's own port is the decoy, which nothing may ask.
  const natives = pool(runtimeOver(fake, () => ({ client: new ExecutorClient({ executor: 'webdriveragent', host: '127.0.0.1', port: 1 }) }), decoy.port))
  const ready = await natives.ensure('phone', target, { runId: 'run', testId: 'test', attemptId: 'attempt', app: 'phone' }, lease())
  assert.equal(ready.ok, true, ready.ok ? '' : ready.failure.message)
  if (!ready.ok) return
  const page = await ready.value.browser.newPage({}, 2000)
  const answer = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'state' } }, 2000)
  assert.equal(answer.ok && answer.kind === 'observe' ? answer.observation.text : null, 'Open')
  assert.deepEqual(decoy.asked, [], 'the pool never asked the executor which session is active')
  assert.equal(fake.app.on('GET /status').length, 0)
  assert.equal(fake.app.requests.some((request) => request.path.includes(`/session/${fake.app.sessionId}/`)), true, 'requests went to the session the runtime opened')
  assert.deepEqual(await natives.close(), [])
})

test('the native pool opens no interaction session on a runtime that hands over no executor session', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', launch: false, screen: () => [] })
  const decoy = await decoyExecutor(t)
  const natives = pool(runtimeOver(fake, undefined, decoy.port))
  const refused = await natives.ensure('phone', target, { runId: 'run', testId: 'test', attemptId: 'attempt', app: 'phone' }, lease())
  assert.equal(refused.ok ? undefined : refused.failure.class, 'setup_failed')
  assert.equal(refused.ok ? undefined : refused.failure.message, 'The native runtime did not hand over the executor session it opened for the app, and Retest attaches to no other.')
  assert.deepEqual(decoy.asked, [], 'nothing attached by asking the executor')
  assert.equal(fake.app.on('launch').length, 0)
  assert.deepEqual(await natives.close(), [])
})
