import type { Failure } from '../../src/protocol/failures.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { Reporter } from '../../src/reporters/reporter.ts'
import type { ChildOutput, RunOptions } from '../../src/runner/contract.ts'
import type { RunRecord } from '../support/run-harness.ts'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { eventsFile, resultFile } from '../../src/protocol/run-folder.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { RunFolderError, runFiles } from '../../src/runner/run.ts'
import { readRunFolder } from '../../src/store/read-run-folder.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { eventsOfType, isGoneWithin, isRunning, printedPids, rootDir, runSupportFiles, supportFile, testNamed } from '../support/run-harness.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { capture } from './reporters-fixtures.ts'

describe('deadlines', () => {
  test('a test waiting on nothing times out and answers the abort; its process still ends, and the rest of the file does not run', async () => {
    const record = await runSupportFiles(['timeouts.retest.ts', 'passing.retest.ts'])
    const timedOut = testNamed(record.result, 'waits for something that never comes')
    assert.equal(timedOut.status, 'failed')
    assert.deepEqual(timedOut.failure, {
      class: 'timeout',
      message: 'The test ran longer than its 300 ms budget.',
      details: { timeoutMs: 300 },
    })
    assert.ok(timedOut.durationMs < 1000, `answered in ${timedOut.durationMs} ms, before the grace period ran out`)
    const skipped = testNamed(record.result, 'runs after a timed out test')
    assert.equal(skipped.status, 'not_run')
    assert.deepEqual(skipped.failure, {
      class: 'timeout',
      message:
        'Not run: "waits for something that never comes" timed out, and Retest ended the process for this file because code from that test may still be running.',
    })
    const [pid] = printedPids(record.output)
    assert.ok(pid !== undefined)
    assert.equal(isRunning(pid), false, 'the file process is gone')
    assert.equal(testNamed(record.result, 'saves a task').status, 'passed', 'the next file gets a new process')
    assert.equal(record.result.exitCode, 1)
    assert.equal(record.result.complete, false)
    assert.equal(record.result.failure, undefined, 'the tests explain the run')
  })

  test('an endless loop in a test is ended by killing its process; the rest of the file does not run', async () => {
    const started = performance.now()
    const record = await runSupportFiles(['endless-loop.retest.ts', 'passing.retest.ts'])
    const looping = testNamed(record.result, 'loops forever')
    assert.equal(looping.status, 'failed')
    assert.equal(looping.failure?.class, 'timeout')
    assert.match(looping.failure?.message ?? '', /Its process did not stop within 1000 ms of being asked, so Retest ended it\.$/)
    const skipped = testNamed(record.result, 'never gets a turn')
    assert.equal(skipped.status, 'not_run')
    assert.equal(skipped.failure?.class, 'timeout')
    assert.match(skipped.failure?.message ?? '', /^Not run: "loops forever" timed out, and Retest ended the process for this file/)
    const [pid] = printedPids(record.output)
    assert.ok(pid !== undefined)
    assert.equal(isRunning(pid), false)
    assert.equal(testNamed(record.result, 'saves a task').status, 'passed', 'the next file gets a new process')
    assert.equal(record.result.exitCode, 1)
    assert.equal(record.result.complete, false)
    assert.ok(performance.now() - started < 300 + 1000 + 3000)
    assert.ok(record.browsers[0]?.pages[0]?.disposed, 'the killed test still had its page released')
  })

  test('a command gets no more time than the test has left', async () => {
    const record = await runSupportFiles(['slow-click.retest.ts'], { fake: { hang: 'click' } })
    const slow = testNamed(record.result, 'clicks something that never answers')
    assert.equal(slow.failure?.class, 'timeout')
    const [click] = eventsOfType(record.events, 'action.failed')
    assert.ok((click?.durationMs ?? 0) <= 450, `the click was given ${click?.durationMs} ms of a 400 ms test`)
    assert.equal(record.browsers[0]?.commands.filter((command) => command.kind === 'click').length, 1, 'the click was never sent twice')
  })

  test('running out of time stops the command still in the page, which sends nothing more and says why', async () => {
    const record = await runSupportFiles(['slow-click.retest.ts'], { fake: { hang: 'click', overrunMs: 5000 } })
    const [click] = eventsOfType(record.events, 'action.failed')
    assert.equal(click?.failure.class, 'timeout')
    assert.equal(
      click?.failure.message,
      "The test ran longer than its 400 ms budget. It was waiting for getByTestId('save-task').click(). getByTestId('save-task').click() was stopped before it sent any input.",
    )
    assert.deepEqual(click?.failure.details, { timeoutMs: 400, inputSent: false })
    assert.ok((click?.durationMs ?? Infinity) < 1000, `the click was answered after ${click?.durationMs} ms, not at the end of its overrun`)
    const page = record.browsers[0]?.pages[0]
    assert.deepEqual(page?.stopped.map((command) => command.kind), ['click'])
    assert.equal(page?.clicks, 0)
    assert.equal(eventsOfType(record.events, 'action.completed').filter((event) => event.command === 'click').length, 0)
  })

  test('an action still running when the test ends is reported unknown once, and stopped in the page', async () => {
    const record = await runSupportFiles(['unawaited.retest.ts'], { timeouts: { cleanup: 100 } })
    const test = testNamed(record.result, 'returns while an action runs')
    assert.match(test.failure?.message ?? '', /was still running when the test returned/)
    const clicks = eventsOfType(record.events, 'action.failed').filter((event) => event.testId === test.testId)
    assert.deepEqual(
      clicks.map((event) => [event.failure.class, event.failure.message]),
      [['outcome_unknown', 'The browser had not answered when the test ended, so whether the action took effect is unknown.']],
    )
    const stopped = record.browsers[0]?.pages.flatMap((page) => page.stopped) ?? []
    assert.deepEqual(stopped, [{ kind: 'click', locator: { by: 'testId', value: 'missing' } }])
  })

  test('an action that times out on its own leaves the process to the next test', async () => {
    const record = await runSupportFiles(['slow-click.retest.ts'], { fake: { hang: 'click' }, timeouts: { action: 100 } })
    const slow = testNamed(record.result, 'clicks something that never answers')
    assert.equal(slow.failure?.class, 'timeout')
    assert.equal(testNamed(record.result, 'runs next').status, 'passed')
    const [pid] = printedPids(record.output)
    assert.ok(pid !== undefined && !isRunning(pid))
  })
})

// The click's event, the test's verdict and the stored result say the same thing about the lost browser.
function lostClick(record: RunRecord): Failure {
  const [click, ...others] = eventsOfType(record.events, 'action.failed').filter((event) => event.command === 'click')
  assert.ok(click !== undefined && others.length === 0, 'the click is reported once')
  const [finished] = eventsOfType(record.events, 'test.finished')
  assert.deepEqual(finished?.failure, click.failure)
  assert.deepEqual(testNamed(record.result, 'saves a task').failure, click.failure)
  assert.deepEqual(testNamed(record.written ?? assert.fail(), 'saves a task').failure, click.failure)
  return click.failure
}

describe('the browser', () => {
  test('lost during an action that sent its input: that test has an unknown outcome, and later tests do not run', async () => {
    const record = await runSupportFiles(['passing.retest.ts', 'timeouts.retest.ts'], { fake: { disconnect: { on: 'click', stage: 'after_input' } } })
    const lost = testNamed(record.result, 'saves a task')
    assert.equal(lost.status, 'error')
    const failure = lostClick(record)
    assert.equal(failure.class, 'outcome_unknown')
    assert.equal(failure.message, "The page lost its browser after getByTestId('save-task').click() sent its input: The browser process exited.")
    assert.deepEqual([failure.location?.file, failure.location?.line], [supportFile('passing.retest.ts'), 6])
    for (const name of ['returns values from nested steps', 'waits for something that never comes']) {
      const later = testNamed(record.result, name)
      assert.equal(later.status, 'not_run', name)
      assert.equal(later.failure?.class, 'session_lost', name)
    }
    const [evidence] = eventsOfType(record.events, 'evidence.failed')
    assert.equal(evidence?.message, 'The browser was gone, so Retest took no screenshot.')
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.browsers.length, 1, 'the browser is not relaunched')
    const [pid] = printedPids(record.output)
    assert.ok(pid !== undefined && !isRunning(pid))
  })

  test('lost while an action waits, before it sent any input: the page says so, and nothing is unknown', async () => {
    const record = await runSupportFiles(['passing.retest.ts'], { fake: { disconnect: { on: 'click', stage: 'before_input' } } })
    assert.equal(testNamed(record.result, 'saves a task').status, 'error')
    assert.equal(lostClick(record).class, 'session_lost')
    assert.match(lostClick(record).message, /^The page lost its browser before getByTestId\('save-task'\)\.click\(\) sent any input/)
    assert.equal(record.result.exitCode, 2)
  })

  test('lost during an action that does not answer in time: its outcome is unknown, reported once', async () => {
    const started = performance.now()
    const record = await runSupportFiles(['passing.retest.ts'], {
      fake: { disconnect: { on: 'click', stage: 'no_answer' } },
      timeouts: { action: 3000 },
    })
    const failure = lostClick(record)
    assert.equal(failure.class, 'outcome_unknown')
    assert.match(failure.message, /^The browser was lost during getByTestId\('save-task'\)\.click\(\), which had not answered 1000 ms later, so whether it took effect is unknown\./)
    const [click] = eventsOfType(record.events, 'action.failed')
    // A timer can fire up to a millisecond before the clock agrees, as Deadline allows.
    assert.ok((click?.durationMs ?? 0) >= 999, `the page had its grace period, and the click was reported after ${click?.durationMs} ms`)
    assert.ok(performance.now() - started < 3000, 'the run did not wait for the page to answer')
  })

  test('that fails to launch: tests do not run, the failure is the run failure and theirs, and the run exits 2', async () => {
    const record = await runSupportFiles(['passing.retest.ts'], { fake: { launchFails: 'No browser at /fake/chromium.' } })
    const launch = { class: 'setup_failed', message: 'No browser at /fake/chromium.' }
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.result.browser, null)
    assert.deepEqual(record.result.failure, launch)
    assert.deepEqual(eventsOfType(record.events, 'run.finished')[0]?.failure, launch)
    assert.deepEqual(record.written?.failure, launch)
    for (const test of record.result.files.flatMap((file) => file.tests)) {
      assert.equal(test.status, 'not_run')
      assert.deepEqual(test.failure, launch)
    }
    assert.equal(eventsOfType(record.events, 'browser.started').length, 0)
  })

  test('opens each page within the setup budget and is closed within the cleanup budget', async () => {
    const record = await runSupportFiles(['passing.retest.ts'], { timeouts: { setup: 4321, cleanup: 1234 } })
    const [browser] = record.browsers
    assert.deepEqual(browser?.pageBudgets, [4321, 4321, 4321])
    assert.equal(browser?.closeBudget, 1234)
    assert.equal(browser?.closed, true)
  })

  test('once started, is reported with its process id and executable', async () => {
    const record = await runSupportFiles(['output.retest.ts'])
    const [started] = eventsOfType(record.events, 'browser.started')
    assert.equal(started?.pid, record.browsers[0]?.pid)
    assert.equal(started?.executablePath, '/fake/chromium')
    assert.equal(record.result.browser?.executablePath, '/fake/chromium')
  })

  test('a screenshot that fails is recorded beside the original failure', async () => {
    const record = await runSupportFiles(['no-assertions.retest.ts'], { fake: { screenshotFails: true } })
    const test = testNamed(record.result, 'only acts')
    assert.equal(test.failure?.class, 'no_assertions')
    assert.deepEqual(test.evidence, [])
    assert.equal(eventsOfType(record.events, 'evidence.failed')[0]?.message, 'Retest could not take a screenshot: The page could not be captured.')
  })
})

describe('cleanup', () => {
  test('a cleanup failure is kept beside the original failure', async () => {
    const record = await runSupportFiles(['failing.retest.ts'], { fake: { disposeFails: true } })
    const failed = testNamed(record.result, 'shows the wrong text')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.failure?.class, 'check_failed')
    assert.deepEqual(failed.cleanupFailures, [
      { class: 'cleanup_failed', message: "Closing the test's browser context failed: The browser context would not close." },
    ])
    assert.equal(record.result.exitCode, 1)
  })

  test('a cleanup failure alone makes the test an error and the run exit 2', async () => {
    const record = await runSupportFiles(['output.retest.ts'], { fake: { disposeFails: true } })
    const test = testNamed(record.result, 'writes to stdout and stderr')
    assert.equal(test.status, 'error')
    assert.equal(test.failure, undefined)
    assert.equal(test.cleanupFailures?.length, 1)
    assert.equal(record.result.exitCode, 2)
  })
})

describe('interruption', () => {
  test('stops the running test and its process, closes the browser, and keeps what exists', async () => {
    const controller = new AbortController()
    const started = performance.now()
    const record = await runSupportFiles(['slow-click.retest.ts', 'passing.retest.ts'], {
      signal: controller.signal,
      timeouts: { action: 10_000, test: 20_000 },
      fake: {
        hang: 'click',
        onCommand: (command) => {
          if (command.kind === 'click') setTimeout(() => controller.abort(), 20)
        },
      },
    })
    assert.ok(performance.now() - started < 3000, 'the run stopped promptly')
    assert.equal(record.result.exitCode, 130)
    assert.equal(record.result.status, 'interrupted')
    assert.equal(record.result.complete, false)
    assert.deepEqual(record.written, record.result)
    const stopped = testNamed(record.result, 'clicks something that never answers')
    assert.equal(stopped.status, 'error')
    assert.equal(stopped.failure?.class, 'interrupted')
    assert.equal(testNamed(record.result, 'runs next').status, 'not_run')
    assert.equal(record.result.files[1]?.collection, 'ok', 'every file was collected before any test ran')
    assert.deepEqual(record.result.files[1]?.tests.map((test) => [test.status, test.failure?.class]), [
      ['not_run', 'interrupted'],
      ['not_run', 'interrupted'],
      ['not_run', 'interrupted'],
    ])
    const [click] = eventsOfType(record.events, 'action.failed')
    assert.deepEqual(click?.failure, {
      class: 'interrupted',
      message: "The run was interrupted. getByTestId('save-task').click() was stopped before it sent any input.",
      details: { inputSent: false },
      location: { file: supportFile('slow-click.retest.ts'), line: 6, column: 39 },
    })
    assert.equal(record.browsers[0]?.pages[0]?.stopped.length, 1)
    assert.equal(record.browsers[0]?.closed, true)
    const [pid] = printedPids(record.output)
    assert.ok(pid !== undefined && !isRunning(pid))
    assert.equal(eventsOfType(record.events, 'run.finished')[0]?.exitCode, 130)
  })

  test('a page that keeps working after it is stopped leaves the action unknown, reported once', async () => {
    const controller = new AbortController()
    const record = await runSupportFiles(['slow-click.retest.ts'], {
      signal: controller.signal,
      timeouts: { action: 10_000, test: 20_000 },
      fake: {
        hang: 'click',
        ignoresStop: true,
        onCommand: (command) => {
          if (command.kind === 'click') setTimeout(() => controller.abort(), 20)
        },
      },
    })
    const clicks = eventsOfType(record.events, 'action.failed')
    assert.deepEqual(
      clicks.map((event) => [event.failure.class, event.failure.message]),
      [['outcome_unknown', 'The browser had not answered when the test ended, so whether the action took effect is unknown.']],
    )
    assert.equal(record.result.exitCode, 130)
  })

  test('before the run starts, nothing runs and the run exits 130', async () => {
    const controller = new AbortController()
    controller.abort()
    const record = await runSupportFiles(['passing.retest.ts'], { signal: controller.signal })
    assert.equal(record.result.exitCode, 130)
    assert.equal(record.browsers.length, 0)
    assert.equal(record.result.files[0]?.failure?.class, 'interrupted')
  })

  test('by SIGTERM takes the same path and exits 143', async () => {
    const controller = new AbortController()
    const record = await runSupportFiles(['slow-click.retest.ts', 'passing.retest.ts'], {
      signal: controller.signal,
      timeouts: { action: 10_000, test: 20_000 },
      fake: {
        hang: 'click',
        onCommand: (command) => {
          if (command.kind === 'click') setTimeout(() => controller.abort('SIGTERM'), 20)
        },
      },
    })
    assert.deepEqual([record.result.exitCode, record.result.status, record.result.complete], [143, 'interrupted', false])
    assert.deepEqual(record.written, record.result)
    assert.equal(eventsOfType(record.events, 'run.finished')[0]?.exitCode, 143)
    assert.deepEqual(testNamed(record.result, 'clicks something that never answers').failure?.message, 'The run was stopped by SIGTERM.')
    assert.equal(record.browsers[0]?.closed, true)
    const [pid] = printedPids(record.output)
    assert.ok(pid !== undefined && !isRunning(pid))
  })
})

describe('reporters', () => {
  test('a reporter that throws ends the run with exit 2; the test under way finishes and the rest do not run', async () => {
    const seen: string[] = []
    const broken: Reporter = {
      name: 'terminal',
      onEvent: (event) => {
        if (event.type === 'test.started') throw new Error('The terminal went away.')
      },
      onRunEnd: () => undefined,
    }
    const listening: Reporter = { name: 'listening', onEvent: (event) => void seen.push(event.type), onRunEnd: () => void seen.push('end') }
    const record = await runSupportFiles(['passing.retest.ts', 'failing.retest.ts'], { reporters: [broken, listening] })
    const lost = { class: 'reporting_failed', message: 'The terminal reporter failed on test.started: The terminal went away.' }
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.result.status, 'error')
    assert.deepEqual(record.result.failure, lost)
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.reporter, 'terminal,listening')
    assert.equal(testNamed(record.result, 'saves a task').status, 'passed')
    const skipped = testNamed(record.result, 'returns values from nested steps')
    assert.deepEqual(skipped.failure, lost)
    assert.ok(record.result.files[1]?.tests.every((test) => test.status === 'not_run' && test.failure?.class === 'reporting_failed'))
    assert.equal(seen.at(-1), 'end', 'the other reporter still received everything')
    assert.equal(seen.at(-2), 'run.finished')
    assert.deepEqual(record.written, record.result)
  })

  test('a reporter that throws at the end still makes the run exit 2', async () => {
    const broken: Reporter = {
      name: 'summary',
      onEvent: () => undefined,
      onRunEnd: () => {
        throw new Error('Could not print the summary.')
      },
    }
    const record = await runSupportFiles(['output.retest.ts'], { reporters: [broken] })
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.written?.exitCode, 2)
    assert.deepEqual(record.written?.failure, {
      class: 'reporting_failed',
      message: 'The summary reporter failed on the end of the run: Could not print the summary.',
    })
  })

  test('a result that is kept after the report is the same result, with the same times', async () => {
    let seen: RunResult | undefined
    const slow: Reporter = {
      name: 'slow',
      onEvent: () => undefined,
      onRunEnd: async (result) => {
        seen = result
        await sleep(30)
      },
    }
    const record = await runSupportFiles(['output.retest.ts'], { reporters: [slow] })
    assert.deepEqual(record.written, seen)
    assert.deepEqual(record.result, seen)
    assert.equal(eventsOfType(record.events, 'run.finished')[0]?.durationMs, record.result.durationMs)
  })

  test('a reporter that breaks at the end changes the stored outcome and nothing else', async () => {
    let seen: RunResult | undefined
    const broken: Reporter = {
      name: 'summary',
      onEvent: () => undefined,
      onRunEnd: async (result) => {
        seen = result
        await sleep(30)
        throw new Error('Could not print the summary.')
      },
    }
    const record = await runSupportFiles(['output.retest.ts'], { reporters: [broken] })
    const [finished] = eventsOfType(record.events, 'run.finished')
    const given = seen ?? assert.fail('the reporter was given the result')
    const written = record.written ?? assert.fail('result.json was written')
    assert.deepEqual([finished?.exitCode, given.exitCode, written.exitCode], [0, 0, 2])
    assert.deepEqual([written.status, written.complete, written.failure?.class], ['error', false, 'reporting_failed'])
    const facts = (result: RunResult) => [result.runId, result.startedAt, result.finishedAt, result.durationMs, result.counts, result.files]
    assert.deepEqual(facts(written), facts(given), 'the times, counts and files are the ones the reporter was given')
    assert.equal(finished?.durationMs, written.durationMs)
  })
})

// The first test of stray-error.retest.ts leaves a listener behind that throws on SIGUSR2. `set` sends the
// signal and resolves once the process is gone. Node reports a child's exit as it reaps it, so by then the
// runner has seen the process end.
function strayError(): { onOutput: (chunk: ChildOutput) => void; set: () => Promise<void> } {
  const pid = Promise.withResolvers<number>()
  let printed = ''
  return {
    onOutput: (chunk) => {
      printed += chunk.text
      const found = /pid (\d+)\n/.exec(printed)?.[1]
      if (found !== undefined) pid.resolve(Number(found))
    },
    set: async () => {
      const child = await pid.promise
      process.kill(child, 'SIGUSR2')
      assert.ok(await isGoneWithin(child, 5000), 'the process ended')
    },
  }
}

function startedTests(record: RunRecord): string[] {
  return eventsOfType(record.events, 'test.started').map((event) => event.testId)
}

describe('a file process that fails outside its tests', () => {
  const file = (name: string): string => supportFile(name)
  const stray = 'stray-error.retest.ts'
  const endedBefore: Failure = { class: 'test_error', message: 'Not run: the process for this file ended before this test could run (exit code 1).' }
  const strayThrown = /threw an error while no test was running: Error: thrown after the test ended\n/

  test('dies between tests: the tests after it do not run or start, and the file fails with the error', async () => {
    const error = strayError()
    const record = await runSupportFiles([stray], {
      onOutput: error.onOutput,
      fake: { holdClosing: async (index) => (index === 0 ? error.set() : undefined) },
    })
    const [first, ...later] = record.result.files[0]?.tests ?? []
    assert.equal(first?.status, 'passed')
    assert.deepEqual(later.map((test) => [test.status, test.failure]), [['not_run', endedBefore], ['not_run', endedBefore]])
    assert.deepEqual(startedTests(record), [first?.testId], 'no later test started')
    assert.equal(record.browsers[0]?.pages.length, 1, 'no page was opened for them')
    assert.ok(record.output.some((chunk) => chunk.stream === 'stderr' && chunk.text.includes('thrown after the test ended')))
    assert.match(record.result.files[0]?.failure?.message ?? '', strayThrown)
    assert.equal(record.result.exitCode, 2)
  })

  test("dies while the next test's page opens: that test does not run, no screenshot is taken, and the run exits 2", async () => {
    const error = strayError()
    const record = await runSupportFiles([stray], {
      onOutput: error.onOutput,
      fake: { holdOpening: async (index) => (index === 1 ? error.set() : undefined) },
    })
    const [first, next, last] = record.result.files[0]?.tests ?? []
    assert.equal(first?.status, 'passed')
    assert.deepEqual(startedTests(record), [first?.testId, next?.testId], 'the next test had started to open its page')
    for (const test of [next, last]) {
      assert.deepEqual([test?.status, test?.failure, test?.durationMs, test?.assertionCount, test?.evidence], ['not_run', endedBefore, 0, 0, []])
    }
    assert.deepEqual(eventsOfType(record.events, 'test.finished').map((event) => event.status), ['passed', 'not_run', 'not_run'])
    assert.deepEqual(eventsOfType(record.events, 'evidence.captured'), [], 'no screenshot of the blank page')
    assert.deepEqual(eventsOfType(record.events, 'evidence.failed'), [])
    assert.equal(record.browsers[0]?.pages[1]?.disposed, true, 'the page it opened was released')
    assert.deepEqual(record.result.counts, { passed: 1, failed: 0, error: 0, notRun: 2, inconclusive: 0 })
    assert.deepEqual([record.result.exitCode, record.result.status, record.result.complete], [2, 'error', false])
    assert.match(record.result.files[0]?.failure?.message ?? '', strayThrown)
    assert.deepEqual(record.written, record.result)
  })

  test("dies while the next test's page opens, and that page will not close: the test that did not run keeps the cleanup failure", async () => {
    const error = strayError()
    const record = await runSupportFiles([stray], {
      onOutput: error.onOutput,
      fake: { disposeFails: true, holdOpening: async (index) => (index === 1 ? error.set() : undefined) },
    })
    const next = testNamed(record.result, 'waits for the next turn')
    const cleanupFailures = [{ class: 'cleanup_failed', message: "Closing the test's browser context failed: The browser context would not close." }]
    assert.deepEqual([next.status, next.failure, next.cleanupFailures], ['not_run', endedBefore, cleanupFailures])
    const finished = eventsOfType(record.events, 'test.finished').find((event) => event.testId === next.testId)
    assert.deepEqual(finished?.cleanupFailures, cleanupFailures)
    assert.equal(record.result.exitCode, 2)
  })

  test('throws after the last test: the file fails, and the run is incomplete and exits 2', async () => {
    const name = 'late-error.retest.ts'
    const record = await runSupportFiles([name], { fake: { disposeDelayMs: 200 }, reporters: [] })
    assert.equal(testNamed(record.result, 'leaves a timer behind').status, 'passed')
    const thrown: Failure = {
      class: 'test_error',
      message: [
        `${file(name)} threw an error while no test was running: Error: thrown after the last test ended`,
        `Code from the earlier test "leaves a timer behind" may be the cause; this was thrown at ${file(name)}:5.`,
      ].join('\n'),
      location: { file: file(name), line: 5, column: 11 },
    }
    assert.deepEqual(record.result.files[0], { file: file(name), collection: 'ok', failure: thrown, tests: record.result.files[0]?.tests })
    assert.deepEqual([record.result.exitCode, record.result.status, record.result.complete], [2, 'error', false])
    assert.deepEqual(record.result.failure, thrown)
    assert.deepEqual(record.written, record.result)
    const failed = eventsOfType(record.events, 'file.failed')
    assert.deepEqual(failed.map((event) => [event.file, event.failure]), [[file(name), thrown]])
    assert.deepEqual(record.events.slice(-2).map((event) => event.type), ['file.failed', 'run.finished'])
    const [finished] = eventsOfType(record.events, 'run.finished')
    assert.deepEqual([finished?.exitCode, finished?.complete, finished?.failure], [2, false, thrown])
  })

  test('throws after the last test: the reports and inspect show it', async () => {
    const name = 'late-error.retest.ts'
    const agent = capture()
    const human = capture()
    const humanErrors = capture()
    const reporters = [
      createAgentReporter({ stdout: agent, runFolder: 'run' }),
      createHumanReporter({ stdout: human, stderr: humanErrors, color: false, runFolder: 'run' }),
    ]
    const record = await runSupportFiles([name], { fake: { disposeDelayMs: 200 }, reporters })
    assert.match(agent.text, new RegExp(`^error ${file(name).replaceAll('.', '\\.')}:5 failed outside its tests\n  test_error ${file(name).replaceAll('.', '\\.')} threw an error`, 'm'))
    assert.match(human.text, /\n {4}✓ leaves a timer behind .*\n {2}✗ tests\/support\/files\/late-error\.retest\.ts {2}failed outside its tests\n/)
    assert.match(human.text, /✗ tests\/support\/files\/late-error\.retest\.ts {2}failed outside its tests\n\n {4}Test error\n/)
    // The fake browser collects no diagnostics, so the summary's Diagnostics row sets the label column's width.
    assert.match(human.text, /\n {2}Files {8}1 file failed outside its tests\n/)
    const thrown = record.result.files[0]?.failure
    assert.ok(thrown !== undefined)
    assert.deepEqual(readRunFolder(record.folder, 'run').result.files[0]?.failure, thrown)
    rmSync(join(record.folder, resultFile))
    const rebuilt = readRunFolder(record.folder, 'run').result
    assert.match(rebuilt.failure?.message ?? '', /threw an error while no test was running: Error: thrown after the last test ended/)
    assert.deepEqual(rebuilt.files[0]?.failure, thrown)
  })

  test('throws after the last test, and the run is killed before it finishes: inspect still shows the file failure', async () => {
    const record = await runSupportFiles(['late-error.retest.ts'], { fake: { disposeDelayMs: 200 } })
    const thrown = record.result.files[0]?.failure
    assert.ok(thrown !== undefined)
    assert.deepEqual(record.events.slice(-2).map((event) => event.type), ['file.failed', 'run.finished'])
    rmSync(join(record.folder, resultFile))
    writeFileSync(join(record.folder, eventsFile), record.lines.slice(0, -1).map((line) => `${line}\n`).join(''))
    const rebuilt = readRunFolder(record.folder, 'run').result
    assert.deepEqual(rebuilt.files[0]?.failure, thrown)
    assert.deepEqual(rebuilt.failure, { class: 'interrupted', message: 'The run stopped before it finished.' })
    assert.deepEqual([rebuilt.exitCode, rebuilt.complete], [2, false])
  })

  test('dies after the last test: the file fails with the way its process ended', async () => {
    const name = 'late-exit.retest.ts'
    const record = await runSupportFiles([name], { fake: { disposeDelayMs: 200 } })
    assert.equal(testNamed(record.result, 'leaves an exit behind').status, 'passed')
    const ended = { class: 'test_error', message: `The process for ${file(name)} ended with exit code 3 while no test was running.` }
    assert.deepEqual(record.result.files[0]?.failure, ended)
    assert.deepEqual([record.result.exitCode, record.result.complete, record.result.failure], [2, false, ended])
    assert.deepEqual(eventsOfType(record.events, 'run.finished')[0]?.failure, ended)
  })

  test('is too busy to close after the last test: it is ended, and the file fails', async () => {
    const name = 'busy-after-tests.retest.ts'
    const record = await runSupportFiles([name], { fake: { disposeDelayMs: 200 } })
    assert.equal(testNamed(record.result, 'leaves a loop behind').status, 'passed')
    assert.deepEqual(record.result.files[0]?.failure, {
      class: 'test_error',
      message: `The process for ${file(name)} did not close within 1000 ms of being asked to, so Retest ended it.`,
    })
    assert.equal(record.result.exitCode, 2)
  })

  test('closes cleanly after its tests: the file has no failure of its own', async () => {
    const record = await runSupportFiles(['output.retest.ts'])
    assert.equal(record.result.files[0]?.failure, undefined)
    assert.deepEqual(eventsOfType(record.events, 'file.failed'), [])
    assert.deepEqual([record.result.exitCode, record.result.complete], [0, true])
  })
})

describe('the child process', () => {
  test('an event for another test is a violation: the test fails at once and its process is ended', async () => {
    const started = performance.now()
    const record = await runSupportFiles(['foreign-event.retest.ts'])
    const test = testNamed(record.result, 'reports a step of another test')
    assert.equal(test.failure?.class, 'test_error')
    assert.equal(test.failure?.message, 'The process for this file sent step.started for an inactive test attempt.')
    assert.equal(testNamed(record.result, 'never gets a turn').status, 'not_run')
    assert.equal(eventsOfType(record.events, 'step.started').length, 0, 'the event is not recorded')
    assert.ok(performance.now() - started < 2000, 'the test did not wait for its timeout')
  })

  test("a secret fill in milestone 1's mode fails as usage, and types nothing", async () => {
    const record = await runSupportFiles(['secret-fill.retest.ts'])
    const test = testNamed(record.result, 'fills a secret without a config')
    assert.deepEqual([test.failure?.class, test.failure?.message], ['usage', 'secret("password") needs a config that declares it. This run has no secrets.'])
    assert.deepEqual(record.browsers[0]?.commands, [])
    assert.equal(eventsOfType(record.events, 'action.failed')[0]?.secret, 'password')
  })

  test('a command for an app the test does not use is a violation, and reaches no page', async () => {
    const record = await runSupportFiles(['foreign-app.retest.ts'])
    const test = testNamed(record.result, 'sends a command for an app it does not use')
    assert.deepEqual([test.failure?.class, test.failure?.message], ['test_error', 'The process for this file sent a command for the app "admin", which this test does not use.'])
    assert.deepEqual(record.browsers[0]?.commands, [])
  })

  test('an error from code an earlier test left behind fails the running test and names that test', async () => {
    const name = 'earlier-callback.retest.ts'
    const record = await runSupportFiles([name])
    assert.equal(testNamed(record.result, 'leaves a callback behind').status, 'passed')
    assert.deepEqual(testNamed(record.result, 'sets it off').failure, {
      class: 'test_error',
      message: [
        'Error: thrown by code the earlier test left behind',
        `Code from the earlier test "leaves a callback behind" may be the cause; this was thrown at ${supportFile(name)}:7.`,
      ].join('\n'),
      location: { file: supportFile(name), line: 7, column: 11 },
    })
  })
})

describe('the base URL', () => {
  test('keeps its credentials for the page, and is recorded and printed without them', async () => {
    const stdout = capture()
    const reporter = createHumanReporter({ stdout, stderr: capture(), color: false, runFolder: 'run' })
    const baseUrl = 'http://ada:secret@127.0.0.1:4173'
    const record = await runSupportFiles(['no-assertions.retest.ts'], { baseUrl, reporters: [reporter] })
    assert.equal(record.browsers[0]?.pages[0]?.baseUrl, baseUrl)
    assert.equal(eventsOfType(record.events, 'run.started')[0]?.options.baseUrl, 'http://127.0.0.1:4173/')
    assert.match(stdout.text, /--base-url http:\/\/127\.0\.0\.1:4173\//)
    for (const text of [readFileSync(join(record.folder, eventsFile), 'utf8'), readFileSync(join(record.folder, resultFile), 'utf8'), stdout.text]) {
      assert.equal(text.includes('secret'), false)
    }
  })
})

describe('owned processes', () => {
  test('a parent that exits mid-run takes its test file process with it', async () => {
    const script = fileURLToPath(new URL('../support/exit-mid-run.ts', import.meta.url))
    const parent = spawn(process.execPath, ['--conditions=retest-source', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    let printed = ''
    parent.stdout.setEncoding('utf8').on('data', (text: string) => {
      printed += text
    })
    const [code] = await once(parent, 'close')
    assert.equal(code, 3)
    const pid = Number(/child (\d+)/.exec(printed)?.[1])
    assert.ok(pid > 0, `the child reported its id: ${JSON.stringify(printed)}`)
    assert.equal(await isGoneWithin(pid, 2000), true)
  })
})

describe('the run folder', () => {
  test('an output folder that holds files is refused before anything runs', async () => {
    const folder = tempFolder('taken-')
    writeFileSync(join(folder, 'result.json'), '{}')
    const { launch, browsers } = fakeLauncher()
    const options: RunOptions = {
      files: [supportFile('passing.retest.ts')],
      rootDir,
      apps: { kind: 'browser', browserPath: '/fake/chromium' },
      timeouts: defaultTimeouts,
      outputDir: folder,
      headless: true,
      signal: new AbortController().signal,
    }
    await assert.rejects(runFiles(options, [], launch), RunFolderError)
    assert.equal(browsers.length, 0)
  })
})
