import type { TestContext } from 'node:test'
import type { AgentDeviceAnswer, AgentDeviceHost, AgentDeviceMethod, AgentDeviceStarter } from '../../src/native/agent-device/package.ts'
import type { SnapshotNode } from '../../src/native/agent-device/tree.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { RunOptions } from '../../src/runner/contract.ts'
import type { StartNative } from '../../src/runner/native-pool.ts'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { AgentDeviceRuntime } from '../../src/native/agent-device/runtime.ts'
import { RunSession } from '../../src/runner/run-session.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { unixOnly } from '../support/platform-skip.ts'
import { fakeExecutable, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'

// Whole runs of Android tests through the runner, the native pool and the agent-device runtime, against a stand-in
// for agent-device that plays the benchmark's task app: a title field, Save, and the saved title, which the app keeps
// until it is removed. Each test checks it starts with nothing saved, then saves a title. Only agent-device is a stand-in.

// agent-device's state folder names this process by the start ps reads, which Windows does not have.
const androidHost = { skip: unixOnly('a Windows run refuses every native target before any runtime starts, and Windows has no ps') }

const pkg = 'dev.retest.tasks'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** agent-device on one emulator holding the task app: what it installs, what the app shows and saves, and every daemon it started. */
class TaskDevice {
  readonly calls: { readonly daemon: number; readonly method: AgentDeviceMethod; readonly options: Readonly<Record<string, unknown>> }[] = []
  daemons = 0
  closedDaemons = 0
  installed = false
  stored: string | undefined
  running: { title: string; saved: string } | undefined
  heldBy: string | undefined
  generation = 0
  /** Calls whose answer is agent-device's runtime gone, by their order among this method's calls. */
  readonly lose = new Map<AgentDeviceMethod, number>()

  get starter(): AgentDeviceStarter {
    return () => {
      const daemon = ++this.daemons
      const host: AgentDeviceHost = {
        port: { call: (method, options) => Promise.resolve(this.#answer(daemon, method, options)) },
        close: () => {
          this.closedDaemons += 1
          this.heldBy = undefined
          return Promise.resolve({ ok: true, leftovers: [] })
        },
      }
      return Promise.resolve(host)
    }
  }

  sent(method: AgentDeviceMethod): typeof this.calls {
    return this.calls.filter((call) => call.method === method)
  }

  #answer(daemon: number, method: AgentDeviceMethod, options: Readonly<Record<string, unknown>>): AgentDeviceAnswer {
    this.calls.push({ daemon, method, options })
    const answered = (value: unknown): AgentDeviceAnswer => ({ status: 'answered', value, durationMs: 1 })
    const lostAt = this.lose.get(method)
    if (lostAt !== undefined && this.sent(method).length === lostAt) return { status: 'lost', message: `agent-device's ${method} failed outside agent-device: its runtime is gone`, durationMs: 1 }
    const session = options['session']
    if (this.heldBy !== undefined && method.startsWith('apps.') && session !== this.heldBy) return { status: 'refused', code: 'DEVICE_IN_USE', message: `android device emulator-5554 is owned by session "${this.heldBy}".`, durationMs: 1 }
    switch (method) {
      case 'devices.list':
        return answered([{ platform: 'android', name: 'Pixel_9', kind: 'emulator', booted: true, model: 'Pixel 9', osVersion: '15', identifiers: { serial: 'emulator-5554' }, android: { serial: 'emulator-5554' } }])
      case 'apps.uninstall': {
        const was = this.installed
        this.installed = false
        this.stored = undefined
        this.running = undefined
        return answered({ platform: 'android', app: pkg, wasInstalled: was })
      }
      case 'apps.install':
        this.installed = true
        return answered({ app: pkg, platform: 'android', appId: pkg, package: pkg, identifiers: {} })
      case 'apps.open':
        if (!this.installed) return { status: 'failed', code: 'APP_NOT_INSTALLED', message: `No package found matching "${pkg}"`, durationMs: 1 }
        if (typeof session === 'string') this.heldBy = session
        // An open without a relaunch brings a running copy to the front as it is.
        if (options['relaunch'] === true || this.running === undefined) this.running = { title: '', saved: this.stored ?? 'Nothing saved' }
        return answered({ session, appBundleId: pkg })
      case 'apps.close':
      case 'sessions.close':
        if (session !== this.heldBy) return { status: 'failed', code: 'SESSION_NOT_FOUND', message: 'No active session', durationMs: 1 }
        this.heldBy = undefined
        this.running = undefined
        return answered({ session })
      case 'capture.snapshot':
        return answered({ nodes: this.#screen(), appBundleId: pkg, refsGeneration: ++this.generation, truncated: false })
      case 'interactions.fill':
        if (this.running === undefined || !String(options['ref']).startsWith('@e2')) return { status: 'refused', code: 'COMMAND_FAILED', reason: 'ref_not_found', message: 'no such ref', durationMs: 1 }
        this.running.title = String(options['text'])
        return answered({})
      case 'interactions.press':
        if (this.running === undefined || !String(options['ref']).startsWith('@e3')) return { status: 'refused', code: 'COMMAND_FAILED', reason: 'ref_not_found', message: 'no such ref', durationMs: 1 }
        this.stored = this.running.title
        this.running.saved = this.running.title
        return answered({})
      case 'capture.screenshot':
        return answered({ path: options['path'] })
      default:
        return answered({})
    }
  }

  #screen(): SnapshotNode[] {
    const shown = this.running ?? { title: '', saved: '' }
    const at = (y: number): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } => ({ x: 48, y, width: 984, height: 120 })
    return [
      { index: 0, type: 'android.widget.FrameLayout', rect: { x: 0, y: 0, width: 1080, height: 2400 }, visibleToUser: true, ref: 'e1' },
      { index: 1, parentIndex: 0, type: 'android.widget.EditText', value: shown.title, placeholder: 'Task title', hintShowing: shown.title === '', identifier: `${pkg}:id/task_title`, rect: at(200), enabled: true, visibleToUser: true, ref: 'e2' },
      { index: 2, parentIndex: 0, type: 'android.widget.Button', label: 'Save', identifier: `${pkg}:id/save_task`, rect: at(340), enabled: true, visibleToUser: true, ref: 'e3' },
      { index: 3, parentIndex: 0, type: 'android.widget.TextView', label: shown.saved, identifier: `${pkg}:id/saved_task`, rect: at(480), enabled: true, visibleToUser: true, ref: 'e4' },
    ]
  }
}

const tests = `import { expect, test } from 'retest'

for (const n of [1, 2, 3]) {
  test(\`saves task \${n}\`, { apps: ['tasks'] }, async ({ tasks }) => {
    await expect(tasks.getByTestId('saved_task')).toHaveText('Nothing saved')
    await tasks.getByTestId('task_title').fill(\`Release checklist \${n}\`)
    await tasks.getByTestId('save_task').tap()
    await expect(tasks.getByTestId('saved_task')).toHaveText(\`Release checklist \${n}\`)
  })
}
`

// Runs the three tests through the whole runner, with agent-device's daemon the stand-in's.
async function androidRun(t: TestContext, device: TaskDevice): Promise<{ readonly result: RunResult; readonly events: RetestEvent[] }> {
  const start: StartNative = async (target, context) => {
    if (target.platform !== 'android') return { ok: false, failure: { class: 'setup_failed', message: 'this run has Android targets only' }, idle: true }
    const started = await AgentDeviceRuntime.start({ target, tools: context.tools, timeoutMs: context.timeoutMs, signal: context.signal, redact: context.redact, starter: device.starter, readBytes: () => Promise.resolve(new Uint8Array(png)) })
    if (!started.ok) return { ok: false, failure: started.failure, ...(started.idle === true ? { idle: true as const } : {}), ...(started.cleaned === true ? { cleaned: true as const } : {}) }
    const { runtime } = started
    return { ok: true, value: { runtime, close: (timeoutMs) => runtime.close(timeoutMs) } }
  }
  const root = tempProject({
    [configFileName]: `import { defineConfig } from 'retest'\nexport default defineConfig({ apps: { tasks: { platform: 'android', appPath: 'app-debug.apk', package: '${pkg}', serial: 'emulator-5554' } } })\n`,
    'tests/tasks.retest.ts': tests,
  })
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok, loaded.ok ? '' : loaded.failure.message)
  const secrets = resolveSecrets(loaded.config, {})
  assert.ok(secrets.ok)
  const folder = newRunFolder()
  const store = RunStore.create(folder)
  const options: RunOptions = {
    files: ['tests/tasks.retest.ts'],
    rootDir: root,
    apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
    timeouts: { ...quickTimeouts, setup: 5000, action: 3000, assertion: 1000, cleanup: 2000, test: 15_000 },
    outputDir: folder,
    headless: true,
    workers: 1,
    signal: new AbortController().signal,
    lastRunFile: false,
  }
  let result: RunResult
  try {
    result = await new RunSession({ options, reporters: [], launch: fakeLauncher().launch, findExecutable: fakeExecutable, store, native: { start } }).run()
  } finally {
    store.close()
  }
  t.diagnostic(`calls: ${device.calls.map((call) => `${call.daemon}:${call.method}`).join(' ')}`)
  return { result, events: readEvents(folder).events }
}

function statuses(events: readonly RetestEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'test.finished' ? [event.status] : []))
}

test("one agent-device daemon serves every Android test of the run, and each test still starts with nothing an earlier one saved", androidHost, async (t) => {
  const device = new TaskDevice()
  device.installed = true
  device.stored = 'Saved by an earlier run'
  const { result, events } = await androidRun(t, device)
  assert.deepEqual(statuses(events), ['passed', 'passed', 'passed'], 'every test found nothing saved, then saved its own task')
  assert.deepEqual([result.status, result.exitCode], ['passed', 0])
  assert.equal(device.daemons, 1, "agent-device's daemon starts once for the run")
  assert.equal(device.sent('devices.list').length, 1, 'the emulator is looked up once')
  assert.equal(device.sent('apps.uninstall').length, 3, 'each test removes the app, with what the one before saved')
  assert.equal(device.sent('apps.install').length, 3, 'and installs the APK afresh')
  assert.deepEqual(device.sent('apps.open').map((call) => call.options['relaunch']), [undefined, undefined, undefined])
  assert.deepEqual([device.sent('apps.close').length, device.sent('sessions.close').length, device.closedDaemons], [1, 1, 1], 'the run closes the app, the session and the daemon once, at its end')
  assert.equal(device.heldBy, undefined, 'nothing holds the emulator once the run ends')
})

test('a test whose agent-device runtime was lost leaves it to no later test: the next test starts a new one, which the test after reuses', androidHost, async (t) => {
  const device = new TaskDevice()
  // The first test's first look finds agent-device's runtime gone.
  device.lose.set('capture.snapshot', 1)
  const { events } = await androidRun(t, device)
  assert.deepEqual(statuses(events), ['error', 'passed', 'passed'], 'the first test ends as an error; the two after it pass')
  assert.equal(device.daemons, 2, 'the lost runtime is replaced once, and its replacement serves the third test')
  assert.equal(device.closedDaemons, 2, 'the lost runtime is closed before its replacement starts, and the replacement at the run end')
  const second = device.calls.filter((call) => call.daemon === 2).map((call) => call.method)
  assert.equal(second[0], 'devices.list', 'the new runtime looks the emulator up afresh')
  assert.ok(device.calls.filter((call) => call.daemon === 1 && call.method === 'sessions.close').length === 1, 'the lost runtime still closes its session')
  assert.equal(device.heldBy, undefined)
})
