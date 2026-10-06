import type { NativePoolRuntime, StartNative } from '../../src/runner/native-pool.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { PageCommand } from '../../src/protocol/commands.ts'
import type { LoadedNativeTarget } from '../../src/config/loaded.ts'
import type { ResourceNeed } from '../../src/runner/resources.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as pause } from 'node:timers/promises'
import { Deadline } from '../../src/protocol/deadline.ts'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { BoundNativeInteractionSession, NativePageAdapter, NativePool } from '../../src/runner/native-pool.ts'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { acquireResources, partFree, ResourceLease } from '../../src/runner/resources.ts'
import { SharedLocks } from '../../src/runner/locks.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { validateConfig } from '../../src/config/validate.ts'
import { parse } from '../../src/protocol/schema.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { executionRecordSchema } from '../../src/protocol/execution.ts'
import { openFake } from './native-interaction-fake.ts'
import { ScriptedProcess } from '../support/scripted-process.ts'

const owner = { runId: 'run', testId: 'test', attemptId: 'attempt', app: 'phone' }
const target: LoadedNativeTarget = { name: 'phone', platform: 'ios-simulator', appPath: '/fixture/TaskPhone.app', device: 'iPhone 17', runtime: '26.5' }
const need: ResourceNeed = { kind: 'device', name: 'iPhone 17 on 26.5', key: 'native-device', apps: ['phone'] }
const budgets = { collection: 2000, setup: 2000, action: 2000, assertion: 2000, navigation: 2000, cleanup: 2000, test: 5000 }

for (const platform of ['ios-simulator', 'macos'] as const) {
  test(`the ${platform} runner page delegates a fresh native recording source with its identity`, async (t) => {
    const fake = await openFake(t, { platform, screen: () => [] })
    const { testId, attemptId, app } = fake.session.identity.owner
    const identity: RecordIdentity = { testId, attemptId, app, sessionId: fake.session.sessionId }
    const requestsBefore = fake.app.requests.length
    const delegated: RecordIdentity[] = []
    const sources: ReturnType<typeof fake.interaction.frameSource>[] = []
    const open = fake.interaction.frameSource.bind(fake.interaction)
    fake.interaction.frameSource = (record) => {
      delegated.push(record)
      const source = open(record)
      sources.push(source)
      return source
    }
    const page = new NativePageAdapter(fake.interaction)
    assert.equal(typeof page.frameSource, 'function', 'recorded native runs must receive the session frame hook')
    assert.ok(page.frameSource)
    const first = page.frameSource(identity)
    const second = page.frameSource(identity)
    assert.deepEqual(delegated, [identity, identity])
    assert.equal(first, sources[0])
    assert.equal(second, sources[1])
    assert.notEqual(first, second, 'resuming after withheld pixels must open a fresh source')
    assert.deepEqual(first.identity, identity)
    assert.equal(first.name, platform === 'macos' ? 'window-crop' : 'simulator-display')
    assert.equal(first.availability().available, true)
    assert.equal(fake.app.requests.length, requestsBefore, 'opening the hook sends no request to the app')
  })
}

function lease(needs: readonly ResourceNeed[]): ResourceLease {
  return new ResourceLease({ request: { attemptId: 'attempt', holder: 'test', scope: 'run', position: 0, needs, pastLeaseMs: 2000, releaseWithinMs: 2000, locks: new SharedLocks(), resources: new SharedLocks() }, locks: undefined, resources: undefined, sessions: undefined })
}

test('the native pool refuses startup without the matching acquired resource', async () => {
  let starts = 0
  const pool = new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: [], redact: (text) => text, onLost: () => undefined, start: async () => { starts++; return { ok: false, failure: { class: 'setup_failed', message: 'unused' } } } })
  const refused = await pool.ensure('phone', target, owner, lease([]))
  assert.equal(refused.ok, false)
  assert.equal(starts, 0)
  assert.deepEqual(await pool.close(), [])
})

test('acquisition precedes native startup, launch follows session setup, and release waits for shutdown', async (t) => {
  const order: string[] = []
  const endings: string[] = []
  const fake = await openFake(t, { platform: 'ios-simulator', launch: false, screen: () => [{ type: 'StaticText', identifier: 'state', label: 'Open' }] })
  const closed = Promise.withResolvers<void>()
  const runtime: NativePoolRuntime = {
    identity: fake.session.identity.runtime.kind === 'web' ? (() => { throw new Error('expected native') })() : fake.session.identity.runtime,
    execution: fake.session.execution,
    bundle: { appPath: '/fixture/TaskPhone.app', bundleId: fake.app.bundleId, executable: 'TaskPhone', sha256: 'a'.repeat(64), platforms: ['iPhoneSimulator'] },
    port: 0, connected: true, onDisconnect: () => () => undefined,
    openSession: async () => ({ ok: true, session: fake.session }), close: async () => undefined,
  }
  const start: StartNative = async (_target, context) => {
    order.push('start')
    assert.deepEqual(context.tools.hiddenVariables, ['WITHHELD'])
    assert.equal(context.redact('sensitive'), '{{redacted}}')
    assert.equal(fake.app.on('launch').length, 0)
    return { ok: true, value: { runtime, close: async () => { order.push('close'); await closed.promise } } }
  }
  const pool = new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: ['WITHHELD'], redact: (text) => text === 'sensitive' ? '{{redacted}}' : text, onLost: () => undefined, onEnded: (browser) => endings.push(browser.owner.app), start, interact: async () => ({ ok: true, value: fake.interaction }) })
  const acquired = await acquireResources({ attemptId: 'attempt', holder: 'test', scope: 'run', position: 0, needs: [need], pastLeaseMs: 2000, releaseWithinMs: 2000, locks: new SharedLocks(), resources: new SharedLocks(), onAcquired: () => order.push('acquired') }, new Promise(() => undefined))
  assert.equal(acquired.ok, true)
  if (!acquired.ok) return
  const ready = await pool.ensure('phone', target, owner, acquired.lease)
  assert.equal(ready.ok, true, ready.ok ? '' : ready.failure.message)
  if (!ready.ok) return
  assert.deepEqual(order, ['acquired', 'start'])
  assert.equal(fake.app.running, false, 'opening and installing do not launch the app')
  const page = await ready.value.browser.newPage({}, 2000)
  assert.equal(fake.app.running, true)
  const answer = await page.execute({ kind: 'observe', locator: { by: 'testId', value: 'state' } }, 2000)
  assert.equal(answer.ok && answer.kind === 'observe' ? answer.observation.text : null, 'Open')
  let free = false
  const release = partFree(need, new Map([['phone', pool.held(ready.value.browser)]]))?.then(() => { free = true })
  await nextTurn()
  assert.equal(free, false)
  closed.resolve()
  await release
  assert.equal(fake.app.running, false)
  assert.equal(free, true)
  assert.deepEqual(endings, ['phone'])
  assert.deepEqual(await pool.close(), [])
  await acquired.lease.release({ whenFree: () => undefined, giveBackSessions: () => true, ending: false })
})

test('native launch validation refuses owned switches and malformed settings without quoting values', () => {
  for (const launch of [ { arguments: ['--remote-debugging-port=sensitive'] }, { environment: { NODE_OPTIONS: 'sensitive' } }, { arguments: ['ok', { value: 'sensitive' }] }, { environment: 'sensitive' } ]) {
    const result = validateConfig({ apps: { phone: { platform: target.platform, appPath: target.appPath, device: target.device, runtime: target.runtime, ...launch } } }, '/work/retest.config.ts')
    assert.equal(result.ok, false)
    if (!result.ok) assert.ok(!result.failure.message.includes('sensitive'))
  }
})

test('the runner native session refuses changed launch settings and records an unexpected app end', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', launch: false, screen: () => [] })
  const session = new BoundNativeInteractionSession({ session: fake.session, client: new ExecutorClient({ executor: 'webdriveragent', host: '127.0.0.1', port: 1 }), executor: fake.executor, redact: (text) => text, processes: async () => ({ ok: true, running: fake.app.running, pids: fake.app.running ? [fake.app.pid] : [] }) }, { arguments: [], environment: {} })
  const refused = await session.launch(2000, undefined, { arguments: ['sensitive'], environment: {} })
  assert.equal(refused.result.ok ? undefined : refused.result.failure.class, 'unsupported')
  assert.equal(refused.input, 'not_sent')
  assert.equal(fake.app.on('launch').length, 0)
  assert.ok(!JSON.stringify(refused).includes('sensitive'))
  assert.equal((await session.launch(2000, undefined, { arguments: [], environment: {} })).result.ok, true)
  assert.deepEqual(await session.appState(2000), { ok: true, state: 'foreground', endedUnexpectedly: false })
  fake.app.running = false
  assert.deepEqual(await session.appState(2000), { ok: true, state: 'not_running', endedUnexpectedly: true })
  await session.dispose(2000)
})

test('parent native checks preserve failure, selected state and identity against a forged verdict', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'Button', identifier: 'task', label: 'Open', selected: false, frame: { x: 20, y: 100, width: 120, height: 40 } }] })
  const page = new NativePageAdapter(fake.interaction)
  const process = new ScriptedProcess()
  const events: EventBody[] = []
  const running = new RunningTest({ process, pages: new Map([['phone', page]]), testId: 'test', attemptId: 'attempt', timeouts: budgets, emit: (event) => events.push(event) })
  const report = running.run()
  const send = (id: number, command: PageCommand) => { process.deliver({ type: 'command', ...process.scope, id, app: 'phone', command, timeoutMs: 2000 }); return process.answer(id) }
  const recipe = { by: 'testId', value: 'task' } as const
  const observed = await send(1, { kind: 'observe', locator: recipe })
  assert.equal(observed.ok && observed.kind === 'observe' ? observed.sessionId : undefined, 'attempt:phone')
  if (!observed.ok || observed.kind !== 'observe') throw new Error('no observation')
  process.deliver({ type: 'event', event: { type: 'assertion.passed', testId: 'test', attemptId: 'attempt', session: 'phone', observationId: observed.observationId, sessionId: observed.sessionId, locator: recipe, matcher: 'toBeSelected', check: { matcher: 'toBeSelected' }, attempts: 1, expected: null, actual: null, durationMs: 1 } })
  process.deliver({ type: 'test-finished', testId: 'test', attemptId: 'attempt', status: 'passed', assertionCount: 1, durationMs: 0 })
  const ended = await report
  assert.equal(ended.observed?.[0]?.class, 'check_failed')
  assert.match(ended.observed?.[0]?.message ?? '', /task.*not selected/)
  const failed = events.find((event) => event.type === 'assertion.failed')
  assert.equal(failed?.type === 'assertion.failed' ? failed.sessionId : undefined, 'attempt:phone')
  const look = events.find((event) => event.type === 'observation')
  assert.equal(look?.type === 'observation' ? look.native?.selected : undefined, false)
  for (const [index, event] of events.entries()) assert.equal(parse(retestEventSchema, { schemaVersion: 1, runId: 'run', sequence: index + 1, time: new Date().toISOString(), elapsedMs: 1, origin: 'parent', ...event }).ok, true)
  running.close()
})

test('forged web actions and native secret input reach no executor input route', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'TextField', identifier: 'account', text: '' }] })
  const page = new NativePageAdapter(fake.interaction)
  const refused = await page.execute({ kind: 'goto', url: 'https://example.test/' }, 2000)
  assert.equal(refused.ok ? undefined : refused.failure.class, 'unsupported')
  const fill = await page.execute({ kind: 'fill', locator: { by: 'testId', value: 'account' }, value: 'withheld', secret: 'credential' }, 2000)
  assert.equal(fill.ok ? undefined : fill.failure.class, 'unsupported')
  assert.equal(fake.app.requests.length, 0)
})

test('native execution records retain the app, operating system, executor pin and Xcode', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', launch: false, screen: () => [] })
  const record = { configuration: { sha256: 'a'.repeat(64), settings: { apps: {}, timeouts: budgets, locks: [], diagnostics: { capture: false, limits: {} } } }, runtime: { retest: 'test', node: process.version, platform: process.platform }, sessions: [{ app: 'phone', sessionId: 'attempt:phone', engine: 'ios-simulator', product: 'TaskPhone', version: '1', resource: 'device', native: fake.session.execution }], startingState: [{ app: 'phone', browserStorage: 'none', backendData: 'external', native: { appData: 'reset', keychain: 'reset', boundary: 'fresh simulator', notIsolated: ['backend'] } }] }
  const parsed = parse(executionRecordSchema, record)
  assert.equal(parsed.ok, true, parsed.ok ? '' : JSON.stringify(parsed.issues))
  if (parsed.ok) assert.deepEqual(parsed.value.sessions[0]?.native, fake.session.execution)
  // Every app says what browser storage it started from, a native app that it has none, so a reader never meets a gap.
  const { browserStorage: _storage, ...withoutStorage } = record.startingState[0] ?? { browserStorage: 'none' }
  assert.equal(parse(executionRecordSchema, { ...record, startingState: [withoutStorage] }).ok, false)
})

test('an uncertain native start keeps its resource reserved and reports cleanup uncertainty', async () => {
  let starts = 0
  const pool = new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: [], redact: (text) => text, onLost: () => undefined, start: async () => { starts++; throw new Error('start lost its answer') } })
  assert.equal((await pool.ensure('phone', target, owner, lease([need]))).ok, false)
  let free = false
  void pool.heldApp('attempt', 'phone')?.whenFree?.().then(() => { free = true })
  await nextTurn()
  assert.equal(free, false)
  const secondNeed = { ...need, apps: ['other'] }
  assert.equal((await pool.ensure('other', target, { ...owner, app: 'other' }, lease([secondNeed]))).ok, false)
  assert.equal(starts, 1, 'an uncertain start is never followed by another runtime on that resource')
  assert.match((await pool.close())[0]?.message ?? '', /could not prove.*ended/)
})

test('a native start that proves it launched nothing releases its held part', async () => {
  const pool = new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: [], redact: (text) => text, onLost: () => undefined, start: async () => ({ ok: false, idle: true, failure: { class: 'setup_failed', message: 'no launch' } }) })
  assert.equal((await pool.ensure('phone', target, owner, lease([need]))).ok, false)
  const free = partFree(need, new Map([['phone', pool.heldApp('attempt', 'phone') ?? {}]]))
  assert.ok(free !== undefined)
  await free
  assert.deepEqual(await pool.close(), [])
})

test('native cancellation preserves a dispatched unknown outcome and prevents another action', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'Button', identifier: 'save', label: 'Save', frame: { x: 20, y: 100, width: 120, height: 40 } }] })
  const route = 'POST /session/:session/element/:element/click'
  fake.app.behaviours.set(route, { hang: true })
  const page = new NativePageAdapter(fake.interaction)
  const child = new ScriptedProcess()
  const events: EventBody[] = []
  const running = new RunningTest({ process: child, pages: new Map([['phone', page]]), testId: 'test', attemptId: 'attempt', timeouts: budgets, emit: (event) => events.push(event) })
  const report = running.run()
  child.deliver({ type: 'command', ...child.scope, id: 1, app: 'phone', command: { kind: 'tap', locator: { by: 'testId', value: 'save' } }, timeoutMs: 2000 })
  const deadline = new Deadline(2000)
  while (fake.app.on(route).length === 0 && !deadline.expired) await pause(1)
  assert.equal(fake.app.on(route).length, 1, 'the executor received the request before revocation')
  running.revoke({ class: 'interrupted', message: 'stopped by the parent' }, 0)
  await report
  await running.settle(2000)
  await fake.interaction.reconcile(2000)
  assert.equal(fake.interaction.unknownOutcomes.length, 1)
  const outcome = fake.interaction.unknownOutcomes[0]
  assert.equal(outcome?.source === 'input' ? outcome.outcome.input : undefined, 'unknown')
  assert.equal(outcome?.source === 'input' ? outcome.outcome.route : undefined, route)
  assert.equal(page.recordedOutcomes[0]?.input, 'unknown')
  assert.equal(page.recordedOutcomes[0]?.generation, 1)
  const refused = await page.execute({ kind: 'tap', locator: { by: 'testId', value: 'save' } }, 2000)
  assert.equal(refused.ok, false)
  assert.equal(fake.app.on(route).length, 1, 'a dispatch that may have gone is never resent')
  assert.equal(events.filter((event) => event.type === 'action.failed').length, 1)
  running.close()
})

test('native assertions reject a reference from a launch that ended', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'StaticText', identifier: 'state', label: 'Open' }] })
  const child = new ScriptedProcess()
  const events: EventBody[] = []
  const running = new RunningTest({ process: child, pages: new Map([['phone', new NativePageAdapter(fake.interaction)]]), testId: 'test', attemptId: 'attempt', timeouts: budgets, emit: (event) => events.push(event) })
  const report = running.run()
  const recipe = { by: 'testId', value: 'state' } as const
  child.deliver({ type: 'command', ...child.scope, id: 1, app: 'phone', command: { kind: 'observe', locator: recipe }, timeoutMs: 2000 })
  const answer = await child.answer(1)
  if (!answer.ok || answer.kind !== 'observe') throw new Error('no native observation')
  await fake.interaction.terminate(2000)
  child.deliver({ type: 'event', event: { type: 'assertion.passed', testId: 'test', attemptId: 'attempt', session: 'phone', observationId: answer.observationId, sessionId: answer.sessionId, locator: recipe, matcher: 'toHaveText', check: { matcher: 'toHaveText', text: 'Open' }, attempts: 1, expected: null, actual: null, durationMs: 1 } })
  child.deliver({ type: 'test-finished', testId: 'test', attemptId: 'attempt', status: 'passed', assertionCount: 1, durationMs: 0 })
  const ended = await report
  assert.equal(ended.observed?.[0]?.details?.['stale'], true)
  assert.equal(events.filter((event) => event.type === 'assertion.passed').length, 0)
  running.close()
})

test('bundle destinations are native secret origins; a web-only config still requires HTTP origins', () => {
  const value = { secrets: { password: { env: 'WITHHELD' } }, secretOrigins: { password: ['dev.retest.fixtures.taskphone'] } }
  const native = validateConfig({ ...value, apps: { phone: { platform: target.platform, appPath: target.appPath, device: target.device, runtime: target.runtime } } }, '/work/retest.config.ts')
  assert.equal(native.ok, true, native.ok ? '' : native.failure.message)
  if (native.ok) assert.deepEqual(native.config.secrets.get('password')?.origins, ['dev.retest.fixtures.taskphone'])
  const web = validateConfig({ ...value, apps: { web: { browser: 'chrome' } } }, '/work/retest.config.ts')
  assert.equal(web.ok, false)
})

test('the parent refuses a forged second action or look while native input is in flight', async (t) => {
  const fake = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'Button', identifier: 'save', label: 'Save', frame: { x: 20, y: 100, width: 120, height: 40 } }] })
  const route = 'POST /session/:session/element/:element/click'
  fake.app.behaviours.set(route, { delayMs: 100 })
  const child = new ScriptedProcess()
  const running = new RunningTest({ process: child, pages: new Map([['phone', new NativePageAdapter(fake.interaction)]]), testId: 'test', attemptId: 'attempt', timeouts: budgets, emit: () => undefined })
  const report = running.run()
  const locator = { by: 'testId', value: 'save' } as const
  child.deliver({ type: 'command', ...child.scope, id: 1, app: 'phone', command: { kind: 'tap', locator }, timeoutMs: 2000 })
  const deadline = new Deadline(2000)
  while (fake.app.on(route).length === 0 && !deadline.expired) await pause(1)
  assert.equal(fake.app.on(route).length, 1)
  for (const [id, kind] of [[2, 'tap'], [3, 'observe']] as const) {
    child.deliver({ type: 'command', ...child.scope, id, app: 'phone', command: { kind, locator }, timeoutMs: 2000 })
    const answer = await child.answer(id)
    assert.equal(answer.ok ? undefined : answer.failure.class, 'concurrent_commands')
  }
  assert.equal((await child.answer(1)).ok, true)
  child.deliver({ type: 'test-finished', testId: 'test', attemptId: 'attempt', status: 'passed', assertionCount: 0, durationMs: 0 })
  assert.deepEqual((await report).observed?.map((problem) => problem.class), ['concurrent_commands', 'concurrent_commands'])
  assert.equal(fake.app.on(route).length, 1)
  running.close()
})
