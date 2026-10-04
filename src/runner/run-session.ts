import type { NewPageOptions, OwnedBrowser, SessionIdentity } from '../browser/contract.ts'
import type { ElectronRuntime } from '../browser/electron.ts'
import type { LoadedTarget } from '../config/loaded.ts'
import type { DiagnosticsPolicy } from '../diagnostics/policy.ts'
import type { AttemptEvaluations, AttemptHostCheck } from '../evaluation/attempt.ts'
import type { DiagnosticsSummary } from '../protocol/diagnostics.ts'
import type { EvaluationRecord } from '../protocol/evaluation.ts'
import type { EventBody, EventOrigin, LeasePart } from '../protocol/events.ts'
import type { BundleRecord, CleanupRecord, ExecutionRecord, ModuleRecord, PreparationRecord, RequirementCheck } from '../protocol/execution.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheckResult } from '../protocol/host-check.ts'
import type { Evidence, FileResult, Narrowed, RunResult, TestResult } from '../protocol/result.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import type { Variant } from '../protocol/variant.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { RunStore } from '../store/run-store.ts'
import type { FindExecutable, LaunchBrowser, LaunchElectron, ReadyTarget as WebReadyTarget } from './browser-pool.ts'
import type { ChildOutput, RunOptions, Selection, StopReason } from './contract.ts'
import type { HostChecks, TestHostCheck } from './host-checks.ts'
import type { RunOutcome } from './outcome.ts'
import type { CollectedTests, Plan, PlannedFile, PlannedTest } from './plan.ts'
import type { RunConfig } from './run-config.ts'
import type { CheckedPages } from './run-host-checks.ts'
import type { BodyReport, RunningTestOptions } from './running-test.ts'
import type { Attempt, Visit } from './schedule.ts'
import type { RunJudges } from './fingerprint.ts'
import type { HostPreparations, TestPreparation } from './preparation.ts'
import type { AcquiredStage, HeldApp, ResourceLease, ResourceNeed } from './resources.ts'
import type { SessionLease } from './sessions.ts'
import type { AppPage, PagesContext } from './test-pages.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AttemptDiagnostics } from '../diagnostics/attempt.ts'
import { defaultDiagnosticsPolicy, recordedPolicy, resolveDiagnostics, withDiagnosticsFailure } from '../diagnostics/policy.ts'
import { notRunRecords, RunEvaluations, withEvaluationFailures } from '../evaluation/run-evaluations.ts'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { retestEventSchema } from '../protocol/events.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { sha256Hex } from '../shared/sha256.ts'
import { attemptEnding, canonicalJson, withFinalBundle } from '../protocol/execution.ts'
import { errorMessage, failure, withAlso } from '../protocol/failures.ts'
import { runResultSchema } from '../protocol/result.ts'
import { appLogFile, browserLogFile, childLogFile, stateFile, targetBrowserLogFile, testId, testTitle } from '../protocol/run-folder.ts'
import { originOf, withoutCredentials } from '../protocol/url.ts'
import { variantKey } from '../protocol/variant.ts'
import { relativePosixPath } from '../shared/posix-path.ts'
import { retestVersion } from '../version.ts'
import { AppServers } from './app-servers.ts'
import { newAttemptId } from './attempt-id.ts'
import { bounded } from './bounded.ts'
import { NativeBrowserAdapter, NativePool } from './native-pool.ts'
import type { LaunchWithLogs, ReadyNativeTarget, StartNative } from './native-pool.ts'
import { BrowserPool } from './browser-pool.ts'
import { defaultBrowsers, defaultWorkers, runInWorkers } from './workers.ts'
import { EventLog } from './event-log.ts'
import { appBuildsProblem, bundleRecord, configurationRecord, executionRecord, executionSettings, hashModules, judgeFor, redactedRecord, Requirements, runJudges, secretDeclarations } from './fingerprint.ts'
import { focusOf, onlyRefusal } from './focus.ts'
import { hostChecksScopeProblem, hostChecksShapeProblem, notRunHostChecks, recordedHostChecks, testHostChecks } from './host-checks.ts'
import { lastRunOf, lastRunPath, writeLastRun } from './last-run.ts'
import { loadTests, missingFileFailure } from './load-tests.ts'
import { SharedLocks } from './locks.ts'
import { inDeclarationOrder } from './result-order.ts'
import { interruptionOf, runOutcome, stopReasonOf, testStatus } from './outcome.ts'
import { collectedTest, planTests } from './plan.ts'
import { declaredBackend, preparationsScopeProblem, preparationsShapeProblem, prepareAttempt, readPreparations, testPreparations } from './preparation.ts'
import { endedBeforeTest, fileProcessFailure, laterTestsReason, reportedErrors } from './process-failures.ts'
import { Redactor } from './redactor.ts'
import { runConfig } from './run-config.ts'
import { runHostChecks } from './run-host-checks.ts'
import { abortGraceMs, RunningTest } from './running-test.ts'
import { attemptKey, phasesOf, scheduleRun } from './schedule.ts'
import { SecretFiller, secretValuesProblem, secretVariables } from './secrets.ts'
import { emptySelectionFailure, selectionProblem, testSelected, variantSelected } from './selection.ts'
import { acquireResources, hostResources, leasePart, partFree, resourceNeeds, sessionResource } from './resources.ts'
import { sessionOptionsProblem } from './sessions.ts'
import { searchSetups } from './setup-search.ts'
import { skippedCheckFailures } from './skipped-checks.ts'
import { attemptRefusal, targetDriver } from './target-drivers.ts'
import { TestFileProcess } from './test-file-process.ts'
import { timerMs } from './timer.ts'
import { captureFailure, disposePages, openPage, saveState } from './test-pages.ts'

export type RunSessionOptions = {
  options: RunOptions
  reporters: readonly Reporter[]
  launch: LaunchBrowser
  findExecutable: FindExecutable
  store: RunStore
  /** Starts an Electron app: Retest's own launcher when absent; tests pass a fake. */
  launchElectron?: LaunchElectron
  /** Starts a native runtime, and launches a native app with its standard output kept: Retest's own when absent; tests pass stand-ins. */
  native?: { readonly start?: StartNative; readonly launchWithLogs?: LaunchWithLogs }
}

type ReadyTarget = WebReadyTarget | ReadyNativeTarget

type Opened<T> = { ok: true; value: T } | { ok: false; failure: Failure }
/**
 * One attempt as its events and result name it, and the host checks it has. `variant` is absent in milestone 1's
 * mode.
 */
type Described = {
  testId: string
  attemptId: string
  test: PlannedTest
  targets: Variant
  variant?: Variant
  hostChecks: TestHostCheck[]
  hostEvaluations: AttemptHostCheck[]
  hostPreparations: TestPreparation[]
}
/**
 * `paths` names every module the file's process said it had loaded when the attempt ended. `leftOpen` holds the browsers
 * whose contexts the attempt could not close, which keep its sessions until they close.
 */
type TestOutcome = { result: TestResult; laterTests?: Failure; paths?: string[]; leftOpen?: readonly OwnedBrowser[] }
/**
 * The modules of the file's process, by path: those it loaded with the file, those known before this attempt, and the
 * parent's own hash of each.
 */
type AttemptModules = { collected: readonly string[] | undefined; known: readonly string[]; hashes: Map<string, string> }
/** The attempt's browser contexts once closed: the cleanup failures to report, and the browsers whose contexts stayed open. */
type ClosedPages = { cleanupFailures: Failure[]; leftOpen: OwnedBrowser[] }
/** What an attempt that started records besides its verdict: its execution identity, and the host's preparation and cleanup. */
type AttemptRecords = { execution?: ExecutionRecord; preparations?: PreparationRecord[]; cleanups?: CleanupRecord[] }
/**
 * `checked` is each host check's result once they ran; without it, every check is listed as not run. `evaluated` is
 * every AI check the attempt ended; without it, each of the host's is listed as not run.
 */
type Finished = Described & {
  startedAt: number
  failure: Failure | undefined
  assertionCount: number
  evidence: Evidence[]
  cleanupFailures: Failure[]
  checked?: HostCheckResult[]
  evaluated?: EvaluationRecord[]
  /** The file's process ended on its own during the body. */
  crashed?: boolean
  /** Every failure the parent saw for itself during the attempt, which an ending that names a check, a crash or an unknown outcome needs. */
  seen?: readonly Failure[]
  /** A browser of the attempt was gone when its checks were over. */
  browserLost?: boolean
  /** The bundle the attempt ran in the end, when its body loaded modules after it started. */
  finalBundle?: BundleRecord
  /** Each session's diagnostics, once its capture ended. */
  diagnostics?: DiagnosticsSummary[]
} & AttemptRecords
/** An attempt that ran to its end, or one whose body never started, with why. */
type Ran =
  | { kind: 'finished'; finished: Finished; laterTests?: Failure; paths?: string[]; leftOpen?: readonly OwnedBrowser[] }
  | { kind: 'not_run'; reason: Failure; cleanupFailures: Failure[]; leftOpen?: readonly OwnedBrowser[] }
/** What a file's visits added up to: its results in the order they ran, and its process failures. */
type FileRecord = { tests: TestResult[]; failures: Failure[] }
type Output = { write: (stream: ChildOutput['stream'], text: string) => void; end: () => void }
// A target's first browser keeps the log's name; each further one adds its number, as logs/browser-2.log.
function instanceLogFile(file: string, instance: number): string {
  return instance === 0 ? file : file.replace(/\.log$/, `-${instance + 1}.log`)
}

/** What `run.started` records of the host's sessions, requirement, app builds and preparations. */
type RecordedHostOptions = {
  sessions?: { owner: string; perOwner: number; host: number; waitMs: number }
  requirement?: { version: string; checks: RequirementCheck[] }
  appBuilds?: Record<string, string>
  preparations?: string[]
}

/** A run's plan: the config it follows and what collection found. */
type Planned = { config: RunConfig; plan: Plan }
/** A saved state to restore into an app's new page, and the names its event records. */
type Restored = { storage: StorageState; named: { state: string; app: string; target: string } }
/** A setup's state for one target: saved, or why it is not. */
type StateOutcome = { ok: true } | { ok: false; failure: Failure; target: string }
/** What a run's result says besides its outcome. It is fixed once the run is over. */
type ResultFacts = Omit<RunResult, keyof RunOutcome>

/**
 * One run of selected files: the parent's whole lifecycle. Every file is collected first, in a process of its
 * own, so the run knows every test before any starts. Then each visit runs its attempts in a new process for its
 * file: setups first, once per target and one after another, then the rest in file order on the workers, up to
 * `workers` files at once. The browsers a scheduled test needs launch once the schedule is known; app servers
 * start the first time a test needs them, and every test gets a new page for each of its apps.
 */
export class RunSession {
  readonly #options: RunOptions
  readonly #store: RunStore
  readonly #events: EventLog
  readonly #redactor = new Redactor()
  readonly #reporterNames: string
  readonly #rootDir: string
  readonly #files: string[]
  readonly #runId = randomUUID()
  readonly #startedAt = new Date()
  readonly #start = monotonicClock()
  readonly #stopped = Promise.withResolvers<void>()
  readonly #releases: Promise<unknown>[] = []
  readonly #processes = new Set<TestFileProcess>()
  readonly #records = new Map<string, FileRecord>()
  readonly #states = new Map<string, StateOutcome>()
  readonly #runFailures: Failure[] = []
  readonly #nativeStarts: NonNullable<RunResult['natives']> = []
  readonly #nativeEnded = new Set<string>()
  readonly #nativeScopes = new Map<string, Described>()
  readonly #native: NativePool
  readonly #browsers: BrowserPool
  readonly #servers: AppServers
  readonly #secrets: SecretFiller
  readonly #hiddenVariables: string[]
  /** The run's host checks, once their shape is known to be right. */
  readonly #hostChecks: HostChecks | undefined
  readonly #hostChecksProblem: Failure | undefined
  /** The run's judges, call budget and host AI checks. */
  readonly #evaluations: RunEvaluations
  readonly #workers: number
  /** The most browsers a target's tests are spread over. */
  readonly #browserCount: number
  #stopReason: Failure | undefined
  /** Why the run was stopped from outside, once it was. */
  #stoppedBy: StopReason | undefined
  #interruption: Failure | undefined
  /** Every test whose body is running, with the browsers its pages are in. */
  readonly #running = new Set<{ running: RunningTest; browsers: readonly OwnedBrowser[] }>()
  /**
   * The run's lock table, which holds the locks, desktops, devices and data folders attempts hold, and each test
   * attempt's place in the order waiters are served, by attempt key.
   */
  readonly #locks = new SharedLocks()
  readonly #lockOrder = new Map<string, number>()
  /** Every lease the run's attempts took, and those being given back, which the run waits for before it ends. */
  readonly #leases = new Set<ResourceLease>()
  readonly #letting = new Set<Promise<void>>()
  /** How `test.only` narrowed the run, once it did. */
  #narrowed: Narrowed | undefined
  /** The checks the host required of tests that test code skipped, which were never made. */
  readonly #hostFailures: Failure[] = []
  /** The host's preparations, once their shape is known to be right, and the requirement its checks belong to. */
  readonly #preparations: HostPreparations | undefined
  readonly #requirements: Requirements
  /** The run's judges as fingerprints read them. */
  readonly #judges: RunJudges
  /** Sessions held for contexts that could not be closed, each given back when its browsers close or the run ends. */
  readonly #heldSessions = new Set<() => void>()
  /** What the run refuses in its sessions, preparations, requirement and app builds before it loads anything. */
  readonly #hostProblems: (Failure | undefined)[]
  /** How the run captures and judges console, runtime error and network diagnostics. */
  readonly #diagnostics: DiagnosticsPolicy

  constructor({ options, reporters, launch, findExecutable, store, launchElectron, native }: RunSessionOptions) {
    const { apps, timeouts } = options
    this.#options = options
    this.#workers = options.workers ?? defaultWorkers()
    this.#browserCount = options.browsers ?? defaultBrowsers(this.#workers)
    this.#store = store
    this.#rootDir = resolve(options.rootDir)
    this.#files = options.files.map((file) => relativePosixPath(this.#rootDir, resolve(this.#rootDir, file)))
    this.#reporterNames = describeReporters(reporters)
    this.#events = new EventLog({
      runId: this.#runId,
      store,
      reporters,
      elapsedMs: () => elapsedMs(this.#start),
      onFailure: (problem) => {
        this.#stopReason ??= problem
      },
      redact: (event) => this.#redactor.redactFields(retestEventSchema, event),
    })
    store.setClock(() => elapsedMs(this.#start))
    const named = apps.kind === 'config'
    // Judges' credentials are taught to the redactor before any server or browser starts, and their variables are left
    // out of the environment each test file process, server and browser is given.
    this.#evaluations = new RunEvaluations({ config: apps.kind === 'config' ? apps.config : undefined, hostEvaluations: options.hostEvaluations, redactor: this.#redactor, env: process.env })
    const judgeVariables = this.#evaluations.hiddenVariables
    const declared = apps.kind === 'config' ? apps.config.secrets : new Map()
    // A browser or an Electron app never sees the variables secrets are read from, as the test process does not, and an
    // Electron app's own output is redacted as it is written.
    this.#hiddenVariables = [...secretVariables(declared), ...judgeVariables]
    this.#native = new NativePool({
      logFolder: (app, target, attemptId) => store.pathOf(`logs/native/${attemptId}/${app}/${target}`),
      setupMs: timeouts.setup, cleanupMs: timeouts.cleanup, signal: options.signal,
      hiddenVariables: this.#hiddenVariables, redact: (text) => this.#redactor.redact(text),
      onLost: (browser, reason) => { for (const test of this.#running) if (test.browsers.includes(browser)) test.running.browserLost(reason) },
      onEnded: (browser) => {
        const sessionId = formatSessionId(browser.owner.attemptId, browser.owner.app)
        const described = this.#nativeScopes.get(browser.owner.attemptId)
        if (this.#nativeEnded.has(sessionId) || described === undefined || browser.page === undefined) return
        this.#emitFor(described, { type: 'native.ended', testId: browser.owner.testId, attemptId: browser.owner.attemptId, session: browser.owner.app, sessionId, unknownOutcomes: browser.page.recordedOutcomes })
      },
      ...(native?.start === undefined ? {} : { start: native.start }),
      ...(native?.launchWithLogs === undefined ? {} : { launchWithLogs: native.launchWithLogs }),
    })
    this.#browsers = new BrowserPool({
      launch,
      ...(launchElectron === undefined ? {} : { launchElectron }),
      hiddenVariables: this.#hiddenVariables,
      redact: (text) => this.#redactor.redact(text),
      redactStream: () => this.#redactor.stream(),
      findExecutable: named ? findExecutable : async () => ({ ok: true, path: apps.browserPath }),
      logFile: (app, target, instance) => store.pathOf(instanceLogFile(named ? targetBrowserLogFile(variantKey({ [app]: target })) : browserLogFile, instance)),
      headless: options.headless,
      named,
      timeouts,
      stopped: this.#stopped.promise,
      interruption: () => this.#interruption,
      onStarted: ({ info, userAgent, pid, instance, instances }) => {
        const numbered = { ...(instance === undefined ? {} : { instance }), ...(instances === undefined ? {} : { instances }) }
        this.#events.emit({ type: 'browser.started', ...info, userAgent, pid, ...numbered })
      },
      onLost: (browser, reason) => {
        for (const test of this.#running) if (test.browsers.includes(browser)) test.running.browserLost(reason)
      },
    })
    this.#servers = new AppServers({
      hiddenVariables: judgeVariables,
      logFile: (app) => store.pathOf(appLogFile(app)),
      redactor: this.#redactor,
      setupMs: timeouts.setup,
      signal: options.signal,
      emit: (body) => void this.#events.emit(body),
    })
    this.#secrets = new SecretFiller(apps.kind === 'config' ? apps.secrets : new Map(), declared, this.#redactor)
    this.#hostChecksProblem = options.hostChecks === undefined ? undefined : hostChecksShapeProblem(options.hostChecks)
    this.#hostChecks = this.#hostChecksProblem === undefined ? options.hostChecks : undefined
    const preparationsProblem = preparationsShapeProblem(options.prepare)
    this.#preparations = readPreparations(options.prepare)
    const redact = (text: string): string => this.#redactor.redact(text)
    this.#requirements = new Requirements(options.requirement, redact)
    this.#judges = runJudges(apps.kind === 'config' ? apps.config.evaluation : undefined, this.#rootDir, redact)
    // A check's fingerprint is public, so one that holds a value the run has read is refused rather than hashed.
    const requirementProblem = this.#requirements.shapeProblem ?? this.#requirements.contentProblem(this.#hostChecks, this.#evaluations.recorded(), this.#judges, (text) => redact(text) !== text)
    const appNames = apps.kind === 'config' ? [...apps.config.apps.keys()] : ['page']
    this.#hostProblems = [sessionOptionsProblem(options.sessions), preparationsProblem, requirementProblem, appBuildsProblem(options.appBuilds, appNames)]
    // The host's block replaces the config's; one that cannot be read refuses the run before it loads anything.
    const diagnostics = resolveDiagnostics(options.diagnostics, apps.kind === 'config' ? apps.config.diagnostics : undefined)
    this.#diagnostics = diagnostics.ok ? diagnostics.policy : defaultDiagnosticsPolicy
    if (!diagnostics.ok) this.#hostProblems.push(diagnostics.failure)
  }

  async run(): Promise<RunResult> {
    const { signal } = this.#options
    const interrupt = (): void => this.#interrupt()
    signal.addEventListener('abort', interrupt, { once: true })
    try {
      this.#emitRunStarted()
      if (signal.aborted) this.#interrupt()
      const files = await this.#runFiles()
      await this.#release()
      return await this.#finish(files)
    } finally {
      signal.removeEventListener('abort', interrupt)
      await Promise.all([...this.#processes].map((process) => process.kill()))
      await this.#release()
    }
  }

  // Checks whose shape is wrong are left out: the run refuses them before it loads anything.
  #emitRunStarted(): void {
    const { apps, timeouts, commandLineTimeouts } = this.#options
    const recorded =
      apps.kind === 'config'
        ? { config: relativePosixPath(this.#rootDir, apps.config.file), ...recordedBaseUrls(apps.baseUrls) }
        : { ...(apps.baseUrl === undefined ? {} : { baseUrl: withoutCredentials(apps.baseUrl) }), browserPath: apps.browserPath }
    const evaluations = this.#evaluations.recorded()
    const checks = {
      ...(this.#hostChecks === undefined ? {} : { hostChecks: recordedHostChecks(this.#hostChecks) }),
      ...(evaluations === undefined ? {} : { hostEvaluations: evaluations }),
      ...this.#recordedHostOptions(),
    }
    this.#events.emit({
      type: 'run.started',
      retestVersion,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      rootDir: this.#rootDir,
      files: this.#files,
      options: { ...recorded, timeouts, ...(commandLineTimeouts === undefined ? {} : { commandLineTimeouts }), workers: this.#workers, browsers: this.#browserCount, ...(this.#options.playwright === true ? { playwright: true as const } : {}), reporter: this.#reporterNames, ...checks },
    })
  }

  // What run.started records of the host's sessions, requirement, app builds and preparations, each only when given
  // with a shape the run accepts.
  #recordedHostOptions(): RecordedHostOptions {
    const [sessionsProblem, , requirementProblem, buildsProblem] = this.#hostProblems
    const { sessions, appBuilds } = this.#options
    const requirement = requirementProblem === undefined ? this.#requirements.recorded() : undefined
    // The host writes the owner and the builds, so they are redacted as any text a host writes is.
    const redact = (text: string): string => this.#redactor.redact(text)
    return {
      ...(sessions === undefined || sessionsProblem !== undefined
        ? {}
        : { sessions: { owner: redact(sessions.owner), perOwner: sessions.budget.limits.perOwner, host: sessions.budget.limits.host, waitMs: sessions.waitMs ?? this.#options.timeouts.setup } }),
      ...(requirement === undefined ? {} : { requirement }),
      ...(appBuilds === undefined || buildsProblem !== undefined ? {} : { appBuilds: Object.fromEntries(Object.entries(appBuilds).map(([app, build]) => [app, redact(build)])) }),
      ...(this.#preparations === undefined ? {} : { preparations: Object.keys(this.#preparations) }),
    }
  }

  // A run the command line or the caller set up wrongly loads nothing, and neither does one that matches no
  // test. Host checks that name no test the run will run, or an app a test does not use, start nothing.
  async #runFiles(): Promise<FileResult[]> {
    const { apps } = this.#options
    const configured = runConfig(apps)
    const selection = this.#options.selection ?? {}
    const problem = configured.ok ? selectionProblem(selection, this.#files, configured.config) : configured.failure
    const secrets = apps.kind === 'config' ? secretValuesProblem(apps.secrets) : undefined
    for (const found of [problem, secrets, this.#hostChecksProblem, this.#evaluations.shapeProblem, ...this.#hostProblems]) if (found !== undefined) this.#failRun(found)
    if (!configured.ok) return this.#files.map((file) => this.#collectionFailed(file, this.#notLoaded()))
    const planned: Planned = { config: configured.config, plan: await this.#plan(configured.config) }
    const focus = focusOf(planned.plan)
    if (focus !== undefined && this.#stopReason === undefined) this.#narrow(focus.narrowed)
    // Only a run that may narrow does: one that refused test.only, or stopped before, lists every test as not run.
    const schedule = scheduleRun(planned.plan, selection, planned.config.variants, this.#narrowed === undefined ? undefined : focus)
    const collected = planned.plan.files.some((file) => file.ok && file.tests.length > 0)
    if (this.#stopReason === undefined && schedule.selected === 0 && collected) this.#failRun(emptySelectionFailure(selection, this.#narrowed))
    // A skipped test is part of the selection, so host checks may name it, but nothing starts for it.
    const skipped = schedule.skipped.map((attempt) => ({ file: attempt.test.file, attempts: [attempt] }))
    const checks = this.#stopReason === undefined ? this.#hostChecksScope(planned.plan, [...schedule.visits, ...skipped]) : undefined
    if (checks !== undefined) this.#failRun(checks)
    for (const attempt of schedule.skipped) this.#skip(attempt, planned)
    // An attempt that needs a target with no driver ends here, before any server starts or browser launches, and
    // takes no share of the browsers. Setups run first, one after another, so every state is saved before a test
    // starts from it. Then the test visits run on the workers, each file in a process of its own, each worker keeping
    // to one of the browsers its targets are spread over.
    const visits = this.#stopReason === undefined ? this.#refuseUndriven(schedule.visits, planned, selection) : schedule.visits
    const phases = phasesOf(visits)
    for (const [position, attempt] of phases.tests.flatMap((visit) => visit.attempts).entries()) this.#lockOrder.set(attemptKey(attempt), position)
    this.#spreadBrowsers(planned.config, phases.tests)
    for (const visit of phases.setups) await this.#runVisit(visit, planned, 0)
    await runInWorkers(phases.tests, this.#workers, (visit, worker) => this.#runVisit(visit, planned, worker))
    return planned.plan.files.map((file) => (file.ok ? this.#fileResult(file, planned.config.variants) : { file: file.file, collection: 'failed', failure: file.failure, tests: [] }))
  }

  // Each refused attempt is not run, with the refusal that names its target, and leaves the schedule. A setup the
  // selection did not choose was added for the attempts that start from its state, so one that no remaining attempt
  // needs leaves too, and nothing starts for it. A visit left with no attempt starts no process.
  #refuseUndriven(visits: readonly Visit[], planned: Planned, selection: Selection): Visit[] {
    let refused = false
    const runnable = visits.map(({ file, attempts }) => ({
      file,
      attempts: attempts.filter((attempt) => {
        const refusal = attemptRefusal(attempt.targets, planned.config.apps)
        if (refusal === undefined) return true
        refused = true
        this.#record(file).tests.push(this.#notRun(this.#describe(attempt, planned), refusal))
        return false
      }),
    }))
    const needed = refused ? this.#setupsStillNeeded(runnable, planned, selection) : undefined
    const kept = runnable.map(({ file, attempts }) => ({
      file,
      attempts: attempts.filter((attempt) => attempt.test.registered.setup !== true || needed === undefined || needed.has(attemptKey(attempt))),
    }))
    return kept.filter((visit) => visit.attempts.length > 0)
  }

  // The setups the remaining attempts start from, a setup's own states included, and every setup the selection chose
  // for itself, by attempt key.
  #setupsStillNeeded(visits: readonly Visit[], planned: Planned, selection: Selection): Set<string> {
    const { plan, config } = planned
    const attempts = visits.flatMap((visit) => visit.attempts)
    const chosen = (attempt: Attempt): boolean => {
      const file = plan.files.find((each) => each.file === attempt.test.file)
      const selected = testSelected(attempt.test, selection) && variantSelected(attempt.test.testId, config.variants ? attempt.targets : undefined, selection)
      return file?.ok === true && file.borrowed !== true && selected
    }
    const needed = new Set<string>()
    const waiting = attempts.filter((attempt) => attempt.test.registered.setup !== true || chosen(attempt))
    for (let attempt = waiting.pop(); attempt !== undefined; attempt = waiting.pop()) {
      if (attempt.test.registered.setup === true) needed.add(attemptKey(attempt))
      for (const [app, state] of attempt.test.states) {
        const setup = plan.setups.get(state)
        const target = attempt.targets[app]
        if (setup === undefined || target === undefined) continue
        const key = attemptKey({ test: setup.test, targets: { [app]: target } })
        const scheduled = attempts.find((each) => attemptKey(each) === key)
        if (scheduled !== undefined && !needed.has(key)) waiting.push(scheduled)
      }
    }
    return needed
  }

  #failRun(problem: Failure): void {
    this.#runFailures.push(problem)
    this.#stopReason ??= problem
  }

  // A run that may not narrow fails before any test; one that may says so in its events and its result.
  #narrow(narrowed: Narrowed): void {
    const { forbidOnly } = this.#options
    if (forbidOnly !== undefined) {
      this.#failRun(onlyRefusal(narrowed, forbidOnly))
      return
    }
    this.#narrowed = narrowed
    this.#events.emit({ type: 'run.narrowed', ...narrowed })
  }

  // A target's browsers follow its load. The workers that will really run, no more than there are files, get one
  // browser for every three, or what the run asked for; a target that carries a share of the run's tests gets that
  // share of them, at least one, and never more than the files that use it. So a run of one target on many workers
  // spreads over a few browsers, and a matrix of many targets starts one of each.
  #spreadBrowsers(config: RunConfig, tests: readonly Visit[]): void {
    const workers = Math.min(this.#workers, tests.length)
    if (workers < 2) return
    const base = this.#options.browsers ?? defaultBrowsers(workers)
    const total = tests.reduce((count, visit) => count + visit.attempts.length, 0)
    const uses = new Map<string, { app: string; target: string; attempts: number; visits: number }>()
    for (const visit of tests) {
      const seen = new Set<string>()
      for (const attempt of visit.attempts) {
        for (const [app, target] of Object.entries(attempt.targets)) {
          const id = JSON.stringify([app, target])
          const use = uses.get(id) ?? { app, target, attempts: 0, visits: 0 }
          use.attempts += 1
          if (!seen.has(id)) use.visits += 1
          seen.add(id)
          uses.set(id, use)
        }
      }
    }
    for (const use of uses.values()) {
      const app = config.apps.get(use.app)
      const target = app?.targets.get(use.target)
      if (app === undefined || target === undefined) continue
      const share = Math.ceil((base * use.attempts) / total)
      this.#browsers.spread(app, target, Math.max(1, Math.min(share, workers, use.visits)))
    }
  }

  #hostChecksScope(plan: Plan, visits: readonly Visit[]): Failure | undefined {
    const tests = [...new Map(visits.flatMap((visit) => visit.attempts).map(({ test }) => [test.testId, test])).values()]
    const unloaded = plan.files.flatMap((file) => (file.ok ? [] : [file.file]))
    const pageChecks = this.#hostChecks === undefined ? undefined : hostChecksScopeProblem(this.#hostChecks, tests, unloaded)
    const preparations = this.#preparations === undefined ? undefined : preparationsScopeProblem(this.#preparations, tests, unloaded)
    return pageChecks ?? this.#evaluations.scopeProblem(tests, unloaded) ?? preparations
  }

  async #plan(config: RunConfig): Promise<Plan> {
    const collected: CollectedTests[] = []
    for (const file of this.#files) collected.push(await this.#collect(file))
    const search = this.#options.apps.kind === 'config' ? await searchSetups({ rootDir: this.#rootDir, collected, collect: (file) => this.#look(file) }) : undefined
    const plan = planTests(collected, config, search)
    for (const file of plan.files) {
      if (file.ok) this.#events.emit({ type: 'collection.completed', file: file.file, tests: file.tests.map((test) => collectedTest(test, config)) })
      else this.#events.emit({ type: 'collection.failed', file: file.file, failure: file.failure })
    }
    return plan
  }

  // Loading a file to plan the run keeps its output only when the load fails: the load that runs its tests
  // produces the same output again, and a file whose load failed is not loaded again.
  async #collect(file: string): Promise<CollectedTests> {
    if (this.#stopReason !== undefined) return { file, ok: false, failure: this.#notLoaded() }
    if (!existsSync(resolve(this.#rootDir, file))) return { file, ok: false, failure: missingFileFailure(file) }
    const logFile = childLogFile(file)
    const held: [ChildOutput['stream'], string][] = []
    const collected = await this.#load(file, { onOutput: (stream, text) => held.push([stream, text]), logFile })
    if (collected.ok) return collected
    const output = this.#outputFor(file, logFile)
    for (const [stream, text] of held) output.write(stream, text)
    output.end()
    return { file, ok: false, failure: this.#interruption ?? collected.failure }
  }

  // A file looked through for setups is not part of the run, so nothing it prints is kept.
  async #look(file: string): Promise<CollectedTests> {
    if (this.#stopReason !== undefined) return { file, ok: false, failure: this.#notLoaded() }
    return this.#load(file, { onOutput: () => undefined })
  }

  async #load(file: string, { onOutput, logFile }: { onOutput: Output['write']; logFile?: string }): Promise<CollectedTests> {
    const child = this.#spawn(onOutput)
    try {
      const timeoutMs = this.#options.timeouts.collection
      const loaded = await loadTests(child, { file, rootDir: this.#rootDir, timeoutMs, ...(logFile === undefined ? {} : { logFile }) })
      await child.close(abortGraceMs)
      if (loaded.ok) return { file, ok: true, tests: loaded.tests }
      return { file, ok: false, failure: withAlso(loaded.failure, reportedErrors(file, child.errors)) }
    } finally {
      await this.#forget(child)
    }
  }

  // The process is closed before the visit's results are final, so an error it reports after its last test, or
  // an ending no test explains, fails the file. The event keeps that failure for a run that stops before it finishes.
  async #runVisit({ file, attempts }: Visit, planned: Planned, worker: number): Promise<void> {
    const record = this.#record(file)
    if (this.#stopReason !== undefined) {
      const reason = this.#stopReason
      record.tests.push(...attempts.map((attempt) => this.#notRun(this.#describe(attempt, planned), reason)))
      return
    }
    const logFile = childLogFile(file)
    const output = this.#outputFor(file, logFile)
    const child = this.#spawn(output.write)
    try {
      const ran = await this.#loadAndRun(child, file, attempts, planned, worker)
      const closed = await child.close(abortGraceMs)
      record.tests.push(...ran.tests)
      if (!ran.loaded) return
      const problem = fileProcessFailure({ file, closed, errors: child.errors, killed: child.killed, exitRecorded: ran.exitRecorded })
      if (problem === undefined) return
      this.#events.emit({ type: 'file.failed', file, failure: problem })
      record.failures.push(problem)
    } finally {
      await this.#forget(child)
      output.end()
    }
  }

  async #loadAndRun(child: TestFileProcess, file: string, attempts: readonly Attempt[], planned: Planned, worker: number): Promise<{ loaded: boolean; tests: TestResult[]; exitRecorded: boolean }> {
    const logFile = childLogFile(file)
    const loaded = await loadTests(child, { file, rootDir: this.#rootDir, timeoutMs: this.#options.timeouts.collection, logFile })
    if (!loaded.ok) {
      const reason = this.#interruption ?? withAlso(loaded.failure, reportedErrors(file, child.errors))
      return { loaded: false, tests: attempts.map((attempt) => this.#notRun(this.#describe(attempt, planned), reason)), exitRecorded: false }
    }
    const declared = new Set(loaded.tests.map((test) => testId(file, testTitle(test.name, (test.describes ?? []).map((block) => block.name)))))
    const tests: TestResult[] = []
    let laterTests: Failure | undefined
    // An attempt's bundle is what the process loaded with the file, and what that attempt itself loaded first: a module an
    // earlier test imported is that test's, so a test's bundle is the same whichever tests ran before it.
    const hashes = new Map<string, string>()
    let known: readonly string[] = loaded.modules ?? []
    for (const attempt of attempts) {
      const described = this.#describe(attempt, planned)
      const modules: AttemptModules = { collected: loaded.modules, known, hashes }
      const outcome: TestOutcome = declared.has(described.testId)
        ? await this.#runAttempt(child, described, planned, { notRunReason: laterTests, worker, modules })
        : { result: this.#notRun(described, failure('collection_failed', 'Not run: its file no longer declared it when it loaded again to run it.')) }
      tests.push(outcome.result)
      laterTests ??= outcome.laterTests
      known = outcome.paths ?? known
    }
    return { loaded: true, tests, exitRecorded: laterTests !== undefined }
  }

  // An attempt acquires everything it needs before anything is launched for it, in the acquisition order of
  // resources.ts: its locks, then the desktop, devices and data folders, then its sessions. Then its apps' servers and
  // browsers are made ready, an Electron app launched for it alone among them, and it runs. An Electron app launched for
  // it is quit before its result is written, and what it holds is given back in reverse order once it is really free.
  async #runAttempt(child: TestFileProcess, described: Described, planned: Planned, place: { notRunReason: Failure | undefined; worker: number; modules: AttemptModules }): Promise<TestOutcome> {
    const skip = this.#stopReason ?? place.notRunReason ?? this.#missingState(described, planned.plan)
    if (skip !== undefined) return { result: this.#notRun(described, skip) }
    if (child.exit !== undefined) return { result: this.#notRun(described, endedBeforeTest(child.exit)) }
    const held = await this.#acquire(described, planned.config)
    if (!held.ok) return { result: this.#notRun(described, held.failure) }
    const launched = new Map<string, ReadyTarget>()
    let leftOpen: readonly OwnedBrowser[] = []
    try {
      const ready = await this.#prepare(described, planned.config, place.worker, launched, held.lease)
      if (!ready.ok) {
        const quitFailures = await this.#quitLaunches(planned.config, described, launched, [])
        return { result: this.#notRun(described, this.#stopReason ?? ready.failure, quitFailures) }
      }
      const outcome = await this.#runHolding(child, described, planned, ready.value, place.modules)
      leftOpen = outcome.leftOpen ?? []
      return outcome
    } finally {
      this.#letGo(described, held.lease, launched, leftOpen)
    }
  }

  // The attempt's needs, from its apps and locks, acquired stage by stage within their bounds, each stage's event
  // written as it is granted. The wait counts against no budget of the test. One that cannot have everything does not
  // run, holding nothing.
  async #acquire(described: Described, config: RunConfig): Promise<{ ok: true; lease: ResourceLease } | { ok: false; failure: Failure }> {
    const { testId: holder, attemptId } = described
    const { sessions, timeouts } = this.#options
    const needs = this.#needs(described, config)
    if (!needs.ok) return needs
    const position = this.#lockOrder.get(attemptKey(described)) ?? Number.MAX_SAFE_INTEGER
    const draw = sessions === undefined ? undefined : { budget: sessions.budget, owner: sessions.owner, waitMs: sessions.waitMs ?? timeouts.setup }
    const grant = await acquireResources(
      {
        attemptId,
        holder,
        scope: this.#runId,
        position,
        needs: needs.value,
        locks: this.#locks,
        resources: hostResources,
        sessions: draw,
        pastLeaseMs: timeouts.setup,
        releaseWithinMs: timeouts.cleanup,
        variant: described.variant,
        onAcquired: (stage) => this.#recordStage(described, stage),
      },
      this.#stopped.promise,
    )
    if (!grant.ok) return { ok: false, failure: grant.stopped ? (this.#stopReason ?? grant.failure) : grant.failure }
    const { lease } = grant
    this.#leases.add(lease)
    // A run stopped as the grant came gives everything back at once: nothing was launched or opened that could still be
    // in use, and its sessions were never recorded as reserved.
    if (this.#stopReason !== undefined) {
      void lease.release({
        whenFree: () => undefined,
        giveBackSessions: (granted) => {
          granted.release()
          return true
        },
        ending: true,
      })
      return { ok: false, failure: this.#stopReason }
    }
    if (!lease.empty) this.#recordLease(described, lease)
    return { ok: true, lease }
  }

  // The attempt's needs. Reading a data folder's real path and its volume's case rule can fail, and then the attempt does
  // not run: two names for one folder could otherwise hold two leases.
  #needs({ test, targets }: Described, config: RunConfig): Opened<ResourceNeed[]> {
    try {
      return { ok: true, value: resourceNeeds({ apps: test.apps, targets, config: config.apps, locks: test.registered.locks ?? [], owner: this.#options.sessions?.owner }) }
    } catch (error) {
      return { ok: false, failure: failure('setup_failed', `Not run: Retest could not read where a data folder of the test is, or whether its disk ignores case: ${errorMessage(error)}`) }
    }
  }

  // Each stage of an acquisition as it is granted: the locks as Phase 1 recorded them, the desktop, devices and data
  // folders, and the sessions, which a run stopped meanwhile never records.
  #recordStage(described: Described, stage: AcquiredStage): void {
    const { testId, attemptId, test } = described
    const redact = (text: string): string => this.#redactor.redact(text)
    if (stage.kind === 'locks') {
      const heldBy = stage.heldBy.length === 0 ? {} : { heldBy: [...stage.heldBy] }
      this.#emitFor(described, { type: 'lock.acquired', testId, attemptId, locks: [...(test.registered.locks ?? [])], waitedMs: stage.waitedMs, ...heldBy })
      return
    }
    if (stage.kind === 'resources') {
      const resources = stage.needs.map((need) => ({ ...leasePart(need), name: redact(need.name) }))
      const holders = { ...(stage.heldBy.length === 0 ? {} : { heldBy: [...stage.heldBy] }), ...(stage.heldElsewhere === 0 ? {} : { heldElsewhere: stage.heldElsewhere }) }
      this.#emitFor(described, { type: 'resource.acquired', testId, attemptId, resources, waitedMs: stage.waitedMs, ...holders })
      return
    }
    const { sessions } = this.#options
    if (sessions === undefined || this.#stopReason !== undefined) return
    const { perOwner, host } = sessions.budget.limits
    const { waitedMs, active } = stage.lease
    this.#emitFor(described, { type: 'session.reserved', testId, attemptId, owner: redact(sessions.owner), sessions: test.apps.length, waitedMs, active: { ...active }, limits: { perOwner, host } })
  }

  // The whole lease once everything is held, and its expiry when a part it covers does not come free in time.
  #recordLease(described: Described, lease: ResourceLease): void {
    const redact = (text: string): string => this.#redactor.redact(text)
    const record = lease.record(redact)
    const { testId, attemptId } = described
    this.#emitFor(described, { type: 'lease.taken', testId, attemptId, lease: record })
    lease.onExpired((expiry) => {
      const parts = (needs: readonly ResourceNeed[]): LeasePart[] => needs.map((need) => ({ ...leasePart(need), name: redact(need.name) }))
      this.#emitFor(described, { type: 'lease.expired', testId, attemptId, lease: record, held: parts(expiry.held), released: parts(expiry.released) })
    })
  }

  // An Electron app launched for this attempt alone quits when its page closes. One whose page never opened, because a
  // later app was not ready or its window never came, is quit here. Each must be gone within the cleanup budget, or
  // the attempt records a cleanup failure beside its outcome, which never softens a failure it already has. An app whose
  // page could not be closed already has its failure. A stopped run quits every app as it ends.
  async #quitLaunches(config: RunConfig, { targets }: Described, launched: ReadonlyMap<string, ReadyTarget>, leftOpen: readonly OwnedBrowser[]): Promise<Failure[]> {
    const { cleanup } = this.#options.timeouts
    const failures: Failure[] = []
    for (const [app, { browser }] of launched) {
      const resource = sessionResource(targetOf(config, app, targets[app]))
      if (browser instanceof NativeBrowserAdapter) {
        await browser.close(cleanup).catch((error: unknown) => failures.push(failure('cleanup_failed', `Closing the native app ${app}: ${errorMessage(error)}`)))
        continue
      }
      if (resource !== 'app-launch' && resource !== 'data-folder') continue
      if (!isElectronRuntime(browser) || leftOpen.includes(browser)) continue
      const quitting = browser.closeRequested ? browser.gone : browser.close(cleanup).then(() => browser.gone)
      const quit = await bounded(quitting, timerMs(cleanup + abortGraceMs))
      if (quit.status === 'done') continue
      const detail = quit.status === 'failed' ? `failed: ${errorMessage(quit.error)}` : `did not finish within the ${cleanup} ms cleanup budget.`
      failures.push(failure('cleanup_failed', `Quitting the Electron app ${app} ${detail}`))
    }
    return failures
  }

  // Gives the lease back, in reverse order, in the background: the next attempt need not wait for it, and the run waits
  // for every release before it ends. A release that fails is the run's own problem, said as one, never a rejection
  // nothing hears.
  #letGo(described: Described, lease: ResourceLease, launched: ReadonlyMap<string, ReadyTarget>, leftOpen: readonly OwnedBrowser[]): void {
    if (lease.empty) return
    const apps = this.#heldApps(described, launched)
    const releasing = lease
      .release({
        whenFree: (need) => partFree(need, apps),
        giveBackSessions: (sessions) => this.#releaseSessions(described, sessions, described.test.apps.length, leftOpen),
        ending: this.#interruption !== undefined,
      })
      .catch((error: unknown) => this.#events.reportFailure(failure('cleanup_failed', `Retest could not give back what ${described.testId} held: ${errorMessage(error)}`)))
    this.#letting.add(releasing)
    void releasing.finally(() => this.#letting.delete(releasing))
  }

  // What each of the attempt's apps says about when it is free. An Electron app on a named data folder answers with the
  // pool's own chain for that folder, which settles once every app the pool launched there, or gave up launching and
  // that may still have come up, is gone. An app launched for this attempt alone answers once its processes are gone.
  // A browser target holds no desktop, device or data folder. A native session, once the runner drives one, says so here.
  #heldApps({ targets, attemptId }: Described, launched: ReadonlyMap<string, ReadyTarget>): Map<string, HeldApp> {
    const apps = new Map<string, HeldApp>()
    for (const [app, target] of Object.entries(targets)) {
      const loaded = this.#options.apps.kind === 'config' ? this.#options.apps.config.apps.get(app)?.targets.get(target) : undefined
      const folder = loaded !== undefined && 'browser' in loaded && loaded.browser === 'electron' ? loaded.userDataDir : undefined
      const browser = launched.get(app)?.browser
      const native = this.#native.heldApp(attemptId, app)
      if (native !== undefined) apps.set(app, native)
      else if (folder !== undefined) apps.set(app, { whenFree: () => this.#browsers.folderSettled(folder) })
      else if (browser !== undefined && isElectronRuntime(browser)) apps.set(app, { whenFree: () => browser.gone })
    }
    return apps
  }

  // Sessions come back once the attempt's contexts are closed. Contexts it could not close still count until their
  // browsers close, or the run ends, and the event says which it was.
  // Says whether the sessions came back now.
  #releaseSessions(described: Described, lease: SessionLease, count: number, leftOpen: readonly OwnedBrowser[]): boolean {
    const owner = this.#redactor.redact(this.#options.sessions?.owner ?? '')
    let released = false
    // The event is written before the sessions go, so no attempt they go to can be recorded as reserving them first.
    const release = (after: 'contexts_closed' | 'browser_closed'): void => {
      if (released) return
      released = true
      this.#emitFor(described, { type: 'session.released', testId: described.testId, attemptId: described.attemptId, owner, sessions: count, after })
      lease.release()
    }
    const open = [...new Set(leftOpen)]
    if (open.length === 0) {
      release('contexts_closed')
      return true
    }
    const finish = (): void => {
      this.#heldSessions.delete(finish)
      release('browser_closed')
    }
    this.#heldSessions.add(finish)
    const free = open.map((browser) => browser instanceof NativeBrowserAdapter
      ? this.#native.heldApp(described.attemptId, browser.owner.app)?.whenFree?.() ?? new Promise<void>(() => undefined)
      : this.#browsers.whenFree(browser))
    void Promise.all(free).then(finish, () => undefined)
    return false
  }

  // The parent records what the attempt runs before anything acts on an app, then the host prepares its state. A
  // preparation that does not succeed keeps the body from running. The host's cleanup runs once the attempt is over,
  // however it ended, and a cleanup that fails is kept beside the attempt's failure.
  async #runHolding(child: TestFileProcess, described: Described, planned: Planned, prepared: ReadonlyMap<string, ReadyTarget>, modules: AttemptModules): Promise<TestOutcome> {
    const startedAt = monotonicClock()
    const { test } = described
    const execution = this.#executionRecord(described, planned, prepared, hashModules(this.#rootDir, modules.collected, modules.hashes))
    const shown = { name: test.registered.name, file: test.file, location: test.registered.location, ...describePath(test), ...setupMark(test) }
    this.#emitFor(described, { type: 'test.started', testId: described.testId, attemptId: described.attemptId, ...shown, execution })
    const finished: Finished = { ...described, startedAt, failure: undefined, assertionCount: 0, evidence: [], cleanupFailures: [], execution }
    const { variant } = described
    const owner = this.#options.sessions?.owner
    const preparing = await prepareAttempt({
      preparations: described.hostPreparations,
      scope: { testId: described.testId, attemptId: described.attemptId, file: test.file, ...(variant === undefined ? {} : { variant }), ...(owner === undefined ? {} : { owner }) },
      timeouts: this.#options.timeouts,
      stopped: this.#stopped.promise,
      interruption: () => this.#interruption,
      emit: (body) => this.#emitFor(described, body),
      redact: (text) => this.#redactor.redact(text),
    })
    const ran: Ran =
      preparing.failure === undefined
        ? await this.#runPrepared(child, described, planned, prepared, finished)
        : { kind: 'finished', finished: { ...finished, failure: preparing.failure, seen: [preparing.failure] } }
    // An app launched for the attempt is gone before the host cleans its state up, so it cannot touch that state again.
    const quitFailures = await this.#quitLaunches(planned.config, described, prepared, ran.leftOpen ?? [])
    const cleaned = await preparing.cleanUp(ran.kind === 'not_run' || ran.finished.failure !== undefined)
    const records = { execution, preparations: preparing.records, cleanups: cleaned.records }
    const leftOpen = ran.leftOpen === undefined ? {} : { leftOpen: ran.leftOpen }
    if (ran.kind === 'not_run') return { result: this.#notRun(described, ran.reason, [...ran.cleanupFailures, ...quitFailures, ...cleaned.failures], records), ...leftOpen }
    const grown = this.#finalBundle(modules, ran.paths, execution)
    const result = this.#finishTest({ ...ran.finished, ...records, ...grown, cleanupFailures: [...ran.finished.cleanupFailures, ...quitFailures, ...cleaned.failures] })
    return { result, ...(ran.laterTests === undefined ? {} : { laterTests: ran.laterTests }), ...(ran.paths === undefined ? {} : { paths: ran.paths }), ...leftOpen }
  }

  // The modules the attempt loaded for the first time join the bundle the file loaded with it; none, and the bundle it
  // started with stands.
  #finalBundle(modules: AttemptModules, paths: readonly string[] | undefined, execution: ExecutionRecord): { finalBundle?: BundleRecord } {
    if (paths === undefined) return {}
    const known = new Set(modules.known)
    const added = paths.filter((path) => !known.has(path))
    if (added.length === 0) return {}
    const bundle = bundleRecord(hashModules(this.#rootDir, [...(modules.collected ?? []), ...added], modules.hashes))
    return bundle === undefined || bundle.sha256 === execution.bundle?.sha256 ? {} : { finalBundle: bundle }
  }

  // Closes the attempt's browser contexts and says which stayed open. With session limits a stopped run still closes
  // them, within the cleanup budget, since other attempts wait for those sessions; without, a stopped run leaves them to
  // close with their browsers, as before.
  async #closePages(context: PagesContext, pages: readonly AppPage[]): Promise<ClosedPages> {
    if (this.#options.sessions === undefined) return { cleanupFailures: await disposePages(context, pages), leftOpen: [] }
    const cleanup = this.#options.timeouts.cleanup
    const cleanupFailures: Failure[] = []
    const leftOpen: OwnedBrowser[] = []
    for (const { page, browser } of pages) {
      if (!this.#connected(browser)) continue
      const disposed = await bounded(page.dispose(cleanup), timerMs(cleanup + abortGraceMs))
      if (disposed.status === 'done') continue
      leftOpen.push(browser)
      if (this.#interruption !== undefined) continue
      const detail = disposed.status === 'failed' ? `failed: ${errorMessage(disposed.error)}` : `took longer than ${cleanup} ms.`
      cleanupFailures.push(failure('cleanup_failed', `Closing the test's browser context ${detail}`))
    }
    return { cleanupFailures, leftOpen }
  }

  // The attempt once its state is prepared: its pages open, its body runs, the parent's checks follow, and the pages
  // close. It ends without a verdict of its own only when the file's process ended before the body could start.
  async #runPrepared(child: TestFileProcess, described: Described, planned: Planned, prepared: ReadonlyMap<string, ReadyTarget>, finished: Finished): Promise<Ran> {
    const context = this.#pagesContext(described)
    // A native app's capture starts as its page opens, before the app launches; a web page's once every page is open.
    const diagnostics = this.#attemptDiagnostics(described)
    const opened = await this.#openPages(context, described, prepared, planned.config, diagnostics)
    // A stopped run does not close the pages that opened before the one that failed, so their browsers hold the sessions.
    const halfOpen = this.#interruption === undefined ? [] : [...prepared.values()].map((target) => target.browser)
    if (!opened.ok) {
      const { summaries } = await diagnostics.finishNative(this.#interruption === undefined ? 'attempt_ended' : 'run_interrupted')
      return { kind: 'finished', finished: { ...finished, failure: opened.failure, seen: [opened.failure], diagnostics: summaries }, leftOpen: halfOpen }
    }
    const interruption = this.#interruption
    if (interruption !== undefined) {
      const { summaries } = await diagnostics.finishNative('run_interrupted')
      const closed = await this.#closePages(context, opened.value)
      return { kind: 'finished', finished: { ...finished, failure: interruption, seen: [interruption], diagnostics: summaries }, leftOpen: closed.leftOpen }
    }
    const pages = opened.value
    // Code the previous test left behind can end the process while the pages open.
    if (child.exit !== undefined) return this.#bodyNotRun(context, pages, child.exit, diagnostics)
    // Capture starts on every page before the body runs, so before any page navigates. A run stopped meanwhile waits for
    // no page, and the attempt ends as interrupted.
    await diagnostics.start(pages.filter((page) => !(page.browser instanceof NativeBrowserAdapter)), this.#options.timeouts.setup, this.#stopped.promise)
    if (this.#interruption !== undefined) {
      const { summaries } = await diagnostics.finishNative('run_interrupted')
      return { kind: 'finished', finished: { ...finished, failure: this.#interruption, diagnostics: summaries } }
    }
    const evaluations = this.#evaluations.attempt({ context, pages, hostChecks: described.hostEvaluations, runSignal: this.#options.signal })
    const { report, running } = await this.#runBody(child, pages, described, planned.config, evaluations)
    let checked: CheckedPages | undefined
    try {
      if (report.endedBeforeStart !== undefined) return await this.#bodyNotRun(context, pages, report.endedBeforeStart, diagnostics)
      // The body passed only if its required AI checks passed too, by the parent's own records, whatever the test
      // file's process reported about them. Host checks read the pages as the body left them, so they come before the
      // screenshot and the saved state. The pages' navigations are still written while they run, since a check may
      // wait for a document to arrive. The host's AI checks follow, only when everything before them passed.
      const body = withEvaluationFailures({ reported: report.failure, recorded: await evaluations.failures(), observed: report.observed ?? [] })
      checked = body === undefined ? await runHostChecks(context, pages, described.hostChecks) : undefined
      if ((body ?? checked?.failure) === undefined) await evaluations.runHostChecks()
      else evaluations.skipHostChecks()
      if (checked !== undefined) await running.settleNavigations(this.#settleBudget())
    } finally {
      running.close()
    }
    const observed = [...(report.observed ?? []), ...(checked?.failure === undefined ? [] : [checked.failure])]
    // Capture ends once the body, its dispatched commands and the parent's checks are over, before the screenshot and
    // before any app is closed. A diagnostics policy's failure follows any failure the test already had, and never
    // replaces it.
    const diagnosed = await diagnostics.finishNative(this.#interruption === undefined ? 'attempt_ended' : 'run_interrupted')
    const verdict = withDiagnosticsFailure(withEvaluationFailures({ reported: report.failure ?? checked?.failure, recorded: await evaluations.failures(), observed }), diagnosed.failure)
    const evidence = verdict === undefined ? [] : await captureFailure(context, pages)
    const unsaved = verdict === undefined ? await this.#saveSetupState(context, described, pages) : undefined
    const browserLost = pages.some((page) => !this.#connected(page.browser))
    const { cleanupFailures, leftOpen } = await this.#closePages(context, pages)
    const problem = verdict ?? unsaved
    const hostChecks = checked === undefined ? {} : { checked: checked.results }
    const crashed = report.crashed === true ? { crashed: true } : {}
    const seen = [...observed, ...(diagnosed.failure === undefined ? [] : [diagnosed.failure]), ...(unsaved === undefined ? [] : [unsaved])]
    const laterTests = laterTestsReason(described.test.registered.name, report)
    return {
      kind: 'finished',
      finished: { ...finished, failure: problem, assertionCount: report.assertionCount, evidence, cleanupFailures, ...hostChecks, evaluated: [...evaluations.records], ...crashed, seen, browserLost, diagnostics: diagnosed.summaries },
      ...(laterTests === undefined ? {} : { laterTests }),
      ...(report.modules === undefined ? {} : { paths: report.modules }),
      leftOpen,
    }
  }

  // The attempt's execution identity, from what is known before its first action: the bundle its file's process
  // loaded, the configuration of its targets, the runtime, its sessions and the browsers they run in, the session
  // owner, the app builds the host named, the requirement and the state each app starts from.
  #executionRecord(described: Described, planned: Planned, prepared: ReadonlyMap<string, ReadyTarget>, modules: readonly ModuleRecord[] | undefined): ExecutionRecord {
    const { test, targets, attemptId } = described
    const { apps, sessions, appBuilds, testEnvironment } = this.#options
    const timeouts = { ...this.#options.timeouts, ...(test.registered.timeout === undefined ? {} : { test: test.registered.timeout }) }
    const judges = described.hostEvaluations.flatMap((check) => judgeFor(this.#judges, check.judge) ?? [])
    const policy = recordedPolicy(this.#diagnostics)
    const settings = executionSettings({
      config: planned.config,
      evaluation: apps.kind === 'config' ? apps.config.evaluation : undefined,
      judges,
      headless: this.#options.headless,
      test,
      targets,
      timeouts,
      environment: testEnvironment,
      diagnostics: { capture: this.#diagnostics.capture, ...(policy === undefined ? {} : { policy }), limits: { ...this.#diagnostics.limits } },
      playwright: this.#options.playwright === true,
    })
    for (const [app, name] of Object.entries(targets)) {
      const target = planned.config.apps.get(app)?.targets.get(name)
      const recorded = settings.apps[app]
      if (target === undefined || recorded === undefined || !('platform' in target)) continue
      if ((target.arguments?.length ?? 0) > 0) recorded.args = { count: target.arguments?.length ?? 0, sha256: sha256Hex(canonicalJson(target.arguments)) }
      if (Object.keys(target.environment ?? {}).length > 0) recorded.environment = { count: Object.keys(target.environment ?? {}).length, sha256: sha256Hex(canonicalJson(target.environment)) }
    }
    const recordedSessions = [...prepared].map(([app, { runtime, browser }]) => {
      const resource = sessionResource(targetOf(planned.config, app, targets[app]))
      return { app, sessionId: formatSessionId(attemptId, app), engine: runtime.kind === 'web' ? runtime.engine : runtime.kind, product: browser.product, version: browser.version, resource, ...(runtime.kind === 'web' ? {} : { native: runtime.execution }) }
    })
    const startingState = test.apps.map((app) => {
      const state = test.states.get(app)
      const native = prepared.get(app)?.browser
      if (native instanceof NativeBrowserAdapter) return { app, native: native.startingState, backendData: declaredBackend(described.hostPreparations, app) }
      const storage = state === undefined ? { browserStorage: freshOrReused(planned.config, app, targets[app]) } : { browserStorage: 'saved' as const, state }
      return { app, ...storage, backendData: declaredBackend(described.hostPreparations, app) }
    })
    const builds = appBuilds === undefined || this.#hostProblems[3] !== undefined ? undefined : appBuilds
    const redact = (text: string): string => this.#redactor.redact(text)
    // The settings are redacted before they are hashed, and the whole record again before it is written.
    const record = executionRecord({
      configuration: configurationRecord(settings, redact),
      modules,
      secretReferences: secretDeclarations(planned.config.secrets),
      runtime: { retest: retestVersion, node: process.version, platform: `${process.platform}-${process.arch}` },
      sessions: recordedSessions,
      owner: sessions?.owner,
      appBuilds: builds,
      apps: test.apps,
      requirement: this.#requirements.forTest(described.hostChecks, described.hostEvaluations, this.#judges),
      startingState,
    })
    return redactedRecord(record, redact)
  }

  // Every app's server and browser, before the test starts; any that is not ready keeps the test from running. Each app
  // made ready goes into `launched` at once, so an Electron app launched for this attempt is quit even when a later app
  // is not ready.
  async #prepare(described: Described, config: RunConfig, worker: number, launched: Map<string, ReadyTarget>, lease: ResourceLease): Promise<Opened<Map<string, ReadyTarget>>> {
    const { test, targets, testId, attemptId } = described
    this.#nativeScopes.set(attemptId, described)
    const ready = new Map<string, ReadyTarget>()
    for (const name of test.apps) {
      const app = config.apps.get(name)
      const targetName = targets[name]
      const target = targetName === undefined ? undefined : app?.targets.get(targetName)
      if (app === undefined || target === undefined) return { ok: false, failure: failure('test_error', `The config has no target ${JSON.stringify(targetName)} for ${name}.`) }
      const driver = targetDriver(name, target, { native: true })
      if (!driver.ok) return driver
      let browser: Opened<ReadyTarget>
      if (driver.driver === 'macos' || driver.driver === 'ios-simulator') {
        const unready = await this.#servers.ensure(app)
        if (unready !== undefined) return { ok: false, failure: this.#interruption ?? unready }
        browser = await this.#native.ensure(name, driver.target, { runId: this.#runId, testId, attemptId, app: name }, lease)
      } else {
        // Both start inside this attempt's complete lease, preserving concurrent browser and server setup.
        const [unready, opened] = await Promise.all([this.#servers.ensure(app), this.#browsers.ensure(app, driver.target, worker)])
        browser = opened
        if (opened.ok) launched.set(name, opened.value)
        if (unready !== undefined) return { ok: false, failure: this.#interruption ?? unready }
      }
      if (!browser.ok) return browser
      ready.set(name, browser.value)
      launched.set(name, browser.value)
    }
    return { ok: true, value: ready }
  }

  async #openPages(context: PagesContext, described: Described, ready: ReadonlyMap<string, ReadyTarget>, config: RunConfig, diagnostics: AttemptDiagnostics): Promise<Opened<AppPage[]>> {
    const pages: AppPage[] = []
    for (const [app, { browser, runtime, emulation, proxy }] of ready) {
      const state = this.#restoredState(described, app)
      if (state !== undefined && !state.ok) {
        await disposePages(context, pages)
        return state
      }
      const baseUrl = runtime.kind === 'web' ? config.apps.get(app)?.baseUrl : undefined
      const options: NewPageOptions = {
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(emulation === undefined ? {} : { emulation }),
        ...(state === undefined ? {} : { storageState: state.value.storage }),
        ...(proxy === undefined ? {} : { proxy }),
      }
      const { testId: id, attemptId } = described
      const session = { sessionId: formatSessionId(attemptId, app), owner: { runId: this.#runId, testId: id, attemptId, app }, runtime }
      const unwatched = browser instanceof NativeBrowserAdapter ? await this.#watchNative(diagnostics, browser, session) : undefined
      if (unwatched !== undefined) {
        await disposePages(context, pages)
        return { ok: false, failure: unwatched }
      }
      const opened = await openPage(context, browser, options)
      if (!opened.ok) {
        await disposePages(context, pages)
        return opened
      }
      opened.value.identify?.(session)
      pages.push({ app, page: opened.value, browser, touch: runtime.kind === 'ios-simulator' || emulation?.touch === true, session })
      if (browser instanceof NativeBrowserAdapter) {
        const native = { sessionId: session.sessionId, app, target: targetsName(described.targets, app), product: browser.product, identity: browser.identity.execution }
        this.#nativeStarts.push(native)
        this.#emitFor(described, { type: 'native.started', testId: id, attemptId, session: app, ...native })
      }
      if (state !== undefined) this.#emitFor(described, { type: 'state.restored', testId: described.testId, attemptId: described.attemptId, ...state.value.named, sessionId: session.sessionId })
    }
    return { ok: true, value: pages }
  }

  #restoredState({ test, targets }: Described, app: string): Opened<Restored> | undefined {
    const state = test.states.get(app)
    const target = targets[app]
    if (state === undefined || target === undefined) return undefined
    try {
      return { ok: true, value: { storage: this.#store.readState(stateFile(state, target)), named: { state, app, target } } }
    } catch (error) {
      return { ok: false, failure: failure('setup_failed', `Retest could not read the saved state ${JSON.stringify(state)}: ${errorMessage(error)}`) }
    }
  }

  async #saveSetupState(context: PagesContext, { test, targets }: Described, pages: readonly AppPage[]): Promise<Failure | undefined> {
    const [page] = pages
    if (test.registered.setup !== true || page === undefined) return undefined
    const target = targets[page.app]
    return target === undefined ? undefined : saveState(context, page, test.registered.name, target)
  }

  // A setup's result decides its state for that target: its dependents do not run without it. A cleanup failure
  // alone comes after the state was saved.
  #settled({ test, targets }: Described, result: TestResult): TestResult {
    const [app] = test.apps
    const target = app === undefined ? undefined : targets[app]
    if (test.registered.setup !== true || target === undefined) return result
    const key = stateKey(test.registered.name, target)
    if (result.failure === undefined) this.#states.set(key, { ok: true })
    else this.#states.set(key, { ok: false, failure: result.failure, target })
    return result
  }

  #missingState({ test, targets }: Described, plan: Plan): Failure | undefined {
    for (const [app, state] of test.states) {
      const target = targets[app]
      const outcome = target === undefined ? undefined : this.#states.get(stateKey(state, target))
      if (outcome?.ok === true) continue
      if (outcome !== undefined) {
        return { ...outcome.failure, message: `Not run: the setup ${JSON.stringify(state)} did not pass on ${outcome.target}. ${outcome.failure.message}` }
      }
      const setup = plan.setups.get(state)
      const where = setup === undefined ? 'no file in this run' : `${setup.test.file}, which could not be collected`
      return failure('setup_failed', `Not run: the setup ${JSON.stringify(state)} is in ${where}.`)
    }
    return undefined
  }

  // The body, settled: every command answered or reported as unknown. The test keeps hearing its pages' navigations
  // until the caller closes it, after the host checks.
  async #runBody(child: TestFileProcess, pages: readonly AppPage[], described: Described, config: RunConfig, evaluations: AttemptEvaluations): Promise<{ report: BodyReport; running: RunningTest }> {
    const { test, testId: id, attemptId, variant } = described
    const timeouts = { ...this.#options.timeouts, ...(test.registered.timeout === undefined ? {} : { test: test.registered.timeout }) }
    const appOrigins = test.apps.flatMap((app) => originOf(config.apps.get(app)?.baseUrl) ?? [])
    const fillSecret: RunningTestOptions['fillSecret'] = (command, context) => this.#secrets.resolve(command, { ...context, appOrigins })
    const running = new RunningTest({
      process: child,
      pages: new Map(pages.map(({ app, page }) => [app, page])),
      testId: id,
      attemptId,
      ...(variant === undefined ? {} : { variant }),
      timeouts,
      emit: (body, origin) => this.#emitFor(described, body, origin),
      ...(config.variants ? { fillSecret } : {}),
      redactor: this.#redactor,
      touch: new Set(pages.filter((page) => page.touch).map(({ app }) => app)),
      evaluations,
    })
    // The test is known as running only while its body runs, as before: a browser lost while it settles is the
    // next test's problem, not this one's.
    const active = { running, browsers: pages.map(({ browser }) => browser) }
    this.#running.add(active)
    let report: BodyReport
    try {
      report = await running.run()
    } finally {
      this.#running.delete(active)
    }
    await running.settle(this.#settleBudget())
    return { report, running }
  }

  // An interrupted run waits for nothing more.
  #settleBudget(): number {
    return this.#interruption === undefined ? this.#options.timeouts.cleanup : 0
  }

  // A body that never ran leaves only blank pages: they are released, and nothing is captured from them. A capture
  // that started is ended and written, though no result names it.
  async #bodyNotRun(context: PagesContext, pages: readonly AppPage[], exit: ProcessExit, diagnostics?: AttemptDiagnostics): Promise<Ran> {
    await diagnostics?.finishNative('attempt_ended')
    const { cleanupFailures, leftOpen } = await this.#closePages(context, pages)
    return { kind: 'not_run', reason: endedBeforeTest(exit), cleanupFailures, leftOpen }
  }

  #finishTest(finished: Finished): TestResult {
    const { failure: problem, cleanupFailures } = finished
    const status = testStatus(problem, cleanupFailures)
    const durationMs = elapsedMs(finished.startedAt)
    const outcome = {
      ...(problem === undefined ? {} : { failure: problem }),
      ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
    }
    const { testId: id, attemptId, assertionCount } = finished
    const checks = hostCheckResults(finished.checked ?? notRunHostChecks(finished.hostChecks))
    const evaluated = evaluationResults(finished.evaluated ?? this.#notRunEvaluations(finished))
    const ending = attemptEnding({
      status,
      failure: problem,
      cleanupFailures,
      hostChecks: checks.hostChecks,
      evaluations: evaluated.evaluations,
      seen: finished.seen,
      crashed: finished.crashed === true,
      browserLost: finished.browserLost === true,
      interruption: this.#interruption,
    })
    const { finalBundle } = finished
    const bundle = finalBundle === undefined ? {} : { bundle: finalBundle }
    this.#emitFor(finished, { type: 'test.finished', testId: id, attemptId, status, durationMs, assertionCount, ...outcome, ending, ...bundle })
    const execution = finished.execution === undefined ? undefined : withFinalBundle(finished.execution, finalBundle)
    const records = attemptRecords({ ...finished, ...(execution === undefined ? {} : { execution }) })
    const diagnostics = finished.diagnostics === undefined || finished.diagnostics.length === 0 ? {} : { diagnostics: finished.diagnostics }
    return this.#settled(finished, { ...this.#resultHead(finished), status, durationMs, assertionCount, ...outcome, ...checks, ...evaluated, ...records, ending, ...diagnostics, evidence: finished.evidence })
  }

  // A check the host required of a skipped test is never made, and test code cannot waive it, so it fails the run.
  #skip(attempt: Attempt, planned: Planned): void {
    const described = this.#describe(attempt, planned)
    this.#record(attempt.test.file).tests.push(this.#skipped(described))
    const { testId: id, test, hostChecks, hostEvaluations } = described
    this.#hostFailures.push(...skippedCheckFailures({ testId: id, location: test.registered.location, hostChecks, hostEvaluations: hostEvaluations.map((check) => check.id) }))
  }

  // A skipped test never starts: it has no test.started, no pages and no verdict of its own.
  #skipped(described: Described): TestResult {
    const { testId: id, attemptId } = described
    const ending = { kind: 'skipped' as const }
    this.#emitFor(described, { type: 'test.finished', testId: id, attemptId, status: 'skipped', durationMs: 0, assertionCount: 0, ending })
    const checks = hostCheckResults(notRunHostChecks(described.hostChecks))
    const evaluated = evaluationResults(this.#notRunEvaluations(described))
    return { ...this.#resultHead(described), status: 'skipped', durationMs: 0, assertionCount: 0, ...checks, ...evaluated, ending, evidence: [] }
  }

  #notRun(described: Described, reason: Failure, cleanupFailures: Failure[] = [], attempt: AttemptRecords = {}): TestResult {
    const cleanup = cleanupFailures.length === 0 ? {} : { cleanupFailures }
    const { testId: id, attemptId } = described
    const checks = hostCheckResults(notRunHostChecks(described.hostChecks))
    const evaluated = evaluationResults(this.#notRunEvaluations(described))
    const ending = attemptEnding({ status: 'not_run', failure: reason, cleanupFailures, hostChecks: checks.hostChecks, evaluations: evaluated.evaluations, interruption: this.#interruption })
    this.#emitFor(described, { type: 'test.finished', testId: id, attemptId, status: 'not_run', durationMs: 0, assertionCount: 0, failure: reason, ...cleanup, ending })
    const records = attemptRecords(attempt)
    return this.#settled(described, { ...this.#resultHead(described), status: 'not_run', durationMs: 0, assertionCount: 0, failure: reason, ...cleanup, ...checks, ...evaluated, ...records, ending, evidence: [] })
  }

  #notRunEvaluations(described: Described): EvaluationRecord[] {
    return notRunRecords(described.hostEvaluations, (text) => this.#redactor.redact(text))
  }

  #resultHead({ test, testId: id, attemptId, variant }: Described): Pick<TestResult, 'testId' | 'name' | 'file' | 'location' | 'describePath' | 'variant' | 'variantKey' | 'setup' | 'attemptId'> {
    const variantFields = variant === undefined ? {} : { variant, variantKey: variantKey(variant) }
    const { name, location } = test.registered
    return { testId: id, name, file: test.file, location, ...describePath(test), ...variantFields, ...setupMark(test), attemptId }
  }

  #describe({ test, targets }: Attempt, planned: Planned): Described {
    const described = {
      testId: test.testId,
      attemptId: newAttemptId(),
      test,
      targets,
      hostChecks: testHostChecks(this.#hostChecks, test),
      hostEvaluations: this.#evaluations.hostChecksFor(test),
      hostPreparations: testPreparations(this.#preparations, test),
    }
    return planned.config.variants ? { ...described, variant: targets } : described
  }

  // Every event of an attempt carries its variant, which the child never sends.
  #emitFor({ variant }: Pick<Described, 'variant'>, body: EventBody, origin?: EventOrigin): void {
    if (body.type === 'native.ended') this.#nativeEnded.add(body.sessionId)
    if (variant === undefined || !('attemptId' in body)) {
      this.#events.emit(body, origin)
      return
    }
    this.#events.emit({ ...body, variant, variantKey: variantKey(variant) }, origin)
  }

  // The attempt's diagnostics, before any capture starts. Each web page's capture starts within the setup budget once
  // the pages are open, and one that cannot start is recorded as unavailable while the attempt goes on.
  #attemptDiagnostics(described: Described): AttemptDiagnostics {
    return new AttemptDiagnostics({
      policy: this.#diagnostics,
      redactor: this.#redactor,
      writeArtifact: (path, bytes) => this.#store.writeArtifact(path, bytes),
      emit: (body) => this.#emitFor(described, body),
      testId: described.testId,
      attemptId: described.attemptId,
      variant: described.variant,
      named: described.variant !== undefined,
    })
  }

  // A native app's sources start before it launches: the declared network file's interval opens now, and the launch
  // binds the app's standard output to the log source. An app whose target declares no network file has none, and says
  // so; one whose target keeps no log, or in a run that captures nothing, is launched by its executor.
  async #watchNative(diagnostics: AttemptDiagnostics, browser: NativeBrowserAdapter, session: SessionIdentity): Promise<Failure | undefined> {
    try {
      const sources = await diagnostics.startNative(session.owner.app, session, browser.target.diagnostics?.network)
      if (this.#diagnostics.capture) browser.keepLogs(sources.logs)
      return undefined
    } catch (error) {
      return failure('setup_failed', `Retest could not start the diagnostics of ${session.owner.app}: ${this.#redactor.redact(errorMessage(error))}`)
    }
  }

  #connected(browser: OwnedBrowser): boolean { return browser instanceof NativeBrowserAdapter ? this.#native.connected(browser) : this.#browsers.connected(browser) }

  #pagesContext(described: Described): PagesContext {
    return {
      store: this.#store,
      timeouts: this.#options.timeouts,
      stopped: this.#stopped.promise,
      interruption: () => this.#interruption,
      connected: (browser) => this.#connected(browser),
      release: (work) => void this.#releases.push(work.catch(() => undefined)),
      named: described.variant !== undefined,
      emit: (body) => this.#emitFor(described, body),
      redact: (text) => this.#redactor.redact(text),
      testId: described.testId,
      attemptId: described.attemptId,
    }
  }

  #record(file: string): FileRecord {
    const known = this.#records.get(file)
    if (known !== undefined) return known
    const record: FileRecord = { tests: [], failures: [] }
    this.#records.set(file, record)
    return record
  }

  // Results are recorded as attempts end, and skipped ones before any runs; the file lists them as collection did.
  #fileResult({ file, tests: planned }: Extract<PlannedFile, { ok: true }>, variants: boolean): FileResult {
    const record = this.#record(file)
    const tests = inDeclarationOrder(record.tests, planned, variants)
    const { failures } = record
    const [first, ...rest] = failures
    return first === undefined ? { file, collection: 'ok', tests } : { file, collection: 'ok', failure: withAlso(first, rest), tests }
  }

  #collectionFailed(file: string, reason: Failure): FileResult {
    this.#events.emit({ type: 'collection.failed', file, failure: reason })
    return { file, collection: 'failed', failure: reason, tests: [] }
  }

  #notLoaded(): Failure {
    const reason = this.#stopReason ?? failure('interrupted', 'The run was interrupted.')
    return failure(reason.class, `Not loaded: ${reason.message}`)
  }

  #spawn(onOutput: Output['write']): TestFileProcess {
    const { testEnvironment } = this.#options
    const environment = testEnvironment === undefined ? {} : { environment: testEnvironment }
    const child = TestFileProcess.spawn({ onOutput, hiddenVariables: this.#hiddenVariables, playwright: this.#options.playwright === true, ...environment })
    this.#processes.add(child)
    return child
  }

  async #forget(child: TestFileProcess): Promise<void> {
    await child.kill()
    this.#processes.delete(child)
  }

  // Each stream is redacted as it arrives; a tail that may be part of a secret waits for the next chunk.
  #outputFor(file: string, logFile: string): Output {
    const streams = { stdout: this.#redactor.stream(), stderr: this.#redactor.stream() }
    const keep = (stream: ChildOutput['stream'], text: string): void => {
      if (text === '') return
      try {
        this.#store.appendLog(logFile, text)
        this.#options.onOutput?.({ file, stream, text })
      } catch (error) {
        this.#events.reportFailure(failure('reporting_failed', `Retest could not keep the output of ${file}: ${errorMessage(error)}`))
      }
    }
    return {
      write: (stream, text) => keep(stream, streams[stream].write(text)),
      end: () => {
        keep('stdout', streams.stdout.end())
        keep('stderr', streams.stderr.end())
      },
    }
  }

  #interrupt(): void {
    if (this.#interruption !== undefined) return
    const stoppedBy = stopReasonOf(this.#options.signal)
    const reason = interruptionOf(stoppedBy)
    this.#stoppedBy = stoppedBy
    this.#interruption = reason
    this.#stopReason = reason
    this.#stopped.resolve()
    for (const test of this.#running) test.running.revoke(reason, 0)
    for (const process of this.#processes) void process.kill()
  }

  // Browsers close before the servers their pages talked to stop; saved states go last. A state that stays
  // behind holds session cookies, so failing to remove it fails the run.
  async #release(): Promise<void> {
    for (const failure of await this.#native.close()) this.#events.reportFailure(failure)
    try { await this.#browsers.close() }
    catch (error) { this.#events.reportFailure(failure('cleanup_failed', `Closing the run's browsers: ${errorMessage(error)}`)) }
    await bounded(Promise.all(this.#letting), this.#options.timeouts.cleanup)
    // The table the desktop, devices and data folders live in outlasts the run. What still comes free now is given back;
    // a part whose app is still there stays held, and its lease says so.
    await Promise.all([...this.#leases].map((lease) => lease.finish(this.#options.timeouts.cleanup)))
    for (const problem of await this.#servers.stop()) this.#events.reportFailure(problem)
    await this.#evaluations.close(this.#options.timeouts.cleanup)
    await bounded(Promise.all(this.#releases), this.#options.timeouts.cleanup)
    try {
      this.#store.removeStates()
    } catch (error) {
      this.#events.reportFailure(failure('cleanup_failed', `Retest could not remove the saved states: ${errorMessage(error)}`))
    }
    // Rewriting a log while its writer is still active can race an issued write. A timeout fails cleanup and keeps
    // the rewrite pending until every browser writer has actually settled.
    const outputSettled = Promise.all(this.#browsers.outputSettlements).then(() => undefined)
    const output = await bounded(outputSettled, this.#options.timeouts.cleanup)
    if (output.status === 'done') this.#redactLogs()
    else {
      const message = output.status === 'failed'
        ? `Browser output did not settle: ${errorMessage(output.error)}`
        : 'Browser output is still pending; final log redaction could not be confirmed.'
      this.#events.reportFailure(failure('cleanup_failed', message))
      void outputSettled.then(() => this.#redactLogs(), () => undefined)
    }
  }

  // Browsers and servers write their own logs, and every log was redacted with what was known as it was written,
  // so all of them are read again once the browsers, the servers and the test file processes are gone.
  #redactLogs(): void {
    if (!this.#redactor.active) return
    try {
      this.#store.redactLogs((text) => this.#redactor.redact(text))
      this.#store.redactDiagnostics((text) => this.#redactor.redact(text))
    } catch (error) {
      this.#events.reportFailure(failure('reporting_failed', `Retest could not redact the logs: ${errorMessage(error)}`))
    }
  }

  // Clocks and test facts are fixed once. The settled outcome is persisted after reporters end, so a final
  // reporter failure is part of the event record as well as result.json.
  async #finish(files: FileResult[]): Promise<RunResult> {
    await this.#events.flush()
    const browsers = this.#browsers.started.map((started) => started.info)
    const facts: ResultFacts = {
      schemaVersion: 1,
      runId: this.#runId,
      retestVersion,
      startedAt: this.#startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: elapsedMs(this.#start),
      browser: browsers[0] ?? null,
      ...(this.#nativeStarts.length === 0 ? {} : { natives: this.#nativeStarts }),
      ...(this.#options.apps.kind === 'config' ? { browsers } : {}),
      ...(this.#narrowed === undefined ? {} : { narrowed: this.#narrowed }),
      files,
    }
    this.#writeLastRun(facts)
    const finished = this.#result(facts)
    const { status, exitCode, complete, counts, durationMs, failure: problem } = finished
    this.#events.emit({ type: 'run.finished', resultFacts: { startedAt: facts.startedAt, finishedAt: facts.finishedAt, ...(this.#options.apps.kind === 'config' ? { namedApps: true as const } : {}) }, status, exitCode, complete, counts, durationMs, ...(problem === undefined ? {} : { failure: problem }) })
    await this.#events.end(finished)
    const settled = this.#result(facts)
    if (!isDeepStrictEqual(settled, finished)) this.#events.recordOutcome(settled)
    try {
      const result = this.#result(facts)
      this.#store.writeResult(result)
      return result
    } catch (error) {
      this.#events.reportFailure(failure('reporting_failed', `Retest could not write result.json: ${errorMessage(error)}`))
      this.#events.recordOutcome(this.#result(facts))
      return this.#result(facts)
    }
  }

  // `lastRunFile: false` records nothing, and a path records there instead of under the root directory.
  #writeLastRun(facts: ResultFacts): void {
    const path = lastRunPath(this.#rootDir, this.#options.lastRunFile)
    if (path === undefined) return
    try {
      writeLastRun(path, lastRunOf(facts))
    } catch (error) {
      const shown = this.#options.lastRunFile === undefined ? relativePosixPath(this.#rootDir, path) : path
      this.#events.reportFailure(failure('reporting_failed', `Retest could not write ${shown}: ${errorMessage(error)}`))
    }
  }

  #result(facts: ResultFacts): RunResult {
    const outcome = runOutcome({ stoppedBy: this.#stoppedBy, runFailures: this.#runFailures, hostFailures: this.#hostFailures, outputFailures: this.#events.failures, files: facts.files })
    return this.#redactor.redactFields(runResultSchema, withOutcome(facts, outcome))
  }
}

// An Electron app on a data folder its target names starts from whatever that folder holds; Retest made every other
// folder an app or a browser starts from, for this attempt alone.
function freshOrReused(config: RunConfig, app: string, target: string | undefined): 'fresh' | 'reused' {
  const loaded = target === undefined ? undefined : config.apps.get(app)?.targets.get(target)
  return loaded !== undefined && 'browser' in loaded && loaded.browser === 'electron' && loaded.userDataDir !== undefined ? 'reused' : 'fresh'
}

function targetOf(config: RunConfig, app: string, target: string | undefined): LoadedTarget | undefined {
  return target === undefined ? undefined : config.apps.get(app)?.targets.get(target)
}

// The pool hands an Electron app out as a browser; only an Electron app says when its processes are gone.
function isElectronRuntime(browser: OwnedBrowser): browser is ElectronRuntime {
  return 'gone' in browser && 'closeRequested' in browser
}

// A state is saved once for each target, so the pair names one outcome.
function stateKey(state: string, target: string): string {
  return JSON.stringify([state, target])
}

function withOutcome(facts: ResultFacts, outcome: RunOutcome): RunResult {
  const { files, ...head } = facts
  const { complete, status, exitCode, counts, failure: problem } = outcome
  return { ...head, complete, status, exitCode, counts, ...(problem === undefined ? {} : { failure: problem }), files }
}

// A result lists host checks only for a test that had some.
function hostCheckResults(results: HostCheckResult[]): { hostChecks?: HostCheckResult[] } {
  return results.length === 0 ? {} : { hostChecks: results }
}

// A result lists AI checks only for a test that had some.
function evaluationResults(records: EvaluationRecord[]): { evaluations?: EvaluationRecord[] } {
  return records.length === 0 ? {} : { evaluations: records }
}

// A result lists the execution identity of an attempt that started, and the host's preparations and cleanups only
// when it had some.
function attemptRecords({ execution, preparations, cleanups }: AttemptRecords): AttemptRecords {
  return {
    ...(execution === undefined ? {} : { execution }),
    ...(preparations === undefined || preparations.length === 0 ? {} : { preparations }),
    ...(cleanups === undefined || cleanups.length === 0 ? {} : { cleanups }),
  }
}

function describePath(test: PlannedTest): { describePath?: string[] } {
  return test.describePath.length === 0 ? {} : { describePath: test.describePath }
}

function setupMark(test: PlannedTest): { setup?: true } {
  return test.registered.setup === true ? { setup: true } : {}
}

// Base URLs keep their credentials for the browser; everything recorded or printed goes without them.
function recordedBaseUrls(baseUrls: Readonly<Record<string, string>> | undefined): { baseUrls?: Record<string, string> } {
  if (baseUrls === undefined || Object.keys(baseUrls).length === 0) return {}
  return { baseUrls: Object.fromEntries(Object.entries(baseUrls).map(([app, url]) => [app, withoutCredentials(url)])) }
}

function describeReporters(reporters: readonly Reporter[]): string {
  return reporters.length === 0 ? 'none' : reporters.map((reporter) => reporter.name).join(',')
}

function targetsName(targets: Variant, app: string): string { return targets[app] ?? app }
