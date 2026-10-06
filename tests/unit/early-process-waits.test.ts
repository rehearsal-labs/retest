import type { ExecutorBuild } from '../../src/native/executors.ts'
import type { OwnedProcessIdentity } from '../../src/shared/process-ownership.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { FirefoxProcess } from '../../src/browser/firefox/process.ts'
import { freePort, startExecutor } from '../../src/native/executor-process.ts'
import { OwnedProcess } from '../../src/native/processes.ts'
import { ExecutorClient } from '../../src/native/webdriver-client.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { earlyClock, fullBudget } from './early-waits-clock.ts'
import { fakeTools, startedProcesses } from './native-fake-tools.ts'
import { alive } from './native-fake-executor.ts'
import { tempFolder } from '../support/temp-folder.ts'

// No Firefox process is started. The fake ownership system never sends an OS signal.
test('Firefox Remote Agent readiness sends the final address probe after early timers', async (t) => {
  const folder = tempFolder('firefox-wait-')
  const startedAt = 'Mon Oct  5 10:00:00 2026'
  const entry: OwnedProcessIdentity = { pid: 4242, parentPid: 1, groupId: 4242, startedAt, command: '/fake/firefox', state: 'S' }
  const launchd: OwnedProcessIdentity = { ...entry, pid: 1, parentPid: 0, groupId: 1, command: '/sbin/launchd' }
  let alive = true
  const entries = () => [launchd, ...(alive ? [entry] : [])]
  const ownership = new OwnedProcessGroup(4242, 1, { read: entries, readProcess: (pid) => entries().find((item) => item.pid === pid), signal: () => { alive = false } })
  assert.deepEqual(ownership.capture(), [])
  const firefox = new FirefoxProcess({ pid: 4242, route: 'launch-services', folder, profile: join(folder, 'profile'), ownership, child: undefined, output: Promise.resolve([]), table: { readAsync: async () => entries(), watchAsync: async () => entries() }, startedAt })
  const clock = earlyClock(t); const probes: number[] = []
  const original = fs.readFile
  t.mock.method(fs, 'readFile', async (file: Parameters<typeof fs.readFile>[0], encoding?: 'utf8'): Promise<string | Buffer> => {
    if (file === join(folder, 'profile', 'WebDriverBiDiServer.json')) {
      probes.push(clock.now()); clock.spend()
      return probes.at(-1)! >= 120 ? JSON.stringify({ ws_host: '127.0.0.1', ws_port: 9999 }) : '{}'
    }
    return encoding === 'utf8' ? original(file, 'utf8') : original(file)
  })
  syncBuiltinESMExports()
  try {
    const result = await clock.run(firefox.waitForAddress(new Deadline(120)))
    assert.equal(result, 'ws://127.0.0.1:9999')
    fullBudget(probes, clock.now())
  } finally {
    alive = false; firefox.expectExit(); await clock.run(firefox.stop(0))
    t.mock.restoreAll(); syncBuiltinESMExports()
  }
})

test('native executor readiness sends its final status probe after early timers', async (t) => {
  const fake = await fakeTools(t)
  await fake.configure({ executorStart: 'runner-not-ready' })
  const products = join(fake.root, 'derived', 'Build', 'Products')
  await fs.mkdir(join(products, 'Debug'), { recursive: true })
  const xctestrun = join(products, 'WebDriverAgentRunner_macosx26.5-arm64.xctestrun')
  await fs.writeFile(xctestrun, 'fake test run')
  const build: ExecutorBuild = { schemaVersion: 1, executor: 'mac2', version: '4.3.6', commit: 'f38257191fa9f273a684f6a9c8c2b16d1272bd09', key: 'k', xcode: { version: '26.5', build: '17F42' }, sdk: 'macosx26.5', architecture: 'arm64', origin: 'adopted', derivedDataPath: join(fake.root, 'derived'), xctestrun, products: join(products, 'Debug'), productsSha256: 'p', xctestrunSha256: 'x', recordedAt: new Date().toISOString(), licenses: [], notices: [] }
  const port = await freePort()
  const hostTimer = setTimeout
  const clock = earlyClock(t, 120); const probes: number[] = []
  let cleanup = false
  const cleanupStarted = Promise.withResolvers<void>()
  const resumeCleanup = Promise.withResolvers<void>()
  const originalStop = OwnedProcess.prototype.stop
  t.mock.method(OwnedProcess.prototype, 'stop', async function (this: OwnedProcess, graceMs: number) {
    cleanup = true
    cleanupStarted.resolve()
    await resumeCleanup.promise
    return originalStop.call(this, graceMs)
  })
  // Startup filesystem and process discovery settle without spending this fake clock. Once probing begins,
  // early timers advance it, so the test measures the readiness loop rather than host startup cost.
  t.mock.method(ExecutorClient.prototype, 'status', async () => {
    probes.push(clock.now()); clock.spend()
    return { status: 'answered', value: { ready: false, os: undefined }, durationMs: 0 }
  })
  const starting = startExecutor({ executor: 'mac2', build, destination: 'platform=macOS,arch=arm64', port, environment: {}, logFile: join(fake.root, 'executor.log'), resultFolder: join(fake.root, 'result'), tools: fake.tools, bounds: { timeoutMs: 120 }, isRunnerApp: (command) => command.includes('WebDriverAgentRunner-Runner'), tie: 'command' })
  try {
    await clock.run(Promise.race([starting, cleanupStarted.promise]), () => probes.length > 0 && clock.now() < 120, () => new Promise<void>(resolve => hostTimer(resolve, 1)))
  } finally {
    // Ownership cleanup talks to a worker with its own real monotonic clock. Only readiness uses early timers.
    clock.restore()
    resumeCleanup.resolve()
  }
  const result = await starting
  assert.ok(cleanup, `the failed readiness start awaited owned-process cleanup: ${JSON.stringify(result)}`)
  assert.ok(!result.ok && result.failure.class === 'setup_failed', JSON.stringify(result))
  assert.match(result.failure.message, /did not answer \/status within 120 ms/)
  assert.ok((probes.at(-1) ?? -1) >= 120, `last probe at ${probes.at(-1)}: ${probes.join(', ')}`)
  assert.ok((probes.at(-1) ?? Infinity) < 122, 'the final readiness probe is bounded')
  // Cleanup has a separate bound and is not part of readiness's final status read.
  assert.deepEqual((await startedProcesses(fake.root)).filter(alive), [], 'all owned fake processes ended')
  assert.deepEqual(result.leftRunning, [])
  assert.equal(result.failure.details?.['also'], undefined, 'owned-process cleanup reported no failure')
})
