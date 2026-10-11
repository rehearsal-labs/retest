import type { Inventory, TestJob } from '../../scripts/ci/test-plan.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertCoverage, discoverTests, makeTestPlan, nativeIntegrationFiles } from '../../scripts/ci/test-plan.ts'

const inventory: Inventory = {
  unit: ['tests/unit/alpha.test.ts', 'tests/unit/bravo.test.ts', 'tests/unit/charlie.test.ts', 'tests/unit/delta.test.ts', 'tests/unit/echo.test.ts'],
  integration: ['tests/integration/browser-state.test.ts', 'tests/integration/browser-actions.test.ts', 'tests/integration/evidence-flows.test.ts', 'tests/integration/native-api-phone.test.ts'],
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
})

test('duration balancing separates long files, is deterministic and assigns newly added files', () => {
  const durations = { 'tests/unit/alpha.test.ts': 100, 'tests/unit/bravo.test.ts': 90, 'tests/unit/charlie.test.ts': 80, 'tests/unit/delta.test.ts': 70 }
  const options = { inventory, scope: 'unit', platform: 'macos-arm64', files: [], durations } as const
  const plan = makeTestPlan(options)
  assert.equal(plan.unit.length, 4)
  assert.deepEqual(plan.unit.map((job) => job.estimatedSeconds), [100, 90, 80, 71])
  assertCoverage(inventory.unit, plan.unit.flatMap((job) => job.files))
  assert.deepEqual(makeTestPlan({ ...options, inventory: { unit: [...inventory.unit].reverse(), integration: [...inventory.integration].reverse() } }), plan)
  assert.throws(() => makeTestPlan({ ...options, durations: { 'tests/unit/alpha.test.ts': Infinity } }), /finite/)
})

test('checks-only mode creates no test jobs and partial suites remain focused', () => {
  const plan = makeTestPlan({ inventory, scope: 'checks', platform: 'all', files: [] })
  assert.equal(plan.full, false)
  assert.equal(plan.checks.length, 3)
  assert.deepEqual([...plan.unit, ...plan.linux, ...plan.macos], [])
  const jobs: TestJob[] = makeTestPlan({ inventory, scope: 'integration', platform: 'all', files: [] }).macos
  assert.equal(jobs.filter((job) => job.lane === 'native').length, 2)
})
