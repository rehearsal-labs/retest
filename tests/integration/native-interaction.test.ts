import type { TaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import type { MacosAppRuntime } from '../../src/native/macos-app.ts'
import type { ProcessReading } from '../../src/native/session.ts'
import type { ExecutorSession, RequestBounds } from '../../src/native/webdriver-client.ts'
import assert from 'node:assert/strict'
import { access, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, afterEach, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { CLIENT_HEADER } from '../../fixtures/cross-platform/service/clients.ts'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { NativeInteractionSession } from '../../src/native/interaction-session.ts'
import { IosSimulatorRuntime, simulatorAppProcesses } from '../../src/native/ios-simulator.ts'
import { MacosDesktop } from '../../src/native/macos-app.ts'
import { endRecorded, listProcesses, runCommand, systemTools } from '../../src/native/processes.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { executorBuild, nativeSkipReason, processesWith, taskDeskApp, taskPhoneApp, within } from './native-harness.ts'

// Native finds, input, checks, the software keyboard and alerts on the real simulator with WebDriverAgent and TaskPhone,
// and on the real macOS runner with TaskDesk, against the cross-platform fixture service. Both take the desktop or a
// simulator: run this only under the heavy gate lock. A machine without the pinned Xcode, the iOS 26.5 runtime, the
// fixtures' builds or Automation Mode without a dialog skips each half by name. The fixture password is the service's
// own seeded one; it is filled as a secret and learned by the session's redaction, so no tree or failure holds it.

const iosSkip = await nativeSkipReason('ios-simulator')
// Only a build that is not there skips; one that cannot be read fails the file rather than pass as skipped.
const buildsSkip = process.platform !== 'darwin' ? 'needs macOS' : (await Promise.all([taskPhoneApp, taskDeskApp].map((path) => access(path).then(() => undefined, (error: unknown) => {
  if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return `${path} is missing`
  throw new Error(`Retest could not read whether ${path} is there: ${error instanceof Error ? error.message : String(error)}`)
})))).find((reason) => reason !== undefined)
const macosSkip = (await nativeSkipReason('macos')) ?? ((await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk')).length > 0 ? 'TaskDesk is already running; this test never touches a copy it did not start' : undefined)
const [ada] = SEEDED_ACCOUNTS
if (ada === undefined) throw new Error('the fixture service seeds no account')
const redactor = new Redactor()
redactor.learn('password', ada.password)
const redact = (text: string): string => redactor.redact(text)
const interrupted = { class: 'interrupted', message: 'The run was interrupted.' } as const
const actionMs = 20_000
const checkMs = 10_000
// TaskDesk's window, placed near the top left of the screen, away from the centre where another app's window floats.
const windowFrame = '20,60,700,480'

/** Requests the service logged, one plain line each, as its `printLine` gives them. */
function serviceLines(): { readonly lines: string[]; readonly count: (method: string, path: string, client: string) => number } {
  const lines: string[] = []
  return { lines, count: (method, path, client) => lines.filter((line) => line.includes(` ${method} ${path} `) && line.endsWith(`client=${client}`)).length }
}

/** Signs in as ada for the test client and creates tasks through the service, returning their ids in order. */
async function createTasks(url: string, titles: readonly string[]): Promise<string[]> {
  const signIn = await fetch(new URL('/api/sign-in', url), { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test' }, body: JSON.stringify({ account: ada?.id, password: ada?.password }) })
  const signed: unknown = await signIn.json()
  const token = isPlainObject(signed) && typeof signed['token'] === 'string' ? signed['token'] : ''
  const ids: string[] = []
  for (const title of titles) {
    const created = await fetch(new URL('/api/tasks', url), { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test', authorization: `Bearer ${token}` }, body: JSON.stringify({ title }) })
    const body: unknown = await created.json()
    const task = isPlainObject(body) && isPlainObject(body['task']) ? body['task'] : undefined
    if (typeof task?.['id'] !== 'string') throw new Error('the service created no task')
    ids.push(task['id'])
  }
  return ids
}

async function readTask(url: string, id: string): Promise<{ readonly status: number; readonly title?: string }> {
  const signIn = await fetch(new URL('/api/sign-in', url), { method: 'POST', headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test' }, body: JSON.stringify({ account: ada?.id, password: ada?.password }) })
  const signed: unknown = await signIn.json()
  const token = isPlainObject(signed) && typeof signed['token'] === 'string' ? signed['token'] : ''
  const answer = await fetch(new URL(`/api/tasks/${id}`, url), { headers: { authorization: `Bearer ${token}` } })
  const body: unknown = await answer.json()
  const task = isPlainObject(body) && isPlainObject(body['task']) ? body['task'] : undefined
  return { status: answer.status, ...(typeof task?.['title'] === 'string' ? { title: task['title'] } : {}) }
}

function ok(result: { readonly result: { readonly ok: boolean; readonly failure?: { readonly message: string } } }, what: string): void {
  assert.equal(result.result.ok, true, `${what}: ${result.result.failure?.message ?? ''}`)
}

/** The routes every input request of a session took, in order, with how far each got. */
function inputRoutes(interaction: NativeInteractionSession): string[] {
  return interaction.inputs.map((record) => `${record.kind} ${record.input}`)
}

/** Whether a text holds the fixture password as it is. */
function holdsPassword(text: string): boolean {
  return text.includes(ada?.password ?? '\u0000')
}

test('the Info.plist files of TaskPhone and TaskDesk declare no privacy usage description', { skip: buildsSkip }, async () => {
  for (const plist of [join(taskPhoneApp, 'Info.plist'), join(taskDeskApp, 'Contents', 'Info.plist')]) {
    const read = await runCommand(systemTools.plutil, ['-convert', 'json', '-o', '-', plist], { timeoutMs: 15_000 })
    assert.equal(read.code, 0, read.stderr)
    const keys = Object.keys(JSON.parse(read.stdout)).filter((key) => /UsageDescription$/.test(key))
    assert.deepEqual(keys, [], plist)
  }
})

describe('native finds, input and checks on the real iOS simulator with TaskPhone', { skip: iosSkip }, () => {
  let runtime: IosSimulatorRuntime
  let service: TaskService
  let logs: string
  const requests = serviceLines()
  const opened: NativeInteractionSession[] = []
  // A disposal that fails fails the test: the session left the app or the executor session behind.
  afterEach(async () => {
    const problems: string[] = []
    for (const interaction of opened.splice(0)) await interaction.dispose(60_000).catch((error: unknown) => problems.push(error instanceof Error ? error.message : String(error)))
    assert.deepEqual(problems, [], 'every session disposed of what it held')
  })
  const open = async (attemptId: string): Promise<{ readonly interaction: NativeInteractionSession; readonly executor: ExecutorSession }> => {
    const session = await runtime.openSession({ owner: { runId: 'native-interaction', testId: 'phone', attemptId, app: 'phone' }, launch: { arguments: ['-reset', '-serviceURL', service.url], environment: {} }, redact }, 30_000)
    if (!session.ok) throw new Error(session.failure.message)
    const installed = await session.session.install({ appPath: taskPhoneApp }, 120_000)
    ok(installed, 'install')
    ok(await session.session.launch(120_000), 'launch')
    const attached = { client: session.client, session: session.executor }
    const processes = (bounds: RequestBounds): Promise<ProcessReading> => simulatorAppProcesses(systemTools, runtime.udid, runtime.bundle.bundleId, bounds)
    const interaction = new NativeInteractionSession({ session: session.session, client: attached.client, executor: attached.session, redact, processes })
    opened.push(interaction)
    return { interaction, executor: attached.session }
  }
  const signIn = async (interaction: NativeInteractionSession): Promise<void> => {
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: ada.id }, actionMs), 'fill the account')
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: ada.password, secret: 'password' }, actionMs), 'fill the password')
    ok(await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, actionMs), 'tap sign in')
    const signedIn = await interaction.expect({ by: 'testId', value: 'signed-in-account' }, { matcher: 'toHaveText', text: ada.id }, checkMs)
    assert.equal(signedIn.passed, true, signedIn.failure?.message)
  }

  before(async () => {
    logs = await mkdtemp(join(tmpdir(), 'retest-native-interaction-ios-'))
    service = await startTaskService({ port: 0, syncDelayMs: 100, printLine: (line) => requests.lines.push(line) })
    const build = await executorBuild('webdriveragent', logs)
    const started = await IosSimulatorRuntime.start({ target: { appPath: taskPhoneApp, device: 'iPhone 17', runtime: '26.5' }, build, tools: systemTools, redact, logFolder: logs, timeoutMs: 600_000 })
    if (!started.ok) throw new Error(started.failure.message)
    runtime = started.runtime
  })

  after(async () => {
    try {
      await runtime.close(180_000)
    } finally {
      await service.close()
      await rm(logs, { recursive: true, force: true })
    }
  })

  test('TaskPhone: a text field and a secure field are filled, the keyboard comes up and is dismissed, a task is created and its id and state are checked; a wrong state fails naming the element', async () => {
    const { interaction } = await open('phone-flow')
    const signInsBefore = requests.count('POST', '/api/sign-in', 'ios')
    const createsBefore = requests.count('POST', '/api/tasks', 'ios')
    ok(await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, actionMs), 'tap the account field')
    const keyboard = await interaction.waitForKeyboard(checkMs)
    assert.equal(keyboard.ok && keyboard.state.shown, true, keyboard.ok ? '' : keyboard.failure.message)
    // On a new simulator iOS shows a card about sliding to type over the first keyboard of a field that takes it.
    if (keyboard.ok && keyboard.state.firstRunCard) ok(await interaction.dismissFirstRunCard(actionMs), 'dismiss the first-run card')
    else process.stdout.write("# the keyboard's first-run card about sliding to type did not show on TaskPhone's account field\n")
    ok(await interaction.dismissKeyboard(actionMs), 'dismiss the keyboard by its return key')
    assert.deepEqual(await interaction.keyboardState(checkMs), { ok: true, state: { shown: false, firstRunCard: false } })
    await signIn(interaction)
    assert.equal(interaction.inputs.find((record) => record.kind === 'keys' && record.readBack === 'length_matched') !== undefined, true, 'the secure field read back as bullets, counted')
    const title = `Phone task ${Date.now()}`
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'new-task-title-field' }, value: title }, actionMs), 'fill the title')
    const up = await interaction.keyboardState(checkMs)
    assert.equal(up.ok && up.state.shown, true, 'the keyboard came up for the title field')
    ok(await interaction.dismissKeyboard(actionMs), "dismiss the keyboard by its 'done' key")
    ok(await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'create-task-button' } }, actionMs), 'tap create')
    const id = await interaction.expect({ by: 'testId', value: 'created-task-id' }, { matcher: 'toHaveText', pattern: { pattern: '^task-[0-9a-f]{12}$', flags: '' } }, checkMs)
    assert.equal(id.passed, true, id.failure?.message)
    const taskId = id.actual?.text ?? ''
    const state = await interaction.expect({ by: 'testId', value: 'created-task-state' }, { matcher: 'toHaveText', text: 'Open' }, checkMs)
    assert.equal(state.passed, true, state.failure?.message)
    assert.equal((await interaction.expect({ by: 'testId', value: 'created-task-title' }, { matcher: 'toHaveText', text: title }, checkMs)).passed, true)
    const wrong = await interaction.expect({ by: 'testId', value: 'created-task-state' }, { matcher: 'toHaveText', text: 'Done' }, 1500)
    assert.equal(wrong.passed, false)
    assert.equal(wrong.failure?.class, 'check_failed')
    assert.match(wrong.failure?.message ?? '', /^getByTestId\('created-task-state'\) has text "Open", expected "Done"\./)
    assert.equal(wrong.failure?.details?.['element'], 'the StaticText "created-task-state"')
    assert.deepEqual(await readTask(service.url, taskId), { status: 200, title }, 'the service holds the task the phone created, by its id')
    assert.equal(requests.count('POST', '/api/sign-in', 'ios') - signInsBefore, 1, 'one sign-in reached the service')
    assert.equal(requests.count('POST', '/api/tasks', 'ios') - createsBefore, 1, 'one create reached the service')
    const alert = await interaction.readAlert(checkMs)
    assert.deepEqual(alert, { ok: true, alert: { open: false } }, "WebDriverAgent's alert route answers that no alert is open")
    const look = await interaction.observe({ by: 'testId', value: 'created-task-state' }, checkMs)
    assert.equal(look.ok && look.look.tree.elements.some((element) => Object.values(element.attributes).some(holdsPassword)), false, 'the tree holds no password')
    assert.equal(interaction.inputs.every((record) => record.input === 'sent'), true, inputRoutes(interaction).join(', '))
    assert.equal(interaction.unknownOutcomes.length, 0)
  })

  test('TaskPhone: a locator with a missing identifier fails by name, never falling back to a label; a reference from before a relaunch is refused', async () => {
    const { interaction } = await open('phone-locators')
    const missing = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in' } }, 3000)
    assert.equal(!missing.result.ok && missing.result.failure.class, 'not_found', !missing.result.ok ? missing.result.failure.message : '')
    const labelled = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'Sign in' } }, 3000)
    assert.match(!labelled.result.ok ? labelled.result.failure.message : '', /1 element has "Sign in" as both name and label: iOS's executor writes the label as the name of an element with no identifier/)
    assert.deepEqual(interaction.inputs, [], 'nothing was tapped')
    const resolved = await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, actionMs)
    if (!resolved.ok) throw new Error(resolved.failure.message)
    ok(await interaction.terminate(60_000), 'terminate')
    ok(await interaction.launch(120_000), 'relaunch')
    const stale = await interaction.pressResolved(resolved.element, actionMs)
    assert.equal(stale.input, 'not_sent')
    assert.equal(!stale.result.ok && stale.result.failure.details?.['stale'], true)
    assert.deepEqual(interaction.inputs, [])
  })

  test('TaskPhone: a cancel after the sign-in tap went records an unknown outcome; the tap is not taken back and nothing is tapped again', async () => {
    const { interaction } = await open('phone-cancel-tap')
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: ada.id }, actionMs), 'fill the account')
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: ada.password, secret: 'password' }, actionMs), 'fill the password')
    const before = requests.count('POST', '/api/sign-in', 'ios')
    interaction.onInput((sending) => {
      if (sending.kind === 'tap') setTimeout(() => interaction.cancel(interrupted), 100)
    })
    const tapped = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, actionMs)
    assert.equal(tapped.input, 'unknown', !tapped.result.ok ? tapped.result.failure.message : 'the tap was answered before the cancel')
    assert.equal(!tapped.result.ok && tapped.result.failure.class, 'interrupted')
    const unknown = interaction.unknownOutcomes.filter((entry) => entry.source === 'input')
    assert.equal(unknown.length, 1)
    assert.equal(unknown[0]?.source === 'input' && unknown[0].outcome.route, 'POST /session/:session/element/:element/click')
    await sleep(3000)
    const signIns = requests.count('POST', '/api/sign-in', 'ios') - before
    process.stdout.write(`# the service saw ${signIns} sign-in(s) from the phone after the cancelled tap\n`)
    assert.ok(signIns <= 1, 'the tap reached the app at most once')
    const later = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, actionMs)
    assert.equal(later.input, 'not_sent', 'a cancelled session sends nothing more')
  })

  test('TaskPhone: a cancel after a typing went records an unknown outcome; the typing is not taken back and nothing is typed again', async () => {
    const { interaction, executor } = await open('phone-cancel')
    await signIn(interaction)
    interaction.onInput((sending) => {
      if (sending.kind === 'keys') setTimeout(() => interaction.cancel(interrupted), 300)
    })
    const long = 'Release checklist for the phone '.repeat(5)
    const typed = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'new-task-title-field' }, value: long }, actionMs)
    assert.equal(typed.input, 'unknown')
    assert.equal(!typed.result.ok && typed.result.failure.class, 'interrupted')
    const unknown = interaction.unknownOutcomes.filter((entry) => entry.source === 'input')
    assert.equal(unknown.length, 1)
    assert.equal(unknown[0]?.source === 'input' && unknown[0].outcome.route, 'POST /session/:session/wda/keys')
    const reconciled = await interaction.reconcile(30_000)
    const entry = reconciled.find((each) => each.source === 'input')
    assert.equal(entry?.source === 'input' && entry.outcome.reconciled?.ok === true && entry.outcome.reconciled.running, true)
    // The session is stopped, so the field is read straight from the executor, which sends nothing to the app.
    const lengths: number[] = []
    for (let look = 0; look < 3; look += 1) {
      const tree = await executor.ownedSource({ platform: 'ios-simulator', bundleId: runtime.bundle.bundleId, appNames: ['TaskPhone'] }, { timeoutMs: 30_000 })
      const value = tree.status === 'answered' ? /name="new-task-title-field"[^>]*?value="([^"]*)"|value="([^"]*)"[^>]*name="new-task-title-field"/.exec(tree.value.xml) : null
      lengths.push((value?.[1] ?? value?.[2] ?? '').length)
      await sleep(1000)
    }
    process.stdout.write(`# the title field held ${lengths.join(', ')} characters after the cancel, of ${long.length} typed once\n`)
    assert.deepEqual(lengths, [long.length, long.length, long.length], 'the typing landed once, whole, and nothing more was typed after the cancel')
    assert.deepEqual(inputRoutes(interaction).slice(-1), ['keys unknown'], 'the typing was the last input sent')
  })

  test('TaskPhone: a lost executor during a lookup is session_lost', async () => {
    const { interaction } = await open('phone-lost')
    const looking = interaction.expect({ by: 'testId', value: 'created-task-id' }, { matcher: 'toBeVisible' }, 60_000)
    await sleep(1000)
    for (const entry of runtime.executorProcesses.slice(1)) assert.equal(await endRecorded(systemTools, entry, 1000), 'ended')
    const result = await within(looking, 30_000, 'the lookup did not end within 30 s of the lost executor')
    assert.equal(result.passed, false)
    assert.equal(result.failure?.class, 'session_lost', result.failure?.message)
  })
})

describe('native finds, input and checks on the real macOS runner with TaskDesk', { skip: macosSkip }, () => {
  let desktop: MacosDesktop
  let app: MacosAppRuntime
  let service: TaskService
  let logs: string
  let executable: string
  const requests = serviceLines()
  const opened: NativeInteractionSession[] = []
  // A disposal that fails fails the test: the session left the app or the executor session behind.
  afterEach(async () => {
    const problems: string[] = []
    for (const interaction of opened.splice(0)) await interaction.dispose(60_000).catch((error: unknown) => problems.push(error instanceof Error ? error.message : String(error)))
    assert.deepEqual(problems, [], 'every session disposed of what it held')
  })
  const open = async (attemptId: string): Promise<{ readonly interaction: NativeInteractionSession; readonly executor: ExecutorSession }> => {
    const session = await app.openSession({ owner: { runId: 'native-interaction', testId: 'desk', attemptId, app: 'desk' }, launch: { arguments: ['-reset', '-serviceURL', service.url, '-windowFrame', windowFrame], environment: {} }, redact }, 30_000)
    if (!session.ok) throw new Error(session.failure.message)
    ok(await session.session.launch(60_000), 'launch')
    const attached = { client: session.client, session: session.executor }
    const processes = async (bounds: RequestBounds): Promise<ProcessReading> => {
      try {
        const pids = (await listProcesses(systemTools, bounds.timeoutMs)).filter((entry) => entry.command === executable || entry.command.startsWith(`${executable} `)).map((entry) => entry.pid)
        return { ok: true, running: pids.length > 0, pids }
      } catch (error) {
        return { ok: false, problem: String(error) }
      }
    }
    const interaction = new NativeInteractionSession({ session: session.session, client: attached.client, executor: attached.session, redact, processes, tools: systemTools })
    opened.push(interaction)
    return { interaction, executor: attached.session }
  }
  const signIn = async (interaction: NativeInteractionSession): Promise<void> => {
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: ada.id }, actionMs), 'fill the account')
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: ada.password, secret: 'password' }, actionMs), 'fill the password')
    ok(await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, actionMs), 'click sign in')
    const signedIn = await interaction.expect({ by: 'testId', value: 'signed-in-account' }, { matcher: 'toHaveText', text: ada.id }, checkMs)
    assert.equal(signedIn.passed, true, signedIn.failure?.message)
  }

  before(async () => {
    logs = await mkdtemp(join(tmpdir(), 'retest-native-interaction-macos-'))
    executable = join(await realpath(taskDeskApp), 'Contents', 'MacOS', 'TaskDesk')
    service = await startTaskService({ port: 0, syncDelayMs: 100, printLine: (line) => requests.lines.push(line) })
    const build = await executorBuild('mac2', logs)
    const started = await MacosDesktop.start({ build, tools: systemTools, redact, logFolder: logs, timeoutMs: 180_000 })
    if (!started.ok) throw new Error(started.failure.message)
    desktop = started.desktop
    const openedApp = await desktop.openApp(taskDeskApp)
    if (!openedApp.ok) throw new Error(openedApp.failure.message)
    app = openedApp.runtime
  })

  after(async () => {
    try {
      await desktop.close(60_000)
      assert.deepEqual(await processesWith(executable), [], 'no TaskDesk is left')
    } finally {
      await service.close()
      await rm(logs, { recursive: true, force: true })
    }
  })

  test('TaskDesk: sign in, find a task by id and check its state, a wrong state fails naming the element, a chord goes through press, and the list scrolls', async () => {
    const { interaction } = await open('desk-flow')
    // The capture is the window's own image, so whatever lies over the window, the pointer included, stays out of it.
    assert.equal((await interaction.expect({ by: 'testId', value: 'sign-in-button' }, { matcher: 'toBeVisible' }, checkMs)).passed, true)
    const untouched = await interaction.capture(30_000)
    process.stdout.write(`# the window capture before any click ${untouched.ok ? `was taken: ${untouched.capture.width}x${untouched.capture.height}` : `was refused: ${untouched.failure.message}`}\n`)
    assert.ok(untouched.ok, untouched.ok ? '' : untouched.failure.message)
    await signIn(interaction)
    const masked = interaction.inputs.find((record) => record.kind === 'keys' && record.readBack !== undefined && record.readBack !== 'matched')
    process.stdout.write(`# TaskDesk's secure field read back as ${masked?.readBack ?? 'nothing recorded'}\n`)
    assert.equal(masked?.readBack, 'length_matched', 'the secure field read back one masking character per character typed, counted and never shown')
    // Thirty more tasks overflow the list; a row below its view is hidden until the list scrolls.
    const ids = await createTasks(service.url, Array.from({ length: 30 }, (_, index) => `Desk scroll task ${index + 1}`))
    assert.equal((await interaction.expect({ by: 'testId', value: 'task-count' }, { matcher: 'toHaveText', text: '33 tasks' }, 15_000)).passed, true)
    const looked = await interaction.observe({ by: 'role', role: 'cell' }, checkMs)
    if (!looked.ok) throw new Error(looked.failure.message)
    const hiddenIndex = looked.look.observation.items.findIndex((item) => !item.visible)
    assert.ok(hiddenIndex > 0, 'the list shows its first rows and hides the rest')
    const hiddenId = ['seed-ada-1', 'seed-ada-2', 'seed-ada-3', ...ids][hiddenIndex] ?? ''
    const hiddenRow = { by: 'testId', value: `task-row-${hiddenId}` } as const
    assert.equal((await interaction.expect(hiddenRow, { matcher: 'toBeHidden' }, checkMs)).passed, true)
    ok(await interaction.dispatch({ kind: 'scroll', locator: { by: 'testId', value: 'task-list' }, x: 0, y: 120 }, actionMs), 'scroll the list down')
    const revealed = await interaction.expect(hiddenRow, { matcher: 'toBeVisible' }, checkMs)
    assert.equal(revealed.passed, true, revealed.failure?.message)
    const field = { by: 'testId', value: 'task-id-field' } as const
    ok(await interaction.dispatch({ kind: 'fill', locator: field, value: 'not-a-task' }, actionMs), 'fill a wrong id')
    ok(await interaction.dispatch({ kind: 'press', locator: field, key: 'Meta+A' }, actionMs), 'select all with a chord')
    ok(await interaction.dispatch({ kind: 'press', key: 'Backspace' }, actionMs), 'delete the selection')
    const emptied = await interaction.expect(field, { matcher: 'toHaveValue', value: '' }, checkMs)
    assert.equal(emptied.passed, true, emptied.failure?.message)
    ok(await interaction.dispatch({ kind: 'fill', locator: field, value: 'seed-ada-2' }, actionMs), 'fill the seeded id')
    ok(await interaction.dispatch({ kind: 'press', locator: field, key: 'Enter' }, actionMs), 'press Enter to show it')
    assert.equal((await interaction.expect({ by: 'testId', value: 'selected-task-id' }, { matcher: 'toHaveText', text: 'seed-ada-2' }, checkMs)).passed, true)
    const shown = await interaction.expect({ by: 'testId', value: 'selected-task-state' }, { matcher: 'toHaveText', text: 'Done' }, checkMs)
    assert.equal(shown.passed, true, shown.failure?.message)
    const row = await interaction.expect({ by: 'testId', value: 'task-state-seed-ada-1' }, { matcher: 'toHaveText', text: 'Open' }, checkMs)
    assert.equal(row.passed, true, row.failure?.message)
    const wrong = await interaction.expect({ by: 'testId', value: 'selected-task-state' }, { matcher: 'toHaveText', text: 'Open' }, 1500)
    assert.equal(wrong.failure?.class, 'check_failed')
    assert.match(wrong.failure?.message ?? '', /^getByTestId\('selected-task-state'\) has text "Done", expected "Open"\./)
    assert.equal(wrong.failure?.details?.['element'], 'the StaticText "selected-task-state"')
    const selected = await interaction.expect({ by: 'testId', value: 'selected-task-state' }, { matcher: 'toBeSelected' }, checkMs)
    assert.equal(selected.failure?.class, 'unsupported', 'a static text has no selected state on macOS, so the check is refused, not passed')
    const alert = await interaction.readAlert(checkMs)
    assert.deepEqual(alert, { ok: true, alert: { open: false } })
    const capture = await interaction.capture(30_000)
    process.stdout.write(`# the window capture after the clicks ${capture.ok ? `was taken: ${capture.capture.width}x${capture.capture.height}` : `was refused: ${capture.failure.message}`}\n`)
    assert.ok(capture.ok, capture.ok ? '' : capture.failure.message)
    assert.equal(interaction.inputs.every((record) => record.input === 'sent'), true, inputRoutes(interaction).join(', '))
  })

  test('TaskDesk: a locator with a missing identifier fails by name; a reference from before a relaunch is refused', async () => {
    const { interaction } = await open('desk-locators')
    const missing = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in' } }, 3000)
    assert.equal(!missing.result.ok && missing.result.failure.class, 'not_found', !missing.result.ok ? missing.result.failure.message : '')
    const byLabel = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'Sign in' } }, 3000)
    assert.equal(!byLabel.result.ok && byLabel.result.failure.class, 'not_found', `a label is never a test id: ${!byLabel.result.ok ? byLabel.result.failure.message : ''}`)
    const resolved = await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, actionMs)
    if (!resolved.ok) throw new Error(resolved.failure.message)
    ok(await interaction.terminate(60_000), 'terminate')
    ok(await interaction.launch(60_000), 'relaunch')
    const stale = await interaction.pressResolved(resolved.element, actionMs)
    assert.equal(stale.input, 'not_sent')
    assert.equal(!stale.result.ok && stale.result.failure.details?.['stale'], true)
    assert.deepEqual(interaction.inputs, [])
  })

  test('TaskDesk: a cancel after the sign-in click went records an unknown outcome; the click is not taken back and nothing is clicked again', async () => {
    const { interaction } = await open('desk-cancel-click')
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: ada.id }, actionMs), 'fill the account')
    ok(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: ada.password, secret: 'password' }, actionMs), 'fill the password')
    const before = requests.count('POST', '/api/sign-in', 'macos')
    interaction.onInput((sending) => {
      if (sending.kind === 'click') setTimeout(() => interaction.cancel(interrupted), 100)
    })
    const clicked = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, actionMs)
    assert.equal(clicked.input, 'unknown', !clicked.result.ok ? clicked.result.failure.message : 'the click was answered before the cancel')
    assert.equal(!clicked.result.ok && clicked.result.failure.class, 'interrupted')
    assert.equal(interaction.unknownOutcomes.filter((entry) => entry.source === 'input').length, 1)
    const reconciled = await interaction.reconcile(30_000)
    const entry = reconciled.find((each) => each.source === 'input')
    assert.equal(entry?.source === 'input' && entry.outcome.reconciled?.ok === true && entry.outcome.reconciled.running, true)
    await sleep(3000)
    const signIns = requests.count('POST', '/api/sign-in', 'macos') - before
    process.stdout.write(`# the service saw ${signIns} sign-in(s) from the desktop after the cancelled click\n`)
    assert.ok(signIns <= 1, 'the click reached the app at most once')
  })

  test('TaskDesk: a cancel after a typing went records an unknown outcome; the typing is not taken back and nothing is typed again', async () => {
    const { interaction, executor } = await open('desk-cancel')
    interaction.onInput((sending) => {
      if (sending.kind === 'keys') setTimeout(() => interaction.cancel(interrupted), 500)
    })
    const long = 'release checklist on the desk '.repeat(4)
    const typed = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: long }, actionMs)
    assert.equal(typed.input, 'unknown')
    assert.equal(!typed.result.ok && typed.result.failure.class, 'interrupted')
    assert.equal(interaction.unknownOutcomes.filter((entry) => entry.source === 'input').length, 1)
    const reconciled = await interaction.reconcile(30_000)
    const entry = reconciled.find((each) => each.source === 'input')
    assert.equal(entry?.source === 'input' && entry.outcome.reconciled?.ok === true && entry.outcome.reconciled.running, true)
    const lengths: number[] = []
    for (let look = 0; look < 3; look += 1) {
      const tree = await executor.ownedSource({ platform: 'macos', bundleId: app.bundle.bundleId, appNames: ['TaskDesk'] }, { timeoutMs: 30_000 })
      const value = tree.status === 'answered' ? /identifier="account-field" value="([^"]*)"/.exec(tree.value.xml) : null
      lengths.push((value?.[1] ?? '').length)
      await sleep(1000)
    }
    process.stdout.write(`# the account field held ${lengths.join(', ')} characters after the cancel, of ${long.length} typed once\n`)
    assert.deepEqual(lengths, [long.length, long.length, long.length], 'the typing landed once, whole, and nothing more was typed after the cancel')
  })

  test('TaskDesk: a lost runner during a lookup is session_lost', async () => {
    const { interaction } = await open('desk-lost')
    const looking = interaction.expect({ by: 'testId', value: 'selected-task-id' }, { matcher: 'toBeVisible' }, 60_000)
    await sleep(1000)
    for (const entry of desktop.executorProcesses.slice(1)) assert.equal(await endRecorded(systemTools, entry, 1000), 'ended')
    const result = await within(looking, 30_000, 'the lookup did not end within 30 s of the lost runner')
    assert.equal(result.failure?.class, 'session_lost', result.failure?.message)
  })
})

