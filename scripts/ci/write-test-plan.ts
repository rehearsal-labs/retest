import { appendFileSync } from 'node:fs'
import { discoverTests, fastFileLimitSeconds, makeTestPlan } from './test-plan.ts'

const scope = process.env['RETEST_CI_SCOPE'] || 'all'
const platform = process.env['RETEST_CI_PLATFORM'] || 'all'
if (scope !== 'all' && scope !== 'fast' && scope !== 'checks' && scope !== 'unit' && scope !== 'integration') throw new Error('Choose all, fast, checks, unit or integration.')
if (platform !== 'all' && platform !== 'linux-x64' && platform !== 'linux-arm64' && platform !== 'macos-arm64') throw new Error('Choose all, linux-x64, linux-arm64 or macos-arm64.')
const inventory = discoverTests(process.cwd())
const plan = makeTestPlan({ inventory, scope, platform, files: (process.env['RETEST_CI_TEST_FILES'] ?? '').split(/\s+/).filter(Boolean) })
const output = process.env['GITHUB_OUTPUT']
if (output === undefined) throw new Error('GITHUB_OUTPUT is required.')
for (const [name, value] of Object.entries(plan)) appendFileSync(output, `${name}=${JSON.stringify(value)}\n`)
// The result job checks each lane's outcome against these counts, so it never reads the plan's file lists.
const requested = { checks: plan.checks.length, unit: plan.unit.length, linux: plan.linux.length, macos: plan.macos.length }
appendFileSync(output, `requested=${JSON.stringify(requested)}\n`)
const summary = process.env['GITHUB_STEP_SUMMARY']
const selected = plan.checks.map((job) => job.platform).join(', ')
const shortFiles = plan.macos.length > 0 ? `, and on macos-arm64 the integration files under ${fastFileLimitSeconds} seconds or not yet timed` : ''
const heading = plan.full
  ? 'Full release matrix. Every test file is assigned once per platform.'
  : scope === 'fast'
    ? `Fast checks: build, types and unit files on ${selected}${shortFiles}. This run does not establish full release coverage.`
    : 'Focused checks. This run does not establish full release coverage.'
if (summary !== undefined) appendFileSync(summary, [
  heading,
  '',
  `Inventory: ${inventory.unit.length} unit files and ${inventory.integration.length} integration files.`,
  '',
  ...[...plan.unit, ...plan.linux, ...plan.macos].map((job) => `- ${job.platform} ${job.lane} ${job.shard}/${job.total}: ${job.files.length} files, estimated ${job.estimatedSeconds} s of tests for a target of ${job.targetSeconds} s.`),
  '',
].join('\n'))
