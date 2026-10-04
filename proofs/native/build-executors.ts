/**
 * Builds both native executors from their pinned commits into Retest's executor cache, or finds them there, through
 * `ensureExecutorBuild`: WebDriverAgent for iOS simulators and the macOS runner of appium-mac2-driver. It takes over
 * the Phase 1 builds in ~/Library/Caches/retest-proofs/derived when they match the pin, so the macOS runner keeps the
 * code hash macOS knows. Prints one line per executor and writes the records it read to the log folder.
 *
 *   node --conditions=retest-source proofs/native/build-executors.ts [--only webdriveragent|mac2]
 *
 * Exit 0 when both builds are ready, 1 when one is not.
 */
import type { ExecutorName } from '../../src/native/executors.ts'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ensureExecutorBuild } from '../../src/native/executors.ts'
import { systemTools } from '../../src/native/processes.ts'
import { CACHE_ROOT } from './shared/evidence.ts'

const sources: Record<ExecutorName, string> = { webdriveragent: join(CACHE_ROOT, 'WebDriverAgent'), mac2: join(CACHE_ROOT, 'appium-mac2-driver') }
const adoptFrom: Record<ExecutorName, string[]> = { webdriveragent: [join(CACHE_ROOT, 'derived', 'wda-ios')], mac2: [join(CACHE_ROOT, 'derived', 'mac2')] }

const { values } = parseArgs({ options: { only: { type: 'string' } } })
const only = values.only
if (only !== undefined && only !== 'webdriveragent' && only !== 'mac2') {
  process.stderr.write('--only takes webdriveragent or mac2\n')
  process.exit(2)
}
const logs = join(CACHE_ROOT, 'logs')
await mkdir(logs, { recursive: true })
const stamp = new Date().toISOString().replace(/\.\d+Z$/, 'Z').replaceAll(':', '-')
let failed = false
for (const executor of ['webdriveragent', 'mac2'] as const) {
  if (only !== undefined && only !== executor) continue
  const started = Date.now()
  const logFile = join(logs, `executor-build-${executor}-${stamp}.log`)
  const result = await ensureExecutorBuild({ executor, sources, adoptFrom: adoptFrom[executor], logFile, timeoutMs: 30 * 60_000, tools: systemTools })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  if (!result.ok) {
    failed = true
    process.stdout.write(`${executor}: not ready after ${seconds} s: ${result.failure.message}\n`)
    continue
  }
  const { build } = result
  process.stdout.write(`${executor}: ${result.action} in ${seconds} s; ${build.origin} ${build.version} at ${build.commit.slice(0, 12)}; products ${build.productsSha256.slice(0, 16)}; code directory hash ${build.codeDirectoryHash ?? 'unread'}; ${build.licenses.length} licence(s), ${build.notices.map((notice) => `${notice.files} files under the BSD notice`).join(', ') || 'no notice'}; folder ${result.folder}\n`)
  await writeFile(join(logs, `executor-build-${executor}-${stamp}.json`), `${JSON.stringify({ action: result.action, folder: result.folder, build }, null, 2)}\n`)
}
process.exitCode = failed ? 1 : 0
