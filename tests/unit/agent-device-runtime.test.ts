import type { LoadedAgentDeviceTarget } from '../../src/config/loaded.ts'
import type { AgentDeviceInteraction } from '../../src/native/agent-device/interaction.ts'
import type { AgentDeviceAnswer, AgentDeviceHost, AgentDeviceMethod, AgentDeviceStarter } from '../../src/native/agent-device/package.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'
import { AgentDeviceRuntime } from '../../src/native/agent-device/runtime.ts'
import { systemTools } from '../../src/native/processes.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'
import { unixOnly } from '../support/platform-skip.ts'

// The Android runtime against a stand-in for agent-device: finding the emulator or device a target names, booting an
// emulator only when it is not running and shutting down only one it booted, installing the APK afresh and checking
// the package it installed, and closing everything it started. No Android SDK, emulator or device runs here; these are
// the only checks of the Android path, which has not run on a real emulator or device.

// agent-device's state folder is a folder Retest owns, which names this process by the start ps reads. Windows has no
// ps, and a run there refuses every native target before any runtime starts.
const androidHost = { skip: unixOnly('a Windows run refuses every native target before any runtime starts, and Windows has no ps') }

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const apk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

type Call = { readonly method: AgentDeviceMethod; readonly options: Readonly<Record<string, unknown>> }

/**
 * agent-device's daemon as the runtime sees it: devices it lists, what it installs, every call it gets, and its close.
 * The device holds the app or not, with what an earlier run saved. Its install, uninstall and reinstall answer as
 * agent-device 0.21.36 answered them on the Android 15 emulator: a reinstall of an app the device does not have fails,
 * since adb's uninstall of it fails there with `DELETE_FAILED_INTERNAL_ERROR`; an uninstall reads the device's packages
 * first and says whether the app was there.
 */
class StandInDaemon {
  readonly calls: Call[] = []
  readonly started: { readonly stateDir: string; readonly env: Readonly<Record<string, string>> }[] = []
  readonly answers = new Map<AgentDeviceMethod, AgentDeviceAnswer>()
  booted: boolean
  closed = 0
  installs = 'dev.retest.tasks'
  installed = true
  saved: string | undefined
  /** The agent-device session that holds the device once it opened the app, until it closes. */
  heldBy: string | undefined
  readonly kind: 'emulator' | 'device'

  constructor(options: { readonly booted: boolean; readonly kind?: 'emulator' | 'device' }) {
    this.booted = options.booted
    this.kind = options.kind ?? 'emulator'
  }

  get starter(): AgentDeviceStarter {
    return (options) => {
      this.started.push({ stateDir: options.stateDir, env: options.env })
      const host: AgentDeviceHost = {
        port: { call: (method, callOptions) => this.#answer(method, callOptions) },
        close: () => {
          this.closed += 1
          this.heldBy = undefined
          return Promise.resolve({ ok: true, leftovers: [] })
        },
      }
      return Promise.resolve(host)
    }
  }

  sent(method: AgentDeviceMethod): Call[] {
    return this.calls.filter((call) => call.method === method)
  }

  async #answer(method: AgentDeviceMethod, options: Readonly<Record<string, unknown>>): Promise<AgentDeviceAnswer> {
    this.calls.push({ method, options })
    const answered = (value: unknown): AgentDeviceAnswer => ({ status: 'answered', value, durationMs: 1 })
    const given = this.answers.get(method)
    if (given !== undefined) return given
    const app = String(options['app'])
    const session = options['session']
    if (this.heldBy !== undefined && method.startsWith('apps.') && session !== this.heldBy) return { status: 'refused', code: 'DEVICE_IN_USE', message: `android device emulator-5554 is owned by session "${this.heldBy}".`, durationMs: 1 }
    switch (method) {
      case 'devices.list':
        return answered([
          { platform: 'ios', name: 'iPhone 17', kind: 'simulator', booted: false, identifiers: {} },
          { platform: 'android', name: 'Pixel_9', kind: this.kind, booted: this.booted, model: 'Pixel 9', osVersion: '16', identifiers: this.booted ? { serial: 'emulator-5554' } : {}, ...(this.booted ? { android: { serial: 'emulator-5554' } } : {}) },
        ])
      case 'devices.boot':
        this.booted = true
        return answered({})
      case 'apps.reinstall':
        if (!this.installed) return { status: 'failed', code: 'COMMAND_FAILED', message: `adb uninstall failed for ${app}`, durationMs: 1 }
        this.saved = undefined
        return answered({ app: options['app'], appPath: options['appPath'], platform: 'android', package: this.installs, identifiers: {} })
      case 'apps.uninstall': {
        const was = this.installed
        this.installed = false
        this.saved = undefined
        return answered(was ? { platform: 'android', app, wasInstalled: true, appId: app, message: `Uninstalled: ${app}` } : { platform: 'android', app, wasInstalled: false, message: `Not installed: ${app}` })
      }
      case 'apps.install':
        this.installed = true
        return answered({ app: options['app'], appPath: options['appPath'], platform: 'android', appId: this.installs, package: this.installs, identifiers: { session: 'default', appId: this.installs, package: this.installs } })
      case 'apps.open':
        if (typeof session === 'string') this.heldBy = session
        return answered({ session, appBundleId: app })
      case 'apps.close':
      case 'sessions.close':
        if (session !== this.heldBy) return { status: 'failed', code: 'SESSION_NOT_FOUND', message: 'No active session', durationMs: 1 }
        this.heldBy = undefined
        return answered({ session })
      case 'capture.screenshot':
        await writeFile(String(options['path']), png)
        return answered({ path: options['path'] })
      default:
        return answered({})
    }
  }
}

function androidTarget(device: { readonly name: string } | { readonly serial: string }): LoadedAgentDeviceTarget {
  return { name: 'android', platform: 'android', appPath: '/work/app-debug.apk', package: 'dev.retest.tasks', device, driver: 'agent-device' }
}

// Starts a runtime that is closed when the test ends however it ends, so a failing check leaves no state folder behind.
// The APK reads as `apk` unless the test gives what each read returns.
async function start(t: TestContext, daemon: StandInDaemon, device: { readonly name: string } | { readonly serial: string }, readBytes: () => Promise<Uint8Array> = () => Promise.resolve(apk)): ReturnType<typeof AgentDeviceRuntime.start> {
  const started = await AgentDeviceRuntime.start({ target: androidTarget(device), tools: { ...systemTools, hiddenVariables: ['RETEST_SECRET_VARIABLE'] }, timeoutMs: 30_000, redact: (text) => text, starter: daemon.starter, readBytes })
  if (started.ok) t.after(() => started.runtime.close(10_000))
  return started
}

test('an emulator that is not running is booted, named in the identity, and shut down at the end with the daemon and its folder', androidHost, async (t) => {
  process.env['RETEST_SECRET_VARIABLE'] = 'kept-from-agent-device'
  const daemon = new StandInDaemon({ booted: false })
  const started = await start(t, daemon, { name: 'Pixel_9' })
  assert.ok(started.ok, started.ok ? '' : started.failure.message)
  const { runtime } = started
  assert.equal(daemon.sent('devices.boot')[0]?.options['device'], 'Pixel_9')
  assert.equal(daemon.started[0]?.env['RETEST_SECRET_VARIABLE'], undefined, "agent-device's daemon never sees a hidden variable")
  assert.deepEqual(runtime.execution, {
    platform: 'android',
    app: { bundleId: 'dev.retest.tasks', path: '/work/app-debug.apk', sha256: sha256Hex(apk) },
    os: { name: 'Android', version: '16', build: 'unreported' },
    android: { name: 'Pixel_9', serial: 'emulator-5554', kind: 'emulator', model: 'Pixel 9' },
    executor: { name: 'agent-device', version: '0.21.36', package: 'agent-device' },
  })
  assert.equal(runtime.identity.kind, 'android')
  const folder = daemon.started[0]?.stateDir ?? ''
  assert.ok(existsSync(folder))
  await runtime.close(10_000)
  const [closed] = daemon.sent('sessions.close')
  assert.equal(closed?.options['shutdown'], true, 'the emulator Retest booted is shut down')
  assert.equal(closed?.options['serial'], 'emulator-5554')
  assert.equal(daemon.closed, 1)
  assert.equal(existsSync(folder), false, "agent-device's state folder is removed")
  delete process.env['RETEST_SECRET_VARIABLE']
})

test('a running device named by serial is used as it is: nothing is booted, and nothing is shut down', androidHost, async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  const started = await start(t, daemon, { serial: 'emulator-5554' })
  assert.ok(started.ok, started.ok ? '' : started.failure.message)
  assert.equal(daemon.sent('devices.boot').length, 0)
  await started.runtime.close(10_000)
  assert.equal(daemon.sent('sessions.close')[0]?.options['shutdown'], undefined)
})

test('the APK is installed afresh through agent-device, and an install of another package is refused before any launch', androidHost, async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  const started = await start(t, daemon, { serial: 'emulator-5554' })
  assert.ok(started.ok)
  const opened = await started.runtime.openInteraction({ owner: { runId: 'r', testId: 't', attemptId: 'a1', app: 'tasks' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 1000, new AbortController().signal)
  assert.ok(opened.ok)
  const session = opened.value
  assert.equal(session.platform, 'android')
  const installed = await session.install({ appPath: '/work/app-debug.apk' }, 5000)
  assert.ok(installed.result.ok)
  // Both name the runtime's agent-device session, which holds the device once a test has opened the app.
  const named = daemon.sent('apps.uninstall')[0]?.options['session']
  assert.match(String(named), /^retest-\d+-[0-9a-f]{8}$/)
  assert.deepEqual(daemon.sent('apps.uninstall')[0]?.options, { platform: 'android', serial: 'emulator-5554', session: named, app: 'dev.retest.tasks' })
  assert.deepEqual(daemon.sent('apps.install')[0]?.options, { platform: 'android', serial: 'emulator-5554', session: named, app: 'dev.retest.tasks', appPath: '/work/app-debug.apk' })
  daemon.installs = 'com.example.other'
  const other = await session.install({ appPath: '/work/app-debug.apk' }, 5000)
  assert.ok(!other.result.ok)
  assert.match(other.result.failure.message, /installed com\.example\.other, not dev\.retest\.tasks/)
  // A capture is agent-device's screenshot, written to the runtime's folder and read back.
  const launched = await session.launch(5000)
  assert.ok(launched.result.ok)
  const captured = await session.capture(5000)
  assert.ok(captured.ok, captured.ok ? '' : captured.failure.message)
  assert.equal(captured.capture.source, 'executor-screen')
  assert.deepEqual(daemon.sent('apps.open')[0]?.options, { app: 'dev.retest.tasks', relaunch: true, platform: 'android', serial: 'emulator-5554', session: daemon.sent('apps.open')[0]?.options['session'] })
  await session.dispose(5000)
  await started.runtime.close(10_000)
})

// The interaction session a test's app opens on the runtime, disposed when the test ends.
async function interactionOf(t: TestContext, runtime: AgentDeviceRuntime, attemptId = 'a1'): Promise<AgentDeviceInteraction> {
  const opened = await runtime.openInteraction({ owner: { runId: 'r', testId: 't', attemptId, app: 'tasks' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 1000, new AbortController().signal)
  assert.ok(opened.ok)
  t.after(() => opened.value.dispose(5000))
  return opened.value
}

test('the APK installs on a device without the app and on one with it, and the app starts with no data of an earlier run', androidHost, async (t) => {
  for (const had of [false, true]) {
    const daemon = new StandInDaemon({ booted: true })
    daemon.installed = had
    daemon.saved = had ? 'Release checklist 1' : undefined
    const started = await start(t, daemon, { serial: 'emulator-5554' })
    assert.ok(started.ok, started.ok ? '' : started.failure.message)
    const session = await interactionOf(t, started.runtime)
    const installed = await session.install({ appPath: '/work/app-debug.apk' }, 5000)
    const which = had ? 'a device with the app' : 'a device without the app'
    assert.ok(installed.result.ok, installed.result.ok ? '' : `${which}: ${installed.result.failure.message}`)
    assert.equal(installed.input, 'sent', which)
    assert.equal(daemon.installed, true, which)
    assert.equal(daemon.saved, undefined, `${which} keeps nothing an earlier run saved`)
    assert.equal(daemon.sent('apps.reinstall').length, 0, which)
    const named = daemon.sent('apps.uninstall')[0]?.options['session']
    assert.deepEqual(daemon.sent('apps.uninstall').map((call) => call.options), [{ platform: 'android', serial: 'emulator-5554', session: named, app: 'dev.retest.tasks' }], which)
    assert.deepEqual(daemon.sent('apps.install').map((call) => call.options), [{ platform: 'android', serial: 'emulator-5554', session: named, app: 'dev.retest.tasks', appPath: '/work/app-debug.apk' }], which)
    await started.runtime.close(10_000)
  }
})

test('an install that fails says truthfully whether anything reached the device, and is never sent again', androidHost, async (t) => {
  const refused: AgentDeviceAnswer = { status: 'refused', code: 'DEVICE_NOT_READY', message: 'The device is not ready.', durationMs: 1 }
  const failed: AgentDeviceAnswer = { status: 'failed', code: 'COMMAND_FAILED', message: 'adb install failed', durationMs: 1 }
  const cases: readonly { readonly name: string; readonly had: boolean; readonly method: AgentDeviceMethod; readonly answer: AgentDeviceAnswer; readonly input: 'sent' | 'not_sent' | 'unknown'; readonly installs: number }[] = [
    { name: 'an uninstall agent-device refused', had: true, method: 'apps.uninstall', answer: refused, input: 'not_sent', installs: 0 },
    { name: 'an uninstall that failed', had: true, method: 'apps.uninstall', answer: { ...failed, message: 'adb uninstall failed for dev.retest.tasks' }, input: 'unknown', installs: 0 },
    { name: 'an uninstall stopped before it went', had: true, method: 'apps.uninstall', answer: { status: 'stopped', dispatched: 'no', durationMs: 1 }, input: 'not_sent', installs: 0 },
    { name: 'an install refused where there was no app', had: false, method: 'apps.install', answer: refused, input: 'not_sent', installs: 1 },
    { name: 'an install refused after the app was removed', had: true, method: 'apps.install', answer: refused, input: 'sent', installs: 1 },
    { name: 'an install that failed', had: false, method: 'apps.install', answer: failed, input: 'unknown', installs: 1 },
    { name: 'an install that timed out', had: true, method: 'apps.install', answer: { status: 'timeout', message: 'agent-device did not answer apps.install within 5000 ms.', durationMs: 5000 }, input: 'unknown', installs: 1 },
  ]
  for (const entry of cases) {
    const daemon = new StandInDaemon({ booted: true })
    daemon.installed = entry.had
    daemon.answers.set(entry.method, entry.answer)
    const started = await start(t, daemon, { serial: 'emulator-5554' })
    assert.ok(started.ok, started.ok ? '' : started.failure.message)
    const session = await interactionOf(t, started.runtime)
    const installed = await session.install({ appPath: '/work/app-debug.apk' }, 5000)
    assert.ok(!installed.result.ok, entry.name)
    assert.equal(installed.result.failure.class, 'setup_failed', entry.name)
    assert.equal(installed.input, entry.input, entry.name)
    assert.equal(installed.result.failure.details?.['inputSent'], entry.input, entry.name)
    assert.equal(daemon.sent('apps.install').length, entry.installs, `${entry.name}: the install is sent at most once`)
    assert.equal(daemon.sent('apps.reinstall').length, 0, entry.name)
    await started.runtime.close(10_000)
  }
})

test('a device agent-device does not list is refused by name, listing what it does list, and nothing is left', androidHost, async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  const started = await start(t, daemon, { serial: 'emulator-5560' })
  assert.ok(!started.ok)
  assert.equal(started.idle, true)
  assert.match(started.failure.message, /no Android emulator or device with the serial emulator-5560: it lists Pixel_9 \(emulator-5554\)/)
  assert.equal(daemon.closed, 1)
  assert.equal(existsSync(daemon.started[0]?.stateDir ?? ''), false)
})

test('a physical device that is not running is refused: Retest boots only an emulator', androidHost, async (t) => {
  const daemon = new StandInDaemon({ booted: false, kind: 'device' })
  const started = await start(t, daemon, { name: 'Pixel_9' })
  assert.ok(!started.ok)
  assert.match(started.failure.message, /is not running, and Retest boots only an emulator/)
  assert.equal(daemon.sent('devices.boot').length, 0)
})

test('one runtime serves each test of its target: the daemon starts once, and each test removes the app and installs the APK in its session, starting with no data of the one before', androidHost, async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  daemon.saved = 'Saved by an earlier run'
  const started = await start(t, daemon, { serial: 'emulator-5554' })
  assert.ok(started.ok, started.ok ? '' : started.failure.message)
  const { runtime } = started
  for (const attempt of ['a1', 'a2', 'a3']) {
    const session = await interactionOf(t, runtime, attempt)
    const installed = await session.install({ appPath: '/work/app-debug.apk' }, 5000)
    assert.ok(installed.result.ok, installed.result.ok ? '' : `${attempt}: ${installed.result.failure.message}`)
    assert.equal(installed.input, 'sent', attempt)
    assert.equal(daemon.saved, undefined, `${attempt} starts with nothing an earlier test or run saved`)
    const launched = await session.launch(5000)
    assert.ok(launched.result.ok, attempt)
    daemon.saved = `Saved by ${attempt}`
    await session.dispose(5000)
    assert.equal(runtime.reusable(), true, `${attempt}: the runtime can serve the next test`)
  }
  assert.equal(daemon.started.length, 1, "agent-device's daemon starts once")
  const named = daemon.sent('apps.open')[0]?.options['session']
  assert.deepEqual(daemon.sent('apps.uninstall').map((call) => call.options['session']), [named, named, named], 'each test removes the app, in the session that holds the device')
  assert.deepEqual(daemon.sent('apps.install').map((call) => call.options['session']), [named, named, named], 'and installs the APK in it')
  // An install ended any copy of the app, so no launch stops one first.
  assert.deepEqual(daemon.sent('apps.open').map((call) => call.options['relaunch']), [undefined, undefined, undefined])
  assert.equal(daemon.sent('apps.close').length, 0, "a test leaves the app for the next test's install to remove")
  await runtime.close(10_000)
  assert.deepEqual(daemon.calls.slice(-2).map((call) => [call.method, call.options['app'], call.options['session']]), [['apps.close', 'dev.retest.tasks', named], ['sessions.close', undefined, named]], 'the close ends the app the last test left, then the session')
  assert.equal(daemon.closed, 1)
})

test('an APK rebuilt between two tests of one runtime is the build installed, and the identity names it', androidHost, async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  const rebuilt = new Uint8Array([...apk, 9])
  const reads = [apk, apk]
  const started = await start(t, daemon, { serial: 'emulator-5554' }, () => Promise.resolve(reads.shift() ?? rebuilt))
  assert.ok(started.ok, started.ok ? '' : started.failure.message)
  const { runtime } = started
  const first = await interactionOf(t, runtime, 'a1')
  assert.ok((await first.install({ appPath: '/work/app-debug.apk' }, 5000)).result.ok)
  await first.dispose(5000)
  assert.equal(runtime.execution.app.sha256, sha256Hex(apk))
  const second = await interactionOf(t, runtime, 'a2')
  assert.ok((await second.install({ appPath: '/work/app-debug.apk' }, 5000)).result.ok)
  await second.dispose(5000)
  assert.equal(daemon.sent('apps.install').length, 2)
  assert.equal(runtime.execution.app.sha256, sha256Hex(rebuilt), 'the identity names the build now on the device')
  assert.equal(runtime.bundle.sha256, sha256Hex(rebuilt))
  assert.equal(runtime.identity.processIds.length, 0)
})

test('a runtime that lost agent-device, or one of whose calls went unanswered, serves no further test', androidHost, async (t) => {
  const cases: readonly { readonly name: string; readonly answer: AgentDeviceAnswer; readonly connected: boolean }[] = [
    { name: 'agent-device gone', answer: { status: 'lost', message: "agent-device's capture.snapshot failed outside agent-device: the daemon is gone", durationMs: 1 }, connected: false },
    { name: 'a look that timed out', answer: { status: 'timeout', message: 'agent-device did not answer capture.snapshot within 1000 ms.', durationMs: 1000 }, connected: true },
    { name: 'a look stopped once it had gone', answer: { status: 'stopped', dispatched: 'unknown', durationMs: 1 }, connected: true },
  ]
  for (const entry of cases) {
    const daemon = new StandInDaemon({ booted: true })
    const started = await start(t, daemon, { serial: 'emulator-5554' })
    assert.ok(started.ok, started.ok ? '' : started.failure.message)
    const { runtime } = started
    const session = await interactionOf(t, runtime, 'a1')
    assert.ok((await session.install({ appPath: '/work/app-debug.apk' }, 5000)).result.ok)
    assert.ok((await session.launch(5000)).result.ok)
    assert.equal(runtime.reusable(), true, entry.name)
    daemon.answers.set('capture.snapshot', entry.answer)
    const looked = await session.observe({ by: 'testId', value: 'saved_task' }, 1000)
    assert.ok(!looked.ok, entry.name)
    await session.dispose(5000)
    assert.equal(runtime.connected, entry.connected, entry.name)
    assert.equal(runtime.reusable(), false, `${entry.name}: the runtime serves no further test`)
    await runtime.close(10_000).catch(() => undefined)
  }
})
