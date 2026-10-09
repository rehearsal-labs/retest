import type { TestContext } from 'node:test'
import type { RequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import type { DiagnosticLine, DiagnosticsSummary } from '../../src/protocol/diagnostics.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { parseRequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import { readArtifact } from '../../src/diagnostics/artifact.ts'
import { nativePins } from '../../src/native/executors.ts'
import { listSimulators } from '../../src/native/ios-simulator.ts'
import { systemTools } from '../../src/native/processes.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { budgets, eventsOf, filesHolding, repositoryRoot, runCli, runProject, scratchFolder, testNamed, writeProject } from './cli-harness.ts'
import { nativeSkipReason, processesWith, taskDeskApp, taskPhoneApp, within } from './native-harness.ts'
import { endService } from './service-teardown.ts'
import { assertNativeNetworkLockLocation } from './native-network-lock-fixture.ts'

// Native diagnostics through Retest's CLI on real targets: TaskPhone on an iOS 26.5 simulator and TaskDesk on this
// Mac, against the cross-platform fixture service started with `--network-log`. The config declares that file for the
// phone with the client `ios` and for the desk with `macos`, and both keep their standard output by default; `plain` is
// TaskDesk with no declared source, and `quiet` is TaskDesk with `logs: 'none'`. One run of the fixture's three tests
// shows each app's own log lines and network records in the run folder with their identity and client, the sources an
// app lacks as unavailable with their reasons, a required screenshot check judged by the fake judge on the phone's own
// capture, no password in any file, and `inspect --test` showing the native sources. It takes the simulator and the
// desktop, so it runs only under the heavy-gate lock.

const unverified = (await nativeSkipReason('ios-simulator')) ?? (await nativeSkipReason('macos'))
const serverScript = join(repositoryRoot, 'fixtures/cross-platform/service/server.ts')
const testsFile = join(repositoryRoot, 'fixtures/cross-platform/tests/native-diagnostics.retest.ts')
const fakeJudge = fileURLToPath(new URL('../support/fake-evaluator.ts', import.meta.url))
const pairName = 'the phone and the desk keep their own log lines and network records, and the judge sees the phone'
const plainName = 'TaskDesk with no declared source keeps its standard output and has no network source'
const quietName = 'TaskDesk that keeps no log is launched by its executor and has neither source'
const taskDeskExecutable = '/TaskDesk.app/Contents/MacOS/TaskDesk'
const runnerApp = nativePins.executors.webdriveragent.runnerApp
const ada = SEEDED_ACCOUNTS.find((account) => account.id === 'ada')
assert.ok(ada !== undefined)
const password = ada.password
const timeouts = budgets({ setup: 300_000, action: 30_000, assertion: 20_000, test: 300_000, cleanup: 60_000 })

type Service = { readonly url: string; readonly networkLog: string; requests(): RequestRecord[] }

/**
 * Starts the fixture service in a process group of its own. The test stops it with SIGTERM; one that stays is ended
 * through its own handle, and anything of its group still there fails the test by name.
 */
async function startService(t: TestContext): Promise<Service> {
  const folder = await scratchFolder(t, 'retest-native-diagnostics-service-')
  const networkLog = join(folder, 'network.jsonl')
  const child = spawn(process.execPath, ['--conditions=retest-source', serverScript, '--port', '0', '--network-log', networkLog], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const { pid } = child
  assert.ok(pid !== undefined, 'the service did not start')
  const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
  t.after(async () => {
    child.kill('SIGTERM')
    await within(exited, 10_000, 'the service did not exit within 10 s of SIGTERM').catch(() => undefined)
    await endService(child, 'the fixture service')
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
      const requests = (): RequestRecord[] => (existsSync(networkLog) ? readFileSync(networkLog, 'utf8').split('\n').filter((line) => line !== '').flatMap((line) => parseRequestRecord(line) ?? []) : [])
      return { url, networkLog, requests }
    }
    if (performance.now() > end) assert.fail(`the service printed no address within 15 s: ${stderr}`)
    await delay(10)
  }
}

function configSource(service: Service, judgeLog: string): string {
  const desk = (diagnostics: string): string => `{ platform: 'macos', appPath: ${JSON.stringify(taskDeskApp)}, arguments: ['-reset', '-windowFrame', '20,60,700,480', '-serviceURL', ${JSON.stringify(service.url)}]${diagnostics} }`
  return `import { defineConfig, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: {
    phone: { platform: 'ios-simulator', appPath: ${JSON.stringify(taskPhoneApp)}, device: 'iPhone 17', runtime: '26.5', arguments: ['-reset', '-serviceURL', ${JSON.stringify(service.url)}], diagnostics: { network: { path: ${JSON.stringify(service.networkLog)}, client: 'ios' } } },
    desk: ${desk(`, diagnostics: { network: { path: ${JSON.stringify(service.networkLog)}, client: 'macos' } }`)},
    plain: ${desk('')},
    quiet: ${desk(", diagnostics: { logs: 'none' }")},
  },
  secrets: { password: env('RETEST_NATIVE_DIAGNOSTICS_PASSWORD') },
  secretOrigins: { password: ['dev.retest.fixtures.taskphone', 'dev.retest.fixtures.taskdesk'] },
  evaluation: { judges: { fake: { adapter: ${JSON.stringify(fakeJudge)}, options: { log: ${JSON.stringify(judgeLog)} }, accepts: ['images'] } }, timeoutMs: 30000 },
})
`
}

/** The processes a run could leave behind: an executor runner, xcodebuild, TaskDesk. */
async function nativeProcesses(): Promise<{ readonly pid: number; readonly command: string }[]> {
  const listed = [...(await processesWith(runnerApp)), ...(await processesWith('xcodebuild')), ...(await processesWith(taskDeskExecutable))]
  return [...new Map(listed.map((entry) => [entry.pid, entry])).values()]
}

/** A session's summary in a test's result, by app. */
function summaryOf(result: TestResult, app: string): DiagnosticsSummary {
  const summary = result.diagnostics?.find((entry) => entry.app === app)
  assert.ok(summary !== undefined, `${result.name} has diagnostics for ${app}: ${JSON.stringify(result.diagnostics)}`)
  return summary
}

/** The records of a session's artifact, between its capture markers, read back through Retest's own artifact reader. */
function artifactLines(run: FinishedRun, summary: DiagnosticsSummary): DiagnosticLine[] {
  assert.ok(summary.path !== undefined, `${summary.app ?? summary.sessionId} saved an artifact`)
  const reading = readArtifact(run.output, summary.path)
  assert.ok(reading.ok, reading.ok ? '' : reading.problem)
  const [started, ...rest] = reading.lines
  const finished = rest.pop()
  assert.deepEqual([started?.type, finished?.type], ['capture.started', 'capture.finished'], 'the artifact opens and closes with its capture markers')
  if (finished?.type === 'capture.finished') assert.deepEqual([finished.console, finished.network], [summary.console, summary.network], 'the artifact ends with the states its summary names')
  return rest
}

/** Checks a declared app's artifact: its own stdout lines and its own client's request records, each naming the session. */
function assertOwnRecords(run: FinishedRun, result: TestResult, app: string, expected: { source: 'simctl-stdout' | 'macos-stdout'; client: 'ios' | 'macos'; engine: 'ios-simulator' | 'macos' }): DiagnosticLine[] {
  const summary = summaryOf(result, app)
  assert.equal(summary.console.state, 'complete', JSON.stringify(summary.console))
  assert.equal(summary.network.state, 'complete', JSON.stringify(summary.network))
  assert.deepEqual([summary.scope?.engine, summary.scope?.source, summary.scope?.console.covered, summary.scope?.network.covered], [expected.engine, 'owned_app', ['owned_process'], ['app_network_source']])
  const lines = artifactLines(run, summary)
  const sessionId = `${result.attemptId}:${app}`
  assert.equal(summary.sessionId, sessionId)
  for (const line of lines) assert.deepEqual([line.testId, line.attemptId, line.app, line.sessionId], [result.testId, result.attemptId, app, sessionId], `every record names the test, attempt, app and session: ${JSON.stringify(line)}`)
  const logs = lines.filter((line) => line.type === 'console')
  assert.ok(logs.length > 0, `${app} kept its own log lines`)
  for (const line of logs) assert.deepEqual([line.origin, line.source, line.consoleType, typeof line.processId], ['native', expected.source, 'stdout', 'number'])
  assert.ok(logs.some((line) => /^POST \/api\/sign-in 200 \d+ms$/.test(line.text.text)), `${app} logged its sign-in request: ${JSON.stringify(logs.map((line) => line.text.text))}`)
  const requests = lines.filter((line) => line.type === 'network.request')
  assert.ok(requests.length > 0, `${app} kept its network records`)
  for (const line of lines) if (line.type.startsWith('network.')) assert.deepEqual(['source' in line ? line.source : undefined, 'client' in line ? line.client : undefined], ['app-network-file', expected.client], `a network record names the file and the client: ${JSON.stringify(line)}`)
  assert.ok(requests.some((line) => line.method === 'POST' && line.url === '/api/sign-in'), `${app}'s records hold its sign-in: ${JSON.stringify(requests)}`)
  return lines
}

function sequenceOf(events: readonly RetestEvent[], type: RetestEvent['type'], sessionId: string): number {
  const found = events.find((event) => event.type === type && 'sessionId' in event && event.sessionId === sessionId)
  assert.ok(found !== undefined, `the run recorded ${type} for ${sessionId}`)
  return found.sequence
}

// The network-file lock is a kernel lock taken with macOS's lockf, and native apps run only on a Mac, so elsewhere no
// lock is taken at all.
test('native network-file exclusion spans separate run temporary directories and retains its inode', { skip: process.platform === 'darwin' ? false : `unverified: the network-file lock stands on macOS's lockf, and this host is ${process.platform}` }, async t => {
  await assertNativeNetworkLockLocation(await scratchFolder(t, 'retest-network-lock-fixture-'))
})

test('native apps keep their declared diagnostics through the CLI, say what they lack, and give the judge the phone\'s capture', { timeout: 1_200_000, skip: unverified }, async (t) => {
  assert.deepEqual(await processesWith(taskDeskExecutable), [], 'an existing TaskDesk copy is never adopted or ended')
  const before = new Set((await nativeProcesses()).map((entry) => entry.pid))
  const service = await startService(t)
  const judgeLog = join(await scratchFolder(t, 'retest-native-diagnostics-judge-'), 'fake.jsonl')
  const root = await writeProject(t, { 'retest.config.ts': configSource(service, judgeLog), 'native-diagnostics.retest.ts': await readFile(testsFile, 'utf8') })
  const run = await runProject(t, root, { env: { RETEST_NATIVE_DIAGNOSTICS_PASSWORD: password }, timeouts, args: ['--workers', '1'] })

  const artifacts = join(homedir(), 'Library/Caches/retest-proofs/artifacts/native-diagnostics-wired')
  await mkdir(artifacts, { recursive: true })
  const kept = await mkdtemp(join(artifacts, 'run-'))
  await cp(run.output, kept, { recursive: true })
  await cp(service.networkLog, join(kept, 'service-network.jsonl'))
  if (existsSync(judgeLog)) await cp(judgeLog, join(kept, 'fake-judge.jsonl'))
  t.diagnostic(`artifacts: ${kept}`)

  // No password in any file the run wrote, nor in the service's records or what the judge was handed.
  assert.deepEqual(filesHolding(run.output, password), [], 'the password reached no file of the run')
  assert.equal(readFileSync(service.networkLog, 'utf8').includes(password), false, 'nor the service network log')
  assert.equal(existsSync(judgeLog) && readFileSync(judgeLog, 'utf8').includes(password), false, 'nor the judge log')

  // Nothing the run started is left: no simulator of the run, no TaskDesk, no runner or xcodebuild that was not there before.
  const listed = await listSimulators(systemTools, { timeoutMs: 30_000 })
  assert.ok(Array.isArray(listed), 'the simulators could be listed')
  for (const started of eventsOf(run.events, 'native.started')) {
    const udid = started.identity.device?.udid
    if (udid === undefined) continue
    assert.equal(listed.some((device) => device.udid === udid), false, `the simulator ${udid} is deleted`)
    assert.deepEqual(await processesWith(`/Devices/${udid}/`), [], 'no process of the simulator is left')
  }
  assert.deepEqual(await processesWith(taskDeskExecutable), [], 'TaskDesk is gone')
  assert.deepEqual((await nativeProcesses()).filter((entry) => !before.has(entry.pid)), [], 'no runner, xcodebuild or TaskDesk the run started is left')

  assert.ok(run.result !== undefined)
  assert.deepEqual(rebuildRecordedResult(run.events), run.result, 'the result rebuilds from the events')
  const pair = testNamed(run, pairName)
  const plain = testNamed(run, plainName)
  const quiet = testNamed(run, quietName)
  for (const result of [pair, plain, quiet]) assert.equal(result.status, 'passed', `${result.name}: ${result.failure?.message ?? ''}`)
  assert.equal(run.exit.code, 0)
  assert.equal(eventsOf(run.events, 'lease.expired').length, 0)

  // Each declared app's own lines and records, and none of the other's.
  const phoneLines = assertOwnRecords(run, pair, 'phone', { source: 'simctl-stdout', client: 'ios', engine: 'ios-simulator' })
  const deskLines = assertOwnRecords(run, pair, 'desk', { source: 'macos-stdout', client: 'macos', engine: 'macos' })
  assert.ok(phoneLines.some((line) => line.type === 'network.request' && line.method === 'POST' && line.url === '/api/tasks'), 'the phone\'s records hold the task it created')
  assert.equal(deskLines.some((line) => line.type === 'network.request' && line.url === '/api/tasks' && line.method === 'POST'), false, 'the desk created no task, and the phone\'s request is not in its records')
  const served = service.requests()
  assert.ok(served.some((request) => request.client === 'ios' && request.path === '/api/sign-in') && served.some((request) => request.client === 'macos' && request.path === '/api/sign-in'), 'both apps signed in at the service')

  // Each native source started before its app launched, and finished before its session ended.
  for (const app of ['phone', 'desk']) {
    const sessionId = `${pair.attemptId}:${app}`
    assert.ok(sequenceOf(run.events, 'diagnostics.started', sessionId) < sequenceOf(run.events, 'native.started', sessionId), `${app}'s capture started before its app launched`)
    assert.ok(sequenceOf(run.events, 'diagnostics.finished', sessionId) < sequenceOf(run.events, 'native.ended', sessionId), `${app}'s capture finished before its session ended`)
  }

  // The app with no declared source keeps its standard output and says it has no network source.
  const plainSummary = summaryOf(plain, 'plain')
  assert.equal(plainSummary.console.state, 'complete', JSON.stringify(plainSummary.console))
  assert.deepEqual(plainSummary.network, { state: 'unavailable', reason: 'the app provides no network source' })
  assert.deepEqual(plainSummary.scope?.network.covered, [])
  assert.ok(artifactLines(run, plainSummary).every((line) => line.type === 'console' && line.source === 'macos-stdout'), 'its artifact holds its log lines only')

  // The app that keeps no log is launched by its executor and has neither source; its empty artifact claims nothing.
  const quietSummary = summaryOf(quiet, 'quiet')
  assert.deepEqual(quietSummary.console, { state: 'unavailable', reason: 'the app provides no log source' })
  assert.deepEqual(quietSummary.network, { state: 'unavailable', reason: 'the app provides no network source' })
  assert.deepEqual(artifactLines(run, quietSummary), [])

  // The required screenshot check was judged on the phone's own capture, with its identity and time.
  const [evaluation, ...otherEvaluations] = pair.evaluations ?? []
  assert.ok(evaluation !== undefined && otherEvaluations.length === 0, `one AI check: ${JSON.stringify(pair.evaluations)}`)
  assert.deepEqual([evaluation.mode, evaluation.verdict, evaluation.judge], ['required', 'pass', 'fake'])
  const [evidence, ...otherEvidence] = evaluation.evidence
  assert.ok(evidence !== undefined && otherEvidence.length === 0)
  assert.deepEqual([evidence.kind, evidence.app, evidence.sessionId, evidence.attemptId, evidence.testId, evidence.source], ['screenshot', 'phone', `${pair.attemptId}:phone`, pair.attemptId, pair.testId, 'executor-screen'])
  assert.ok(evidence.captureReference !== undefined && Number.isFinite(Date.parse(evidence.capturedAt)) && typeof evidence.capturedElapsedMs === 'number', `the evidence names its capture and when it came: ${JSON.stringify(evidence)}`)
  assert.ok(evidence.path !== undefined)
  const image = await readFile(join(run.output, evidence.path))
  assert.equal(createHash('sha256').update(image).digest('hex'), evidence.sha256, 'the saved image is the one the record names')
  const calls = readFileSync(judgeLog, 'utf8').split('\n').filter((line) => line.includes('"call"'))
  assert.equal(calls.length, 1, 'the judge was asked once')
  assert.match(calls[0] ?? '', /"kind":"image"/)
  assert.match(calls[0] ?? '', /"app":"phone"/)
  assert.match(calls[0] ?? '', new RegExp(`"width":${evidence.width ?? -1},"height":${evidence.height ?? -1}`), 'the judge saw an image of the capture\'s size')

  // inspect --test shows each native source, what it covers, its records and where they are.
  const shown = await runCli(t, ['inspect', run.output, '--test', pair.testId], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  for (const app of ['phone', 'desk']) {
    assert.match(shown.stdout, new RegExp(`Diagnostics ${app} +console \\d+ entr(y|ies) · network \\d+ requests?`))
  }
  assert.match(shown.stdout, /console covers owned process; not anything else/)
  assert.match(shown.stdout, /network covers app network source; not anything else/)
  assert.match(shown.stdout, /Owned app stdout and declared app-supplied metadata only/)
  assert.match(shown.stdout, /stdout native {2}POST \/api\/sign-in 200 \d+ms/)
  assert.match(shown.stdout, /POST +200 .*\/api\/sign-in/)
  const quietShown = await runCli(t, ['inspect', run.output, '--test', quiet.testId], { cwd: root })
  assert.equal(quietShown.exit.code, 0, quietShown.stderr)
  assert.match(quietShown.stdout, /Diagnostics quiet +console unavailable: the app provides no log source · network unavailable: the app provides no network source/)
  const json = await runCli(t, ['inspect', run.output, '--test', pair.testId, '--json'], { cwd: root })
  const report: unknown = JSON.parse(json.stdout)
  assert.ok(typeof report === 'object' && report !== null && 'diagnostics' in report && Array.isArray(report.diagnostics))
  assert.equal(report.diagnostics.length, 2)
})
