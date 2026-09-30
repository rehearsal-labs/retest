import type { TestContext } from 'node:test'
import type { FinishedRun, StartedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import {
  budgets,
  childLog,
  eventsOf,
  exampleFile,
  finishRun,
  isRunning,
  onlyEvent,
  onlyTest,
  printedPids,
  resultOf,
  runRetest,
  scenario,
  startRun,
  testNamed,
  waitFor,
} from './cli-harness.ts'

// The test budget, the second a stopped test's process has to answer, then closing the browser.
const timeoutBoundMs = 10_000

async function runTimeout(t: TestContext, name: string): Promise<FinishedRun> {
  const app = await openApp(t)
  const file = scenario(name)
  const run = await runRetest(t, { files: [file], baseUrl: app.url })
  const [pid] = printedPids(childLog(run, file))
  assert.ok(pid !== undefined, 'the test file printed its process id')
  assert.equal(isRunning(pid), false, 'the process of the timed out file was ended')
  assert.ok(run.durationMs < timeoutBoundMs, `took ${run.durationMs} ms`)
  return run
}

function assertTimedOut(run: FinishedRun, name: string, later: string): void {
  assert.equal(run.exit.code, 1)
  const timedOut = testNamed(run, name)
  assert.deepEqual([timedOut.status, timedOut.failure?.class], ['failed', 'timeout'])
  assert.match(timedOut.failure?.message ?? '', /longer than its 500 ms budget/)
  const skipped = testNamed(run, later)
  assert.deepEqual([skipped.status, skipped.failure?.class], ['not_run', 'timeout'])
  assert.ok(skipped.failure?.message.includes(`"${name}" timed out`), skipped.failure?.message)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.complete, result.counts.notRun], ['failed', false, 1])
}

test('timeout: a test waiting for something that never comes is stopped, and the rest of its file does not run', async (t) => {
  const run = await runTimeout(t, 'cooperative-timeout')
  assertTimedOut(run, 'waits for something that never comes', 'runs after the timeout')
})

test('timeout: a test stuck in an endless loop is ended with its process, and the rest of its file does not run', async (t) => {
  const run = await runTimeout(t, 'loop-timeout')
  assertTimedOut(run, 'loops forever', 'runs after the loop')
})

test('timeout: the next file still runs, in a new process, after a test in the previous file timed out', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [scenario('loop-timeout'), exampleFile], baseUrl: app.url })

  assert.equal(run.exit.code, 1)
  assert.deepEqual(resultOf(run).counts, { passed: 1, failed: 1, error: 0, notRun: 1, inconclusive: 0 })
  assert.equal(testNamed(run, 'saves a task').status, 'passed')
  assert.equal(app.submissions(), 1)
})

// Kills only the browser this run reported, once `ready` proves a command is under way.
async function killBrowserWhen(started: StartedRun, ready: () => Promise<unknown>): Promise<FinishedRun> {
  const browser = await started.retest.waitForEvent('browser.started')
  await ready()
  process.kill(-browser.pid, 'SIGKILL')
  return finishRun(started)
}

function startBrowserLost(t: TestContext, baseUrl: string): Promise<StartedRun> {
  const timeouts = budgets({ action: 20_000, assertion: 20_000, test: 30_000 })
  return startRun(t, { files: [scenario('browser-lost')], baseUrl, timeouts })
}

function assertBrowserLost(run: FinishedRun, failureClass: 'outcome_unknown' | 'session_lost'): void {
  assert.equal(run.exit.code, 2)
  const lost = testNamed(run, 'saves a task')
  assert.deepEqual([lost.status, lost.failure?.class], ['error', failureClass])
  const later = testNamed(run, 'runs after the browser is lost')
  assert.deepEqual([later.status, later.failure?.class], ['not_run', 'session_lost'])
  assert.match(onlyEvent(run.events, 'evidence.failed').message, /browser was gone/)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.complete, result.counts.passed], ['error', false, 0])
}

test('browser disconnect: losing the browser during a click says its outcome is unknown, and never clicks again', async (t) => {
  const app = await openApp(t, { mode: 'frozen' })
  const started = await startBrowserLost(t, app.url)
  // The frozen page counts the press and then never confirms it, so the click is still in flight.
  const run = await killBrowserWhen(started, () => waitFor('the press reaching the app', () => app.submissions() === 1))

  assertBrowserLost(run, 'outcome_unknown')
  const lost = testNamed(run, 'saves a task').failure
  assert.match(lost?.message ?? '', /^Retest lost the page after it began to click getByTestId\('save-task'\), so it cannot tell whether that took effect/)
  const [click] = eventsOf(run.events, 'action.failed').filter((event) => event.command === 'click')
  assert.deepEqual(click?.failure, lost, 'the click and the test say the same')
  assert.equal(eventsOf(run.events, 'action.completed').filter((event) => event.command === 'click').length, 0)
  assert.equal(app.submissions(), 1)
})

test('browser disconnect: losing the browser while an assertion looks is a lost session, not a failed check', async (t) => {
  const app = await openApp(t, { mode: 'delayed', delayMs: 60_000 })
  const started = await startBrowserLost(t, app.url)
  const run = await killBrowserWhen(started, () =>
    started.retest.waitForEvent('action.completed', (event) => event.command === 'click'),
  )

  assertBrowserLost(run, 'session_lost')
  assert.equal(app.submissions(), 1)
})

test('browser disconnect: losing the browser while a click waits for its element says the page was lost, never that the outcome is unknown', async (t) => {
  const app = await openApp(t)
  const timeouts = budgets({ action: 20_000, test: 30_000 })
  const started = await startRun(t, { files: [scenario('lost-while-waiting')], baseUrl: app.url, timeouts })
  // The step starts just before its click is sent, and the click can only wait: its element never appears.
  const run = await killBrowserWhen(started, () => started.retest.waitForEvent('step.started'))

  assert.equal(run.exit.code, 2)
  const lost = onlyTest(run).failure
  assert.equal(lost?.class, 'session_lost')
  assert.deepEqual(onlyEvent(run.events, 'action.failed').failure, lost, 'the click and the test say the same')
  assert.deepEqual(onlyEvent(run.events, 'test.finished').failure, lost)
})

test('cleanup failure: the original check failure stays beside the failure to close the test context', async (t) => {
  const app = await openApp(t, { mode: 'broken' })
  // Chrome cannot confirm closing a context within 1 ms, so this budget makes cleanup fail in the real browser.
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url, timeouts: budgets({ assertion: 500, cleanup: 1 }) })

  assert.equal(run.exit.code, 1)
  const failed = onlyTest(run)
  assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'check_failed'])
  assert.deepEqual(failed.cleanupFailures?.map((cleanup) => cleanup.class), ['cleanup_failed'])
  assert.match(failed.cleanupFailures?.[0]?.message ?? '', /browser context/)
  assert.deepEqual(onlyEvent(run.events, 'test.finished').cleanupFailures, failed.cleanupFailures)
  assert.match(onlyEvent(run.events, 'evidence.failed').message, /screenshot/)
})

test('file and test isolation: each test gets clean storage in a new tab, and each file a new process', async (t) => {
  const app = await openApp(t)
  const files = [scenario('isolation'), scenario('isolation-next-file')]
  const run = await runRetest(t, { files, baseUrl: app.url })

  assert.equal(run.exit.code, 0)
  assert.deepEqual(resultOf(run).counts, { passed: 3, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
  assert.equal(app.submissions(), 1)
})
