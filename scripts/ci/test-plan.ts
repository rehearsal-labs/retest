import { readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import recordedDurations from './test-durations.json' with { type: 'json' }

export type Platform = 'linux-x64' | 'linux-arm64' | 'macos-arm64' | 'windows-x64'
/** A file's recorded seconds on each platform a passing run has timed it on. */
export type PlatformSeconds = Readonly<Partial<Record<Platform, number>>>
export type Durations = Readonly<Record<string, PlatformSeconds>>
export type Scope = 'all' | 'fast' | 'checks' | 'unit' | 'integration'
export type Inventory = { unit: readonly string[]; integration: readonly string[] }
export type CheckJob = { platform: Platform; runner: string }
export type TestJob = CheckJob & { lane: 'unit' | 'web' | 'native'; shard: number; total: number; files: string[]; estimatedSeconds: number; targetSeconds: number }
export type TestPlan = { full: boolean; checks: CheckJob[]; unit: TestJob[]; linux: TestJob[]; macos: TestJob[]; windows: TestJob[] }

/**
 * Seconds of tests, by the recorded durations, that each shard of a lane is packed to. A lane gets as many shards as
 * its files' total needs at this target, so a slower suite gets more machines rather than longer jobs.
 */
export type ShardTargets = { readonly unit: number; readonly linuxWeb: number; readonly macosWeb: number; readonly macosNative: number; readonly windowsWeb: number }
export type PlanOptions = {
  inventory: Inventory
  scope: Scope
  platform: Platform | 'all'
  files: readonly string[]
  durations?: Durations
  targets?: Partial<ShardTargets>
}

export const defaultShardTargets: ShardTargets = { unit: 150, linuxWeb: 300, macosWeb: 360, macosNative: 360, windowsWeb: 300 }

/** The fast suite runs only the integration files whose recorded duration is under this many seconds, on macOS. */
export const fastFileLimitSeconds = 60

/** Every platform CI runs on, in the order test-durations.json lists them. */
export const platformNames: readonly Platform[] = ['macos-arm64', 'linux-x64', 'linux-arm64', 'windows-x64']

/** The platforms with an integration lane: every platform. Windows got its lane with the browsers that run there. */
export const integrationPlatforms: ReadonlySet<Platform> = new Set<Platform>(['linux-x64', 'linux-arm64', 'macos-arm64', 'windows-x64'])

/** Whether CI assigns a test file to a platform: every platform runs the unit files. */
export function assignedTo(platform: Platform, file: string): boolean {
  return file.startsWith('tests/unit/') || integrationPlatforms.has(platform)
}

const platforms: readonly CheckJob[] = [
  { platform: 'linux-x64', runner: 'ubuntu-24.04' },
  { platform: 'linux-arm64', runner: 'ubuntu-24.04-arm' },
  { platform: 'macos-arm64', runner: 'macos-26' },
  { platform: 'windows-x64', runner: 'windows-2025' },
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
const durations: Durations = recordedDurations

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

/**
 * The seconds a file is planned at on a platform: that platform's own recorded time, or else the largest any platform
 * has recorded, or else the default for a file no passing run has timed yet.
 */
function plannedSeconds(file: string, platform: Platform, lane: TestJob['lane'], weights: Durations): number {
  const recorded = weights[file]
  const own = recorded?.[platform]
  if (own !== undefined) return own
  // Native files run on Linux only for their portable controls and explicit platform skips.
  if (platform !== 'macos-arm64' && lane !== 'unit' && nativeFiles.has(file)) return 1
  const elsewhere = recorded === undefined ? [] : Object.values(recorded)
  return elsewhere.length > 0 ? Math.max(...elsewhere) : lane === 'unit' ? 1 : 20
}

// The shard count is the lane's total over its target, rounded up, and files go largest first into the emptiest shard.
// The emptiest shard never holds more than the total over the count, which is at most the target, so the file added
// to it leaves no shard more than the lane's largest file past its target.
function split(files: readonly string[], platform: CheckJob, lane: TestJob['lane'], targetSeconds: number, weights: Durations): TestJob[] {
  const seconds = (file: string): number => plannedSeconds(file, platform.platform, lane, weights)
  const totalSeconds = files.reduce((sum, file) => sum + seconds(file), 0)
  const count = Math.min(files.length, Math.max(1, Math.ceil(totalSeconds / targetSeconds)))
  const jobs: TestJob[] = Array.from({ length: count }, (_, index) => ({ ...platform, lane, shard: index + 1, total: count, files: [], estimatedSeconds: 0, targetSeconds }))
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
  if (Object.values(weights).some((entry) => Object.values(entry).some((value) => !Number.isFinite(value) || value <= 0))) throw new Error('Test durations must be positive finite seconds.')
  const targets: ShardTargets = { ...defaultShardTargets, ...options.targets }
  if (Object.values(targets).some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('Shard targets must be positive finite seconds.')
  const fast = scope === 'fast'
  const unit = scope === 'all' || fast || scope === 'unit' ? inventory.unit.filter((file) => selected.has(file)) : []
  const integration = scope === 'all' || fast || scope === 'integration' ? inventory.integration.filter((file) => selected.has(file)) : []
  const plan: TestPlan = { full: scope === 'all' && platform === 'all' && files.length === 0, checks: [...checks], unit: [], linux: [], macos: [], windows: [] }
  for (const job of checks) {
    plan.unit.push(...split(unit, job, 'unit', targets.unit, weights))
    if (job.platform === 'macos-arm64') {
      // The fast suite finds what is broken before the full matrix runs: the short files, on the slowest platform.
      const macosFiles = fast ? integration.filter((file) => plannedSeconds(file, 'macos-arm64', 'web', weights) < fastFileLimitSeconds) : integration
      const browserJobs = split(macosFiles.filter((file) => !nativeFiles.has(file)), job, 'web', targets.macosWeb, weights)
      const nativeJobs = split(macosFiles.filter((file) => nativeFiles.has(file)), job, 'native', targets.macosNative, weights)
      assertCoverage(macosFiles, [...browserJobs, ...nativeJobs].flatMap((part) => part.files))
      plan.macos.push(...browserJobs, ...nativeJobs)
    } else if (!fast && job.platform === 'windows-x64') {
      plan.windows.push(...split(integration, job, 'web', targets.windowsWeb, weights))
    } else if (!fast) {
      plan.linux.push(...split(integration, job, 'web', targets.linuxWeb, weights))
    }
  }
  return plan
}
