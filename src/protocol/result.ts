import {
  countsSchema,
  exitCodeSchema,
  runStatusSchema,
  testStatusSchema,
  type Counts,
  type ExitCode,
  type RunStatus,
  type TestStatus,
} from './events.ts'
import { failureSchema, sourceLocationSchema, type Failure, type SourceLocation } from './failures.ts'
import { s, type Schema } from './schema.ts'

/** A file saved during the test. `path` is relative to the run folder. */
export type Evidence = { kind: 'screenshot'; path: string }

export type TestResult = {
  testId: string
  name: string
  file: string
  location: SourceLocation
  attemptId: string
  status: TestStatus
  durationMs: number
  assertionCount: number
  failure?: Failure
  cleanupFailures?: Failure[]
  evidence: Evidence[]
}

export type FileResult = { file: string; collection: 'ok' | 'failed'; failure?: Failure; tests: TestResult[] }

export type BrowserInfo = { product: string; version: string; executablePath: string }

/**
 * The contents of `result.json`, written once when the run ends. `failure` is the run's own, one that no
 * single test explains; tests it kept from running carry it too.
 */
export type RunResult = {
  schemaVersion: 1
  runId: string
  retestVersion: string
  startedAt: string
  finishedAt: string
  complete: boolean
  status: RunStatus
  exitCode: ExitCode
  durationMs: number
  browser: BrowserInfo | null
  counts: Counts
  failure?: Failure
  files: FileResult[]
}

const count = s.number({ integer: true, min: 0 })
const duration = s.number({ min: 0 })

const testResultSchema = s.object({
  testId: s.string(),
  name: s.string(),
  file: s.string(),
  location: sourceLocationSchema,
  attemptId: s.string(),
  status: testStatusSchema,
  durationMs: duration,
  assertionCount: count,
  failure: s.optional(failureSchema),
  cleanupFailures: s.optional(s.array(failureSchema)),
  evidence: s.array(s.object({ kind: s.literal('screenshot'), path: s.string() })),
})

export const runResultSchema: Schema<RunResult> = s.object({
  schemaVersion: s.literal(1),
  runId: s.string(),
  retestVersion: s.string(),
  startedAt: s.string(),
  finishedAt: s.string(),
  complete: s.boolean(),
  status: runStatusSchema,
  exitCode: exitCodeSchema,
  durationMs: duration,
  browser: s.nullable(s.object({ product: s.string(), version: s.string(), executablePath: s.string() })),
  counts: countsSchema,
  failure: s.optional(failureSchema),
  files: s.array(
    s.object({
      file: s.string(),
      collection: s.enum(['ok', 'failed']),
      failure: s.optional(failureSchema),
      tests: s.array(testResultSchema),
    }),
  ),
})
