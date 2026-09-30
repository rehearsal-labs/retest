import {
  countsSchema,
  exitCodeSchema,
  runStatusSchema,
  targetInfoSchema,
  testStatusSchema,
  type Counts,
  type ExitCode,
  type RunStatus,
  type TargetInfo,
  type TestStatus,
} from './events.ts'
import { failureSchema, sourceLocationSchema, type Failure, type SourceLocation } from './failures.ts'
import { hostCheckResultSchema, type HostCheckResult } from './host-check.ts'
import { s, type Schema } from './schema.ts'
import { variantSchema, type Variant } from './variant.ts'

/** A file saved during the test. `path` is relative to the run folder; `app` is the app it shows, when the run has a config. */
export type Evidence = { kind: 'screenshot'; path: string; app?: string }

/**
 * One attempt at a test. A test that runs once per target has one result per variant, so a result is unique by
 * `testId` and `variantKey`. `setup` marks a `test.setup`. `hostChecks` lists every host check the test had, in
 * order, whatever happened to it.
 */
export type TestResult = {
  testId: string
  name: string
  file: string
  location: SourceLocation
  describePath?: string[]
  variant?: Variant
  variantKey?: string
  setup?: true
  attemptId: string
  status: TestStatus
  durationMs: number
  assertionCount: number
  failure?: Failure
  cleanupFailures?: Failure[]
  hostChecks?: HostCheckResult[]
  evidence: Evidence[]
}

export type FileResult = { file: string; collection: 'ok' | 'failed'; failure?: Failure; tests: TestResult[] }

/** A browser the run started. `app` and `target` name the app target it served, when the run has a config. */
export type BrowserInfo = { product: string; version: string; executablePath: string; app?: string; target?: TargetInfo }

/**
 * The contents of `result.json`, written once when the run ends. `browser` is the first browser the run
 * started; a run from a config lists every app target's browser in `browsers`. `failure` is the run's own,
 * one that no single test explains; tests it kept from running carry it too.
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
  browsers?: BrowserInfo[]
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
  describePath: s.optional(s.array(s.string())),
  variant: s.optional(variantSchema),
  variantKey: s.optional(s.string()),
  setup: s.optional(s.literal(true)),
  attemptId: s.string(),
  status: testStatusSchema,
  durationMs: duration,
  assertionCount: count,
  failure: s.optional(failureSchema),
  cleanupFailures: s.optional(s.array(failureSchema)),
  hostChecks: s.optional(s.array(hostCheckResultSchema)),
  evidence: s.array(s.object({ kind: s.literal('screenshot'), path: s.string(), app: s.optional(s.string()) })),
})

const browserInfoSchema = s.object({
  product: s.string(),
  version: s.string(),
  executablePath: s.string(),
  app: s.optional(s.string()),
  target: s.optional(targetInfoSchema),
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
  browser: s.nullable(browserInfoSchema),
  browsers: s.optional(s.array(browserInfoSchema)),
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
