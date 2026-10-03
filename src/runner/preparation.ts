import type { BackendData, CleanupRecord, PreparationOutcome, PreparationRecord } from '../protocol/execution.ts'
import type { EventBody } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Variant } from '../protocol/variant.ts'
import type { PlannedTest } from './plan.ts'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { unmatchedHostCheckKeys } from '../protocol/host-check.ts'
import { isName } from '../protocol/names.ts'
import { describeValue, formatPath, isArray, isPlainObject } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { bounded } from './bounded.ts'

/**
 * What a host's preparation reports when it has prepared the attempt's starting state: the recipe or fixture it used
 * and its version, the seed where one decides the data, an opaque receipt that names the operation, and flat metadata
 * about the policy it applied. None of it may hold a secret or a dump of data: every string is redacted, and each is
 * held to a length.
 */
export type PreparedState = {
  readonly recipe: string
  readonly seed?: string | number
  readonly receipt?: string
  readonly metadata?: Readonly<Record<string, string | number | boolean>>
}

/**
 * A preparation's answer: `prepared`, with what it prepared, or `failed` or `uncertain` with the reason, when it knows
 * it did not prepare the state or cannot tell whether it did. An error it throws counts as `failed`.
 */
export type PreparationAnswer = ({ readonly status: 'prepared' } & PreparedState) | { readonly status: 'failed' | 'uncertain'; readonly reason: string }

/**
 * What a preparation is told about the attempt it prepares: the key it was given under, the test, its attempt, its
 * file, the apps whose backend it covers, the target each app runs on in a run from a config, the session owner, and
 * its time. `signal` is aborted when its time runs out or the run stops; giving up does not undo what it started.
 */
export type PreparationContext = {
  readonly key: string
  readonly testId: string
  readonly attemptId: string
  readonly file: string
  readonly apps: readonly string[]
  readonly variant?: Readonly<Variant>
  readonly owner?: string
  readonly timeoutMs: number
  readonly signal: AbortSignal
}

/**
 * What a cleanup is told: what its preparation was told, how the preparation ended and what it prepared, absent when it
 * had nothing to prepare, and whether the attempt had failed by then. It runs after the body, after a failure and after
 * the run was stopped, within its own time.
 */
export type CleanupContext = PreparationContext & {
  readonly preparation?: Exclude<PreparationOutcome, 'not_run'>
  readonly prepared?: PreparedState
  readonly failed: boolean
}

/**
 * A host's preparation and cleanup for the tests a key names, as `RunOptions.prepare` gives them. `prepare` runs once
 * the attempt has its browsers, locks and sessions and before it opens a page; `cleanup` runs once the attempt is over,
 * whenever its preparation's turn came, even when `prepare` failed or there was none. `backendData` declares the backend without preparing it: `reused` on purpose, or `external`,
 * managed elsewhere; a preparation that prepares declares `prepared` by itself, so the two never go together. `apps`
 * are the apps whose backend it covers, every app of the test by default. `timeoutMs` and `cleanupTimeoutMs` default
 * to the setup and cleanup budgets.
 */
export type HostPreparation = {
  readonly prepare?: (context: PreparationContext) => Promise<PreparationAnswer>
  readonly cleanup?: (context: CleanupContext) => Promise<void>
  readonly backendData?: 'reused' | 'external'
  readonly apps?: readonly string[]
  readonly timeoutMs?: number
  readonly cleanupTimeoutMs?: number
}

/** Host preparations by test id or by file, as `RunOptions.prepare` gives them. */
export type HostPreparations = Readonly<Record<string, HostPreparation>>

/** One preparation of a test: the key it came from, what it does, and the apps it covers. */
export type TestPreparation = { readonly key: string; readonly preparation: HostPreparation; readonly apps: readonly string[] }

/** What a preparation run needs from the attempt and the run. */
export type PrepareOptions = {
  preparations: readonly TestPreparation[]
  scope: { testId: string; attemptId: string; file: string; variant?: Variant; owner?: string }
  timeouts: { setup: number; cleanup: number }
  /** Settles when the run is interrupted. */
  stopped: Promise<void>
  interruption: () => Failure | undefined
  emit: (body: EventBody) => void
  redact: (text: string) => string
}

/** How the preparations of an attempt ended, and the cleanup to run once it is over, whatever happened. */
export type PreparedAttempt = {
  /** The attempt's failure when a preparation did not succeed: its body must not run. */
  failure?: Failure
  records: PreparationRecord[]
  cleanUp(failed: boolean): Promise<{ failures: Failure[]; records: CleanupRecord[] }>
}

const preparationKeys = new Set(['prepare', 'cleanup', 'backendData', 'apps', 'timeoutMs', 'cleanupTimeoutMs'])
// Bounds on what a preparation reports, so a record stays a record and never becomes a dump.
const longestText = 500
const mostMetadata = 32

/**
 * Everything wrong with a `prepare` option that can be told without the tests, as one usage failure naming each key,
 * or undefined. A key set to undefined counts as absent, and any key a preparation does not have is refused.
 *
 * @example preparationsShapeProblem({ 'a.retest.ts': { prepare: 'reset' } })?.class // 'usage'
 */
export function preparationsShapeProblem(value: unknown): Failure | undefined {
  if (value === undefined) return undefined
  const problems: string[] = []
  const add = (path: (string | number)[], message: string): void => void problems.push(`${formatPath(['prepare', ...path]).slice(2)}: ${message}`)
  if (!isPlainObject(value)) return usage([`prepare: expected preparations by test id or file, received ${describeValue(value)}`])
  for (const [key, entry] of Object.entries(value)) {
    if (!isPlainObject(entry)) {
      add([key], `expected { prepare, cleanup, backendData, apps, timeoutMs, cleanupTimeoutMs }, received ${describeValue(entry)}`)
      continue
    }
    const given = Object.fromEntries(Object.entries(entry).filter(([, item]) => item !== undefined))
    for (const name of Object.keys(given)) if (!preparationKeys.has(name)) add([key, name], 'unknown key')
    for (const name of ['prepare', 'cleanup']) if (name in given && typeof given[name] !== 'function') add([key, name], `expected a function, received ${describeValue(given[name])}`)
    if ('backendData' in given && given['backendData'] !== 'reused' && given['backendData'] !== 'external') add([key, 'backendData'], `expected "reused" or "external", received ${describeValue(given['backendData'])}`)
    if ('backendData' in given && 'prepare' in given) add([key, 'backendData'], 'a preparation that prepares declares "prepared" itself, so give prepare or backendData, not both')
    if ('apps' in given && (!isArray(given['apps']) || given['apps'].length === 0 || !given['apps'].every((app) => typeof app === 'string' && isName(app)))) {
      add([key, 'apps'], `expected a list of app names, received ${describeValue(given['apps'])}`)
    }
    for (const name of ['timeoutMs', 'cleanupTimeoutMs']) if (name in given && !isBudget(given[name])) add([key, name], `expected a whole number of milliseconds from 1 to ${maxTimeout}, received ${describeValue(given[name])}`)
  }
  return usage(problems)
}

/**
 * What the run must refuse before any test starts, once it knows its tests: a key that names none of them and no file
 * one comes from, and an app a covered test does not use. A key that names a file which could not be collected is left
 * to that file's own failure.
 *
 * @example preparationsScopeProblem(preparations, scheduledTests, [])
 */
export function preparationsScopeProblem(preparations: HostPreparations, tests: readonly PlannedTest[], unloadedFiles: readonly string[]): Failure | undefined {
  const unloaded = (key: string): boolean => unloadedFiles.some((file) => key === file || key.startsWith(`${file} > `))
  const problems = unmatchedHostCheckKeys(preparations, tests)
    .filter((key) => !unloaded(key))
    .map((key) => `${formatPath(['prepare', key]).slice(2)}: names no test this run will run, and no file one comes from.`)
  for (const [key, { apps }] of Object.entries(preparations)) {
    const lacking = apps === undefined ? undefined : tests.find((test) => (test.testId === key || test.file === key) && apps.some((app) => !test.apps.includes(app)))
    if (apps !== undefined && lacking !== undefined) {
      const missing = apps.filter((app) => !lacking.apps.includes(app)).join(', ')
      problems.push(`${formatPath(['prepare', key, 'apps']).slice(2)}: ${missing} is not an app of ${JSON.stringify(lacking.testId)}, which uses ${lacking.apps.join(', ')}.`)
    }
  }
  return usage(problems)
}

/**
 * A test's preparations in the order they run, its file's first, each with the apps it covers.
 *
 * @example testPreparations(preparations, plannedTest).map(({ key }) => key) // ['tests/a.retest.ts', 'tests/a.retest.ts > saves']
 */
export function testPreparations(preparations: HostPreparations | undefined, test: PlannedTest): TestPreparation[] {
  if (preparations === undefined) return []
  const keyed = [test.file, test.testId].filter((key) => Object.hasOwn(preparations, key))
  return keyed.flatMap((key) => {
    const preparation = preparations[key]
    return preparation === undefined ? [] : [{ key, preparation, apps: preparation.apps ?? test.apps }]
  })
}

/**
 * What a host declared about an app's backend data: `prepared` when a preparation that prepares covers it, otherwise
 * `external` or `reused` as declared, and `unavailable` when nothing was. The record of the preparation says whether it
 * succeeded.
 *
 * @example declaredBackend(testPreparations(preparations, test), 'web') // 'prepared'
 */
export function declaredBackend(preparations: readonly TestPreparation[], app: string): BackendData {
  const covering = preparations.filter((entry) => entry.apps.includes(app))
  if (covering.some((entry) => entry.preparation.prepare !== undefined)) return 'prepared'
  if (covering.some((entry) => entry.preparation.backendData === 'external')) return 'external'
  return covering.some((entry) => entry.preparation.backendData === 'reused') ? 'reused' : 'unavailable'
}

/**
 * Runs an attempt's preparations in order, each within its own time, and records how each ended. The first that does
 * not succeed ends the attempt before it acts on any app: the rest are not run, and its failure is `setup_failed`, or
 * the run's interruption when the run stopped. The cleanup it returns runs every cleanup whose preparation started,
 * in reverse order, each within its own time; a cleanup that fails is reported beside the attempt's failure, never in
 * its place.
 *
 * @example const prepared = await prepareAttempt(options); if (prepared.failure === undefined) await runBody()
 */
export async function prepareAttempt(options: PrepareOptions): Promise<PreparedAttempt> {
  const records: PreparationRecord[] = []
  const started: { entry: TestPreparation; outcome?: Exclude<PreparationOutcome, 'not_run'>; prepared?: PreparedState }[] = []
  let attemptFailure: Failure | undefined
  // A declaration with nothing to prepare has no record of its own: the attempt's starting state carries it. A
  // preparation never called, because an earlier one did not succeed or the run had stopped, is not run, and nothing
  // of it is cleaned up.
  for (const entry of options.preparations) {
    const { prepare } = entry.preparation
    const head = { key: entry.key, apps: [...entry.apps], backendData: 'prepared' as const }
    const stoppedFirst = options.interruption()
    if (attemptFailure !== undefined || stoppedFirst !== undefined) {
      const reason = attemptFailure === undefined && stoppedFirst !== undefined ? { reason: cut(options.redact(`The run stopped before it was called: ${stoppedFirst.message}`)) } : {}
      if (prepare !== undefined) records.push(emitted(options, { ...head, outcome: 'not_run', ...reason, durationMs: 0 }))
      attemptFailure ??= stoppedFirst
      continue
    }
    if (prepare === undefined) {
      started.push({ entry })
      continue
    }
    const ran = await runPrepare(entry, prepare, options)
    records.push(emitted(options, { ...head, ...ran.record }))
    started.push({ entry, outcome: ran.outcome, ...(ran.prepared === undefined ? {} : { prepared: ran.prepared }) })
    attemptFailure = ran.failure
  }
  return {
    ...(attemptFailure === undefined ? {} : { failure: attemptFailure }),
    records,
    cleanUp: async (failed) => {
      const failures: Failure[] = []
      const cleaned: CleanupRecord[] = []
      for (const { entry, outcome, prepared } of started.toReversed()) {
        const { cleanup } = entry.preparation
        if (cleanup === undefined) continue
        const ended = await runCleanup(entry, cleanup, { ...options, failed, ...(outcome === undefined ? {} : { outcome }), ...(prepared === undefined ? {} : { prepared }) })
        cleaned.push(ended.record)
        options.emit({ type: 'cleanup.finished', testId: options.scope.testId, attemptId: options.scope.attemptId, cleanup: ended.record })
        if (ended.failure !== undefined) failures.push(ended.failure)
      }
      return { failures, records: cleaned }
    },
  }
}

type Ran = {
  outcome: Exclude<PreparationOutcome, 'not_run'>
  prepared?: PreparedState
  record: Omit<PreparationRecord, 'key' | 'apps' | 'backendData'>
  failure?: Failure
}

// One that throws failed; one that does not answer in time, or answers what Retest cannot read, is uncertain, since
// the work it started may have done anything.
async function runPrepare(entry: TestPreparation, prepare: NonNullable<HostPreparation['prepare']>, options: PrepareOptions): Promise<Ran> {
  const startedAt = monotonicClock()
  const timeoutMs = entry.preparation.timeoutMs ?? options.timeouts.setup
  const stop = new AbortController()
  const context = contextFor(entry, options, timeoutMs, stop.signal)
  const answered = await bounded(new Promise<PreparationAnswer>((resolve) => resolve(prepare(context))), timeoutMs, options.stopped)
  const durationMs = elapsedMs(startedAt)
  const redact = options.redact
  if (answered.status === 'stopped') {
    const interruption = options.interruption() ?? failure('interrupted', 'The run was interrupted.')
    stop.abort(interruption)
    return { outcome: 'cancelled', record: { outcome: 'cancelled', reason: cut(redact(interruption.message)), durationMs }, failure: interruption }
  }
  if (answered.status === 'timed_out') {
    stop.abort(new DOMException(`The preparation took longer than ${timeoutMs} ms.`, 'TimeoutError'))
    return unsettled(entry, 'uncertain', `it did not answer within ${timeoutMs} ms, and what it started may still be running`, durationMs)
  }
  if (answered.status === 'failed') return unsettled(entry, 'failed', cut(`it threw: ${redact(errorMessage(answered.error))}`), durationMs)
  const read = readAnswer(answered.value)
  if (!read.ok) return unsettled(entry, 'uncertain', cut(redact(read.problem)), durationMs)
  if (read.answer.status !== 'prepared') return unsettled(entry, read.answer.status, cut(`it said: ${redact(read.answer.reason)}`), durationMs)
  // The host's cleanup is given what its preparation answered, as it answered it; only the record is redacted.
  const { status: _status, ...prepared } = read.answer
  return { outcome: 'prepared', prepared, record: { outcome: 'prepared', ...redactedState(prepared, redact), durationMs } }
}

function redactedState(state: PreparedState, redact: (text: string) => string): PreparedState {
  const metadata = state.metadata === undefined ? undefined : Object.fromEntries(Object.entries(state.metadata).map(([key, item]) => [key, typeof item === 'string' ? redact(item) : item]))
  return {
    recipe: redact(state.recipe),
    ...(state.seed === undefined ? {} : { seed: typeof state.seed === 'string' ? redact(state.seed) : state.seed }),
    ...(state.receipt === undefined ? {} : { receipt: redact(state.receipt) }),
    ...(metadata === undefined ? {} : { metadata }),
  }
}

function unsettled(entry: TestPreparation, outcome: 'failed' | 'uncertain', reason: string, durationMs: number): Ran {
  const verb = outcome === 'failed' ? 'failed' : 'could not be confirmed'
  const message = `The host's preparation for ${JSON.stringify(entry.key)} ${verb}, so the test did not act on any app: ${reason}.`
  const attemptFailure: Failure = { ...failure('setup_failed', message), details: { preparation: entry.key, outcome } }
  return { outcome, record: { outcome, reason, durationMs }, failure: attemptFailure }
}

type CleanupOptions = PrepareOptions & { outcome?: Exclude<PreparationOutcome, 'not_run'>; failed: boolean; prepared?: PreparedState }

// A cleanup runs even after the run was stopped: what the host started is its to undo, and its own time bounds it.
async function runCleanup(entry: TestPreparation, cleanup: NonNullable<HostPreparation['cleanup']>, options: CleanupOptions): Promise<{ record: CleanupRecord; failure?: Failure }> {
  const startedAt = monotonicClock()
  const timeoutMs = entry.preparation.cleanupTimeoutMs ?? options.timeouts.cleanup
  const stop = new AbortController()
  const context: CleanupContext = {
    ...contextFor(entry, options, timeoutMs, stop.signal),
    ...(options.outcome === undefined ? {} : { preparation: options.outcome }),
    ...(options.prepared === undefined ? {} : { prepared: options.prepared }),
    failed: options.failed,
  }
  const ended = await bounded(new Promise<void>((resolve) => resolve(cleanup(context))), timeoutMs)
  const durationMs = elapsedMs(startedAt)
  const key = JSON.stringify(entry.key)
  if (ended.status === 'done') return { record: { key: entry.key, outcome: 'done', durationMs } }
  if (ended.status === 'timed_out' || ended.status === 'stopped') {
    stop.abort(new DOMException(`The cleanup took longer than ${timeoutMs} ms.`, 'TimeoutError'))
    const late = `did not finish within ${timeoutMs} ms, and what it started may still be running`
    return { record: { key: entry.key, outcome: 'timed_out', reason: `it ${late}`, durationMs }, failure: failure('cleanup_failed', `The host's cleanup for ${key} ${late}.`) }
  }
  const reason = cut(`it threw: ${options.redact(errorMessage(ended.error))}`)
  return { record: { key: entry.key, outcome: 'failed', reason, durationMs }, failure: failure('cleanup_failed', `The host's cleanup for ${key} failed: ${reason}.`) }
}

function contextFor(entry: TestPreparation, options: PrepareOptions, timeoutMs: number, signal: AbortSignal): PreparationContext {
  const { testId, attemptId, file, variant, owner } = options.scope
  return Object.freeze({
    key: entry.key,
    testId,
    attemptId,
    file,
    apps: Object.freeze([...entry.apps]),
    ...(variant === undefined ? {} : { variant: Object.freeze({ ...variant }) }),
    ...(owner === undefined ? {} : { owner }),
    timeoutMs,
    signal,
  })
}

function emitted(options: PrepareOptions, record: PreparationRecord): PreparationRecord {
  options.emit({ type: 'preparation.finished', testId: options.scope.testId, attemptId: options.scope.attemptId, preparation: record })
  return record
}

type Read = { ok: true; answer: PreparationAnswer } | { ok: false; problem: string }

// What a preparation answered is the host's code, read as data: anything Retest cannot read leaves the state unknown.
// The answer is kept as given, for the host's own cleanup; the record redacts it.
function readAnswer(value: unknown): Read {
  const refused = (problem: string): Read => ({ ok: false, problem: `it answered ${problem}` })
  if (!isPlainObject(value)) return refused(`${describeValue(value)}, not { status }`)
  const { status } = value
  if (status === 'failed' || status === 'uncertain') {
    const extra = Object.keys(value).find((key) => key !== 'status' && key !== 'reason')
    if (extra !== undefined) return refused(`with the unknown key ${JSON.stringify(extra)}`)
    if (typeof value['reason'] !== 'string' || value['reason'].trim() === '') return refused(`${status} without a reason`)
    return { ok: true, answer: { status, reason: value['reason'] } }
  }
  if (status !== 'prepared') return refused(`the status ${describeValue(status)}, not "prepared", "failed" or "uncertain"`)
  const extra = Object.keys(value).find((key) => !['status', 'recipe', 'seed', 'receipt', 'metadata'].includes(key) && value[key] !== undefined)
  if (extra !== undefined) return refused(`with the unknown key ${JSON.stringify(extra)}`)
  const { recipe, seed, receipt, metadata } = value
  if (typeof recipe !== 'string' || recipe.trim() === '' || recipe.length > longestText) return refused(`prepared with the recipe ${describeValue(recipe)}, not text of 1 to ${longestText} characters`)
  if (seed !== undefined && !(typeof seed === 'string' && seed.length <= longestText) && !(typeof seed === 'number' && Number.isFinite(seed))) return refused(`a seed that is neither a number nor text of up to ${longestText} characters`)
  if (receipt !== undefined && (typeof receipt !== 'string' || receipt.length > longestText)) return refused(`a receipt that is not text of up to ${longestText} characters`)
  const flat = metadata === undefined ? undefined : readMetadata(metadata)
  if (flat !== undefined && !flat.ok) return refused(flat.problem)
  return {
    ok: true,
    answer: {
      status: 'prepared',
      recipe,
      ...(seed === undefined ? {} : { seed }),
      ...(receipt === undefined ? {} : { receipt }),
      ...(flat === undefined ? {} : { metadata: flat.metadata }),
    },
  }
}

function readMetadata(value: unknown): { ok: true; metadata: Record<string, string | number | boolean> } | { ok: false; problem: string } {
  if (!isPlainObject(value)) return { ok: false, problem: `metadata that is ${describeValue(value)}, not flat values by name` }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  if (entries.length > mostMetadata) return { ok: false, problem: `metadata with ${entries.length} entries, more than ${mostMetadata}` }
  const metadata: Record<string, string | number | boolean> = {}
  for (const [key, item] of entries) {
    if (!isName(key)) return { ok: false, problem: `metadata named ${JSON.stringify(key)}, which is not a name` }
    if (typeof item === 'string' && item.length <= longestText) metadata[key] = item
    else if ((typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean') metadata[key] = item
    else return { ok: false, problem: `metadata ${JSON.stringify(key)} that is ${describeValue(item)}, not a number, a boolean or text of up to ${longestText} characters` }
  }
  return { ok: true, metadata }
}

function cut(text: string): string {
  return text.length > longestText ? `${text.slice(0, longestText)}…` : text
}

function isBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxTimeout
}

function usage(problems: readonly string[]): Failure | undefined {
  const [first] = problems
  if (first === undefined) return undefined
  return failure('usage', problems.length === 1 ? first : `The preparations have ${problems.length} problems:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
}

/** The preparations a run was given, read once their shape is known to be right. */
export function readPreparations(value: unknown): HostPreparations | undefined {
  if (value === undefined || preparationsShapeProblem(value) !== undefined || !isPlainObject(value)) return undefined
  const read: Record<string, HostPreparation> = {}
  for (const [key, entry] of Object.entries(value)) if (isHostPreparation(entry)) read[key] = entry
  return read
}

function isHostPreparation(value: unknown): value is HostPreparation {
  return preparationsShapeProblem({ preparation: value }) === undefined
}
