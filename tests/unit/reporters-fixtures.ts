import type { EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { Failure, SourceLocation } from '../../src/protocol/failures.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { truncateText } from '../../src/protocol/failures.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import type { Writer } from '../../src/reporters/style.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'

// Recorded event sequences for reporter and inspect tests, shaped as the runner writes them.

export const file = 'examples/task.retest.ts'
export const browserPath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
export const baseUrl = 'http://127.0.0.1:4173'
export const pageUrl = 'http://127.0.0.1:4173/'
export const comparison = 'whole text, ends trimmed, each run of spaces or line breaks read as one space'

export const source = `import { test, expect } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('shows the count', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('count')).toHaveText('0 tasks')
})
`

export const savesTask: string = testId(file, 'saves a task')
export const showsCount: string = testId(file, 'shows the count')

const at = (line: number, column = 3): SourceLocation => ({ file, line, column })
const savesScope = { testId: savesTask, attemptId: 'attempt-1', session: 'page' }
const countScope = { testId: showsCount, attemptId: 'attempt-2', session: 'page' }
const savedTask = { by: 'testId', value: 'saved-task' } as const

const temporaryFolders: string[] = []
process.once('exit', () => {
  for (const folder of temporaryFolders) rmSync(folder, { recursive: true, force: true })
})

/** A new empty folder, removed when the test process exits. */
export function temporaryFolder(): string {
  const folder = mkdtempSync(join(tmpdir(), 'retest-cli-test-'))
  temporaryFolders.push(folder)
  return folder
}

/** A folder with the test file in it, to be the run's root directory. */
export function projectFolder(): string {
  const root = temporaryFolder()
  mkdirSync(join(root, 'examples'))
  writeFileSync(join(root, file), source)
  return root
}

const childTypes: ReadonlySet<string> = new Set(['step.started', 'step.finished', 'assertion.passed', 'assertion.failed'])

/**
 * Adds the envelope the parent writes: run id, sequence, time and elapsed time, ten milliseconds apart, and
 * whether the test file's process reported the event.
 */
export function stamp(bodies: EventBody[], runId = 'run-1'): RetestEvent[] {
  return bodies.map((body, sequence) => ({
    schemaVersion: 1,
    runId,
    sequence,
    time: new Date(Date.UTC(2026, 8, 30, 9, 15, 0, sequence * 10)).toISOString(),
    elapsedMs: sequence * 10,
    origin: childTypes.has(body.type) ? 'child' : 'parent',
    ...body,
  }))
}

/** The result the runner would store for these events, taken from their `run.finished`. */
export function resultOf(events: RetestEvent[]): RunResult {
  const finished = events.findLast((event) => event.type === 'run.finished')
  if (finished?.type !== 'run.finished') throw new Error('The events do not finish the run.')
  const { status, exitCode, complete, counts, durationMs, failure } = finished
  const { schemaVersion, runId, retestVersion, startedAt, browser, files } = rebuildResult(events)
  const finishedAt = finished.time
  const outcome = { schemaVersion, runId, retestVersion, startedAt, finishedAt, complete, status, exitCode, durationMs, browser, counts }
  return failure === undefined ? { ...outcome, files } : { ...outcome, failure, files }
}

export function runStarted(rootDir: string, options: { timeouts?: typeof defaultTimeouts } = {}): EventBody {
  return {
    type: 'run.started',
    retestVersion: '0.0.0',
    node: 'v24.12.0',
    platform: 'darwin',
    rootDir,
    files: [file],
    options: { baseUrl, browserPath, timeouts: options.timeouts ?? defaultTimeouts, reporter: 'human' },
  }
}

const browserStarted: EventBody = {
  type: 'browser.started',
  product: 'Chrome',
  version: '140.0.7339.80',
  userAgent: 'Mozilla/5.0 Chrome/140.0.7339.80',
  pid: 4242,
  executablePath: browserPath,
}

const collected: EventBody = {
  type: 'collection.completed',
  file,
  tests: [
    { testId: savesTask, name: 'saves a task', location: at(3, 1) },
    { testId: showsCount, name: 'shows the count', location: at(10, 1) },
  ],
}

function savesTaskActions(): EventBody[] {
  return [
    { type: 'test.started', ...savesScope, name: 'saves a task', file, location: at(3, 1) },
    { type: 'action.completed', ...savesScope, command: 'goto', pageUrl, durationMs: 12, location: at(4) },
    { type: 'navigation', ...savesScope, url: pageUrl },
    {
      type: 'action.completed',
      ...savesScope,
      command: 'fill',
      locator: { by: 'testId', value: 'task-title' },
      pageUrl,
      durationMs: 8,
      location: at(5),
      valueLength: 17,
    },
    {
      type: 'action.completed',
      ...savesScope,
      command: 'click',
      locator: { by: 'testId', value: 'save-task' },
      pageUrl,
      durationMs: 9,
      location: at(6),
    },
  ]
}

function passingCount(): EventBody[] {
  return [
    { type: 'test.started', ...countScope, name: 'shows the count', file, location: at(10, 1) },
    { type: 'action.completed', ...countScope, command: 'goto', pageUrl, durationMs: 11, location: at(11) },
    {
      type: 'assertion.passed',
      ...countScope,
      matcher: 'toHaveText',
      locator: { by: 'testId', value: 'count' },
      expected: truncateText('0 tasks'),
      actual: truncateText('0 tasks'),
      comparison,
      attempts: 1,
      timeoutMs: 5000,
      durationMs: 4,
      location: at(12),
      pageUrl,
    },
    { type: 'test.finished', ...countScope, status: 'passed', durationMs: 904, assertionCount: 1 },
  ]
}

function runFinished(fields: Omit<Extract<EventBody, { type: 'run.finished' }>, 'type'>): EventBody {
  return { type: 'run.finished', ...fields }
}

// The details are the ones a failed locator assertion records, which repeat the event's own fields.
function assertionFailure(expected: string, actual: string, message: string): EventBody[] {
  const details = { expected: truncateText(expected), received: truncateText(actual), attempts: 14, timeoutMs: 5000, comparison }
  const failure: Failure = { class: 'check_failed', message, location: at(7), details }
  return [
    {
      type: 'assertion.failed',
      ...savesScope,
      matcher: 'toHaveText',
      locator: savedTask,
      expected: truncateText(expected),
      actual: truncateText(actual),
      comparison,
      attempts: 14,
      timeoutMs: 5000,
      durationMs: 5003,
      location: at(7),
      pageUrl,
      failure,
    },
    {
      type: 'evidence.captured',
      ...savesScope,
      kind: 'screenshot',
      path: 'artifacts/saves-a-task-failure.png',
      reason: 'failure',
    },
    { type: 'test.finished', ...savesScope, status: 'failed', durationMs: 5600, assertionCount: 1, failure },
  ]
}

// Everything up to the end of the run in which both tests pass.
function passingTests(rootDir: string): EventBody[] {
  return [
    runStarted(rootDir),
    browserStarted,
    collected,
    ...savesTaskActions(),
    {
      type: 'assertion.passed',
      ...savesScope,
      matcher: 'toHaveText',
      locator: savedTask,
      expected: truncateText('Release checklist'),
      actual: truncateText('Release checklist'),
      comparison,
      attempts: 3,
      timeoutMs: 5000,
      durationMs: 210,
      location: at(7),
      pageUrl,
    },
    { type: 'test.finished', ...savesScope, status: 'passed', durationMs: 812, assertionCount: 1 },
    ...passingCount(),
  ]
}

/** Both tests pass. */
export function passingRun(rootDir: string): RetestEvent[] {
  return stamp([
    ...passingTests(rootDir),
    runFinished({
      status: 'passed',
      exitCode: 0,
      complete: true,
      counts: { passed: 2, failed: 0, error: 0, notRun: 0, inconclusive: 0 },
      durationMs: 1900,
    }),
  ])
}

/** The first test's check fails after the save; the second passes. */
export function failingRun(
  rootDir: string,
  values = { expected: 'Release checklist', actual: 'Saving…' },
): RetestEvent[] {
  const message = `Expected the text ${JSON.stringify(values.expected)}, received ${JSON.stringify(values.actual)}.`
  return stamp([
    runStarted(rootDir),
    browserStarted,
    collected,
    ...savesTaskActions(),
    ...assertionFailure(values.expected, values.actual, message),
    ...passingCount(),
    runFinished({
      status: 'failed',
      exitCode: 1,
      complete: true,
      counts: { passed: 1, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
      durationMs: 6100,
    }),
  ])
}

/** The click is covered by an overlay, and the screenshot could not be taken. */
export function actionFailureRun(rootDir: string): RetestEvent[] {
  const failure: Failure = {
    class: 'not_actionable',
    message: "getByTestId('save-task') is covered by another element at its centre.",
    location: at(6),
    details: { check: 'hit test', coveredBy: 'div.overlay' },
  }
  return stamp([
    runStarted(rootDir),
    browserStarted,
    collected,
    ...savesTaskActions().slice(0, -1),
    {
      type: 'action.failed',
      ...savesScope,
      command: 'click',
      locator: { by: 'testId', value: 'save-task' },
      pageUrl,
      durationMs: 10_002,
      location: at(6),
      failure,
    },
    {
      type: 'evidence.failed',
      ...savesScope,
      kind: 'screenshot',
      reason: 'failure',
      message: 'The page closed first.',
    },
    { type: 'test.finished', ...savesScope, status: 'failed', durationMs: 10_050, assertionCount: 0, failure },
    ...passingCount(),
    runFinished({
      status: 'failed',
      exitCode: 1,
      complete: true,
      counts: { passed: 1, failed: 1, error: 0, notRun: 0, inconclusive: 0 },
      durationMs: 11_000,
    }),
  ])
}

/** The browser is lost during the first test, so the second never runs. */
export function lostBrowserRun(rootDir: string): RetestEvent[] {
  const failure: Failure = {
    class: 'outcome_unknown',
    message: 'The browser closed after the click was sent.',
    location: at(6),
  }
  const notRun: Failure = { class: 'session_lost', message: 'The browser was lost before this test started.' }
  return stamp([
    runStarted(rootDir),
    browserStarted,
    collected,
    ...savesTaskActions().slice(0, -1),
    {
      type: 'action.failed',
      ...savesScope,
      command: 'click',
      locator: { by: 'testId', value: 'save-task' },
      durationMs: 40,
      location: at(6),
      failure,
    },
    { type: 'test.finished', ...savesScope, status: 'error', durationMs: 90, assertionCount: 0, failure },
    { type: 'test.finished', ...countScope, status: 'not_run', durationMs: 0, assertionCount: 0, failure: notRun },
    runFinished({
      status: 'error',
      exitCode: 2,
      complete: false,
      counts: { passed: 0, failed: 0, error: 1, notRun: 1, inconclusive: 0 },
      durationMs: 400,
    }),
  ])
}

/** The first test fails its check and its cleanup; the second passes its check but its cleanup fails. */
export function cleanupFailureRun(rootDir: string): RetestEvent[] {
  const message = 'Expected the text "Release checklist", received "Saving…".'
  const [assertion, evidence, finished] = assertionFailure('Release checklist', 'Saving…', message)
  const cleanup: Failure = { class: 'cleanup_failed', message: 'The browser context did not close within 10000 ms.' }
  if (finished?.type !== 'test.finished' || assertion === undefined || evidence === undefined)
    throw new Error('fixture')
  const countEvents = passingCount()
  const countFinished: EventBody = {
    type: 'test.finished',
    ...countScope,
    status: 'error',
    durationMs: 904,
    assertionCount: 1,
    cleanupFailures: [cleanup],
  }
  return stamp([
    runStarted(rootDir),
    browserStarted,
    collected,
    ...savesTaskActions(),
    assertion,
    evidence,
    { ...finished, cleanupFailures: [cleanup] },
    ...countEvents.slice(0, -1),
    countFinished,
    runFinished({
      status: 'failed',
      exitCode: 1,
      complete: false,
      counts: { passed: 0, failed: 1, error: 1, notRun: 0, inconclusive: 0 },
      durationMs: 7000,
    }),
  ])
}

/** The first test runs out of time while its check still looks, so the rest of the file does not run. */
export function timedOutRun(rootDir: string): RetestEvent[] {
  const failure: Failure = {
    class: 'timeout',
    message: 'The test ran longer than its 3000 ms budget.',
    location: at(7),
    details: { timeoutMs: 3000 },
  }
  const notRun: Failure = {
    class: 'timeout',
    message: 'Not run: "saves a task" timed out, and Retest ended the process for this file because code from that test may still be running.',
  }
  return stamp([
    runStarted(rootDir),
    browserStarted,
    collected,
    ...savesTaskActions(),
    {
      type: 'assertion.failed',
      ...savesScope,
      matcher: 'toHaveText',
      locator: savedTask,
      expected: truncateText('Release checklist'),
      actual: truncateText('Saving…'),
      comparison,
      attempts: 9,
      timeoutMs: 2990,
      durationMs: 2990,
      location: at(7),
      pageUrl,
      failure,
    },
    { type: 'test.finished', ...savesScope, status: 'failed', durationMs: 3004, assertionCount: 1, failure },
    { type: 'test.finished', ...countScope, status: 'not_run', durationMs: 0, assertionCount: 0, failure: notRun },
    runFinished({
      status: 'failed',
      exitCode: 1,
      complete: false,
      counts: { passed: 0, failed: 1, error: 0, notRun: 1, inconclusive: 0 },
      durationMs: 3100,
    }),
  ])
}

/** The browser does not start, so no test runs, and the run fails for that one reason. */
export function launchFailureRun(rootDir: string): RetestEvent[] {
  const failure: Failure = {
    class: 'setup_failed',
    message: 'No browser at /opt/chromium. Pass the path to a Chromium or Chrome executable.',
  }
  return stamp([
    runStarted(rootDir),
    collected,
    { type: 'test.finished', ...savesScope, status: 'not_run', durationMs: 0, assertionCount: 0, failure },
    { type: 'test.finished', ...countScope, status: 'not_run', durationMs: 0, assertionCount: 0, failure },
    runFinished({
      status: 'error',
      exitCode: 2,
      complete: false,
      counts: { passed: 0, failed: 0, error: 0, notRun: 2, inconclusive: 0 },
      durationMs: 30,
      failure,
    }),
  ])
}

/** A file whose import fails, so nothing runs; the run fails for the same reason. */
export function collectionFailureRun(rootDir: string): RetestEvent[] {
  const failure: Failure = {
    class: 'collection_failed',
    message: "Cannot find module './missing.ts' imported from examples/task.retest.ts",
    location: at(1, 1),
  }
  return stamp([
    runStarted(rootDir),
    { type: 'collection.failed', file, failure },
    runFinished({
      status: 'error',
      exitCode: 2,
      complete: false,
      counts: { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 },
      durationMs: 150,
      failure,
    }),
  ])
}

/** What Retest records when the file's process throws while no test is running. */
export const lateError: Failure = {
  class: 'test_error',
  message: `${file} threw an error while no test was running: Error: late`,
  location: at(4),
}

/** Both tests pass, then the file's process throws while no test is running. */
export function lateErrorRun(rootDir: string): RetestEvent[] {
  return stamp([
    ...passingTests(rootDir),
    { type: 'file.failed', file, failure: lateError },
    runFinished({
      status: 'error',
      exitCode: 2,
      complete: false,
      counts: { passed: 2, failed: 0, error: 0, notRun: 0, inconclusive: 0 },
      durationMs: 1900,
      failure: lateError,
    }),
  ])
}

/** A writer that keeps what it was given. */
export type Captured = Writer & { readonly text: string; readonly isTTY: boolean }

export function capture(isTTY = false): Captured {
  let text = ''
  return {
    isTTY,
    write(chunk: string) {
      text += chunk
    },
    get text() {
      return text
    },
  }
}

/** Removes ANSI colour codes. */
export function plain(text: string): string {
  return text.replace(/\u001b\[\d+m/g, '')
}
