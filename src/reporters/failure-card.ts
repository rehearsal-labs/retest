import type { TestStatus } from '../protocol/events.ts'
import type { Failure, FailureDetail, SourceLocation, TruncatedText } from '../protocol/failures.ts'
import type { FileResult, RunResult, TestResult } from '../protocol/result.ts'
import type { Variant } from '../protocol/variant.ts'
import type { EventOfType, RunRecord, TestEvent } from './run-record.ts'
import type { RunTargets } from './targets.ts'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { formatRerunCommand } from './commands.ts'
import { plural, testTitle } from './format.ts'
import { namingTargets, variantLabel } from './targets.ts'

/** The action or assertion event that shows how a test failed. */
export type FailingCall = EventOfType<'action.failed'> | EventOfType<'assertion.failed'>

/** What went wrong with a file itself: it could not be collected, or its process failed outside its tests. */
export type FileProblem = 'collection' | 'process'

/** A test a card is about. `targets` are the ones a command must name to pick out its variant. */
export type CardTest = {
  testId: string
  name: string
  describePath?: string[]
  status: TestStatus
  durationMs: number
  targets?: Variant
}

type CardSubject = { test: CardTest; fileProblem?: never } | { test?: never; fileProblem: FileProblem }

/** Everything a report says about one test, or about one file that failed on its own. */
export type FailureCard = CardSubject & {
  title: string
  file: string
  /** The test's variant as reports name it, such as `web=pixel (emulated)`. */
  variant?: string
  /** The test's failure, or its first cleanup failure when that is all it has. */
  failure?: Failure
  call?: FailingCall
  /** Where the code frame points: the failing call, else the failure, else the test. */
  location?: SourceLocation
  /** Paths inside the run folder, joined to the run folder as it was given. */
  screenshots: string[]
  evidenceProblems: string[]
  /** Cleanup failures besides `failure`. */
  cleanupFailures: Failure[]
  rerun?: string
}

export type CardOptions = { record: RunRecord; runFolder: string; targets: RunTargets }

const fileProblems: Record<FileProblem, string> = {
  collection: 'could not be collected',
  process: 'failed outside its tests',
}

/** @example describeFileProblem('process') // 'failed outside its tests' */
export function describeFileProblem(problem: FileProblem): string {
  return fileProblems[problem]
}

/**
 * One card for each file that could not be collected, each test that failed or ended in an error, and
 * each file whose process failed outside its tests, in run order.
 *
 * @example failureCards(result, { record, runFolder: '.retest/runs/latest' })
 */
export function failureCards(result: RunResult, options: CardOptions): FailureCard[] {
  const cards: FailureCard[] = []
  for (const file of result.files) {
    const problem = fileProblemOf(file)
    if (problem === 'collection') cards.push(fileCard(file, problem, options))
    for (const test of file.tests) {
      if (test.status === 'failed' || test.status === 'error') cards.push(testCard(test, options))
    }
    if (problem === 'process') cards.push(fileCard(file, problem, options))
  }
  return cards
}

/** What went wrong with a file itself, if anything. */
export function fileProblemOf(file: FileResult): FileProblem | undefined {
  if (file.collection === 'failed') return 'collection'
  return file.failure === undefined ? undefined : 'process'
}

/** Tests that did not run, in run order. */
export function testsNotRun(result: RunResult): TestResult[] {
  return result.files.flatMap((file) => file.tests.filter((test) => test.status === 'not_run'))
}

/**
 * The run's own failure, unless a file's own card already shows it. A report prints it once, and leaves
 * it off the tests it kept from running.
 *
 * @example runFailureToShow(result)?.message // 'No browser at /opt/chromium.'
 */
export function runFailureToShow(result: RunResult): Failure | undefined {
  const { failure } = result
  if (failure === undefined || result.files.some((file) => isDeepStrictEqual(file.failure, failure))) return undefined
  return failure
}

/** Why a test did not run, unless that is the run's own failure, which the report prints once. */
export function notRunReason(result: RunResult, test: TestResult): Failure | undefined {
  return isDeepStrictEqual(test.failure, result.failure) ? undefined : test.failure
}

/**
 * The failure's details that the failing call's own fields do not already show with the same value:
 * the values compared, the comparison, the looks taken and the limit.
 *
 * @example unshownDetails(card) // [['check', 'hit-target'], ['covering', 'div.overlay']]
 */
export function unshownDetails(card: FailureCard): [string, FailureDetail][] {
  const shown = shownByCall(card.call)
  return Object.entries(card.failure?.details ?? {}).filter(([key, value]) => !isDeepStrictEqual(shown.get(key), value))
}

function shownByCall(call: FailingCall | undefined): ReadonlyMap<string, FailureDetail> {
  if (call?.type !== 'assertion.failed') return new Map()
  const values = recordedValues(call)
  const shown = new Map<string, FailureDetail>([['attempts', call.attempts]])
  if (values !== undefined) shown.set('expected', values.expected).set('received', values.actual)
  if (call.comparison !== undefined) shown.set('comparison', call.comparison)
  if (call.timeoutMs !== undefined) shown.set('timeoutMs', call.timeoutMs)
  return shown
}

/**
 * The card for one test, whatever its status.
 *
 * @example testCard(test, { record, runFolder })
 */
export function testCard(test: TestResult, options: CardOptions): FailureCard {
  const record = options.record.test(test.testId, test.variantKey)
  const events = record?.events ?? []
  const call = findFailingCall(events, test.failure)
  const run = options.record.started
  // A test whose only failures came in cleanup leads with the first of them.
  const [failure, ...cleanupFailures] = [
    ...(test.failure === undefined ? [] : [test.failure]),
    ...(test.cleanupFailures ?? []),
  ]
  const targets = namingTargets(test.variant, options.targets)
  const variant = variantLabel(test.variant, options.targets)
  const { testId, name, describePath, status, durationMs } = test
  return {
    title: testTitle(test.file, name, describePath),
    file: test.file,
    test: {
      testId,
      name,
      ...(describePath === undefined ? {} : { describePath }),
      status,
      durationMs,
      ...(targets === undefined ? {} : { targets }),
    },
    ...(variant === undefined ? {} : { variant }),
    ...(failure === undefined ? {} : { failure }),
    ...(call === undefined ? {} : { call }),
    location: call?.location ?? failure?.location ?? test.location,
    screenshots: evidencePaths(events, test).map((path) => join(options.runFolder, path)),
    evidenceProblems: events.flatMap((event) => (event.type === 'evidence.failed' ? [event.message] : [])),
    cleanupFailures,
    ...(run === undefined ? {} : { rerun: formatRerunCommand(run, { file: test.file, line: test.location.line, row: record?.row, targets }) }),
  }
}

function fileCard(file: FileResult, problem: FileProblem, options: CardOptions): FailureCard {
  const run = options.record.started
  const location = file.failure?.location
  return {
    title: file.file,
    file: file.file,
    fileProblem: problem,
    ...(file.failure === undefined ? {} : { failure: file.failure }),
    ...(location === undefined ? {} : { location }),
    screenshots: [],
    evidenceProblems: [],
    cleanupFailures: [],
    ...(run === undefined ? {} : { rerun: formatRerunCommand(run, { file: file.file }) }),
  }
}

// The evidence events say what was captured; a folder without events still has the result's list.
function evidencePaths(events: TestEvent[], test: TestResult): string[] {
  const captured = events.flatMap((event) => (event.type === 'evidence.captured' ? [event.path] : []))
  return captured.length > 0 || events.length > 0 ? captured : test.evidence.map((evidence) => evidence.path)
}

// The test's own failure is authoritative; the event carrying the same failure adds the locator, the
// values and the wait. Without a failure on the test, its last failed call stands in.
function findFailingCall(events: TestEvent[], failure: Failure | undefined): FailingCall | undefined {
  const calls = events.filter(isFailingCall)
  if (failure === undefined) return calls.at(-1)
  return calls.findLast((call) => call.failure.class === failure.class && call.failure.message === failure.message)
}

function isFailingCall(event: TestEvent): event is FailingCall {
  return event.type === 'action.failed' || event.type === 'assertion.failed'
}

export type RecordedValues = { expected: TruncatedText; actual: TruncatedText }

/** Both values of a failed assertion. */
export function recordedValues(call: FailingCall | undefined): RecordedValues | undefined {
  if (call?.type !== 'assertion.failed' || call.expected === null || call.actual === null) return undefined
  return { expected: call.expected, actual: call.actual }
}

/**
 * Whether the failure's message only repeats the recorded values, as the message of a check that failed on
 * them does. Any other failure, such as a timeout that stopped the check, says something the values do not.
 */
export function messageRepeatsValues(card: FailureCard): boolean {
  return card.failure?.class === 'check_failed' && recordedValues(card.call) !== undefined
}

/** The matcher or command that failed. */
export function callName(call: FailingCall): string {
  return call.type === 'assertion.failed' ? call.matcher : call.command
}

/**
 * How long the failing call waited and for what, with durations written by `duration`.
 *
 * @example describeWait(call, formatDuration) // '5s for toHaveText, looked 14 times, limit 5s'
 */
export function describeWait(call: FailingCall, duration: (milliseconds: number) => string): string {
  if (call.type === 'action.failed') return `${duration(call.durationMs)} for ${call.command}`
  const limit = call.timeoutMs === undefined ? '' : `, limit ${duration(call.timeoutMs)}`
  return `${duration(call.durationMs)} for ${call.matcher}, looked ${plural(call.attempts, 'time')}${limit}`
}
