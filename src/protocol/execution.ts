import type { EvaluationRecord, EvidenceKind } from './evaluation.ts'
import type { TestStatus } from './events.ts'
import type { Failure } from './failures.ts'
import type { HostCheckResult } from './host-check.ts'
import type { Timeouts } from './timeouts.ts'
import { diagnosticsPolicyRecordSchema, type DiagnosticsPolicyRecord } from './diagnostics.ts'
import { emulationSchema, type Emulation } from './emulation.ts'
import { s, type Schema } from './schema.ts'
import { timeoutsSchema } from './timeouts.ts'

/**
 * One module a test file's process loaded from the project: its path from the run's root, POSIX, which starts with
 * `../` for a module outside the root, and the SHA-256 of the bytes Node loaded, in hex. Modules under `node_modules`
 * and Retest's own are never listed.
 */
export type ModuleRecord = { path: string; sha256: string }

/**
 * The test bundle a process ran: every module it loaded from the project, sorted by path, and the SHA-256 of that
 * list written as canonical JSON. A changed helper changes its module's hash and so the bundle's.
 */
export type BundleRecord = { sha256: string; modules: ModuleRecord[] }

/**
 * An app's target as it changes how a test runs: the target's name and kind, the browser and channel, whether it
 * runs headless, the named device or the screen it emulates, the proxy, without its credentials, and for an Electron
 * app how many arguments it is started with and the SHA-256 of their list as canonical JSON, never their text. The
 * executable's path, the app's folder and its base URL are left out: they say where things are on this machine, and the
 * browser's own identity is in `sessions`.
 */
export type AppSettings = {
  target: string
  kind: 'web' | 'ios-simulator' | 'macos'
  browser?: string
  channel?: string
  headless?: boolean
  device?: string
  emulation?: Emulation
  proxy?: { server: string; bypass: string[] }
  simulator?: { device: string; runtime: string }
  args?: { count: number; sha256: string }
  environment?: { count: number; sha256: string }
}

/** A secret by name and where it is read from: the variable an `env` source names, or `function`. Never its value. */
export type SecretReference = { name: string; source: 'env' | 'function'; variable?: string }

/** A secret the config declares, by reference, with the origins beyond a test's apps where it may be typed. */
export type SecretDeclaration = { name: string; source: 'env' | 'function'; variable?: string; origins: string[] }

/**
 * A judge as its settings stand: its adapter's kind and module, the code that adapter is, the evidence it accepts, its
 * credentials by name and source, never their values, and the SHA-256 of its options as canonical JSON, every string
 * redacted first. The code is a file adapter's SHA-256, a package adapter's installed version, or `codeUnavailable` for
 * a factory the config gave, or an adapter Retest could not read.
 */
export type JudgeSettings = {
  name: string
  adapter: 'file' | 'package' | 'factory'
  module?: string
  moduleSha256?: string
  packageVersion?: string
  codeUnavailable?: true
  accepts: EvidenceKind[]
  credentials: SecretReference[]
  optionsSha256: string
}

/**
 * The AI evaluation settings in effect for a test: the judges its host AI checks name, the time a check may take, every
 * limit, and the version of the instructions Retest gives a judge.
 */
export type EvaluationSettings = { judges: JudgeSettings[]; timeoutMs: number; limits: Record<string, number>; promptVersion: string }

/** How a run captures console, runtime error and network diagnostics, and what its policy fails a test for. */
export type DiagnosticsSettings = { capture: boolean; policy?: DiagnosticsPolicyRecord; limits: Record<string, number> }

/**
 * What a test attempt runs under, as far as it changes how this test runs: each of its apps' targets, its budgets with
 * its own timeout in place, the locks it holds, the names of the environment its file's process was given, never
 * their values, when the host gave one, the diagnostics policy, the evaluation settings its host AI checks use, and whether
 * its file ran as a Playwright test file.
 */
export type ExecutionSettings = {
  apps: Record<string, AppSettings>
  timeouts: Timeouts
  locks: string[]
  environment?: string[]
  diagnostics: DiagnosticsSettings
  evaluation?: EvaluationSettings
  playwright?: true
}

/** The settings and the SHA-256 of their canonical JSON. */
export type ConfigurationRecord = { sha256: string; settings: ExecutionSettings }

/** What ran the test: Retest's version, Node's and the platform, as `process.platform-process.arch`. */
export type RuntimeRecord = { retest: string; node: string; platform: string }

/**
 * What a session takes while it runs: a context in a browser others share, an Electron app launched for this attempt
 * alone, an Electron app on the data folder its target names, which one attempt holds at a time, the Mac's interactive
 * desktop, or a simulator device.
 */
export type SessionResource = 'browser-context' | 'app-launch' | 'data-folder' | 'desktop' | 'device'

/**
 * A session of the attempt: its app, its id, the browser it ran in as the browser reported itself, and the resource it
 * took. `resource` is absent in runs recorded before it.
 */
/** The native executor's identity as a portable JSON record. */
export type NativeExecutionRecord = {
  platform: 'ios-simulator' | 'macos'
  app: { bundleId: string; version?: string; build?: string; path: string; sha256: string }
  os: { name: 'iOS' | 'macOS'; version: string; build: string }
  device?: { name: string; type: string; udid: string }
  executor: { name: string; version: string; commit: string; commitVerified: boolean; productsSha256: string; codeDirectoryHash?: string; origin: 'built' | 'adopted' }
  xcode: { version: string; build: string }
}

export type SessionRecord = { app: string; sessionId: string; engine: string; product: string; version: string; resource?: SessionResource; native?: NativeExecutionRecord }

/**
 * One check a host requires, in a requirement version: its id, which never changes within the version, whether it
 * reads a page or asks a judge, and the SHA-256 of its content as canonical JSON. A check whose content changes
 * cannot keep its id in the same version.
 */
export type RequirementCheck = { id: string; kind: 'page' | 'evaluation'; sha256: string }

/** The requirement a test attempt was held to: its version, its checks, and the SHA-256 of both together. */
export type RequirementRecord = { version: string; sha256: string; checks: RequirementCheck[] }

/**
 * What a host declared about an app's backend data at the start of an attempt: `prepared` by its preparation, `reused`
 * from earlier attempts on purpose, `external`, managed by someone else, or `unavailable`, which says Retest was told
 * nothing. Fresh browser storage never says anything about the backend.
 */
export type BackendData = 'prepared' | 'reused' | 'external' | 'unavailable'

/**
 * Where an app of an attempt started: its browser storage, new, restored from a saved state, which it names, reused
 * from the data folder its Electron target names, which earlier launches may have changed, or `none` for a native app,
 * which has no browser storage and says what its relaunch resets in `native`; and its backend data as the host declared it.
 */
export type NativeStartingState = { appData: 'reset' | 'kept'; keychain: 'reset' | 'kept'; boundary: string; appReset?: true; notIsolated: string[] }

export type StartingState = { app: string; browserStorage: 'fresh' | 'saved' | 'reused' | 'none'; native?: NativeStartingState; state?: string; backendData: BackendData }

/**
 * The identity of one attempt's execution, as the parent recorded it before the attempt's first action: the bundle
 * the test file's process loaded, the configuration and its fingerprint, the runtime, each session and the browser it
 * runs in, the session owner, the app builds the host named, the requirement and where each app started.
 * `unavailable` names each identity Retest could not record, as `bundle` or `app-build:<app>`.
 */
export type ExecutionRecord = {
  bundle?: BundleRecord
  configuration: ConfigurationRecord
  /** The secrets the config declares, by reference. Which of them a test types is not known before it runs, so they are not fingerprinted. */
  secretReferences?: SecretDeclaration[]
  runtime: RuntimeRecord
  sessions: SessionRecord[]
  owner?: string
  appBuilds?: Record<string, string>
  requirement?: RequirementRecord
  startingState: StartingState[]
  unavailable?: string[]
}

/**
 * How a host's preparation of an attempt ended: `prepared`, `failed` when it said so or threw, `uncertain` when Retest
 * cannot tell, as when it did not answer in time or answered something unreadable, `cancelled` when the run stopped
 * while it ran, and `not_run` when it was never called: an earlier preparation of the attempt did not succeed, or the
 * run had stopped. A preparation never called has no cleanup.
 */
export type PreparationOutcome = 'prepared' | 'failed' | 'uncertain' | 'cancelled' | 'not_run'

/**
 * One preparation of an attempt: the key it was given under, the apps whose backend it covers, the backend data it
 * declared, how it ended, and what it reported: the recipe or fixture version, a seed, an opaque receipt and flat
 * metadata, each redacted. A receipt names an operation; it does not prove the data is the same.
 */
export type PreparationRecord = {
  key: string
  apps: string[]
  backendData: BackendData
  outcome: PreparationOutcome
  recipe?: string
  seed?: string | number
  receipt?: string
  metadata?: Record<string, string | number | boolean>
  reason?: string
  durationMs: number
}

/** How a host's cleanup of an attempt ended. `timed_out` gave up waiting; what it started may still be running. */
export type CleanupRecord = { key: string; outcome: 'done' | 'failed' | 'timed_out'; reason?: string; durationMs: number }

/**
 * What ended an attempt, as a caller comparing attempts reads it. `assertion_failed` is one of the test's own checks;
 * `required_check_failed` a host's check, named by `checkId` when it has an id; `action_failed` an action that failed
 * before any check decided; `crashed` a lost browser or a test process that ended on its own; `cancelled` a stopped
 * run; `outcome_unknown` an action whose effect nobody knows; `check_error` a required check the parent could not
 * complete, as when a page did not answer it or required evidence was incomplete. `notRun` names the host's required
 * checks that never ran. A kind that names a check, a crash or an unknown outcome rests on the parent's own records.
 */
export type EndingKind =
  | 'passed'
  | 'skipped'
  | 'not_run'
  | 'assertion_failed'
  | 'required_check_failed'
  | 'check_error'
  | 'inconclusive'
  | 'evaluation_error'
  | 'setup_failed'
  | 'action_failed'
  | 'timed_out'
  | 'test_error'
  | 'crashed'
  | 'cancelled'
  | 'outcome_unknown'
  | 'cleanup_failed'

export type Ending = { kind: EndingKind; checkId?: string; notRun?: string[] }

const hex = s.string()
const names = s.array(s.string())

export const moduleRecordSchema: Schema<ModuleRecord> = s.object({ path: s.string(), sha256: hex })

export const bundleRecordSchema: Schema<BundleRecord> = s.object({ sha256: hex, modules: s.array(moduleRecordSchema) })

const secretReferenceShape = { name: s.string(), source: s.enum(['env', 'function']), variable: s.optional(s.string()) }

const appSettingsSchema: Schema<AppSettings> = s.object({
  target: s.string(),
  kind: s.enum(['web', 'ios-simulator', 'macos']),
  browser: s.optional(s.string()),
  channel: s.optional(s.string()),
  headless: s.optional(s.boolean()),
  device: s.optional(s.string()),
  emulation: s.optional(emulationSchema),
  proxy: s.optional(s.object({ server: s.string(), bypass: names })),
  simulator: s.optional(s.object({ device: s.string(), runtime: s.string() })),
  args: s.optional(s.object({ count: s.number({ integer: true, min: 1 }), sha256: hex })),
  environment: s.optional(s.object({ count: s.number({ integer: true, min: 1 }), sha256: hex })),
})

export const executionSettingsSchema: Schema<ExecutionSettings> = s.object({
  apps: s.record(appSettingsSchema),
  timeouts: timeoutsSchema,
  locks: names,
  environment: s.optional(names),
  diagnostics: s.object({ capture: s.boolean(), policy: s.optional(diagnosticsPolicyRecordSchema), limits: s.record(s.number({ min: 0 })) }),
  evaluation: s.optional(
    s.object({
      judges: s.array(
        s.object({
          name: s.string(),
          adapter: s.enum(['file', 'package', 'factory']),
          module: s.optional(s.string()),
          moduleSha256: s.optional(hex),
          packageVersion: s.optional(s.string()),
          codeUnavailable: s.optional(s.literal(true)),
          accepts: s.array(s.enum(['text', 'images', 'frames'])),
          credentials: s.array(s.object(secretReferenceShape)),
          optionsSha256: hex,
        }),
      ),
      timeoutMs: s.number({ integer: true, min: 1 }),
      limits: s.record(s.number({ min: 0 })),
      promptVersion: s.string(),
    }),
  ),
  playwright: s.optional(s.literal(true)),
})

const backendDataSchema = s.enum(['prepared', 'reused', 'external', 'unavailable'])

export const requirementCheckSchema: Schema<RequirementCheck> = s.object({ id: s.string(), kind: s.enum(['page', 'evaluation']), sha256: hex })

export const nativeExecutionIdentitySchema: Schema<NativeExecutionRecord> = s.object({
  platform: s.enum(['ios-simulator', 'macos']),
  app: s.object({ bundleId: s.string(), version: s.optional(s.string()), build: s.optional(s.string()), path: s.string(), sha256: hex }),
  os: s.object({ name: s.enum(['iOS', 'macOS']), version: s.string(), build: s.string() }),
  device: s.optional(s.object({ name: s.string(), type: s.string(), udid: s.string() })),
  executor: s.object({ name: s.string(), version: s.string(), commit: s.string(), commitVerified: s.boolean(), productsSha256: hex, codeDirectoryHash: s.optional(s.string()), origin: s.enum(['built', 'adopted']) }),
  xcode: s.object({ version: s.string(), build: s.string() }),
})

export const nativeStartingStateSchema: Schema<NativeStartingState> = s.object({
  appData: s.enum(['reset', 'kept']), keychain: s.enum(['reset', 'kept']), boundary: s.string(), appReset: s.optional(s.literal(true)), notIsolated: names,
})

export const executionRecordSchema: Schema<ExecutionRecord> = s.object({
  bundle: s.optional(bundleRecordSchema),
  configuration: s.object({ sha256: hex, settings: executionSettingsSchema }),
  secretReferences: s.optional(s.array(s.object({ ...secretReferenceShape, origins: names }))),
  runtime: s.object({ retest: s.string(), node: s.string(), platform: s.string() }),
  sessions: s.array(
    s.object({
      app: s.string(),
      sessionId: s.string(),
      engine: s.string(),
      product: s.string(),
      version: s.string(),
      resource: s.optional(s.enum(['browser-context', 'app-launch', 'data-folder', 'desktop', 'device'])),
      native: s.optional(nativeExecutionIdentitySchema),
    }),
  ),
  owner: s.optional(s.string()),
  appBuilds: s.optional(s.record(s.string())),
  requirement: s.optional(s.object({ version: s.string(), sha256: hex, checks: s.array(requirementCheckSchema) })),
  startingState: s.array(s.object({ app: s.string(), browserStorage: s.enum(['fresh', 'saved', 'reused', 'none']), native: s.optional(nativeStartingStateSchema), state: s.optional(s.string()), backendData: backendDataSchema })),
  unavailable: s.optional(names),
})

export const preparationRecordSchema: Schema<PreparationRecord> = s.object({
  key: s.string(),
  apps: names,
  backendData: backendDataSchema,
  outcome: s.enum(['prepared', 'failed', 'uncertain', 'cancelled', 'not_run']),
  recipe: s.optional(s.string()),
  seed: s.optional(s.union([s.string(), s.number()])),
  receipt: s.optional(s.string()),
  metadata: s.optional(s.record(s.union([s.string(), s.number(), s.boolean()]))),
  reason: s.optional(s.string()),
  durationMs: s.number({ min: 0 }),
})

export const cleanupRecordSchema: Schema<CleanupRecord> = s.object({
  key: s.string(),
  outcome: s.enum(['done', 'failed', 'timed_out']),
  reason: s.optional(s.string()),
  durationMs: s.number({ min: 0 }),
})

export const endingSchema: Schema<Ending> = s.object({
  kind: s.enum([
    'passed',
    'skipped',
    'not_run',
    'assertion_failed',
    'required_check_failed',
    'check_error',
    'inconclusive',
    'evaluation_error',
    'setup_failed',
    'action_failed',
    'timed_out',
    'test_error',
    'crashed',
    'cancelled',
    'outcome_unknown',
    'cleanup_failed',
  ]),
  checkId: s.optional(s.string()),
  notRun: s.optional(names),
})

/**
 * A value as JSON with every object's keys in code-unit order, so the same value always writes the same text.
 * Arrays keep their order. `undefined` properties are left out, as `JSON.stringify` leaves them.
 *
 * @example canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }) // '{"a":[2,{"c":4,"d":3}],"b":1}'
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sorted(value))
}

/** Whether text is a SHA-256 in hex, as Retest writes one. */
export function isSha256(text: string): boolean {
  return /^[0-9a-f]{64}$/.test(text)
}

/**
 * An execution record with the bundle the attempt ran in the end in place of the one it started with, which is then no
 * longer unavailable.
 *
 * @example withFinalBundle(started, bundle).bundle === bundle // true
 */
export function withFinalBundle(execution: ExecutionRecord, bundle: BundleRecord | undefined): ExecutionRecord {
  if (bundle === undefined) return execution
  const unavailable = (execution.unavailable ?? []).filter((name) => name !== 'bundle')
  const { unavailable: _unavailable, ...rest } = execution
  return { ...rest, bundle, ...(unavailable.length === 0 ? {} : { unavailable }) }
}

/**
 * What decides an attempt's ending, every fact the parent's own: its status and failure, its host checks and AI checks
 * as the parent ran them, the failures the parent saw for itself during the attempt (its revocations, the pages'
 * answers, the assertions it judged failed, its preparation, its pages and its policies), whether the test file's
 * process ended on its own, whether a browser of the attempt was gone, and the run's interruption.
 */
export type EndingFacts = {
  status: TestStatus
  failure?: Failure | undefined
  cleanupFailures?: readonly Failure[] | undefined
  hostChecks?: readonly HostCheckResult[] | undefined
  evaluations?: readonly EvaluationRecord[] | undefined
  seen?: readonly Failure[] | undefined
  crashed?: boolean
  browserLost?: boolean
  interruption?: Failure | undefined
}

/**
 * What ended an attempt. A kind that names a required check, a crash or an unknown outcome needs the parent to have seen
 * it: a failure the test file's process only reports, whatever class it gives, is the test's own, an assertion for a
 * failed check or an `expect.poll` that ran out of time, and a test error otherwise. A test that never ran says `not_run`,
 * or `cancelled` when the run's interruption kept it from running.
 *
 * @example attemptEnding({ status: 'failed', failure: { class: 'check_failed', message: '…' } }).kind // 'assertion_failed'
 */
export function attemptEnding(facts: EndingFacts): Ending {
  const notRun = [
    ...(facts.hostChecks ?? []).flatMap((result) => (result.status === 'not_run' && result.check.id !== undefined ? [result.check.id] : [])),
    ...(facts.evaluations ?? []).flatMap((record) => (record.source === 'host' && record.verdict === 'not_run' ? [record.checkId] : [])),
  ]
  const listed = notRun.length === 0 ? {} : { notRun }
  const { status, failure: lead, interruption } = facts
  if (status === 'passed' || status === 'skipped') return { kind: status }
  const interrupted = lead !== undefined && interruption !== undefined && sameFailure(lead, interruption)
  if (status === 'not_run') return { kind: interrupted ? 'cancelled' : 'not_run', ...listed }
  if (lead === undefined) return { kind: (facts.cleanupFailures?.length ?? 0) > 0 ? 'cleanup_failed' : 'test_error', ...listed }
  if (facts.crashed === true) return { kind: 'crashed', ...listed }
  if (interrupted) return { kind: 'cancelled', ...listed }
  const check = (facts.hostChecks ?? []).find((result) => result.status === 'failed' && result.failure !== undefined && sameFailure(result.failure, lead))
  if (check !== undefined) {
    const identified = check.check.id === undefined ? {} : { checkId: check.check.id }
    if (lead.class === 'host_check_failed') return { kind: 'required_check_failed', ...identified, ...listed }
    return { kind: lead.class === 'session_lost' && facts.browserLost === true ? 'crashed' : 'check_error', ...identified, ...listed }
  }
  const judged = (facts.evaluations ?? []).find((record) => record.failure !== undefined && sameFailure(record.failure, lead))
  if (judged !== undefined) return { ...judgedEnding(judged), ...listed }
  if ((facts.seen ?? []).some((each) => sameFailure(each, lead))) return { kind: seenEnding(lead), ...listed }
  return { kind: lead.class === 'check_failed' || lead.class === 'timeout' ? 'assertion_failed' : 'test_error', ...listed }
}

// A check's own record decides: a host's check names its id, and a test's own required check is one of its assertions.
function judgedEnding(record: EvaluationRecord): Ending {
  const host = record.source === 'host'
  const identified = host ? { checkId: record.checkId } : {}
  switch (record.failure?.class) {
    case 'evaluation_failed':
      return host ? { kind: 'required_check_failed', ...identified } : { kind: 'assertion_failed' }
    case 'evaluation_inconclusive':
      return { kind: 'inconclusive', ...identified }
    default:
      return { kind: 'evaluation_error', ...identified }
  }
}

// A failure the parent saw for itself, by its class. A host-wide policy, such as a strict diagnostics policy, fails a
// test as a required check does; required evidence that was incomplete is a check the parent could not complete.
function seenEnding(failure: Failure): EndingKind {
  switch (failure.class) {
    case 'check_failed':
      return 'assertion_failed'
    case 'host_check_failed':
      return 'required_check_failed'
    case 'reporting_failed':
      return 'check_error'
    case 'not_found':
    case 'ambiguous':
    case 'not_actionable':
    case 'unsupported':
      return 'action_failed'
    case 'timeout':
      return /^The test ran longer than its \d+ ms budget/.test(failure.message) ? 'timed_out' : 'action_failed'
    case 'setup_failed':
    case 'collection_failed':
      return 'setup_failed'
    case 'session_lost':
      return 'crashed'
    case 'outcome_unknown':
      return 'outcome_unknown'
    case 'interrupted':
      return 'cancelled'
    case 'cleanup_failed':
      return 'cleanup_failed'
    case 'evaluation_inconclusive':
      return 'inconclusive'
    case 'evaluation_error':
      return 'evaluation_error'
    default:
      return 'test_error'
  }
}

// Two failures are one when their class and message are: details such as `also` are added along the way.
function sameFailure(first: Failure, second: Failure): boolean {
  return first.class === second.class && first.message === second.message
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => sorted(item))
  if (typeof value !== 'object' || value === null) return value
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  entries.sort(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
  return Object.fromEntries(entries.map(([key, item]) => [key, sorted(item)]))
}
