import type { TestContext } from 'node:test'
import type { Inventory } from '../../scripts/ci/test-plan.ts'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describeMissing, formatDurations, platformOfArtifact, readDurations, readShardResults, refreshDurations } from '../../scripts/ci/measured-durations.ts'

const execute = promisify(execFile)
const refresher = fileURLToPath(new URL('../../scripts/ci/refresh-durations.ts', import.meta.url))

const inventory: Inventory = {
  unit: ['tests/unit/alpha.test.ts', 'tests/unit/bravo.test.ts'],
  integration: ['tests/integration/browser-state.test.ts', 'tests/integration/conformance-chrome.test.ts'],
}

type Run = { file: string; durationMs: number; exitCode?: number | null; signal?: string | null }

async function folder(context: TestContext): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'retest-ci-durations-'))
  context.after(() => rm(created, { recursive: true, force: true }))
  return created
}

/** A shard's results.json as scripts/ci/run-tests.ts writes it, in an artifact folder named as ci.yml names it. */
async function writeShard(root: string, name: string, runs: readonly Run[]): Promise<void> {
  await mkdir(join(root, name), { recursive: true })
  const files = runs.map((run) => ({ file: run.file, durationMs: run.durationMs, exitCode: run.exitCode === undefined ? 0 : run.exitCode, signal: run.signal ?? null }))
  const exitCode = files.some((file) => file.exitCode !== 0) ? 1 : 0
  await writeFile(join(root, name, 'results.json'), `${JSON.stringify({ schemaVersion: 1, completed: true, exitCode, plannedFiles: runs.map((run) => run.file), files }, null, 2)}\n`)
}

/** One passing time for each file on each platform, given in seconds. */
async function writeEveryPlatform(root: string, seconds: Readonly<Record<string, number>>): Promise<void> {
  const runs = Object.entries(seconds).map(([file, value]) => ({ file, durationMs: value * 1000 }))
  for (const name of ['unit-macos-arm64-1-1', 'unit-linux-x64-1-1', 'unit-linux-arm64-1-1', 'unit-windows-x64-1-1']) await writeShard(root, name, runs)
}

test('the platform of a results file is read from the artifact name ci.yml gives it', () => {
  assert.equal(platformOfArtifact('unit-macos-arm64-3-1'), 'macos-arm64')
  assert.equal(platformOfArtifact('unit-linux-arm64-12-2'), 'linux-arm64')
  assert.equal(platformOfArtifact('integration-linux-x64-2-1'), 'linux-x64')
  assert.equal(platformOfArtifact('integration-macos-web-1-1'), 'macos-arm64')
  assert.equal(platformOfArtifact('integration-macos-native-1-3'), 'macos-arm64')
  assert.equal(platformOfArtifact('unit-windows-x64-2-1'), 'windows-x64')
  for (const name of ['chromium-ticker-web-2-1', 'integration-windows-x64-1-1', 'integration-macos-arm64-1-1', 'integration-linux-x64-1', 'results']) assert.equal(platformOfArtifact(name), undefined, name)
})

test('each file takes its slowest passing time on each platform, rounded up to whole seconds', async (context) => {
  const artifacts = await folder(context)
  await writeShard(artifacts, 'unit-linux-x64-1-1', [{ file: 'tests/unit/alpha.test.ts', durationMs: 900 }, { file: 'tests/unit/bravo.test.ts', durationMs: 4100 }])
  await writeShard(artifacts, 'unit-linux-x64-2-2', [{ file: 'tests/unit/alpha.test.ts', durationMs: 1500 }])
  await writeShard(artifacts, 'unit-macos-arm64-1-1', [{ file: 'tests/unit/alpha.test.ts', durationMs: 2001 }, { file: 'tests/unit/bravo.test.ts', durationMs: 3000 }])
  // A ticker artifact or any other JSON beside the results is not read.
  await mkdir(join(artifacts, 'chromium-ticker-web-2-1'), { recursive: true })
  await writeFile(join(artifacts, 'chromium-ticker-web-2-1', 'manifest.json'), '{"not":"results"}\n')
  const shards = readShardResults(artifacts)
  assert.equal(shards.results, 3)
  const refreshed = refreshDurations({ previous: { 'tests/unit/bravo.test.ts': { 'linux-arm64': 7 } }, measured: shards.files, named: shards.named, inventory })
  assert.deepEqual(refreshed.durations, {
    'tests/unit/alpha.test.ts': { 'macos-arm64': 3, 'linux-x64': 2 },
    'tests/unit/bravo.test.ts': { 'macos-arm64': 3, 'linux-x64': 5, 'linux-arm64': 7 },
  })
  assert.deepEqual(refreshed.measured, ['tests/unit/alpha.test.ts', 'tests/unit/bravo.test.ts'])
  assert.deepEqual(refreshed.missing, [{ file: 'tests/unit/alpha.test.ts', platforms: ['linux-arm64', 'windows-x64'] }, { file: 'tests/unit/bravo.test.ts', platforms: ['linux-arm64', 'windows-x64'] }])
})

test('a failing, killed or cut-off file gives no time, and keeps its earlier time on that platform', async (context) => {
  const artifacts = await folder(context)
  await writeShard(artifacts, 'integration-macos-web-1-1', [
    { file: 'tests/integration/browser-state.test.ts', durationMs: 67000, exitCode: 1 },
    { file: 'tests/unit/alpha.test.ts', durationMs: 90000, exitCode: null, signal: 'SIGTERM' },
    { file: 'tests/unit/bravo.test.ts', durationMs: 2000 },
  ])
  await writeShard(artifacts, 'integration-linux-x64-1-1', [{ file: 'tests/integration/browser-state.test.ts', durationMs: 6000 }])
  const shards = readShardResults(artifacts)
  assert.deepEqual(shards.files.map((each) => [each.file, each.platform]), [['tests/integration/browser-state.test.ts', 'linux-x64'], ['tests/unit/bravo.test.ts', 'macos-arm64']])
  assert.deepEqual(shards.named, ['tests/integration/browser-state.test.ts', 'tests/unit/alpha.test.ts', 'tests/unit/bravo.test.ts'])
  const refreshed = refreshDurations({ previous: { 'tests/integration/browser-state.test.ts': { 'macos-arm64': 21 } }, measured: shards.files, named: shards.named, inventory })
  assert.deepEqual(refreshed.durations, {
    'tests/integration/browser-state.test.ts': { 'macos-arm64': 21, 'linux-x64': 6 },
    'tests/unit/bravo.test.ts': { 'macos-arm64': 2 },
  })
  assert.deepEqual(refreshed.kept, [])
  assert.deepEqual(refreshed.missing.map((each) => each.file), ['tests/integration/browser-state.test.ts', 'tests/unit/alpha.test.ts', 'tests/unit/bravo.test.ts'])
  assert.deepEqual(refreshed.missing[1], { file: 'tests/unit/alpha.test.ts', platforms: ['macos-arm64', 'linux-x64', 'linux-arm64', 'windows-x64'] })
})

test('a file the repository no longer holds is dropped, and a file no artifact names keeps its earlier times', () => {
  const refreshed = refreshDurations({
    previous: { 'tests/integration/conformance.test.ts': { 'macos-arm64': 217 }, 'tests/integration/conformance-chrome.test.ts': { 'macos-arm64': 257, 'linux-x64': 45 } },
    measured: [{ file: 'tests/integration/conformance.test.ts', platform: 'macos-arm64', durationMs: 768304 }, { file: 'tests/unit/bravo.test.ts', platform: 'linux-x64', durationMs: 0 }],
    named: ['tests/integration/conformance.test.ts', 'tests/unit/bravo.test.ts'],
    inventory,
  })
  assert.deepEqual(refreshed.durations, { 'tests/integration/conformance-chrome.test.ts': { 'macos-arm64': 257, 'linux-x64': 45 }, 'tests/unit/bravo.test.ts': { 'linux-x64': 1 } })
  assert.deepEqual(refreshed.dropped, ['tests/integration/conformance.test.ts'])
  assert.deepEqual(refreshed.kept, ['tests/integration/conformance-chrome.test.ts'])
  assert.match(describeMissing(refreshed.missing), /^The artifacts have no passing time for 2 files on some platform: tests\/integration\/conformance-chrome\.test\.ts on macos-arm64, linux-x64, linux-arm64; tests\/unit\/bravo\.test\.ts on macos-arm64, linux-arm64, windows-x64\. .*--partial/)
})

test('results that are not what run-tests.ts writes, or whose folder names no platform, are refused by their path', async (context) => {
  for (const [name, document] of [
    ['unit-linux-x64-1-1', { schemaVersion: 1 }],
    ['unit-linux-x64-2-1', { schemaVersion: 2, files: [] }],
    ['unit-linux-x64-3-1', { schemaVersion: 1, files: [{ file: '../tests/unit/alpha.test.ts', durationMs: 1, exitCode: 0, signal: null }] }],
    ['unit-linux-x64-4-1', { schemaVersion: 1, files: [{ file: 'tests/unit/alpha.test.ts', durationMs: -1, exitCode: 0, signal: null }] }],
    ['unit-linux-x64-5-1', { schemaVersion: 1, files: [{ file: 'tests/unit/alpha.test.ts', durationMs: '1', exitCode: 0, signal: null }] }],
    ['unit-linux-x64-6-1', { schemaVersion: 1, files: [{ file: 'tests/unit/alpha.test.ts', durationMs: 1 }] }],
    ['downloaded', { schemaVersion: 1, files: [] }],
  ] as const) {
    const artifacts = await folder(context)
    await mkdir(join(artifacts, name))
    await writeFile(join(artifacts, name, 'results.json'), JSON.stringify(document))
    assert.throws(() => readShardResults(artifacts), new RegExp(`${name}/results\\.json`))
  }
  const empty = await folder(context)
  assert.throws(() => readShardResults(empty), /No results\.json/)
})

test('the durations file is written sorted by path with platforms in a fixed order, and read back only as positive seconds by platform', async (context) => {
  assert.equal(
    formatDurations({ 'tests/unit/bravo.test.ts': { 'linux-arm64': 3, 'macos-arm64': 2 }, 'tests/integration/browser-state.test.ts': { 'linux-x64': 9 } }),
    '{\n  "tests/integration/browser-state.test.ts": {\n    "linux-x64": 9\n  },\n  "tests/unit/bravo.test.ts": {\n    "macos-arm64": 2,\n    "linux-arm64": 3\n  }\n}\n',
  )
  const root = await folder(context)
  for (const document of ['[]', '{"tests/unit/alpha.test.ts":3}', '{"tests/unit/alpha.test.ts":{}}', '{"tests/unit/alpha.test.ts":{"linux-x64":0}}', '{"tests/unit/alpha.test.ts":{"freebsd-x64":3}}', '{"README.md":{"linux-x64":3}}']) {
    await writeFile(join(root, 'durations.json'), document)
    assert.throws(() => readDurations(join(root, 'durations.json')), document)
  }
  await writeFile(join(root, 'durations.json'), '{"tests/unit/alpha.test.ts":{"linux-x64":3}}')
  assert.deepEqual(readDurations(join(root, 'durations.json')), { 'tests/unit/alpha.test.ts': { 'linux-x64': 3 } })
})

test('the command refuses a run that misses a platform for some file, unless told the refresh is partial', async (context) => {
  const root = await folder(context)
  await mkdir(join(root, 'tests/unit'), { recursive: true })
  await mkdir(join(root, 'tests/integration'), { recursive: true })
  await mkdir(join(root, 'scripts/ci'), { recursive: true })
  for (const file of [...inventory.unit, ...inventory.integration]) await writeFile(join(root, file), '')
  const before = formatDurations({ 'tests/integration/conformance.test.ts': { 'macos-arm64': 217 }, 'tests/integration/conformance-chrome.test.ts': { 'macos-arm64': 257, 'linux-x64': 45, 'linux-arm64': 51 } })
  await writeFile(join(root, 'scripts/ci/test-durations.json'), before)
  const artifacts = join(root, 'artifacts')
  await writeShard(artifacts, 'integration-macos-web-1-1', [{ file: 'tests/integration/conformance.test.ts', durationMs: 768304 }, { file: 'tests/integration/browser-state.test.ts', durationMs: 61500 }])
  await writeShard(artifacts, 'integration-linux-x64-1-1', [{ file: 'tests/integration/browser-state.test.ts', durationMs: 20000 }])
  await writeShard(artifacts, 'integration-linux-arm64-1-1', [{ file: 'tests/integration/browser-state.test.ts', durationMs: 19000, exitCode: 1 }])
  await assert.rejects(execute(process.execPath, [refresher, 'artifacts'], { cwd: root, timeout: 10000 }), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error && 'stderr' in error)
    assert.equal(error.code, 1)
    assert.match(String(error.stderr), /no passing time for 2 files on some platform: tests\/integration\/browser-state\.test\.ts on linux-arm64; tests\/integration\/conformance-chrome\.test\.ts on macos-arm64, linux-x64, linux-arm64\..*Nothing was written\./)
    return true
  })
  assert.equal(await readFile(join(root, 'scripts/ci/test-durations.json'), 'utf8'), before)
  const result = await execute(process.execPath, [refresher, '--partial', 'artifacts'], { cwd: root, timeout: 10000 })
  assert.match(result.stdout, /Read 3 results files: 1 test files timed, 1 kept only their earlier times\./)
  assert.match(result.stdout, /Dropped tests\/integration\/conformance\.test\.ts: the repository no longer holds it\./)
  assert.equal(await readFile(join(root, 'scripts/ci/test-durations.json'), 'utf8'), formatDurations({
    'tests/integration/browser-state.test.ts': { 'macos-arm64': 62, 'linux-x64': 20 },
    'tests/integration/conformance-chrome.test.ts': { 'macos-arm64': 257, 'linux-x64': 45, 'linux-arm64': 51 },
  }))
  await writeEveryPlatform(join(root, 'complete'), { 'tests/integration/browser-state.test.ts': 30, 'tests/integration/conformance-chrome.test.ts': 40 })
  await execute(process.execPath, [refresher, 'complete'], { cwd: root, timeout: 10000 })
  assert.equal(await readFile(join(root, 'scripts/ci/test-durations.json'), 'utf8'), formatDurations({
    'tests/integration/browser-state.test.ts': { 'macos-arm64': 30, 'linux-x64': 30, 'linux-arm64': 30 },
    'tests/integration/conformance-chrome.test.ts': { 'macos-arm64': 40, 'linux-x64': 40, 'linux-arm64': 40 },
  }))
  await assert.rejects(execute(process.execPath, [refresher], { cwd: root, timeout: 10000 }), (error: unknown) => {
    assert.ok(error instanceof Error && 'code' in error)
    assert.equal(error.code, 2)
    return true
  })
})
