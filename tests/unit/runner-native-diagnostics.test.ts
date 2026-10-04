import type { TestContext } from 'node:test'
import type { AppBuild, ResetPolicy } from '../../src/browser/contract.ts'
import type { AppBundle, NativeExecutionIdentity } from '../../src/native/identity.ts'
import type { LoggedNativeLaunch, LoggedNativeLaunchOptions, NativeLogSource } from '../../src/native/logs.ts'
import type { RecordedProcess } from '../../src/native/processes.ts'
import type { AppProcessReading, CaptureSource, DriverAnswer, LaunchSpec, NativeAppDriver, NativeLauncher, NativeSessionOptions } from '../../src/native/session.ts'
import type { ScopedSource } from '../../src/native/source-scope.ts'
import type { ExecutorAppState, ExecutorSession, RequestBounds } from '../../src/native/webdriver-client.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { NativePoolRuntime, StartNative } from '../../src/runner/native-pool.ts'
import type { FakeElement } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { runtimeIdentity } from '../../src/native/identity.ts'
import { NativeAppSession } from '../../src/native/session.ts'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { RunSession } from '../../src/runner/run-session.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { FakeApp } from './native-interaction-fake.ts'

// The order a native app's diagnostics keep around its launch, over the stand-in executor: the sources start before the
// app launches, the launch that keeps its standard output goes in place of the executor's after the session's own checks
// and hands the session the process it recorded, the sources finish once the body and the parent's checks are over and
// before anything closes, and the launch's stop is awaited after the session ends the app and before the runtime ends.

const command = (app: FakeApp): string => `/fake/${app.appName}.app/${app.appName}`

function identityOf(app: FakeApp): NativeExecutionIdentity {
  const platform = app.platform === 'macos' ? 'macos' : 'ios-simulator'
  return {
    platform,
    app: { bundleId: app.bundleId, version: '1.0', build: '1', path: `/fake/${app.appName}.app`, sha256: 'a'.repeat(64) },
    os: platform === 'macos' ? { name: 'macOS', version: '26.5', build: 'fake' } : { name: 'iOS', version: '26.5', build: 'fake' },
    ...(platform === 'macos' ? {} : { device: { name: 'retest-native-fake', type: 'iPhone 17', udid: '12345678-1234-1234-1234-123456789012' } }),
    executor: { name: platform === 'macos' ? 'appium-mac2-driver' : 'WebDriverAgent', version: '0', commit: '0'.repeat(40), commitVerified: false, productsSha256: 'b'.repeat(64), origin: 'adopted' },
    xcode: { version: '26.5', build: 'fake' },
  }
}

function bundleOf(app: FakeApp): AppBundle {
  return { appPath: `/fake/${app.appName}.app`, bundleId: app.bundleId, version: '1.0', build: '1', executable: app.appName, platforms: [app.platform === 'macos' ? 'MacOSX' : 'iPhoneSimulator'], sha256: 'a'.repeat(64) }
}

/** The session's lifecycle over the stand-in, noting each call that orders the launch. */
class StandInDriver implements NativeAppDriver {
  readonly platform: 'ios-simulator' | 'macos'
  readonly bundle: AppBundle
  readonly identity: NativeExecutionIdentity
  readonly resetPolicy: ResetPolicy = { appData: 'reset', keychain: 'reset' }
  readonly runtimeProcessIds: readonly number[] = []
  readonly captureSources: readonly CaptureSource[] = ['executor-screen']
  blocker: Failure | undefined
  readonly #app: FakeApp
  readonly #executor: ExecutorSession
  readonly #order: string[]

  constructor(app: FakeApp, executor: ExecutorSession, order: string[]) {
    this.#app = app
    this.#executor = executor
    this.#order = order
    this.platform = app.platform === 'macos' ? 'macos' : 'ios-simulator'
    this.bundle = bundleOf(app)
    this.identity = identityOf(app)
  }

  async install(build: AppBuild): Promise<DriverAnswer<unknown>> {
    void build
    return { status: 'answered', value: null, durationMs: 0 }
  }

  async launchBlocker(): Promise<Failure | undefined> {
    this.#order.push('launch blocker')
    return this.blocker
  }

  launch(launch: LaunchSpec, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    this.#order.push('executor launch')
    return this.#executor.launchApp({ target: { bundleId: this.#app.bundleId }, ...launch }, bounds)
  }

  activate(bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    this.#order.push('activate')
    return this.#executor.activateApp({ bundleId: this.#app.bundleId }, bounds)
  }

  terminate(bounds: RequestBounds): Promise<DriverAnswer<boolean>> {
    this.#order.push('terminate')
    return this.#executor.terminateApp({ bundleId: this.#app.bundleId }, bounds)
  }

  state(bounds: RequestBounds): Promise<DriverAnswer<ExecutorAppState>> {
    return this.#executor.appState({ bundleId: this.#app.bundleId }, bounds)
  }

  async processState(): Promise<AppProcessReading> {
    const running = this.#app.running
    return { ok: true, running, pids: running ? [this.#app.pid] : [], processes: running ? [{ pid: this.#app.pid, command: command(this.#app) }] : [] }
  }

  capture(_source: CaptureSource, bounds: RequestBounds): Promise<DriverAnswer<Uint8Array>> {
    return this.#executor.screenshot(bounds)
  }

  source(bounds: RequestBounds): Promise<DriverAnswer<ScopedSource>> {
    return this.#executor.ownedSource({ platform: this.platform, bundleId: this.#app.bundleId, appNames: [this.#app.appName] }, bounds)
  }

  async forceEnd(processes: readonly RecordedProcess[]): Promise<string[]> {
    void processes
    this.#app.running = false
    return []
  }

  async endExecutorSession(bounds: RequestBounds): Promise<string[]> {
    const ended = await this.#executor.end(bounds)
    return ended.status === 'answered' || ended.status === 'refused' ? [] : [ended.message]
  }

  released(): void {}
}

type StandIn = { readonly app: FakeApp; readonly client: ExecutorClient; readonly order: string[] }

async function standIn(t: TestContext, platform: 'ios-simulator' | 'macos', screen: (app: FakeApp) => FakeElement[]): Promise<StandIn> {
  const app = new FakeApp({ platform, screen })
  const port = await app.listen()
  t.after(() => app.close())
  return { app, client: new ExecutorClient({ executor: platform === 'macos' ? 'mac2' : 'webdriveragent', host: '127.0.0.1', port }), order: [] }
}

/** A session over the stand-in, opened as a runtime opens one, with the options the caller gives. */
async function openSession(stand: StandIn, options: Omit<NativeSessionOptions, 'owner' | 'redact'> & Partial<Pick<NativeSessionOptions, 'owner' | 'redact'>>): Promise<{ session: NativeAppSession; driver: StandInDriver; executor: ExecutorSession }> {
  const created = await stand.client.createSession({ timeoutMs: 2000 })
  if (created.status !== 'answered') throw new Error('the stand-in opened no session')
  const driver = new StandInDriver(stand.app, created.value, stand.order)
  const session = new NativeAppSession(driver, { owner: { runId: 'run', testId: 'test', attemptId: 'attempt', app: 'phone' }, redact: (text) => text, ...options })
  return { session, driver, executor: created.value }
}

/** A launcher that starts the stand-in's app itself, as the launch that keeps its output would, noting each call. */
function standInLauncher(stand: StandIn, answer: 'answered' | 'unknown' | 'decline' = 'answered'): NativeLauncher {
  return async (launch) => {
    stand.order.push(`launcher ${launch.arguments.join(' ')}`)
    if (answer === 'decline') return undefined
    stand.app.running = true
    stand.app.elements = stand.app.screen(stand.app)
    if (answer === 'unknown') return { answer: { status: 'failed', input: 'unknown', failure: { class: 'outcome_unknown', message: 'The launch may have happened.' } }, processes: [] }
    return { answer: { status: 'answered', value: null, durationMs: 1 }, processes: [{ pid: stand.app.pid, command: command(stand.app) }] }
  }
}

const launchSpec = { arguments: ['-reset'], environment: {} }

describe('a launch the session owner makes in place of the executor', () => {
  test("goes after the session's own checks, sends nothing to the executor's launch route, and the session owns the process it names", async (t) => {
    const stand = await standIn(t, 'ios-simulator', () => [{ type: 'StaticText', identifier: 'state', label: 'Open' }])
    const { session } = await openSession(stand, { launch: launchSpec, launcher: standInLauncher(stand) })
    const launched = await session.launch(2000)
    assert.equal(launched.result.ok, true, launched.result.ok ? '' : launched.result.failure.message)
    assert.deepEqual(stand.order, ['launch blocker', 'launcher -reset'])
    assert.equal(stand.app.on('POST /session/:session/wda/apps/launch').length, 0, "the executor's launch route was never asked")
    assert.deepEqual(session.processIds, [stand.app.pid])
    assert.equal(session.appStatus.expectedRunning, true)
    await session.dispose(2000)
    assert.equal(stand.app.running, false, 'disposing ended the process the launch named, as its own')
    assert.deepEqual(stand.order.slice(2), ['terminate'])
  })

  test('a launch blocker stops it before the launcher is asked', async (t) => {
    const stand = await standIn(t, 'macos', () => [])
    const { session, driver } = await openSession(stand, { launch: launchSpec, launcher: standInLauncher(stand) })
    driver.blocker = { class: 'not_actionable', message: 'A copy of the app is already running.' }
    const refused = await session.launch(2000)
    assert.deepEqual([refused.input, refused.result.ok ? undefined : refused.result.failure.class], ['not_sent', 'not_actionable'])
    assert.deepEqual(stand.order, ['launch blocker'])
    assert.equal(stand.app.running, false)
    await session.dispose(2000)
  })

  test("a launcher that declines leaves the launch to the executor's route", async (t) => {
    const stand = await standIn(t, 'ios-simulator', () => [])
    const { session } = await openSession(stand, { launch: launchSpec, launcher: standInLauncher(stand, 'decline') })
    assert.equal((await session.launch(2000)).result.ok, true)
    assert.deepEqual(stand.order, ['launch blocker', 'launcher -reset', 'executor launch'])
    assert.equal(stand.app.on('POST /session/:session/wda/apps/launch').length, 1)
    await session.dispose(2000)
  })

  test('a launch whose outcome is unknown is kept as unknown and reconciled, never taken back, and what it started is still ended', async (t) => {
    const stand = await standIn(t, 'ios-simulator', () => [])
    const { session } = await openSession(stand, { launch: launchSpec, launcher: standInLauncher(stand, 'unknown') })
    const launched = await session.launch(2000)
    assert.deepEqual([launched.input, launched.result.ok ? undefined : launched.result.failure.class], ['unknown', 'outcome_unknown'])
    assert.equal(session.appStatus.generation, 1, 'a launch that may have gone starts a new launch')
    const [unknown] = await session.reconcile(2000)
    assert.deepEqual([unknown?.kind, unknown?.reconciled], ['launch', { ok: true, running: true, pids: [stand.app.pid] }])
    assert.deepEqual(session.processIds, [stand.app.pid], 'the process the operating system showed in the launch window is the session\'s own')
    await session.dispose(2000)
    assert.equal(stand.app.running, false)
  })
})

// A whole run on a native stand-in: a real test file process drives `phone`, whose runtime is the stand-in and whose
// launch with its output kept is a stand-in too. What the app writes, and when, shows when each source starts and ends.
describe('a run keeps a native app\'s diagnostics from before its launch until its body and checks are over', () => {
  const phoneTests = `import { expect, test } from '@rehearsal-labs/retest'

test('saves on the phone', { apps: ['phone'] }, async ({ phone }) => {
  await phone.getByTestId('save').tap()
  await expect(phone.getByTestId('state')).toHaveText('Saved')
})
`
  // A click on macOS needs the app in front of the real desktop, which a stand-in is not, so the desk's body only reads.
  const deskTests = `import { expect, test } from '@rehearsal-labs/retest'

test('reads the desk', { apps: ['desk'] }, async ({ desk }) => {
  await expect(desk.getByTestId('state')).toHaveText('Open')
})
`

  type Recorded = { events: RetestEvent[]; folder: string; order: string[]; launches: LoggedNativeLaunchOptions[] }

  async function recordedRun(t: TestContext, diagnostics: string, platform: 'ios-simulator' | 'macos' = 'ios-simulator', topLevel = ''): Promise<Recorded> {
    const scratch = tempFolder('native-diagnostics-run-')
    const network = join(scratch, 'network.jsonl')
    let sequence = 0
    const appendRequest = (client: 'ios' | 'macos', path: string): void => {
      sequence += 1
      appendFileSync(network, `${JSON.stringify({ schemaVersion: 1, type: 'http.request', sequence, startedAt: new Date().toISOString(), method: 'POST', path, status: 201, durationMs: 3, client, completed: true })}\n`)
    }
    // A record from before the test started belongs to no attempt.
    writeFileSync(network, '')
    appendRequest('ios', '/api/before-the-test')
    let source: NativeLogSource | undefined
    const say = (line: string): void => source?.push(Buffer.from(`${line}\n`))
    const stand = await standIn(t, platform, (app) => platform === 'macos' ? [{ type: 'StaticText', identifier: 'state', value: 'Open', frame: { x: 40, y: 100, width: 200, height: 16 } }] : [
      { type: 'Button', identifier: 'save', label: 'Save', frame: { x: 16, y: 300, width: 200, height: 44 }, onClick: () => {
        say('POST /api/tasks 201 3ms')
        appendRequest('ios', '/api/tasks')
        appendRequest('macos', '/api/tasks/other-client')
        const state = app.elements.find((element) => element.identifier === 'state')
        if (state !== undefined) state.label = 'Saved'
      } },
      { type: 'StaticText', identifier: 'state', label: 'Open', frame: { x: 16, y: 360, width: 200, height: 20 } },
    ])
    const launches: LoggedNativeLaunchOptions[] = []
    const launchWithLogs = async (options: LoggedNativeLaunchOptions): Promise<LoggedNativeLaunch> => {
      stand.order.push('launch with logs')
      launches.push(options)
      source = options.source
      const process = { pid: stand.app.pid, command: command(stand.app) }
      options.source.bind(process, platform === 'macos' ? 'macos-stdout' : 'simctl-stdout')
      stand.app.running = true
      stand.app.elements = stand.app.screen(stand.app)
      say('started')
      return { process, ...(platform === 'macos' ? {} : { launcher: { pid: 4343, command: 'xcrun simctl launch --console' } }), stop: async () => {
        stand.order.push('stop')
        // Written after the sources finished: neither reaches the attempt's artifact.
        say('after the stop')
        appendRequest('ios', '/api/after-the-stop')
        stand.app.running = false
      } }
    }
    const execution = identityOf(stand.app)
    const start: StartNative = async () => {
      stand.order.push('runtime start')
      const runtime: NativePoolRuntime = {
        identity: runtimeIdentity(execution, []),
        execution,
        bundle: bundleOf(stand.app),
        port: 0,
        connected: true,
        onDisconnect: () => () => undefined,
        openSession: async (options) => {
          const opened = await openSession(stand, options)
          return { ok: true, session: opened.session, client: stand.client, executor: opened.executor }
        },
        close: async () => undefined,
      }
      return { ok: true, value: { runtime, close: async () => { stand.order.push('runtime close') } } }
    }
    const app = platform === 'macos' ? `desk: { platform: 'macos', appPath: 'TaskDesk.app'` : `phone: { platform: 'ios-simulator', appPath: 'TaskPhone.app', device: 'iPhone 17', runtime: '26.5'`
    const root = tempProject({
      'retest.config.ts': `import { defineConfig } from '@rehearsal-labs/retest'\nexport default defineConfig({ apps: { ${app}, arguments: ['-reset']${diagnostics.replace('NETWORK', JSON.stringify(network))} } }${topLevel} })\n`,
      'tests/app.retest.ts': platform === 'macos' ? deskTests : phoneTests,
    })
    const loaded = await loadConfig(join(root, configFileName))
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
    const secrets = resolveSecrets(loaded.config, {})
    assert.ok(secrets.ok)
    const folder = newRunFolder()
    const store = RunStore.create(folder)
    const options = { files: ['tests/app.retest.ts'], rootDir: root, apps: { kind: 'config' as const, config: loaded.config, secrets: secrets.secrets }, timeouts: { ...quickTimeouts, setup: 5000, action: 3000, assertion: 3000, cleanup: 5000, test: 15_000 }, outputDir: folder, headless: true, workers: 1, signal: new AbortController().signal }
    try {
      const result = await new RunSession({ options, reporters: [], launch: fakeLauncher().launch, findExecutable: fakeExecutable, store, native: { start, launchWithLogs } }).run()
      assert.equal(result.exitCode, 0, JSON.stringify(result.files))
    } finally {
      store.close()
    }
    return { events: readEvents(folder).events, folder, order: stand.order, launches }
  }

  function sequence(events: readonly RetestEvent[], type: RetestEvent['type']): number {
    const found = events.find((event) => event.type === type)
    assert.ok(found !== undefined, `the run recorded ${type}`)
    return found.sequence
  }

  test('the sources start before the launch, keep what the app does in its body, and finish before the stop and the runtime end', async (t) => {
    const { events, folder, order, launches } = await recordedRun(t, ", diagnostics: { network: { path: NETWORK, client: 'ios' } }")
    assert.deepEqual(order.filter((step) => step !== 'launch blocker'), ['runtime start', 'launch with logs', 'terminate', 'stop', 'runtime close'], 'the session ended the app before the launch was stopped, and the runtime ended last')
    assert.deepEqual(order.filter((step) => step === 'executor launch'), [], "the executor's launch route was never asked")
    const [launch] = launches
    assert.ok(launch !== undefined && launches.length === 1)
    assert.deepEqual([launch.target, launch.launch], [{ platform: 'ios-simulator', udid: '12345678-1234-1234-1234-123456789012', bundleId: 'dev.retest.fixtures.taskphone', executable: 'TaskPhone' }, { arguments: ['-reset'], environment: {} }])

    const started = events.find((event) => event.type === 'test.started')
    assert.ok(started?.type === 'test.started')
    const sessionId = formatSessionId(started.attemptId, 'phone')
    assert.ok(sequence(events, 'diagnostics.started') < sequence(events, 'native.started'), 'capture started before the app launched')
    assert.ok(sequence(events, 'diagnostics.finished') < sequence(events, 'native.ended'), 'capture finished before the session ended')
    const finished = events.find((event) => event.type === 'diagnostics.finished')
    assert.ok(finished?.type === 'diagnostics.finished' && finished.sessionId === sessionId)
    const summary = finished.diagnostics
    assert.equal(summary.console.state, 'complete')
    assert.equal(summary.network.state, 'complete')
    assert.equal(summary.scope?.source, 'owned_app')
    assert.ok(summary.path !== undefined)
    const artifact = parseArtifact(readFileSync(join(folder, summary.path), 'utf8'), summary.path)
    assert.ok(artifact.ok, artifact.ok ? '' : artifact.problem)
    const logs = artifact.lines.flatMap((line) => (line.type === 'console' ? [line.text.text] : []))
    const routes = artifact.lines.flatMap((line) => (line.type === 'network.request' ? [line.url] : []))
    assert.deepEqual(logs, ['started', 'POST /api/tasks 201 3ms'], 'the lines from the launch and the body, and none after the stop')
    assert.deepEqual(routes, ['/api/tasks'], "this client's records from the attempt only: none before it, none of the other client, none after the stop")
    for (const line of artifact.lines) assert.deepEqual([line.testId, line.attemptId, line.app, line.sessionId], [started.testId, started.attemptId, 'phone', sessionId])

    const result = events.find((event) => event.type === 'run.finished')
    assert.ok(result !== undefined)
    const rebuilt = rebuildRecordedResult(events)
    assert.deepEqual(rebuilt.files[0]?.tests[0]?.diagnostics, [summary], 'the result names the native source as the events do')
  })

  test('on macOS the app launched with its output kept is then activated, so the runner drives that app and brings it in front', async (t) => {
    const { events, folder, order, launches } = await recordedRun(t, ", diagnostics: { network: { path: NETWORK, client: 'macos' } }", 'macos')
    assert.deepEqual(order.filter((step) => step !== 'launch blocker'), ['runtime start', 'launch with logs', 'activate', 'terminate', 'stop', 'runtime close'])
    assert.deepEqual(launches.map((launch) => launch.target), [{ platform: 'macos', executable: '/fake/TaskDesk.app/Contents/MacOS/TaskDesk' }])
    const finished = events.find((event) => event.type === 'diagnostics.finished')
    assert.ok(finished?.type === 'diagnostics.finished' && finished.diagnostics.path !== undefined)
    assert.equal(finished.diagnostics.console.state, 'complete')
    assert.deepEqual(finished.diagnostics.network, { state: 'unavailable', reason: 'the source wrote no network records for the owned app' }, 'the desk made no request of its own in this test')
    const artifact = parseArtifact(readFileSync(join(folder, finished.diagnostics.path), 'utf8'), finished.diagnostics.path)
    assert.ok(artifact.ok)
    assert.deepEqual(artifact.lines.map((line) => (line.type === 'console' ? `${line.source} ${line.text.text}` : line.type)), ['capture.started', 'macos-stdout started', 'capture.finished'])
  })

  test("an app with no declared network file says so, and one that keeps no log is launched by its executor and says so", async (t) => {
    const plain = await recordedRun(t, '')
    const plainSummary = plain.events.find((event) => event.type === 'diagnostics.finished')
    assert.ok(plainSummary?.type === 'diagnostics.finished')
    assert.equal(plainSummary.diagnostics.console.state, 'complete')
    assert.deepEqual(plainSummary.diagnostics.network, { state: 'unavailable', reason: 'the app provides no network source' })
    assert.deepEqual(plain.launches.length, 1)

    const quiet = await recordedRun(t, ", diagnostics: { logs: 'none' }")
    assert.deepEqual(quiet.launches, [], 'nothing launched the app with its output kept')
    assert.deepEqual(quiet.order.filter((step) => step !== 'launch blocker'), ['runtime start', 'executor launch', 'terminate', 'runtime close'])
    const quietSummary = quiet.events.find((event) => event.type === 'diagnostics.finished')
    assert.ok(quietSummary?.type === 'diagnostics.finished')
    assert.deepEqual([quietSummary.diagnostics.console, quietSummary.diagnostics.network], [{ state: 'unavailable', reason: 'the app provides no log source' }, { state: 'unavailable', reason: 'the app provides no network source' }])
  })

  test('a run that captures nothing launches the app by its executor, opens no network file and records both sources as disabled', async (t) => {
    const off = await recordedRun(t, ", diagnostics: { network: { path: NETWORK, client: 'ios' } }", 'ios-simulator', ', diagnostics: { capture: false }')
    assert.deepEqual(off.launches, [])
    assert.deepEqual(off.order.filter((step) => step !== 'launch blocker'), ['runtime start', 'executor launch', 'terminate', 'runtime close'])
    assert.equal(off.events.some((event) => event.type === 'diagnostics.started'), false)
    const summary = off.events.find((event) => event.type === 'diagnostics.finished')
    assert.ok(summary?.type === 'diagnostics.finished')
    assert.deepEqual([summary.diagnostics.console, summary.diagnostics.network, summary.diagnostics.path], [{ state: 'disabled' }, { state: 'disabled' }, undefined])
  })
})
