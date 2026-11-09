import assert from 'node:assert/strict'
import { access, cp, mkdir, mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdDecompressSync } from 'node:zlib'
import { SEEDED_ACCOUNTS } from '../../fixtures/cross-platform/service/accounts.ts'
import { startTaskService } from '../../fixtures/cross-platform/service/task-service.ts'
import { agentDeviceVersion, loadAgentDevice } from '../../src/native/agent-device/package.ts'
import { listSimulatorRuntimes, listSimulators } from '../../src/native/ios-simulator.ts'
import { runCommand, systemTools } from '../../src/native/processes.ts'
import { rebuildRecordedResult } from '../../src/store/rebuild-result.ts'
import { budgets, filesHolding, repositoryRoot, runProject, testNamed, writeProject } from './cli-harness.ts'
import { processesWith, taskPhoneApp } from './native-harness.ts'

// TaskPhone on an iPhone simulator, driven through agent-device, through Retest's public test API and its CLI: a
// secret sign-in, a task created and checked, and a check that fails on what the app shows. The run creates its own
// simulators and deletes them; afterwards no simulator it made, no process naming one, and no state folder of
// agent-device's is left, and the password is in no file the run kept or agent-device's runner wrote while it ran.

const unverified = await agentDeviceSkipReason()

test('TaskPhone through agent-device: secret sign-in, a created task, a preserved failure and a clean end', { skip: unverified }, async (t) => {
  const startedAt = Date.now()
  const service = await startTaskService({ port: 0, syncDelayMs: 100, printLine: () => undefined })
  t.after(() => service.close())
  const account = SEEDED_ACCOUNTS.find((entry) => entry.id === 'ada')
  assert.ok(account !== undefined)
  const simulatorsBefore = await simulatorIds()
  const foldersBefore = await stateFolders()
  const source = await readFile(join(repositoryRoot, 'fixtures/cross-platform/tests/agent-device-phone.retest.ts'), 'utf8')
  const root = await writeProject(t, {
    'phone.retest.ts': source,
    'retest.config.ts': `import { defineConfig, env } from '@rehearsal-labs/retest'
export default defineConfig({ apps: { phone: { platform: 'ios-simulator', driver: 'agent-device', appPath: ${JSON.stringify(taskPhoneApp)}, device: 'iPhone 17', runtime: '26.5', arguments: ['-reset', '-serviceURL', ${JSON.stringify(service.url)}] } }, secrets: { password: env('RETEST_AGENT_DEVICE_PASSWORD') }, secretOrigins: { password: ['dev.retest.fixtures.taskphone'] } })
`,
  })
  const run = await runProject(t, root, { env: { RETEST_AGENT_DEVICE_PASSWORD: account.password }, timeouts: budgets({ setup: 240_000, action: 30_000, assertion: 15_000, test: 180_000, cleanup: 90_000 }), args: ['--workers', '1'] })
  const artifacts = join(homedir(), 'Library/Caches/retest-proofs/artifacts/agent-device-phone')
  await mkdir(artifacts, { recursive: true })
  const kept = await mkdtemp(join(artifacts, 'run-'))
  await cp(run.output, kept, { recursive: true })
  t.diagnostic(`artifacts: ${kept}`)

  assert.deepEqual(filesHolding(run.output, account.password), [], 'the password reached no file of the run')
  assert.ok(run.result !== undefined, run.stderr)
  assert.deepEqual(rebuildRecordedResult(run.events), run.result)
  const passed = testNamed(run, 'TaskPhone through agent-device signs in with a secret, creates a task and checks it')
  assert.equal(passed.status, 'passed', passed.failure?.message)
  const failed = testNamed(run, 'TaskPhone through agent-device preserves a wrong task state failure')
  assert.equal(failed.failure?.class, 'check_failed', failed.failure?.message)
  assert.match(failed.failure?.message ?? '', /created-task-state.*Open|Open.*created-task-state/s)
  assert.equal(run.exit.code, 1)

  // The failure kept a screenshot of the simulator's display, a PNG in the run folder.
  const screenshot = failed.evidence.find((item) => item.kind === 'screenshot')
  assert.ok(screenshot !== undefined, 'the failed test kept a screenshot')
  assert.equal(screenshot.source, 'simulator-display')
  const png = await readFile(join(run.output, screenshot.path))
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'the screenshot is a PNG')

  // Each test's session names what ran: the app, the simulator, agent-device at the checked version and the Xcode.
  const xcode = await installedXcode()
  const started = run.events.filter((event) => event.type === 'native.started')
  assert.equal(started.length, 2)
  const created: string[] = []
  for (const event of started) {
    assert.equal(event.identity.platform, 'ios-simulator')
    assert.equal(event.identity.app.bundleId, 'dev.retest.fixtures.taskphone')
    assert.match(event.identity.app.sha256, /^[0-9a-f]{64}$/)
    assert.deepEqual([event.identity.os.name, event.identity.os.version], ['iOS', '26.5'])
    assert.equal(event.identity.device?.type, 'iPhone 17')
    assert.deepEqual(event.identity.executor, { name: 'agent-device', version: agentDeviceVersion, package: 'agent-device' })
    assert.deepEqual(event.identity.xcode, xcode)
    if (event.identity.device !== undefined) created.push(event.identity.device.udid)
  }
  const ended = run.events.filter((event) => event.type === 'native.ended')
  assert.equal(ended.length, 2)
  for (const event of ended) assert.deepEqual(event.unknownOutcomes, [], 'every input was answered')
  assert.equal(run.events.filter((event) => event.type === 'lease.expired').length, 0)

  // The secret fill is recorded by the secret's name, typed into a secure field whose masked read-back matched.
  const fills = run.events.filter((event) => event.type === 'action.completed' && event.command === 'fill' && 'secret' in event && event.secret === 'password')
  assert.equal(fills.length, 2, 'each test typed the password once')
  const entries = run.events.filter((event) => event.type === 'capture.native_entry')
  assert.equal(entries.length, 2)
  for (const entry of entries) assert.equal(entry.type === 'capture.native_entry' ? entry.nativeField : undefined, 'secure')
  assert.equal(run.events.filter((event) => event.type === 'capture.masked_entry').length, 2)

  // Nothing the run made is left: its simulators, any process naming them, agent-device's state folders.
  const simulatorsAfter = await simulatorIds()
  for (const udid of created) {
    assert.equal(simulatorsBefore.has(udid), false, 'the run made its own simulator')
    assert.equal(simulatorsAfter.has(udid), false, `the simulator ${udid} was deleted`)
    assert.deepEqual(await processesWith(udid), [], `no process names the simulator ${udid}`)
  }
  assert.deepEqual([...(await stateFolders())].filter((folder) => !foldersBefore.has(folder)), [], "agent-device's state folders were removed")

  // agent-device's runner keeps its build and XCTest's result bundles in its own cache; none it wrote holds the password.
  assert.deepEqual(await runnerFilesHolding(startedAt, account.password), [], "the password is in no file agent-device's runner wrote during the run")
})

async function agentDeviceSkipReason(): Promise<string | undefined> {
  if (process.platform !== 'darwin') return 'needs macOS with Xcode'
  const version = await runCommand(systemTools.xcodebuild, ['-version'], { timeoutMs: 30_000 })
  if (!version.started || version.code !== 0) return 'Xcode is not installed'
  const loaded = await loadAgentDevice()
  if (!loaded.ok) return loaded.failure.message
  const missing = await access(taskPhoneApp).then(() => false, () => true)
  if (missing) return `${taskPhoneApp} is missing`
  const runtimes = await listSimulatorRuntimes(systemTools, { timeoutMs: 30_000 })
  if (!Array.isArray(runtimes)) throw new Error(`Retest could not read the installed simulator runtimes: ${runtimes.message}`)
  if (!runtimes.some((runtime) => runtime.version === '26.5' && runtime.build === '23F77')) return 'the iOS 26.5 (23F77) simulator runtime is not installed'
  return undefined
}

async function installedXcode(): Promise<{ readonly version: string; readonly build: string }> {
  const result = await runCommand(systemTools.xcodebuild, ['-version'], { timeoutMs: 30_000 })
  const version = /^Xcode (\S+)/m.exec(result.stdout)?.[1]
  const build = /^Build version (\S+)/m.exec(result.stdout)?.[1]
  assert.ok(version !== undefined && build !== undefined, result.stdout)
  return { version, build }
}

async function simulatorIds(): Promise<Set<string>> {
  const listed = await listSimulators(systemTools, { timeoutMs: 30_000 })
  if (!Array.isArray(listed)) throw new Error(listed.message)
  return new Set(listed.map((device) => device.udid))
}

async function stateFolders(): Promise<Set<string>> {
  return new Set((await readdir(tmpdir())).filter((name) => name.startsWith('retest-agent-device-')))
}

// Files under agent-device's runner cache changed since `since`, read as written and, for XCTest's compressed result
// bundle records, decompressed, that hold `value`.
async function runnerFilesHolding(since: number, value: string): Promise<string[]> {
  const root = join(homedir(), '.agent-device', 'apple-runner')
  const needle = Buffer.from(value)
  const holding: string[] = []
  const walk = async (folder: string): Promise<void> => {
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) {
        await walk(path)
        continue
      }
      if (!entry.isFile() || (await stat(path)).mtimeMs < since) continue
      const bytes = await readFile(path)
      if (bytes.includes(needle)) holding.push(path)
      else {
        try {
          if (zstdDecompressSync(bytes).includes(needle)) holding.push(path)
        } catch {
          // Not a compressed record.
        }
      }
    }
  }
  await walk(root)
  return holding
}
