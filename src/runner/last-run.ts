import type { LastRun, LastRunTest } from '../protocol/last-run.ts'
import type { RunResult } from '../protocol/result.ts'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { lastRunFile } from '../protocol/last-run.ts'

/**
 * What `--last-failed` reads after this run: each test that failed, ended in an error or was kept from running,
 * with its variant's key when it has one.
 */
export function lastRunOf(result: Pick<RunResult, 'runId' | 'finishedAt' | 'files'>): LastRun {
  const tests = result.files.flatMap((file) =>
    file.tests.flatMap(({ testId, variantKey, status }): LastRunTest[] => {
      if (status !== 'failed' && status !== 'error' && status !== 'not_run') return []
      return [variantKey === undefined ? { testId, status } : { testId, variantKey, status }]
    }),
  )
  return { schemaVersion: 1, runId: result.runId, finishedAt: result.finishedAt, tests }
}

/** Writes `.retest/last-run.json` under the root directory, whole: through a temporary file renamed into place. */
export function writeLastRun(rootDir: string, lastRun: LastRun): void {
  const target = join(rootDir, lastRunFile)
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.partial`
  writeFileSync(temporary, `${JSON.stringify(lastRun, null, 2)}\n`)
  renameSync(temporary, target)
}
