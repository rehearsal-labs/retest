import type { DiagnosticsSummary } from '../protocol/diagnostics.ts'
import type { RetestEvent } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheckResult } from '../protocol/host-check.ts'
import type { RecordingRecord } from '../protocol/recording.ts'
import type { BrowserInfo, FileResult, RunResult, TestResult } from '../protocol/result.ts'
import type { EventOfType, TestEvent } from '../reporters/run-record.ts'
import { withFinalBundle } from '../protocol/execution.ts'
import { failure, withAlso } from '../protocol/failures.ts'
import { eventsFile, resultFile } from '../protocol/run-folder.ts'
import { recordEvents, type FileRecord, type RunRecord, type TestRecord } from '../reporters/run-record.ts'
import { attemptEvidence, runEvidence } from '../runner/evidence-status.ts'
import { countTests } from '../runner/outcome.ts'

/** Thrown when a folder is not a run folder Retest can read. The message says why. */
export class RunFolderReadError extends Error {
  override readonly name = 'RunFolderReadError'
}

/**
 * The result of a run that ended before writing `result.json`, from its events. It is always
 * incomplete, with status `error` and exit code 2, so it can never read as a completed pass. A test that
 * started and never finished is an `error`; a test that never started did not run. A test lists the host
 * checks its events recorded; one the run stopped before it ended has no event and is never listed as passed.
 * A file keeps the failure of its process that `file.failed` recorded. The run's failure says whether it
 * stopped early or finished without its result, and `run.narrowed` keeps how `test.only` narrowed it. A run that
 * finished lists only the tests it chose, as its `result.json` would.
 *
 * @example rebuildResult(readEvents(text).events).complete // false
 */
export function rebuildResult(events: readonly RetestEvent[]): RunResult {
  const record = recordEvents(events)
  const { started, finished, last } = record
  if (started === undefined || last === undefined) {
    throw new RunFolderReadError(`${eventsFile} has no run.started event, so the run cannot be rebuilt.`)
  }
  const removed = removedRecordings(record.removals)
  const files = [...record.files.values()].map((file) => fileResult(file, { endMs: last.elapsedMs, finished: finished !== undefined, removed }))
  const pending = new Set<string>()
  for (const event of record.removals) {
    if (event.type === 'artifact.removal_requested') pending.add(event.path)
    else pending.delete(event.path)
  }
  for (const test of files.flatMap((file) => file.tests)) {
    if (test.recordings === undefined) continue
    test.recordings = test.recordings.map((recording) => recording.path !== undefined && pending.has(recording.path) ? { ...recording, removalPending: true } : recording)
  }
  // A target's further browsers are events of their own; the result lists each target once, by its first.
  const browsers = record.browsers.filter((event) => event.instance === undefined).map(browserInfo)
  const [browser = null] = browsers
  const narrowed = record.narrowed === undefined ? {} : { narrowed: { only: record.narrowed.only, kept: record.narrowed.kept, collected: record.narrowed.collected } }
  return {
    schemaVersion: 1,
    runId: started.runId,
    retestVersion: started.retestVersion,
    startedAt: started.time,
    finishedAt: last.time,
    complete: false,
    status: 'error',
    exitCode: 2,
    durationMs: Math.max(0, last.elapsedMs - started.elapsedMs),
    browser,
    ...(record.natives.length === 0 ? {} : { natives: record.natives.map(({ app, target, product, sessionId, identity }) => ({ app, target, product, sessionId, identity })) }),
    ...(browsers.some((info) => info.app !== undefined) ? { browsers } : {}),
    counts: countTests(files),
    failure: missingResult(finished, record.outcome),
    ...narrowed,
    ...(finished?.evidenceStatus !== undefined ? { evidenceStatus: finished.evidenceStatus } : files.some(file => file.tests.some(test => test.recordings !== undefined)) ? { evidenceStatus: runEvidence(files.flatMap(file => file.tests), [], false) } : {}),
    files,
  }
}

/**
 * Reconstructs the parent-recorded result for comparison with an existing result.json. It does not prove that the
 * file was written. Readers of a missing result must keep using rebuildResult, which always reports that loss.
 * Older events lack the exact result clock fields and cannot be reconstructed this way.
 */
export function rebuildRecordedResult(events: readonly RetestEvent[]): RunResult {
  const { finished, outcome } = recordEvents(events)
  if (finished?.resultFacts === undefined) throw new RunFolderReadError('The events have no exact final result facts; only an incomplete result can be rebuilt.')
  const incomplete = rebuildResult(events)
  if ((['passed', 'failed', 'error', 'notRun', 'inconclusive'] as const).some((key) => incomplete.counts[key] !== finished.counts[key]) || (incomplete.counts.skipped ?? 0) !== (finished.counts.skipped ?? 0)) throw new RunFolderReadError('The final counts do not agree with the recorded tests.')
  const { failure: _missing, browsers, ...facts } = incomplete
  const settled = outcome ?? finished
  return {
    ...facts,
    startedAt: finished.resultFacts.startedAt,
    finishedAt: finished.resultFacts.finishedAt,
    durationMs: finished.durationMs,
    complete: settled.complete,
    status: settled.status,
    exitCode: settled.exitCode,
    ...(finished.resultFacts.namedApps === true ? { browsers: browsers ?? [] } : {}),
    ...(settled.failure === undefined ? {} : { failure: settled.failure }),
  }
}

function missingResult(finished: EventOfType<'run.finished'> | undefined, outcome: EventOfType<'run.outcome'> | undefined): Failure {
  if (finished === undefined) return stopped('The run stopped before it finished.')
  const missing = failure('reporting_failed', `The run finished without writing ${resultFile}.`)
  const problem = outcome?.failure ?? finished.failure
  return problem === undefined ? missing : withAlso(problem, [missing])
}

// A run that finished gave every attempt it chose a test.finished, so a collected test with neither a start nor an end
// was left out by the selection, test.only included, and the result leaves it out too. A run that stopped early may
// have chosen it, so it stays, as not run.
function fileResult(file: FileRecord, { endMs, finished, removed }: { endMs: number; finished: boolean; removed: ReadonlySet<string> }): FileResult {
  const { collection } = file
  if (collection?.type === 'collection.failed') {
    return { file: file.file, collection: 'failed', failure: collection.failure, tests: [] }
  }
  if (collection === undefined && file.tests.length === 0) {
    return {
      file: file.file,
      collection: 'failed',
      failure: stopped('The run stopped before this file was collected.'),
      tests: [],
    }
  }
  const failed = file.failed === undefined ? {} : { failure: file.failed.failure }
  const chosen = finished ? file.tests.filter((test) => test.started !== undefined || test.finished !== undefined) : file.tests
  return { file: file.file, collection: 'ok', ...failed, tests: chosen.map((test) => testResult(test, endMs, removed)) }
}

function browserInfo(event: EventOfType<'browser.started'>): BrowserInfo {
  const { product, version, executablePath, app, target } = event
  return { product, version, executablePath, ...(app === undefined ? {} : { app }), ...(target === undefined ? {} : { target }) }
}

function testResult(test: TestRecord, endMs: number, removed: ReadonlySet<string>): TestResult {
  const { testId, name, file, location, describePath, variant, variantKey, setup } = test
  const described = {
    testId,
    name,
    file,
    location,
    ...(describePath === undefined ? {} : { describePath }),
    ...(variant === undefined ? {} : { variant }),
    ...(variantKey === undefined ? {} : { variantKey }),
    ...(setup === undefined ? {} : { setup }),
  }
  // A test with a variant ran with a config, where each screenshot's session names its app. A screenshot names the
  // session that captured it, and when, in runs recorded since sessions had ids, and what took it, when on the run's
  // clock and the look it is, each as its event recorded it.
  const evidence = test.events.flatMap((event) => {
    if (event.type !== 'evidence.captured') return []
    const app = variant === undefined ? undefined : event.session
    const { sessionId, attemptId, capturedAt, capturedElapsedMs, source, observationId, captureReference } = event
    const captured = sessionId === undefined ? {} : { sessionId, attemptId, ...(capturedAt === undefined ? {} : { capturedAt }) }
    const identity = {
      ...(capturedElapsedMs === undefined ? {} : { capturedElapsedMs }),
      ...(source === undefined ? {} : { source }),
      ...(captureReference === undefined ? {} : { captureReference }),
      ...(observationId === undefined ? {} : { observationId }),
    }
    return [{ kind: event.kind, path: event.path, ...(app === undefined ? {} : { app }), ...captured, ...identity }]
  })
  const { started, finished } = test
  const recorded = [...recordedHostChecks(test.events), ...(finished?.hostChecksNotRun ?? []).map(({ check, app }): HostCheckResult => ({ check, app, status: 'not_run' }))]
  // An AI check the run stopped before it ended has no event either, so a rebuilt test never lists one as passed.
  const evaluated = test.events.flatMap((event) => (event.type === 'evaluation.finished' ? [event.evaluation] : []))
  const hostChecks = { ...(recorded.length === 0 ? {} : { hostChecks: recorded }), ...(evaluated.length === 0 ? {} : { evaluations: evaluated }) }
  const attempt = attemptRecords(test)
  const diagnosed = recordedDiagnostics(test, variant !== undefined)
  const recordings = recordedRecordings(test, removed)
  if (finished !== undefined) {
    return {
      ...described,
      attemptId: finished.attemptId,
      status: finished.status,
      durationMs: finished.durationMs,
      assertionCount: finished.assertionCount,
      ...(finished.failure === undefined ? {} : { failure: finished.failure }),
      ...(finished.cleanupFailures === undefined ? {} : { cleanupFailures: finished.cleanupFailures }),
      ...hostChecks,
      ...attempt,
      ...(finished.ending === undefined ? {} : { ending: finished.ending }),
      ...(finished.status === 'not_run' || finished.status === 'skipped' ? {} : diagnosed),
      ...recordings,
      ...(finished.evidenceStatus === undefined ? {} : { evidenceStatus: finished.evidenceStatus }),
      evidence,
    }
  }
  if (started !== undefined) {
    return {
      ...described,
      attemptId: started.attemptId,
      status: 'error',
      durationMs: Math.max(0, endMs - started.elapsedMs),
      assertionCount: test.events.filter(
        (event) => event.type === 'assertion.passed' || event.type === 'assertion.failed',
      ).length,
      failure: stopped('The run stopped before this test finished.'),
      ...hostChecks,
      ...attempt,
      ...diagnosed,
      ...recordings,
      ...(recordings.recordings === undefined ? {} : { evidenceStatus: attemptEvidence(recordings.recordings, []) }),
      evidence,
    }
  }
  return {
    ...described,
    attemptId: '',
    status: 'not_run',
    durationMs: 0,
    assertionCount: 0,
    failure: stopped('The run stopped before this test started.'),
    evidence,
  }
}

// An attempt's execution identity is in its test.started, with the bundle its test.finished names when the body loaded
// more; its preparations and cleanups are the events that recorded them.
function attemptRecords(test: TestRecord): Pick<TestResult, 'execution' | 'preparations' | 'cleanups'> {
  const started = test.started?.execution
  const execution = started === undefined ? undefined : withFinalBundle(started, test.finished?.bundle)
  const preparations = test.events.flatMap((event) => (event.type === 'preparation.finished' ? [event.preparation] : []))
  const cleanups = test.events.flatMap((event) => (event.type === 'cleanup.finished' ? [event.cleanup] : []))
  return {
    ...(execution === undefined ? {} : { execution }),
    ...(preparations.length === 0 ? {} : { preparations }),
    ...(cleanups.length === 0 ? {} : { cleanups }),
  }
}

// Each session's diagnostics as its diagnostics.finished recorded them, with their artifacts. A capture that started and
// has no end was cut off with the run: its records were never written, so it is unavailable, never empty.
function recordedDiagnostics(test: TestRecord, named: boolean): Pick<TestResult, 'diagnostics'> {
  const ended = new Set<string>()
  const summaries: DiagnosticsSummary[] = []
  for (const event of test.events) {
    if (event.type !== 'diagnostics.finished') continue
    ended.add(event.sessionId)
    summaries.push(event.diagnostics)
  }
  for (const event of test.events) {
    if (event.type !== 'diagnostics.started' || ended.has(event.sessionId)) continue
    const reason = 'the run stopped before this capture was written'
    const unavailable = { state: 'unavailable' as const, reason }
    summaries.push({ ...(named && event.session !== undefined ? { app: event.session } : {}), sessionId: event.sessionId, scope: event.scope, startedAt: event.startedAt, console: unavailable, network: unavailable })
  }
  return summaries.length === 0 ? {} : { diagnostics: summaries }
}

// Each recording as its recording.finished wrote it, with the retention that removed its video once its attempt passed. A
// recording that began and has no end was cut off with the run: nothing says its video was finished, so it is listed as
// unavailable, never as complete.
function recordedRecordings(test: TestRecord, removed: ReadonlySet<string>): Pick<TestResult, 'recordings'> {
  const recordings: RecordingRecord[] = []
  const ended = new Set<string>()
  for (const event of test.events) {
    if (event.type !== 'recording.finished') continue
    ended.add(event.recording.recordingId)
    const { path } = event.recording
    recordings.push(path !== undefined && removed.has(path) ? { ...event.recording, removed: 'passed_attempt_recording' } : event.recording)
  }
  for (const event of test.events) {
    if (event.type !== 'recording.started' || ended.has(event.recordingId)) continue
    const { testId, attemptId, session, sessionId, recordingId, number, source, mode } = event
    const app = session ?? ''
    recordings.push({ recordingId, sequence: number, testId, attemptId, app, sessionId, status: 'unavailable', gaps: [{ code: 'run_stopped', message: 'The run stopped before this recording was written down, so nothing says its video was finished.', app, sessionId }], source, mode })
  }
  return recordings.length === 0 ? {} : { recordings }
}

// The recordings retention removed once their attempts passed, by path.
function removedRecordings(removals: RunRecord['removals']): Set<string> {
  const removed = new Set<string>()
  for (const event of removals) {
    if (event.reason !== 'passed_attempt_recording') continue
    if (event.type === 'artifact.removed') removed.add(event.path)
    else if (event.type === 'artifact.removal_failed') removed.delete(event.path)
  }
  return removed
}

// A check the run stopped before it ended has no event, so it is never listed, least of all as passed. A check the attempt
// never ran is listed by its test.finished, after the checks that ran, as result.json lists it.
function recordedHostChecks(events: readonly TestEvent[]): HostCheckResult[] {
  return events.flatMap((event): HostCheckResult[] => {
    if (event.type === 'host_check.passed') return [{ check: event.check, app: event.session, status: 'passed' }]
    if (event.type === 'host_check.failed') return [{ check: event.check, app: event.session, status: 'failed', failure: event.failure }]
    return []
  })
}

function stopped(message: string): Failure {
  return { class: 'interrupted', message }
}
