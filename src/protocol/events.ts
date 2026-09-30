import { actionKindSchema, type ActionKind } from './commands.ts'
import {
  failureSchema,
  sourceLocationSchema,
  truncatedTextSchema,
  type Failure,
  type SourceLocation,
  type TruncatedText,
} from './failures.ts'
import { locatorRecipeSchema, type LocatorRecipe } from './locator.ts'
import { s, type Schema } from './schema.ts'
import { timeoutsSchema, type Timeouts } from './timeouts.ts'

/** Milestone 1 never produces `inconclusive`. */
export type TestStatus = 'passed' | 'failed' | 'error' | 'not_run' | 'inconclusive'
export type RunStatus = 'passed' | 'failed' | 'error' | 'interrupted'
/** 130 and 143 are a run stopped by SIGINT and by SIGTERM. */
export type ExitCode = 0 | 1 | 2 | 130 | 143
export type Counts = { passed: number; failed: number; error: number; notRun: number; inconclusive: number }
export type CollectedTest = { testId: string; name: string; location: SourceLocation }

/** What the parent adds to each event as it writes it. `elapsedMs` is monotonic time since the run started. */
export type EventStamp = { schemaVersion: 1; runId: string; sequence: number; time: string; elapsedMs: number }

type Common = { session?: string }
type TestScope = { testId: string; attemptId: string }
type StepScope = TestScope & { stepId?: string }
type ActionFields = StepScope & {
  command: ActionKind
  locator?: LocatorRecipe
  pageUrl?: string
  durationMs: number
  location?: SourceLocation
  valueLength?: number
}
type AssertionFields = StepScope & {
  matcher: string
  locator?: LocatorRecipe
  expected: TruncatedText | null
  actual: TruncatedText | null
  comparison?: string
  attempts: number
  timeoutMs?: number
  durationMs: number
  location?: SourceLocation
  pageUrl?: string
}

/** Step and assertion events, which the child reports for the parent to stamp. */
export type ChildEvent = Common &
  (
    | (TestScope & { type: 'step.started'; stepId: string; parentStepId?: string; name: string; location?: SourceLocation })
    | (TestScope & { type: 'step.finished'; stepId: string; status: 'passed' | 'failed'; durationMs: number; failure?: Failure })
    | (AssertionFields & { type: 'assertion.passed' })
    | (AssertionFields & { type: 'assertion.failed'; failure: Failure })
  )

/**
 * An event before the parent stamps it. Page URLs are origin and path, with no query or fragment. The
 * browser's `pid` is also its process group. `file.failed` is a collected file whose process failed outside
 * its tests. The failure on `run.finished` is the run's own, one that no single test explains, such as a
 * browser that did not start or output that could not be kept.
 */
export type EventBody =
  | ChildEvent
  | (Common &
      (
        | {
            type: 'run.started'
            retestVersion: string
            node: string
            platform: string
            rootDir: string
            files: string[]
            options: { baseUrl?: string; browserPath: string; timeouts: Timeouts; reporter: string }
          }
        | { type: 'browser.started'; product: string; version: string; userAgent: string; pid: number; executablePath: string }
        | { type: 'collection.completed'; file: string; tests: CollectedTest[] }
        | { type: 'collection.failed'; file: string; failure: Failure }
        | { type: 'file.failed'; file: string; failure: Failure }
        | (TestScope & { type: 'test.started'; name: string; file: string; location: SourceLocation })
        | (ActionFields & { type: 'action.completed' })
        | (ActionFields & { type: 'action.failed'; failure: Failure })
        | (StepScope & { type: 'navigation'; url: string })
        | (TestScope & { type: 'evidence.captured'; kind: 'screenshot'; path: string; reason: 'failure' })
        | (TestScope & { type: 'evidence.failed'; kind: 'screenshot'; reason: 'failure'; message: string })
        | (TestScope & {
            type: 'test.finished'
            status: TestStatus
            durationMs: number
            assertionCount: number
            failure?: Failure
            cleanupFailures?: Failure[]
          })
        | {
            type: 'run.finished'
            status: RunStatus
            exitCode: ExitCode
            complete: boolean
            counts: Counts
            durationMs: number
            failure?: Failure
          }
      ))

/** A version 1 event, one line of `events.jsonl`. */
export type RetestEvent = EventStamp & EventBody

const count = s.number({ integer: true, min: 0 })
const duration = s.number({ min: 0 })

export const testStatusSchema: Schema<TestStatus> = s.enum(['passed', 'failed', 'error', 'not_run', 'inconclusive'])
export const runStatusSchema: Schema<RunStatus> = s.enum(['passed', 'failed', 'error', 'interrupted'])
export const exitCodeSchema: Schema<ExitCode> = s.union([s.literal(0), s.literal(1), s.literal(2), s.literal(130), s.literal(143)])
export const countsSchema: Schema<Counts> = s.object({
  passed: count,
  failed: count,
  error: count,
  notRun: count,
  inconclusive: count,
})

const collectedTestSchema = s.object({
  testId: s.string(),
  name: s.string(),
  location: sourceLocationSchema,
})

const common = { session: s.optional(s.string()) }
const envelope = {
  schemaVersion: s.literal(1),
  runId: s.string(),
  sequence: count,
  time: s.string(),
  elapsedMs: duration,
  ...common,
}
const testScope = { testId: s.string(), attemptId: s.string() }
const stepScope = { ...testScope, stepId: s.optional(s.string()) }
const actionFields = {
  ...stepScope,
  command: actionKindSchema,
  locator: s.optional(locatorRecipeSchema),
  pageUrl: s.optional(s.string()),
  durationMs: duration,
  location: s.optional(sourceLocationSchema),
  valueLength: s.optional(count),
}
const assertionFields = {
  ...stepScope,
  matcher: s.string(),
  locator: s.optional(locatorRecipeSchema),
  expected: s.nullable(truncatedTextSchema),
  actual: s.nullable(truncatedTextSchema),
  comparison: s.optional(s.string()),
  attempts: count,
  timeoutMs: s.optional(count),
  durationMs: duration,
  location: s.optional(sourceLocationSchema),
  pageUrl: s.optional(s.string()),
}

const stepStarted = {
  type: s.literal('step.started'),
  ...testScope,
  stepId: s.string(),
  parentStepId: s.optional(s.string()),
  name: s.string(),
  location: s.optional(sourceLocationSchema),
}
const stepFinished = {
  type: s.literal('step.finished'),
  ...testScope,
  stepId: s.string(),
  status: s.enum(['passed', 'failed']),
  durationMs: duration,
  failure: s.optional(failureSchema),
}
const assertionPassed = { type: s.literal('assertion.passed'), ...assertionFields }
const assertionFailed = { type: s.literal('assertion.failed'), ...assertionFields, failure: failureSchema }

export const childEventSchema: Schema<ChildEvent> = s.discriminatedUnion('type', [
  s.object({ ...common, ...stepStarted }),
  s.object({ ...common, ...stepFinished }),
  s.object({ ...common, ...assertionPassed }),
  s.object({ ...common, ...assertionFailed }),
])

export const retestEventSchema: Schema<RetestEvent> = s.discriminatedUnion('type', [
  s.object({
    ...envelope,
    type: s.literal('run.started'),
    retestVersion: s.string(),
    node: s.string(),
    platform: s.string(),
    rootDir: s.string(),
    files: s.array(s.string()),
    options: s.object({
      baseUrl: s.optional(s.string()),
      browserPath: s.string(),
      timeouts: timeoutsSchema,
      reporter: s.string(),
    }),
  }),
  s.object({
    ...envelope,
    type: s.literal('browser.started'),
    product: s.string(),
    version: s.string(),
    userAgent: s.string(),
    pid: s.number({ integer: true, min: 1 }),
    executablePath: s.string(),
  }),
  s.object({
    ...envelope,
    type: s.literal('collection.completed'),
    file: s.string(),
    tests: s.array(collectedTestSchema),
  }),
  s.object({ ...envelope, type: s.literal('collection.failed'), file: s.string(), failure: failureSchema }),
  s.object({ ...envelope, type: s.literal('file.failed'), file: s.string(), failure: failureSchema }),
  s.object({
    ...envelope,
    type: s.literal('test.started'),
    ...testScope,
    name: s.string(),
    file: s.string(),
    location: sourceLocationSchema,
  }),
  s.object({ ...envelope, ...stepStarted }),
  s.object({ ...envelope, ...stepFinished }),
  s.object({ ...envelope, type: s.literal('action.completed'), ...actionFields }),
  s.object({ ...envelope, type: s.literal('action.failed'), ...actionFields, failure: failureSchema }),
  s.object({ ...envelope, type: s.literal('navigation'), ...stepScope, url: s.string() }),
  s.object({ ...envelope, ...assertionPassed }),
  s.object({ ...envelope, ...assertionFailed }),
  s.object({
    ...envelope,
    type: s.literal('evidence.captured'),
    ...testScope,
    kind: s.literal('screenshot'),
    path: s.string(),
    reason: s.literal('failure'),
  }),
  s.object({
    ...envelope,
    type: s.literal('evidence.failed'),
    ...testScope,
    kind: s.literal('screenshot'),
    reason: s.literal('failure'),
    message: s.string(),
  }),
  s.object({
    ...envelope,
    type: s.literal('test.finished'),
    ...testScope,
    status: testStatusSchema,
    durationMs: duration,
    assertionCount: count,
    failure: s.optional(failureSchema),
    cleanupFailures: s.optional(s.array(failureSchema)),
  }),
  s.object({
    ...envelope,
    type: s.literal('run.finished'),
    status: runStatusSchema,
    exitCode: exitCodeSchema,
    complete: s.boolean(),
    counts: countsSchema,
    durationMs: duration,
    failure: s.optional(failureSchema),
  }),
])
