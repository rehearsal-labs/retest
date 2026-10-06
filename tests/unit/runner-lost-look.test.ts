import type { CommandResult } from '../../src/protocol/commands.ts'
import type { ChildEvent } from '../../src/protocol/events.ts'
import type { Failure, SourceLocation } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ScriptedTest } from '../support/scripted-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { runFiles } from '../../src/runner/run.ts'
import { abortGraceMs } from '../../src/runner/running-test.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { tempProject } from '../support/project.ts'
import { eventsOfType, newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'
import { scriptedApp, scriptedTest } from '../support/scripted-process.ts'

// A browser lost while an assertion looks at the page. The test file's process reports nothing more of a test once it
// is asked to abort, so the parent asks only once the check that was looking has reported the loss, and records that
// check as failed with the loss, at the check's own place, as its own record.

const at: SourceLocation = { file: 'tests/a.retest.ts', line: 7, column: 9 }
const savedTask: LocatorRecipe = { by: 'testId', value: 'saved-task' }
const lostReason = 'the browser closed the pipe'

// What happens next on the parent's side: its answers, its records and its stop, once the page has said what it says.
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function sentTypes(run: ScriptedTest): string[] {
  return run.process.sent.map((message) => message.type)
}

// One look at the saved task, sent as the check at `at` sends it, marked as a check's look.
function look(run: ScriptedTest, id: number): Promise<CommandResult> {
  run.process.deliver({ type: 'command', ...run.process.scope, id, app: scriptedApp, command: { kind: 'observe', locator: savedTask, check: true }, timeoutMs: 500, location: at })
  return run.process.answer(id)
}

// The assertion the test file's process reports when a look of its check is answered with a failure, as
// `pollLocator` writes it: naming the last look the parent served, if one was.
function checkFailed(run: ScriptedTest, failure: Failure, served: CommandResult | undefined): ChildEvent {
  const named =
    served?.ok === true && served.kind === 'observe' && served.observationId !== undefined && served.sessionId !== undefined
      ? { observationId: served.observationId, sessionId: served.sessionId }
      : {}
  return {
    type: 'assertion.failed',
    testId: run.testId,
    attemptId: run.attemptId,
    session: scriptedApp,
    matcher: 'toHaveText',
    locator: savedTask,
    expected: truncateText('Release checklist'),
    actual: null,
    attempts: 2,
    timeoutMs: 5000,
    durationMs: 60,
    location: at,
    ...named,
    check: { matcher: 'toHaveText', text: 'Release checklist' },
    failure,
  }
}

function finished(run: ScriptedTest, failure: Failure | undefined, assertionCount: number): void {
  run.process.deliver({ type: 'test-finished', ...run.process.scope, status: 'failed', ...(failure === undefined ? {} : { failure }), assertionCount, durationMs: 70 })
}

function recordedFailures(run: ScriptedTest) {
  return run.events.flatMap(({ body, origin }) => (body.type === 'assertion.failed' ? [{ body, origin }] : []))
}

describe('a browser lost while a check looks', () => {
  test('between two looks: the next look gets the loss, the check is recorded as failed with it at its place, and only then is the process asked to abort', async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    await run.command(1, { kind: 'goto', url: '/' })
    const served = await look(run, 2)
    assert.equal(served.ok && served.kind === 'observe' ? served.observationId : undefined, 'o1')
    run.running.browserLost(lostReason)
    await settled()
    assert.deepEqual(sentTypes(run), ['run', 'command-result', 'command-result'], 'the process is not asked to abort while its check may still report')

    const lost: Failure = { class: 'session_lost', message: `The browser was lost: ${lostReason}`, location: at }
    assert.deepEqual(await look(run, 3), { ok: false, failure: lost }, "the check's next look is answered with the loss, at the check's place")
    run.event(checkFailed(run, lost, served))
    await settled()

    const records = recordedFailures(run)
    assert.equal(records.length, 1)
    const [record] = records
    assert.equal(record?.origin, 'parent', 'the parent saw the loss, so the record is its own')
    assert.deepEqual(
      [record?.body.matcher, record?.body.locator, record?.body.location, record?.body.observationId, record?.body.sessionId, record?.body.failure],
      ['toHaveText', savedTask, at, 'o1', formatSessionId(run.attemptId, scriptedApp), lost],
      'the record names the check, its place and the look it rested on, with the loss as its failure',
    )
    assert.ok(run.timeline.indexOf('assertion.failed') < run.timeline.indexOf('abort'), 'the process is asked to abort once the check reported')

    finished(run, lost, 1)
    const report = await run.report
    await run.running.settle(0)
    run.running.close()
    assert.deepEqual(report.failure, lost, "the test fails with the check's loss, at its place")
    assert.ok(report.observed?.some((each) => isDeepStrictEqual(each, lost)), 'the loss at the check is the parent\'s own observation')
  })

  test('during a look the page answers: the page\'s own words are the check\'s failure, recorded by the parent before it asks the process to abort', async () => {
    const run = await scriptedTest({ fake: { disconnect: { on: 'observe', stage: 'before_input' } }, timeouts: { test: 10_000 } })
    await run.command(1, { kind: 'goto', url: '/' })
    const answer = look(run, 2)
    await settled()
    run.running.browserLost('The browser process exited.')
    const answered = await answer
    assert.ok(!answered.ok, 'the look failed')
    assert.deepEqual([answered.failure.class, answered.failure.location], ['session_lost', at])
    assert.match(answered.failure.message, /^The page lost its browser before .+ sent any input: The browser process exited\.$/)
    await settled()
    assert.equal(sentTypes(run).includes('abort'), false, 'the process is not asked to abort while its check may still report')

    run.event(checkFailed(run, answered.failure, undefined))
    await settled()
    const [record, ...others] = recordedFailures(run)
    assert.deepEqual(others, [])
    assert.deepEqual([record?.origin, record?.body.matcher, record?.body.location, record?.body.failure], ['parent', 'toHaveText', at, answered.failure])
    assert.ok(run.timeline.indexOf('assertion.failed') < run.timeline.indexOf('abort'))

    finished(run, answered.failure, 1)
    const report = await run.report
    await run.running.settle(0)
    run.running.close()
    assert.deepEqual(report.failure, answered.failure)
  })

  test('a check that never reports: the process is asked to abort once the grace period is over, and the test still ends as a lost session', async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    await look(run, 1)
    const startedAt = performance.now()
    run.running.browserLost(lostReason)
    while (!sentTypes(run).includes('abort')) {
      assert.ok(performance.now() - startedAt < abortGraceMs * 3, 'the process was asked to abort')
      await delay(10)
    }
    // A timer can fire up to a millisecond before the clock agrees.
    assert.ok(performance.now() - startedAt >= abortGraceMs - 1, 'the check had the grace period to report')
    finished(run, undefined, 0)
    const report = await run.report
    await run.running.settle(0)
    run.running.close()
    // The check never said where it was, so the loss names the place its last look came from.
    assert.deepEqual(report.failure, { class: 'session_lost', message: `The browser was lost: ${lostReason}`, location: at })
    assert.deepEqual(recordedFailures(run), [])
  })

  test('a loss right after a plain read, which no check sent, asks the process to abort without waiting for an assertion', async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    run.process.deliver({ type: 'command', ...run.process.scope, id: 1, app: scriptedApp, command: { kind: 'observePage' }, timeoutMs: 500, location: at })
    await run.process.answer(1)
    const startedAt = performance.now()
    run.running.browserLost(lostReason)
    while (!sentTypes(run).includes('abort')) await delay(5)
    assert.ok(performance.now() - startedAt < abortGraceMs / 2, 'no check was looking, so nothing was waited for')
    finished(run, undefined, 0)
    const report = await run.report
    await run.running.settle(0)
    run.running.close()
    assert.deepEqual(report.failure, { class: 'session_lost', message: `The browser was lost: ${lostReason}`, location: at })
  })

  test('a loss with nothing in flight and no check between looks names the place of the last command the test sent', async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    const typedAt: SourceLocation = { file: 'tests/a.retest.ts', line: 4, column: 3 }
    run.process.deliver({ type: 'command', ...run.process.scope, id: 1, app: scriptedApp, command: { kind: 'fill', locator: { by: 'testId', value: 'task-title' }, value: 'Draft' }, timeoutMs: 500, location: typedAt })
    await run.process.answer(1)
    run.running.browserLost(lostReason)
    while (!sentTypes(run).includes('abort')) await delay(5)
    finished(run, undefined, 0)
    const report = await run.report
    await run.running.settle(0)
    run.running.close()
    assert.deepEqual(report.failure, { class: 'session_lost', message: `The browser was lost: ${lostReason}`, location: typedAt })
  })
})

describe('a browser lost while a check looks, in a run', async () => {
  const file = 'tests/lost.retest.ts'
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('a browser lost while a check looks', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('a test after the browser is lost does not run', async ({ page }) => {
  await page.goto('/')
})
`
  let lossScheduled = false
  const { launch, browsers } = fakeLauncher({
    onCommand: (command) => {
      if (command.kind !== 'observe' || lossScheduled) return
      lossScheduled = true
      // Once the first look has answered, while the check waits before its next look, as a check mostly does.
      setTimeout(() => browsers[0]?.disconnect(lostReason), 20)
    },
  })
  const folder = newRunFolder()
  const result = await runFiles(
    {
      files: [file],
      rootDir: tempProject({ [file]: tests }),
      apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: 'http://127.0.0.1:4173' },
      timeouts: { ...quickTimeouts, assertion: 5000, test: 10_000 },
      outputDir: folder,
      headless: true,
      workers: 1,
      signal: new AbortController().signal,
    },
    [],
    launch,
  )
  const { events } = readEvents(folder)
  const [lostTest, laterTest] = result.files.flatMap((each) => each.tests)

  test("the test ends as a lost session at the check's line, and the run names the failed check", () => {
    assert.equal(result.exitCode, 2)
    assert.deepEqual([lostTest?.status, lostTest?.failure?.class, lostTest?.failure?.location?.file, lostTest?.failure?.location?.line], ['error', 'session_lost', file, 5])
    const recorded = eventsOfType(events, 'assertion.failed').filter((event) => event.attemptId === lostTest?.attemptId)
    assert.equal(recorded.length, 1, 'one check is recorded as failed')
    const [check] = recorded
    assert.ok(check !== undefined)
    assert.deepEqual([check.origin, check.matcher, check.location?.line], ['parent', 'toHaveText', 5])
    assert.deepEqual(check.failure, lostTest?.failure, 'the check and the test say the same')
    const looked = eventsOfType(events.slice(0, events.indexOf(check)), 'observation').map((event) => event.observationId)
    assert.ok(check.observationId !== undefined && looked.includes(check.observationId), 'the record rests on a look the parent served before it')
    assert.deepEqual([laterTest?.status, laterTest?.failure?.class], ['not_run', 'session_lost'])
  })
})
