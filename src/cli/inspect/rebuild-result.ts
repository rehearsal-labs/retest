import type { RetestEvent } from '../../protocol/events.ts'
import type { Failure } from '../../protocol/failures.ts'
import type { HostCheckResult } from '../../protocol/host-check.ts'
import type { BrowserInfo, FileResult, RunResult, TestResult } from '../../protocol/result.ts'
import type { EventOfType, TestEvent } from '../../reporters/run-record.ts'
import { failure, withAlso } from '../../protocol/failures.ts'
import { eventsFile, resultFile } from '../../protocol/run-folder.ts'
import { recordEvents, type FileRecord, type TestRecord } from '../../reporters/run-record.ts'
import { countTests } from '../../runner/outcome.ts'
import { CliError } from '../errors.ts'

/**
 * The result of a run that ended before writing `result.json`, from its events. It is always
 * incomplete, with status `error` and exit code 2, so it can never read as a completed pass. A test that
 * started and never finished is an `error`; a test that never started did not run. A test lists the host
 * checks its events recorded; one the run stopped before it ended has no event and is never listed as passed.
 * A file keeps the failure of its process that `file.failed` recorded. The run's failure says whether it
 * stopped early or finished without its result.
 *
 * @example rebuildResult(readEvents(text).events).complete // false
 */
export function rebuildResult(events: readonly RetestEvent[]): RunResult {
  const record = recordEvents(events)
  const { started, finished, last } = record
  if (started === undefined || last === undefined) {
    throw new CliError(`${eventsFile} has no run.started event, so the run cannot be rebuilt.`)
  }
  const files = [...record.files.values()].map((file) => fileResult(file, last.elapsedMs))
  const browsers = record.browsers.map(browserInfo)
  const [browser = null] = browsers
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
    ...(browsers.some((info) => info.app !== undefined) ? { browsers } : {}),
    counts: countTests(files),
    failure: missingResult(finished),
    files,
  }
}

function missingResult(finished: EventOfType<'run.finished'> | undefined): Failure {
  if (finished === undefined) return stopped('The run stopped before it finished.')
  const missing = failure('reporting_failed', `The run finished without writing ${resultFile}.`)
  return finished.failure === undefined ? missing : withAlso(finished.failure, [missing])
}

function fileResult(file: FileRecord, endMs: number): FileResult {
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
  return { file: file.file, collection: 'ok', ...failed, tests: file.tests.map((test) => testResult(test, endMs)) }
}

function browserInfo(event: EventOfType<'browser.started'>): BrowserInfo {
  const { product, version, executablePath, app, target } = event
  return { product, version, executablePath, ...(app === undefined ? {} : { app }), ...(target === undefined ? {} : { target }) }
}

function testResult(test: TestRecord, endMs: number): TestResult {
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
  // A test with a variant ran with a config, where each screenshot's session names its app.
  const evidence = test.events.flatMap((event) => {
    if (event.type !== 'evidence.captured') return []
    const app = variant === undefined ? undefined : event.session
    return [{ kind: event.kind, path: event.path, ...(app === undefined ? {} : { app }) }]
  })
  const { started, finished } = test
  const recorded = recordedHostChecks(test.events)
  const hostChecks = recorded.length === 0 ? {} : { hostChecks: recorded }
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

// A check the run stopped before it ended has no event, so it is never listed, least of all as passed.
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
