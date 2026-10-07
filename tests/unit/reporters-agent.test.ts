import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import {
  actionFailureRun,
  capture,
  cleanupFailureRun,
  collectionFailureRun,
  comparison,
  failingRun,
  lateErrorRun,
  launchFailureRun,
  lostBrowserRun,
  passingRun,
  projectFolder,
  resultOf,
  timedOutRun,
} from './reporters-fixtures.ts'

const root = projectFolder()
const runFolder = '.retest/runs/2026-09-30T09-15-00.000Z'

function render(events: RetestEvent[], result: RunResult = resultOf(events)): string {
  const stdout = capture(true)
  const reporter = createAgentReporter({ stdout, runFolder })
  for (const event of events) reporter.onEvent(event)
  assert.equal(stdout.text, '', 'the agent report waits for the end of the run')
  reporter.onRunEnd(result)
  return stdout.text
}

describe('agent reporter', () => {
  test('a failed check: counts first, one block with each fact once, then the next command', () => {
    assert.equal(
      render(failingRun(root)),
      [
        'retest: 1 failed, 1 passed (2) in 6.1s, exit 1',
        'fail examples/task.retest.ts:7 saves a task',
        "  check_failed toHaveText getByTestId('saved-task')",
        '  expected "Release checklist" received "Saving…" waited 5003ms for toHaveText, looked 14 times, limit 5000ms',
        `  compared ${comparison}`,
        `  screenshot ${runFolder}/artifacts/saves-a-task-failure.png`,
        `next: npx retest inspect ${runFolder} --test "examples/task.retest.ts > saves a task" --json`,
        '',
      ].join('\n'),
    )
  })

  test('a passing run is two lines', () => {
    assert.equal(
      render(passingRun(root)),
      `retest: 2 passed (2) in 1.9s, exit 0\nnext: npx retest inspect ${runFolder} --json\n`,
    )
  })

  test('an action failure keeps its message, details and the missing screenshot', () => {
    const lines = render(actionFailureRun(root)).split('\n')
    assert.deepEqual(lines.slice(1, 8), [
      'fail examples/task.retest.ts:6 saves a task',
      "  not_actionable click getByTestId('save-task')",
      "  getByTestId('save-task') is covered by another element at its centre.",
      '  waited 10002ms for click',
      '  check "hit test"',
      '  coveredBy "div.overlay"',
      '  screenshot not saved: The page closed first.',
    ])
  })

  test('errors and tests that did not run are listed, and the run is marked incomplete', () => {
    assert.equal(
      render(lostBrowserRun(root)),
      [
        'retest: 1 error, 1 not run (2) in 400 ms, exit 2, incomplete',
        'error examples/task.retest.ts:6 saves a task',
        "  outcome_unknown click getByTestId('save-task')",
        '  The browser closed after the click was sent.',
        '  waited 40ms for click',
        'not run examples/task.retest.ts:10 shows the count',
        '  session_lost The browser was lost before this test started.',
        `next: npx retest inspect ${runFolder} --test "examples/task.retest.ts > saves a task" --json`,
        '',
      ].join('\n'),
    )
  })

  test('cleanup failures follow the original failure', () => {
    const report = render(cleanupFailureRun(root))
    assert.match(
      report,
      /fail examples\/task\.retest\.ts:7 saves a task\n {2}check_failed toHaveText .*\n {2}expected .*\n {2}compared .*\n {2}screenshot .*\n {2}cleanup_failed The browser context did not close within 10000 ms\.\n/,
    )
    assert.match(
      report,
      /error examples\/task\.retest\.ts:10 shows the count\n {2}cleanup_failed The browser context did not close within 10000 ms\.\nnext: /,
    )
  })

  test('a collection failure points to the whole run, and is not repeated as the run failure', () => {
    assert.equal(
      render(collectionFailureRun(root)),
      [
        'retest: no tests ran in 150 ms, exit 2, incomplete',
        'error examples/task.retest.ts:1 could not be collected',
        "  collection_failed Cannot find module './missing.ts' imported from examples/task.retest.ts",
        `next: npx retest inspect ${runFolder} --json`,
        '',
      ].join('\n'),
    )
  })

  test('a file whose process failed outside its tests follows its tests, and is not repeated as the run failure', () => {
    assert.equal(
      render(lateErrorRun(root)),
      [
        'retest: 2 passed (2) in 1.9s, exit 2, incomplete',
        'error examples/task.retest.ts:4 failed outside its tests',
        '  test_error examples/task.retest.ts threw an error while no test was running: Error: late',
        `next: npx retest inspect ${runFolder} --json`,
        '',
      ].join('\n'),
    )
  })

  test('a run failure comes right after the counts, once, and not beside each test it kept from running', () => {
    assert.equal(
      render(launchFailureRun(root)),
      [
        'retest: 2 not run (2) in 30 ms, exit 2, incomplete',
        'run failed: setup_failed No browser at /opt/chromium. Pass the path to a Chromium or Chrome executable.',
        'not run examples/task.retest.ts:3 saves a task',
        'not run examples/task.retest.ts:10 shows the count',
        `next: npx retest inspect ${runFolder} --json`,
        '',
      ].join('\n'),
    )
  })

  test('a timeout keeps its message beside the values, and a detail with a value the call does not show', () => {
    const report = render(timedOutRun(root))
    assert.match(report, /\n {2}timeout toHaveText getByTestId\('saved-task'\)\n {2}The test ran longer than its 3000 ms budget\.\n/)
    assert.match(
      report,
      /\n {2}expected "Release checklist" received "Saving…" waited 2990ms for toHaveText, looked 9 times, limit 2990ms\n {2}compared .*\n {2}timeoutMs 3000\n/,
    )
    assert.doesNotMatch(report, /attempts|comparison/)
  })

  test('status words are lowercase', () => {
    for (const events of [failingRun(root), lostBrowserRun(root), collectionFailureRun(root), launchFailureRun(root)]) {
      assert.doesNotMatch(render(events), /\b(FAIL|ERROR|NOT_RUN)\b/)
    }
  })

  test('keeps multi-line values on one line and cuts long ones with their length', () => {
    const report = render(failingRun(root, { expected: 'a\nb', actual: 'y'.repeat(5000) }))
    assert.match(report, /\n {2}expected "a\\nb" received "y{300}"… \(300 of 5000 characters\) waited /)
  })

  test('never prints colour codes, even to a terminal', () => {
    assert.ok(!render(failingRun(root)).includes('\u001b['))
  })
})

test('the agent report names missing evidence separately from a passing test', () => {
  const events = passingRun(root)
  const result = resultOf(events)
  const first = result.files[0]?.tests[0]
  assert.ok(first)
  const gap = { code: 'media_process_lost' as const, message: 'The media process ended.' }
  first.evidenceStatus = { state: 'unavailable', gaps: [gap] }
  result.evidenceStatus = { state: 'unavailable', attempts: { complete: 0, partial: 0, unavailable: 1, notRequested: 1 }, gaps: [gap] }
  const output = render(events, result)
  assert.match(output, /evidence: unavailable/)
  assert.match(output, /evidence unavailable .*saves a task/)
  assert.match(output, /media_process_lost: The media process ended\./)
  assert.match(output, /2 passed/)
  assert.equal(result.exitCode, 0)
})
