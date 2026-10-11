import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import recordedDurations from './test-durations.json' with { type: 'json' }

export type Platform = 'linux-x64' | 'linux-arm64' | 'macos-arm64'
export type Scope = 'all' | 'checks' | 'unit' | 'integration'
export type Inventory = { unit: readonly string[]; integration: readonly string[] }
export type CheckJob = { platform: Platform; runner: string }
export type TestJob = CheckJob & { lane: 'unit' | 'web' | 'native'; shard: number; total: number; files: string[]; estimatedSeconds: number }
export type TestPlan = { full: boolean; checks: CheckJob[]; unit: TestJob[]; linux: TestJob[]; macos: TestJob[] }
export type PlanOptions = { inventory: Inventory; scope: Scope; platform: Platform | 'all'; files: readonly string[]; durations?: Readonly<Record<string, number>> }

const platforms: readonly CheckJob[] = [
  { platform: 'linux-x64', runner: 'ubuntu-24.04' },
  { platform: 'linux-arm64', runner: 'ubuntu-24.04-arm' },
  { platform: 'macos-arm64', runner: 'macos-26' },
]

// These files use the desktop or simulator. Separate machines split them; each machine still runs one file at a time.
export const nativeIntegrationFiles: readonly string[] = [
  'tests/integration/capture-ios.test.ts',
  'tests/integration/capture-macos.test.ts',
  'tests/integration/evidence-flows.test.ts',
  'tests/integration/evidence-native.test.ts',
  'tests/integration/evidence-timelines.test.ts',
  'tests/integration/native-api-desk.test.ts',
  'tests/integration/native-api-phone.test.ts',
  'tests/integration/native-diagnostics-wired.test.ts',
  'tests/integration/native-diagnostics.test.ts',
  'tests/integration/native-evaluation.test.ts',
  'tests/integration/native-interaction.test.ts',
  'tests/integration/native-ios-lifecycle.test.ts',
  'tests/integration/native-macos-lifecycle.test.ts',
  'tests/integration/native-secrets.test.ts',
  'tests/integration/native-withhold-resume.test.ts',
  'tests/integration/reference-flow-engines.test.ts',
  'tests/integration/reference-flow.test.ts',
]
const nativeFiles: ReadonlySet<string> = new Set(nativeIntegrationFiles)
const durations: Readonly<Record<string, number>> = recordedDurations

function ordered(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export function discoverTests(root: string): Inventory {
  function files(folder: string): string[] {
    return readdirSync(join(root, folder), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.ts'))
      .map((entry) => relative(root, resolve(entry.parentPath, entry.name)).split('\\').join('/'))
      .sort(ordered)
  }
  return { unit: files('tests/unit'), integration: files('tests/integration') }
}

export function assertCoverage(expected: readonly string[], actual: readonly string[]): void {
  const expectedSet = new Set(expected)
  const actualSet = new Set(actual)
  if (expectedSet.size !== expected.length || actualSet.size !== actual.length) throw new Error('A test file is assigned more than once.')
  if (expected.length !== actual.length || expected.some((file) => !actualSet.has(file))) throw new Error('The test plan omits or adds a test file.')
}

function split(files: readonly string[], platform: CheckJob, lane: TestJob['lane'], count: number, weights: Readonly<Record<string, number>>): TestJob[] {
  const jobs: TestJob[] = Array.from({ length: Math.min(count, files.length) }, (_, index) => ({ ...platform, lane, shard: index + 1, total: Math.min(count, files.length), files: [], estimatedSeconds: 0 }))
  const seconds = (file: string): number => {
    // Native files still run on Linux, including their portable controls and explicit platform skips.
    if (platform.platform !== 'macos-arm64' && lane !== 'unit' && nativeFiles.has(file)) return 1
    return weights[file] ?? (lane === 'unit' ? 1 : 20)
  }
  for (const file of [...files].sort((left, right) => seconds(right) - seconds(left) || ordered(left, right))) {
    const job = jobs.reduce((lowest, next) => next.estimatedSeconds < lowest.estimatedSeconds ? next : lowest)
    job.files.push(file)
    job.estimatedSeconds += seconds(file)
  }
  for (const job of jobs) job.files.sort(ordered)
  assertCoverage(files, jobs.flatMap((job) => job.files))
  return jobs
}

export function makeTestPlan(options: PlanOptions): TestPlan {
  const { inventory, scope, platform, files } = options
  const all = [...inventory.unit, ...inventory.integration]
  assertCoverage(all, all)
  if (all.some((file) => !/^tests\/(?:unit|integration)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.test\.ts$/.test(file))) throw new Error('Invalid test file path in the inventory.')
  assertCoverage(files, files)
  if (files.some((file) => !all.includes(file))) throw new Error('Every selected test file must exist in the checked commit.')
  if (files.length > 0 && scope !== 'unit' && scope !== 'integration') throw new Error('Choose unit or integration when selecting test files.')
  const eligible = scope === 'unit' ? inventory.unit : scope === 'integration' ? inventory.integration : all
  if (files.some((file) => !eligible.includes(file))) throw new Error('A selected file belongs to a different suite.')
  const selected = new Set(files.length > 0 ? files : eligible)
  const checks = platforms.filter((job) => platform === 'all' || job.platform === platform)
  if (checks.length === 0) throw new Error('Unknown CI platform.')
  const weights = options.durations ?? durations
  if (Object.values(weights).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('Test durations must be positive finite seconds.')
  const unit = scope === 'all' || scope === 'unit' ? inventory.unit.filter((file) => selected.has(file)) : []
  const integration = scope === 'all' || scope === 'integration' ? inventory.integration.filter((file) => selected.has(file)) : []
  const plan: TestPlan = { full: scope === 'all' && platform === 'all' && files.length === 0, checks: [...checks], unit: [], linux: [], macos: [] }
  for (const job of checks) {
    plan.unit.push(...split(unit, job, 'unit', 4, weights))
    if (job.platform === 'macos-arm64') {
      const browserJobs = split(integration.filter((file) => !nativeFiles.has(file)), job, 'web', 4, weights)
      const nativeJobs = split(integration.filter((file) => nativeFiles.has(file)), job, 'native', 2, weights)
      assertCoverage(integration, [...browserJobs, ...nativeJobs].flatMap((part) => part.files))
      plan.macos.push(...browserJobs, ...nativeJobs)
    } else {
      plan.linux.push(...split(integration, job, 'web', 4, weights))
    }
  }
  return plan
}
