import type { LoadedAgentDeviceTarget } from '../../src/config/loaded.ts'
import type { AgentDeviceAnswer, AgentDeviceHost, AgentDeviceMethod, AgentDeviceStarter } from '../../src/native/agent-device/package.ts'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { test, type TestContext } from 'node:test'
import { AgentDeviceRuntime } from '../../src/native/agent-device/runtime.ts'
import { systemTools } from '../../src/native/processes.ts'
import { sha256Hex } from '../../src/shared/sha256.ts'

// The Android runtime against a stand-in for agent-device: finding the emulator or device a target names, booting an
// emulator only when it is not running and shutting down only one it booted, installing the APK afresh and checking
// the package it installed, and closing everything it started. No Android SDK, emulator or device runs here; these are
// the only checks of the Android path, which has not run on a real emulator or device.

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const apk = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])

type Call = { readonly method: AgentDeviceMethod; readonly options: Readonly<Record<string, unknown>> }

/** agent-device's daemon as the runtime sees it: devices it lists, what it installs, every call it gets, and its close. */
class StandInDaemon {
  readonly calls: Call[] = []
  readonly started: { readonly stateDir: string; readonly env: Readonly<Record<string, string>> }[] = []
  booted: boolean
  closed = 0
  installs = 'dev.retest.tasks'
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
        return answered({ app: options['app'], appPath: options['appPath'], platform: 'android', package: this.installs, identifiers: {} })
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
async function start(t: TestContext, daemon: StandInDaemon, device: { readonly name: string } | { readonly serial: string }): ReturnType<typeof AgentDeviceRuntime.start> {
  const started = await AgentDeviceRuntime.start({ target: androidTarget(device), tools: { ...systemTools, hiddenVariables: ['RETEST_SECRET_VARIABLE'] }, timeoutMs: 30_000, redact: (text) => text, starter: daemon.starter, readBytes: () => Promise.resolve(apk) })
  if (started.ok) t.after(() => started.runtime.close(10_000))
  return started
}

test('an emulator that is not running is booted, named in the identity, and shut down at the end with the daemon and its folder', async (t) => {
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

test('a running device named by serial is used as it is: nothing is booted, and nothing is shut down', async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  const started = await start(t, daemon, { serial: 'emulator-5554' })
  assert.ok(started.ok, started.ok ? '' : started.failure.message)
  assert.equal(daemon.sent('devices.boot').length, 0)
  await started.runtime.close(10_000)
  assert.equal(daemon.sent('sessions.close')[0]?.options['shutdown'], undefined)
})

test('the APK is installed afresh through agent-device, and an install of another package is refused before any launch', async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  const started = await start(t, daemon, { serial: 'emulator-5554' })
  assert.ok(started.ok)
  const opened = await started.runtime.openInteraction({ owner: { runId: 'r', testId: 't', attemptId: 'a1', app: 'tasks' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 1000, new AbortController().signal)
  assert.ok(opened.ok)
  const session = opened.value
  assert.equal(session.platform, 'android')
  const installed = await session.install({ appPath: '/work/app-debug.apk' }, 5000)
  assert.ok(installed.result.ok)
  assert.deepEqual(daemon.sent('apps.reinstall')[0]?.options, { platform: 'android', serial: 'emulator-5554', app: 'dev.retest.tasks', appPath: '/work/app-debug.apk' })
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

test('a device agent-device does not list is refused by name, listing what it does list, and nothing is left', async (t) => {
  const daemon = new StandInDaemon({ booted: true })
  const started = await start(t, daemon, { serial: 'emulator-5560' })
  assert.ok(!started.ok)
  assert.equal(started.idle, true)
  assert.match(started.failure.message, /no Android emulator or device with the serial emulator-5560: it lists Pixel_9 \(emulator-5554\)/)
  assert.equal(daemon.closed, 1)
  assert.equal(existsSync(daemon.started[0]?.stateDir ?? ''), false)
})

test('a physical device that is not running is refused: Retest boots only an emulator', async (t) => {
  const daemon = new StandInDaemon({ booted: false, kind: 'device' })
  const started = await start(t, daemon, { name: 'Pixel_9' })
  assert.ok(!started.ok)
  assert.match(started.failure.message, /is not running, and Retest boots only an emulator/)
  assert.equal(daemon.sent('devices.boot').length, 0)
})
