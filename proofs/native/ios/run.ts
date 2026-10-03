/**
 * Drives one real iOS simulator screen through WebDriverAgent, the XCTest executor Appium's XCUITest driver
 * uses, over its own HTTP API. No Appium server and no npm package: simctl owns the device, xcodebuild hosts the
 * runner, and Node's fetch talks to it.
 *
 * It creates and boots its own simulator, starts the runner on it, launches Settings, reads the window's tree,
 * finds General by label with exactly one match and taps it once, goes back, taps the search field and types into
 * it with one keyboard event, reads the value and the tree again, captures the screen through WebDriverAgent and,
 * as a separate source, through `simctl io screenshot`, terminates Settings, ends the session, shuts the runner and
 * the simulator down, and deletes the simulator. It never acts on a simulator it did not create.
 *
 *   node --conditions=retest-source proofs/native/ios/run.ts [--port 8100] [--keep-device]
 *
 * Exit 0 when every step passed, 2 when the machine blocked it (no simulator runtime, a busy port), 1 when a step
 * failed. Builds, logs and artifacts go under ~/Library/Caches/retest-proofs.
 */
import type { ParseArgsConfig } from 'node:util'
import type { KnownFailure } from '../shared/processes.ts'
import type { JsonValue, Locator } from '../shared/webdriver.ts'
import { access, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { Blocked, CACHE_ROOT, createRunFolders, inspectPng, ProofRecord, StepStopped } from '../shared/evidence.ts'
import { capture, describeExit, isListening, logTail, processIds, RunnerProcess, RunnerStartError, runLogged } from '../shared/processes.ts'
import { countTypes, observe, ownedWindowSource, readSource } from '../shared/source.ts'
import { APP_STATE, describeError, isJsonObject, WebDriverClient, WebDriverSession } from '../shared/webdriver.ts'

const BUNDLE_ID = 'com.apple.Preferences'
const APP_NAME = 'Settings'
const SEARCH_TEXT = 'Wallpaper'
const HOST = '127.0.0.1'
const WDA_ROOT = join(CACHE_ROOT, 'WebDriverAgent')
const PROJECT = join(WDA_ROOT, 'WebDriverAgent.xcodeproj')
const DERIVED_DATA = join(CACHE_ROOT, 'derived', 'wda-ios')
const RUNNER_PROCESS = 'WebDriverAgentRunner-Runner'
const DEVICE_NAME = 'Retest proof iPhone'
const DOWNLOAD_COMMAND = 'xcodebuild -downloadPlatform iOS'

const USAGE = `Usage: node --conditions=retest-source proofs/native/ios/run.ts [--port 8100] [--keep-device]

  --port <number>   Port for WebDriverAgent's HTTP server. Default 8100.
  --keep-device     Keep the simulator this proof created instead of deleting it.
`

/** An installed simulator runtime, as `simctl list runtimes -j` describes it. */
type Runtime = {
  readonly identifier: string
  readonly name: string
  readonly version: string
  readonly build: string
  readonly iPhoneTypes: readonly { readonly identifier: string; readonly name: string }[]
}

/** A simulator, as `simctl list devices -j` describes it. */
type Device = {
  readonly udid: string
  readonly name: string
  readonly state: string
  readonly runtime: string
}

function role(type: string): Locator {
  return { using: 'class name', value: type }
}

function predicate(value: string): Locator {
  return { using: 'predicate string', value }
}

function text(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value : ''
}

async function simctlJson(args: readonly string[]): Promise<JsonValue> {
  const result = await capture('xcrun', ['simctl', ...args, '-j'])
  if (result.exitCode !== 0) throw new Error(`xcrun simctl ${args.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 300)}`)
  return JSON.parse(result.stdout)
}

async function listRuntimes(): Promise<Runtime[]> {
  const value = await simctlJson(['list', 'runtimes'])
  const runtimes = isJsonObject(value) ? value['runtimes'] : undefined
  if (!Array.isArray(runtimes)) return []
  return runtimes.filter(isJsonObject).filter((runtime) => runtime['platform'] === 'iOS' && runtime['isAvailable'] === true).map((runtime) => {
    const types = Array.isArray(runtime['supportedDeviceTypes']) ? runtime['supportedDeviceTypes'].filter(isJsonObject) : []
    return {
      identifier: text(runtime['identifier']),
      name: text(runtime['name']),
      version: text(runtime['version']),
      build: text(runtime['buildversion']),
      iPhoneTypes: types.filter((type) => type['productFamily'] === 'iPhone').map((type) => ({ identifier: text(type['identifier']), name: text(type['name']) })),
    }
  })
}

async function listDevices(): Promise<Device[]> {
  const value = await simctlJson(['list', 'devices'])
  const byRuntime = isJsonObject(value) ? value['devices'] : undefined
  if (!isJsonObject(byRuntime)) return []
  return Object.entries(byRuntime).flatMap(([runtime, devices]) => (Array.isArray(devices) ? devices.filter(isJsonObject) : []).map((device) => ({
    udid: text(device['udid']),
    name: text(device['name']),
    state: text(device['state']),
    runtime,
  })))
}

async function deviceState(udid: string): Promise<string | undefined> {
  return (await listDevices()).find((device) => device.udid === udid)?.state
}

async function simctl(args: readonly string[], timeoutMs: number = 60_000): Promise<string> {
  const result = await capture('xcrun', ['simctl', ...args], { timeoutMs })
  if (result.exitCode !== 0) throw new Error(`xcrun simctl ${args.join(' ')} exited ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 300)}`)
  return result.stdout
}

async function appIsRunningOn(udid: string): Promise<boolean> {
  // A running app shows in the device's launchd as UIKitApplication:<bundle id>[…].
  return (await simctl(['spawn', udid, 'launchctl', 'list'])).includes(`UIKitApplication:${BUNDLE_ID}`)
}

async function findXctestrun(): Promise<string | undefined> {
  const products = join(DERIVED_DATA, 'Build', 'Products')
  const names = await readdir(products).catch(() => [])
  const name = names.find((candidate) => /^WebDriverAgentRunner_iphonesimulator.*\.xctestrun$/.test(candidate))
  return name === undefined ? undefined : join(products, name)
}

const KNOWN_FAILURES: KnownFailure[] = [
  {
    pattern: /is not installed\. Please download and install the platform|No available simulator runtimes/i,
    blocked: true,
    explanation: `No iOS simulator runtime is installed. Install one with \`${DOWNLOAD_COMMAND}\` (several gigabytes), then run this proof again.`,
  },
  {
    pattern: /Unable to find a destination matching/i,
    blocked: false,
    explanation: 'xcodebuild cannot run on that simulator. The runner log lists the destinations it can use.',
  },
  {
    pattern: /\*\* TEST EXECUTE FAILED \*\*/,
    blocked: false,
    explanation: 'xcodebuild ended the runner before it served commands. The runner log names the reason.',
  },
]

const OPTIONS = { options: { port: { type: 'string', default: '8100' }, 'keep-device': { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } } as const satisfies ParseArgsConfig

function readOptions(): ReturnType<typeof parseArgs<typeof OPTIONS>> | string {
  try {
    return parseArgs(OPTIONS)
  } catch (error) {
    return describeError(error)
  }
}

async function main(): Promise<number> {
  const parsed = readOptions()
  if (typeof parsed === 'string') {
    process.stderr.write(`${parsed}\n\n${USAGE}`)
    return 2
  }
  const { values } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const port = Number(values.port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    process.stderr.write(`--port must be a whole number from 1 to 65535\n\n${USAGE}`)
    return 2
  }
  const folders = await createRunFolders('ios')
  const runnerLog = join(folders.logs, `wda-ios-runner-${folders.stamp}.log`)
  const client = new WebDriverClient(`http://${HOST}:${port}`, 60_000)
  const record = new ProofRecord('Native iOS simulator screen through WebDriverAgent')
  record.facts['port'] = port
  record.facts['runnerLog'] = runnerLog
  record.facts['artifacts'] = folders.artifacts

  let device: Device | undefined
  let createdDevice = false
  let bootedDevice = false
  let runner: RunnerProcess | undefined
  let session: WebDriverSession | undefined
  let appMayBeRunning = false

  const saveWindowTree = async (active: WebDriverSession, name: string): Promise<ReturnType<typeof readSource>> => {
    const owned = ownedWindowSource(await active.source())
    if (owned === undefined) throw new Error('the tree has no window')
    const path = join(folders.artifacts, name)
    await writeFile(path, owned.xml)
    record.artifact(path)
    return readSource(owned.xml)
  }

  try {
    // Checked first: without a runtime nothing else here can run, and the fix is a large download.
    const runtime = await record.step('find an iOS simulator runtime', async (note) => {
      if (process.platform !== 'darwin') throw new Blocked('This proof needs macOS with Xcode')
      const runtimes = await listRuntimes()
      const newest = runtimes.at(-1)
      if (newest === undefined) throw new Blocked(`No iOS simulator runtime is installed. Install one with \`${DOWNLOAD_COMMAND}\` (several gigabytes), then run this proof again.`)
      record.facts['runtime'] = { name: newest.name, version: newest.version, build: newest.build, identifier: newest.identifier }
      note(`${newest.name} (${newest.build}); ${runtimes.length} iOS runtime(s) installed`)
      return newest
    })

    await record.step('check the machine', async (note) => {
      const xcode = await capture('xcodebuild', ['-version'])
      if (xcode.exitCode !== 0) throw new Blocked('xcodebuild is missing; install Xcode and select it with xcode-select')
      record.facts['xcode'] = xcode.stdout.trim().replace(/\n/g, ', ')
      try {
        await access(PROJECT)
      } catch {
        throw new Blocked(`WebDriverAgent is not in the cache. Run: git clone https://github.com/appium/WebDriverAgent ${WDA_ROOT}`)
      }
      const commit = await capture('git', ['rev-parse', 'HEAD'], { cwd: WDA_ROOT })
      const packageJson: { version?: string } = JSON.parse(await readFile(join(WDA_ROOT, 'package.json'), 'utf8'))
      record.facts['executor'] = { name: 'WebDriverAgent', version: packageJson.version ?? 'unknown', commit: commit.stdout.trim(), license: 'BSD-3-Clause' }
      note(`${String(record.facts['xcode'])}; WebDriverAgent ${packageJson.version ?? 'unknown'} at ${commit.stdout.trim().slice(0, 12)}`)
      if ((await processIds({ pattern: RUNNER_PROCESS })).length > 0) throw new Blocked(`A ${RUNNER_PROCESS} process is already running; this proof never stops a runner it did not start.`)
      if (await isListening(HOST, port)) throw new Blocked(`Something already listens on ${HOST}:${port}; choose another --port.`)
    })

    device = await record.step('create a simulator', async (note) => {
      const type = runtime.iPhoneTypes.at(-1)
      if (type === undefined) throw new Blocked(`${runtime.name} supports no iPhone device type`)
      const udid = (await simctl(['create', DEVICE_NAME, type.identifier, runtime.identifier])).trim()
      createdDevice = true
      note(`created ${DEVICE_NAME} (${udid}) as ${type.name} on ${runtime.name}; this proof acts on no other simulator`)
      return { udid, name: DEVICE_NAME, state: 'Shutdown', runtime: runtime.identifier }
    })
    const target = device

    await record.step('boot the simulator', async (note) => {
      await simctl(['boot', target.udid])
      bootedDevice = true
      // bootstatus -b boots if needed and returns once the device has finished booting.
      await simctl(['bootstatus', target.udid, '-b'], 10 * 60_000)
      note(`state ${String(await deviceState(target.udid))}`)
    })

    await record.step('build WebDriverAgent for testing', async (note) => {
      const existing = await findXctestrun()
      if (existing !== undefined) {
        note(`reused ${existing}`)
        return
      }
      const logPath = join(folders.logs, `wda-ios-build-for-testing-${folders.stamp}.log`)
      const args = ['build-for-testing', '-project', PROJECT, '-scheme', 'WebDriverAgentRunner', '-destination', `platform=iOS Simulator,id=${target.udid}`, '-derivedDataPath', DERIVED_DATA, 'COMPILER_INDEX_STORE_ENABLE=NO']
      const exit = await runLogged('xcodebuild', args, { logPath, cwd: WDA_ROOT, timeoutMs: 20 * 60_000 })
      if (exit.exitCode !== 0) throw new Error(`xcodebuild build-for-testing ended with ${describeExit(exit)}; see ${logPath}`)
      note(`built; log ${logPath}`)
    })

    runner = await record.step('start the runner on the simulator', async (note) => {
      const args = ['test-without-building', '-project', PROJECT, '-scheme', 'WebDriverAgentRunner', '-destination', `platform=iOS Simulator,id=${target.udid}`, '-derivedDataPath', DERIVED_DATA, 'COMPILER_INDEX_STORE_ENABLE=NO']
      try {
        const started = await RunnerProcess.start({ args, cwd: WDA_ROOT, environment: { USE_PORT: String(port) }, logPath: runnerLog, client, readyTimeoutMs: 240_000, knownFailures: KNOWN_FAILURES })
        note(`xcodebuild pid ${String(started.pid)} serves http://${HOST}:${port}; ${JSON.stringify(started.status['os'])}`)
        return started
      } catch (error) {
        if (!(error instanceof RunnerStartError)) throw error
        note(`log tail: ${(await logTail(error.logPath, 3)).replace(/\s*\n\s*/g, ' | ')}`)
        const message = `${error.message}. ${error.explanation} Log: ${error.logPath}`
        throw error.blocked ? new Blocked(message) : new Error(message)
      }
    })

    session = await record.step(`create a session that launches ${APP_NAME}`, async (note) => {
      appMayBeRunning = true
      const created = await WebDriverSession.create(client, { bundleId: BUNDLE_ID, arguments: [], environment: {}, shouldWaitForQuiescence: true, forceAppLaunch: true, shouldTerminateApp: true }, 120_000)
      note(`session ${created.id}`)
      return created
    })
    const active = session

    await record.step(`activate ${APP_NAME} and read its state`, async (note) => {
      await active.activateApp(BUNDLE_ID)
      const state = await observe(() => active.appState(BUNDLE_ID), (value) => value === 4, 5000)
      note(`state ${state.value} (${APP_STATE[state.value] ?? 'unknown'}); launchd lists it: ${String(await appIsRunningOn(target.udid))}`)
      if (!state.met) throw new Error(`${APP_NAME} is not in the foreground`)
    })

    await record.step("read the window's tree", async (note) => {
      const elements = await saveWindowTree(active, 'window-before.xml')
      note(`${elements.length} elements in the window; ${countTypes(elements).slice(0, 5).map(([type, count]) => `${type.replace('XCUIElementType', '')} ${count}`).join(', ')}`)
      if (!elements.some((element) => element.attributes['label'] === 'General')) throw new Error('nothing in the window is labelled General')
    })

    await record.step('find General by label and tap it', async (note) => {
      const general = await active.findOne(predicate("label == 'General' AND (elementType == 75 OR elementType == 9)"))
      note(`exactly one match, elementType ${JSON.stringify(await active.attribute(general, 'elementType'))}, identifier ${JSON.stringify(await active.attribute(general, 'identifier'))}`)
      await active.click(general)
      const opened = await observe(async () => ({
        bar: (await active.findAll(predicate("elementType == 21 AND (identifier == 'General' OR label == 'General')"))).length,
        about: (await active.findAll(predicate("label == 'About' AND (elementType == 75 OR elementType == 9)"))).length,
      }), (value) => value.bar === 1 || value.about === 1, 5000)
      note(`General screen: ${opened.value.bar} navigation bar(s) named General, ${opened.value.about} About row(s)`)
      if (!opened.met) throw new Error('the General screen did not open')
    })

    await record.step('go back to the main list', async (note) => {
      const bar = await active.findOne(role('XCUIElementTypeNavigationBar'))
      // Chosen by what it is, never by position: a bar's first button is not necessarily its back button.
      const back = await active.findOneWithin(bar, predicate("elementType == 9 AND (identifier == 'BackButton' OR label == 'Settings' OR label == 'Back')"))
      note(`back button labelled ${JSON.stringify(await active.attribute(back, 'label'))}, identifier ${JSON.stringify(await active.attribute(back, 'identifier'))}`)
      await active.click(back)
      const listed = await observe(async () => (await active.findAll(role('XCUIElementTypeSearchField'))).length, (count) => count === 1, 5000)
      if (!listed.met) throw new Error(`the main list came back with ${listed.value} search fields; exactly one is required`)
    })

    await record.step('type into the search field', async (note) => {
      const field = await active.findOne(role('XCUIElementTypeSearchField'))
      await active.click(field)
      // One synthesized typing event to the focused field; the value route would tap again on its own.
      await active.typeIntoFocused(SEARCH_TEXT)
      const value = await observe(() => active.attribute(field, 'value'), (read) => read === SEARCH_TEXT, 3000)
      const keyboards = await active.findAll(role('XCUIElementTypeKeyboard'))
      note(`tapped once, typed once; field reads ${JSON.stringify(value.value)} after ${value.attempts} look(s); software keyboard ${keyboards.length > 0 ? 'shown' : 'not shown'}`)
      if (!value.met) throw new Error('the search field does not hold exactly the typed text')
    })

    await record.step("read the window's tree again and find the typed text", async (note) => {
      const elements = await saveWindowTree(active, 'window-after.xml')
      const fields = elements.filter((element) => element.type === 'XCUIElementTypeSearchField' && element.attributes['value'] === SEARCH_TEXT)
      note(`${fields.length} search field(s) in the window hold the typed text`)
      if (fields.length !== 1) throw new Error('exactly one search field must hold the typed text')
    })

    const wdaSize = await record.step('capture the screen through WebDriverAgent', async (note) => {
      const png = await active.screenshot()
      const facts = inspectPng(png)
      const path = join(folders.artifacts, 'wda-screen.png')
      await writeFile(path, png)
      record.artifact(path)
      note(`${facts.width}x${facts.height} PNG, ${facts.distinctColors >= 4096 ? '4096 or more' : facts.distinctColors} colours`)
      if (facts.distinctColors < 2) throw new Error('the capture is one flat colour')
      return `${facts.width}x${facts.height}`
    })

    // A second capture source, recorded as such: simctl reads the simulator's display, not the app through XCTest.
    await record.step('capture the screen through simctl', async (note) => {
      const path = join(folders.artifacts, 'simctl-screen.png')
      await simctl(['io', target.udid, 'screenshot', '--type=png', path])
      const facts = inspectPng(await readFile(path))
      record.artifact(path)
      const size = `${facts.width}x${facts.height}`
      note(`${size} PNG, ${facts.distinctColors >= 4096 ? '4096 or more' : facts.distinctColors} colours; WebDriverAgent's capture was ${wdaSize}`)
      if (facts.distinctColors < 2) throw new Error('the capture is one flat colour')
    })

    await record.step(`terminate ${APP_NAME}`, async (note) => {
      const terminated = await active.terminateApp(BUNDLE_ID)
      const state = await observe(() => active.appState(BUNDLE_ID), (value) => value === 1, 5000)
      const gone = await observe(() => appIsRunningOn(target.udid), (running) => !running, 5000)
      note(`terminate answered ${String(terminated)}; state ${state.value} (${APP_STATE[state.value] ?? 'unknown'}); launchd lists it: ${String(gone.value)}`)
      if (!terminated || !state.met || !gone.met) throw new Error(`${APP_NAME} is still running`)
      appMayBeRunning = false
    })
  } catch (error) {
    if (!(error instanceof StepStopped)) {
      process.stderr.write(`Unexpected error outside a step: ${describeError(error)}\n`)
      record.facts['unexpectedError'] = describeError(error)
    }
  } finally {
    await cleanUp({ record, client, port, device, createdDevice, bootedDevice, keepDevice: values['keep-device'], runner, session, appMayBeRunning })
  }
  await record.finish(folders.artifacts)
  return record.exitCode
}

async function cleanUp(state: {
  readonly record: ProofRecord
  readonly client: WebDriverClient
  readonly port: number
  readonly device: Device | undefined
  readonly createdDevice: boolean
  readonly bootedDevice: boolean
  readonly keepDevice: boolean
  readonly runner: RunnerProcess | undefined
  readonly session: WebDriverSession | undefined
  readonly appMayBeRunning: boolean
}): Promise<void> {
  const { record, client, port, device, runner, session } = state
  if (state.appMayBeRunning && device !== undefined) {
    await record.cleanup(`terminate ${APP_NAME} after the stop`, async (note) => {
      if (session !== undefined) note(`terminate answered ${String(await session.terminateApp(BUNDLE_ID).catch((error: unknown) => describeError(error)))}`)
      if (await appIsRunningOn(device.udid)) {
        await simctl(['terminate', device.udid, BUNDLE_ID])
        note('terminated with simctl')
      }
    })
  }
  if (session !== undefined) {
    await record.cleanup('end the session', async () => {
      await session.end()
    })
  }
  if (runner !== undefined) {
    await record.cleanup('shut the runner down', async (note) => {
      // GET /wda/shutdown is WebDriverAgent's own shutdown route: the test method ends and xcodebuild exits.
      const answer = await client.send('GET', '/wda/shutdown').then((reply) => `answered ${reply.status} ${JSON.stringify(reply.text)}`, (error: unknown) => describeError(error))
      const ended = await runner.waitForEnd(30_000)
      note(`GET /wda/shutdown ${answer}; xcodebuild ended with ${describeExit(ended)}${ended.signalled ? ' after this proof signalled it' : ''}`)
      if (ended.signalled) throw new Error('the shutdown route did not end the runner')
    })
  }
  if (device !== undefined) {
    await record.cleanup('check that nothing is left running', async (note) => {
      const runnerPids = await observe(() => processIds({ pattern: RUNNER_PROCESS }), (pids) => pids.length === 0, 10_000)
      const listening = await isListening(HOST, port)
      const appRunning = (await deviceState(device.udid)) === 'Booted' ? await appIsRunningOn(device.udid) : false
      note(`${runnerPids.value.length} runner processes, ${APP_NAME} ${appRunning ? 'running' : 'not running'}, port ${port} ${listening ? 'still listening' : 'closed'}`)
      if (runnerPids.value.length > 0 || appRunning || listening) throw new Error('something this proof started is still running')
    })
  }
  if (device !== undefined && state.bootedDevice) {
    await record.cleanup('shut the simulator down', async (note) => {
      await simctl(['shutdown', device.udid], 120_000)
      const shutdown = await observe(() => deviceState(device.udid), (value) => value === 'Shutdown', 30_000)
      note(`state ${String(shutdown.value)}`)
      if (!shutdown.met) throw new Error('the simulator did not shut down')
    })
  }
  if (device !== undefined && state.createdDevice && !state.keepDevice) {
    await record.cleanup('delete the simulator this proof created', async (note) => {
      await simctl(['delete', device.udid], 120_000)
      const left = await deviceState(device.udid)
      note(left === undefined ? 'deleted' : `still listed as ${left}`)
      if (left !== undefined) throw new Error('the simulator is still listed')
    })
  }
}

process.exitCode = await main()
