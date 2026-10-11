import { appendFileSync } from 'node:fs'
import { discoverTests, makeTestPlan } from './test-plan.ts'

const scope = process.env['RETEST_CI_SCOPE'] || 'all'
const platform = process.env['RETEST_CI_PLATFORM'] || 'all'
if (scope !== 'all' && scope !== 'checks' && scope !== 'unit' && scope !== 'integration') throw new Error('Choose all, checks, unit or integration.')
if (platform !== 'all' && platform !== 'linux-x64' && platform !== 'linux-arm64' && platform !== 'macos-arm64') throw new Error('Choose all, linux-x64, linux-arm64 or macos-arm64.')
const inventory = discoverTests(process.cwd())
const plan = makeTestPlan({ inventory, scope, platform, files: (process.env['RETEST_CI_TEST_FILES'] ?? '').split(/\s+/).filter(Boolean) })
const output = process.env['GITHUB_OUTPUT']
if (output === undefined) throw new Error('GITHUB_OUTPUT is required.')
for (const [name, value] of Object.entries(plan)) appendFileSync(output, `${name}=${JSON.stringify(value)}\n`)
const summary = process.env['GITHUB_STEP_SUMMARY']
if (summary !== undefined) appendFileSync(summary, [
  plan.full ? 'Full release matrix. Every test file is assigned once per platform.' : 'Focused checks. This run does not establish full release coverage.',
  '',
  `Inventory: ${inventory.unit.length} unit files and ${inventory.integration.length} integration files.`,
  '',
  ...[...plan.unit, ...plan.linux, ...plan.macos].map((job) => `- ${job.platform} ${job.lane} ${job.shard}/${job.total}: ${job.files.length} files, historical estimate ${Math.ceil(job.estimatedSeconds / 60)} minutes.`),
  '',
].join('\n'))
