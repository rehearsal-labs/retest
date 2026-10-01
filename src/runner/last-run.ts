import type { LastRun, LastRunTest } from '../protocol/last-run.ts'
import type { RunResult } from '../protocol/result.ts'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

/**
 * Where a run records the tests it did not pass: `.retest/last-run.json` under the root directory by default, the
 * path its caller chose, resolved from the current directory, or nowhere for `false`.
 *
 * @example lastRunPath('/work', undefined) // '/work/.retest/last-run.json'
 */
export function lastRunPath(rootDir: string, chosen: string | false | undefined): string | undefined {
  if (chosen === false) return undefined
  return chosen === undefined ? join(rootDir, lastRunFile) : resolve(chosen)
}

/** Writes the record of a run to `target`, whole: through a temporary file renamed into place. */
export function writeLastRun(target: string, lastRun: LastRun): void {
  mkdirSync(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.partial`
  writeFileSync(temporary, `${JSON.stringify(lastRun, null, 2)}\n`)
  renameSync(temporary, target)
}
