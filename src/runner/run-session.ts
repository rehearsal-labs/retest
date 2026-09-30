import type { NewPageOptions, OwnedBrowser } from '../browser/contract.ts'
import type { EventBody, EventOrigin } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheckResult } from '../protocol/host-check.ts'
import type { Evidence, FileResult, RunResult, TestResult } from '../protocol/result.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import type { Variant } from '../protocol/variant.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { RunStore } from '../store/run-store.ts'
import type { FindExecutable, LaunchBrowser, ReadyTarget } from './browser-pool.ts'
import type { ChildOutput, RunOptions } from './contract.ts'
import type { HostChecks, TestHostCheck } from './host-checks.ts'
import type { RunOutcome } from './outcome.ts'
import type { CollectedTests, Plan, PlannedTest } from './plan.ts'
import type { RunConfig } from './run-config.ts'
import type { BodyReport, RunningTestOptions } from './running-test.ts'
import type { Attempt, Visit } from './schedule.ts'
import type { AppPage, PagesContext } from './test-pages.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { retestEventSchema } from '../protocol/events.ts'
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
import { BrowserPool } from './browser-pool.ts'
import { EventLog } from './event-log.ts'
import { hostChecksScopeProblem, hostChecksShapeProblem, notRunHostChecks, recordedHostChecks, testHostChecks } from './host-checks.ts'
import { lastRunOf, writeLastRun } from './last-run.ts'
import { loadTests, missingFileFailure } from './load-tests.ts'
import { runOutcome, stopSignalOf, testStatus } from './outcome.ts'
import { collectedTest, planTests } from './plan.ts'
import { endedBeforeTest, fileProcessFailure, laterTestsReason, reportedErrors } from './process-failures.ts'
import { Redactor } from './redactor.ts'
import { runConfig } from './run-config.ts'
import { runHostChecks } from './run-host-checks.ts'
import { abortGraceMs, RunningTest } from './running-test.ts'
import { scheduleRun } from './schedule.ts'
import { SecretFiller, secretValuesProblem, secretVariables } from './secrets.ts'
import { emptySelectionFailure, selectionProblem } from './selection.ts'
import { searchSetups } from './setup-search.ts'
import { TestFileProcess } from './test-file-process.ts'
import { captureFailure, disposePages, openPage, saveState } from './test-pages.ts'

export type RunSessionOptions = {
  options: RunOptions
  reporters: readonly Reporter[]
  launch: LaunchBrowser
  findExecutable: FindExecutable
  store: RunStore
}

type Opened<T> = { ok: true; value: T } | { ok: false; failure: Failure }
/**
 * One attempt as its events and result name it, and the host checks it has. `variant` is absent in milestone 1's
 * mode.
 */
type Described = { testId: string; attemptId: string; test: PlannedTest; targets: Variant; variant?: Variant; hostChecks: TestHostCheck[] }
type TestOutcome = { result: TestResult; laterTests?: Failure }
/** `checked` is each host check's result once they ran; without it, every check is listed as not run. */
type Finished = Described & {
  startedAt: number
  failure: Failure | undefined
  assertionCount: number
  evidence: Evidence[]
  cleanupFailures: Failure[]
  checked?: HostCheckResult[]
}
/** What a file's visits added up to: its results in the order they ran, and its process failures. */
type FileRecord = { tests: TestResult[]; failures: Failure[] }
type Output = { write: (stream: ChildOutput['stream'], text: string) => void; end: () => void }
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
 * file: setups first, once per target, then the rest in file order. Browsers and app servers start the first
 * time a test needs them, and every test gets a new page for each of its apps.
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
  readonly #browsers: BrowserPool
  readonly #servers: AppServers
  readonly #secrets: SecretFiller
  readonly #hiddenVariables: string[]
  /** The run's host checks, once their shape is known to be right. */
  readonly #hostChecks: HostChecks | undefined
  readonly #hostChecksProblem: Failure | undefined
  #stopReason: Failure | undefined
  #interruption: Failure | undefined
  #test: { running: RunningTest; browsers: readonly OwnedBrowser[] } | undefined

  constructor({ options, reporters, launch, findExecutable, store }: RunSessionOptions) {
    const { apps, timeouts } = options
    this.#options = options
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
    const named = apps.kind === 'config'
    this.#browsers = new BrowserPool({
      launch,
      findExecutable: named ? findExecutable : async () => ({ ok: true, path: apps.browserPath }),
      logFile: (app, target) => store.pathOf(named ? targetBrowserLogFile(variantKey({ [app]: target })) : browserLogFile),
      headless: options.headless,
      named,
      timeouts,
      stopped: this.#stopped.promise,
      interruption: () => this.#interruption,
      onStarted: ({ info, userAgent, pid }) => this.#events.emit({ type: 'browser.started', ...info, userAgent, pid }),
      onLost: (browser, reason) => {
        if (this.#test?.browsers.includes(browser) === true) this.#test.running.browserLost(reason)
      },
    })
    this.#servers = new AppServers({
      logFile: (app) => store.pathOf(appLogFile(app)),
      redactor: this.#redactor,
      setupMs: timeouts.setup,
      signal: options.signal,
      emit: (body) => void this.#events.emit(body),
    })
    const declared = apps.kind === 'config' ? apps.config.secrets : new Map()
    this.#secrets = new SecretFiller(apps.kind === 'config' ? apps.secrets : new Map(), declared, this.#redactor)
    this.#hiddenVariables = secretVariables(declared)
    this.#hostChecksProblem = options.hostChecks === undefined ? undefined : hostChecksShapeProblem(options.hostChecks)
    this.#hostChecks = this.#hostChecksProblem === undefined ? options.hostChecks : undefined
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
    const checks = this.#hostChecks === undefined ? {} : { hostChecks: recordedHostChecks(this.#hostChecks) }
    this.#events.emit({
      type: 'run.started',
      retestVersion,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      rootDir: this.#rootDir,
      files: this.#files,
      options: { ...recorded, timeouts, ...(commandLineTimeouts === undefined ? {} : { commandLineTimeouts }), reporter: this.#reporterNames, ...checks },
    })
  }

  // A run the command line or the caller set up wrongly loads nothing, and neither does one that matches no
  // test. Host checks that name no test the run will run, or an app a test does not use, start nothing.
  async #runFiles(): Promise<FileResult[]> {
    const { apps } = this.#options
    const configured = runConfig(apps)
    const selection = this.#options.selection ?? {}
    const problem = configured.ok ? selectionProblem(selection, this.#files, configured.config) : configured.failure
    const secrets = apps.kind === 'config' ? secretValuesProblem(apps.secrets) : undefined
    for (const found of [problem, secrets, this.#hostChecksProblem]) if (found !== undefined) this.#failRun(found)
    if (!configured.ok) return this.#files.map((file) => this.#collectionFailed(file, this.#notLoaded()))
    const planned: Planned = { config: configured.config, plan: await this.#plan(configured.config) }
    const schedule = scheduleRun(planned.plan, selection, planned.config.variants)
    const collected = planned.plan.files.some((file) => file.ok && file.tests.length > 0)
    if (this.#stopReason === undefined && schedule.selected === 0 && collected) this.#failRun(emptySelectionFailure(selection))
    const checks = this.#stopReason === undefined ? this.#hostChecksScope(planned.plan, schedule.visits) : undefined
    if (checks !== undefined) this.#failRun(checks)
    for (const visit of schedule.visits) await this.#runVisit(visit, planned)
    return planned.plan.files.map((file) => (file.ok ? this.#fileResult(file.file) : { file: file.file, collection: 'failed', failure: file.failure, tests: [] }))
  }

  #failRun(problem: Failure): void {
    this.#runFailures.push(problem)
    this.#stopReason ??= problem
  }

  #hostChecksScope(plan: Plan, visits: readonly Visit[]): Failure | undefined {
    if (this.#hostChecks === undefined) return undefined
    const tests = [...new Map(visits.flatMap((visit) => visit.attempts).map(({ test }) => [test.testId, test])).values()]
    const unloaded = plan.files.flatMap((file) => (file.ok ? [] : [file.file]))
    return hostChecksScopeProblem(this.#hostChecks, tests, unloaded)
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
  async #runVisit({ file, attempts }: Visit, planned: Planned): Promise<void> {
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
      const ran = await this.#loadAndRun(child, file, attempts, planned)
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

  async #loadAndRun(child: TestFileProcess, file: string, attempts: readonly Attempt[], planned: Planned): Promise<{ loaded: boolean; tests: TestResult[]; exitRecorded: boolean }> {
    const logFile = childLogFile(file)
    const loaded = await loadTests(child, { file, rootDir: this.#rootDir, timeoutMs: this.#options.timeouts.collection, logFile })
    if (!loaded.ok) {
      const reason = this.#interruption ?? withAlso(loaded.failure, reportedErrors(file, child.errors))
      return { loaded: false, tests: attempts.map((attempt) => this.#notRun(this.#describe(attempt, planned), reason)), exitRecorded: false }
    }
    const declared = new Set(loaded.tests.map((test) => testId(file, testTitle(test.name, (test.describes ?? []).map((block) => block.name)))))
    const tests: TestResult[] = []
    let laterTests: Failure | undefined
    for (const attempt of attempts) {
      const described = this.#describe(attempt, planned)
      const outcome = declared.has(described.testId)
        ? await this.#runAttempt(child, described, planned, laterTests)
        : { result: this.#notRun(described, failure('collection_failed', 'Not run: its file no longer declared it when it loaded again to run it.')) }
      tests.push(outcome.result)
      laterTests ??= outcome.laterTests
    }
    return { loaded: true, tests, exitRecorded: laterTests !== undefined }
  }

  async #runAttempt(child: TestFileProcess, described: Described, planned: Planned, notRunReason: Failure | undefined): Promise<TestOutcome> {
    const skip = this.#stopReason ?? notRunReason ?? this.#missingState(described, planned.plan)
    if (skip !== undefined) return { result: this.#notRun(described, skip) }
    if (child.exit !== undefined) return { result: this.#notRun(described, endedBeforeTest(child.exit)) }
    const ready = await this.#prepare(described, planned.config)
    if (!ready.ok) return { result: this.#notRun(described, this.#stopReason ?? ready.failure) }
    const startedAt = monotonicClock()
    const { test } = described
    const shown = { name: test.registered.name, file: test.file, location: test.registered.location, ...describePath(test), ...setupMark(test) }
    this.#emitFor(described, { type: 'test.started', testId: described.testId, attemptId: described.attemptId, ...shown })
    const finished: Finished = { ...described, startedAt, failure: undefined, assertionCount: 0, evidence: [], cleanupFailures: [] }
    const context = this.#pagesContext(described)
    const opened = await this.#openPages(context, described, ready.value, planned.config)
    if (!opened.ok) return { result: this.#finishTest({ ...finished, failure: opened.failure }) }
    if (this.#interruption !== undefined) return { result: this.#finishTest({ ...finished, failure: this.#interruption }) }
    const pages = opened.value
    // Code the previous test left behind can end the process while the pages open.
    if (child.exit !== undefined) return { result: await this.#bodyNotRun(context, described, pages, child.exit) }
    const report = await this.#runBody(child, pages, described, planned.config)
    if (report.endedBeforeStart !== undefined) return { result: await this.#bodyNotRun(context, described, pages, report.endedBeforeStart) }
    // Host checks read the pages as the body left them, so they come before the screenshot and the saved state.
    const checked = report.failure === undefined ? await runHostChecks(context, pages, described.hostChecks) : undefined
    const verdict = report.failure ?? checked?.failure
    const evidence = verdict === undefined ? [] : await captureFailure(context, pages)
    const unsaved = verdict === undefined ? await this.#saveSetupState(context, described, pages) : undefined
    const cleanupFailures = await disposePages(context, pages)
    const problem = verdict ?? unsaved
    const ran = checked === undefined ? {} : { checked: checked.results }
    const result = this.#finishTest({ ...finished, failure: problem, assertionCount: report.assertionCount, evidence, cleanupFailures, ...ran })
    const laterTests = laterTestsReason(test.registered.name, report)
    return laterTests === undefined ? { result } : { result, laterTests }
  }

  // Every app's server and browser, before the test starts; any that is not ready keeps the test from running.
  async #prepare({ test, targets }: Described, config: RunConfig): Promise<Opened<Map<string, ReadyTarget>>> {
    const ready = new Map<string, ReadyTarget>()
    for (const name of test.apps) {
      const app = config.apps.get(name)
      const targetName = targets[name]
      const target = targetName === undefined ? undefined : app?.targets.get(targetName)
      if (app === undefined || target === undefined) return { ok: false, failure: failure('test_error', `The config has no target ${JSON.stringify(targetName)} for ${name}.`) }
      const unready = await this.#servers.ensure(app)
      if (unready !== undefined) return { ok: false, failure: this.#interruption ?? unready }
      const browser = await this.#browsers.ensure(app, target)
      if (!browser.ok) return browser
      ready.set(name, browser.value)
    }
    return { ok: true, value: ready }
  }

  async #openPages(context: PagesContext, described: Described, ready: ReadonlyMap<string, ReadyTarget>, config: RunConfig): Promise<Opened<AppPage[]>> {
    const pages: AppPage[] = []
    for (const [app, { browser, emulation, proxy }] of ready) {
      const state = this.#restoredState(described, app)
      if (state !== undefined && !state.ok) {
        await disposePages(context, pages)
        return state
      }
      const baseUrl = config.apps.get(app)?.baseUrl
      const options: NewPageOptions = {
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(emulation === undefined ? {} : { emulation }),
        ...(state === undefined ? {} : { storageState: state.value.storage }),
        ...(proxy === undefined ? {} : { proxy }),
      }
      const opened = await openPage(context, browser, options)
      if (!opened.ok) {
        await disposePages(context, pages)
        return opened
      }
      pages.push({ app, page: opened.value, browser, touch: emulation?.touch === true })
      if (state !== undefined) this.#emitFor(described, { type: 'state.restored', testId: described.testId, attemptId: described.attemptId, ...state.value.named })
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

  async #runBody(child: TestFileProcess, pages: readonly AppPage[], described: Described, config: RunConfig): Promise<BodyReport> {
    const { test, testId: id, attemptId, variant } = described
    const timeouts = { ...this.#options.timeouts, ...(test.registered.timeout === undefined ? {} : { test: test.registered.timeout }) }
    const appOrigins = test.apps.flatMap((app) => originOf(config.apps.get(app)?.baseUrl) ?? [])
    const fillSecret: RunningTestOptions['fillSecret'] = (command, pageUrl, timeoutMs) => this.#secrets.resolve(command, { pageUrl, appOrigins, timeoutMs })
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
    })
    this.#test = { running, browsers: pages.map(({ browser }) => browser) }
    const report = await running.run()
    this.#test = undefined
    await running.settle(this.#interruption === undefined ? timeouts.cleanup : 0)
    running.close()
    return report
  }

  // A body that never ran leaves only blank pages: they are released, and nothing is captured from them.
  async #bodyNotRun(context: PagesContext, described: Described, pages: readonly AppPage[], exit: ProcessExit): Promise<TestResult> {
    const cleanupFailures = await disposePages(context, pages)
    return this.#notRun(described, endedBeforeTest(exit), cleanupFailures)
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
    this.#emitFor(finished, { type: 'test.finished', testId: id, attemptId, status, durationMs, assertionCount, ...outcome })
    const checks = hostCheckResults(finished.checked ?? notRunHostChecks(finished.hostChecks))
    return this.#settled(finished, { ...this.#resultHead(finished), status, durationMs, assertionCount, ...outcome, ...checks, evidence: finished.evidence })
  }

  #notRun(described: Described, reason: Failure, cleanupFailures: Failure[] = []): TestResult {
    const cleanup = cleanupFailures.length === 0 ? {} : { cleanupFailures }
    const { testId: id, attemptId } = described
    this.#emitFor(described, { type: 'test.finished', testId: id, attemptId, status: 'not_run', durationMs: 0, assertionCount: 0, failure: reason, ...cleanup })
    const checks = hostCheckResults(notRunHostChecks(described.hostChecks))
    return this.#settled(described, { ...this.#resultHead(described), status: 'not_run', durationMs: 0, assertionCount: 0, failure: reason, ...cleanup, ...checks, evidence: [] })
  }

  #resultHead({ test, testId: id, attemptId, variant }: Described): Pick<TestResult, 'testId' | 'name' | 'file' | 'location' | 'describePath' | 'variant' | 'variantKey' | 'setup' | 'attemptId'> {
    const variantFields = variant === undefined ? {} : { variant, variantKey: variantKey(variant) }
    const { name, location } = test.registered
    return { testId: id, name, file: test.file, location, ...describePath(test), ...variantFields, ...setupMark(test), attemptId }
  }

  #describe({ test, targets }: Attempt, planned: Planned): Described {
    const described = { testId: test.testId, attemptId: newAttemptId(), test, targets, hostChecks: testHostChecks(this.#hostChecks, test) }
    return planned.config.variants ? { ...described, variant: targets } : described
  }

  // Every event of an attempt carries its variant, which the child never sends.
  #emitFor({ variant }: Pick<Described, 'variant'>, body: EventBody, origin?: EventOrigin): void {
    if (variant === undefined || !('attemptId' in body)) {
      this.#events.emit(body, origin)
      return
    }
    this.#events.emit({ ...body, variant, variantKey: variantKey(variant) }, origin)
  }

  #pagesContext(described: Described): PagesContext {
    return {
      store: this.#store,
      timeouts: this.#options.timeouts,
      stopped: this.#stopped.promise,
      interruption: () => this.#interruption,
      connected: (browser) => this.#browsers.connected(browser),
      release: (work) => void this.#releases.push(work.catch(() => undefined)),
      named: described.variant !== undefined,
      emit: (body) => this.#emitFor(described, body),
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

  #fileResult(file: string): FileResult {
    const { tests, failures } = this.#record(file)
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
    const child = TestFileProcess.spawn({ onOutput, hiddenVariables: this.#hiddenVariables, ...environment })
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
    const stopped = stopSignalOf(this.#options.signal) === 'SIGTERM' ? 'The run was stopped by SIGTERM.' : 'The run was interrupted.'
    const reason = failure('interrupted', stopped)
    this.#interruption = reason
    this.#stopReason = reason
    this.#stopped.resolve()
    this.#test?.running.revoke(reason, 0)
    for (const process of this.#processes) void process.kill()
  }

  // Browsers close before the servers their pages talked to stop; saved states go last. A state that stays
  // behind holds session cookies, so failing to remove it fails the run.
  async #release(): Promise<void> {
    await this.#browsers.close()
    await this.#servers.stop()
    await bounded(Promise.all(this.#releases), this.#options.timeouts.cleanup)
    try {
      this.#store.removeStates()
    } catch (error) {
      this.#events.reportFailure(failure('cleanup_failed', `Retest could not remove the saved states: ${errorMessage(error)}`))
    }
    this.#redactLogs()
  }

  // Browsers and servers write their own logs, and every log was redacted with what was known as it was written,
  // so all of them are read again once the browsers, the servers and the test file processes are gone.
  #redactLogs(): void {
    if (!this.#redactor.active) return
    try {
      this.#store.redactLogs((text) => this.#redactor.redact(text))
    } catch (error) {
      this.#events.reportFailure(failure('reporting_failed', `Retest could not redact the logs: ${errorMessage(error)}`))
    }
  }

  // Everything but the outcome is fixed once. Failures after run.finished, such as a reporter that breaks at
  // the end or a result.json that cannot be written, change only the outcome that result.json stores.
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
      ...(this.#options.apps.kind === 'config' ? { browsers } : {}),
      files,
    }
    try {
      writeLastRun(this.#rootDir, lastRunOf(facts))
    } catch (error) {
      this.#events.reportFailure(failure('reporting_failed', `Retest could not write .retest/last-run.json: ${errorMessage(error)}`))
    }
    const finished = this.#result(facts)
    const { status, exitCode, complete, counts, durationMs, failure: problem } = finished
    this.#events.emit({ type: 'run.finished', status, exitCode, complete, counts, durationMs, ...(problem === undefined ? {} : { failure: problem }) })
    await this.#events.end(finished)
    try {
      const result = this.#result(facts)
      this.#store.writeResult(result)
      return result
    } catch (error) {
      this.#events.reportFailure(failure('reporting_failed', `Retest could not write result.json: ${errorMessage(error)}`))
      return this.#result(facts)
    }
  }

  #result(facts: ResultFacts): RunResult {
    const stoppedBy = this.#interruption === undefined ? undefined : stopSignalOf(this.#options.signal)
    const outcome = runOutcome({ stoppedBy, runFailures: this.#runFailures, outputFailures: this.#events.failures, files: facts.files })
    return this.#redactor.redactFields(runResultSchema, withOutcome(facts, outcome))
  }
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
