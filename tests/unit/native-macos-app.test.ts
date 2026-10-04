import type { TestContext } from 'node:test'
import type { ExecutorBuild } from '../../src/native/executors.ts'
import type { FakeTools } from './native-fake-tools.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { automationOverlayPids, coveringWindows, MacosDesktop } from '../../src/native/macos-app.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { decodePng } from '../../src/native/png.ts'
import { alive, readApps, readJsonFile, readRequests } from './native-fake-executor.ts'
import { fakeAppBundle, fakeTools, fakeWindowProcess, startedProcesses } from './native-fake-tools.ts'

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
  // The 20x10-point window at scale 2, cut from the 80x60 display capture.
  assert.deepEqual([capture.capture.width, capture.capture.height, capture.capture.source], [40, 20, 'window-crop'])
  assert.equal(decodePng(capture.capture.png).width, 40)
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
  if (opened.ok) await opened.session.dispose(5000)
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

test('a window of another process over the app\'s window refuses the capture by name', darwinOnly, async (t) => {
  const setup = await setUp(t, { coveringWindow: { layer: 1000, x: 10, y: 5, width: 6, height: 6 } })
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  await opened.session.launch(10_000)
  const capture = await opened.session.capture(10_000)
  assert.equal(capture.ok, false)
  assert.match(!capture.ok ? capture.failure.message : '', /1 window\(s\) of other processes lie over the app's window \(layer 1000\)/)
  await opened.session.dispose(5000)
})

test('the windows over an app window are the other processes\' windows in front of it that overlap it, the Dock\'s surface aside', () => {
  const frame = { x: 100, y: 100, width: 200, height: 100 }
  const screen = { x: 0, y: 0, width: 1728, height: 1117 }
  const own = { pid: 50, layer: 0, ...frame }
  const dock = { pid: 60, layer: 20, ...screen }
  const panel = { pid: 70, layer: 1000, x: 250, y: 150, width: 100, height: 100 }
  const elsewhere = { pid: 80, layer: 0, x: 400, y: 400, width: 50, height: 50 }
  const behind = { pid: 90, layer: 0, x: 0, y: 0, width: 1728, height: 1000 }
  assert.deepEqual(coveringWindows([dock, panel, elsewhere, own, behind], { pids: [50], frame }, { screen, dockPids: [60] }), { ok: true, windows: [panel] })
  assert.deepEqual(coveringWindows([dock, own], { pids: [50], frame }, { screen, dockPids: [] }), { ok: true, windows: [dock] }, 'a full-screen window not of the Dock counts')
  assert.equal(coveringWindows([dock, behind], { pids: [50], frame }, { screen, dockPids: [60] }).ok, false, 'no window of the app where its tree places it')
})

test('the Automation Mode overlay over the whole screen is passed over by its owner, and nothing else is', () => {
  const frame = { x: 100, y: 100, width: 200, height: 100 }
  const screen = { x: 0, y: 0, width: 1728, height: 1117 }
  const own = { pid: 50, layer: 0, ...frame }
  const overlay = { pid: 70, layer: 1000, ...screen }
  const pointer = { pid: 601, layer: 2147483630, x: 150, y: 120, width: 28, height: 28 }
  const overlayPanel = { pid: 70, layer: 1000, x: 120, y: 110, width: 100, height: 40 }
  const otherFullScreen = { pid: 80, layer: 1000, ...screen }
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

test('the fake window list allows the system overlay during a session and refuses another owner at the same layer', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  const overlay = await fakeWindowProcess(setup.fake, '/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI')
  const window = { layer: 1000, x: 0, y: 0, width: 40, height: 30 }
  await setup.fake.configure({ coveringWindow: { pid: overlay, ...window } })
  assert.deepEqual(await opened.session.launch(10_000), { result: { ok: true }, input: 'sent' })
  const allowed = await opened.session.capture(10_000)
  assert.ok(allowed.ok, allowed.ok ? '' : allowed.failure.message)
  if (allowed.ok) assert.deepEqual([allowed.capture.width, allowed.capture.height], [40, 20])
  const other = await fakeWindowProcess(setup.fake, '/Applications/Another.app/Contents/MacOS/AutomationModeUI')
  await setup.fake.configure({ coveringWindow: { pid: other, ...window } })
  const refused = await opened.session.capture(10_000)
  assert.equal(refused.ok, false)
  assert.match(!refused.ok ? refused.failure.message : '', /1 window\(s\) of other processes lie over the app's window \(layer 1000\)/)
  await opened.session.dispose(5000)
  const ended = await opened.session.capture(5000)
  assert.equal(ended.ok, false, 'a disposed session cannot capture through the overlay exception')
})

test('two runner apps launched by the fake executor refuse its identity and are cleaned through recorded ancestry', darwinOnly, async (t) => {
  const setup = await setUp(t, { extraRunnerApp: true })
  const started = await MacosDesktop.start({ build: setup.build, tools: setup.fake.tools, logFolder: join(setup.fake.root, 'logs'), timeoutMs: 20_000, desktopLock: join(setup.fake.root, 'desktop.lock') })
  assert.match(!started.ok ? started.failure.message : '', /2 runner apps \(pid \d+, \d+\) appeared during this start, so Retest cannot tell which one is its own/)
  assert.deepEqual((await startedProcesses(setup.fake.root)).filter(alive), [], 'the fake xcodebuild itself launched both apps; verified ancestry owns them')
})

test('a capture is refused when the windows on screen change between the readings around it', darwinOnly, async (t) => {
  const setup = await setUp(t, { windowsChange: true })
  const desktop = await startDesktop(t, setup)
  const app = await desktop.openApp(setup.appPath)
  if (!app.ok) throw new Error(app.failure.message)
  const opened = await app.runtime.openSession(session, 5000)
  if (!opened.ok) throw new Error(opened.failure.message)
  await opened.session.launch(10_000)
  const capture = await opened.session.capture(10_000)
  assert.match(!capture.ok ? capture.failure.message : '', /windows on screen changed while the display was captured/)
  await opened.session.dispose(5000)
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

test('a window list that cannot be read after the display capture refuses the capture, naming that reading', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  await writeFile(join(setup.fake.root, 'window-list-readings.txt'), '')
  await setup.fake.configure({ windowListReadings: 1 })
  const capture = await opened.session.capture(10_000)
  assert.equal(capture.ok, false)
  assert.match(!capture.ok ? capture.failure.message : '', /could not read which windows were on screen after the display was captured \(osascript.*\)/)
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

test('a capture under the Automation Mode overlay is taken, and one under a full-screen window of another process is refused', darwinOnly, async (t) => {
  const { setup, opened } = await launchedSession(t)
  await opened.session.launch(10_000)
  const overlayProcess = spawn('sleep', ['600'], { detached: true, stdio: 'ignore' })
  t.after(() => overlayProcess.kill('SIGKILL'))
  const listed = readJsonFile(join(setup.fake.root, 'processes.json'))
  const others = Array.isArray(listed) ? listed : []
  const overlayCommand = '/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI'
  await writeFile(join(setup.fake.root, 'processes.json'), JSON.stringify([...others, { pid: overlayProcess.pid, command: overlayCommand }]))
  await setup.fake.configure({ coveringWindow: { layer: 1000, x: 0, y: 0, width: 40, height: 30, pid: overlayProcess.pid } })
  const taken = await opened.session.capture(10_000)
  assert.ok(taken.ok, taken.ok ? '' : taken.failure.message)
  // The same window owned by a process that is not AutomationModeUI lies over the app's window.
  await writeFile(join(setup.fake.root, 'processes.json'), JSON.stringify([...others, { pid: overlayProcess.pid, command: '/Applications/Floating.app/Contents/MacOS/Floating' }]))
  const refused = await opened.session.capture(10_000)
  assert.match(!refused.ok ? refused.failure.message : '', /1 window\(s\) of other processes lie over the app's window \(layer 1000\)/)
})
