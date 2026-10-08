import { writeFileSync } from 'node:fs'
import { isMainThread } from 'node:worker_threads'

// Only the CLI gets this explicit --import. Retest does not pass --import to test-file children.
const output = process.env['RETEST_BENCH_RESOURCE_OUTPUT']
if (output === undefined) throw new Error('The resource preload needs RETEST_BENCH_RESOURCE_OUTPUT.')
if (isMainThread && process.argv[1] === process.env['RETEST_BENCH_ROOT_ENTRY']) process.once('exit', () => {
  const usage = process.resourceUsage()
  writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, pid: process.pid, userCpuMs: usage.userCPUTime / 1000, systemCpuMs: usage.systemCPUTime / 1000, peakRssBytes: usage.maxRSS * 1024 })}\n`, { flag: 'wx' })
})
