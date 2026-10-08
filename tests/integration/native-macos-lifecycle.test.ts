import type { TaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import type { MacosAppRuntime } from '../../src/native/macos-app.ts'
import type { NativeAppSession } from '../../src/native/session.ts'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { automationOverlayPids, coveringWindows, MacosDesktop, macosAppProcesses, windowsOnScreen } from '../../src/native/macos-app.ts'
import { decodePng, distinctColours } from '../../src/native/png.ts'
import { macosResetPolicy } from '../../src/native/reset-policy.ts'
import { endRecorded, runCommand, systemTools } from '../../src/native/processes.ts'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { executorBuild, listeningAddresses, mainScreen, nativeSkipReason, prepareFixtureService, processesWith, taskDeskApp, within } from './native-harness.ts'

// The macOS app lifecycle on the real macOS runner and the TaskDesk fixture. It takes the desktop: run it only under the
// heavy gate lock, so nothing else drives the desktop at the same time. It opens TaskDesk's one window and closes it,
// and shows no dialog: a Mac whose Automation Mode would ask an administrator skips it by name.

const skip = (await nativeSkipReason('macos')) ?? ((await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk')).length > 0 ? 'TaskDesk is already running; this test never touches a copy it did not start' : undefined)
const bundleId = 'dev.retest.fixtures.taskdesk'
const marker = 'retestLifecycleMarker'
const interrupted = { class: 'interrupted', message: 'The run was interrupted.' } as const
// What lay over TaskDesk's window when it was captured, kept so the run's output says it.
let coveredOnThisMac: { layer: number; width: number; height: number }[] = []

async function defaultsRead(): Promise<string | undefined> {
  const result = await runCommand('/usr/bin/defaults', ['read', bundleId, marker], { timeoutMs: 10_000 })
  return result.code === 0 ? result.stdout.trim() : undefined
}

describe('the macOS app lifecycle on the real macOS runner', { skip }, () => {
  let desktop: MacosDesktop
  let app: MacosAppRuntime
  let service: TaskService
  let logs: string
  let executable: string
  // Every session a test opens is disposed after it, even when the test failed part way, so the next test can open one.
  const sessions: NativeAppSession[] = []
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.dispose(60_000).catch(() => undefined)
  })
  const open = async (attemptId: string, launchArguments: readonly string[]): Promise<NativeAppSession> => {
    const opened = await app.openSession({ owner: { runId: 'native-macos', testId: 'lifecycle', attemptId, app: 'desk' }, launch: { arguments: launchArguments, environment: {} }, redact: (text) => text }, 30_000)
    if (!opened.ok) throw new Error(opened.failure.message)
    sessions.push(opened.session)
    return opened.session
  }
  const deskProcesses = async (): Promise<number[]> => (await processesWith(executable)).map((entry) => entry.pid)

  before(async () => {
    logs = await mkdtemp(join(tmpdir(), 'retest-native-macos-'))
    executable = join(await realpath(taskDeskApp), 'Contents', 'MacOS', 'TaskDesk')
    service = await startTaskService({ port: 0, syncDelayMs: 100 })
    const build = await executorBuild('mac2', logs)
    const started = await MacosDesktop.start({ build, tools: systemTools, logFolder: logs, timeoutMs: 180_000 })
    if (!started.ok) throw new Error(started.failure.message)
    desktop = started.desktop
    const opened = await desktop.openApp(taskDeskApp)
    if (!opened.ok) throw new Error(opened.failure.message)
    app = opened.runtime
  })

  after(async () => {
    try {
      await desktop.close(60_000)
      assert.deepEqual(await processesWith(join(desktop.build.products, 'WebDriverAgentRunner-Runner.app')), [], 'no runner is left')
      assert.deepEqual(await deskProcesses(), [], 'no TaskDesk is left')
      assert.deepEqual(await listeningAddresses(desktop.port), [], 'nothing listens on the runner port')
    } finally {
      if (coveredOnThisMac.length > 0) process.stdout.write(`# the capture was taken while ${JSON.stringify(coveredOnThisMac)} lay over TaskDesk's window\n`)
      await runCommand('/usr/bin/defaults', ['delete', bundleId, marker], { timeoutMs: 10_000 })
      await service.close()
      await rm(logs, { recursive: true, force: true })
    }
  })

  test('one runner serves the desktop, on a port of its own bound to 127.0.0.1, and a second is refused', async () => {
    assert.notEqual(desktop.port, 10100)
    assert.deepEqual(await listeningAddresses(desktop.port), [`127.0.0.1:${desktop.port}`])
    assert.equal(desktop.processIds.length, 2, 'xcodebuild and the runner app')
    assert.equal(desktop.os.name, 'macOS')
    assert.equal(app.execution.app.bundleId, bundleId)
    assert.equal(app.execution.executor.codeDirectoryHash, '06e22851aab6c648f81dcfa546eaeeffab753404', 'the runner macOS knows, never rebuilt')
    assert.deepEqual(app.resetPolicy, macosResetPolicy.contract)
    const second = await MacosDesktop.start({ build: desktop.build, tools: systemTools, logFolder: logs, timeoutMs: 30_000 })
    assert.equal(second.ok, false)
  })

  test('the host prepares the fixture service, and TaskDesk launches at its path, is captured as its window and terminates', async () => {
    const { prepared } = await prepareFixtureService(service.url, 'desk')
    assert.equal(prepared.records[0]?.outcome, 'prepared')
    const session = await open('macos-lifecycle', ['-reset', '-serviceURL', service.url, '-windowFrame', '20,60,700,480'])
    const installed = await session.install({ appPath: taskDeskApp }, 5000)
    assert.equal(!installed.result.ok && installed.result.failure.class, 'unsupported')
    assert.deepEqual(await session.launch(60_000), { result: { ok: true }, input: 'sent' })
    assert.deepEqual(session.processIds, await deskProcesses())
    assert.deepEqual(await session.appState(10_000), { ok: true, state: 'foreground' })
    assert.deepEqual(await session.activate(10_000), { result: { ok: true }, input: 'sent' })
    const tree = await session.readSource(30_000)
    if (!tree.ok) throw new Error(tree.failure.message)
    assert.match(tree.tree.source.xml, /^<XCUIElementTypeWindow/)
    assert.doesNotMatch(tree.tree.source.xml, /XCUIElementTypeMenuBar/)
    const window = tree.tree.source.window
    if (window === undefined) throw new Error('the tree names no window')
    assert.deepEqual(window, { x: 20, y: 60, width: 700, height: 480 })
    // Whatever lies over TaskDesk's window, the capture is its own window's image; what lay over it is written down.
    const windows = await windowsOnScreen(systemTools, { timeoutMs: 10_000 })
    if (typeof windows === 'string') throw new Error(windows)
    const listed = await processesWith('/')
    const dock = listed.filter((entry) => entry.command.endsWith('/Dock.app/Contents/MacOS/Dock')).map((entry) => entry.pid)
    const screen = await mainScreen()
    const overlay = automationOverlayPids(listed)
    const covering = coveringWindows(windows, { pids: session.processIds, frame: window }, { screen, dockPids: dock, automationOverlayPids: overlay })
    const overlayUp = windows.some((entry) => overlay.includes(entry.pid) && entry.width === screen.width && entry.height === screen.height)
    process.stdout.write(`# the Automation Mode overlay was ${overlayUp ? '' : 'not '}over the whole screen at the capture\n`)
    const shot = await session.capture(30_000)
    if (!shot.ok) throw new Error(shot.failure.message)
    if (covering.ok) coveredOnThisMac = covering.windows.map((entry) => ({ layer: entry.layer, width: entry.width, height: entry.height }))
    process.stdout.write(`# TaskDesk window capture passed with the Automation Mode overlay ${overlayUp ? 'present' : 'absent'} and ${coveredOnThisMac.length} other window(s) over it\n`)
    assert.equal(shot.capture.source, 'window-crop')
    assert.equal(shot.capture.reference.sessionId, 'macos-lifecycle:desk')
    const image = decodePng(shot.capture.png)
    const scale = image.width / (window?.width ?? 1)
    assert.ok(Number.isInteger(scale) && scale >= 1, `the image is the window at a whole scale, ${scale}`)
    assert.equal(image.height, (window?.height ?? 0) * scale)
    assert.ok(distinctColours(image) > 16)
    assert.deepEqual(await session.terminate(60_000), { result: { ok: true }, input: 'sent' })
    assert.deepEqual(await session.appState(10_000), { ok: true, state: 'not_running' })
    assert.deepEqual(await deskProcesses(), [])
    await session.dispose(30_000)
    assert.deepEqual((await prepared.cleanUp(false)).failures, [])
  })

  test('a relaunch keeps the app\'s defaults; the app\'s own reset clears them; references from the launch before are refused', async () => {
    assert.equal((await runCommand('/usr/bin/defaults', ['write', bundleId, marker, '-string', 'written before the launch'], { timeoutMs: 10_000 })).code, 0)
    const keeping = await open('macos-keep', [])
    await keeping.launch(60_000)
    const first = await keeping.readSource(30_000)
    if (!first.ok) throw new Error(first.failure.message)
    await keeping.terminate(60_000)
    assert.equal(await defaultsRead(), 'written before the launch', 'a relaunch cleared nothing')
    await keeping.launch(60_000)
    assert.equal(keeping.checkReference(first.tree.reference)?.class, 'not_actionable')
    await keeping.dispose(30_000)
    const resetting = await open('macos-reset', ['-reset'])
    await resetting.launch(60_000)
    await resetting.terminate(60_000)
    await resetting.dispose(30_000)
    assert.equal(await defaultsRead(), undefined, "TaskDesk's -reset removed its whole defaults domain")
  })

  test('a stale runner session is refused by the runner; the session is lost and still ends the TaskDesk it launched', async () => {
    const session = await open('macos-stale', [])
    await session.launch(60_000)
    const launched = await deskProcesses()
    const intruder = new ExecutorClient({ executor: 'mac2', host: '127.0.0.1', port: desktop.port })
    const replaced = await intruder.createSession({ timeoutMs: 30_000 })
    assert.equal(replaced.status, 'answered')
    const state = await session.appState(10_000)
    assert.equal(!state.ok && state.failure.class, 'session_lost')
    await session.dispose(30_000)
    assert.deepEqual(await deskProcesses(), [], `pid ${launched.join(', ')} was ended by the session that launched it`)
    if (replaced.status === 'answered') await replaced.value.end({ timeoutMs: 10_000 })
  })

  test('an app that crashes is seen as ended, and activate does not launch it again', async () => {
    const session = await open('macos-crash', [])
    assert.deepEqual(await session.launch(60_000), { result: { ok: true }, input: 'sent' })
    const [pid] = session.processIds
    if (pid === undefined) throw new Error('the launch named no process')
    // Ended from outside, as a crash ends it, and only as the process the launch recorded: by its pid, start and command.
    const reading = await macosAppProcesses(systemTools, bundleId, { timeoutMs: 10_000 })
    const launched = reading.ok ? reading.processes.find((entry) => entry.pid === pid) : undefined
    if (launched === undefined) throw new Error('the launched TaskDesk could not be read')
    assert.equal(await endRecorded(systemTools, launched, 0), 'ended')
    await sleep(500)
    assert.deepEqual(await session.appState(10_000), { ok: true, state: 'not_running' })
    assert.equal(session.appStatus.endedUnexpectedly, true)
    const activated = await session.activate(30_000)
    assert.equal(!activated.result.ok && activated.result.failure.class, 'session_lost')
    assert.deepEqual(await deskProcesses(), [], 'nothing launched it again')
    await session.dispose(30_000)
  })

  test('a cancel after the launch went leaves its outcome unknown, and reconciliation reads where the app stood', async () => {
    const session = await open('macos-cancel', [])
    const launching = session.launch(60_000)
    // The launch is in flight once its process exists: XCTest answers only after the app has finished launching.
    for (let looks = 0; looks < 500 && (await deskProcesses()).length === 0; looks += 1) await sleep(5)
    session.cancel(interrupted)
    const launched = await launching
    assert.equal(launched.input, 'unknown', 'the cancel came while the launch was in flight')
    assert.equal(!launched.result.ok && launched.result.failure.class, 'interrupted')
    const [reconciled] = await session.reconcile(10_000)
    assert.equal(reconciled?.reconciled?.ok && reconciled.reconciled.running, true)
    await session.dispose(30_000)
    assert.deepEqual(await deskProcesses(), [])
  })

  test('a lost runner loses the open session within seconds, and the session still ends its TaskDesk', async (t) => {
    const session = await open('macos-lost', [])
    await session.launch(60_000)
    const lost = new Promise<string>((resolve) => desktop.onDisconnect(resolve))
    const killedAt = performance.now()
    // The runner app the desktop recorded as its own, ended by its pid, start and command.
    for (const runnerApp of desktop.executorProcesses.slice(1)) assert.equal(await endRecorded(systemTools, runnerApp, 0), 'ended')
    const said = await within(lost, 30_000, 'the desktop did not report the lost runner within 30 s')
    const seenAfterMs = Math.round(performance.now() - killedAt)
    t.diagnostic(`the lost runner app was reported ${seenAfterMs} ms after it was killed`)
    assert.match(said, /runner app \(pid \d+\) ended|xcodebuild ended/)
    assert.ok(seenAfterMs < 5000)
    const state = await session.appState(10_000)
    assert.equal(!state.ok && state.failure.class, 'session_lost')
    await session.dispose(30_000)
    assert.deepEqual(await deskProcesses(), [])
  })
})
