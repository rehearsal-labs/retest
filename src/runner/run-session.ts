import type { LaunchOptions, OwnedBrowser, OwnedPage } from '../browser/contract.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RegisteredTest } from '../protocol/messages.ts'
import type { BrowserInfo, Evidence, FileResult, RunResult, TestResult } from '../protocol/result.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { RunStore } from '../store/run-store.ts'
import type { RunOptions } from './contract.ts'
import type { RunOutcome } from './outcome.ts'
import type { BodyReport } from './running-test.ts'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { closeGraceMs, LaunchError } from '../browser/contract.ts'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { errorMessage, failure, withAlso } from '../protocol/failures.ts'
import { browserLogFile, childLogFile, failureScreenshotFile, testId } from '../protocol/run-folder.ts'
import { withoutCredentials } from '../protocol/url.ts'
import { relativePosixPath } from '../shared/posix-path.ts'
import { retestVersion } from '../version.ts'
import { newAttemptId } from './attempt-id.ts'
import { bounded, type Bounded } from './bounded.ts'
import { EventLog } from './event-log.ts'
import { collectedTests, loadTests, missingFileFailure } from './load-tests.ts'
import { runOutcome, stopSignalOf, testStatus } from './outcome.ts'
import { endedBeforeTest, fileProcessFailure, laterTestsReason, reportedErrors } from './process-failures.ts'
import { abortGraceMs, RunningTest } from './running-test.ts'
import { TestFileProcess } from './test-file-process.ts'

/** Starts the run's browser. The runner passes its setup budget; tests pass a fake. */
export type LaunchBrowser = (options: LaunchOptions, timeoutMs: number) => Promise<OwnedBrowser>

export type RunSessionOptions = {
  options: RunOptions
  reporters: readonly Reporter[]
  launch: LaunchBrowser
  store: RunStore
}

type BrowserState =
  | { kind: 'not_started' }
  | { kind: 'ready'; browser: OwnedBrowser }
  | { kind: 'unavailable'; failure: Failure; browser?: OwnedBrowser }

type Opened<T> = { ok: true; value: T } | { ok: false; failure: Failure }
type TestScope = { testId: string; attemptId: string }
type DescribedTest = { scope: TestScope; file: string; test: RegisteredTest }
type TestOutcome = { result: TestResult; laterTests?: Failure }
/** A file's tests, or why it could not be collected. `exitRecorded` means a test's result says how its process ended. */
type FileRun = { collected: false; failure: Failure } | { collected: true; tests: TestResult[]; exitRecorded: boolean }
/** What a run's result says besides its outcome. It is fixed once the run is over. */
type ResultFacts = Omit<RunResult, keyof RunOutcome>
type Finished = DescribedTest & {
  startedAt: number
  failure: Failure | undefined
  assertionCount: number
  evidence: Evidence[]
  cleanupFailures: Failure[]
}

/**
 * One run of selected files: the parent's whole lifecycle. Files run one after another, each in its own
 * process; the browser starts once, when the first test needs it, and every test gets a new page.
 */
export class RunSession {
  readonly #options: RunOptions
  readonly #launch: LaunchBrowser
  readonly #store: RunStore
  readonly #events: EventLog
  readonly #reporterNames: string
  readonly #rootDir: string
  readonly #files: string[]
  readonly #runId = randomUUID()
  readonly #startedAt = new Date()
  readonly #start = monotonicClock()
  readonly #stopped = Promise.withResolvers<void>()
  readonly #releases: Promise<unknown>[] = []
  #stopReason: Failure | undefined
  #interruption: Failure | undefined
  #closingBrowser = false
  #browser: BrowserState = { kind: 'not_started' }
  #browserInfo: BrowserInfo | null = null
  #process: TestFileProcess | undefined
  #test: RunningTest | undefined

  constructor({ options, reporters, launch, store }: RunSessionOptions) {
    this.#options = options
    this.#launch = launch
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
    })
  }

  async run(): Promise<RunResult> {
    const { signal } = this.#options
    const interrupt = (): void => this.#interrupt()
    signal.addEventListener('abort', interrupt, { once: true })
    try {
      this.#emitRunStarted()
      if (signal.aborted) this.#interrupt()
      const files: FileResult[] = []
      for (const file of this.#files) files.push(await this.#runFile(file))
      await this.#closeBrowser()
      return await this.#finish(files)
    } finally {
      signal.removeEventListener('abort', interrupt)
      await this.#process?.kill()
      await this.#closeBrowser()
    }
  }

  // The base URL keeps its credentials for the browser; everything recorded or printed goes without them.
  #emitRunStarted(): void {
    const { baseUrl, browserPath, timeouts } = this.#options
    this.#events.emit({
      type: 'run.started',
      retestVersion,
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      rootDir: this.#rootDir,
      files: this.#files,
      options: {
        ...(baseUrl === undefined ? {} : { baseUrl: withoutCredentials(baseUrl) }),
        browserPath,
        timeouts,
        reporter: this.#reporterNames,
      },
    })
  }

  // The process is closed before the file's result is decided, so an error it reports after its last
  // test, or an ending no test explains, fails the file. The event keeps that failure for a run that stops
  // before it finishes.
  async #runFile(file: string): Promise<FileResult> {
    if (this.#stopReason !== undefined) {
      const reason = failure(this.#stopReason.class, `Not loaded: ${this.#stopReason.message}`)
      return this.#collectionFailed(file, reason)
    }
    if (!existsSync(resolve(this.#rootDir, file))) return this.#collectionFailed(file, missingFileFailure(file))
    const logFile = childLogFile(file)
    const child = TestFileProcess.spawn({ onOutput: (stream, text) => this.#output(file, logFile, stream, text) })
    this.#process = child
    try {
      const ran = await this.#collectAndRun(child, file, logFile)
      const closed = await child.close(abortGraceMs)
      if (!ran.collected) return this.#collectionFailed(file, withAlso(ran.failure, reportedErrors(file, child.errors)))
      const problem = fileProcessFailure({ file, closed, errors: child.errors, killed: child.killed, exitRecorded: ran.exitRecorded })
      if (problem === undefined) return { file, collection: 'ok', tests: ran.tests }
      this.#events.emit({ type: 'file.failed', file, failure: problem })
      return { file, collection: 'ok', failure: problem, tests: ran.tests }
    } finally {
      this.#process = undefined
      await child.kill()
    }
  }

  async #collectAndRun(child: TestFileProcess, file: string, logFile: string): Promise<FileRun> {
    const timeoutMs = this.#options.timeouts.collection
    const loaded = await loadTests(child, { file, rootDir: this.#rootDir, timeoutMs, logFile })
    if (!loaded.ok) return { collected: false, failure: this.#interruption ?? loaded.failure }
    this.#events.emit({ type: 'collection.completed', file, tests: collectedTests(file, loaded.tests) })
    const tests: TestResult[] = []
    let laterTests: Failure | undefined
    for (const test of loaded.tests) {
      const outcome = await this.#runTest(child, file, test, laterTests)
      tests.push(outcome.result)
      laterTests ??= outcome.laterTests
    }
    return { collected: true, tests, exitRecorded: laterTests !== undefined }
  }

  async #runTest(child: TestFileProcess, file: string, test: RegisteredTest, notRunReason: Failure | undefined): Promise<TestOutcome> {
    const scope = { testId: testId(file, test.name), attemptId: newAttemptId() }
    const described = { scope, file, test }
    const skip = this.#stopReason ?? notRunReason
    if (skip !== undefined) return { result: this.#notRun(described, skip) }
    if (child.exit !== undefined) return { result: this.#notRun(described, endedBeforeTest(child.exit)) }
    const browser = await this.#ensureBrowser()
    if (!browser.ok) return { result: this.#notRun(described, this.#stopReason ?? browser.failure) }
    const startedAt = monotonicClock()
    this.#events.emit({ type: 'test.started', ...scope, name: test.name, file, location: test.location })
    const finished = { ...described, startedAt, assertionCount: 0, evidence: [], cleanupFailures: [] }
    const opened = await this.#openPage(browser.value)
    if (!opened.ok) return { result: this.#finishTest({ ...finished, failure: opened.failure }) }
    if (this.#interruption !== undefined) return { result: this.#finishTest({ ...finished, failure: this.#interruption }) }
    const page = opened.value
    // Code the previous test left behind can end the process while the page opens.
    if (child.exit !== undefined) return { result: await this.#bodyNotRun(described, page, child.exit) }
    const report = await this.#runBody(child, page, scope, test)
    if (report.endedBeforeStart !== undefined) return { result: await this.#bodyNotRun(described, page, report.endedBeforeStart) }
    const evidence = report.failure === undefined ? [] : await this.#captureFailure(page, scope)
    const cleanupFailures = await this.#dispose(page)
    const result = this.#finishTest({ ...finished, failure: report.failure, assertionCount: report.assertionCount, evidence, cleanupFailures })
    const laterTests = laterTestsReason(test.name, report)
    return laterTests === undefined ? { result } : { result, laterTests }
  }

  async #runBody(child: TestFileProcess, page: OwnedPage, scope: TestScope, test: RegisteredTest): Promise<BodyReport> {
    const timeouts = { ...this.#options.timeouts, ...(test.timeout === undefined ? {} : { test: test.timeout }) }
    const running = new RunningTest({ process: child, page, ...scope, timeouts, emit: (body) => void this.#events.emit(body) })
    this.#test = running
    const report = await running.run()
    this.#test = undefined
    await running.settle(this.#interruption === undefined ? timeouts.cleanup : 0)
    running.close()
    return report
  }

  async #ensureBrowser(): Promise<Opened<OwnedBrowser>> {
    const state = this.#browser
    if (state.kind === 'ready') return { ok: true, value: state.browser }
    if (state.kind === 'unavailable') return { ok: false, failure: state.failure }
    const { browserPath, headless, timeouts } = this.#options
    const launching = this.#launch({ executablePath: browserPath, logFile: this.#store.pathOf(browserLogFile), headless }, timeouts.setup)
    const launched = await bounded(launching, timeouts.setup + abortGraceMs, this.#stopped.promise)
    if (launched.status !== 'done') {
      if (launched.status !== 'failed') this.#release(launching.then((browser) => browser.close(timeouts.cleanup)))
      const problem = (launched.status === 'stopped' ? this.#interruption : undefined) ?? launchFailure(launched, timeouts.setup)
      this.#browser = { kind: 'unavailable', failure: problem }
      return { ok: false, failure: problem }
    }
    const browser = launched.value
    this.#browser = { kind: 'ready', browser }
    const { product, version, userAgent, pid, executablePath } = browser
    this.#browserInfo = { product, version, executablePath }
    this.#events.emit({ type: 'browser.started', product, version, userAgent, pid, executablePath })
    browser.onDisconnect((reason) => this.#browserLost(reason))
    return { ok: true, value: browser }
  }

  async #openPage(browser: OwnedBrowser): Promise<Opened<OwnedPage>> {
    const { baseUrl, timeouts } = this.#options
    const opening = browser.newPage(baseUrl === undefined ? {} : { baseUrl }, timeouts.setup)
    const opened = await bounded(opening, timeouts.setup + abortGraceMs, this.#stopped.promise)
    if (opened.status === 'done') return { ok: true, value: opened.value }
    if (opened.status !== 'failed') this.#release(opening.then((page) => page.dispose(timeouts.cleanup)))
    if (opened.status === 'stopped' && this.#interruption !== undefined) return { ok: false, failure: this.#interruption }
    if (opened.status === 'timed_out') {
      return { ok: false, failure: failure('setup_failed', `Opening a new page took longer than the ${timeouts.setup} ms setup budget.`) }
    }
    const lost = !browser.connected
    const detail = opened.status === 'failed' ? errorMessage(opened.error) : 'the run stopped'
    return { ok: false, failure: failure(lost ? 'session_lost' : 'setup_failed', `Retest could not open a page: ${detail}`) }
  }

  // Evidence never replaces the failure it illustrates; when it cannot be taken, the reason is recorded.
  async #captureFailure(page: OwnedPage, scope: TestScope): Promise<Evidence[]> {
    if (this.#interruption !== undefined) return []
    const cleanup = this.#options.timeouts.cleanup
    const unavailable = (message: string): Evidence[] => {
      this.#events.emit({ type: 'evidence.failed', ...scope, session: 'page', kind: 'screenshot', reason: 'failure', message })
      return []
    }
    if (!this.#browserConnected()) return unavailable('The browser was gone, so Retest took no screenshot.')
    const shot = await bounded(page.screenshot(cleanup), cleanup + abortGraceMs, this.#stopped.promise)
    if (shot.status === 'stopped') return []
    if (shot.status === 'timed_out') return unavailable(`Taking a screenshot took longer than ${cleanup} ms.`)
    if (shot.status === 'failed') return unavailable(`Retest could not take a screenshot: ${errorMessage(shot.error)}`)
    const path = failureScreenshotFile(scope.testId, scope.attemptId)
    try {
      this.#store.writeArtifact(path, shot.value)
    } catch (error) {
      return unavailable(`Retest could not save the screenshot: ${errorMessage(error)}`)
    }
    this.#events.emit({ type: 'evidence.captured', ...scope, session: 'page', kind: 'screenshot', path, reason: 'failure' })
    return [{ kind: 'screenshot', path }]
  }

  // A browser that is gone or about to be closed takes its contexts with it.
  async #dispose(page: OwnedPage): Promise<Failure[]> {
    if (this.#interruption !== undefined || !this.#browserConnected()) return []
    const cleanup = this.#options.timeouts.cleanup
    const disposed = await bounded(page.dispose(cleanup), cleanup + abortGraceMs, this.#stopped.promise)
    if (disposed.status === 'done' || disposed.status === 'stopped') return []
    if (disposed.status === 'timed_out') {
      return [failure('cleanup_failed', `Closing the test's browser context took longer than ${cleanup} ms.`)]
    }
    return [failure('cleanup_failed', `Closing the test's browser context failed: ${errorMessage(disposed.error)}`)]
  }

  #finishTest(finished: Finished): TestResult {
    const { scope, file, test, failure: problem, cleanupFailures } = finished
    const status = testStatus(problem, cleanupFailures)
    const durationMs = elapsedMs(finished.startedAt)
    const outcome = {
      ...(problem === undefined ? {} : { failure: problem }),
      ...(cleanupFailures.length === 0 ? {} : { cleanupFailures }),
    }
    this.#events.emit({ type: 'test.finished', ...scope, status, durationMs, assertionCount: finished.assertionCount, ...outcome })
    return {
      ...scope,
      name: test.name,
      file,
      location: test.location,
      status,
      durationMs,
      assertionCount: finished.assertionCount,
      ...outcome,
      evidence: finished.evidence,
    }
  }

  // A body that never ran leaves only a blank page: it is released, and nothing is captured from it.
  async #bodyNotRun(described: DescribedTest, page: OwnedPage, exit: ProcessExit): Promise<TestResult> {
    const cleanupFailures = await this.#dispose(page)
    return this.#notRun(described, endedBeforeTest(exit), cleanupFailures)
  }

  #notRun({ scope, file, test }: DescribedTest, reason: Failure, cleanupFailures: Failure[] = []): TestResult {
    const cleanup = cleanupFailures.length === 0 ? {} : { cleanupFailures }
    this.#events.emit({ type: 'test.finished', ...scope, status: 'not_run', durationMs: 0, assertionCount: 0, failure: reason, ...cleanup })
    return {
      ...scope,
      name: test.name,
      file,
      location: test.location,
      status: 'not_run',
      durationMs: 0,
      assertionCount: 0,
      failure: reason,
      ...cleanup,
      evidence: [],
    }
  }

  #collectionFailed(file: string, reason: Failure): FileResult {
    this.#events.emit({ type: 'collection.failed', file, failure: reason })
    return { file, collection: 'failed', failure: reason, tests: [] }
  }

  #output(file: string, logFile: string, stream: 'stdout' | 'stderr', text: string): void {
    try {
      this.#store.appendLog(logFile, text)
      this.#options.onOutput?.({ file, stream, text })
    } catch (error) {
      this.#events.reportFailure(failure('reporting_failed', `Retest could not keep the output of ${file}: ${errorMessage(error)}`))
    }
  }

  #interrupt(): void {
    if (this.#interruption !== undefined) return
    const stopped = stopSignalOf(this.#options.signal) === 'SIGTERM' ? 'The run was stopped by SIGTERM.' : 'The run was interrupted.'
    const reason = failure('interrupted', stopped)
    this.#interruption = reason
    this.#stopReason = reason
    this.#stopped.resolve()
    this.#test?.revoke(reason, 0)
    void this.#process?.kill()
  }

  #browserLost(reason: string): void {
    const state = this.#browser
    if (this.#closingBrowser || state.kind !== 'ready') return
    const problem = failure('session_lost', `Not run: the browser was lost earlier in this run. ${reason}`)
    this.#browser = { kind: 'unavailable', failure: problem, browser: state.browser }
    this.#test?.browserLost(reason)
  }

  #browserConnected(): boolean {
    return this.#browser.kind === 'ready' && this.#browser.browser.connected
  }

  #release(work: Promise<unknown>): void {
    this.#releases.push(work.catch(() => undefined))
  }

  async #closeBrowser(): Promise<void> {
    const state = this.#browser
    const browser = state.kind === 'not_started' ? undefined : state.browser
    const { cleanup } = this.#options.timeouts
    if (browser !== undefined) {
      this.#closingBrowser = true
      this.#browser = { kind: 'unavailable', failure: failure('setup_failed', 'The browser was closed.') }
      await bounded(browser.close(cleanup), cleanup + closeGraceMs + abortGraceMs)
    }
    await bounded(Promise.all(this.#releases), cleanup)
  }

  // Everything but the outcome is fixed once. Failures after run.finished, such as a reporter that breaks at
  // the end or a result.json that cannot be written, change only the outcome that result.json stores.
  async #finish(files: FileResult[]): Promise<RunResult> {
    await this.#events.flush()
    const facts: ResultFacts = {
      schemaVersion: 1,
      runId: this.#runId,
      retestVersion,
      startedAt: this.#startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: elapsedMs(this.#start),
      browser: this.#browserInfo,
      files,
    }
    const finished = withOutcome(facts, this.#outcome(files))
    const { status, exitCode, complete, counts, durationMs, failure: problem } = finished
    this.#events.emit({ type: 'run.finished', status, exitCode, complete, counts, durationMs, ...(problem === undefined ? {} : { failure: problem }) })
    await this.#events.end(finished)
    try {
      const result = withOutcome(facts, this.#outcome(files))
      this.#store.writeResult(result)
      return result
    } catch (error) {
      this.#events.reportFailure(failure('reporting_failed', `Retest could not write result.json: ${errorMessage(error)}`))
      return withOutcome(facts, this.#outcome(files))
    }
  }

  #outcome(files: readonly FileResult[]): RunOutcome {
    const stoppedBy = this.#interruption === undefined ? undefined : stopSignalOf(this.#options.signal)
    return runOutcome({ stoppedBy, outputFailures: this.#events.failures, files })
  }
}

function withOutcome(facts: ResultFacts, outcome: RunOutcome): RunResult {
  const { files, ...head } = facts
  const { complete, status, exitCode, counts, failure: problem } = outcome
  return { ...head, complete, status, exitCode, counts, ...(problem === undefined ? {} : { failure: problem }), files }
}

function launchFailure(launched: Exclude<Bounded<OwnedBrowser>, { status: 'done' }>, setupMs: number): Failure {
  if (launched.status === 'failed') {
    const { error } = launched
    return error instanceof LaunchError ? error.failure : failure('setup_failed', `The browser did not start: ${errorMessage(error)}`)
  }
  return failure('setup_failed', `The browser did not start within the ${setupMs} ms setup budget.`)
}

function describeReporters(reporters: readonly Reporter[]): string {
  return reporters.length === 0 ? 'none' : reporters.map((reporter) => reporter.name).join(',')
}
