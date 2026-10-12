import { writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { describeMissing, durationsPath, formatDurations, readDurations, readShardResults, refreshDurations } from './measured-durations.ts'
import { discoverTests } from './test-plan.ts'

// Rewrites scripts/ci/test-durations.json from a CI run's artifacts, from the repository root:
//
//   gh run download <run id> --repo rehearsal-labs/retest --dir /tmp/retest-run-<run id>
//   node scripts/ci/refresh-durations.ts [--partial] /tmp/retest-run-<run id>
//
// Each file gets, on each platform, its slowest passing time there, rounded up to whole seconds. A file that failed,
// was killed or was cut off gives no time. A refresh changes nothing unless every file that has a time, or that the
// run named, passed on every platform; --partial keeps the earlier times where it did not. A file the repository no
// longer holds is dropped.

const partial = process.argv.includes('--partial')
const folders = process.argv.slice(2).filter((argument) => argument !== '--partial')
const folder = folders[0]
if (folders.length !== 1 || folder === undefined || folder === '') {
  process.stderr.write('Usage: node scripts/ci/refresh-durations.ts [--partial] <folder of downloaded CI artifacts>\n')
  process.exit(2)
}
const root = process.cwd()
const path = join(root, durationsPath)
const shards = readShardResults(isAbsolute(folder) ? folder : resolve(root, folder))
const refreshed = refreshDurations({ previous: readDurations(path), measured: shards.files, named: shards.named, inventory: discoverTests(root) })
if (refreshed.missing.length > 0 && !partial) {
  process.stderr.write(`${describeMissing(refreshed.missing)} Nothing was written.\n`)
  process.exit(1)
}
writeFileSync(path, formatDurations(refreshed.durations))
process.stdout.write([
  `Read ${shards.results} results files: ${refreshed.measured.length} test files timed, ${refreshed.kept.length} kept only their earlier times.`,
  ...refreshed.missing.map((each) => `No passing time for ${each.file} on ${each.platforms.join(', ')}; any earlier time there was kept.`),
  ...refreshed.dropped.map((file) => `Dropped ${file}: the repository no longer holds it.`),
  `Wrote ${durationsPath}.`,
  '',
].join('\n'))
