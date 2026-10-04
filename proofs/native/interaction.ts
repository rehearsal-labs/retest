/**
 * Runs Retest's native finds, input and checks, `src/native`, on the real targets once, against the cross-platform
 * fixture service: TaskPhone on a simulator the runtime creates signs in with a text field and a secure field, shows
 * its software keyboard and has it dismissed, creates a task and reads its id from the screen; TaskDesk, through the
 * desktop's macOS runner, signs in, finds that task by its id and reads its state. Each half also checks a wrong state
 * on purpose and records the failure. TaskDesk's window is placed at 20,60 so it lies clear of the floating window at
 * the centre of this screen, and whether its capture passed the coverage check is recorded.
 *
 *   node --conditions=retest-source proofs/native/interaction.ts [--only ios|macos]
 *
 * It takes the desktop and a simulator; run it under the heavy gate lock. Exit 0 when every step passed, 1 otherwise.
 * Captures go under ~/Library/Caches/retest-proofs/artifacts/interaction/<run>/; no tree is kept, since an iOS tree
 * holds the keyboard's languages.
 */
import type { ExecutorName } from '../../src/native/executors.ts'
import type { NativeCheckRecord } from '../../src/native/assertions.ts'
import type { NativeAppSession, NativeCapture, ProcessReading } from '../../src/native/session.ts'
import type { RequestBounds } from '../../src/native/webdriver-client.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { JsonValue } from './shared/webdriver.ts'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { CLIENT_HEADER } from '../../fixtures/cross-platform/service/clients.ts'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { ensureExecutorBuild } from '../../src/native/executors.ts'
import { NativeInteractionSession } from '../../src/native/interaction-session.ts'
import { IosSimulatorRuntime, simulatorAppProcesses } from '../../src/native/ios-simulator.ts'
import { MacosDesktop, windowsOnScreen } from '../../src/native/macos-app.ts'
import { decodePng, distinctColours } from '../../src/native/png.ts'
import { listProcesses, systemTools } from '../../src/native/processes.ts'
import { attachExecutorSession, ExecutorClient } from '../../src/native/webdriver-client.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { CACHE_ROOT, ProofRecord, StepStopped } from './shared/evidence.ts'

const { values } = parseArgs({ options: { only: { type: 'string' } } })
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')
const artifacts = join(CACHE_ROOT, 'artifacts', 'interaction', stamp)
const sources: Record<ExecutorName, string> = { webdriveragent: join(CACHE_ROOT, 'WebDriverAgent'), mac2: join(CACHE_ROOT, 'appium-mac2-driver') }
const taskPhone = join(CACHE_ROOT, 'derived', 'taskphone', 'Build', 'Products', 'Debug-iphonesimulator', 'TaskPhone.app')
const taskDesk = join(CACHE_ROOT, 'derived', 'taskdesk', 'Build', 'Products', 'Debug', 'TaskDesk.app')
const windowFrame = '20,60,700,480'
const actionMs = 20_000
const checkMs = 15_000
const [ada] = SEEDED_ACCOUNTS
if (ada === undefined) throw new Error('the fixture service seeds no account')
// The fixture's own seeded password, typed as a secret and learned by the sessions' redaction.
const redactor = new Redactor()
redactor.learn('password', ada.password)
const redact = (text: string): string => redactor.redact(text)
await mkdir(artifacts, { recursive: true })
const logs = await mkdtemp(join(tmpdir(), 'retest-native-interaction-'))
const record = new ProofRecord("Retest's native finds, input and checks on the real simulator and the real macOS runner")
record.facts['artifacts'] = artifacts
const requests: string[] = []
const service = await startTaskService({ port: 0, syncDelayMs: 1000, printLine: (line) => requests.push(line) })
await fetch(new URL('/admin/reset', service.url), { method: 'POST', headers: { [CLIENT_HEADER]: 'test' } })

// The runtimes keep the executor session they open; every executor answer names its one active session, so the proof
// attaches to that one, as the integration test does, until the wiring hands the runtime's own over.
async function attach(port: number, executor: ExecutorName): Promise<{ readonly client: ExecutorClient; readonly session: ReturnType<typeof attachExecutorSession> }> {
  const answer = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(10_000) })
  const body: unknown = await answer.json()
  const id = isPlainObject(body) && typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
  if (id === undefined) throw new Error('the executor names no active session')
  const client = new ExecutorClient({ executor, host: '127.0.0.1', port })
  return { client, session: attachExecutorSession(client, id) }
}

async function saveCapture(capture: NativeCapture, label: string, note: (fact: string) => void): Promise<void> {
  const { reference, source } = capture
  const path = join(artifacts, `${reference.sessionId.replace(':', '-')}-launch${reference.generation}-${reference.observationId}-${label}-${source}.png`)
  await writeFile(path, capture.png)
  record.artifact(path)
  note(`${source} ${capture.width}x${capture.height}, ${distinctColours(decodePng(capture.png))} colours`)
}

async function keepCapture(session: NativeAppSession, source: 'executor-screen' | 'simulator-display', label: string, note: (fact: string) => void): Promise<void> {
  const shot = await session.capture(30_000, { source })
  if (!shot.ok) throw new Error(shot.failure.message)
  await saveCapture(shot.capture, label, note)
}

function require(done: { readonly result: { readonly ok: boolean; readonly failure?: { readonly message: string } }; readonly input: string }, what: string, note: (fact: string) => void): void {
  if (!done.result.ok) throw new Error(`${what}: ${done.result.failure?.message ?? ''}`)
  note(`${what}: input ${done.input}`)
}

async function check(interaction: NativeInteractionSession, locator: LocatorRecipe, record: NativeCheckRecord, timeoutMs: number): Promise<string> {
  const result = await interaction.expect(locator, record, timeoutMs)
  if (!result.passed) throw new Error(result.failure?.message ?? 'the check did not pass')
  return result.actual?.text ?? ''
}

// A wrong state, checked on purpose: the step passes only when the check fails as a check, naming the element.
async function wrongState(interaction: NativeInteractionSession, locator: LocatorRecipe, expected: string, note: (fact: string) => void): Promise<string> {
  const result = await interaction.expect(locator, { matcher: 'toHaveText', text: expected }, 1500)
  if (result.passed || result.failure?.class !== 'check_failed') throw new Error(`the wrong state did not fail as a check: ${result.failure?.class ?? 'it passed'}`)
  note(result.failure.message)
  return result.failure.message
}

// What lies over TaskDesk's window when its capture is refused: each window's layer, and whether it is Automation
// Mode's own overlay. No other process is named, since another app's name is the user's own.
const automationModeOverlay = '/System/Library/PrivateFrameworks/AutomationMode.framework/AutomationModeUI.app/Contents/MacOS/AutomationModeUI'
async function coveringFacts(session: NativeAppSession): Promise<JsonValue> {
  const tree = await session.readSource(10_000)
  const frame = tree.ok ? tree.tree.source.window : undefined
  const windows = await windowsOnScreen(systemTools, { timeoutMs: 10_000 })
  if (frame === undefined || typeof windows === 'string') return 'unread'
  const listed = await listProcesses(systemTools, 10_000)
  const own = new Set(session.processIds)
  const index = windows.findIndex((entry) => own.has(entry.pid))
  const over = windows.slice(0, index === -1 ? windows.length : index).filter((entry) => !own.has(entry.pid) && entry.layer !== 2147483630 && entry.x < frame.x + frame.width && frame.x < entry.x + entry.width && entry.y < frame.y + frame.height && frame.y < entry.y + entry.height)
  return over.map((entry) => ({ layer: entry.layer, wholeScreen: entry.x === 0 && entry.y === 0 && entry.width >= frame.width, automationModeOverlay: listed.some((process) => process.pid === entry.pid && process.command === automationModeOverlay) }))
}

let createdId = 'seed-ada-1'
try {
  if (values.only !== 'macos') {
    const build = await record.step('find the pinned WebDriverAgent', async (note) => {
      const ensured = await ensureExecutorBuild({ executor: 'webdriveragent', sources, logFile: join(logs, 'wda-build.log'), timeoutMs: 30 * 60_000, tools: systemTools })
      if (!ensured.ok) throw new Error(ensured.failure.message)
      note(`${ensured.action}, products ${ensured.build.productsSha256.slice(0, 16)}`)
      return ensured.build
    })
    const runtime = await record.step('start an iOS simulator runtime for TaskPhone', async (note) => {
      const started = await IosSimulatorRuntime.start({ target: { appPath: taskPhone, device: 'iPhone 17', runtime: '26.5' }, build, tools: systemTools, logFolder: logs, timeoutMs: 600_000 })
      if (!started.ok) throw new Error(started.failure.message)
      record.facts['ios'] = { execution: started.runtime.execution }
      note(`simulator ${started.runtime.udid}, WebDriverAgent on 127.0.0.1:${started.runtime.port}`)
      return started.runtime
    })
    try {
      const { session, interaction } = await record.step('open a session, install and launch TaskPhone', async (note) => {
        const opened = await runtime.openSession({ owner: { runId: stamp, testId: 'interaction', attemptId: 'proof', app: 'phone' }, launch: { arguments: ['-reset', '-serviceURL', service.url], environment: {} }, redact }, 30_000)
        if (!opened.ok) throw new Error(opened.failure.message)
        require(await opened.session.install({ appPath: taskPhone }, 120_000), 'install', note)
        require(await opened.session.launch(120_000), 'launch', note)
        const attached = await attach(runtime.port, 'webdriveragent')
        const processes = (bounds: RequestBounds): Promise<ProcessReading> => simulatorAppProcesses(systemTools, runtime.udid, runtime.bundle.bundleId, bounds)
        return { session: opened.session, interaction: new NativeInteractionSession({ session: opened.session, client: attached.client, executor: attached.session, redact, processes }) }
      })
      await record.step('tap the account field, see the software keyboard come up, and dismiss it by its return key', async (note) => {
        require(await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, actionMs), 'tap the account field', note)
        const keyboard = await interaction.waitForKeyboard(checkMs)
        if (!keyboard.ok) throw new Error(keyboard.failure.message)
        record.facts['iosFirstRunCard'] = keyboard.state.firstRunCard
        note(`keyboard up, first-run card ${keyboard.state.firstRunCard ? 'shown' : 'not shown'}`)
        await keepCapture(session, 'simulator-display', 'keyboard', note)
        if (keyboard.state.firstRunCard) require(await interaction.dismissFirstRunCard(actionMs), 'dismiss the first-run card', note)
        require(await interaction.dismissKeyboard(actionMs), 'dismiss the keyboard', note)
        const after = await interaction.keyboardState(checkMs)
        if (!after.ok || after.state.shown) throw new Error('the keyboard is still up')
      })
      await record.step('sign in with the text field and the secure field', async (note) => {
        require(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: ada.id }, actionMs), 'fill the account', note)
        require(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: ada.password, secret: 'password' }, actionMs), 'fill {{password}}', note)
        require(await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, actionMs), 'tap sign in', note)
        note(`signed in as ${await check(interaction, { by: 'testId', value: 'signed-in-account' }, { matcher: 'toHaveText', text: ada.id }, checkMs)}`)
      })
      await record.step('create a task and read its id and state from the screen', async (note) => {
        const title = `Proof task ${stamp}`
        require(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'new-task-title-field' }, value: title }, actionMs), 'fill the title', note)
        require(await interaction.dismissKeyboard(actionMs), "dismiss the keyboard by its 'done' key", note)
        require(await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'create-task-button' } }, actionMs), 'tap create', note)
        createdId = await check(interaction, { by: 'testId', value: 'created-task-id' }, { matcher: 'toHaveText', pattern: { pattern: '^task-[0-9a-f]{12}$', flags: '' } }, checkMs)
        const state = await check(interaction, { by: 'testId', value: 'created-task-state' }, { matcher: 'toHaveText', text: 'Open' }, checkMs)
        record.facts['createdTaskId'] = createdId
        note(`created ${createdId}, state ${state}`)
        await keepCapture(session, 'executor-screen', 'created', note)
        await keepCapture(session, 'simulator-display', 'created', note)
      })
      await record.step('check a wrong state on purpose and see it fail naming the element', async (note) => {
        record.facts['iosWrongState'] = await wrongState(interaction, { by: 'testId', value: 'created-task-state' }, 'Done', note)
      })
      record.facts['iosInputs'] = interaction.inputs.map((input) => `${input.kind} ${input.route} ${input.input}${input.readBack === undefined ? '' : ` read back ${input.readBack}`}`)
      await record.cleanup('dispose the session', async () => interaction.dispose(60_000))
    } finally {
      await record.cleanup('close the runtime', async () => runtime.close(180_000))
    }
  }
  if (values.only !== 'ios') {
    const build = await record.step('find the pinned macOS runner', async (note) => {
      const ensured = await ensureExecutorBuild({ executor: 'mac2', sources, adoptFrom: [join(CACHE_ROOT, 'derived', 'mac2')], logFile: join(logs, 'mac2-build.log'), timeoutMs: 30 * 60_000, tools: systemTools })
      if (!ensured.ok) throw new Error(ensured.failure.message)
      note(`${ensured.action}, code directory hash ${ensured.build.codeDirectoryHash ?? 'unread'}`)
      return ensured.build
    })
    const desktop = await record.step("start the desktop's macOS runner", async (note) => {
      const started = await MacosDesktop.start({ build, tools: systemTools, logFolder: logs, timeoutMs: 180_000 })
      if (!started.ok) throw new Error(started.failure.message)
      note(`runner on 127.0.0.1:${started.desktop.port}, ${started.desktop.os.name} ${started.desktop.os.version} (${started.desktop.os.build})`)
      return started.desktop
    })
    try {
      const executable = join(await realpath(taskDesk), 'Contents', 'MacOS', 'TaskDesk')
      const { session, interaction } = await record.step(`launch TaskDesk with its window at ${windowFrame}`, async (note) => {
        const app = await desktop.openApp(taskDesk)
        if (!app.ok) throw new Error(app.failure.message)
        record.facts['macos'] = { execution: app.runtime.execution }
        const opened = await app.runtime.openSession({ owner: { runId: stamp, testId: 'interaction', attemptId: 'proof', app: 'desk' }, launch: { arguments: ['-reset', '-serviceURL', service.url, '-windowFrame', windowFrame], environment: {} }, redact }, 30_000)
        if (!opened.ok) throw new Error(opened.failure.message)
        require(await opened.session.launch(60_000), 'launch', note)
        const attached = await attach(desktop.port, 'mac2')
        const processes = async (bounds: RequestBounds): Promise<ProcessReading> => {
          try {
            const pids = (await listProcesses(systemTools, bounds.timeoutMs)).filter((entry) => entry.command === executable || entry.command.startsWith(`${executable} `)).map((entry) => entry.pid)
            return { ok: true, running: pids.length > 0, pids }
          } catch (error) {
            return { ok: false, problem: error instanceof Error ? error.message : String(error) }
          }
        }
        return { session: opened.session, interaction: new NativeInteractionSession({ session: opened.session, client: attached.client, executor: attached.session, redact, processes, tools: systemTools }) }
      })
      // Before the first click the pointer is wherever it was, off the window; every click leaves it over the window, and
      // the coverage check counts the pointer's own window.
      await record.step("capture TaskDesk's window before the first click, or be refused by name", async (note) => {
        await check(interaction, { by: 'testId', value: 'sign-in-button' }, { matcher: 'toBeVisible' }, checkMs)
        const shot = await session.capture(30_000)
        record.facts['macosCaptureBeforeClicks'] = shot.ok ? 'passed the coverage check' : shot.failure.message
        if (shot.ok) return saveCapture(shot.capture, 'before-clicks', note)
        record.facts['macosCoveringBeforeClicks'] = await coveringFacts(session)
        if (!/lie over the app's window/.test(shot.failure.message)) throw new Error(shot.failure.message)
        note(`refused: ${shot.failure.message}`)
      })
      await record.step('sign in with the text field and the secure field', async (note) => {
        require(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: ada.id }, actionMs), 'fill the account', note)
        require(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: ada.password, secret: 'password' }, actionMs), 'fill {{password}}', note)
        require(await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, actionMs), 'click sign in', note)
        note(`signed in as ${await check(interaction, { by: 'testId', value: 'signed-in-account' }, { matcher: 'toHaveText', text: ada.id }, checkMs)}`)
      })
      await record.step(`find the task by its id, ${createdId}, and read its state`, async (note) => {
        const field: LocatorRecipe = { by: 'testId', value: 'task-id-field' }
        require(await interaction.dispatch({ kind: 'fill', locator: field, value: createdId }, actionMs), 'fill the id', note)
        require(await interaction.dispatch({ kind: 'press', locator: field, key: 'Enter' }, actionMs), 'press Enter', note)
        await check(interaction, { by: 'testId', value: 'selected-task-id' }, { matcher: 'toHaveText', text: createdId }, checkMs)
        const state = await check(interaction, { by: 'testId', value: 'selected-task-state' }, { matcher: 'toHaveText', text: 'Open' }, checkMs)
        record.facts['macosTaskState'] = state
        note(`the desktop shows ${createdId} as ${state}`)
      })
      await record.step('check a wrong state on purpose and see it fail naming the element', async (note) => {
        record.facts['macosWrongState'] = await wrongState(interaction, { by: 'testId', value: 'selected-task-state' }, 'Done', note)
      })
      await record.step("capture TaskDesk's window after the clicks, or be refused by name", async (note) => {
        const shot = await session.capture(30_000)
        record.facts['macosCaptureAfterClicks'] = shot.ok ? 'passed the coverage check' : shot.failure.message
        if (shot.ok) return saveCapture(shot.capture, 'found', note)
        record.facts['macosCoveringAfterClicks'] = await coveringFacts(session)
        if (!/lie over the app's window/.test(shot.failure.message)) throw new Error(shot.failure.message)
        note(`refused: ${shot.failure.message}`)
      })
      record.facts['macosInputs'] = interaction.inputs.map((input) => `${input.kind} ${input.route} ${input.input}${input.readBack === undefined ? '' : ` read back ${input.readBack}`}`)
      await record.cleanup('dispose the session', async () => interaction.dispose(60_000))
    } finally {
      await record.cleanup('close the runner and check nothing is left', async (note) => {
        await desktop.close(60_000)
        const left = (await listProcesses(systemTools, 10_000)).filter((entry) => entry.command.includes('WebDriverAgentRunner-Runner.app/Contents/MacOS') || entry.command.includes('/TaskDesk.app/Contents/MacOS/'))
        note(`${left.length} runner or TaskDesk process(es) left`)
        if (left.length > 0) throw new Error('something is left')
      })
    }
  }
} catch (error) {
  if (!(error instanceof StepStopped)) record.facts['unexpectedError'] = redact(error instanceof Error ? error.message : String(error))
} finally {
  record.facts['serviceRequests'] = requests.map((line) => line.replace(/^\S+ /, ''))
  await service.close()
  await rm(logs, { recursive: true, force: true })
}
await record.finish(artifacts)
process.exitCode = record.exitCode
