import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { rebuildResult } from '../../src/store/rebuild-result.ts'
import { recordedRun, recordingRecord } from './reporters-html-fixtures.ts'
import {
  actionFailureRun,
  capture,
  cleanupFailureRun,
  collectionFailureRun,
  failingRun,
  file,
  lateErrorRun,
  launchFailureRun,
  lostBrowserRun,
  passingRun,
  plain,
  projectFolder,
  resultOf,
  runStarted,
  stamp,
  temporaryFolder,
  timedOutRun,
} from './reporters-fixtures.ts'

const root = projectFolder()
const runFolder = '.retest/runs/2026-09-30T09-15-00.000Z'

function render(events: RetestEvent[], options: { color?: boolean; result?: RunResult } = {}) {
  const stdout = capture()
  const stderr = capture()
  const reporter = createHumanReporter({ stdout, stderr, color: options.color ?? false, runFolder })
  for (const event of events) reporter.onEvent(event)
  reporter.onRunEnd(options.result ?? resultOf(events))
  return { stdout: stdout.text, stderr: stderr.text }
}

describe('human reporter', () => {
  test('a JSONL reconstruction names every interrupted recording gap exactly', () => {
    const complete = recordedRun(root)
    const stopped = complete.slice(0, complete.findIndex(event => event.type === 'recording.finished'))
    const result = rebuildResult(stopped)
    const recording = result.files.flatMap(file => file.tests).flatMap(test => test.recordings ?? [])[0]
    assert.ok(recording)
    assert.equal(recording.gaps[0]?.code, 'run_stopped')
    const { stdout } = render(stopped, { result })
    for (const gap of recording.gaps) {
      assert.ok(stdout.includes(gap.code), 'terminal identifies the exact gap code')
      assert.ok(stdout.includes(gap.message), 'terminal preserves the exact gap reason')
    }
    assert.ok(stdout.includes('unavailable'))
    assert.equal(result.complete, false)
    assert.equal(stdout.includes('undefined'), false)
  })

  test('finished evidence and rebuilt results show each reason once, including run gaps', () => {
    const gaps = [
      { code: 'capture_gaps', message: 'Capture missed the first state.', app: 'web', sessionId: 'attempt:web' },
      { code: 'frames_dropped', message: 'Two frames were dropped.', app: 'web', sessionId: 'attempt:web' },
    ] as const
    const events = recordedRun(root, recordingRecord({ status: 'partial', gaps: [...gaps] }))
      .map((event): RetestEvent => event.type === 'test.finished' ? { ...event, evidenceStatus: { state: 'partial', gaps: [...gaps] } } : event)
    const result = resultOf(events)
    result.evidenceStatus = { state: 'partial', attempts: { complete: 0, partial: 1, unavailable: 0, notRequested: 0 }, gaps: [{ code: 'media_unavailable', message: 'The run could not finish its media worker.' }] }
    const { stdout } = render(events, { result })
    for (const gap of [...gaps, ...(result.evidenceStatus.gaps ?? [])]) {
      assert.equal(stdout.split(gap.message).length - 1, 1)
      assert.ok(stdout.includes(`${gap.code}: ${gap.message}`))
    }
  })

  test('a passing run lists each test and a summary, with no card', () => {
    const { stdout, stderr } = render(passingRun(root))
    assert.equal(stderr, '')
    assert.equal(
      stdout,
      [
        '',
        '  retest 0.0.0  Chrome 140.0.7339.80',
        '',
        '  examples/task.retest.ts  2 tests',
        '    ✓ saves a task  812 ms',
        '    ✓ shows the count  904 ms',
        '',
        '  Tests   2 passed',
        '  Checks  2 passed',
        '  Time    1.9s',
        `  Output  ${runFolder}`,
        '  Exit    0',
        '',
        '',
      ].join('\n'),
    )
  })

  test("the header counts a target's browsers whichever of them starts first", () => {
    const spread = (numberedFirst: boolean): RetestEvent[] =>
      passingRun(root).flatMap((event): RetestEvent[] => {
        if (event.type !== 'browser.started') return [event]
        const counted = { ...event, instances: 2 }
        const numbered = { ...event, instance: 2, pid: event.pid + 1 }
        return numberedFirst ? [numbered, counted] : [counted, numbered]
      })
    for (const numberedFirst of [false, true]) {
      const lines = render(spread(numberedFirst)).stdout.split('\n').filter((line) => line.includes('Chrome'))
      assert.deepEqual(lines, ['  retest 0.0.0  Chrome 140.0.7339.80 · 2 browsers'], numberedFirst ? 'the second browser started first' : 'the first browser started first')
    }
  })

  test('prints each test as its event arrives', () => {
    const stdout = capture()
    const reporter = createHumanReporter({ stdout, stderr: capture(), color: false, runFolder })
    const events = passingRun(root)
    const firstFinished = events.findIndex((event) => event.type === 'test.finished')
    for (const event of events.slice(0, firstFinished + 1)) reporter.onEvent(event)
    assert.match(stdout.text, /✓ saves a task {2}812 ms\n$/)
    assert.doesNotMatch(stdout.text, /shows the count/)
  })

  // The failure's details repeat the values, the comparison, the looks and the limit, so none of them is printed again.
  test('a failed check prints one card with everything needed to act on it, each fact once', () => {
    const { stdout } = render(failingRun(root))
    const card = stdout.slice(stdout.indexOf('  ✗ examples/task.retest.ts › saves a task'), stdout.indexOf('  Tests'))
    assert.equal(
      card,
      [
        '  ✗ examples/task.retest.ts › saves a task  5.6s',
        '',
        '    Check failed     toHaveText',
        "    Locator          getByTestId('saved-task')",
        '    Page             http://127.0.0.1:4173/',
        '    - Expected       "Release checklist"',
        '    + Received       "Saving…"',
        '    Compared         whole text, ends trimmed, each run of spaces or line breaks read as one space',
        '    Waited           5s for toHaveText, looked 14 times, limit 5s',
        '',
        '    examples/task.retest.ts:7:3',
        "      5 │   await page.getByTestId('task-title').fill('Release checklist')",
        "      6 │   await page.getByTestId('save-task').click()",
        "    › 7 │   await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')",
        '      8 │ })',
        '',
        `    Screenshot       ${runFolder}/artifacts/saves-a-task-failure.png`,
        '    Rerun            npx retest run examples/task.retest.ts:3 --browser "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --base-url http://127.0.0.1:4173',
        `    Inspect          npx retest inspect ${runFolder} --test "examples/task.retest.ts > saves a task"`,
        '',
        '',
      ].join('\n'),
    )
    assert.match(stdout, /\n {2}Tests {3}1 failed · 1 passed\n {2}Checks {2}1 failed · 1 passed\n {2}Time {4}6\.1s\n/)
    assert.match(stdout, /\n {2}Exit {4}1\n\n$/)
  })

  test('says so when the source file is gone', () => {
    const elsewhere = temporaryFolder()
    const { stdout } = render(failingRun(elsewhere))
    assert.match(stdout, /\n {4}examples\/task\.retest\.ts:7:3 {2}\(the file is gone\)\n/)
    assert.match(stdout, /Rerun {12}npx retest run examples\/task\.retest\.ts/)
  })

  test('says so when the source file no longer reaches the failing line', () => {
    const shortened = projectFolder()
    writeFileSync(join(shortened, file), "test('saves a task', async () => {})\n")
    const { stdout } = render(failingRun(shortened))
    assert.match(
      stdout,
      /examples\/task\.retest\.ts:7:3 {2}\(line 7 is past the end of the file, which may have changed since the run\)/,
    )
  })

  test('an action failure names the call, its checks and the missing screenshot', () => {
    const { stdout } = render(actionFailureRun(root))
    assert.match(stdout, /\n {4}Not actionable {3}click\n/)
    assert.match(stdout, /\n {4}getByTestId\('save-task'\) is covered by another element at its centre\.\n/)
    assert.match(stdout, /\n {4}Waited {11}10s for click\n/)
    assert.match(stdout, /\n {4}check {12}"hit test"\n {4}coveredBy {8}"div\.overlay"\n/)
    assert.match(stdout, /\n {4}› 6 │ {3}await page\.getByTestId\('save-task'\)\.click\(\)\n/)
    assert.match(stdout, /\n {4}Screenshot {7}not saved: The page closed first\.\n/)
    assert.doesNotMatch(stdout, /Expected|Received|Compared/)
  })

  test('lists tests that did not run, with the reason, and marks the run incomplete', () => {
    const { stdout } = render(lostBrowserRun(root))
    assert.match(stdout, /\n {4}! saves a task {2}90 ms\n {4}- shows the count {2}not run\n/)
    assert.match(stdout, /\n {4}Outcome unknown {2}click\n {4}The browser closed after the click was sent\.\n/)
    assert.match(
      stdout,
      /\n {2}Not run\n {4}examples\/task\.retest\.ts › shows the count {2}The browser was lost before this test started\.\n/,
    )
    assert.match(stdout, /\n {2}Tests {3}1 error · 1 not run\n/)
    assert.match(stdout, /\n {2}Exit {4}2 · incomplete\n/)
    assert.doesNotMatch(stdout, /✗ examples\/task\.retest\.ts › shows the count/)
  })

  test('keeps the original failure beside a cleanup failure', () => {
    const { stdout } = render(cleanupFailureRun(root))
    const first = stdout.slice(
      stdout.indexOf('✗ examples/task.retest.ts › saves a task'),
      stdout.indexOf('✗ examples/task.retest.ts › shows the count'),
    )
    assert.match(first, /Check failed {5}toHaveText/)
    assert.match(first, /- Expected {7}"Release checklist"/)
    assert.match(first, /Cleanup failed {3}The browser context did not close within 10000 ms\./)
    const second = stdout.slice(stdout.indexOf('✗ examples/task.retest.ts › shows the count'))
    assert.match(
      second,
      /^✗ examples\/task\.retest\.ts › shows the count {2}904 ms\n\n {4}Cleanup failed\n {4}The browser context did not close within 10000 ms\.\n/,
    )
    assert.match(stdout, /\n {2}Exit {4}1 · incomplete\n/)
  })

  test('a timeout keeps its message beside the values, and a detail with a value the card does not show', () => {
    const { stdout } = render(timedOutRun(root))
    assert.match(stdout, /\n {4}Timed out {8}toHaveText\n {4}The test ran longer than its 3000 ms budget\.\n/)
    assert.match(stdout, /\n {4}Waited {11}3s for toHaveText, looked 9 times, limit 3s\n {4}timeoutMs {8}3000\n/)
    assert.doesNotMatch(stdout, /attempts|comparison {3}/)
  })

  test('a run failure is printed once, and not beside each test it kept from running', () => {
    const { stdout } = render(launchFailureRun(root))
    assert.match(
      stdout,
      /\n {2}Not run\n {4}examples\/task\.retest\.ts › saves a task\n {4}examples\/task\.retest\.ts › shows the count\n\n {2}Run failed\n {4}Setup failed\n {4}No browser at \/opt\/chromium\. Pass the path to a Chromium or Chrome executable\.\n\n {2}Tests {3}2 not run\n/,
    )
    assert.equal(stdout.split('No browser at').length, 2)
  })

  test('a run failure that a collection card already shows is not printed again', () => {
    const { stdout } = render(collectionFailureRun(root))
    assert.equal(stdout.split("Cannot find module './missing.ts'").length, 2)
    assert.doesNotMatch(stdout, /Run failed/)
  })

  test('shows long values cut, with the recorded length', () => {
    const long = 'x'.repeat(10_000)
    const { stdout } = render(failingRun(root, { expected: 'Release checklist', actual: long }))
    const received = stdout.split('\n').find((line) => line.includes('+ Received')) ?? ''
    assert.ok(received.includes(`"${'x'.repeat(300)}"… (300 of 10000 characters)`), received.slice(0, 80))
    assert.ok(received.length < 400)
  })

  test('diffs values line by line when either has several lines', () => {
    const { stdout } = render(
      failingRun(root, { expected: 'Tasks\nRelease checklist\nDone', actual: 'Tasks\nSaving…\nDone' }),
    )
    assert.match(
      stdout,
      /\n {4}- Expected\n {4}\+ Received\n\n {6}Tasks\n {4}- Release checklist\n {4}\+ Saving…\n {6}Done\n/,
    )
  })

  test('a file that could not be collected gets a card with its reason', () => {
    const { stdout } = render(collectionFailureRun(root))
    assert.match(
      stdout,
      /\n {2}✗ examples\/task\.retest\.ts {2}could not be collected\n\n {4}Collection failed\n {4}Cannot find module/,
    )
    assert.match(stdout, /\n {4}› 1 │ import \{ test, expect \}/)
    assert.match(stdout, new RegExp(`\\n {4}Inspect {10}npx retest inspect ${runFolder.replaceAll('.', '\\.')}\\n`))
    assert.match(stdout, /\n {2}Tests {3}none\n {2}Files {3}1 file could not be collected\n/)
    assert.match(stdout, /\n {2}Exit {4}2 · incomplete\n/)
  })

  test('a file whose process failed outside its tests is marked after its tests, gets a card of its own, and the run failure is not repeated', () => {
    const { stdout } = render(lateErrorRun(root))
    assert.match(stdout, /\n {4}✓ shows the count {2}904 ms\n {2}✗ examples\/task\.retest\.ts {2}failed outside its tests\n\n/)
    assert.match(
      stdout,
      /\n {2}✗ examples\/task\.retest\.ts {2}failed outside its tests\n\n {4}Test error\n {4}examples\/task\.retest\.ts threw an error while no test was running: Error: late\n/,
    )
    assert.match(stdout, /\n {4}› 4 │ {3}await page\.goto\('\/'\)\n/)
    assert.doesNotMatch(stdout, /Run failed/)
    assert.match(stdout, /\n {2}Files {3}1 file failed outside its tests\n/)
    assert.match(stdout, /\n {2}Exit {4}2 · incomplete\n/)
  })

  test('an interrupted run says so', () => {
    const events = passingRun(root)
    const result: RunResult = { ...resultOf(events), status: 'interrupted', exitCode: 130, complete: false }
    assert.match(render(events, { result }).stdout, /\n {2}Exit {4}130 · interrupted, incomplete\n/)
  })

  test('the rerun command repeats changed timeouts', () => {
    const events = failingRun(root)
    events[0] =
      stamp([runStarted(root, { timeouts: { ...defaultTimeouts, action: 500, test: 3000 } })])[0] ?? assert.fail()
    assert.match(render(events).stdout, /--base-url http:\/\/127\.0\.0\.1:4173 --timeouts action=500,test=3000\n/)
  })

  test('colours only when asked, with the same words', () => {
    const coloured = render(failingRun(root), { color: true }).stdout
    const uncoloured = render(failingRun(root)).stdout
    assert.ok(coloured.includes('\u001b[31m'))
    assert.ok(!uncoloured.includes('\u001b['))
    assert.equal(plain(coloured), uncoloured)
  })

  test('echoes test output line by line, and what never ended at the run end', () => {
    const stdout = capture()
    const stderr = capture()
    const reporter = createHumanReporter({ stdout, stderr, color: false, runFolder })
    reporter.onOutput({ file, stream: 'stdout', text: 'one\r\ntw' })
    reporter.onOutput({ file, stream: 'stderr', text: 'warn\n' })
    assert.equal(stdout.text, '  examples/task.retest.ts | one\n')
    reporter.onOutput({ file, stream: 'stdout', text: 'o\nthree' })
    assert.equal(stdout.text, '  examples/task.retest.ts | one\n  examples/task.retest.ts | two\n')
    assert.equal(stderr.text, '  examples/task.retest.ts | warn\n')
    const events = passingRun(root)
    for (const event of events) reporter.onEvent(event)
    reporter.onRunEnd(resultOf(events))
    assert.match(stdout.text, /✓ shows the count {2}904 ms\n {2}examples\/task\.retest\.ts \| three\n\n {2}Tests/)
  })
})
