import type { DiagnosticCollection } from '../../src/diagnostics/observations.ts'
import type { LaunchBrowser } from '../../src/runner/browser-pool.ts'
import type { EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { PageCommand } from '../../src/protocol/commands.ts'
import type { NewPageOptions } from '../../src/browser/contract.ts'
import type { FakePage } from '../support/fake-browser.ts'
import type { TestContext } from 'node:test'
import type { LoadedNativeTarget } from '../../src/config/loaded.ts'
import type { ExecutorBuild } from '../../src/native/executors.ts'
import type { NativePoolRuntime, NativeRuntimeStarters } from '../../src/runner/native-pool.ts'
import type { ResourceNeed } from '../../src/runner/resources.ts'
import type { PagesContext } from '../../src/runner/test-pages.ts'
import type { SecretFillContext } from '../../src/runner/running-test.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { describeCommand } from '../../src/protocol/commands.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { parse } from '../../src/protocol/schema.ts'
import { NativePageAdapter, NativePool, startBuilt } from '../../src/runner/native-pool.ts'
import { partFree, ResourceLease } from '../../src/runner/resources.ts'
import { SharedLocks } from '../../src/runner/locks.ts'
import { openPage, screenshotSource } from '../../src/runner/test-pages.ts'
import { captureSourceNameSchema } from '../../src/protocol/identity.ts'
import { NativeError } from '../../src/native/session.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { runFiles } from '../../src/runner/run.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { SessionBudget } from '../../src/runner/sessions.ts'
import { FakeBrowser } from '../support/fake-browser.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents, runSupportFiles } from '../support/run-harness.ts'
import { ScriptedProcess, scriptedTest } from '../support/scripted-process.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { openFake } from './native-interaction-fake.ts'
import { standInRun } from './runner-native-stand-in.ts'

const budgets = { collection: 2000, setup: 2000, action: 2000, assertion: 2000, navigation: 2000, cleanup: 2000, test: 5000 }
const stateScreen = () => [{ type: 'StaticText', identifier: 'state', label: 'Open', frame: { x: 16, y: 360, width: 200, height: 20 } }]
const wrongState = `import { expect, test } from '@rehearsal-labs/retest'

test('checks a state the app never shows', { apps: ['phone'] }, async ({ phone }) => {
  await expect(phone.getByTestId('state')).toHaveText('Done', { timeout: 300 })
})
`

describe('a native app whose page and runtime will not close', () => {
  test('gives its sessions back when the run ends, says so, and counts the failed close once', { timeout: 60_000 }, async (t) => {
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const run = await standInRun(t, {
      // The device stays held for the process once its app could not be closed, so no other test here uses it.
      device: 'iPhone 17 left held',
      screen: stateScreen,
      tests: wrongState,
      // The executor never ends its session, so the app's page does not close within the cleanup budget.
      prepare: (app) => app.behaviours.set('DELETE /session/:session', { hang: true }),
      closeRuntime: async () => {
        throw new Error('Reading the processes timed out.')
      },
      options: { sessions: { owner: 'agent-1', budget, waitMs: 2000 } },
    })
    const [result] = run.result.files.flatMap((file) => file.tests)
    assert.deepEqual([result?.status, result?.failure?.class], ['failed', 'check_failed'])
    assert.ok(result?.cleanupFailures?.some((each) => each.message.startsWith('Closing the native app phone:')), JSON.stringify(result?.cleanupFailures))
    const released = run.events.filter((event) => event.type === 'session.released')
    assert.deepEqual(released.map((event) => event.type === 'session.released' ? [event.sessions, event.after] : []), [[1, 'run_ended']], 'the held session came back at the end of the run, and the event says how')
    assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 }, 'a budget that outlives the run lost nothing')
    assert.equal(run.result.failure, undefined, 'the close the attempt already recorded is not reported again as a failure of the run')
    assert.equal(run.result.exitCode, 1, 'the app failed a check, and one failed close is not counted twice')
    const started = run.events.find((event) => event.type === 'test.started')
    assert.deepEqual(started?.type === 'test.started' ? started.execution?.startingState.map((each) => [each.app, each.browserStorage]) : undefined, [['phone', 'none']], 'a native app says it has no browser storage')
  })
})

describe('the native page adapter', () => {
  test('refuses the first-run keyboard card on macOS by name, before anything is read or pressed', { timeout: 60_000 }, async (t) => {
    const fake = await openFake(t, { platform: 'macos', screen: stateScreen })
    const page = new NativePageAdapter(fake.interaction)
    const refused = await page.execute({ kind: 'nativeKeyboard', operation: 'dismissFirstRunCard' }, 2000)
    assert.deepEqual([refused.ok, refused.ok ? undefined : refused.failure.class], [false, 'unsupported'])
    assert.match(refused.ok ? '' : refused.failure.message, /first-run keyboard card is an iOS screen/)
    assert.deepEqual(fake.app.requests, [], 'nothing reached the executor')
  })
})

describe('native keyboard, alert and swipe calls in the record', () => {
  test("an alert's description names the button the test wrote", () => {
    assert.equal(describeCommand({ kind: 'nativeAlert', operation: 'accept', button: 'Allow' }), "page.alert.accept('Allow')")
    assert.equal(describeCommand({ kind: 'nativeAlert', operation: 'dismiss' }), 'page.alert.dismiss()')
  })

  test('each action event says which way a swipe went, what a keyboard or alert call did and which button it pressed', { timeout: 60_000 }, async (t) => {
    const fake = await openFake(t, { platform: 'ios-simulator', screen: stateScreen })
    const process = new ScriptedProcess()
    const events: EventBody[] = []
    const running = new RunningTest({ process, pages: new Map([['phone', new NativePageAdapter(fake.interaction)]]), testId: 'test', attemptId: 'attempt', timeouts: budgets, emit: (event) => events.push(event) })
    const report = running.run()
    const commands: PageCommand[] = [
      { kind: 'swipe', direction: 'left' },
      { kind: 'nativeKeyboard', operation: 'wait' },
      { kind: 'nativeKeyboard', operation: 'dismiss' },
      { kind: 'nativeAlert', operation: 'accept', button: 'Allow' },
    ]
    for (const [index, command] of commands.entries()) {
      process.deliver({ type: 'command', ...process.scope, id: index + 1, app: 'phone', command, timeoutMs: 1000 })
      await process.answer(index + 1)
    }
    process.deliver({ type: 'test-finished', testId: 'test', attemptId: 'attempt', status: 'passed', assertionCount: 0, durationMs: 0 })
    await report
    await running.settle(1000)
    running.close()
    const actions = events.filter((event) => event.type === 'action.completed' || event.type === 'action.failed')
    assert.deepEqual(actions.map((event) => [event.command, event.direction, event.operation, event.button]), [
      ['swipe', 'left', undefined, undefined],
      ['nativeKeyboard', undefined, 'wait', undefined],
      ['nativeKeyboard', undefined, 'dismiss', undefined],
      ['nativeAlert', undefined, 'accept', 'Allow'],
    ])
    for (const [index, event] of actions.entries()) assert.equal(parse(retestEventSchema, { schemaVersion: 1, runId: 'run', sequence: index + 1, time: new Date().toISOString(), elapsedMs: 1, origin: 'parent', ...event }).ok, true)
  })
})

describe('a run stopped while its pages start their diagnostics', () => {
  test('closes its pages before it gives their sessions back', { timeout: 60_000 }, async () => {
    const config = `import { chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173' }) } })
`
    const root = tempProject({ [configFileName]: config, 'tests/a.retest.ts': `import { test } from '@rehearsal-labs/retest'\n\ntest('never starts', async () => {})\n` })
    const loaded = await loadConfig(join(root, configFileName))
    assert.ok(loaded.ok)
    const secrets = resolveSecrets(loaded.config, {})
    assert.ok(secrets.ok)
    const starting = Promise.withResolvers<void>()
    const pages: FakePage[] = []
    // A page whose diagnostics never start, so the run is stopped while it waits for them.
    class SlowCapture extends FakeBrowser {
      override async newPage(options: NewPageOptions, timeoutMs: number): Promise<FakePage> {
        const page = await super.newPage(options, timeoutMs)
        pages.push(page)
        return Object.assign(page, {
          collectDiagnostics: (): Promise<DiagnosticCollection> => {
            starting.resolve()
            return new Promise<DiagnosticCollection>(() => undefined)
          },
        })
      }
    }
    const launch: LaunchBrowser = async (launchOptions) => new SlowCapture({}, launchOptions)
    const stop = new AbortController()
    void starting.promise.then(() => stop.abort('SIGINT'))
    const openAtRelease: boolean[] = []
    const watcher = { name: 'watcher', onEvent: (event: RetestEvent) => { if (event.type === 'session.released') openAtRelease.push(...pages.map((page) => !page.disposed)) }, onRunEnd: () => undefined }
    const folder = newRunFolder()
    const budget = new SessionBudget({ perOwner: 1, host: 1 })
    const result = await runFiles({ files: ['tests/a.retest.ts'], rootDir: root, apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets }, timeouts: { ...quickTimeouts, setup: 5000 }, outputDir: folder, headless: true, workers: 1, signal: stop.signal, lastRunFile: false, sessions: { owner: 'agent-1', budget, waitMs: 2000 } }, [watcher], launch, fakeExecutable)
    assert.equal(result.exitCode, 130)
    assert.equal(pages.length, 1)
    assert.deepEqual(openAtRelease, [false], 'the context was closed before its session went back')
    const released = readEvents(folder).events.filter((event) => event.type === 'session.released')
    assert.deepEqual(released.map((event) => event.type === 'session.released' ? event.after : undefined), ['contexts_closed'])
    assert.deepEqual(budget.snapshot(), { host: 0, owners: new Map(), waiting: 0 })
  })
})

describe('a declared native network file', () => {
  const need: ResourceNeed = { kind: 'device', name: 'iPhone 17 on 26.5', key: 'native-device', apps: ['phone'] }
  const leaseFor = (attemptId: string): ResourceLease => new ResourceLease({ request: { attemptId, holder: 'test', scope: 'run', position: 0, needs: [need], pastLeaseMs: 2000, releaseWithinMs: 2000, locks: new SharedLocks(), resources: new SharedLocks() }, locks: undefined, resources: undefined, sessions: undefined })

  async function poolFor(t: TestContext): Promise<NativePool> {
    const fake = await openFake(t, { platform: 'ios-simulator', launch: false, screen: () => [] })
    const runtime: NativePoolRuntime = {
      identity: { kind: 'ios-simulator', bundleId: fake.app.bundleId, appPath: '/fixture/TaskPhone.app', device: 'iPhone 17', runtime: '26.5', processIds: [] },
      execution: fake.session.execution,
      bundle: { appPath: '/fixture/TaskPhone.app', bundleId: fake.app.bundleId, executable: 'TaskPhone', sha256: 'a'.repeat(64), platforms: ['iPhoneSimulator'] },
      port: 0, connected: true, onDisconnect: () => () => undefined,
      openSession: async () => ({ ok: true, session: fake.session }), close: async () => undefined,
    }
    return new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: [], redact: (text) => text, onLost: () => undefined, start: async () => ({ ok: true, value: { runtime, close: async () => undefined } }), interact: async () => ({ ok: true, value: fake.interaction }) })
  }

  test('is held by one run at a time, so two runs never read one file for one client together', { timeout: 60_000, skip: process.platform === 'darwin' ? false : 'native apps and lockf run only on a Mac' }, async (t) => {
    const folder = tempFolder('native-network-lock-')
    const target: LoadedNativeTarget = { name: 'phone', platform: 'ios-simulator', appPath: '/fixture/TaskPhone.app', device: 'iPhone 17', runtime: '26.5', diagnostics: { logs: 'none', network: { path: join(folder, 'network.jsonl'), client: 'ios' } } }
    const first = await poolFor(t)
    const second = await poolFor(t)
    const owner = { runId: 'run', testId: 'test', attemptId: 'a1', app: 'phone' }
    const held = await first.ensure('phone', target, owner, leaseFor('a1'))
    assert.equal(held.ok, true, held.ok ? '' : held.failure.message)
    const refused = await second.ensure('phone', target, { ...owner, attemptId: 'a2' }, leaseFor('a2'))
    assert.deepEqual([refused.ok, refused.ok ? undefined : refused.failure.class], [false, 'setup_failed'])
    assert.match(refused.ok ? '' : refused.failure.message, /^Another run reads the network file .*network\.jsonl for its native app/)
    assert.deepEqual(await first.close(), [])
    const third = await (await poolFor(t)).ensure('phone', target, { ...owner, attemptId: 'a3' }, leaseFor('a3'))
    assert.equal(third.ok, true, 'once the first run let the file go, another may read it')
    if (third.ok) await third.value.browser.close(2000)
    await second.close()
  })
})

describe("a native app's diagnostics scope", () => {
  test('a target that keeps no log covers no console, and says so in its scope and its summary alike', { timeout: 60_000 }, async (t) => {
    const run = await standInRun(t, {
      screen: stateScreen,
      tests: `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('reads the state', { apps: ['phone'] }, async ({ phone }) => {\n  await expect(phone.getByTestId('state')).toHaveText('Open')\n})\n`,
    })
    assert.equal(run.result.exitCode, 0, JSON.stringify(run.result.files))
    const started = run.events.find((event) => event.type === 'diagnostics.started')
    assert.deepEqual(started?.type === 'diagnostics.started' ? started.scope.console : undefined, { covered: [], notCovered: ['owned_process'] })
    const finished = run.events.find((event) => event.type === 'diagnostics.finished')
    assert.equal(finished?.type === 'diagnostics.finished' ? finished.diagnostics.console.state : undefined, 'unavailable')
  })
})

describe('a page that could not be opened', () => {
  const context = (): PagesContext => ({ store: RunStore.create(newRunFolder()), timeouts: budgets, stopped: new Promise(() => undefined), interruption: () => undefined, connected: () => true, release: () => undefined, named: true, emit: () => undefined, redact: (text) => text, testId: 'test', attemptId: 'attempt' })
  // A browser whose new page fails with the native error it is given.
  const failing = (error: Error): FakeBrowser => {
    class Refusing extends FakeBrowser {
      override async newPage(): Promise<FakePage> {
        throw error
      }
    }
    return new Refusing({}, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
  }

  for (const kept of ['outcome_unknown', 'cleanup_failed', 'unsupported'] as const) {
    test(`keeps a native launch's ${kept} rather than reading as a plain setup failure`, { timeout: 60_000 }, async () => {
      const opened = await openPage(context(), failing(new NativeError({ class: kept, message: 'The launch may have happened.' })), {})
      assert.deepEqual([opened.ok, opened.ok ? undefined : opened.failure.class], [false, kept])
      assert.match(opened.ok ? '' : opened.failure.message, /The launch may have happened\./)
    })
  }

  test('any other native failure stays a setup failure', { timeout: 60_000 }, async () => {
    const opened = await openPage(context(), failing(new NativeError({ class: 'not_actionable', message: 'A copy of the app is running.' })), {})
    assert.equal(opened.ok ? undefined : opened.failure.class, 'setup_failed')
  })
})

describe('a native runtime that refuses to start', () => {
  const deskNeed: ResourceNeed = { kind: 'desktop', name: 'macos', key: 'macos', apps: ['desk'] }
  const deskTarget: LoadedNativeTarget = { name: 'macos', platform: 'macos', appPath: '/fixture/TaskDesk.app' }
  const build: ExecutorBuild = { schemaVersion: 1, executor: 'mac2', version: '0', commit: '0'.repeat(40), key: 'k', xcode: { version: '26.5', build: 'fake' }, sdk: 'macosx', architecture: 'arm64', origin: 'adopted', derivedDataPath: '/unused', xctestrun: '/unused', products: '/unused', productsSha256: 'a'.repeat(64), xctestrunSha256: 'b'.repeat(64), recordedAt: '2026-10-05T00:00:00.000Z', licenses: [], notices: [] }
  const refusal = { class: 'setup_failed' as const, message: "Another Retest process drives this Mac's desktop." }
  const leaseOn = (attemptId: string): ResourceLease => new ResourceLease({ request: { attemptId, holder: 'test', scope: 'run', position: 0, needs: [deskNeed], pastLeaseMs: 2000, releaseWithinMs: 2000, locks: new SharedLocks(), resources: new SharedLocks() }, locks: undefined, resources: undefined, sessions: undefined })

  test('a proved-cleaned iOS start keeps its failure and frees the device through the built-runtime adapter', async () => {
    const phoneNeed: ResourceNeed = { kind: 'device', name: 'cleaned boot', key: 'cleaned-boot', apps: ['phone'] }
    const phoneTarget: LoadedNativeTarget = { name: 'phone', platform: 'ios-simulator', appPath: '/fixture/TaskPhone.app', device: 'iPhone 17', runtime: '26.5' }
    const leaseOnPhone = (attemptId: string): ResourceLease => new ResourceLease({ request: { attemptId, holder: 'test', scope: 'run', position: 0, needs: [phoneNeed], pastLeaseMs: 2000, releaseWithinMs: 2000, locks: new SharedLocks(), resources: new SharedLocks() }, locks: undefined, resources: undefined, sessions: undefined })
    let starts = 0
    const bootFailure = { class: 'setup_failed' as const, message: 'Bootstatus refused after its process ended.' }
    const starters: NativeRuntimeStarters = { ios: async () => { starts++; return { ok: false, failure: bootFailure, cleaned: true } }, macos: async () => { throw new Error('no desktop start expected') } }
    const pool = new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: [], redact: text => text, onLost: () => undefined, start: (target, context) => startBuilt(target, context, { ...build, executor: 'webdriveragent', sdk: 'iphonesimulator' }, starters) })
    const owner = { runId: 'run', testId: 'test', attemptId: 'cleaned-1', app: 'phone' }
    const first = await pool.ensure('phone', phoneTarget, owner, leaseOnPhone(owner.attemptId))
    assert.equal(first.ok, false)
    assert.equal(first.ok ? undefined : first.failure, bootFailure, 'cleanup cannot soften the original boot failure')
    let freed = false
    void pool.heldApp(owner.attemptId, 'phone')?.whenFree?.().then(() => { freed = true })
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(freed, true, 'the proved-cleaned start releases the lease without waiting for expiry')
    await pool.ensure('phone', phoneTarget, { ...owner, attemptId: 'cleaned-2' }, leaseOnPhone('cleaned-2'))
    assert.equal(starts, 2)
    assert.deepEqual(await pool.close(), [])
  })

  function poolStarting(answer: { ok: false; failure: typeof refusal; idle?: true }): { pool: NativePool; starts: () => number } {
    let starts = 0
    const starters: NativeRuntimeStarters = { ios: async () => answer, macos: async () => { starts++; return answer } }
    const pool = new NativePool({ logFolder: () => '/unused', setupMs: 2000, cleanupMs: 2000, signal: new AbortController().signal, hiddenVariables: [], redact: (text) => text, onLost: () => undefined, start: (target, context) => startBuilt(target, context, build, starters) })
    return { pool, starts: () => starts }
  }

  test('frees the desktop when the refusal says it started nothing, so the next attempt may start it again and the run ends clean', { timeout: 60_000 }, async () => {
    const { pool, starts } = poolStarting({ ok: false, failure: refusal, idle: true })
    const owner = { runId: 'run', testId: 'test', attemptId: 'a1', app: 'desk' }
    const first = await pool.ensure('desk', deskTarget, owner, leaseOn('a1'))
    assert.equal(first.ok ? undefined : first.failure.message, refusal.message)
    const free = partFree(deskNeed, new Map([['desk', pool.heldApp('a1', 'desk') ?? {}]]))
    assert.ok(free !== undefined)
    await free
    await pool.ensure('desk', deskTarget, { ...owner, attemptId: 'a2' }, leaseOn('a2'))
    assert.equal(starts(), 2, 'the second attempt was not kept behind a start that launched nothing')
    assert.deepEqual(await pool.close(), [])
  })

  test('keeps the desktop held when the refusal does not say it started nothing', { timeout: 60_000 }, async () => {
    const { pool, starts } = poolStarting({ ok: false, failure: refusal })
    const owner = { runId: 'run', testId: 'test', attemptId: 'a1', app: 'desk' }
    assert.equal((await pool.ensure('desk', deskTarget, owner, leaseOn('a1'))).ok, false)
    await pool.ensure('desk', deskTarget, { ...owner, attemptId: 'a2' }, leaseOn('a2'))
    assert.equal(starts(), 1, 'no second runtime starts behind an uncertain one')
    assert.match((await pool.close())[0]?.message ?? '', /could not prove the native start/)
  })
})

describe("what took a page's screenshot", () => {
  test("each web engine's page names its own protocol's capture, and a native session names its own source", () => {
    const web = (engine: 'chromium' | 'firefox' | 'webkit') => ({ kind: 'web' as const, engine, product: engine, version: '1', executablePath: `/fake/${engine}`, processIds: [] })
    assert.deepEqual((['chromium', 'firefox', 'webkit'] as const).map((engine) => screenshotSource(web(engine))), ['chromium', 'firefox', 'webkit'])
    for (const name of ['firefox', 'webkit']) assert.equal(parse(captureSourceNameSchema, name).ok, true)
  })
})

describe('a secret fill', () => {
  test("names the app whose page takes it, so the run can hold an Electron app's window to secretOrigins alone", { timeout: 60_000 }, async () => {
    const seen: SecretFillContext[] = []
    const run = await scriptedTest({ fillSecret: async (_command, context) => { seen.push(context); return { ok: false, failure: { class: 'not_actionable', message: 'refused here' } } } })
    await run.command(1, { kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: { secret: 'password' } })
    await run.finish()
    assert.deepEqual(seen.map((context) => context.app), ['page'])
  })
})

describe('browser.started', () => {
  test('names the engine that ran the browser, and takes a build only as a string the driver read', { timeout: 60_000 }, async () => {
    const record = await runSupportFiles(['output.retest.ts'])
    const started = record.events.filter((event) => event.type === 'browser.started')
    assert.deepEqual(started.map((event) => event.type === 'browser.started' ? [event.engine, event.build] : []), [['chromium', undefined]], 'the fake browser is no driver of Retest, so no build is claimed for it')
    const base = { schemaVersion: 1, runId: 'run', sequence: 1, time: new Date().toISOString(), elapsedMs: 1, origin: 'parent', type: 'browser.started', product: 'Firefox', version: '133.0.3', userAgent: '', pid: 4242, executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox' }
    assert.equal(parse(retestEventSchema, { ...base, engine: 'firefox', build: '20241209150345' }).ok, true)
    assert.equal(parse(retestEventSchema, { ...base, engine: 'gecko' }).ok, false)
    assert.equal(parse(retestEventSchema, { ...base, build: 20241209150345 }).ok, false)
  })
})

describe('a table row found by its name on a web page', () => {
  const namedRow = { by: 'role', role: 'row', name: 'Grace Hopper grace@example.com Engineer 3' } as const
  const cases: { label: string; command: PageCommand }[] = [
    { label: 'a look', command: { kind: 'observe', locator: namedRow } },
    { label: 'a click', command: { kind: 'click', locator: namedRow } },
    { label: 'a look inside the row', command: { kind: 'observe', locator: { by: 'testId', value: 'team', within: [namedRow] } } },
  ]
  for (const { label, command } of cases) {
    test(`is refused before the page is asked, as unsupported, for ${label}`, { timeout: 60_000 }, async () => {
      const seen: string[] = []
      const run = await scriptedTest({ fake: { onCommand: (sent) => seen.push(sent.kind) } })
      const answer = await run.command(1, command)
      const report = await run.finish()
      assert.equal(answer.ok ? undefined : answer.failure.class, 'unsupported')
      assert.match(answer.ok ? '' : answer.failure.message, /gives a table row no name from its cells/)
      assert.deepEqual(seen, [], 'nothing reached the page')
      assert.deepEqual(report.observed?.map((each) => each.class), ['unsupported'], "the refusal is the parent's own failure, whatever the process claims")
    })
  }

  test('a row found without a name, and a cell found by its name, reach the page', { timeout: 60_000 }, async () => {
    const seen: string[] = []
    const run = await scriptedTest({ fake: { onCommand: (sent) => seen.push(sent.kind) } })
    await run.command(1, { kind: 'observe', locator: { by: 'role', role: 'row' } })
    await run.command(2, { kind: 'observe', locator: { by: 'role', role: 'cell', name: 'Grace Hopper' } })
    await run.finish()
    assert.deepEqual(seen, ['observe', 'observe'], 'the parent sent both looks on')
  })
})
