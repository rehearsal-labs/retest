import { s, type Schema } from './schema.ts'

/** Where every run records the tests it did not pass, relative to the root directory. `--last-failed` reads it. */
export const lastRunFile = '.retest/last-run.json'

/** A test the last run did not pass: it failed, ended in an error, or could not run. */
export type LastRunTest = { testId: string; variantKey?: string; status: 'failed' | 'error' | 'not_run' }

/** The contents of `.retest/last-run.json`, written again when each run ends. */
export type LastRun = { schemaVersion: 1; runId: string; finishedAt: string; tests: LastRunTest[] }

export const lastRunSchema: Schema<LastRun> = s.object({
  schemaVersion: s.literal(1),
  runId: s.string(),
  finishedAt: s.string(),
  tests: s.array(
    s.object({
      testId: s.string(),
      variantKey: s.optional(s.string()),
      status: s.enum(['failed', 'error', 'not_run']),
    }),
  ),
})
