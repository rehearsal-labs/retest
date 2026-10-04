import type { NativeAppSession } from '../../src/native/session.ts'
import type { LoggedNativeLaunch } from '../../src/native/logs.ts'
import type { RecordedProcess } from '../../src/native/processes.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { parseRequestRecord } from '../../fixtures/cross-platform/service/request-log.ts'
import { AttemptDiagnostics } from '../../src/diagnostics/attempt.ts'
import { parseArtifact } from '../../src/diagnostics/artifact.ts'
import { defaultDiagnosticsPolicy } from '../../src/diagnostics/policy.ts'
import { diagnosticsCardLines } from '../../src/diagnostics/report.ts'
import { IosSimulatorRuntime } from '../../src/native/ios-simulator.ts'
import { MacosDesktop } from '../../src/native/macos-app.ts'
import { launchLoggedNativeApp } from '../../src/native/logs.ts'
import { commandOf, endProblem, endRecorded, systemTools } from '../../src/native/processes.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { executorBuild, nativeSkipReason, processesWith, taskDeskApp, taskPhoneApp, within } from './native-harness.ts'

const iosSkip = await nativeSkipReason('ios-simulator')
const macosSkip = await nativeSkipReason('macos') ?? ((await processesWith('/TaskDesk.app/Contents/MacOS/TaskDesk')).length > 0 ? 'TaskDesk is already running; this test touches only its own launch' : undefined)
const out = resolve(process.env['RETEST_NATIVE_DIAGNOSTICS_OUT'] ?? '/tmp/retest-native-diagnostics-build')
await mkdir(out, { recursive: true })

/** A real service child, with its exact command recorded. No output from the app or service is saved raw. */
async function service(folder: string): Promise<{ url: string; path: string; stop(): Promise<void> }> {
  const path = join(folder, 'service-network.jsonl')
  const child = spawn(process.execPath, ['--conditions=retest-source', 'fixtures/cross-platform/service/server.ts', '--port', '0', '--network-log', path], { cwd: resolve('.'), env: {}, stdio: ['ignore', 'pipe', 'ignore'] })
  const address = new Promise<string>((resolve, reject) => {
    let first = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { if (first.includes('\n')) return; first += chunk; const line = first.split('\n')[0] ?? ''; if (first.includes('\n')) /^http:\/\/127\.0\.0\.1:\d+$/.test(line) ? resolve(line) : reject(new Error('The fixture service gave no loopback address.')) })
    child.once('error', () => reject(new Error('The fixture service did not start.')))
    child.once('exit', () => reject(new Error('The fixture service ended before its address.')))
  })
  const pid = child.pid
  if (pid === undefined) throw new Error('The fixture service launch names no pid.')
  const reading = await commandOf(systemTools, pid)
  if (reading.state !== 'present') throw new Error('The fixture service command could not be recorded.')
  const serviceProcess: RecordedProcess = { pid, command: reading.command }
  const stop = async (): Promise<void> => { const problem = endProblem(serviceProcess, await endRecorded(systemTools, serviceProcess, 10_000)); if (problem !== undefined) throw new Error(problem) }
  try { return { url: await within(address, 10_000, 'The fixture service gave no address.'), path, stop } }
  catch (error) { await stop(); throw error }
}

for (const platform of ['ios-simulator', 'macos'] as const) test(`${platform === 'macos' ? 'TaskDesk' : 'TaskPhone'}: owned stdout and declared network metadata retain identity, with honest absent sources`, { skip: platform === 'macos' ? macosSkip : iosSkip, timeout: 900_000 }, async (t) => {
  const folder = await mkdtemp(join(out, `diagnostics-${platform}-`)); t.diagnostic(`artifacts ${folder}`)
  const redactor = new Redactor(); for (const account of SEEDED_ACCOUNTS) redactor.learn(`fixture-${account.id}`, account.password)
  const events: EventBody[] = []
  const store = RunStore.create(join(folder, 'run'))
  const owner = { runId: 'native-diagnostics', testId: `native diagnostics ${platform}`, attemptId: 'diagnostics-attempt', app: platform === 'macos' ? 'desk' : 'phone' }
  const attempt = (): AttemptDiagnostics => new AttemptDiagnostics({ policy: defaultDiagnosticsPolicy, redactor, writeArtifact: (path, bytes) => store.writeArtifact(path, bytes), emit: (body) => events.push(body), testId: owner.testId, attemptId: owner.attemptId, variant: undefined, named: true })
  let runtime: IosSimulatorRuntime | undefined; let desktop: MacosDesktop | undefined; let session: NativeAppSession | undefined; let launched: LoggedNativeLaunch | undefined; let diagnostics: AttemptDiagnostics | undefined
  const server = await service(folder)
  try {
    const build = await executorBuild(platform === 'macos' ? 'mac2' : 'webdriveragent', folder)
    if (platform === 'ios-simulator') {
      const started = await IosSimulatorRuntime.start({ target: { appPath: taskPhoneApp, device: 'iPhone 17', runtime: '26.5' }, build, tools: systemTools, logFolder: folder, timeoutMs: 600_000 })
      if (!started.ok) throw new Error(started.failure.message); runtime = started.runtime
      const opened = await runtime.openSession({ owner, launch: { arguments: [], environment: {} }, redact: (text) => redactor.redact(text) }, 30_000)
      if (!opened.ok) throw new Error(opened.failure.message); session = opened.session
      const installed = await session.install({ appPath: taskPhoneApp }, 120_000); assert.equal(installed.result.ok, true)
    } else {
      const started = await MacosDesktop.start({ build, tools: systemTools, logFolder: folder, timeoutMs: 180_000 })
      if (!started.ok) throw new Error(started.failure.message); desktop = started.desktop
      const app = await desktop.openApp(taskDeskApp); if (!app.ok) throw new Error(app.failure.message)
      const opened = await app.runtime.openSession({ owner, launch: { arguments: [], environment: {} }, redact: (text) => redactor.redact(text) }, 30_000)
      if (!opened.ok) throw new Error(opened.failure.message); session = opened.session
    }
    diagnostics = attempt()
    const sources = await diagnostics.startNative(owner.app, session.identity, { path: server.path, client: platform === 'macos' ? 'macos' : 'ios' })
    launched = await launchLoggedNativeApp({ source: sources.logs, tools: systemTools, launch: { arguments: ['-reset', '-serviceURL', server.url, ...(platform === 'macos' ? ['-windowFrame', '20,60,640,480'] : [])], environment: {} }, timeoutMs: 30_000, target: platform === 'macos' ? { platform, executable: join(taskDeskApp, 'Contents', 'MacOS', 'TaskDesk') } : { platform, udid: runtime?.udid ?? '', bundleId: 'dev.retest.fixtures.taskphone', executable: 'TaskPhone' } })
    const client = platform === 'macos' ? 'macos' : 'ios'
    await within((async () => { for (;;) { const records = (await readFile(server.path, 'utf8')).split('\n').flatMap((line) => { const record = parseRequestRecord(line); return record === undefined ? [] : [record] }); if (records.some((record) => record.client === client && record.path === '/api/health')) return; await sleep(50) } })(), 15_000, 'The owned app made no health request.')
    // A server's completion precedes the client's stdout write. Do not terminate the app before that line arrives.
    const stdoutStarted = performance.now()
    while (sources.logs.entries === 0 && performance.now() - stdoutStarted < 15_000) await sleep(20)
    assert.ok(sources.logs.entries > 0, 'The owned app wrote no stdout request line.')
    // Traffic from another client must never enter this app's artifact.
    await fetch(new URL('/api/health', server.url), { headers: { 'x-task-client': platform === 'macos' ? 'ios' : 'macos' }, signal: AbortSignal.timeout(5000) })
    await launched.stop(); launched = undefined
    const result = await diagnostics.finishNative('attempt_ended')
    assert.equal(result.failure, undefined)
    const [summary] = result.summaries; assert.ok(summary?.path)
    assert.equal(summary.console.state, 'complete'); assert.equal(summary.network.state, 'complete')
    const text = await readFile(join(store.directory, summary.path), 'utf8')
    const parsed = parseArtifact(text, summary.path); assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
    const lines = parsed.lines; assert.ok(lines.some((line) => line.type === 'console' && /^GET \/api\/health 200 \d+ms$/.test(line.text.text)))
    const nativeLogs = lines.filter((line) => line.type === 'console'); assert.ok(nativeLogs.length > 0)
    assert.ok(nativeLogs.every((line) => line.processId !== undefined && line.origin === 'native' && line.source === (platform === 'macos' ? 'macos-stdout' : 'simctl-stdout')))
    const requests = lines.filter((line) => line.type === 'network.request'); assert.ok(requests.length > 0); assert.ok(requests.every((line) => line.client === client && line.source === 'app-network-file' && line.url === '/api/health'))
    for (const line of lines) assert.deepEqual([line.testId, line.attemptId, line.app, line.sessionId], [owner.testId, owner.attemptId, owner.app, session.identity.sessionId])
    for (const account of SEEDED_ACCOUNTS) assert.equal(text.includes(account.password), false)
    assert.equal(/authorization|cookie|Bearer|"headers"|"body"/i.test(text), false)
    const report = diagnosticsCardLines(result.summaries, store.directory); assert.ok(report[0]?.value.includes('app log'))
    store.writeArtifact('diagnostics-summary.json', Buffer.from(JSON.stringify({ result, report, events }, null, 2)))
    const absentStore = RunStore.create(join(folder, 'no-source'))
    const absent = new AttemptDiagnostics({ policy: defaultDiagnosticsPolicy, redactor, writeArtifact: (path, bytes) => absentStore.writeArtifact(path, bytes), emit: () => undefined, testId: owner.testId, attemptId: owner.attemptId, variant: undefined, named: true })
    await absent.startNative(owner.app, session.identity)
    const absentResult = await absent.finishNative('attempt_ended')
    assert.deepEqual(absentResult.summaries[0]?.network, { state: 'unavailable', reason: 'the app provides no network source' }); absentStore.close()
    const missingStore = RunStore.create(join(folder, 'missing-source'))
    const missing = new AttemptDiagnostics({ policy: defaultDiagnosticsPolicy, redactor, writeArtifact: (path, bytes) => missingStore.writeArtifact(path, bytes), emit: () => undefined, testId: owner.testId, attemptId: owner.attemptId, variant: undefined, named: true })
    await missing.startNative(owner.app, session.identity, { path: join(folder, 'does-not-exist'), client })
    const missingResult = await missing.finishNative('attempt_ended'); assert.deepEqual(missingResult.summaries[0]?.network, { state: 'unavailable', reason: 'the declared network file is missing' }); missingStore.close()
    const persisted = await readFile(server.path, 'utf8'); for (const account of SEEDED_ACCOUNTS) assert.equal(persisted.includes(account.password), false)
  } finally {
    try { await launched?.stop() } finally {
      await diagnostics?.finishNative('attempt_ended')
      try { await session?.dispose(60_000) } finally {
        try { await runtime?.close(180_000); await desktop?.close(60_000) } finally { await server.stop(); store.close() }
      }
    }
  }
})
