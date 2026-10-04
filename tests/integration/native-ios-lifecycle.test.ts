import type { TaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import type { NativeAppSession } from '../../src/native/session.ts'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { IosSimulatorRuntime, listSimulators, simulatorAppProcesses } from '../../src/native/ios-simulator.ts'
import { decodePng, distinctColours } from '../../src/native/png.ts'
import { iosSimulatorResetPolicy } from '../../src/native/reset-policy.ts'
import { runCommand, systemTools } from '../../src/native/processes.ts'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { executorBuild, listeningAddresses, listeningOf, logFolder, nativeSkipReason, prepareFixtureService, processesWith, taskPhoneApp, within } from './native-harness.ts'

// The iOS simulator lifecycle on the real simulator, WebDriverAgent and the TaskPhone fixture: a runtime of its own,
// install, launch, state, captures with the session id, terminate, delete and nothing left, and the deliberate cases of
// the lifecycle: a stale reference and a stale executor session, a crash, a cancel after a launch went, and a lost
// executor. Skipped by name on a machine without the pinned Xcode, the iOS 26.5 runtime or the fixture's build.

const skip = await nativeSkipReason('ios-simulator')
const bundleId = 'dev.retest.fixtures.taskphone'
const interrupted = { class: 'interrupted', message: 'The run was interrupted.' } as const

async function startRuntime(logs: string): Promise<IosSimulatorRuntime> {
  const build = await executorBuild('webdriveragent', logs)
  const started = await IosSimulatorRuntime.start({ target: { appPath: taskPhoneApp, device: 'iPhone 17', runtime: '26.5' }, build, tools: systemTools, logFolder: logs, timeoutMs: 600_000 })
  if (!started.ok) throw new Error(started.failure.message)
  return started.runtime
}

async function nothingLeft(runtime: IosSimulatorRuntime): Promise<void> {
  const listed = await listSimulators(systemTools, { timeoutMs: 30_000 })
  assert.ok(Array.isArray(listed))
  assert.equal(listed.some((device) => device.udid === runtime.udid), false, 'the simulator is deleted')
  assert.deepEqual(await processesWith(`/Devices/${runtime.udid}/`), [], 'no process of the simulator is left')
  assert.deepEqual(await listeningAddresses(runtime.port), [], 'nothing listens on the executor port')
}

async function appContainer(runtime: IosSimulatorRuntime): Promise<string> {
  const result = await runCommand(systemTools.xcrun, ['simctl', 'get_app_container', runtime.udid, bundleId, 'data'], { timeoutMs: 30_000 })
  assert.equal(result.code, 0, result.stderr)
  return result.stdout.trim()
}

describe('the iOS simulator lifecycle on a real simulator', { skip }, () => {
  let runtime: IosSimulatorRuntime
  let service: TaskService
  let logs: string
  const owner = (attemptId: string): { runId: string; testId: string; attemptId: string; app: string } => ({ runId: 'native-ios', testId: 'lifecycle', attemptId, app: 'phone' })
  // Every session a test opens is disposed after it, even when the test failed part way, so the next test can open one.
  const sessions: NativeAppSession[] = []
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose(60_000).catch(() => undefined)
  })
  const open = async (attemptId: string): Promise<NativeAppSession> => {
    const opened = await runtime.openSession({ owner: owner(attemptId), launch: { arguments: ['-reset', '-serviceURL', service.url], environment: {} }, redact: (text) => text }, 30_000)
    if (!opened.ok) throw new Error(opened.failure.message)
    sessions.push(opened.session)
    return opened.session
  }

  before(async () => {
    logs = await mkdtemp(join(tmpdir(), 'retest-native-ios-'))
    service = await startTaskService({ port: 0, syncDelayMs: 100 })
    runtime = await startRuntime(logs)
  })

  after(async () => {
    try {
      await runtime.close(180_000)
      await nothingLeft(runtime)
    } finally {
      await service.close()
      await rm(logs, { recursive: true, force: true })
    }
  })

  test('a runtime creates a simulator of its own and starts WebDriverAgent on its own port, bound to 127.0.0.1', async () => {
    const listed = await listSimulators(systemTools, { timeoutMs: 30_000 })
    const device = Array.isArray(listed) ? listed.find((candidate) => candidate.udid === runtime.udid) : undefined
    assert.match(device?.name ?? '', new RegExp(`^retest-native-${process.pid}-[0-9a-f]{8}$`))
    assert.equal(device?.state, 'Booted')
    assert.notEqual(runtime.port, 8100)
    assert.deepEqual(await listeningAddresses(runtime.port), [`127.0.0.1:${runtime.port}`])
    // Nothing of WebDriverAgent listens on every interface: its screen stream found its port held while it started.
    const runnerApp = runtime.identity.processIds[1]
    assert.equal(typeof runnerApp, 'number')
    assert.deepEqual(await listeningOf(runnerApp ?? 0), [`127.0.0.1:${runtime.port}`])
    assert.deepEqual(runtime.execution.os, { name: 'iOS', version: '26.5', build: '23F77' })
    assert.equal(runtime.execution.app.bundleId, bundleId)
    assert.equal(runtime.execution.xcode.build, '17F42')
    assert.deepEqual(runtime.resetPolicy, iosSimulatorResetPolicy.contract)
  })

  test('the host prepares the fixture service, and the app installs, launches with its arguments, captures with the session id and terminates', async () => {
    const { prepared, events } = await prepareFixtureService(service.url, 'phone')
    assert.equal(prepared.failure, undefined)
    assert.equal(prepared.records[0]?.outcome, 'prepared')
    assert.equal(events.some((event) => event.type === 'preparation.finished'), true)
    const session = await open('ios-lifecycle')
    assert.deepEqual(await session.install({ appPath: taskPhoneApp }, 120_000), { result: { ok: true }, input: 'sent' })
    assert.match(session.execution.app.path, new RegExp(`/Devices/${runtime.udid}/data/Containers/Bundle/Application/[^/]+/TaskPhone\\.app$`), 'the result names the copy installed on the simulator')
    assert.deepEqual(await session.launch(120_000), { result: { ok: true }, input: 'sent' })
    assert.deepEqual(await session.appState(10_000), { ok: true, state: 'foreground' })
    const [pid] = session.processIds
    assert.equal(typeof pid, 'number')
    for (const source of ['executor-screen', 'simulator-display'] as const) {
      const shot = await session.capture(30_000, { source })
      assert.ok(shot.ok, shot.ok ? '' : shot.failure.message)
      if (!shot.ok) continue
      assert.deepEqual(shot.capture.reference, { sessionId: 'ios-lifecycle:phone', instance: shot.capture.reference.instance, generation: 1, observationId: shot.capture.reference.observationId })
      const image = decodePng(shot.capture.png)
      assert.deepEqual([image.width, image.height], [1206, 2622], `${source} is the iPhone 17 screen at scale 3`)
      assert.ok(distinctColours(image) > 16, `${source} is a picture, not one colour`)
    }
    const tree = await session.readSource(30_000)
    assert.ok(tree.ok, tree.ok ? '' : tree.failure.message)
    assert.match(tree.ok ? tree.tree.source.xml : '', new RegExp(`^<XCUIElementTypeApplication [^>]*bundleId="${bundleId}"`))
    assert.deepEqual(await session.terminate(60_000), { result: { ok: true }, input: 'sent' })
    assert.deepEqual(await session.appState(10_000), { ok: true, state: 'not_running' })
    assert.deepEqual(await simulatorAppProcesses(systemTools, runtime.udid, bundleId, { timeoutMs: 10_000 }), { ok: true, running: false, pids: [], processes: [] })
    await session.dispose(30_000)
    const cleaned = await prepared.cleanUp(false)
    assert.deepEqual(cleaned.failures, [])
    assert.equal(cleaned.records[0]?.outcome, 'done')
  })

  test('a failed host preparation answers setup_failed before the app is touched', async () => {
    const { prepared } = await prepareFixtureService('http://127.0.0.1:9', 'phone')
    assert.equal(prepared.failure?.class, 'setup_failed')
    assert.equal(prepared.records[0]?.outcome, 'failed')
  })

  test('a relaunch keeps what the app wrote; references from the launch before, or from another session, are refused', async () => {
    const session = await open('ios-relaunch')
    await session.launch(120_000)
    const first = await session.capture(30_000)
    if (!first.ok) throw new Error(first.failure.message)
    const marker = join(await appContainer(runtime), 'Documents', 'retest-lifecycle-marker.txt')
    await mkdir(join(marker, '..'), { recursive: true })
    await writeFile(marker, 'written in the first launch')
    await session.terminate(60_000)
    await session.launch(120_000)
    assert.equal(await access(marker).then(() => true, () => false), true, 'a relaunch cleared nothing the app wrote')
    const stale = session.checkReference(first.capture.reference)
    assert.equal(stale?.class, 'not_actionable')
    assert.match(stale?.message ?? '', /from launch 1; the app is on launch 2/)
    assert.equal(session.checkReference({ ...first.capture.reference, sessionId: 'another:phone', generation: 2 })?.class, 'usage')
    await session.dispose(60_000)
  })

  test('a stale executor session is refused by WebDriverAgent; the session is lost and still ends the app it launched', async () => {
    const session = await open('ios-stale')
    await session.launch(120_000)
    // Another client opens a session, which WebDriverAgent puts in place of this one.
    const intruder = new ExecutorClient({ executor: 'webdriveragent', host: '127.0.0.1', port: runtime.port })
    const replaced = await intruder.createSession({ timeoutMs: 30_000 })
    assert.equal(replaced.status, 'answered')
    const state = await session.appState(10_000)
    assert.equal(!state.ok && state.failure.class, 'session_lost')
    assert.match(!state.ok ? state.failure.message : '', /no longer knows this session/)
    await session.dispose(60_000)
    assert.deepEqual(await simulatorAppProcesses(systemTools, runtime.udid, bundleId, { timeoutMs: 10_000 }), { ok: true, running: false, pids: [], processes: [] })
    if (replaced.status === 'answered') await replaced.value.end({ timeoutMs: 10_000 })
  })

  test('an app that crashes is seen as ended, and activate does not launch it again', async () => {
    const session = await open('ios-crash')
    assert.deepEqual(await session.launch(120_000), { result: { ok: true }, input: 'sent' })
    const [pid] = session.processIds
    if (pid === undefined) throw new Error('the launch named no process')
    // The simulator's processes are the Mac's own, so the app is ended from outside, as a crash ends it.
    process.kill(pid, 'SIGKILL')
    await sleep(500)
    assert.deepEqual(await session.appState(10_000), { ok: true, state: 'not_running' })
    assert.equal(session.appStatus.endedUnexpectedly, true)
    const activated = await session.activate(30_000)
    assert.equal(!activated.result.ok && activated.result.failure.class, 'session_lost')
    assert.equal(activated.input, 'not_sent')
    assert.deepEqual(await simulatorAppProcesses(systemTools, runtime.udid, bundleId, { timeoutMs: 10_000 }), { ok: true, running: false, pids: [], processes: [] }, 'nothing launched it again')
    await session.dispose(30_000)
  })

  test('a cancel after the launch went leaves its outcome unknown, and reconciliation reads where the app stood', async () => {
    const session = await open('ios-cancel')
    const launching = session.launch(120_000)
    // The launch is in flight once the app's process exists: WebDriverAgent answers only after the app has launched.
    let seen = false
    for (let looks = 0; looks < 600 && !seen; looks += 1) {
      const reading = await simulatorAppProcesses(systemTools, runtime.udid, bundleId, { timeoutMs: 5000 })
      seen = reading.ok && reading.running
      if (!seen) await sleep(20)
    }
    assert.equal(seen, true, "the app's process appeared while the launch was in flight")
    session.cancel(interrupted)
    const launched = await launching
    assert.equal(launched.input, 'unknown', 'the cancel came while the launch was in flight')
    assert.equal(!launched.result.ok && launched.result.failure.class, 'interrupted')
    assert.equal(session.unknownOutcomes[0]?.kind, 'launch')
    const [reconciled] = await session.reconcile(10_000)
    assert.equal(reconciled?.reconciled?.ok && reconciled.reconciled.running, true, 'the app the launch started runs')
    // Whatever the launch did on the simulator, disposing ends it.
    await session.dispose(60_000)
    assert.deepEqual(await simulatorAppProcesses(systemTools, runtime.udid, bundleId, { timeoutMs: 10_000 }), { ok: true, running: false, pids: [], processes: [] })
  })

  test('a lost WebDriverAgent loses the open session, and the runtime says so once', async (t) => {
    const session = await open('ios-lost')
    await session.launch(120_000)
    const lost = new Promise<string>((resolve) => runtime.onDisconnect(resolve))
    // The runner app the runtime recorded as its own, and nothing found by a pattern.
    const runnerApp = runtime.identity.processIds[1]
    if (runnerApp === undefined) throw new Error('the runtime recorded no runner app')
    const runners = [{ pid: runnerApp }]
    const killedAt = performance.now()
    for (const runner of runners) process.kill(runner.pid, 'SIGKILL')
    const said = await within(lost, 30_000, 'the runtime did not report the lost runner within 30 s')
    const seenAfterMs = Math.round(performance.now() - killedAt)
    t.diagnostic(`the lost runner app was reported ${seenAfterMs} ms after it was killed`)
    assert.match(said, /runner app \(pid \d+\) ended|xcodebuild ended/)
    assert.ok(seenAfterMs < 5000, 'the loss is seen within seconds, not when xcodebuild gets round to exiting')
    const state = await session.appState(10_000)
    assert.equal(!state.ok && state.failure.class, 'session_lost')
    await session.dispose(60_000)
  })
})

describe('a second runtime starts clean', { skip }, () => {
  test('nothing the app wrote in one runtime is there in the next', async (t) => {
    const logs = await logFolder(t, 'ios-second')
    const first = await startRuntime(logs)
    let marker: string
    try {
      const opened = await first.openSession({ owner: { runId: 'native-ios', testId: 'isolation', attemptId: 'first', app: 'phone' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 30_000)
      if (!opened.ok) throw new Error(opened.failure.message)
      await opened.session.install({ appPath: taskPhoneApp }, 120_000)
      marker = join(await appContainer(first), 'Documents', 'retest-isolation-marker.txt')
      await mkdir(join(marker, '..'), { recursive: true })
      await writeFile(marker, 'written in the first runtime')
      await opened.session.dispose(30_000)
    } finally {
      await first.close(180_000)
    }
    await nothingLeft(first)
    assert.equal(await access(marker).then(() => true, () => false), false, 'the first simulator and its containers are gone')
    const second = await startRuntime(logs)
    try {
      assert.notEqual(second.udid, first.udid)
      const opened = await second.openSession({ owner: { runId: 'native-ios', testId: 'isolation', attemptId: 'second', app: 'phone' }, launch: { arguments: [], environment: {} }, redact: (text) => text }, 30_000)
      if (!opened.ok) throw new Error(opened.failure.message)
      await opened.session.install({ appPath: taskPhoneApp }, 120_000)
      const container = await appContainer(second)
      assert.equal(await access(join(container, 'Documents', 'retest-isolation-marker.txt')).then(() => true, () => false), false)
      await opened.session.dispose(30_000)
    } finally {
      await second.close(180_000)
    }
    await nothingLeft(second)
  })
})
