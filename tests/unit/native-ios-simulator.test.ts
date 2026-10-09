import type { TestContext } from 'node:test'
import type { ExecutorBuild } from '../../src/native/executors.ts'
import type { FakeTools } from './native-fake-tools.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { isListening } from '../../src/native/executor-process.ts'
import { IosSimulatorRuntime, simulatorAppProcesses, sweepOrphanedSimulators } from '../../src/native/ios-simulator.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { OwnedProcess } from '../../src/native/processes.ts'
import { readProcessTable, readProcessTableAsync } from '../../src/shared/process-ownership.ts'
import { alive, readApps, readJsonFile } from './native-fake-executor.ts'
import { fakeAppBundle, fakeTools, fakeWindowProcess, hungProcesses, startedProcesses } from './native-fake-tools.ts'

// An iOS simulator runtime needs macOS with Xcode, and refuses to start anywhere else.
const darwinOnly = { skip: process.platform === 'darwin' ? false : 'iOS simulators run only on macOS' }

const owner = { runId: 'run', testId: 'test', attemptId: 'k3v9q0x2mb', app: 'phone' }
const bundleId = 'dev.retest.fixtures.taskphone'

async function setUp(t: TestContext, tools: Record<string, unknown> = {}): Promise<{ readonly fake: FakeTools; readonly appPath: string; readonly build: ExecutorBuild }> {
  const fake = await fakeTools(t)
  await fake.configure(tools)
  const appPath = await fakeAppBundle(fake.root, { platform: 'ios-simulator', name: 'TaskPhone', bundleId })
  const products = join(fake.root, 'derived', 'Build', 'Products')
  await mkdir(products, { recursive: true })
  const xctestrun = join(products, 'WebDriverAgentRunner_iphonesimulator26.5-arm64-x86_64.xctestrun')
  await writeFile(xctestrun, 'fake test run')
  const build: ExecutorBuild = { schemaVersion: 1, executor: 'webdriveragent', version: '16.13.6', commit: '9d1d17ddb59e6097ddc3324b23ca9f4174507b12', key: 'k', xcode: { version: '26.5', build: '17F42' }, sdk: 'iphonesimulator26.5', architecture: 'arm64', origin: 'built', derivedDataPath: join(fake.root, 'derived'), xctestrun, products: join(products, 'Debug-iphonesimulator'), productsSha256: 'p', xctestrunSha256: 'x', recordedAt: new Date().toISOString(), licenses: [], notices: [] }
  return { fake, appPath, build }
}

function start(setup: { readonly fake: FakeTools; readonly appPath: string; readonly build: ExecutorBuild }, extra: { readonly timeoutMs?: number; readonly signal?: AbortSignal } = {}): ReturnType<typeof IosSimulatorRuntime.start> {
  return IosSimulatorRuntime.start({ target: { appPath: setup.appPath, device: 'iPhone 17', runtime: '26.5' }, build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: extra.timeoutMs ?? 30_000, signal: extra.signal })
}

async function simctlCalls(fake: FakeTools): Promise<string[]> {
  return (await fake.calls()).filter((call) => call.tool === 'xcrun').map((call) => call.args[1] ?? '')
}

function devices(root: string): unknown[] {
  const value = readJsonFile(join(root, 'devices.json'))
  return Array.isArray(value) ? value : []
}

async function nothingLeft(fake: FakeTools): Promise<void> {
  assert.deepEqual(devices(fake.root), [], 'no simulator is left')
  const left = (await startedProcesses(fake.root)).filter(alive)
  assert.deepEqual(left, [], 'no process the fakes started is left')
}

test('a runtime creates its own simulator, boots it, starts WebDriverAgent in it, and deletes it at the end', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  assert.ok(started.ok, started.ok ? '' : started.failure.message)
  if (!started.ok) return
  const runtime = started.runtime
  assert.match(devices(setup.fake.root).map((device) => JSON.stringify(device)).join(), new RegExp(`retest-native-${process.pid}-[0-9a-f]{8}`))
  assert.equal(runtime.identity.kind, 'ios-simulator')
  assert.deepEqual(runtime.execution.app, { bundleId, version: '2.1', build: '42', path: setup.appPath, sha256: runtime.bundle.sha256 })
  assert.deepEqual(runtime.execution.os, { name: 'iOS', version: '26.5', build: '23F77' })
  const opened = await runtime.openSession({ owner, launch: { arguments: ['-reset'], environment: {} }, redact: (text) => text }, 5000)
  assert.ok(opened.ok)
  if (!opened.ok) return
  const session = opened.session
  assert.deepEqual(await session.install({ appPath: setup.appPath }, 10_000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(await session.launch(10_000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(await session.appState(5000), { ok: true, state: 'foreground' })
  const executorShot = await session.capture(5000)
  const displayShot = await session.capture(5000, { source: 'simulator-display' })
  assert.equal(executorShot.ok && executorShot.capture.reference.sessionId, 'k3v9q0x2mb:phone')
  assert.equal(displayShot.ok && displayShot.capture.source, 'simulator-display')
  assert.deepEqual(await session.terminate(10_000), { result: { ok: true }, input: 'sent' })
  await session.dispose(10_000)
  await runtime.close(30_000)
  // spawn reads the app's processes: after the launch, before the terminate (whose copies are whose), after it, and at
  // dispose, which finds none of the session's own left.
  assert.deepEqual(await simctlCalls(setup.fake), ['list', 'list', 'list', 'create', 'boot', 'bootstatus', 'install', 'get_app_container', 'spawn', 'io', 'spawn', 'spawn', 'spawn', 'shutdown', 'delete', 'list'])
  const xcodebuild = (await setup.fake.calls()).filter((call) => call.tool === 'xcodebuild').map((call) => call.args[0])
  assert.deepEqual(xcodebuild, ['-version', 'test-without-building'])
  await nothingLeft(setup.fake)
})

test('a runtime that is not in the tested set fails setup before anything is created', darwinOnly, async (t) => {
  const setup = await setUp(t, { runtimes: [{ version: '26.5', build: '23F99' }] })
  const started = await start(setup)
  assert.equal(!started.ok && started.failure.class, 'setup_failed')
  assert.match(!started.ok ? started.failure.message : '', /not in the tested set/)
  assert.equal((await simctlCalls(setup.fake)).includes('create'), false)
})

test('an Xcode other than the pinned build fails setup before simctl runs', darwinOnly, async (t) => {
  const setup = await setUp(t, { xcodeBuild: '17F43' })
  const started = await start(setup)
  assert.match(!started.ok ? started.failure.message : '', /pinned to Xcode 26.5 \(17F42\)/)
  assert.deepEqual(await simctlCalls(setup.fake), [])
})

test('a refused bootstatus whose created simulator was proved removed releases startup ownership', darwinOnly, async (t) => {
  const setup = await setUp(t, { simctl: { bootstatus: { fail: 'boot status unavailable' } } })
  const started = await start(setup)
  assert.equal(started.ok, false)
  if (started.ok) throw new Error('expected the bootstatus refusal')
  assert.equal(started.failure.class, 'setup_failed')
  assert.match(started.failure.message, /bootstatus.*boot status unavailable/)
  assert.equal(started.idle, undefined, 'idle must still mean the start created nothing')
  assert.equal(started.cleaned, true, 'proved cleanup must release the failed startup lease')
  await nothingLeft(setup.fake)
})

test('a refused bootstatus whose simulator deletion is unproved keeps startup ownership held', darwinOnly, async (t) => {
  const setup = await setUp(t, { simctl: { bootstatus: { fail: 'boot status unavailable' }, delete: { fail: 'deletion unavailable' } } })
  const started = await start(setup)
  assert.equal(started.ok, false)
  if (started.ok) throw new Error('expected the bootstatus refusal')
  assert.notEqual(started.idle, true)
  assert.notEqual(started.cleaned, true)
  assert.match(String(started.failure.details?.['also']), /cleanup_failed.*deletion unavailable/)
})

for (const step of ['create', 'boot', 'bootstatus'] as const) {
  test(`a start stopped during ${step} removes what it made and leaves no process`, darwinOnly, async (t) => {
    const setup = await setUp(t, { simctl: { [step]: { hang: true } } })
    const stop = new AbortController()
    // The stop comes once the step hangs, with the child it started running. A stop that lands while the fake is still
    // starting that child can leave it with a parent already ended before Retest read it; Retest then leaves the child
    // alone and reports it, as a process it cannot trace to its launch, which is not this case.
    const watching = setInterval(async () => {
      if ((await simctlCalls(setup.fake)).includes(step) && (await hungProcesses(setup.fake.root)).length > 0) stop.abort({ class: 'interrupted', message: 'The run was interrupted.' })
    }, 50)
    t.after(() => clearInterval(watching))
    const started = await start(setup, { signal: stop.signal })
    assert.equal(started.ok, false)
    await setup.fake.configure({})
    // This fake stops before it creates a device. If a create actually made one without answering its id, its name
    // would not prove ownership and Retest would report it instead of deleting it.
    await nothingLeft(setup.fake)
  })
}

test('a start stopped while WebDriverAgent comes up ends xcodebuild and deletes the simulator', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'hang' })
  const stop = new AbortController()
  // As for a stopped simctl step: the stop comes once xcodebuild hangs, with the child it started running.
  const watching = setInterval(async () => {
    const calls = await setup.fake.calls()
    if (calls.some((call) => call.tool === 'xcodebuild' && call.args[0] === 'test-without-building') && (await hungProcesses(setup.fake.root)).length > 0) {
      clearInterval(watching)
      stop.abort({ class: 'interrupted', message: 'The run was interrupted.' })
    }
  }, 50)
  t.after(() => clearInterval(watching))
  const started = await start(setup, { signal: stop.signal })
  assert.equal(!started.ok && started.failure.class, 'interrupted')
  await nothingLeft(setup.fake)
})

test('WebDriverAgent that fails to start fails setup naming its log, and the simulator is deleted', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'fail' })
  const started = await start(setup)
  assert.equal(!started.ok && started.failure.class, 'setup_failed')
  assert.match(!started.ok ? started.failure.message : '', /executor log is .*webdriveragent\.log/)
  await nothingLeft(setup.fake)
})

test('a start that runs out of time fails setup and leaves nothing', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'hang' })
  const started = await start(setup, { timeoutMs: 3000 })
  assert.match(!started.ok ? started.failure.message : '', /did not answer \/status within/)
  await nothingLeft(setup.fake)
})

test('a lost WebDriverAgent tells the runtime once and loses its session', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  assert.ok(started.ok)
  if (!started.ok) return
  const runtime = started.runtime
  t.after(() => runtime.close(30_000).catch(() => undefined))
  const opened = await runtime.openSession({ owner, launch: { arguments: [], environment: {} }, redact: (text) => text }, 5000)
  assert.ok(opened.ok)
  if (!opened.ok) return
  const lost = new Promise<string>((resolve) => runtime.onDisconnect(resolve))
  const runners = readJsonFile(join(setup.fake.root, 'processes.json'))
  for (const entry of Array.isArray(runners) ? runners : []) if (typeof entry === 'object' && entry !== null && 'pid' in entry && typeof entry.pid === 'number') process.kill(entry.pid, 'SIGKILL')
  assert.match(await lost, /runner app \(pid \d+\) ended|xcodebuild ended/)
  assert.equal(runtime.connected, false)
  const launched = await opened.session.launch(5000)
  assert.equal(!launched.result.ok && launched.result.failure.class, 'session_lost')
  assert.equal(launched.input, 'not_sent')
})

test('an app that crashes after its launch is seen as ended, and is not launched again by activate', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  assert.ok(started.ok)
  if (!started.ok) return
  t.after(() => started.runtime.close(30_000).catch(() => undefined))
  const opened = await started.runtime.openSession({ owner, launch: { arguments: [], environment: {} }, redact: (text) => text }, 5000)
  assert.ok(opened.ok)
  if (!opened.ok) return
  assert.deepEqual(await opened.session.launch(10_000), { result: { ok: true }, input: 'sent' })
  const pid = opened.session.processIds[0]
  assert.ok(pid !== undefined, 'the parent recorded the launched app before its simulated crash')
  assert.equal(readApps(setup.fake.root)[bundleId]?.pid, pid, 'the crashed process is this fixture app')
  process.kill(pid, 'SIGKILL')
  for (let tries = 0; tries < 100 && alive(pid); tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(alive(pid), false, 'the fake app ended after the parent acknowledged launch')
  const reading = await simulatorAppProcesses(setup.fake.tools, started.runtime.udid, bundleId, { timeoutMs: 5000 })
  assert.deepEqual(reading, { ok: true, running: false, pids: [], processes: [] })
  assert.deepEqual(await opened.session.appState(5000), { ok: true, state: 'not_running' })
  assert.equal(opened.session.appStatus.endedUnexpectedly, true)
  const activated = await opened.session.activate(5000)
  assert.equal(!activated.result.ok && activated.result.failure.class, 'session_lost')
  assert.equal(Object.values(readApps(setup.fake.root)).filter((app) => alive(app.pid)).length, 0, 'nothing relaunched it')
})

test('a second session waits for the first to be disposed', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  assert.ok(started.ok)
  if (!started.ok) return
  t.after(() => started.runtime.close(30_000).catch(() => undefined))
  const first = await started.runtime.openSession({ owner, launch: { arguments: [], environment: {} }, redact: (text) => text }, 5000)
  assert.ok(first.ok)
  const waited = await started.runtime.openSession({ owner: { ...owner, attemptId: 'second' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 300)
  assert.match(!waited.ok ? waited.failure.message : '', /stayed open for 300 ms/)
  const second = started.runtime.openSession({ owner: { ...owner, attemptId: 'second' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 5000)
  if (first.ok) await first.session.dispose(5000)
  assert.equal((await second).ok, true)
})

test('the sweep reports an orphan name without claiming or deleting its device', async (t) => {
  const setup = await setUp(t)
  const gone = spawn('true')
  await new Promise((resolve) => gone.once('exit', resolve))
  const records = [
    { udid: 'AAAAAAAA-0000-0000-0000-000000000001', name: `retest-native-${gone.pid}-0011aabb`, state: 'Booted', runtime: 'iOS-26-5' },
    { udid: 'AAAAAAAA-0000-0000-0000-000000000002', name: `retest-native-${process.pid}-0011aabb`, state: 'Booted', runtime: 'iOS-26-5' },
    { udid: 'AAAAAAAA-0000-0000-0000-000000000003', name: 'iPhone 17', state: 'Shutdown', runtime: 'iOS-26-5' },
  ]
  await writeFile(join(setup.fake.root, 'devices.json'), JSON.stringify(records))
  const swept = await sweepOrphanedSimulators(setup.fake.tools, { timeoutMs: 10_000 })
  // It reports and claims no deletion: the answer holds nothing but the reports.
  assert.deepEqual(Object.keys(swept), ['problems'])
  assert.equal(swept.problems.length, 1)
  assert.match(swept.problems[0] ?? '', /no retained ownership record/)
  assert.match(swept.problems[0] ?? '', /remove it with `xcrun simctl delete AAAAAAAA-0000-0000-0000-000000000001`/)
  assert.deepEqual(devices(setup.fake.root), records)
  assert.equal((await simctlCalls(setup.fake)).some((call) => call === 'shutdown' || call === 'delete'), false)
})

test('WebDriverAgent\'s screen stream finds its port held while it starts, and nothing listens on it afterwards', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  assert.ok(started.ok, started.ok ? '' : started.failure.message)
  if (!started.ok) return
  t.after(() => started.runtime.close(30_000).catch(() => undefined))
  const xcodebuild = (await setup.fake.calls()).find((call) => call.tool === 'xcodebuild' && call.args[0] === 'test-without-building')
  assert.ok(xcodebuild !== undefined)
  const log = await readFile(join(setup.fake.root, 'logs', `${started.runtime.execution.device?.name ?? ''}-webdriveragent.log`), 'utf8')
  const port = Number(/Cannot init screenshots broadcaster service on port (\d+)/.exec(log)?.[1])
  assert.ok(Number.isInteger(port) && port > 0, 'the stream could not take its port')
  assert.equal(await isListening('127.0.0.1', port), false, 'nothing serves the stream port once the runtime runs')
})

test('an install from another path names the build that was installed', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  if (!started.ok) throw new Error(started.failure.message)
  t.after(() => started.runtime.close(30_000).catch(() => undefined))
  const opened = await started.runtime.openSession({ owner, launch: { arguments: [], environment: {} }, redact: (text) => text }, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  const newer = join(setup.fake.root, 'newer')
  await mkdir(newer)
  const other = await fakeAppBundle(newer, { platform: 'ios-simulator', name: 'TaskPhone', bundleId })
  await writeFile(join(other, 'Info.plist'), JSON.stringify({ CFBundleIdentifier: bundleId, CFBundleExecutable: 'TaskPhone', CFBundleShortVersionString: '3.0', CFBundleVersion: '77', CFBundleSupportedPlatforms: ['iPhoneSimulator'] }))
  assert.deepEqual(await opened.session.install({ appPath: other }, 10_000), { result: { ok: true }, input: 'sent' })
  // Named from the copy in the simulator's app container, read after the install.
  const installed = opened.session.execution.app
  assert.match(installed.path, /\/containers\/[0-9A-F-]+\/dev\.retest\.fixtures\.taskphone\.app$/)
  assert.deepEqual([installed.version, installed.build], ['3.0', '77'])
  const { runtime } = opened.session.identity
  assert.equal('appPath' in runtime ? runtime.appPath : undefined, installed.path)
  await opened.session.dispose(5000)
})

test('a start whose screen stream comes up anyway fails, for want of the line that says it did not', darwinOnly, async (t) => {
  const setup = await setUp(t, { streamIgnoresHold: true })
  const started = await start(setup)
  assert.equal(started.ok, false)
  assert.match(!started.ok ? started.failure.message : '', /WebDriverAgent started its screen stream although its port \d+ was held/)
  await nothingLeft(setup.fake)
})

test('a close that cannot read the processes says so, never that nothing is left', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  if (!started.ok) throw new Error(started.failure.message)
  await setup.fake.configure({ psFails: true })
  await assert.rejects(started.runtime.close(30_000), /could not check that nothing of the simulator is left/)
  await setup.fake.configure({})
})

// The pids that were sent SIGTERM, as the fake runner apps note them.
async function signalled(root: string): Promise<number[]> {
  return (await readFile(join(root, 'signals.txt'), 'utf8').catch(() => '')).split('\n').filter((line) => line.endsWith(' SIGTERM')).map((line) => Number.parseInt(line, 10))
}

function runnerApps(root: string): number[] {
  const listed = readJsonFile(join(root, 'processes.json'))
  return (Array.isArray(listed) ? listed : []).flatMap((entry) => (isPlainObject(entry) && typeof entry['pid'] === 'number' && typeof entry['command'] === 'string' && entry['command'].includes('WebDriverAgentRunner-Runner.app') ? [entry['pid']] : []))
}

test('a start that fails after WebDriverAgent came up ends the runner app it recorded itself, when nothing else ends it', darwinOnly, async (t) => {
  const setup = await setUp(t, { streamIgnoresHold: true, runnerSurvivesXcodebuild: true, shutdownLeavesProcesses: true })
  const started = await start(setup)
  assert.match(!started.ok ? started.failure.message : '', /started its screen stream although its port \d+ was held/)
  const runner = runnerApps(setup.fake.root)
  assert.equal(runner.length, 1)
  assert.deepEqual(await signalled(setup.fake.root), runner, 'Retest sent the recorded runner app its SIGTERM')
  await nothingLeft(setup.fake)
})

test('a start whose runner app never answers ends that runner app itself, when xcodebuild\'s end does not', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'runner-not-ready', runnerSurvivesXcodebuild: true, shutdownLeavesProcesses: true })
  const started = await start(setup, { timeoutMs: 4000 })
  assert.match(!started.ok ? started.failure.message : '', /did not answer \/status within/)
  assert.doesNotMatch(!started.ok ? String(started.failure.details?.['also'] ?? '') : '', /could not tie/, 'the runner app tied to the start is not reported as untied')
  const runner = runnerApps(setup.fake.root)
  assert.equal(runner.length, 1)
  assert.deepEqual(await signalled(setup.fake.root), runner)
  await nothingLeft(setup.fake)
})

test('the build a session installed is what later sessions of the runtime name', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  if (!started.ok) throw new Error(started.failure.message)
  t.after(() => started.runtime.close(30_000).catch(() => undefined))
  const first = await started.runtime.openSession({ owner, launch: { arguments: [], environment: {} }, redact: (text) => text }, 5000)
  if (!first.ok) throw new Error(first.failure.message)
  const newer = join(setup.fake.root, 'newer')
  await mkdir(newer)
  const other = await fakeAppBundle(newer, { platform: 'ios-simulator', name: 'TaskPhone', bundleId })
  await writeFile(join(other, 'Info.plist'), JSON.stringify({ CFBundleIdentifier: bundleId, CFBundleExecutable: 'TaskPhone', CFBundleShortVersionString: '3.0', CFBundleVersion: '77', CFBundleSupportedPlatforms: ['iPhoneSimulator'] }))
  assert.deepEqual(await first.session.install({ appPath: other }, 10_000), { result: { ok: true }, input: 'sent' })
  const installed = first.session.execution.app
  await first.session.dispose(5000)
  const second = await started.runtime.openSession({ owner: { ...owner, attemptId: 'second' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 5000)
  if (!second.ok) throw new Error(second.failure.message)
  assert.deepEqual(second.session.execution.app, installed, 'the second session names the copy installed on the simulator')
  assert.deepEqual([started.runtime.execution.app.version, started.runtime.execution.app.build], ['3.0', '77'])
  assert.deepEqual(await second.session.launch(10_000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(second.session.processIds, [readApps(setup.fake.root)[bundleId]?.pid])
  await second.session.dispose(5000)
})

test('a runtime never runs WebDriverAgent on its default port', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await IosSimulatorRuntime.start({ target: { appPath: setup.appPath, device: 'iPhone 17', runtime: '26.5' }, build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 30_000, port: 8100 })
  assert.match(!started.ok ? started.failure.message : '', /Port 8100 is an executor's default port/)
  assert.equal((await setup.fake.calls()).some((call) => call.tool === 'xcodebuild' && call.args[0] === 'test-without-building'), false)
  await nothingLeft(setup.fake)
})


test('a simulator leftover discovered from its command path is reported and never signalled', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  if (!started.ok) throw new Error(started.failure.message)
  const pid = await fakeWindowProcess(setup.fake, `/usr/bin/tail -f /Devices/${started.runtime.udid}/user-owned.log`)
  // The close first stops the runner and runs simctl shutdown, delete and list, each a fresh Node process of the fake
  // tools, and only then looks for leftovers, which it waits for until under 2 s of its time is left. A 1 s close spent
  // all of it on a hosted macOS runner before the leftover check could read anything. This much pays for those steps on
  // a slow machine and leaves the check the time to read the processes and report what it found.
  await assert.rejects(started.runtime.close(5000), /not recorded as this runtime's launch; Retest did not end it/)
  assert.equal(alive(pid), true, 'the toy process is owned by this unit test, never by the runtime under test')
})

test('a failed simulator list after deletion remains a cleanup failure', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await start(setup)
  if (!started.ok) throw new Error(started.failure.message)
  await setup.fake.configure({ simctl: { list: { fail: 'device list unavailable' } } })
  await assert.rejects(started.runtime.close(5000), /could not check that the simulator .* was removed/)
})

test('an orphan simulator without retained ownership stops startup before creation', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const gone = spawn('true')
  await new Promise((resolve) => gone.once('exit', resolve))
  await writeFile(join(setup.fake.root, 'devices.json'), JSON.stringify([{ udid: 'AAAAAAAA-0000-0000-0000-000000000001', name: `retest-native-${gone.pid}-0011aabb`, state: 'Booted', runtime: 'iOS-26-5' }]))
  const started = await start(setup)
  assert.match(!started.ok ? started.failure.message : '', /no retained ownership record/)
  const called = await simctlCalls(setup.fake)
  assert.equal(called.some((call) => ['create', 'shutdown', 'delete'].includes(call)), false)
})


test('an unanswered create reports its unclaimed device and never adopts a name for deletion', darwinOnly, async (t) => {
  const setup = await setUp(t, { createNeverAnswers: true })
  const stop = new AbortController()
  const watching = setInterval(() => {
    if (devices(setup.fake.root).length > 0) stop.abort({ class: 'interrupted', message: 'Stopped after creation before its answer.' })
  }, 20)
  t.after(() => clearInterval(watching))
  const started = await start(setup, { signal: stop.signal })
  assert.equal(started.ok, false)
  assert.match(!started.ok ? String(started.failure.details?.['also'] ?? '') : '', /cleanup_failed: .*id was never recorded/)
  assert.equal(devices(setup.fake.root).length, 1)
  assert.equal((await simctlCalls(setup.fake)).some((call) => call === 'shutdown' || call === 'delete'), false)
})

test('an iOS start refused before any simulator could exist says it left nothing behind', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const wrong = await IosSimulatorRuntime.start({ target: { appPath: setup.appPath, device: 'iPhone 17', runtime: '26.5' }, build: { ...setup.build, executor: 'mac2' }, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 30_000 })
  assert.deepEqual(!wrong.ok && wrong.idle, true, 'the wrong executor')
  const missing = await IosSimulatorRuntime.start({ target: { appPath: setup.appPath, device: 'iPhone 17', runtime: '27.0' }, build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 30_000 })
  assert.match(!missing.ok ? missing.failure.message : '', /No iOS 27\.0 simulator runtime is available/)
  assert.equal(!missing.ok && missing.idle, true, 'a missing runtime')
  const gone = spawn('true')
  await new Promise((resolve) => gone.once('exit', resolve))
  await writeFile(join(setup.fake.root, 'devices.json'), JSON.stringify([{ udid: 'AAAAAAAA-0000-0000-0000-000000000001', name: `retest-native-${gone.pid}-0011aabb`, state: 'Booted', runtime: 'iOS-26-5' }]))
  const orphan = await start(setup)
  assert.equal(!orphan.ok && orphan.idle, true, 'an orphan simulator refuses before creating one')
  await setup.fake.configure({ xcodeBuild: '17A1' })
  const xcode = await start(setup)
  assert.equal(!xcode.ok && xcode.idle, true, 'another Xcode')
  assert.equal((await simctlCalls(setup.fake)).includes('create'), false)
})

test('an iOS start that created its simulator never says it left nothing behind', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'fail' })
  const failed = await start(setup)
  assert.equal(failed.ok, false)
  assert.equal(!failed.ok && failed.idle, undefined)
  await nothingLeft(setup.fake)
})


test('iOS close accepts a confirmed ownership reading within the cleanup budget and leaves no runtime to hold a lease', darwinOnly, async (t) => {
  const launch = OwnedProcess.start.bind(OwnedProcess)
  let cleaning = false
  t.mock.method(OwnedProcess, 'start', (options: Parameters<typeof OwnedProcess.start>[0]) => launch({
    ...options,
    ownershipSystem: {
      read: (deadline) => readProcessTable(deadline),
      readAsync: async (deadline) => {
        // A loaded host can answer after the short output-deletion wait, while still inside native close's budget.
        // The reply is a real complete table. An expired cleanup budget must still refuse it.
        if (cleaning) await sleep(3500)
        return readProcessTableAsync(deadline)
      },
      signal: (pid, signal) => { process.kill(pid, signal) },
    },
  }))
  const setup = await setUp(t)
  const started = await start(setup)
  if (!started.ok) throw new Error(started.failure.message)
  cleaning = true
  await started.runtime.close(30_000)
  assert.equal(started.runtime.connected, false)
  assert.equal(await isListening('127.0.0.1', started.runtime.port), false)
  await nothingLeft(setup.fake)
})
