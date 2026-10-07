import type { TestContext } from 'node:test'
import type { RequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { CLIENT_HEADER } from '../../fixtures/cross-platform/service/clients.ts'
import { parseRequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import { testedFirefox } from '../../src/browser/firefox/executable.ts'
import { webKitPin } from '../../src/browser/webkit/build.ts'
import { nativePins } from '../../src/native/executors.ts'
import { listSimulators } from '../../src/native/ios-simulator.ts'
import { selectedXcodebuild } from '../../src/native/executor-process.ts'
import { processesRunningExecutable } from './reference-flow-processes.ts'
import { systemTools } from '../../src/native/processes.ts'
import { isPlainObject } from '../../src/protocol/schema.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { budgets, eventsOf, filesHolding, repositoryRoot, runProject, scratchFolder, testNamed, writeProject } from './cli-harness.ts'
import { firefoxPath, testFirefoxRoute, webKitPath } from './engines.ts'
import { nativeSkipReason, processesWith, taskDeskApp, taskPhoneApp, within } from './native-harness.ts'
import { nativeCapturesInside, nativeObservationLoader } from './evidence-native-privacy.ts'
import { assertFreshNativeScreenshotPolicy } from './native-pixel-policy-fixture.ts'
import { browserPath } from '../support/test-browser.ts'
import { binary, ffmpeg, observations, preserveReport, proofRoot, secretAbsent, verifyVideo } from './evidence-support.test.ts'

// The reference flow of the cross-platform fixture once per web engine: TaskPhone on an iOS 26.5 simulator, the web
// front end in Chrome, then Firefox, then WebKit, and TaskDesk on this Mac, one test on all three against one fixture
// service, as tests/integration/reference-flow.test.ts runs it on Chrome. For each engine the same test file runs twice:
// on a service whose sync works, where it passes, and on one started with `--broken-sync=web:macos`, where the desk sees
// the phone's task but never the web's change to it, and the test fails at the desk's state check, naming the task.
// Each run records the engine that drove the web, its product, version and build, and the test checks them. Every run
// takes the simulator and the desktop, so the file runs only under the heavy-gate lock.

test('fresh native screenshot spans survive an ended foreign privacy stretch while overlapping and unstamped frames remain withheld', assertFreshNativeScreenshotPolicy)

const unverified = (await nativeSkipReason('ios-simulator')) ?? (await nativeSkipReason('macos'))
const serverScript = join(repositoryRoot, 'fixtures/cross-platform/service/server.ts')
const flowFile = join(repositoryRoot, 'fixtures/cross-platform/tests/reference-flow.retest.ts')
const flowName = 'creates a task on the phone, marks that task done on the web and sees it done on the desk, by its id'
const taskDeskExecutable = '/TaskDesk.app/Contents/MacOS/TaskDesk'
const runnerApp = nativePins.executors.webdriveragent.runnerApp
const ada = SEEDED_ACCOUNTS.find((account) => account.id === 'ada')
assert.ok(ada !== undefined)
const password = ada.password
// Long enough that each wait for another client's change is visible in the run's own times.
const syncDelayMs = 3000
const timeouts = budgets({ setup: 300_000, action: 30_000, assertion: 20_000, test: 300_000, cleanup: 60_000 })
const flowTest = { timeout: 900_000, skip: unverified }

/**
 * A web engine the flow's `web` app runs on: the config target for a base URL, what the `retest` process needs to start
 * it on this machine, and the identity its `browser.started` must record. A pinned build's version and build are
 * exact; Chrome is the machine's installed Chrome, whose version has four numbers and whose build is a revision.
 */
type WebEngine = {
  readonly name: 'chromium' | 'firefox' | 'webkit'
  readonly label: string
  target(baseUrl: string): string
  environment(): Readonly<Record<string, string>>
  readonly product: string
  readonly version: string | RegExp
  readonly build: string | RegExp
}

const webEngines: readonly WebEngine[] = [
  {
    name: 'chromium',
    label: 'Chrome',
    target: (baseUrl) => `chrome({ baseUrl: ${JSON.stringify(baseUrl)} })`,
    environment: () => ({}),
    product: 'Chrome',
    version: /^\d+\.\d+\.\d+\.\d+$/,
    build: /^\S+$/,
  },
  {
    name: 'firefox',
    label: 'Firefox',
    target: (baseUrl) => `{ browser: 'firefox', executablePath: ${JSON.stringify(firefoxPath())}, baseUrl: ${JSON.stringify(baseUrl)} }`,
    environment: () => ({ RETEST_FIREFOX_ROUTE: testFirefoxRoute() }),
    product: 'Firefox',
    version: testedFirefox().version,
    build: testedFirefox().buildId ?? 'no pinned build',
  },
  {
    name: 'webkit',
    label: 'WebKit',
    target: (baseUrl) => `{ browser: 'webkit', executablePath: ${JSON.stringify(webKitPath())}, baseUrl: ${JSON.stringify(baseUrl)} }`,
    environment: () => ({}),
    product: 'WebKit',
    version: new RegExp(`^\\d+(\\.\\d+)+\\+?, build ${webKitPin.revision}$`),
    build: webKitPin.revision,
  },
]

type Service = { readonly url: string; readonly networkLog: string; requests(): RequestRecord[] }

/**
 * Starts the fixture service in a process group of its own; the test stops it with SIGTERM. A service that stays is
 * ended through the record of what this test launched, each process checked against its record first, and a service
 * still there after that fails the test by name.
 */
async function startService(t: TestContext, flags: readonly string[]): Promise<Service> {
  const folder = await scratchFolder(t, 'retest-reference-service-')
  const networkLog = join(folder, 'network.jsonl')
  const args = ['--conditions=retest-source', serverScript, '--port', '0', '--sync-delay-ms', String(syncDelayMs), '--network-log', networkLog, ...flags]
  const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const { pid } = child
  assert.ok(pid !== undefined, 'the service did not start')
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  // Recorded only while Node has not reaped the service, so its pid can belong to nothing else.
  let ownership: OwnedProcessGroup | undefined
  const record = (): void => {
    if (child.exitCode !== null || child.signalCode !== null) return
    ownership ??= new OwnedProcessGroup(pid)
    ownership.capture()
  }
  t.after(async () => {
    record()
    child.kill('SIGTERM')
    const stopped = await within(exited, 10_000, 'the service did not exit within 10 s of SIGTERM').then(() => true, () => false)
    if (stopped) return
    record()
    const problems = ownership?.remains() === true ? ownership.signalReport('SIGKILL').problems : []
    const ended = await within(exited, 5000, 'the service was still there 5 s after SIGKILL').then(() => true, () => false)
    if (!ended) assert.fail(['The fixture service did not stop, and the test ends only what it recorded.', ...problems].join('\n'))
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (text: string) => {
    stdout += text
  })
  child.stderr.setEncoding('utf8').on('data', (text: string) => {
    stderr += text
  })
  const end = performance.now() + 15_000
  for (;;) {
    const url = /^(http:\/\/127\.0\.0\.1:\d+)\n/.exec(stdout)?.[1]
    if (url !== undefined) {
      record()
      const requests = (): RequestRecord[] => {
        assert.ok(existsSync(networkLog), 'the service wrote its request log')
        return readFileSync(networkLog, 'utf8').split('\n').filter((line) => line !== '').map((line) => {
          const record = parseRequestRecord(line)
          assert.ok(record !== undefined, 'every service request record parses')
          return record
        })
      }
      return { url, networkLog, requests }
    }
    if (performance.now() > end) assert.fail(`the service printed no address within 15 s: ${stderr}`)
    await delay(10)
  }
}

function configSource(service: string, engine: WebEngine): string {
  return `import { chrome, defineConfig, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    phone: { platform: 'ios-simulator', appPath: ${JSON.stringify(taskPhoneApp)}, device: 'iPhone 17', runtime: '26.5', arguments: ['-reset', '-serviceURL', ${JSON.stringify(service)}] },
    web: ${engine.target(service)},
    desk: { platform: 'macos', appPath: ${JSON.stringify(taskDeskApp)}, arguments: ['-reset', '-windowFrame', '20,60,700,480', '-serviceURL', ${JSON.stringify(service)}] },
  },
  recording: { record: true, fps: 10, size: { width: 320, height: 240 } },
  secrets: { password: env('RETEST_REFERENCE_FLOW_PASSWORD') },
  secretOrigins: { password: ['dev.retest.fixtures.taskphone', 'dev.retest.fixtures.taskdesk'] },
})
`
}

/** The processes a run could leave behind: an executor runner, xcodebuild, TaskDesk. */
async function nativeProcesses(): Promise<{ readonly pid: number; readonly command: string }[]> {
  const xcodebuild = await selectedXcodebuild(systemTools)
  assert.equal(typeof xcodebuild, 'string', 'the selected Xcode executable can be identified')
  assert.ok(typeof xcodebuild === 'string')
  const listed = [...(await processesWith(runnerApp)), ...processesRunningExecutable(await processesWith(xcodebuild), xcodebuild), ...(await processesWith(taskDeskExecutable))]
  return [...new Map(listed.map((entry) => [entry.pid, entry])).values()]
}

/** The processes of a web engine's browser that a run could leave behind, by its executable. */
async function browserProcesses(engine: WebEngine): Promise<{ readonly pid: number; readonly command: string }[]> {
  if (engine.name === 'firefox') return processesWith(firefoxPath())
  if (engine.name === 'webkit') return processesWith(webKitPath())
  return processesWith(browserPath())
}

type Flow = { readonly run: FinishedRun; readonly service: Service; readonly kept: string }

async function runFlow(t: TestContext, engine: WebEngine, flags: readonly string[], folder: string): Promise<Flow> {
  assert.deepEqual(await processesWith(taskDeskExecutable), [], 'an existing TaskDesk copy is never adopted or ended')
  const before = new Set((await nativeProcesses()).map((entry) => entry.pid))
  const initialSimulators = await listSimulators(systemTools, { timeoutMs: 30_000 })
  assert.ok(Array.isArray(initialSimulators), 'the existing simulators could be listed')
  const simulatorsBefore = new Set(initialSimulators.map((device) => device.udid))
  const browsersBefore = new Set((await browserProcesses(engine)).map((entry) => entry.pid))
  const service = await startService(t, flags)
  const observed = join(proofRoot, folder + '-observations')
  const loader = nativeObservationLoader(observed, true)
  let flowSource = await readFile(flowFile, 'utf8')
  for (const app of ['phone', 'desk']) {
    const fill = `await ${app}.getByTestId('password-field').fill(secret('password'))`
    assert.equal(flowSource.split(fill).length, 2, 'the unchanged native secret fill is present exactly once')
    // Keep the original action once. Wait for a new whole native read, not a fixed sleep, before sign-in input.
    flowSource = flowSource.replace(fill, `${fill}\n  await awaitFilledNativeFrame('${app}')`)
  }
  flowSource += `
import { access as filledFrameAccess, writeFile as filledFrameWrite } from 'node:fs/promises'
async function awaitFilledNativeFrame(app: 'phone' | 'desk'): Promise<void> {
  const prefix = ${JSON.stringify(observed)} + '/' + app + '-filled-frame'
  await filledFrameWrite(prefix + '-request', 'filled state requested\\n')
  const deadline = performance.now() + 20000
  for (;;) {
    try {
      await filledFrameAccess(prefix + '-ready')
      // Keep sign-in beyond the events' whole-millisecond rounding boundary.
      await new Promise(resolve => setTimeout(resolve, 5))
      return
    }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    if (performance.now() >= deadline) throw new Error('No fresh native filled-state frame arrived for ' + app + '.')
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
`
  const root = await writeProject(t, { 'retest.config.ts': configSource(service.url, engine), 'reference-flow.retest.ts': flowSource })
  const run = await runProject(t, root, { env: { RETEST_REFERENCE_FLOW_PASSWORD: password, RETEST_MEDIA_BINARY: binary, RETEST_FFMPEG: ffmpeg, NODE_OPTIONS: `--import=${loader}`, ...engine.environment() }, timeouts, args: ['--workers', '1'] })
  const saved = await preserveReport(run, folder + '-recorded')
  secretAbsent(run, password)
  t.diagnostic(`recorded flow ${saved}; approved frames ${observed}`)
  await t.test('native default keeps sign-in pixels; secure fields prove masked read-back and plain fields may show characters', async () => {
    const { decoder } = await import('./evidence-support.test.ts')
    const intervals = eventsOf(run.events, 'capture.withheld').filter(event => event.session === 'phone' || event.session === 'desk')
    const entries = eventsOf(run.events, 'capture.native_entry').filter(event => event.session === 'phone' || event.session === 'desk')
    assert.equal(entries.length, 2, 'one declared secret is filled in each native app')
    assert.equal(intervals.length, 0, 'default native secret input opens no withheld stretch')
    const proof: { app: string | undefined; branch: string; maskedReadBack: boolean; imagesChecked: number }[] = []
    for (const entry of entries) {
      const secure = entry.nativeField === 'secure'
      assert.equal(entry.branch, secure ? 'typed into a secure field' : entry.nativeField === 'plain' ? 'typed into a plain field, pixels kept' : 'field type unreadable, pixels kept')
      const masked = eventsOf(run.events, 'capture.masked_entry').filter(event => event.sessionId === entry.sessionId && event.secret === entry.secret)
      assert.equal(masked.length, secure ? 1 : 0, 'plain pixels are kept without a masking claim')
      if (secure) {
        assert.equal(masked[0]?.nativeField, 'secure')
        assert.equal(masked[0]?.readBack, 'length_matched', 'the platform secure field must read back only masking characters with the required length')
      }
      const recording = run.result?.files.flatMap(file => file.tests).flatMap(result => result.recordings ?? []).find(record => record.sessionId === entry.sessionId)
      assert.ok(recording)
      const fill = eventsOf(run.events, 'action.completed').find(event => event.sessionId === entry.sessionId && event.command === 'fill' && event.secret === 'password')
      const signIn = eventsOf(run.events, 'action.completed').find(event => event.sessionId === entry.sessionId && event.locator?.by === 'testId' && event.locator.value === 'sign-in-button')
      assert.ok(fill && signIn, 'the original secret fill and sign-in action complete')
      const applicable = eventsOf(run.events, 'capture.withheld').filter(interval => interval.sessionId === entry.sessionId || recording.source === 'window-crop')
      assert.ok(applicable.every(interval => interval.fromUs >= signIn.elapsedMs * 1000 || eventsOf(run.events, 'capture.resumed').some(end => end.sessionId === interval.sessionId && end.fromUs === interval.fromUs && end.untilUs <= entry.atUs)), 'no privacy stretch overlaps native sign-in, including shared-display stretches')
      const approved = observations(observed, recording)
      const frames = approved.frames
      assert.ok(frames.some(frame => frame.timestampUs < entry.atUs), 'video includes the pre-entry state')
      assert.ok(frames.some(frame => frame.timestampUs >= fill.elapsedMs * 1000 && frame.timestampUs < (signIn.elapsedMs - signIn.durationMs) * 1000), 'video includes the filled field with the selected native pixel policy')
      // Events and action durations round to whole milliseconds; stay inside both rounded boundaries.
      assert.ok(nativeCapturesInside(observed, recording, (fill.elapsedMs + 1) * 1000, (signIn.elapsedMs - signIn.durationMs - 1) * 1000) > 0, 'an approved native image was requested after the fill and arrived before sign-in input')
      assert.ok(frames.some(frame => frame.timestampUs > signIn.elapsedMs * 1000), 'video continues after sign-in')
      assert.equal(approved.ended.frameMapOmitted, 0, 'the whole movie map is required')
      const sources = new Set(frames.map(frame => frame.frameId))
      assert.ok(approved.ended.frameMap.every(frame => sources.has(frame.frameId)), 'every whole-movie source is among the checked images')
      assert.ok(frames.length > 0)
      // Decode every approved source. Plain-field characters and app echoes are permitted by the founder's rule;
      // secure masking is proved by the actual field's private read-back, not a whole-image absence claim.
      for (const frame of frames) await decoder(ffmpeg, ['-v', 'error', '-xerror', '-i', join(approved.folder, frame.image), '-f', 'null', '-'])
      proof.push({ app: entry.session, branch: entry.branch, maskedReadBack: secure, imagesChecked: frames.length })
    }
    writeFileSync(join(observed, 'secrecy.json'), JSON.stringify({ policy: 'native pixels kept by default; secure platform masking required; plain characters and app echoes permitted', entries: proof, withheldIntervals: intervals.length, wholeSourcesChecked: true }, null, 2) + '\n')
  })
  await t.test('each app has independently decoded recording with attempt and session identity', async appTest => {
    const result = testNamed(run, flowName)
    assert.deepEqual((result.recordings ?? []).map(recording => recording.app).sort(), ['desk', 'phone', 'web'])
    for (const recording of result.recordings ?? []) {
      await appTest.test(`${recording.app} recording independently decodes`,async()=>{
      assert.deepEqual([recording.testId, recording.attemptId, recording.sessionId], [result.testId, result.attemptId, `${result.attemptId}:${recording.app}`])
      await verifyVideo(run, recording, observed)
      })
    }
    // A frozen stale desk state must actually be in the evidence, not inferred from a pre-login frame.
    const desk = result.recordings?.find(recording => recording.app === 'desk')
    assert.ok(desk?.clock)
    const lastDeskCheck = eventsOf(run.events, flags.length === 0 ? 'assertion.passed' : 'assertion.failed').filter(event => event.session === 'desk').at(-1)
    assert.ok(lastDeskCheck)
    const withheld = eventsOf(run.events, 'capture.withheld').filter(event => event.sessionId === desk.sessionId)
    const resumed = eventsOf(run.events, 'capture.resumed').filter(event => event.sessionId === desk.sessionId)
    assert.equal(withheld.some(event => event.fromUs <= lastDeskCheck.elapsedMs * 1000 && !resumed.some(end => end.untilUs <= lastDeskCheck.elapsedMs * 1000 && end.untilUs >= event.fromUs)), false, 'the final desk state must have pixel evidence; withholding cannot establish it')
  })

  const artifacts = join(homedir(), 'Library/Caches/retest-proofs/artifacts/evidence-flow-engines', folder)
  await mkdir(artifacts, { recursive: true })
  const kept = await mkdtemp(join(artifacts, 'run-'))
  assert.deepEqual(filesHolding(run.output, password), [], 'the password reached no file of the run')
  assert.equal(readFileSync(service.networkLog, 'utf8').includes(password), false, 'nor the service network log')
  await cp(run.output, kept, { recursive: true })
  await cp(service.networkLog, join(kept, 'service-network.jsonl'))
  t.diagnostic(`artifacts: ${kept}`)
  for (const started of eventsOf(run.events, 'browser.started')) t.diagnostic(`recorded web engine ${started.engine}, ${started.product} ${started.version}, build ${started.build}, executable ${started.executablePath}`)
  if (engine.name === 'firefox') t.diagnostic(`Firefox launch route: ${engine.environment()['RETEST_FIREFOX_ROUTE']}`)

  // Nothing the run started is left: no simulator of the run, no TaskDesk, no runner, xcodebuild or browser that was not there before.
  const listed = await listSimulators(systemTools, { timeoutMs: 30_000 })
  assert.ok(Array.isArray(listed), 'the simulators could be listed')
  assert.deepEqual(listed.filter((device) => !simulatorsBefore.has(device.udid)), [], 'no simulator created during the run is left, including on failed setup')
  for (const started of eventsOf(run.events, 'native.started')) {
    const udid = started.identity.device?.udid
    if (udid === undefined) continue
    assert.equal(listed.some((device) => device.udid === udid), false, `the simulator ${udid} is deleted`)
    assert.deepEqual(await processesWith(`/Devices/${udid}/`), [], 'no process of the simulator is left')
  }
  assert.deepEqual(await processesWith(taskDeskExecutable), [], 'TaskDesk is gone')
  assert.deepEqual((await nativeProcesses()).filter((entry) => !before.has(entry.pid)), [], 'no runner, xcodebuild or TaskDesk the run started is left')
  assert.deepEqual((await browserProcesses(engine)).filter((entry) => !browsersBefore.has(entry.pid)), [], `no ${engine.label} the run started is left`)

  assert.ok(run.result !== undefined)
  assert.deepEqual(rebuildRecordedResult(run.events), run.result, 'the result rebuilds from the events')
  assert.equal(eventsOf(run.events, 'lease.expired').length, 0)
  return { run, service, kept }
}

function attemptEvents(run: FinishedRun, testId: string): RetestEvent[] {
  return run.events.filter((event) => 'testId' in event && event.testId === testId)
}

// The task the web opened, as its own check of the open task's id recorded it.
function openedId(run: FinishedRun): string {
  const opened = eventsOf(run.events, 'assertion.passed').find((event) => event.session === 'web' && event.locator?.by === 'testId' && event.locator.value === 'selected-task-id')
  const id = opened?.actual?.text
  assert.ok(id !== undefined && /^task-[0-9a-f]{12}$/.test(id), `the web opened a task with an assigned id: ${JSON.stringify(opened?.actual)}`)
  return id
}

// The passing checks of one element by its test id that expected, and saw, exactly `text`.
function passedOn(run: FinishedRun, session: string, testIdValue: string, text: string): Extract<RetestEvent, { type: 'assertion.passed' }>[] {
  return eventsOf(run.events, 'assertion.passed').filter((event) => event.session === session && event.locator?.by === 'testId' && event.locator.value === testIdValue && event.expected?.text === text && event.actual?.text === text)
}

function matches(value: string | undefined, expected: string | RegExp): boolean {
  return value !== undefined && (typeof expected === 'string' ? value === expected : expected.test(value))
}

// The apps the run started, each with its identity, the web on `engine` with its engine, product, version and build,
// all after the one lease that covers the device and the desktop. Gives the web browser's identity in words.
function assertStartedApps(run: FinishedRun, engine: WebEngine): string {
  const natives = eventsOf(run.events, 'native.started')
  assert.deepEqual(natives.map((event) => event.app).sort(), ['desk', 'phone'])
  for (const started of natives) {
    const { identity } = started
    const executor = identity.platform === 'macos' ? nativePins.executors.mac2 : nativePins.executors.webdriveragent
    assert.equal(identity.app.bundleId, started.app === 'phone' ? 'dev.retest.fixtures.taskphone' : 'dev.retest.fixtures.taskdesk')
    assert.equal(identity.platform, started.app === 'phone' ? 'ios-simulator' : 'macos')
    assert.equal(typeof identity.app.version, 'string')
    assert.equal(typeof identity.app.build, 'string')
    assert.match(identity.app.sha256, /^[0-9a-f]{64}$/)
    assert.equal(identity.os.name, started.app === 'phone' ? 'iOS' : 'macOS')
    if (started.app === 'phone') assert.deepEqual([identity.os.version, identity.os.build, identity.device?.type], ['26.5', '23F77', 'iPhone 17'])
    assert.deepEqual([identity.executor.name, identity.executor.version, identity.executor.commit], [executor.name, executor.version, executor.commit])
    assert.deepEqual(identity.xcode, nativePins.toolchain.xcode)
  }
  const browsers = eventsOf(run.events, 'browser.started')
  assert.deepEqual(
    browsers.map((event) => [event.app, event.engine, event.product]),
    [['web', engine.name, engine.product]],
  )
  const [browser] = browsers
  assert.ok(browser !== undefined)
  assert.ok(matches(browser.version, engine.version), `the ${engine.label} version ${JSON.stringify(browser.version)} is ${String(engine.version)}`)
  assert.ok(matches(browser.build, engine.build), `the ${engine.label} build ${JSON.stringify(browser.build)} is ${String(engine.build)}`)
  // The test's own record names the web session by the same engine, product and version.
  const sessions = eventsOf(run.events, 'test.started').flatMap((event) => event.execution?.sessions ?? [])
  const web = sessions.find((session) => session.app === 'web')
  assert.deepEqual([web?.engine, web?.product, web?.version], [engine.name, engine.product, browser.version], 'the test names the engine that drove its web session')
  const lease = eventsOf(run.events, 'lease.taken')
  assert.equal(lease.length, 1)
  const [taken] = lease
  assert.ok(taken !== undefined)
  assert.deepEqual(taken.lease.covers.map((part) => [part.kind, part.apps]).sort(), [['desktop', ['desk']], ['device', ['phone']]])
  for (const event of [...natives, ...browsers]) assert.ok(event.sequence > taken.sequence, 'the complete lease precedes every app and browser launch')
  return `web engine ${browser.engine ?? 'unnamed'}: ${browser.product} ${browser.version}, build ${browser.build ?? 'none'}, ${browser.executablePath}`
}

/** A field of a JSON object the service answered with. */
function field(value: unknown, name: string): unknown {
  assert.ok(isPlainObject(value), `expected an object, received ${JSON.stringify(value)}`)
  return value[name]
}

/** The service's own reading of one task for a fresh session of `client`. */
async function readAs(service: Service, client: string, id: string): Promise<{ done: unknown; revision: unknown }> {
  const signedIn = await fetch(`${service.url}/api/sign-in`, { method: 'POST', headers: { [CLIENT_HEADER]: client, 'content-type': 'application/json' }, body: JSON.stringify({ account: 'ada', password }), signal: AbortSignal.timeout(5000) })
  assert.equal(signedIn.status, 200)
  const token = field(await signedIn.json(), 'token')
  assert.equal(typeof token, 'string')
  const read = await fetch(`${service.url}/api/tasks/${id}`, { headers: { authorization: `Bearer ${String(token)}` }, signal: AbortSignal.timeout(5000) })
  assert.equal(read.status, 200)
  const task = field(await read.json(), 'task')
  return { done: field(task, 'done'), revision: field(task, 'revision') }
}

for (const engine of webEngines.filter(engine => engine.name === (process.env['RETEST_TEST_ENGINE'] ?? 'chromium'))) {
  test(`the reference flow with the web on ${engine.label} creates a task on iOS, changes it on the web and verifies it on macOS, through real apps`, flowTest, async (t) => {
    const { run, service } = await runFlow(t, engine, [], engine.name)
    const result = testNamed(run, flowName)
    assert.equal(result.status, 'passed', result.failure?.message)
    assert.equal(run.exit.code, 0)
    t.diagnostic(assertStartedApps(run, engine))

    // One task, by one id: the phone showed it, the web opened and changed it, the desk read it.
    const id = openedId(run)
    assert.equal(passedOn(run, 'phone', 'created-task-id', id).length, 1, 'the phone showed the id the web opened')
    assert.equal(passedOn(run, 'desk', 'selected-task-id', id).length, 1, 'the desk opened that id')
    assert.equal(passedOn(run, 'desk', `task-state-${id}`, 'Open').length, 1, 'the desk saw the phone task before the change')
    const done = passedOn(run, 'desk', `task-state-${id}`, 'Done')
    assert.equal(done.length, 1, 'the desk saw the web change')

    const requests = service.requests()
    const created = requests.filter((request) => request.method === 'POST' && request.path === '/api/tasks')
    assert.deepEqual(created.map(({ client, status }) => ({ client, status })), [{ client: 'ios', status: 201 }], 'the task was made on the phone, once')
    const changed = requests.filter((request) => request.method === 'PATCH')
    assert.deepEqual(changed.map(({ path, client, status }) => ({ path, client, status })), [{ path: `/api/tasks/${id}`, client: 'web', status: 200 }], 'the web changed that task, once')
    for (const client of ['ios', 'web', 'macos'] as const) {
      assert.deepEqual(requests.filter((request) => request.path === '/api/sign-in' && request.client === client).map((request) => request.status), [200], `${client} signed in once with the password`)
    }
    assert.deepEqual(requests.filter((request) => request.client === 'macos' && request.method !== 'GET' && request.path !== '/api/sign-in'), [], 'the desk wrote nothing')

    // The desk's check waited for the change: it passed no sooner than the sync delay after the web saved.
    const [change] = changed
    assert.ok(change !== undefined && done[0] !== undefined)
    const waitedMs = Date.parse(done[0].time) - Date.parse(change.startedAt)
    t.diagnostic(`the desk saw the change ${waitedMs} ms after the web sent it; sync delay ${syncDelayMs} ms`)
    assert.ok(waitedMs >= syncDelayMs, `the desk saw the change ${waitedMs} ms after it was sent, before the ${syncDelayMs} ms sync delay`)
  })

  test(`with the web on ${engine.label} and sync from the web to the desk broken, the reference flow fails at the desk state check, naming the task, and goes no further`, flowTest, async (t) => {
    const { run, service } = await runFlow(t, engine, ['--broken-sync=web:macos'], `${engine.name}-broken-sync`)
    const health: unknown = await (await fetch(`${service.url}/api/health`, { signal: AbortSignal.timeout(5000) })).json()
    assert.deepEqual(field(health, 'brokenSync'), { kind: 'links', links: [{ from: 'web', to: 'macos' }] })
    assert.equal(run.exit.code, 1)
    const result = testNamed(run, flowName)
    assert.deepEqual([result.status, result.failure?.class], ['failed', 'check_failed'])
    t.diagnostic(assertStartedApps(run, engine))

    const id = openedId(run)
    assert.equal(passedOn(run, 'phone', 'created-task-id', id).length, 1, 'the phone showed the id the web opened')
    assert.equal(passedOn(run, 'desk', `task-state-${id}`, 'Open').length, 1, 'the desk saw the phone task, so the failure is not a missing task')
    assert.equal(passedOn(run, 'web', 'selected-task-state', 'Done').length, 1, 'the web saved its change')

    const attempt = attemptEvents(run, result.testId)
    const failed = attempt.filter((event) => event.type === 'assertion.failed')
    assert.equal(failed.length, 1)
    const [check] = failed
    assert.ok(check?.type === 'assertion.failed')
    assert.deepEqual([check.session, check.locator], ['desk', { by: 'testId', value: `task-state-${id}` }], 'the failing check is the desk reading the task by its id')
    assert.equal(check.actual?.text, 'Open', 'the desk still shows the task as the phone made it')
    assert.match(result.failure?.message ?? '', new RegExp(`task-state-${id}`))
    assert.match(result.failure?.message ?? '', /"Open", expected "Done"/)
    const later = attempt.filter((event) => (event.type.startsWith('action.') || event.type.startsWith('assertion.')) && event.sequence > check.sequence)
    assert.deepEqual(later.map((event) => event.type), [], 'nothing ran after the failed check')

    // The service took the web's change and kept it from every macOS session, while the desk kept reading.
    const requests = service.requests()
    const changed = requests.filter((request) => request.method === 'PATCH')
    assert.deepEqual(changed.map(({ path, client, status }) => ({ path, client, status })), [{ path: `/api/tasks/${id}`, client: 'web', status: 200 }])
    const [change] = changed
    assert.ok(change !== undefined)
    const due = Date.parse(change.startedAt) + syncDelayMs
    const deskReads = requests.filter((request) => request.client === 'macos' && request.method === 'GET' && request.path === '/api/tasks' && Date.parse(request.startedAt) > due)
    t.diagnostic(`the desk read its list ${deskReads.length} times after the change was due`)
    assert.ok(deskReads.length > 0, 'the desk read its list after the change was due')
    assert.ok(deskReads.every((request) => request.status === 200))
    assert.deepEqual(requests.filter((request) => request.client === 'macos' && request.method !== 'GET' && request.path !== '/api/sign-in'), [], 'the desk wrote nothing')
    assert.deepEqual(await readAs(service, 'macos', id), { done: false, revision: 1 }, 'a macOS session reads the task as the phone made it')
    assert.deepEqual(await readAs(service, 'web', id), { done: true, revision: 2 }, 'the web change was kept')
  })
}
