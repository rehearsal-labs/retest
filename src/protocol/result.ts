import type { CaptureReference } from './evidence.ts'
import type { NativeExecutionRecord } from './execution.ts'
import { nativeExecutionIdentitySchema } from './execution.ts'
import { diagnosticsSummarySchema, type DiagnosticsSummary } from './diagnostics.ts'
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
import { evaluationRecordSchema, type EvaluationRecord } from './evaluation.ts'
import {
  cleanupRecordSchema,
  endingSchema,
  executionRecordSchema,
  preparationRecordSchema,
  type CleanupRecord,
  type Ending,
  type ExecutionRecord,
  type PreparationRecord,
} from './execution.ts'
import { failureSchema, sourceLocationSchema, type Failure, type SourceLocation } from './failures.ts'
import { hostCheckResultSchema, type HostCheckResult } from './host-check.ts'
import { captureSourceNameSchema, type CaptureSourceName } from './identity.ts'
import { s, type Schema } from './schema.ts'
import { variantSchema, type Variant } from './variant.ts'

/**
 * A file saved during the test. `path` is relative to the run folder; `app` is the app it shows, when the run has a
 * config. `sessionId`, `attemptId` and `capturedAt` say which session of which attempt captured it, and when, as its
 * `EvidenceReference` does. A run recorded before sessions had ids has none of the three. `capturedElapsedMs`, `source`
 * and `observationId` are the reference's too, each present only when the reference has it.
 */
export type Evidence = {
  kind: 'screenshot'
  path: string
  app?: string
  sessionId?: string
  attemptId?: string
  capturedAt?: string
  capturedElapsedMs?: number
  source?: CaptureSourceName
  captureReference?: CaptureReference
  observationId?: string
}

/**
 * One attempt at a test. A test that runs once per target has one result per variant, so a result is unique by
 * `testId` and `variantKey`. `setup` marks a `test.setup`. `hostChecks` lists every host check the test had, in
 * order, whatever happened to it. `evaluations` lists its AI checks: the test's own in the order they ended, then the
 * host's in the order given, each with its verdict. `execution` is the attempt's execution identity, with the bundle
 * it ran in the end; `preparations` and `cleanups` are the host's preparation and cleanup of it, in the order they
 * ran; `ending` says what ended it. Each is absent in runs recorded before it, and `execution` for a test that never
 * started.
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
  evaluations?: EvaluationRecord[]
  execution?: ExecutionRecord
  preparations?: PreparationRecord[]
  cleanups?: CleanupRecord[]
  ending?: Ending
  /**
   * Each session's console, runtime error and network capture: its state for each kind, its counts and its artifact.
   * Absent for a test that never started its body, and in runs recorded before diagnostics.
   */
  diagnostics?: DiagnosticsSummary[]
  evidence: Evidence[]
}

export type FileResult = { file: string; collection: 'ok' | 'failed'; failure?: Failure; tests: TestResult[] }

/** A browser the run started. `app` and `target` name the app target it served, when the run has a config. */
export type BrowserInfo = { product: string; version: string; executablePath: string; app?: string; target?: TargetInfo }

/**
 * How `test.only` narrowed a run: where each `test.only` and `test.describe.only` is, how many of the files' tests
 * they kept, and how many the files hold, setups left out of both.
 */
export type Narrowed = { only: SourceLocation[]; kept: number; collected: number }

/**
 * The contents of `result.json`, written once when the run ends. `browser` is the first browser the run
 * started; a run from a config lists every app target's browser in `browsers`. `failure` is the run's own,
 * one that no single test explains; tests it kept from running carry it too. `narrowed` is present when `test.only`
 * kept part of the files' tests, so the run checked less than they hold.
 */
export type NativeInfo = { app: string; target: string; product: string; sessionId: string; identity: NativeExecutionRecord }

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
  natives?: NativeInfo[]
  counts: Counts
  failure?: Failure
  narrowed?: Narrowed
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
  evaluations: s.optional(s.array(evaluationRecordSchema)),
  execution: s.optional(executionRecordSchema),
  preparations: s.optional(s.array(preparationRecordSchema)),
  cleanups: s.optional(s.array(cleanupRecordSchema)),
  ending: s.optional(endingSchema),
  diagnostics: s.optional(s.array(diagnosticsSummarySchema)),
  evidence: s.array(
    s.object({
      kind: s.literal('screenshot'),
      path: s.string(),
      app: s.optional(s.string()),
      sessionId: s.optional(s.string()),
      attemptId: s.optional(s.string()),
      capturedAt: s.optional(s.string()),
      capturedElapsedMs: s.optional(count),
      source: s.optional(captureSourceNameSchema),
    captureReference: s.optional(s.object({ instance: s.string(), generation: s.number({ integer: true, min: 0 }), observationId: s.string() })),
      observationId: s.optional(s.string()),
    }),
  ),
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
  natives: s.optional(s.array(s.object({ app: s.string(), target: s.string(), product: s.string(), sessionId: s.string(), identity: nativeExecutionIdentitySchema }))),
  counts: countsSchema,
  failure: s.optional(failureSchema),
  narrowed: s.optional(
    s.object({ only: s.array(sourceLocationSchema), kept: s.number({ integer: true, min: 0 }), collected: s.number({ integer: true, min: 0 }) }),
  ),
  files: s.array(
    s.object({
      file: s.string(),
      collection: s.enum(['ok', 'failed']),
      failure: s.optional(failureSchema),
      tests: s.array(testResultSchema),
    }),
  ),
})
