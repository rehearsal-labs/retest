import type { Durations, Inventory, TestJob } from '../../scripts/ci/test-plan.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertCoverage, defaultShardTargets, discoverTests, fastFileLimitSeconds, makeTestPlan, nativeIntegrationFiles } from '../../scripts/ci/test-plan.ts'
import recordedDurations from '../../scripts/ci/test-durations.json' with { type: 'json' }

const inventory: Inventory = {
  unit: ['tests/unit/alpha.test.ts', 'tests/unit/bravo.test.ts', 'tests/unit/charlie.test.ts', 'tests/unit/delta.test.ts', 'tests/unit/echo.test.ts'],
  integration: ['tests/integration/browser-state.test.ts', 'tests/integration/browser-actions.test.ts', 'tests/integration/evidence-flows.test.ts', 'tests/integration/native-api-phone.test.ts'],
}

/**
 * The seconds a file of a job should be planned at: the job's platform's own time, else one second for a native file on
 * Linux, where it only checks its skips, else the largest time any platform has, else the default.
 */
function plannedSeconds(job: TestJob, file: string, durations: Durations): number {
  const own = durations[file]?.[job.platform]
  if (own !== undefined) return own
  if (job.platform !== 'macos-arm64' && job.lane !== 'unit' && nativeIntegrationFiles.includes(file)) return 1
  const elsewhere = Object.values(durations[file] ?? {})
  return elsewhere.length > 0 ? Math.max(...elsewhere) : job.lane === 'unit' ? 1 : 20
}

/** Every job of one lane on one platform, with the lane's largest file. */
function lanes(jobs: readonly TestJob[], durations: Durations): { jobs: TestJob[]; largest: number; total: number }[] {
  const groups = new Map<string, TestJob[]>()
  for (const job of jobs) groups.set(`${job.platform} ${job.lane}`, [...(groups.get(`${job.platform} ${job.lane}`) ?? []), job])
  return [...groups.values()].map((group) => {
    const seconds = group.flatMap((job) => job.files.map((file) => plannedSeconds(job, file, durations)))
    return { jobs: group, largest: Math.max(...seconds), total: seconds.reduce((sum, value) => sum + value, 0) }
  })
}

/** macOS times only, as the older tests below give them; every other platform falls back to them. */
function onMacos(seconds: Readonly<Record<string, number>>): Durations {
  return Object.fromEntries(Object.entries(seconds).map(([file, value]) => [file, { 'macos-arm64': value }]))
}

/** A deterministic sequence of durations, so a failure names the case that made it. */
function durationsFor(files: readonly string[], seed: number): Record<string, number> {
  let state = seed
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648
    return state / 2147483648
  }
  // Mostly short files with a few long ones, as the real suites are.
  return Object.fromEntries(files.map((file) => [file, 1 + Math.floor(next() * (next() < 0.1 ? 600 : 60))]))
}

test('a full plan covers every checked test file exactly once on each platform, including native files on Linux', () => {
  const actual = discoverTests(process.cwd())
  const plan = makeTestPlan({ inventory: actual, scope: 'all', platform: 'all', files: [] })
  assert.equal(plan.full, true)
  assert.equal(plan.checks.length, 3)
  for (const platform of ['linux-x64', 'linux-arm64', 'macos-arm64']) {
    assertCoverage(actual.unit, plan.unit.filter((job) => job.platform === platform).flatMap((job) => job.files))
    assertCoverage(actual.integration, [...plan.linux, ...plan.macos].filter((job) => job.platform === platform).flatMap((job) => job.files))
  }
  assert.ok(plan.macos.filter((job) => job.lane === 'web').every((job) => job.files.every((file) => !nativeIntegrationFiles.includes(file))))
  assert.ok(plan.macos.filter((job) => job.lane === 'native').every((job) => job.files.every((file) => nativeIntegrationFiles.includes(file))))
})

test('the recorded durations give every shard of the full plan at most its target plus its lane\'s largest file', () => {
  const plan = makeTestPlan({ inventory: discoverTests(process.cwd()), scope: 'all', platform: 'all', files: [] })
  for (const lane of lanes([...plan.unit, ...plan.linux, ...plan.macos], recordedDurations)) {
    const target = lane.jobs[0]?.targetSeconds ?? 0
    assert.equal(lane.jobs.length, Math.max(1, Math.ceil(lane.total / target)), `${lane.jobs[0]?.platform} ${lane.jobs[0]?.lane}`)
    for (const job of lane.jobs) {
      assert.equal(job.total, lane.jobs.length)
      assert.ok(job.estimatedSeconds <= job.targetSeconds + lane.largest, `${job.platform} ${job.lane} ${job.shard}: ${job.estimatedSeconds} s`)
    }
  }
  assert.deepEqual(new Set(plan.macos.map((job) => job.targetSeconds)), new Set([defaultShardTargets.macosWeb, defaultShardTargets.macosNative]))
  assert.deepEqual(new Set(plan.linux.map((job) => job.targetSeconds)), new Set([defaultShardTargets.linuxWeb]))
  assert.deepEqual(new Set(plan.unit.map((job) => job.targetSeconds)), new Set([defaultShardTargets.unit]))
})

test('each platform weighs a file by its own time, then by the largest time elsewhere, then by the default', () => {
  const durations: Durations = {
    'tests/integration/browser-state.test.ts': { 'macos-arm64': 300, 'linux-x64': 30, 'linux-arm64': 40 },
    'tests/integration/browser-actions.test.ts': { 'macos-arm64': 90, 'linux-arm64': 70 },
    'tests/integration/evidence-flows.test.ts': { 'macos-arm64': 200 },
    'tests/integration/native-api-phone.test.ts': { 'macos-arm64': 50, 'linux-x64': 5 },
  }
  const plan = makeTestPlan({ inventory, scope: 'integration', platform: 'all', files: [], durations })
  const estimate = (platform: string, lane: string): number => [...plan.linux, ...plan.macos].filter((job) => job.platform === platform && job.lane === lane).reduce((sum, job) => sum + job.estimatedSeconds, 0)
  // linux-x64: its own 30 and 5, browser-actions' largest elsewhere 90, and 1 for a native file it has no time for.
  assert.equal(estimate('linux-x64', 'web'), 30 + 90 + 1 + 5)
  assert.equal(estimate('linux-arm64', 'web'), 40 + 70 + 1 + 1)
  assert.equal(estimate('macos-arm64', 'web'), 300 + 90)
  assert.equal(estimate('macos-arm64', 'native'), 200 + 50)
  const unmeasured = makeTestPlan({ inventory, scope: 'all', platform: 'linux-x64', files: [], durations: {} })
  assert.equal(unmeasured.unit.reduce((sum, job) => sum + job.estimatedSeconds, 0), inventory.unit.length)
  assert.equal(unmeasured.linux.reduce((sum, job) => sum + job.estimatedSeconds, 0), 20 + 20 + 1 + 1)
})

test('a shard never exceeds its target by more than the single largest file, whatever the durations and the target', () => {
  const files = Array.from({ length: 60 }, (_, index) => `tests/integration/file-${String(index).padStart(2, '0')}.test.ts`)
  const many: Inventory = { unit: ['tests/unit/alpha.test.ts'], integration: files }
  for (let seed = 1; seed <= 40; seed += 1) {
    const seconds = durationsFor(files, seed)
    for (const macosWeb of [30, 90, 200, 360, 1000, 100000]) {
      const plan = makeTestPlan({ inventory: many, scope: 'integration', platform: 'macos-arm64', files: [], durations: onMacos(seconds), targets: { macosWeb } })
      const total = files.reduce((sum, file) => sum + (seconds[file] ?? 0), 0)
      const largest = Math.max(...files.map((file) => seconds[file] ?? 0))
      assert.equal(plan.macos.length, Math.min(files.length, Math.max(1, Math.ceil(total / macosWeb))), `seed ${seed}, target ${macosWeb}`)
      for (const job of plan.macos) assert.ok(job.estimatedSeconds <= macosWeb + largest, `seed ${seed}, target ${macosWeb}: shard ${job.shard} ${job.estimatedSeconds} s`)
      assertCoverage(files, plan.macos.flatMap((job) => job.files))
    }
  }
})

test('a change in durations changes the shard count, and a lane with less than one target of work gets one shard', () => {
  const seconds = { 'tests/integration/browser-state.test.ts': 100, 'tests/integration/browser-actions.test.ts': 100, 'tests/integration/evidence-flows.test.ts': 300, 'tests/integration/native-api-phone.test.ts': 200 }
  const options = { inventory, scope: 'integration', platform: 'all', files: [], durations: onMacos(seconds) } as const
  const before = makeTestPlan(options)
  assert.deepEqual(before.macos.map((job) => [job.lane, job.shard, job.total]), [['web', 1, 1], ['native', 1, 2], ['native', 2, 2]])
  assert.equal(before.linux.filter((job) => job.platform === 'linux-x64').length, 1)
  const slower = makeTestPlan({ ...options, durations: onMacos({ ...seconds, 'tests/integration/browser-state.test.ts': 290 }) })
  assert.deepEqual(slower.macos.filter((job) => job.lane === 'web').map((job) => job.estimatedSeconds), [290, 100])
  assert.equal(slower.linux.filter((job) => job.platform === 'linux-x64').length, 2)
  const fasterOnLinux = makeTestPlan({ ...options, durations: { ...onMacos({ ...seconds, 'tests/integration/browser-state.test.ts': 290 }), 'tests/integration/browser-state.test.ts': { 'macos-arm64': 290, 'linux-x64': 100 } } })
  assert.equal(fasterOnLinux.linux.filter((job) => job.platform === 'linux-x64').length, 1)
  assert.equal(fasterOnLinux.linux.filter((job) => job.platform === 'linux-arm64').length, 2)
  const quicker = makeTestPlan({ ...options, durations: onMacos({ ...seconds, 'tests/integration/evidence-flows.test.ts': 10, 'tests/integration/native-api-phone.test.ts': 10 }) })
  assert.deepEqual(quicker.macos.filter((job) => job.lane === 'native').map((job) => job.files), [['tests/integration/evidence-flows.test.ts', 'tests/integration/native-api-phone.test.ts']])
})

test('coverage checking refuses omitted, duplicate and unexpected test files', () => {
  assert.throws(() => assertCoverage(inventory.unit, inventory.unit.slice(1)), /omits or adds/)
  assert.throws(() => assertCoverage(inventory.unit, [...inventory.unit, inventory.unit[0] ?? '']), /more than once/)
  assert.throws(() => assertCoverage(inventory.unit, [...inventory.unit.slice(1), 'tests/unit/unexpected.test.ts']), /omits or adds/)
})

test('focused Linux debugging selects only the named file and cannot claim release coverage', () => {
  const plan = makeTestPlan({ inventory, scope: 'integration', platform: 'linux-x64', files: ['tests/integration/browser-state.test.ts'], durations: {} })
  assert.equal(plan.full, false)
  assert.equal(plan.checks.length, 1)
  assert.equal(plan.unit.length, 0)
  assert.equal(plan.macos.length, 0)
  assert.equal(plan.linux.length, 1)
  assert.deepEqual(plan.linux[0]?.files, ['tests/integration/browser-state.test.ts'])
})

test('selection refuses missing, duplicate, traversal and wrong-suite paths before creating jobs', () => {
  for (const files of [['tests/integration/missing.test.ts'], ['../tests/integration/browser-state.test.ts'], ['tests/integration/browser-state.test.ts', 'tests/integration/browser-state.test.ts'], ['tests/unit/alpha.test.ts']]) {
    assert.throws(() => makeTestPlan({ inventory, scope: 'integration', platform: 'all', files, durations: {} }))
  }
  assert.throws(() => makeTestPlan({ inventory, scope: 'all', platform: 'all', files: ['tests/integration/browser-state.test.ts'] }), /Choose unit or integration/)
  assert.throws(() => makeTestPlan({ inventory, scope: 'fast', platform: 'all', files: ['tests/integration/browser-state.test.ts'] }), /Choose unit or integration/)
})

test('duration balancing separates long files, is deterministic and assigns newly added files', () => {
  const durations = onMacos({ 'tests/unit/alpha.test.ts': 100, 'tests/unit/bravo.test.ts': 90, 'tests/unit/charlie.test.ts': 80, 'tests/unit/delta.test.ts': 70 })
  const options = { inventory, scope: 'unit', platform: 'macos-arm64', files: [], durations, targets: { unit: 100 } } as const
  const plan = makeTestPlan(options)
  assert.equal(plan.unit.length, 4)
  assert.deepEqual(plan.unit.map((job) => job.estimatedSeconds), [100, 90, 80, 71])
  assertCoverage(inventory.unit, plan.unit.flatMap((job) => job.files))
  assert.deepEqual(makeTestPlan({ ...options, inventory: { unit: [...inventory.unit].reverse(), integration: [...inventory.integration].reverse() } }), plan)
  assert.deepEqual(makeTestPlan({ ...options, targets: {} }).unit.map((job) => job.estimatedSeconds), [100, 91, 150])
  for (const value of [Infinity, 0, -1]) assert.throws(() => makeTestPlan({ ...options, durations: { 'tests/unit/alpha.test.ts': { 'linux-x64': value } } }), /finite/)
  for (const unit of [0, -1, Infinity, Number.NaN]) assert.throws(() => makeTestPlan({ ...options, targets: { unit } }), /Shard targets/)
})

test('the fast suite runs checks and unit files on the selected platforms, and only short integration files, on macOS', () => {
  const durations: Durations = {
    'tests/integration/browser-state.test.ts': { 'macos-arm64': fastFileLimitSeconds - 1, 'linux-x64': 5 },
    'tests/integration/browser-actions.test.ts': { 'macos-arm64': fastFileLimitSeconds, 'linux-x64': 5 },
    'tests/integration/evidence-flows.test.ts': { 'macos-arm64': 2 },
  }
  const plan = makeTestPlan({ inventory, scope: 'fast', platform: 'all', files: [], durations })
  assert.equal(plan.full, false)
  assert.equal(plan.checks.length, 3)
  for (const platform of ['linux-x64', 'linux-arm64', 'macos-arm64']) assertCoverage(inventory.unit, plan.unit.filter((job) => job.platform === platform).flatMap((job) => job.files))
  assert.deepEqual(plan.linux, [])
  // The fast suite judges a file by its macOS time, however short it is on Linux.
  assert.deepEqual(plan.macos.filter((job) => job.lane === 'web').flatMap((job) => job.files), ['tests/integration/browser-state.test.ts'])
  // A file no run has timed yet counts its default twenty seconds, so a new file is in the fast suite.
  assert.deepEqual(plan.macos.filter((job) => job.lane === 'native').flatMap((job) => job.files), ['tests/integration/evidence-flows.test.ts', 'tests/integration/native-api-phone.test.ts'])
  const linuxOnly = makeTestPlan({ inventory, scope: 'fast', platform: 'linux-x64', files: [], durations })
  assert.deepEqual([linuxOnly.checks.length, linuxOnly.unit.length > 0, linuxOnly.linux.length, linuxOnly.macos.length], [1, true, 0, 0])
})

test('checks-only mode creates no test jobs and partial suites remain focused', () => {
  const plan = makeTestPlan({ inventory, scope: 'checks', platform: 'all', files: [] })
  assert.equal(plan.full, false)
  assert.equal(plan.checks.length, 3)
  assert.deepEqual([...plan.unit, ...plan.linux, ...plan.macos], [])
  assert.equal(makeTestPlan({ inventory, scope: 'integration', platform: 'all', files: [] }).full, false)
  assert.equal(makeTestPlan({ inventory, scope: 'unit', platform: 'all', files: [] }).full, false)
})
