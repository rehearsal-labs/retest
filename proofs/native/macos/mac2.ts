import type { ProofRecord } from '../shared/evidence.ts'
import type { KnownFailure } from '../shared/processes.ts'
import type { JsonObject } from '../shared/webdriver.ts'
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Blocked, CACHE_ROOT } from '../shared/evidence.ts'
import { capture, describeExit, isListening, logTail, processIds, RunnerProcess, RunnerStartError } from '../shared/processes.ts'
import { observe } from '../shared/source.ts'
import { describeError, WebDriverClient, WebDriverSession } from '../shared/webdriver.ts'
import { readAutomationModeStart } from './automation-mode.ts'

export const HOST = '127.0.0.1'
export const BUNDLE_ID = 'com.apple.TextEdit'
export const APP_NAME = 'TextEdit'
export const MAC2_ROOT: string = join(CACHE_ROOT, 'appium-mac2-driver')
export const PROJECT_ROOT: string = join(MAC2_ROOT, 'WebDriverAgentMac')
export const PROJECT: string = join(PROJECT_ROOT, 'WebDriverAgentMac.xcodeproj')
export const DERIVED_DATA: string = join(CACHE_ROOT, 'derived', 'mac2')
export const RUNNER_PROCESS = 'WebDriverAgentRunner-Runner'
/** What the proof types into TextEdit; the cleanup script discards only documents holding this or nothing. */
export const TYPED_TEXT = 'Retest native proof 42'
/** XCUIKeyModifierShift and XCUIKeyModifierCommand in XCTest's XCUIKeyModifierFlags. */
export const SHIFT_KEY: number = 1 << 1
export const COMMAND_KEY: number = 1 << 4

/**
 * Lines of the runner log that explain a failed start.
 *
 * @example knownFailures('/Applications/Xcode.app/…/Xcode Helper.app')[0].blocked // true
 */
export function knownFailures(xcodeHelper: string): KnownFailure[] {
  return [
    {
      pattern: /Timed out while enabling automation mode/i,
      blocked: true,
      explanation: 'macOS showed its Enable UI Automation dialog and nobody authenticated within a minute. Authenticate in that dialog when the runner starts, or run `sudo automationmodetool enable-automationmode-without-authentication` once in Terminal, then run this again.',
    },
    {
      pattern: /accessibility permission|not trusted for accessibility|kAXErrorAPIDisabled/i,
      blocked: true,
      explanation: `Turn on Accessibility for Xcode Helper in System Settings, Privacy and Security, Accessibility, adding ${xcodeHelper}. Then run this again.`,
    },
    {
      pattern: /Failed to initialize for UI testing/i,
      blocked: false,
      explanation: 'XCTest could not start UI testing. The runner log names the underlying error.',
    },
    {
      pattern: /\*\* TEST EXECUTE FAILED \*\*/,
      blocked: false,
      explanation: 'xcodebuild ended the runner before it served commands. The runner log names the reason.',
    },
  ]
}

/**
 * Checks what the script needs before it starts anything: macOS, Xcode, the executor in the cache, no TextEdit, no
 * runner and a free port. Records the versions as facts and returns the path of Xcode Helper. Meant to run inside
 * a step.
 */
export async function checkMachine(record: ProofRecord, note: (fact: string) => void, port: number): Promise<string> {
  if (process.platform !== 'darwin') throw new Blocked('This needs macOS')
  const xcode = await capture('xcodebuild', ['-version'])
  if (xcode.exitCode !== 0) throw new Blocked('xcodebuild is missing; install Xcode and select it with xcode-select')
  record.facts['xcode'] = xcode.stdout.trim().replace(/\n/g, ', ')
  const developerDir = (await capture('xcode-select', ['-p'])).stdout.trim()
  record.facts['macos'] = (await capture('sw_vers', [])).stdout.trim().replace(/\s*\n\s*/g, ', ')
  try {
    await access(PROJECT)
  } catch {
    throw new Blocked(`WebDriverAgentMac is not in the cache. Run: git clone https://github.com/appium/appium-mac2-driver ${MAC2_ROOT}`)
  }
  const commit = (await capture('git', ['rev-parse', 'HEAD'], { cwd: MAC2_ROOT })).stdout.trim()
  const packageJson: { version?: string } = JSON.parse(await readFile(join(MAC2_ROOT, 'package.json'), 'utf8'))
  record.facts['executor'] = { name: 'appium-mac2-driver WebDriverAgentMac', version: packageJson.version ?? 'unknown', commit, license: 'Apache-2.0' }
  note(`${String(record.facts['xcode'])}; appium-mac2-driver ${packageJson.version ?? 'unknown'} at ${commit.slice(0, 12)}`)
  if ((await processIds({ name: APP_NAME })).length > 0) {
    throw new Blocked(`${APP_NAME} is open. Quit it first: this launches and terminates ${APP_NAME}, and never touches a copy it did not start.`)
  }
  if ((await processIds({ pattern: RUNNER_PROCESS })).length > 0) throw new Blocked(`A ${RUNNER_PROCESS} process is already running; this never stops a runner it did not start.`)
  if (await isListening(HOST, port)) throw new Blocked(`Something already listens on ${HOST}:${port}; choose another --port.`)
  return join(developerDir, 'Platforms', 'MacOSX.platform', 'Developer', 'Library', 'Xcode', 'Agents', 'Xcode Helper.app')
}

/**
 * The `.xctestrun` file a previous `build-for-testing` left, if any.
 *
 * @example await findXctestrun() // '…/derived/mac2/Build/Products/WebDriverAgentRunner_macosx26.5-arm64.xctestrun'
 */
export async function findXctestrun(): Promise<string | undefined> {
  const products = join(DERIVED_DATA, 'Build', 'Products')
  const names = await readdir(products).catch(() => [])
  const name = names.find((candidate) => /^WebDriverAgentRunner_macosx.*\.xctestrun$/.test(candidate))
  return name === undefined ? undefined : join(products, name)
}

/**
 * Starts the runner and reads the system log for the same minutes, so the record says whether macOS showed its
 * Enable UI Automation dialog and whether the run was unattended. Meant to run inside a step.
 */
export async function startRunner(options: { readonly record: ProofRecord; readonly note: (fact: string) => void; readonly client: WebDriverClient; readonly port: number; readonly logPath: string; readonly xcodeHelper: string }): Promise<RunnerProcess> {
  const { record, note } = options
  const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  const args = ['test-without-building', '-project', PROJECT, '-scheme', 'WebDriverAgentRunner', '-destination', `platform=macOS,arch=${arch}`, '-derivedDataPath', DERIVED_DATA, 'COMPILER_INDEX_STORE_ENABLE=NO']
  const startedAt = new Date()
  const readAutomation = async (): Promise<void> => {
    // A second after the start ends covers messages logged as the runner answered.
    const automation = await readAutomationModeStart(new Date(startedAt.getTime() - 1000), new Date(Date.now() + 1000)).catch((error: unknown) => describeError(error))
    if (typeof automation === 'string') {
      record.facts['automationMode'] = { error: automation }
      note(`Automation Mode: the system log could not be read (${automation})`)
      return
    }
    record.facts['automationMode'] = { ...automation, events: [...automation.events] }
    record.facts['unattended'] = automation.unattended
    note(`Automation Mode: ${automation.summary}${automation.newWriterDaemon ? '; launchd had started a new automationmode-writer' : ''}`)
  }
  try {
    const started = await RunnerProcess.start({ args, cwd: PROJECT_ROOT, environment: { USE_PORT: String(options.port), USE_HOST: HOST }, logPath: options.logPath, client: options.client, readyTimeoutMs: 150_000, knownFailures: knownFailures(options.xcodeHelper) })
    note(`xcodebuild pid ${String(started.pid)} answered after ${((Date.now() - startedAt.getTime()) / 1000).toFixed(1)} s; ${JSON.stringify(started.status['os'])}`)
    await readAutomation()
    return started
  } catch (error) {
    await readAutomation()
    if (!(error instanceof RunnerStartError)) throw error
    note(`log tail: ${(await logTail(error.logPath, 3)).replace(/\s*\n\s*/g, ' | ')}`)
    const message = `${error.message}. ${error.explanation} Log: ${error.logPath}`
    throw error.blocked ? new Blocked(message) : new Error(message)
  }
}

/**
 * Creates a session that launches TextEdit and returns it with the process it launched, pid and command line. TextEdit
 * is checked again right before the launch, because XCTest's launch terminates a running copy and this script must
 * never touch one it did not start. Exactly one TextEdit must be running afterwards.
 */
export async function launchTextEdit(client: WebDriverClient, capabilities: JsonObject): Promise<{ readonly session: WebDriverSession; readonly launched: OwnProcess }> {
  const before = await processIds({ name: APP_NAME })
  if (before.length > 0) throw new Blocked(`${APP_NAME} was opened while this was starting (pid ${before.join(', ')}). Quit it first; XCTest's launch would terminate it.`)
  const session = await WebDriverSession.create(client, capabilities, 120_000)
  const after = await processIds({ name: APP_NAME })
  const [pid] = after
  const command = pid === undefined ? '' : (await capture('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)])).stdout.trim()
  if (pid === undefined || after.length !== 1 || command.length === 0) {
    await session.end().catch(() => undefined)
    throw new Error(`expected exactly one ${APP_NAME} process with a command line after the launch, found ${after.length}`)
  }
  return { session, launched: { pid, command } }
}

/**
 * Waits until an element is hittable and its frame is the same on two reads 250 ms apart: a sheet slides in, and
 * a click sent before it stops lands where the button is not yet. WebDriverAgentMac sends booleans as strings.
 */
export async function waitUntilSteady(session: WebDriverSession, element: string, timeoutMs: number): Promise<boolean> {
  let previous = ''
  const steady = await observe(async () => {
    const frame = JSON.stringify(await session.rect(element))
    const hittable = await session.attribute(element, 'hittable')
    const ready = (hittable === true || hittable === 'true') && frame === previous
    previous = frame
    return ready
  }, (ready) => ready, timeoutMs)
  return steady.met
}

/** A process this script recorded as its own: its pid and its command line as `ps` showed it. */
export type OwnProcess = { readonly pid: number; readonly command: string }

/**
 * Whether a recorded process still runs under its pid with its recorded command line. `gone` covers a pid that is free
 * and one another process has now; a `ps` that failed is `unreadable`, never taken for either.
 */
export async function recordedState(entry: OwnProcess): Promise<'running' | 'gone' | 'unreadable'> {
  const shown = await capture('/bin/ps', ['-ww', '-o', 'args=', '-p', String(entry.pid)])
  if (shown.exitCode === 0) return shown.stdout.trim() === entry.command ? 'running' : 'gone'
  // ps answers 1 and prints nothing, not even to stderr, when no process has the pid.
  if (shown.exitCode === 1 && shown.stdout.trim() === '' && shown.stderr.trim() === '') return 'gone'
  return 'unreadable'
}

// Sends SIGTERM to a recorded process only while it is still the recorded one, read right before the signal.
async function signalRecorded(entry: OwnProcess): Promise<'sent' | 'gone' | 'unreadable'> {
  const state = await recordedState(entry)
  if (state !== 'running') return state
  process.kill(entry.pid, 'SIGTERM')
  return 'sent'
}

/**
 * The runner app this script's runner started: the one process listening on the script's port, with its command line.
 * macOS launches the runner app with launchd for its parent, so the port is what ties it to this script.
 */
export async function findOwnRunnerApp(port: number): Promise<OwnProcess | undefined> {
  const listening = await capture('/usr/sbin/lsof', ['-nP', `-iTCP@${HOST}:${port}`, '-sTCP:LISTEN', '-Fp'])
  const pids = listening.stdout.split('\n').filter((line) => /^p\d+$/.test(line)).map((line) => Number(line.slice(1)))
  const [pid] = pids
  if (pid === undefined || pids.length !== 1) return undefined
  const command = (await capture('/bin/ps', ['-ww', '-o', 'args=', '-p', String(pid)])).stdout.trim()
  return command.includes(RUNNER_PROCESS) ? { pid, command } : undefined
}

/** What teardown needs: the record, the runner and its runner app, and the one TextEdit process this script launched. */
export type TearDown = {
  readonly record: ProofRecord
  readonly client: WebDriverClient
  readonly port: number
  readonly runner: RunnerProcess | undefined
  readonly runnerApp: OwnProcess | undefined
  readonly session: WebDriverSession | undefined
  readonly launched: OwnProcess | undefined
  readonly appMayBeRunning: boolean
}

/**
 * Ends what this script started, each as its own cleanup step: the TextEdit it launched, the session, the runner. Then
 * it checks that none of them is left. A process is ended only by the pid and command line this script recorded for
 * it; a TextEdit it did not record is never touched.
 */
export async function tearDown(state: TearDown): Promise<void> {
  const { record, client, port, runner, runnerApp, session, launched } = state
  if (state.appMayBeRunning) {
    await record.cleanup(`terminate the ${APP_NAME} this script launched`, async (note) => {
      if (launched === undefined) {
        const running = await processIds({ name: APP_NAME })
        note(`the launch never named a process; ${running.length} ${APP_NAME} process(es) running, none touched`)
        if (running.length > 0) throw new Error(`a ${APP_NAME} may have been left running; it was not touched because its owner is unknown`)
        return
      }
      const before = await recordedState(launched)
      if (before === 'unreadable') throw new Error(`could not read whether pid ${launched.pid} is still the ${APP_NAME} this script launched`)
      if (before === 'gone') {
        note(`pid ${launched.pid} already gone`)
        return
      }
      const running = await processIds({ name: APP_NAME })
      // XCTest terminates by bundle id, so it is used only while the running copy is still the launched one.
      if (session !== undefined && running.length === 1 && running[0] === launched.pid) {
        note(`terminate answered ${String(await session.terminateApp(BUNDLE_ID).catch((error: unknown) => describeError(error)))}`)
      }
      const gone = await observe(() => recordedState(launched), (left) => left === 'gone', 5000)
      if (!gone.met) {
        const signalled = await signalRecorded(launched)
        throw new Error(signalled === 'sent' ? `sent SIGTERM to pid ${launched.pid}, the ${APP_NAME} this script launched` : `pid ${launched.pid} was ${signalled} when this script went to end it`)
      }
      note(`pid ${launched.pid} ended`)
    })
  }
  if (session !== undefined) {
    await record.cleanup('end the session', async () => {
      await session.end()
    })
  }
  if (runner !== undefined) {
    await record.cleanup('shut the runner down', async (note) => {
      // DELETE / is WebDriverAgentMac's own shutdown route: it ends any session and stops the server.
      const answer = await client.send('DELETE', '/').then((reply) => `answered ${reply.status} ${JSON.stringify(reply.text)}`, (error: unknown) => describeError(error))
      const ended = await runner.waitForEnd(30_000)
      note(`DELETE / ${answer}; xcodebuild ended with ${describeExit(ended)}${ended.signalled ? ' after this script signalled it' : ''}`)
      if (ended.signalled) throw new Error('the shutdown route did not end the runner')
    })
  }
  await record.cleanup('check that nothing this script started is running', async (note) => {
    // Only the runner app this script recorded is looked for and ended, and only while its command line is the
    // recorded one: a runner of any other start, Retest's own among them, is never touched. A runner whose app was
    // never recorded leaves no way to tell that nothing of it is left, so the check fails rather than passing.
    const runnerLeft = runnerApp === undefined ? undefined : (await observe(() => recordedState(runnerApp), (left) => left === 'gone', 10_000)).value
    const appLeft = launched === undefined ? 'gone' : await recordedState(launched)
    const listening = await isListening(HOST, port)
    note(`runner app ${runnerApp === undefined ? 'never recorded' : `pid ${runnerApp.pid} ${runnerLeft ?? 'unknown'}`}, launched ${APP_NAME} ${appLeft}, port ${port} ${listening ? 'still listening' : 'closed'}`)
    const signalled = runnerApp !== undefined && runnerLeft === 'running' ? await signalRecorded(runnerApp) : undefined
    if (runner !== undefined && runnerApp === undefined) throw new Error('the runner started and its runner app was never recorded, so this script cannot tell whether one it started is still running')
    if (runnerLeft === 'unreadable' || appLeft === 'unreadable') throw new Error('this script could not read whether what it started is still running')
    if (runnerLeft === 'running' || appLeft === 'running' || listening) throw new Error(`something this script started is still running${signalled === 'sent' ? '; the runner app was sent SIGTERM' : ''}`)
  })
}
