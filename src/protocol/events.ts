import { actionKindSchema, type ActionKind } from './commands.ts'
import { emulationSchema, type Emulation } from './emulation.ts'
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
import { partialTimeoutsSchema, timeoutsSchema, type Timeouts } from './timeouts.ts'
import { variantSchema, type Variant } from './variant.ts'

/** Milestone 1 never produces `inconclusive`. */
export type TestStatus = 'passed' | 'failed' | 'error' | 'not_run' | 'inconclusive'
export type RunStatus = 'passed' | 'failed' | 'error' | 'interrupted'
/** 130 and 143 are a run stopped by SIGINT and by SIGTERM. */
export type ExitCode = 0 | 1 | 2 | 130 | 143
export type Counts = { passed: number; failed: number; error: number; notRun: number; inconclusive: number }

/**
 * A test as collection found it. `describePath` names its `test.describe` blocks, outermost first. `apps` are
 * the apps it runs with, and `variants` each run of it, when the run has a config. `setup` marks a
 * `test.setup`, and `setupFor` one the run took from a file it was not given: the files whose tests start from
 * its state. `row` is a `test.for` row's number in its list, from 1, which `file:line#row` selects, since every
 * row has the line of its `test.for`. Each field is present only when it says something.
 */
export type CollectedTest = {
  testId: string
  name: string
  location: SourceLocation
  row?: number
  describePath?: string[]
  tags?: string[]
  apps?: string[]
  setup?: true
  setupFor?: string[]
  variants?: Variant[]
}

/**
 * A browser target: its name in its app and, for a target that emulates a screen, what it emulates and the
 * named device, if it is one. A target with `emulation` is always reported as emulated.
 */
export type TargetInfo = { name: string; emulation?: Emulation; device?: string }

/**
 * Who reported an event. `parent` is a fact the parent process saw for itself; `child` is a claim the test
 * file's process made, which the parent checked for shape and passed on.
 */
export type EventOrigin = 'parent' | 'child'

/** What the parent adds to each event as it writes it. `elapsedMs` is monotonic time since the run started. */
export type EventStamp = {
  schemaVersion: 1
  runId: string
  sequence: number
  time: string
  elapsedMs: number
  origin: EventOrigin
}

/** `session` is the app the event concerns: `page` in milestone 1's mode, otherwise the app's name. */
type Common = { session?: string }
type TestScope = { testId: string; attemptId: string }
/** Which run of the test an attempt is, when the run has a config. The parent adds it to every attempt's events. */
type VariantScope = { variant?: Variant; variantKey?: string }
type AttemptScope = TestScope & VariantScope
type StepScope = AttemptScope & { stepId?: string }
type ActionFields = StepScope & {
  command: ActionKind
  locator?: LocatorRecipe
  pageUrl?: string
  durationMs: number
  location?: SourceLocation
  /** The length of the text a `fill` typed. A secret fill names its secret instead. */
  valueLength?: number
  secret?: string
}
type AssertionFields = TestScope & {
  stepId?: string
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
  /** From `expect.soft`: the test went on after it failed. */
  soft?: true
}

/**
 * Step and assertion events, which the child reports for the parent to stamp. `hook` marks the step a
 * `beforeEach` or `afterEach` hook ran as.
 */
export type ChildEvent = Common &
  (
    | (TestScope & {
        type: 'step.started'
        stepId: string
        parentStepId?: string
        name: string
        location?: SourceLocation
        hook?: 'beforeEach' | 'afterEach'
      })
    | (TestScope & { type: 'step.finished'; stepId: string; status: 'passed' | 'failed'; durationMs: number; failure?: Failure })
    | (AssertionFields & { type: 'assertion.passed' })
    | (AssertionFields & { type: 'assertion.failed'; failure: Failure })
  )

/**
 * An event before the parent stamps it. Page URLs are origin and path, with no query or fragment. The
 * browser's `pid` is also its process group, and so is an app server's. `browser.started` comes once for
 * each app target, the first time it is used; app targets that launch the same browser share its `pid`.
 * `file.failed` is a collected file whose process failed outside its tests. The failure on `run.finished`
 * is the run's own, one that no single test explains, such as a browser that did not start or output that
 * could not be kept. State events never carry the state itself.
 */
export type EventBody =
  | (ChildEvent & VariantScope)
  | (Common &
      (
        | {
            type: 'run.started'
            retestVersion: string
            node: string
            platform: string
            rootDir: string
            files: string[]
            options: {
              /** Milestone 1's mode: the base URL and the browser given on the command line. */
              baseUrl?: string
              browserPath?: string
              /** A run from a config: its path relative to the root, and the base URLs the command line replaced, by app. */
              config?: string
              baseUrls?: Record<string, string>
              timeouts: Timeouts
              /** The budgets the command line gave, which a rerun command repeats. Absent when there was no command line. */
              commandLineTimeouts?: Partial<Timeouts>
              reporter: string
            }
          }
        | {
            type: 'browser.started'
            product: string
            version: string
            userAgent: string
            pid: number
            executablePath: string
            app?: string
            target?: TargetInfo
          }
        | { type: 'app.started'; app: string; ready: string; pid: number; durationMs: number }
        | { type: 'app.reused'; app: string; ready: string }
        | { type: 'app.failed'; app: string; ready: string; failure: Failure }
        | { type: 'collection.completed'; file: string; tests: CollectedTest[] }
        | { type: 'collection.failed'; file: string; failure: Failure }
        | { type: 'file.failed'; file: string; failure: Failure }
        | (AttemptScope & {
            type: 'test.started'
            name: string
            file: string
            location: SourceLocation
            describePath?: string[]
            setup?: true
          })
        | (AttemptScope & { type: 'state.saved'; state: string; app: string; target: string })
        | (AttemptScope & { type: 'state.restored'; state: string; app: string; target: string })
        | (ActionFields & { type: 'action.completed' })
        | (ActionFields & { type: 'action.failed'; failure: Failure })
        | (StepScope & { type: 'navigation'; url: string })
        | (AttemptScope & { type: 'evidence.captured'; kind: 'screenshot'; path: string; reason: 'failure' })
        | (AttemptScope & { type: 'evidence.failed'; kind: 'screenshot'; reason: 'failure'; message: string })
        | (AttemptScope & {
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
const processId = s.number({ integer: true, min: 1 })
const names = s.optional(s.array(s.string()))

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
export const targetInfoSchema: Schema<TargetInfo> = s.object({
  name: s.string(),
  emulation: s.optional(emulationSchema),
  device: s.optional(s.string()),
})

const collectedTestSchema: Schema<CollectedTest> = s.object({
  testId: s.string(),
  name: s.string(),
  location: sourceLocationSchema,
  row: s.optional(s.number({ integer: true, min: 1 })),
  describePath: names,
  tags: names,
  apps: names,
  setup: s.optional(s.literal(true)),
  setupFor: names,
  variants: s.optional(s.array(variantSchema)),
})

const common = { session: s.optional(s.string()) }
const envelope = {
  schemaVersion: s.literal(1),
  runId: s.string(),
  sequence: count,
  time: s.string(),
  elapsedMs: duration,
  origin: s.enum(['parent', 'child']),
  ...common,
}
const testScope = { testId: s.string(), attemptId: s.string() }
const variantScope = { variant: s.optional(variantSchema), variantKey: s.optional(s.string()) }
const attemptScope = { ...testScope, ...variantScope }
const stepScope = { ...attemptScope, stepId: s.optional(s.string()) }
const actionFields = {
  ...stepScope,
  command: actionKindSchema,
  locator: s.optional(locatorRecipeSchema),
  pageUrl: s.optional(s.string()),
  durationMs: duration,
  location: s.optional(sourceLocationSchema),
  valueLength: s.optional(count),
  secret: s.optional(s.string()),
}
const assertionFields = {
  ...testScope,
  stepId: s.optional(s.string()),
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
  soft: s.optional(s.literal(true)),
}
const stateFields = { ...attemptScope, state: s.string(), app: s.string(), target: s.string() }

const stepStarted = {
  type: s.literal('step.started'),
  ...testScope,
  stepId: s.string(),
  parentStepId: s.optional(s.string()),
  name: s.string(),
  location: s.optional(sourceLocationSchema),
  hook: s.optional(s.enum(['beforeEach', 'afterEach'])),
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
      browserPath: s.optional(s.string()),
      config: s.optional(s.string()),
      baseUrls: s.optional(s.record(s.string())),
      timeouts: timeoutsSchema,
      commandLineTimeouts: s.optional(partialTimeoutsSchema),
      reporter: s.string(),
    }),
  }),
  s.object({
    ...envelope,
    type: s.literal('browser.started'),
    product: s.string(),
    version: s.string(),
    userAgent: s.string(),
    pid: processId,
    executablePath: s.string(),
    app: s.optional(s.string()),
    target: s.optional(targetInfoSchema),
  }),
  s.object({ ...envelope, type: s.literal('app.started'), app: s.string(), ready: s.string(), pid: processId, durationMs: duration }),
  s.object({ ...envelope, type: s.literal('app.reused'), app: s.string(), ready: s.string() }),
  s.object({ ...envelope, type: s.literal('app.failed'), app: s.string(), ready: s.string(), failure: failureSchema }),
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
    ...attemptScope,
    name: s.string(),
    file: s.string(),
    location: sourceLocationSchema,
    describePath: names,
    setup: s.optional(s.literal(true)),
  }),
  s.object({ ...envelope, type: s.literal('state.saved'), ...stateFields }),
  s.object({ ...envelope, type: s.literal('state.restored'), ...stateFields }),
  s.object({ ...envelope, ...variantScope, ...stepStarted }),
  s.object({ ...envelope, ...variantScope, ...stepFinished }),
  s.object({ ...envelope, type: s.literal('action.completed'), ...actionFields }),
  s.object({ ...envelope, type: s.literal('action.failed'), ...actionFields, failure: failureSchema }),
  s.object({ ...envelope, type: s.literal('navigation'), ...stepScope, url: s.string() }),
  s.object({ ...envelope, ...variantScope, ...assertionPassed }),
  s.object({ ...envelope, ...variantScope, ...assertionFailed }),
  s.object({
    ...envelope,
    type: s.literal('evidence.captured'),
    ...attemptScope,
    kind: s.literal('screenshot'),
    path: s.string(),
    reason: s.literal('failure'),
  }),
  s.object({
    ...envelope,
    type: s.literal('evidence.failed'),
    ...attemptScope,
    kind: s.literal('screenshot'),
    reason: s.literal('failure'),
    message: s.string(),
  }),
  s.object({
    ...envelope,
    type: s.literal('test.finished'),
    ...attemptScope,
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
