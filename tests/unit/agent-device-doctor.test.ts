import type { LoadedAgentDeviceTarget } from '../../src/config/loaded.ts'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { checkAgentDeviceTarget, checkNativeTarget } from '../../src/cli/install/doctor-rows.ts'
import { agentDeviceVersion } from '../../src/native/agent-device/package.ts'
import { screenshotSource } from '../../src/runner/test-pages.ts'

// What `doctor` says of a target driven through agent-device, which it reads without starting anything, and what
// takes such a session's failure screenshot.

const subject = { group: 'phone', subject: "{ platform: 'ios-simulator', driver: 'agent-device' }" }
const loader = (version: string) => () => Promise.resolve({ module: { startAgentDevice: () => Promise.reject(new Error('doctor starts nothing')) }, version })

test("doctor names the installed agent-device and the app, or what is missing, and starts nothing", async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-doctor-agent-device-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const app = join(folder, 'TaskPhone.app')
  await mkdir(app)
  const apk = join(folder, 'app-debug.apk')
  await writeFile(apk, 'PK')
  const ios: LoadedAgentDeviceTarget = { name: 'ios-simulator', platform: 'ios-simulator', appPath: app, device: 'iPhone 17', runtime: '26.5', driver: 'agent-device' }
  const android: LoadedAgentDeviceTarget = { name: 'android', platform: 'android', appPath: apk, package: 'com.example.tasks', device: { serial: 'emulator-5554' }, driver: 'agent-device' }
  const ready = await checkAgentDeviceTarget(subject, ios, loader(agentDeviceVersion))
  assert.deepEqual(ready, { ...subject, ok: true, text: `agent-device ${agentDeviceVersion} is installed, and the app is there; doctor starts neither` })
  const androidRow = await checkAgentDeviceTarget(subject, android, loader(agentDeviceVersion))
  assert.ok(androidRow.ok)
  assert.match(androidRow.text, /has not run on a real emulator or device yet/)
  const other = await checkAgentDeviceTarget(subject, ios, loader('0.20.0'))
  assert.ok(!other.ok)
  assert.match(other.text, /installed agent-device is 0\.20\.0/)
  const missing = await checkAgentDeviceTarget(subject, { ...ios, appPath: join(folder, 'Missing.app') }, loader(agentDeviceVersion))
  assert.ok(!missing.ok && /No app at/.test(missing.text))
  // A native target's row goes to the agent-device row when the target runs through it.
  const routed = await checkNativeTarget({ app: 'phone', subject: subject.subject, target: android, env: {} }, { loadAgentDevice: loader(agentDeviceVersion) })
  assert.ok(routed.ok && /APK is there/.test(routed.text))
})

test("an iOS session through agent-device is captured from the simulator's display; an Android one by agent-device's screenshot", () => {
  const executor = { name: 'agent-device', version: agentDeviceVersion, package: 'agent-device' } as const
  const app = { bundleId: 'dev.retest.fixtures.taskphone', path: '/TaskPhone.app', sha256: '0'.repeat(64) }
  assert.equal(screenshotSource({ kind: 'ios-simulator', bundleId: app.bundleId, appPath: app.path, device: 'iPhone 17', runtime: 'iOS 26.5', processIds: [], execution: { platform: 'ios-simulator', app, os: { name: 'iOS', version: '26.5', build: '23F77' }, executor } }), 'simulator-display')
  assert.equal(screenshotSource({ kind: 'android', bundleId: 'com.example.tasks', appPath: '/app.apk', device: 'Pixel_9', processIds: [], execution: { platform: 'android', app, os: { name: 'Android', version: '16', build: 'unreported' }, executor } }), 'executor-screen')
  assert.equal(screenshotSource({ kind: 'ios-simulator', bundleId: app.bundleId, appPath: app.path, device: 'iPhone 17', runtime: 'iOS 26.5', processIds: [] }), 'executor-screen', "WebDriverAgent's sessions keep their executor screenshot")
})
