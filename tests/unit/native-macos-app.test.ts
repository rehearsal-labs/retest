import type { TestContext } from 'node:test'
import type { CapturedFrame, StartCapture } from '../../src/media/capture.ts'
import type { NativeCaptureSession } from '../../src/native/capture.ts'
import type { ExecutorBuild } from '../../src/native/executors.ts'
import type { FakeTools } from './native-fake-tools.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as wait } from 'node:timers/promises'
import { nativeCaptureTargetCheck, nativeCaptureTimeoutMs, nativeFrameSource, sessionRecordIdentity } from '../../src/native/capture.ts'
import { takeDesktopLock } from '../../src/native/desktop-lock.ts'
import { appWindow, automationOverlayPids, coveringWindows, MacosDesktop, macosAppProcesses, readWindowsOnScreen, windowsOnScreen } from '../../src/native/macos-app.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { decodePng } from '../../src/native/png.ts'
import { commandOf, listProcesses, ProcessListUnread, recordedIdentity, systemTools, terminationGraceMs } from '../../src/native/processes.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { alive, readApps, readJsonFile, readRequests } from './native-fake-executor.ts'
import { endedPid, fakeAppBundle, fakeTools, fakeWindowProcess, processStart, startedProcesses } from './native-fake-tools.ts'

// A macOS desktop needs a Mac: it refuses to start elsewhere, and its lock stands on the kernel lock /usr/bin/lockf takes.
const darwinOnly = { skip: process.platform === 'darwin' ? false : 'the macOS desktop runs only on macOS' }

const owner = { runId: 'run', testId: 'test', attemptId: 'k3v9q0x2mb', app: 'desk' }
const bundleId = 'dev.retest.fixtures.taskdesk'

async function setUp(t: TestContext, tools: Record<string, unknown> = {}, executor: Record<string, unknown> = {}): Promise<{ readonly fake: FakeTools; readonly appPath: string; readonly build: ExecutorBuild }> {
  const fake = await fakeTools(t)
  await fake.configure(tools)
  await writeFile(join(fake.root, 'config.json'), JSON.stringify({ appName: 'TaskDesk', screen: { width: 40, height: 30, scale: 2 }, window: { x: 4, y: 3, width: 20, height: 10 }, ...executor }))
  // The runtime launches the app at its real path, as macOS shows it, so the test speaks of the same path.
  const appPath = await realpath(await fakeAppBundle(fake.root, { platform: 'macos', name: 'TaskDesk', bundleId }))
  const products = join(fake.root, 'derived', 'Build', 'Products')
  await mkdir(join(products, 'Debug'), { recursive: true })
  const xctestrun = join(products, 'WebDriverAgentRunner_macosx26.5-arm64.xctestrun')
  await writeFile(xctestrun, 'fake test run')
  const build: ExecutorBuild = { schemaVersion: 1, executor: 'mac2', version: '4.3.6', commit: 'f38257191fa9f273a684f6a9c8c2b16d1272bd09', key: 'k', xcode: { version: '26.5', build: '17F42' }, sdk: 'macosx26.5', architecture: 'arm64', origin: 'adopted', derivedDataPath: join(fake.root, 'derived'), xctestrun, products: join(products, 'Debug'), productsSha256: 'p', xctestrunSha256: 'x', recordedAt: new Date().toISOString(), licenses: [], notices: [] }
  return { fake, appPath, build }
}

async function startDesktop(t: TestContext, setup: { readonly fake: FakeTools; readonly build: ExecutorBuild }): Promise<MacosDesktop> {
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  if (!started.ok) throw new Error(started.failure.message)
  const { desktop } = started
  t.after(() => desktop.close(20_000).catch(() => undefined))
  return desktop
}

const session = { owner, launch: { arguments: ['-reset'], environment: { RETEST_SERVICE_URL: 'http://127.0.0.1:9' } }, redact: (text: string): string => text }

test('one runner serves the desktop: the app is launched at its path, captured as its window, terminated, and nothing is left', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const desktop = await startDesktop(t, setup)
  assert.deepEqual(desktop.os, { name: 'macOS', version: '27.0.1', build: '26A434' })
  assert.equal(desktop.processIds.length, 2, 'xcodebuild and the runner app')
  const app = await desktop.openApp(setup.appPath)
  assert.ok(app.ok)
  if (!app.ok) return
  assert.equal(app.runtime.identity.kind, 'macos')
  assert.deepEqual(app.runtime.resetPolicy, { appData: 'kept', keychain: 'kept' })
  const opened = await app.runtime.openSession(session, 5000)
  assert.ok(opened.ok)
  if (!opened.ok) return
  const installed = await opened.session.install({ appPath: setup.appPath }, 5000)
  assert.equal(!installed.result.ok && installed.result.failure.class, 'unsupported')
  assert.deepEqual(await opened.session.launch(10_000), { result: { ok: true }, input: 'sent' })
  const launch = readRequests(setup.fake.root).find((request) => request.path.endsWith('/wda/apps/launch'))
  assert.deepEqual(JSON.parse(launch?.body ?? '{}'), { path: setup.appPath, arguments: ['-reset'], environment: { RETEST_SERVICE_URL: 'http://127.0.0.1:9' } })
  assert.equal(opened.session.processIds.length, 1)
  assert.deepEqual(await opened.session.activate(5000), { result: { ok: true }, input: 'sent' })
  const capture = await opened.session.capture(10_000)
  assert.ok(capture.ok, capture.ok ? '' : capture.failure.message)
  if (!capture.ok) return
  // The 20x10-point window at scale 2, as screencapture drew it from the window's number.
  assert.deepEqual([capture.capture.width, capture.capture.height, capture.capture.source], [40, 20, 'window-crop'])
  assert.equal(decodePng(capture.capture.png).width, 40)
  assert.equal(readRequests(setup.fake.root).some((request) => request.path.endsWith('/screenshot')), false, 'the display is not captured')
  const tree = await opened.session.readSource(5000)
  assert.ok(tree.ok)
  assert.doesNotMatch(tree.ok ? tree.tree.source.xml : '', /Recent Items|secret-file/)
  assert.deepEqual(await opened.session.terminate(10_000), { result: { ok: true }, input: 'sent' })
  await opened.session.dispose(5000)
  await desktop.close(20_000)
  assert.deepEqual((await startedProcesses(setup.fake.root)).filter(alive), [])
})

test('a Mac where Automation Mode would ask an administrator fails setup before any runner starts', darwinOnly, async (t) => {
  const setup = await setUp(t, { automation: 'Automation Mode is disabled.\nThis device requires user authentication to enable Automation Mode.' })
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!started.ok ? started.failure.message : '', /enable-automationmode-without-authentication/)
  assert.equal((await setup.fake.calls()).some((call) => call.tool === 'xcodebuild' && call.args[0] === 'test-without-building'), false)
})

test('a dialog that holds the runner fails setup naming the fix, and the runner is ended', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'automation' })
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!started.ok ? started.failure.message : '', /nobody answered/)
  assert.deepEqual((await startedProcesses(setup.fake.root)).filter(alive), [])
})

test('a runner already on the desktop, or a second one in this process, is refused', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const desktop = await startDesktop(t, setup)
  const second = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!second.ok ? second.failure.message : '', /already runs the macOS runner/)
  await desktop.close(20_000)
  const stranger = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => stranger.kill('SIGKILL'))
  const listed = readJsonFile(join(setup.fake.root, 'processes.json'))
  await writeFile(join(setup.fake.root, 'processes.json'), JSON.stringify([...(Array.isArray(listed) ? listed : []), { pid: stranger.pid, command: '/elsewhere/WebDriverAgentRunner-Runner.app/Contents/MacOS/WebDriverAgentRunner-Runner' }]))
  const other = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!other.ok ? other.failure.message : '', new RegExp(`cannot recognise as its own runs on this Mac \\(pid ${stranger.pid}\\)`))
})

test('a copy of the app already running blocks the launch, and Retest touches it not', darwinOnly, async (t) => {
  const setup = await setUp(t, { lsappinfoRunning: [bundleId] })
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  const launched = await opened.session.launch(10_000)
  assert.equal(launched.input, 'not_sent')
  assert.match(!launched.result.ok ? launched.result.failure.message : '', /already running/)
  assert.equal(readRequests(setup.fake.root).some((request) => request.path.endsWith('/wda/apps/launch')), false)
  await opened.session.dispose(5000)
})

test('sessions on one desktop run one after another', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const first = await app.runtime.openSession(session, 5000)
  if (!first.ok) throw new Error(first.failure.message)
  const order: string[] = []
  const second = app.runtime.openSession({ ...session, owner: { ...owner, attemptId: 'second' } }, 10_000).then((opened) => {
    order.push('second opened')
    return opened
  })
  await new Promise((resolve) => setTimeout(resolve, 300))
  order.push('first disposed')
  await first.session.dispose(5000)
  const opened = await second
  assert.deepEqual(order, ['first disposed', 'second opened'])
  if (!opened.ok) throw new Error(opened.failure.message)
  try {
    assert.deepEqual(await opened.session.appState(5000), { ok: true, state: 'not_running' }, 'the waiting session acquired a usable executor')
  } finally {
    await opened.session.dispose(5000)
  }
})

test('an app killed under the session has ended unexpectedly, and activate does not launch it again', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  await opened.session.launch(10_000)
  const pid = readApps(setup.fake.root)[setup.appPath]?.pid
  if (pid !== undefined) process.kill(pid, 'SIGKILL')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(await opened.session.appState(5000), { ok: true, state: 'not_running' })
  assert.equal(opened.session.appStatus.endedUnexpectedly, true)
  const activated = await opened.session.activate(5000)
  assert.equal(!activated.result.ok && activated.result.failure.class, 'session_lost')
  await opened.session.dispose(5000)
})

test('a lost runner loses the open session and tells the desktop once', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  await opened.session.launch(10_000)
  const lost = new Promise<string>((resolve) => desktop.onDisconnect(resolve))
  for (const pid of desktop.processIds.slice(1)) process.kill(pid, 'SIGKILL')
  assert.match(await lost, /runner app \(pid \d+\) ended|xcodebuild ended/)
  const state = await opened.session.appState(5000)
  assert.equal(!state.ok && state.failure.class, 'session_lost')
  // The app this session launched is still ended when the session goes, by its own pid.
  await opened.session.dispose(10_000)
  assert.equal(Object.values(readApps(setup.fake.root)).some((entry) => alive(entry.pid)), false)
})

test('a start that throws lets the next start in this process go ahead', darwinOnly, async (t) => {
  const setup = await setUp(t, { psFails: true })
  const first = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.equal(first.ok, false)
  await setup.fake.configure({})
  const second = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.ok(second.ok, second.ok ? '' : second.failure.message)
  if (second.ok) await second.desktop.close(20_000)
})

test('a start whose runner app appears and never answers ends that runner app too', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'runner-not-ready' })
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 3000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!started.ok ? started.failure.message : '', /did not answer \/status/)
  const runners = readJsonFile(join(setup.fake.root, 'processes.json'))
  assert.ok(Array.isArray(runners) && runners.some((entry) => isPlainObject(entry) && typeof entry['command'] === 'string' && entry['command'].includes('WebDriverAgentRunner-Runner.app')), 'the runner app had appeared')
  assert.deepEqual((await startedProcesses(setup.fake.root)).filter(alive), [], 'xcodebuild and the runner app are gone')
})

test('the desktop is held across processes: a live holder is refused, and a dead holder\'s runner is ended by its record', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const lock = join(setup.fake.root, 'desktop.lock')
  const script = join(setup.fake.root, 'hold-desktop.ts')
  await writeFile(script, [
    `import { MacosDesktop } from ${JSON.stringify(new URL('../../src/native/macos-app.ts', import.meta.url).pathname)}`,
    `const started = await MacosDesktop.start({ build: ${JSON.stringify(setup.build)}, tools: ${JSON.stringify(setup.fake.tools)}, logFolder: ${JSON.stringify(join(setup.fake.root, 'logs'))}, timeoutMs: 20000, desktopLock: ${JSON.stringify(lock)} })`,
    "process.stdout.write(started.ok ? 'started\\n' : `failed ${started.failure.message}\\n`)",
    'setInterval(() => undefined, 1000)',
  ].join('\n'))
  const holder = spawn(process.execPath, ['--conditions=retest-source', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => holder.kill('SIGKILL'))
  const said = await new Promise<string>((resolve) => holder.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString())))
  assert.equal(said.trim(), 'started')
  const refused = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: lock })
  assert.match(!refused.ok ? refused.failure.message : '', new RegExp(`Another Retest process \\(pid ${holder.pid}, started as ".*hold-desktop\\.ts" at [^)]*\\) drives this Mac's desktop`))
  const runners = readJsonFile(join(setup.fake.root, 'processes.json'))
  const runnerApp = Array.isArray(runners) && typeof runners[0] === 'object' && runners[0] !== null && 'pid' in runners[0] && typeof runners[0].pid === 'number' ? runners[0].pid : undefined
  holder.kill('SIGKILL')
  await new Promise((resolve) => holder.once('exit', resolve))
  assert.equal(alive(runnerApp), true, 'a SIGKILL of the holder runs no exit hook, so its runner app stays')
  const taken = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: lock })
  assert.ok(taken.ok, taken.ok ? '' : taken.failure.message)
  assert.equal(alive(runnerApp), false, 'the runner app the dead holder recorded was ended')
  if (taken.ok) await taken.desktop.close(20_000)
})

test('a launch is refused by name when Retest cannot read whether a copy runs', darwinOnly, async (t) => {
  const setup = await setUp(t, { lsappinfoFails: true })
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  const launched = await opened.session.launch(10_000)
  assert.equal(launched.input, 'not_sent')
  assert.match(!launched.result.ok ? launched.result.failure.message : '', /could not read whether a copy of .* runs/)
  await opened.session.dispose(5000)
})

test('a window of another process over the app\'s window leaves the capture to the app\'s own window, by its number, in front or not', darwinOnly, async (t) => {
  const setup = await setUp(t, { coveringWindow: { layer: 1000, x: 10, y: 5, width: 6, height: 6 } })
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  await opened.session.launch(10_000)
  const pid = opened.session.processIds[0]
  const asked = readRequests(setup.fake.root).length
  const capture = await opened.session.capture(10_000)
  assert.ok(capture.ok, capture.ok ? '' : capture.failure.message)
  if (capture.ok) assert.deepEqual([capture.capture.width, capture.capture.height], [40, 20])
  const shots = (await setup.fake.calls()).filter((call) => call.tool === 'screencapture')
  assert.equal(shots.length, 1)
  const file = shots[0]?.args.at(-1) ?? ''
  // The fake numbers the app's window by its owner's pid.
  assert.deepEqual(shots[0]?.args, ['-l', String(pid), '-o', '-x', '-t', 'png', file])
  await assert.rejects(access(file), 'the image file is removed once read')
  assert.deepEqual(readRequests(setup.fake.root).slice(asked).map((request) => request.path).filter((path) => path.endsWith('/screenshot') || path.endsWith('/wda/apps/state')), [], 'neither the display nor whether the app is in front is asked')
  await opened.session.dispose(5000)
})

test('the app\'s window is the one window of its processes where its tree places it, within a point', () => {
  const frame = { x: 100, y: 100, width: 200, height: 100 }
  const own = { pid: 50, layer: 0, ...frame, number: 501 }
  const nearly = { ...own, x: 100.5, y: 99, width: 201, number: 502 }
  const stranger = { pid: 70, layer: 0, ...frame, number: 701 }
  const popover = { pid: 50, layer: 3, x: 150, y: 180, width: 80, height: 40, number: 503 }
  const panel = { pid: 80, layer: 1000, x: 150, y: 120, width: 100, height: 100, number: 801 }
  assert.deepEqual(appWindow([panel, popover, stranger, own], [50], frame), { ok: true, window: own }, 'another process\'s window at the same frame and the app\'s other windows are not it')
  assert.deepEqual(appWindow([nearly], [50], frame), { ok: true, window: nearly })
  assert.deepEqual(appWindow([own], [51, 50], frame), { ok: true, window: own }, 'any of the session\'s processes may own it')
  assert.deepEqual(appWindow([stranger, popover], [50], frame), { ok: false, problem: 'No window of the app is on screen where its tree places it (100,100 200x100); a minimised or hidden window, or one on another Space, is not on screen.', absent: true }, 'no window there may yet come, as just after a launch')
  assert.deepEqual(appWindow([own, nearly], [50], frame), { ok: false, problem: '2 windows of the app are on screen where its tree places it, so Retest cannot tell which one to capture.' })
  assert.deepEqual(appWindow([{ ...own, x: 102 }], [50], frame).ok, false, 'two points off is another place')
  assert.deepEqual(appWindow('osascript ended with exit code 1', [50], frame), { ok: false, problem: 'Retest could not read which windows are on screen (osascript ended with exit code 1).' })
})

test('the windows over an app window are the other processes\' windows in front of it that overlap it, the Dock\'s surface aside', () => {
  const frame = { x: 100, y: 100, width: 200, height: 100 }
  const screen = { x: 0, y: 0, width: 1728, height: 1117 }
  const own = { pid: 50, layer: 0, ...frame, number: 1 }
  const dock = { pid: 60, layer: 20, ...screen, number: 2 }
  const panel = { pid: 70, layer: 1000, x: 250, y: 150, width: 100, height: 100, number: 3 }
  const elsewhere = { pid: 80, layer: 0, x: 400, y: 400, width: 50, height: 50, number: 4 }
  const behind = { pid: 90, layer: 0, x: 0, y: 0, width: 1728, height: 1000, number: 5 }
  assert.deepEqual(coveringWindows([dock, panel, elsewhere, own, behind], { pids: [50], frame }, { screen, dockPids: [60] }), { ok: true, windows: [panel] })
  assert.deepEqual(coveringWindows([dock, own], { pids: [50], frame }, { screen, dockPids: [] }), { ok: true, windows: [dock] }, 'a full-screen window not of the Dock counts')
  assert.equal(coveringWindows([dock, behind], { pids: [50], frame }, { screen, dockPids: [60] }).ok, false, 'no window of the app where its tree places it')
})

test('the Automation Mode overlay over the whole screen is passed over by its owner, and nothing else is', () => {
  const frame = { x: 100, y: 100, width: 200, height: 100 }
  const screen = { x: 0, y: 0, width: 1728, height: 1117 }
  const own = { pid: 50, layer: 0, ...frame, number: 1 }
  const overlay = { pid: 70, layer: 1000, ...screen, number: 2 }
  const pointer = { pid: 601, layer: 2147483630, x: 150, y: 120, width: 28, height: 28, number: 3 }
  const overlayPanel = { pid: 70, layer: 1000, x: 120, y: 110, width: 100, height: 40, number: 4 }
  const otherFullScreen = { pid: 80, layer: 1000, ...screen, number: 5 }
  const desktop = { screen, dockPids: [], automationOverlayPids: [70] }
  assert.deepEqual(coveringWindows([overlay, own], { pids: [50], frame }, desktop), { ok: true, windows: [] })
  assert.deepEqual(coveringWindows([pointer, overlay, own], { pids: [50], frame }, desktop), { ok: true, windows: [pointer] }, 'the pointer still counts')
  assert.deepEqual(coveringWindows([overlayPanel, overlay, own], { pids: [50], frame }, desktop), { ok: true, windows: [overlayPanel] }, 'a window of the overlay\'s process that is not over the whole screen counts')
  assert.deepEqual(coveringWindows([otherFullScreen, own], { pids: [50], frame }, desktop), { ok: true, windows: [otherFullScreen] }, 'a window at the overlay\'s layer of another process counts')
  assert.deepEqual(coveringWindows([overlay, own], { pids: [50], frame }, { screen, dockPids: [] }), { ok: true, windows: [overlay] }, 'without the overlay\'s owner it counts')
})

test('the overlay\'s owner is found by the exact path of macOS\'s AutomationModeUI, never by its name alone', () => {
  const path = '/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI'
  const listed = [
    { pid: 74449, command: path },
    { pid: 74450, command: `${path} -launchedByTest` },
    { pid: 900, command: '/Users/someone/AutomationModeUI.app/Contents/MacOS/AutomationModeUI' },
    { pid: 901, command: `${path}-copy` },
  ]
  assert.deepEqual(automationOverlayPids(listed), [74449, 74450])
})

test('a full-screen window at layer 1000 leaves the capture to the app\'s window, whether the system overlay or another app owns it, and a disposed session captures nothing', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  const overlay = await fakeWindowProcess(setup.fake, '/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI')
  const window = { layer: 1000, x: 0, y: 0, width: 40, height: 30 }
  await setup.fake.configure({ coveringWindow: { pid: overlay, ...window } })
  assert.deepEqual(await opened.session.launch(10_000), { result: { ok: true }, input: 'sent' })
  const underOverlay = await opened.session.capture(10_000)
  assert.ok(underOverlay.ok, underOverlay.ok ? '' : underOverlay.failure.message)
  if (underOverlay.ok) assert.deepEqual([underOverlay.capture.width, underOverlay.capture.height], [40, 20])
  const other = await fakeWindowProcess(setup.fake, '/Applications/Another.app/Contents/MacOS/AutomationModeUI')
  await setup.fake.configure({ coveringWindow: { pid: other, ...window } })
  const underAnother = await opened.session.capture(10_000)
  assert.ok(underAnother.ok, underAnother.ok ? '' : underAnother.failure.message)
  if (underAnother.ok) assert.deepEqual([underAnother.capture.width, underAnother.capture.height], [40, 20])
  await opened.session.dispose(5000)
  const ended = await opened.session.capture(5000)
  assert.equal(ended.ok, false, 'a disposed session captures nothing')
})

test('two runner apps launched by the fake executor refuse its identity and are cleaned through recorded ancestry', darwinOnly, async (t) => {
  const setup = await setUp(t, { extraRunnerApp: true })
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!started.ok ? started.failure.message : '', /2 runner apps \(pid \d+, \d+\) appeared during this start, so Retest cannot tell which one is its own/)
  assert.deepEqual((await startedProcesses(setup.fake.root)).filter(alive), [], 'the fake xcodebuild itself launched both apps; verified ancestry owns them')
})

test('another window changing between the readings around the image leaves the capture taken', darwinOnly, async (t) => {
  const setup = await setUp(t, { windowsChange: true })
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  await opened.session.launch(10_000)
  const capture = await opened.session.capture(10_000)
  assert.ok(capture.ok, capture.ok ? '' : capture.failure.message)
  await opened.session.dispose(5000)
})

test('a capture is refused when the app\'s window changes its number or its owner between the readings around the image', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  const pid = opened.session.processIds[0] ?? 0
  const stranger = await fakeWindowProcess(setup.fake, '/Applications/Floating.app/Contents/MacOS/Floating')
  const cases = [
    { readings: [{}, { number: 999 }], refusal: new RegExp(`^The app's window changed while its image was taken \\(window ${pid} of pid ${pid}, then window 999 of pid ${pid}\\)\\. Retest captured nothing\\.$`) },
    { readings: [{}, { pid: stranger }], refusal: /^After the image was taken: No window of the app is on screen where its tree places it \(4,3 20x10\); a minimised or hidden window, or one on another Space, is not on screen\. Retest captured nothing\.$/ },
  ]
  for (const { readings, refusal } of cases) {
    await rm(join(setup.fake.root, 'app-window-readings.txt'), { force: true })
    await setup.fake.configure({ appWindowReadings: readings })
    const capture = await opened.session.capture(10_000)
    assert.match(!capture.ok ? capture.failure.message : '', refusal)
  }
  assert.equal((await setup.fake.calls()).filter((call) => call.tool === 'screencapture').length, 2, 'each image was taken, and neither handed over')
})

test('a capture is refused before any image when the app\'s window is not on screen, or two of its windows lie where its tree places it', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  await setup.fake.configure({ appWindowReadings: [{ absent: true }] })
  const minimised = await opened.session.capture(10_000)
  assert.equal(!minimised.ok && minimised.failure.message, 'No window of the app is on screen where its tree places it (4,3 20x10); a minimised or hidden window, or one on another Space, is not on screen. Retest captured nothing.')
  await rm(join(setup.fake.root, 'app-window-readings.txt'), { force: true })
  await setup.fake.configure({ appWindowReadings: [{ twice: true }] })
  const several = await opened.session.capture(10_000)
  assert.equal(!several.ok && several.failure.message, '2 windows of the app are on screen where its tree places it, so Retest cannot tell which one to capture. Retest captured nothing.')
  assert.equal((await setup.fake.calls()).some((call) => call.tool === 'screencapture'), false)
})

test('a capture is refused, naming screencapture and the permission it needs, when macOS gives no image, and an image of another size is refused', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  await setup.fake.configure({ screencaptureFails: 'could not create image from window' })
  const denied = await opened.session.capture(10_000)
  assert.equal(!denied.ok && denied.failure.message, 'macOS gave no image of the app\'s window (screencapture ended with exit code 1: could not create image from window). The image needs Screen Recording for the terminal or agent that runs Retest: macOS grants it in System Settings, Privacy & Security, Screen & System Audio Recording, and that app may need a relaunch. npx retest doctor checks it.')
  await setup.fake.configure({ screencaptureSize: { width: 41, height: 20 } })
  const sized = await opened.session.capture(10_000)
  assert.equal(!sized.ok && sized.failure.message, 'The window\'s image is 41x20, not the 20x10-point window at a whole scale. Retest captured nothing.')
  for (const call of (await setup.fake.calls()).filter((entry) => entry.tool === 'screencapture')) await assert.rejects(access(call.args.at(-1) ?? ''), 'no image file is left')
})

test('a session that has recorded no process of its app captures nothing', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  const capture = await opened.session.capture(10_000)
  assert.equal(!capture.ok && capture.failure.message, 'The session has recorded no process of the app, so Retest cannot tell which window is the app\'s. Retest captured nothing.')
  assert.equal((await setup.fake.calls()).some((call) => call.tool === 'screencapture'), false)
})

// A recording start on the session's own clock, collecting what it hands over and why it ended.
function recordingStart(frames: CapturedFrame[], ended: string[], timeoutMs: number): StartCapture {
  const began = performance.now()
  return { fps: 5, clock: () => Math.floor((performance.now() - began) * 1000), deliver: (frame) => frames.push(frame), ended: (reason) => ended.push(reason), timeoutMs }
}

// How many fake screencapture calls have begun to hang.
function hangingShots(root: string): number {
  try {
    return readFileSync(join(root, 'screencapture-hangs.txt'), 'utf8').length
  } catch {
    return 0
  }
}

// Waits on short sleeps until `condition` holds, failing with `what` after `timeoutMs`.
async function until(condition: () => boolean | Promise<boolean>, what: string, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (!(await condition())) {
    if (performance.now() > deadline) assert.fail(`Timed out waiting for ${what}.`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('a window recording that starts before the app\'s window is on screen asks again within its start budget, and a running one drops that frame', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  // The window list lists no window of the app at its first two readings, as just after a launch.
  await setup.fake.configure({ appWindowReadings: [{ absent: true }, { absent: true }] })
  const source = opened.session.frameSource(sessionRecordIdentity(opened.session.identity))
  const frames: CapturedFrame[] = []
  const ended: string[] = []
  assert.deepEqual(await source.start(recordingStart(frames, ended, 20_000)), { ok: true, mode: 'screenshot-loop' })
  assert.ok(frames.length >= 1, 'the start handed over the first image once the window was there')
  await rm(join(setup.fake.root, 'app-window-readings.txt'), { force: true })
  const before = frames.length
  await setup.fake.configure({ appWindowReadings: [{ absent: true }] })
  await until(() => frames.length >= before + 1, 'a frame after the one the running loop dropped', 20_000)
  const stats = await source.stop(10_000)
  const absent = 'No window of the app is on screen where its tree places it (4,3 20x10); a minimised or hidden window, or one on another Space, is not on screen. Retest captured nothing.'
  assert.deepEqual(ended, [])
  assert.equal(stats.endedEarly, undefined)
  assert.equal(stats.problems.filter((problem) => problem === absent).length, 3, 'two readings at the start and one while running, each a dropped frame')
  assert.equal(stats.dropped, 3)
})

// Sets whether the fake executor's tree holds the app's window, keeping its other settings.
async function treeWithoutWindow(root: string, windowless: boolean): Promise<void> {
  const config = readJsonFile(join(root, 'config.json'))
  await writeFile(join(root, 'config.json'), JSON.stringify({ ...(isPlainObject(config) ? config : {}), windowless }))
}

test('a window recording that starts before the app\'s tree holds its window asks again within its start budget, and a running one drops that frame', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  const trees = (): number => readRequests(setup.fake.root).filter((request) => request.path.endsWith('/source')).length
  await treeWithoutWindow(setup.fake.root, true)
  const source = opened.session.frameSource(sessionRecordIdentity(opened.session.identity))
  const frames: CapturedFrame[] = []
  const ended: string[] = []
  const read = trees()
  const starting = source.start(recordingStart(frames, ended, 20_000))
  await until(() => trees() >= read + 2, 'two readings of a tree with no window at the start', 20_000)
  await treeWithoutWindow(setup.fake.root, false)
  assert.deepEqual(await starting, { ok: true, mode: 'screenshot-loop' })
  assert.ok(frames.length >= 1, 'the start handed over the first image once the window was in the tree')
  const running = trees()
  await treeWithoutWindow(setup.fake.root, true)
  await until(() => trees() >= running + 2, 'a reading of a tree with no window while running', 20_000)
  const before = frames.length
  await treeWithoutWindow(setup.fake.root, false)
  await until(() => frames.length > before || ended.length > 0, 'a frame once the window is in the tree again', 20_000)
  const stats = await source.stop(10_000)
  assert.deepEqual(ended, [], 'neither the start nor the running loop ended')
  assert.equal(stats.endedEarly, undefined)
  assert.ok(stats.dropped >= 3, `two readings at the start and one while running were dropped frames, not ${stats.dropped}`)
  assert.deepEqual(new Set(stats.problems), new Set(['Capturing the screen: The app has no window in its tree.']))
  assert.equal(stats.problems.length, stats.dropped)
})

test('a window recording whose window never comes is refused with what its last whole capture found, never as a capture that did not answer', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  await setup.fake.configure({ appWindowReadings: Array.from({ length: 400 }, () => ({ absent: true })) })
  const absent = 'No window of the app is on screen where its tree places it (4,3 20x10); a minimised or hidden window, or one on another Space, is not on screen. Retest captured nothing.'
  const proofStarted = performance.now()
  const absentCapture = await opened.session.capture(nativeCaptureTimeoutMs, { source: 'window-crop' })
  const captureMs = Math.ceil(performance.now() - proofStarted)
  assert.ok(!absentCapture.ok, 'an actual window capture refuses the absent app window')
  assert.deepEqual(absentCapture.failure, { class: 'not_actionable', message: absent, details: { transient: true } })
  assert.equal((await setup.fake.calls()).some((call) => call.tool === 'screencapture'), false)
  assert.equal(opened.session.processIds.length, 1)
  const [pid] = opened.session.processIds
  assert.ok(pid !== undefined)
  const checkTarget = await fixtureTargetCheck(setup.fake, setup.appPath, pid)
  // Stable absence replies take the real capture's measured time, so the start keeps room for its last whole capture.
  const windowAbsent: NativeCaptureSession = {
    get identity() { return opened.session.identity },
    get ended() { return opened.session.ended },
    get cancelled() { return opened.session.cancelled },
    get appStatus() { return opened.session.appStatus },
    capture: async (timeoutMs, options) => {
      assert.ok(timeoutMs > 0 && timeoutMs <= nativeCaptureTimeoutMs)
      assert.equal(options.source, 'window-crop')
      const deadline = new Deadline(Math.floor(timeoutMs), { signal: options.signal })
      const stopped = (): boolean => deadline.reached || options.signal?.aborted === true
      const late = (): Awaited<ReturnType<NativeCaptureSession['capture']>> => ({ ok: false, failure: { class: 'timeout', message: 'The absent-window fixture was stopped or ran out of time.' } })
      if (stopped()) return late()
      assert.ok(captureMs < deadline.remainingMs, `the proved ${captureMs} ms capture fits its ${deadline.remainingMs} ms command budget`)
      try {
        await wait(captureMs, undefined, { signal: options.signal })
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error
        return late()
      }
      return stopped() ? late() : absentCapture
    },
  }
  // One budget holds less than a whole capture's time and the other several captures; both end inside the budget.
  for (const budgetMs of [4500, nativeCaptureTimeoutMs + 3000]) {
    const source = nativeFrameSource(windowAbsent, sessionRecordIdentity(opened.session.identity), async () => { throw new Error('The macOS fixture does not capture a simulator display.') }, checkTarget)
    const frames: CapturedFrame[] = []
    const ended: string[] = []
    const asked = performance.now()
    assert.deepEqual(await source.start(recordingStart(frames, ended, budgetMs)), { ok: false, reason: `The first window-crop capture failed: ${absent}` }, `a start of ${budgetMs} ms`)
    const tookMs = performance.now() - asked
    const stats = await source.stop(10_000)
    assert.deepEqual(ended, [])
    assert.equal(frames.length, 0)
    assert.ok(tookMs < budgetMs, `the start of ${budgetMs} ms answered after ${tookMs} ms`)
    assert.ok(stats.problems.every((problem) => problem === absent), stats.problems.join(' | '))
    assert.ok(stats.problems.length >= (budgetMs > nativeCaptureTimeoutMs ? 2 : 1), `the start of ${budgetMs} ms asked ${stats.problems.length} times`)
  }
})

// The timeout case keeps app metadata in the fixture; forked stand-ins also pay for process-group cleanup.
// The actual app birth is read afresh, and the production target check still refuses an unowned process.
async function fixtureTargetCheck(fake: FakeTools, appPath: string, pid: number): Promise<ReturnType<typeof nativeCaptureTargetCheck>> {
  const app = readApps(fake.root)[appPath]
  assert.equal(app?.pid, pid)
  assert.ok(app?.command !== undefined && app.command !== '')
  assert.ok(alive(pid), 'the app the session launched is still running')
  const owned = { pid, startedAt: processStart(pid), command: app.command }
  return nativeCaptureTargetCheck({ processState: async (bounds) => {
    const deadline = new Deadline(Math.floor(bounds.timeoutMs), { signal: bounds.signal })
    const stopped = (): boolean => deadline.reached || bounds.signal?.aborted === true
    const late = { ok: false, problem: 'The fixture process reading ran out of time or was cancelled.' } as const
    if (stopped()) return late
    if (!alive(pid)) return { ok: true, running: false, pids: [], processes: [] }
    const fresh = readApps(fake.root)[appPath]
    if (fresh?.pid !== pid || fresh.command === undefined || fresh.command === '') return { ok: false, problem: 'The fixture app no longer names its recorded process.' }
    try {
      const observed = { pid, startedAt: processStart(pid), command: fresh.command }
      if (stopped()) return late
      return { ok: true, running: true, pids: [observed.pid], processes: [observed] }
    } catch (error) {
      return { ok: false, problem: error instanceof Error ? error.message : String(error) }
    }
  } }, (entry) => recordedIdentity(owned, entry) === 'same' && entry.command === owned.command)
}

test('a window capture at the start that runs past its budget is a dropped frame, and the start asks again', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  assert.equal(opened.session.processIds.length, 1)
  const [pid] = opened.session.processIds
  assert.ok(pid !== undefined)
  const checkTarget = await fixtureTargetCheck(setup.fake, setup.appPath, pid)
  const asked = hangingShots(setup.fake.root)
  // The first screencapture never answers and ignores SIGTERM, so only the kill after its grace ends it.
  await setup.fake.configure({ screencaptureHangs: true })
  const source = nativeFrameSource(opened.session, sessionRecordIdentity(opened.session.identity), async () => { throw new Error('The macOS fixture does not capture a simulator display.') }, checkTarget)
  const frames: CapturedFrame[] = []
  const ended: string[] = []
  const starting = source.start(recordingStart(frames, ended, 20_000))
  await until(() => hangingShots(setup.fake.root) > asked, 'a screencapture that hangs at the start', 20_000)
  await setup.fake.configure({})
  assert.deepEqual(await starting, { ok: true, mode: 'screenshot-loop' })
  const stats = await source.stop(10_000)
  assert.deepEqual(ended, [])
  assert.equal(stats.endedEarly, undefined)
  assert.ok(frames.length >= 1, 'the start handed over the image it asked again for')
  assert.deepEqual(stats.problems, ['macOS gave no image of the app\'s window in time (screencapture did not finish in time and was ended). Retest captured nothing.'])
  assert.equal(stats.dropped, 1)
  assert.ok((stats.captureMs?.maxMs ?? Infinity) < nativeCaptureTimeoutMs, `the longest capture took ${stats.captureMs?.maxMs} ms`)
})

test('a window capture given less than a whole capture\'s time keeps the grace back, so a screencapture that ignores its stop is a dropped frame inside that time', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  // screencapture never answers and ignores SIGTERM, so only the kill after its grace ends it.
  await setup.fake.configure({ screencaptureHangs: true })
  const source = opened.session.frameSource(sessionRecordIdentity(opened.session.identity))
  const frames: CapturedFrame[] = []
  const ended: string[] = []
  const budgetMs = 4000
  const asked = performance.now()
  const start = await source.start(recordingStart(frames, ended, budgetMs))
  const tookMs = performance.now() - asked
  const stats = await source.stop(10_000)
  const late = 'macOS gave no image of the app\'s window in time (screencapture did not finish in time and was ended). Retest captured nothing.'
  assert.deepEqual(start, { ok: false, reason: `The first window-crop capture failed: ${late}` }, 'the start ends on its dropped frame, never on a capture that did not answer')
  assert.deepEqual(ended, [])
  assert.ok(tookMs < budgetMs, `the start of ${budgetMs} ms answered after ${tookMs} ms`)
  assert.deepEqual(stats.problems, [late], 'no capture was asked for with too little time left to finish')
})

test('the window route\'s readings keep the default grace: one that ignores SIGTERM is killed only once that grace has passed', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-macos-stubborn-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const stubborn = join(folder, 'stubborn')
  await writeFile(stubborn, "#!/bin/sh\ntrap '' TERM\nsleep 30\n")
  await chmod(stubborn, 0o755)
  const tools = { ...systemTools, lsappinfo: stubborn, ps: stubborn, osascript: stubborn }
  // The timeout leaves the shell time to set its trap before SIGTERM comes, even on a loaded machine.
  const timeoutMs = 500
  const readings: readonly (readonly [string, () => Promise<unknown>])[] = [
    ['lsappinfo', () => macosAppProcesses(tools, bundleId, { timeoutMs })],
    ['ps', () => commandOf(tools, process.pid, timeoutMs)],
    ['osascript', () => windowsOnScreen(tools, { timeoutMs })],
  ]
  for (const [name, read] of readings) {
    const began = performance.now()
    await read()
    const tookMs = performance.now() - began
    assert.ok(tookMs >= timeoutMs + terminationGraceMs, `${name} was ended after ${tookMs} ms`)
  }
})

test('a window list or process list that ran out of its time is told from one that could not be read', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'retest-macos-readings-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const slow = join(folder, 'slow')
  const failing = join(folder, 'failing')
  await writeFile(slow, '#!/bin/sh\nsleep 30\n')
  await writeFile(failing, "#!/bin/sh\necho 'execution error: the window server did not answer (-1712)' >&2\nexit 1\n")
  await chmod(slow, 0o755)
  await chmod(failing, 0o755)
  assert.deepEqual(await readWindowsOnScreen({ ...systemTools, osascript: slow }, { timeoutMs: 200 }), { ok: false, problem: 'osascript did not finish in time and was ended', timedOut: true })
  assert.deepEqual(await readWindowsOnScreen({ ...systemTools, osascript: failing }, { timeoutMs: 10_000 }), { ok: false, problem: 'osascript ended with exit code 1: execution error: the window server did not answer (-1712)', timedOut: false })
  await assert.rejects(listProcesses({ ...systemTools, ps: slow }, 200), (error: unknown) => error instanceof ProcessListUnread && error.timedOut && error.message === 'ps did not finish in time and was ended')
  await assert.rejects(listProcesses({ ...systemTools, ps: failing }, 10_000), (error: unknown) => error instanceof ProcessListUnread && !error.timedOut)
})

test('a window image a capture wrote is gone when Retest exits before the capture removed it', darwinOnly, async (t) => {
  // screencapture writes the image, then never answers, so the image is on disk when the process exits.
  const setup = await setUp(t, { screencaptureHangsAfterImage: true })
  const script = join(setup.fake.root, 'exit-mid-capture.ts')
  await writeFile(script, [
    "import { existsSync, readFileSync } from 'node:fs'",
    `import { MacosDesktop } from ${JSON.stringify(new URL('../../src/native/macos-app.ts', import.meta.url).pathname)}`,
    `const started = await MacosDesktop.start({ build: ${JSON.stringify(setup.build)}, tools: ${JSON.stringify(setup.fake.tools)}, logFolder: ${JSON.stringify(join(setup.fake.root, 'logs'))}, timeoutMs: 20000, desktopLock: ${JSON.stringify(join(setup.fake.root, 'desktop.lock'))} })`,
    'if (!started.ok) throw new Error(started.failure.message)',
    `const app = await started.desktop.openApp(${JSON.stringify(setup.appPath)})`,
    'if (!app.ok) throw new Error(app.failure.message)',
    `const opened = await app.runtime.openSession({ owner: ${JSON.stringify(owner)}, launch: { arguments: ['-reset'], environment: {} }, redact: (text) => text }, 5000)`,
    'if (!opened.ok) throw new Error(opened.failure.message)',
    'await opened.session.launch(10000)',
    'void opened.session.capture(20000)',
    `const calls = ${JSON.stringify(join(setup.fake.root, 'calls.jsonl'))}`,
    'for (;;) {',
    "  const shot = readFileSync(calls, 'utf8').split('\\n').filter((line) => line.length > 0).map((line) => JSON.parse(line)).find((call) => call.tool === 'screencapture')",
    '  const file = shot?.args.at(-1)',
    "  if (file !== undefined && existsSync(file)) { process.stdout.write(`${file}\\n`); process.exit(42) }",
    '  await new Promise((resolve) => setTimeout(resolve, 5))',
    '}',
  ].join('\n'))
  const child = spawn(process.execPath, ['--conditions=retest-source', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => child.kill('SIGKILL'))
  let said = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { said += chunk })
  const code = await new Promise<number | null>((resolve) => child.once('exit', (exitCode) => resolve(exitCode)))
  const file = said.trim()
  t.after(() => rm(dirname(file), { recursive: true, force: true }))
  assert.equal(code, 42, said)
  assert.match(file, /\/retest-macos-[^/]+\/window-1\.png$/)
  await assert.rejects(access(file), 'the window image went with the process')
  await assert.rejects(access(dirname(file)), 'and so did the desktop\'s folder it was written to')
})

test('a capture whose tree is not yet the app\'s says so, as a refusal that may clear', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  await writeFile(join(setup.fake.root, 'config.json'), JSON.stringify({ appName: 'Elsewhere', screen: { width: 40, height: 30, scale: 2 }, window: { x: 4, y: 3, width: 20, height: 10 } }))
  const capture = await opened.session.capture(10_000)
  assert.deepEqual(!capture.ok && capture.failure, { class: 'not_actionable', message: 'Capturing the screen: The tree is not of the owned app: its root names another app, not "TaskDesk".', details: { transient: true } })
})

test('a window capture that runs past its budget is a dropped frame inside the loop\'s limit, and the loop asks again', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  const source = opened.session.frameSource(sessionRecordIdentity(opened.session.identity))
  const frames: CapturedFrame[] = []
  const ended: string[] = []
  assert.deepEqual(await source.start(recordingStart(frames, ended, 20_000)), { ok: true, mode: 'screenshot-loop' })
  const asked = hangingShots(setup.fake.root)
  // screencapture never answers and ignores SIGTERM, so only the kill after its grace ends it.
  await setup.fake.configure({ screencaptureHangs: true })
  await until(() => hangingShots(setup.fake.root) > asked, 'a screencapture that hangs', 20_000)
  await setup.fake.configure({})
  const before = frames.length
  await until(() => frames.length > before || ended.length > 0, 'a frame after the capture that ran over', 30_000)
  const stats = await source.stop(10_000)
  assert.deepEqual(ended, [], 'the loop went on after the capture that ran over')
  assert.equal(stats.endedEarly, undefined)
  assert.ok(stats.problems.some((problem) => /^macOS gave no image of the app's window in time \(screencapture did not finish in time and was ended\)\. Retest captured nothing\.$/.test(problem)), stats.problems.join(' | '))
  assert.ok(stats.dropped >= 1)
  assert.ok((stats.captureMs?.maxMs ?? Infinity) < nativeCaptureTimeoutMs, `the longest capture took ${stats.captureMs?.maxMs} ms`)
})

// The pids that were sent SIGTERM, as the fake runner apps note them.
async function signalled(root: string): Promise<number[]> {
  return (await readFile(join(root, 'signals.txt'), 'utf8').catch(() => '')).split('\n').filter((line) => line.endsWith(' SIGTERM')).map((line) => Number.parseInt(line, 10))
}

async function launchedSession(t: TestContext, tools: Record<string, unknown> = {}, executor: Record<string, unknown> = {}): Promise<{ readonly setup: Awaited<ReturnType<typeof setUp>>; readonly opened: Awaited<ReturnType<MacosDesktop['openSession']>> & { readonly ok: true } }> {
  const setup = await setUp(t, tools, executor)
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  t.after(() => opened.session.dispose(5000).catch(() => undefined))
  return { setup, opened }
}

test('closing the desktop ends the runner app Retest recorded itself, when neither its shutdown nor xcodebuild ends it', darwinOnly, async (t) => {
  const setup = await setUp(t, { runnerSurvivesXcodebuild: true, runnerIgnoresShutdown: true })
  const desktop = await startDesktop(t, setup)
  const runnerApp = desktop.processIds[1] ?? 0
  await desktop.close(20_000)
  assert.equal(alive(runnerApp), false)
  assert.deepEqual(await signalled(setup.fake.root), [runnerApp], 'Retest sent the recorded runner app its SIGTERM')
})

test('the app\'s process is found by its bundle id wherever macOS runs it from', darwinOnly, async (t) => {
  // macOS can run an app from somewhere else than its path, as it does for a quarantined download.
  const { setup, opened } = await launchedSession(t, {}, { appCommand: '/private/var/folders/AppTranslocation/X/d/TaskDesk.app/Contents/MacOS/TaskDesk' })
  assert.deepEqual(await opened.session.launch(10_000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(opened.session.processIds, [readApps(setup.fake.root)[setup.appPath]?.pid])
  assert.deepEqual(await opened.session.terminate(10_000), { result: { ok: true }, input: 'sent' })
})

test('a copy of the app running from another path, with the same bundle id, blocks the launch by its pid', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  const elsewhereFolder = join(setup.fake.root, 'elsewhere')
  await mkdir(elsewhereFolder, { recursive: true })
  const elsewhere = await realpath(await fakeAppBundle(elsewhereFolder, { platform: 'macos', name: 'TaskDesk', bundleId }))
  const copy = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => copy.kill('SIGKILL'))
  await writeFile(join(setup.fake.root, 'apps.json'), JSON.stringify({ ...readApps(setup.fake.root), [elsewhere]: { pid: copy.pid, command: join(elsewhere, 'Contents', 'MacOS', 'TaskDesk') } }))
  const launched = await opened.session.launch(10_000)
  assert.equal(launched.input, 'not_sent')
  assert.match(!launched.result.ok ? launched.result.failure.message : '', new RegExp(`already running \\(pid ${copy.pid}\\)`))
  assert.equal(alive(copy.pid), true)
})

test('a start whose desktop record cannot be written stops what it started and leaves nothing running', darwinOnly, async (t) => {
  const setup = await setUp(t, { xcodebuildReplacesRecord: true })
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!started.ok ? started.failure.message : '', /could not record the executor's processes: The desktop record .* is not this process's/)
  for (let tries = 0; tries < 50 && (await startedProcesses(setup.fake.root)).some(alive); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual((await startedProcesses(setup.fake.root)).filter(alive), [], 'xcodebuild and the runner app are gone')
})

test('a window list that cannot be read after the image refuses the capture, naming that reading', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  await writeFile(join(setup.fake.root, 'window-list-readings.txt'), '')
  await setup.fake.configure({ windowListReadings: 1 })
  const capture = await opened.session.capture(10_000)
  assert.equal(capture.ok, false)
  assert.match(!capture.ok ? capture.failure.message : '', /^After the image was taken: Retest could not read which windows are on screen \(osascript ended with exit code 1: execution error: the window server did not answer \(-1712\)\)\. Retest captured nothing\.$/)
})

test('the desktop never runs its runner on the executor\'s default port', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock'), port: 10100 })
  assert.match(!started.ok ? started.failure.message : '', /Port 10100 is an executor's default port/)
  assert.equal((await setup.fake.calls()).some((call) => call.tool === 'xcodebuild' && call.args[0] === 'test-without-building'), false)
})

test('a start killed before its runner app answered leaves that runner app named in the record, and it is never ended', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'runner-not-ready', runnerSurvivesXcodebuild: true })
  const lock = join(setup.fake.root, 'desktop.lock')
  const script = join(setup.fake.root, 'start-desktop.ts')
  await writeFile(script, [
    `import { MacosDesktop } from ${JSON.stringify(new URL('../../src/native/macos-app.ts', import.meta.url).pathname)}`,
    `await MacosDesktop.start({ build: ${JSON.stringify(setup.build)}, tools: ${JSON.stringify(setup.fake.tools)}, logFolder: ${JSON.stringify(join(setup.fake.root, 'logs'))}, timeoutMs: 60000, desktopLock: ${JSON.stringify(lock)} })`,
  ].join('\n'))
  const starter = spawn(process.execPath, ['--conditions=retest-source', script], { stdio: 'ignore' })
  t.after(() => starter.kill('SIGKILL'))
  // Waits until the record names the runner app as one not yet tied to the start, then kills the starter outright.
  let untied: { pid: number; command: string } | undefined
  for (let tries = 0; tries < 200 && untied === undefined; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
    const record = readJsonFile(join(setup.fake.root, 'desktop.json'))
    const listed = isPlainObject(record) && Array.isArray(record['untied']) ? record['untied'][0] : undefined
    if (isPlainObject(listed) && typeof listed['pid'] === 'number' && typeof listed['command'] === 'string') untied = { pid: listed['pid'], command: listed['command'] }
  }
  if (untied === undefined) throw new Error('the record never named the runner app')
  starter.kill('SIGKILL')
  await new Promise((resolve) => starter.once('exit', resolve))
  const refused = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: lock })
  assert.match(!refused.ok ? refused.failure.message : '', new RegExp(`A runner app \\(pid ${untied.pid}\\) appeared during that process's start, which ended before tying it to the start, so Retest did not end it`))
  assert.equal(alive(untied.pid), true, 'a runner app never tied to a start is not ended')
  process.kill(untied.pid, 'SIGKILL')
  await setup.fake.configure({})
  const taken = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: lock })
  assert.ok(taken.ok, taken.ok ? '' : taken.failure.message)
  if (taken.ok) await taken.desktop.close(20_000)
})

test('a capture is taken whatever covers the app\'s window: the whole screen, its centre or its corner, of any owner', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  const owner = await fakeWindowProcess(setup.fake, '/Applications/Floating.app/Contents/MacOS/Floating')
  for (const window of [{ x: 0, y: 0, width: 40, height: 30 }, { x: 12, y: 6, width: 4, height: 4 }, { x: 22, y: 11, width: 6, height: 6 }]) {
    await setup.fake.configure({ coveringWindow: { layer: 1000, pid: owner, ...window } })
    const taken = await opened.session.capture(10_000)
    assert.ok(taken.ok, taken.ok ? '' : taken.failure.message)
    if (taken.ok) assert.deepEqual([taken.capture.width, taken.capture.height], [40, 20])
  }
})

function desktopOptions(setup: { readonly fake: FakeTools; readonly build: ExecutorBuild }): Parameters<typeof MacosDesktop.start>[0] {
  return { build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') }
}

test('a desktop start refused before its runner was started says it left nothing behind', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const wrong = await MacosDesktop.start({ ...desktopOptions(setup), build: { ...setup.build, executor: 'webdriveragent' } })
  assert.deepEqual(!wrong.ok && [wrong.failure.message, wrong.idle], ['The macOS desktop needs a build of the macOS runner, not webdriveragent.', true])
  const desktop = await startDesktop(t, setup)
  const second = await MacosDesktop.start(desktopOptions(setup))
  assert.deepEqual(!second.ok && second.idle, true, 'this process already runs the runner')
  await desktop.close(20_000)
  const held = await takeDesktopLock({ path: join(setup.fake.root, 'desktop.lock'), tools: setup.fake.tools })
  if (!held.ok) throw new Error(held.failure.message)
  const locked = await MacosDesktop.start(desktopOptions(setup))
  assert.match(!locked.ok ? locked.failure.message : '', /already holds the desktop lock/)
  assert.equal(!locked.ok && locked.idle, true, 'the desktop lock is held')
  await held.lock.release()
  await setup.fake.configure({ xcodeBuild: '17A1' })
  const xcode = await MacosDesktop.start(desktopOptions(setup))
  assert.deepEqual(!xcode.ok && xcode.idle, true, 'another Xcode')
  await setup.fake.configure({})
  const free = await takeDesktopLock({ path: join(setup.fake.root, 'desktop.lock'), tools: setup.fake.tools })
  assert.ok(free.ok, 'every refusal let the desktop lock go')
  if (free.ok) await free.lock.release()
})

test('a desktop start whose runner was started never says it left nothing behind', darwinOnly, async (t) => {
  const setup = await setUp(t, { executorStart: 'fail' })
  // A private sweep root keeps unrelated fixture records from refusing this launch.
  const temporary = await mkdtemp(join(setup.fake.root, 'start-'))
  const previousTemporary = process.env['TMPDIR']
  process.env['TMPDIR'] = temporary
  let failed: Awaited<ReturnType<typeof MacosDesktop.start>>
  try { failed = await MacosDesktop.start(desktopOptions(setup)) }
  finally {
    if (previousTemporary === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = previousTemporary
  }
  assert.equal(failed.ok, false)
  assert.equal((await setup.fake.calls()).filter((call) => call.tool === 'xcodebuild' && call.args[0] === 'test-without-building').length, 1, 'the failing executor was actually launched: ' + JSON.stringify(failed))
  assert.equal(!failed.ok && failed.idle, undefined)
})

test('a desktop closed cleanly leaves its record naming nothing of its runner', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const desktop = await startDesktop(t, setup)
  const running = readJsonFile(join(setup.fake.root, 'desktop.json'))
  assert.ok(isPlainObject(running) && isPlainObject(running['xcodebuild']), 'while it runs, the record names xcodebuild')
  await desktop.close(20_000)
  const record = readJsonFile(join(setup.fake.root, 'desktop.json'))
  assert.ok(isPlainObject(record))
  assert.deepEqual([record['pid'], record['xcodebuild'], record['runnerApps'], record['untied']], [process.pid, undefined, [], []])
})

test('a start deletes the run folders a gone Retest process left, and a close leaves none of its own', darwinOnly, async (t) => {
  const setup = await setUp(t)
  const temporary = await mkdtemp(join(tmpdir(), 'retest-native-tmp-'))
  const earlier = process.env['TMPDIR']
  process.env['TMPDIR'] = temporary
  t.after(async () => {
    if (earlier === undefined) delete process.env['TMPDIR']
    else process.env['TMPDIR'] = earlier
    await rm(temporary, { recursive: true, force: true })
  })
  const stale = join(temporary, 'retest-executor-stale')
  await mkdir(join(stale, 'result.xcresult'), { recursive: true })
  await writeFile(join(stale, 'retest-owner.json'), JSON.stringify({ startTimeVersion: 1, pid: await endedPid(), startedAt: 'Mon Oct 5 09:00:00 2026' }))
  const unrecorded = join(temporary, 'retest-executor-unrecorded')
  await mkdir(unrecorded)
  const desktop = await startDesktop(t, setup)
  const during = (await readdir(temporary)).sort()
  assert.equal(during.includes('retest-executor-stale'), false, 'the stale folder was deleted at the start')
  assert.ok(during.includes('retest-executor-unrecorded'), 'a folder without a record of its maker is kept')
  const own = during.filter((name) => name.startsWith('retest-executor-') && name !== 'retest-executor-unrecorded')
  assert.equal(own.length, 1, `the start made one executor folder (${during.join(', ')})`)
  assert.deepEqual(JSON.parse(await readFile(join(temporary, own[0] ?? '', 'retest-owner.json'), 'utf8'))['pid'], process.pid)
  await desktop.close(20_000)
  assert.deepEqual((await readdir(temporary)).sort(), ['retest-executor-unrecorded'], 'the close deleted the executor and desktop folders')
})
