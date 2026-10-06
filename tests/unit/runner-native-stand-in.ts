import type { TestContext } from 'node:test'
import type { AppBuild, ResetPolicy } from '../../src/browser/contract.ts'
import type { AppBundle, NativeExecutionIdentity } from '../../src/native/identity.ts'
import type { RecordedProcess } from '../../src/native/processes.ts'
import type { AppProcessReading, CaptureSource, DriverAnswer, LaunchSpec, NativeAppDriver } from '../../src/native/session.ts'
import type { ScopedSource } from '../../src/native/source-scope.ts'
import type { ExecutorAppState, ExecutorSession, RequestBounds } from '../../src/native/webdriver-client.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { RunOptions } from '../../src/runner/contract.ts'
import type { NativePoolRuntime, StartNative } from '../../src/runner/native-pool.ts'
import type { FakeElement } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { runtimeIdentity } from '../../src/native/identity.ts'
import { NativeAppSession } from '../../src/native/session.ts'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { RunSession } from '../../src/runner/run-session.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'
import { FakeApp } from './native-interaction-fake.ts'

// A whole run whose native apps are the stand-in executor over real HTTP: a real test file process drives them through
// the runner, the pool and the interaction session, and only the runtime and the driver below it are stand-ins.

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

/** The session's lifecycle over the stand-in executor. */
class StandInDriver implements NativeAppDriver {
  readonly platform: 'ios-simulator' | 'macos'
  readonly bundle: AppBundle
  readonly identity: NativeExecutionIdentity
  readonly resetPolicy: ResetPolicy = { appData: 'reset', keychain: 'reset' }
  readonly runtimeProcessIds: readonly number[] = []
  readonly captureSources: readonly CaptureSource[] = ['executor-screen']
  readonly #app: FakeApp
  readonly #executor: ExecutorSession

  constructor(app: FakeApp, executor: ExecutorSession) {
    this.#app = app
    this.#executor = executor
    this.platform = app.platform === 'macos' ? 'macos' : 'ios-simulator'
    this.bundle = bundleOf(app)
    this.identity = identityOf(app)
  }

  async install(build: AppBuild): Promise<DriverAnswer<unknown>> {
    void build
    return { status: 'answered', value: null, durationMs: 0 }
  }

  async launchBlocker(): Promise<undefined> {
    return undefined
  }

  launch(launch: LaunchSpec, bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.launchApp({ target: { bundleId: this.#app.bundleId }, ...launch }, bounds)
  }

  activate(bounds: RequestBounds): Promise<DriverAnswer<unknown>> {
    return this.#executor.activateApp({ bundleId: this.#app.bundleId }, bounds)
  }

  terminate(bounds: RequestBounds): Promise<DriverAnswer<boolean>> {
    return this.#executor.terminateApp({ bundleId: this.#app.bundleId }, bounds)
  }

  state(bounds: RequestBounds): Promise<DriverAnswer<ExecutorAppState>> {
    return this.#executor.appState({ bundleId: this.#app.bundleId }, bounds)
  }

  async processState(): Promise<AppProcessReading> {
    const running = this.#app.running
    const command = `/fake/${this.#app.appName}.app/${this.#app.appName}`
    return { ok: true, running, pids: running ? [this.#app.pid] : [], processes: running ? [{ pid: this.#app.pid, command }] : [] }
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

export type StandInRunOptions = {
  readonly platform?: 'ios-simulator' | 'macos'
  readonly screen: (app: FakeApp) => FakeElement[]
  /** The test file's source; its tests use the app `phone`, or `desk` on macOS. */
  readonly tests: string
  /** Settles or throws as the runtime's own close does. */
  readonly closeRuntime?: () => Promise<void>
  /** Changes the stand-in before the run starts, as with a behaviour for a route. */
  readonly prepare?: (app: FakeApp) => void
  readonly options?: Partial<RunOptions>
  readonly configFields?: string
  readonly secretEnvironment?: Readonly<Record<string, string>>
  /**
   * The simulator device type of an iOS target. Its part of a lease is held for the whole process when a run could not
   * close the app on it, so a test that leaves it held gives later runs in the file another device.
   */
  readonly device?: string
}

export type StandInRun = { readonly result: RunResult; readonly events: RetestEvent[]; readonly app: FakeApp; readonly starts: number }

/** Runs `tests` against one native stand-in app through the whole runner. */
export async function standInRun(t: TestContext, { platform = 'ios-simulator', screen, tests, closeRuntime, prepare, options: extra = {}, device = 'iPhone 17', configFields = '', secretEnvironment = {} }: StandInRunOptions): Promise<StandInRun> {
  const app = new FakeApp({ platform, screen })
  const port = await app.listen()
  t.after(() => app.close())
  prepare?.(app)
  const client = new ExecutorClient({ executor: platform === 'macos' ? 'mac2' : 'webdriveragent', host: '127.0.0.1', port })
  const execution = identityOf(app)
  let starts = 0
  const start: StartNative = async () => {
    starts++
    const runtime: NativePoolRuntime = {
      identity: runtimeIdentity(execution, []),
      execution,
      bundle: bundleOf(app),
      port: 0,
      connected: true,
      onDisconnect: () => () => undefined,
      openSession: async (sessionOptions) => {
        const created = await client.createSession({ timeoutMs: 2000 })
        if (created.status !== 'answered') return { ok: false, failure: { class: 'setup_failed', message: 'the stand-in opened no session' } }
        const session = new NativeAppSession(new StandInDriver(app, created.value), sessionOptions)
        return { ok: true, session, client, executor: created.value }
      },
      close: async () => undefined,
    }
    return { ok: true, value: { runtime, close: closeRuntime ?? (async () => undefined) } }
  }
  const target = platform === 'macos' ? `desk: { platform: 'macos', appPath: 'TaskDesk.app'` : `phone: { platform: 'ios-simulator', appPath: 'TaskPhone.app', device: ${JSON.stringify(device)}, runtime: '26.5'`
  const root = tempProject({
    [configFileName]: `import { defineConfig, env } from '@rehearsal-labs/retest'\nexport default defineConfig({ apps: { ${target}, diagnostics: { logs: 'none' } } }, ${configFields} })\n`,
    'tests/app.retest.ts': tests,
  })
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
  const secrets = resolveSecrets(loaded.config, secretEnvironment)
  assert.ok(secrets.ok)
  const folder = newRunFolder()
  const store = RunStore.create(folder)
  const options: RunOptions = {
    files: ['tests/app.retest.ts'],
    rootDir: root,
    apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
    timeouts: { ...quickTimeouts, setup: 5000, action: 3000, assertion: 1000, cleanup: 600, test: 15_000 },
    outputDir: folder,
    headless: true,
    workers: 1,
    signal: new AbortController().signal,
    lastRunFile: false,
    ...extra,
  }
  let result: RunResult
  try {
    result = await new RunSession({ options, reporters: [], launch: fakeLauncher().launch, findExecutable: fakeExecutable, store, native: { start } }).run()
  } finally {
    store.close()
  }
  return { result, events: readEvents(folder).events, app, starts }
}
