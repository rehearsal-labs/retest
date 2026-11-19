import type { TestContext } from 'node:test'
import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { CommandResult, ObserveAfter } from '../../src/protocol/commands.ts'
import type { Failure, SourceLocation } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ParentMessage } from '../../src/protocol/messages.ts'
import type { ProcessEvent } from '../../src/runner/test-file-process.ts'
import type { ScriptedTest } from '../support/scripted-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { withEvaluationFailures } from '../../src/evaluation/run-evaluations.ts'
import { failure, truncateText } from '../../src/protocol/failures.ts'
import { runFiles } from '../../src/runner/run.ts'
import { abortGraceMs } from '../../src/runner/running-test.ts'
import { TestFileProcess } from '../../src/runner/test-file-process.ts'
import { fakeLauncher } from '../support/fake-browser.ts'
import { tempProject } from '../support/project.ts'
import { eventsOfType, newRunFolder, quickTimeouts, readEvents } from '../support/run-harness.ts'
import { scriptedApp, scriptedTest } from '../support/scripted-process.ts'

// A stop that lands while a check is looking at the page: the user's interrupt, or the test running out of its time,
// which revoke the test the same way. The stop answers the look in flight, or refuses the next, and the check then ends
// with it. The test fails with the stop, never with the failed check the look before it would make, since the check was
// still looking.

const at: SourceLocation = { file: 'tests/a.retest.ts', line: 7, column: 9 }
const title: LocatorRecipe = { by: 'testId', value: 'task-title' }
const check = { matcher: 'toHaveText', text: 'Never' } as const
const interrupted: Failure = failure('interrupted', 'The run was interrupted.')

/** A fake page that holds the answer of its look number `held`, counted from 1, until `release` is called. */
function heldLook(held: number): { holdAnswer: (command: BrowserCommand) => Promise<void>; release: () => void } {
  const gate = Promise.withResolvers<void>()
  let looks = 0
  return {
    holdAnswer: (command) => (command.kind === 'observe' && ++looks === held ? gate.promise : Promise.resolve()),
    release: () => gate.resolve(),
  }
}

// One look of the check at `at`, sent as the test file's process sends it, marked as a check's look.
function look(run: ScriptedTest, id: number, after?: ObserveAfter): Promise<CommandResult> {
  run.process.deliver({ type: 'command', ...run.process.scope, id, app: scriptedApp, command: { kind: 'observe', locator: title, ...(after === undefined ? {} : { after }), check: true }, timeoutMs: 5000, location: at })
  return run.process.answer(id)
}

// What happens next on the parent's side once a message has arrived: its answers, its records and its stop.
function settled(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function served(result: CommandResult): { observationId: string; sessionId: string; changes: number } {
  assert.ok(result.ok && result.kind === 'observe' && result.observationId !== undefined && result.sessionId !== undefined, 'the parent served the look')
  return { observationId: result.observationId, sessionId: result.sessionId, changes: result.changes ?? 0 }
}

// The check's assertion, as `pollLocator` reports it: failed with `failure`, naming the last look the parent served.
function reported(run: ScriptedTest, failed: Failure, last: { observationId: string; sessionId: string } | undefined, attempts: number): void {
  const named = last === undefined ? {} : { observationId: last.observationId, sessionId: last.sessionId }
  run.event({ type: 'assertion.failed', testId: run.testId, attemptId: run.attemptId, session: scriptedApp, matcher: check.matcher, locator: title, expected: truncateText(check.text), actual: null, attempts, timeoutMs: 5000, durationMs: 60, location: at, ...named, check, failure: failed })
}

function finished(run: ScriptedTest, failed: Failure | undefined): void {
  run.process.deliver({ type: 'test-finished', ...run.process.scope, status: 'failed', ...(failed === undefined ? {} : { failure: failed }), assertionCount: 1, durationMs: 70 })
}

type Ended = { verdict: Failure | undefined; records: { failure: Failure; origin: string }[]; observed: readonly Failure[] }

async function ended(run: ScriptedTest, release: () => void): Promise<Ended> {
  const report = await run.report
  await run.running.settle(0)
  run.running.close()
  release()
  const records = run.events.flatMap(({ body, origin }) => (body.type === 'assertion.failed' ? [{ failure: body.failure, origin }] : []))
  const observed = report.observed ?? []
  return { verdict: withEvaluationFailures({ reported: report.failure, recorded: [], observed }), records, observed }
}

// What a check's failed look before the stop would have made it: the parent's own judgement, which must not lead.
function judgedByLook(each: Failure): boolean {
  return each.class === 'check_failed'
}

describe('a check the stop cut short, as the parent records it', () => {
  for (const { name, held } of [{ name: 'first', held: 1 }, { name: 'second', held: 2 }, { name: 'third', held: 3 }]) {
    test(`the stop answers the check's ${name} look while the page holds it: the check and the test fail with the stop`, async () => {
      const page = heldLook(held)
      const run = await scriptedTest({ fake: { holdAnswer: page.holdAnswer }, timeouts: { test: 10_000 } })
      let last: ReturnType<typeof served> | undefined
      for (let id = 1; id < held; id += 1) last = served(await look(run, id, last === undefined ? undefined : { changes: last.changes, waitMs: 0 }))
      const answer = look(run, held, last === undefined ? undefined : { changes: last.changes, waitMs: 5000 })
      await settled()
      run.running.revoke(interrupted, abortGraceMs)
      const stopped = await answer
      assert.deepEqual(stopped, { ok: false, failure: { ...interrupted, location: at } }, 'the look in flight is answered with the stop at the check\'s place')
      reported(run, stopped.ok ? interrupted : stopped.failure, last, held)
      finished(run, stopped.ok ? undefined : stopped.failure)
      const { verdict, records, observed } = await ended(run, page.release)
      assert.deepEqual(records, [{ failure: { ...interrupted, location: at }, origin: 'parent' }], 'the check is recorded as failed with the stop, as the parent\'s own record')
      assert.deepEqual(observed.filter(judgedByLook), [], 'the look before the stop is not a failure the parent saw')
      assert.deepEqual(verdict, interrupted)
    })
  }

  test("the stop refuses the check's next look: the check and the test fail with the stop", async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    const first = served(await look(run, 1))
    run.running.revoke(interrupted, abortGraceMs)
    const refused = await look(run, 2, { changes: first.changes, waitMs: 50 })
    assert.deepEqual(refused, { ok: false, failure: { ...interrupted, location: at } })
    reported(run, { ...interrupted, location: at }, first, 2)
    finished(run, { ...interrupted, location: at })
    const { verdict, records, observed } = await ended(run, () => undefined)
    assert.deepEqual(records, [{ failure: { ...interrupted, location: at }, origin: 'parent' }])
    assert.deepEqual(observed.filter(judgedByLook), [])
    assert.deepEqual(verdict, interrupted)
  })

  test('the process refuses the check\'s next look itself once told to stop: the check and the test fail with the stop', async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    const first = served(await look(run, 1))
    run.running.revoke(interrupted, abortGraceMs)
    await settled()
    // A process asked to abort refuses every later command itself and records nothing more against its test.
    const refusedHere: Failure = { ...failure('interrupted', 'This test has already ended, so Retest sent nothing to the page.'), location: at }
    reported(run, refusedHere, first, 2)
    finished(run, undefined)
    const { verdict, records, observed } = await ended(run, () => undefined)
    assert.deepEqual(records.map((record) => [record.origin, record.failure.class, record.failure.message, record.failure.location]), [['parent', 'interrupted', interrupted.message, at]])
    assert.deepEqual(observed.filter(judgedByLook), [])
    assert.deepEqual(verdict, interrupted)
  })

  test('the test runs out of time while the page holds a look, and the check sees its own time run out with the test\'s: both fail with the timeout', async () => {
    const page = heldLook(2)
    const run = await scriptedTest({ fake: { holdAnswer: page.holdAnswer }, timeouts: { test: 300 } })
    const first = served(await look(run, 1))
    const stopped = await look(run, 2, { changes: first.changes, waitMs: 5000 })
    assert.ok(!stopped.ok && stopped.failure.class === 'timeout', 'the test\'s own time answers the look')
    assert.match(stopped.failure.message, /^The test ran longer than its 300 ms budget\. It was waiting for /)
    // The check's time was the test's, so its last look came back as its deadline passed, and it judged the look before.
    const ownWords: Failure = { ...failure('check_failed', "Expected getByTestId('task-title') to have text 'Never', and it had ''. Looked 2 times in 300 ms."), location: at }
    reported(run, ownWords, first, 2)
    finished(run, ownWords)
    const report = await run.report
    const { verdict, records, observed } = await ended(run, page.release)
    assert.equal(report.timedOut, true)
    assert.equal(records.length, 1)
    assert.deepEqual([records[0]?.origin, records[0]?.failure.class, records[0]?.failure.message], ['parent', 'timeout', stopped.failure.message], 'the check is recorded as failed with the timeout')
    assert.equal(records[0]?.failure.details?.['also'], `check_failed: ${ownWords.message}`, 'and what the process said of it follows')
    assert.deepEqual(observed.filter(judgedByLook), [])
    assert.deepEqual(verdict, stopped.failure, 'the test fails with the timeout as the parent gave it')
  })
})

describe('a check that ended on its own, around a stop', () => {
  const ownWords: Failure = { ...failure('check_failed', "Expected getByTestId('task-title') to have text 'Never', and it had ''. Looked 9 times in 300 ms."), location: at }

  test('before the stop: it keeps its failure, and the stop follows', async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    const first = served(await look(run, 1))
    reported(run, ownWords, first, 9)
    await settled()
    run.running.revoke(interrupted, abortGraceMs)
    finished(run, ownWords)
    const { verdict, records } = await ended(run, () => undefined)
    assert.deepEqual(records, [{ failure: ownWords, origin: 'child' }])
    assert.deepEqual([verdict?.class, verdict?.message, verdict?.details?.['also']], ['check_failed', ownWords.message, `interrupted: ${interrupted.message}`])
  })

  test('reported just after the stop, with no look of it stopped: it keeps its failure, and the stop follows', async () => {
    const run = await scriptedTest({ timeouts: { test: 10_000 } })
    const first = served(await look(run, 1))
    run.running.revoke(interrupted, abortGraceMs)
    reported(run, ownWords, first, 9)
    finished(run, ownWords)
    const { verdict, records } = await ended(run, () => undefined)
    assert.deepEqual(records, [{ failure: ownWords, origin: 'child' }])
    assert.deepEqual([verdict?.class, verdict?.message, verdict?.details?.['also']], ['check_failed', ownWords.message, `interrupted: ${interrupted.message}`])
  })
})

// The same through a run: a real test file's process, whose check looks on the fake page until one of its looks is held,
// and the run is stopped while the page holds it. A stopped process is asked to abort and killed at once, so it rarely
// answers; here the abort and the kill wait until it has answered, at most 5 s, so that its check always reports what
// the stop did to it first, as it does when the answer to its look reaches it before the abort.
describe('a run stopped while a check looks', () => {
  const file = 'tests/stopped.retest.ts'
  const source = (options: string) => `import { expect, test } from 'retest'

test('waits for text that never comes', ${options}async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('task-title')).toHaveText('Never')
})
`

  type Stop = { held: number; timeoutMs?: number }

  async function stoppedRun(t: TestContext, { held, timeoutMs }: Stop) {
    const answered = Promise.withResolvers<void>()
    const hold = (): Promise<unknown> => Promise.race([answered.promise, delay(5000, undefined, { ref: false })])
    const aborted = new WeakSet<TestFileProcess>()
    const kill = TestFileProcess.prototype.kill
    t.mock.method(TestFileProcess.prototype, 'kill', function (this: TestFileProcess) {
      return aborted.has(this) ? hold().then(() => kill.call(this)) : kill.call(this)
    })
    const send = TestFileProcess.prototype.send
    t.mock.method(TestFileProcess.prototype, 'send', function (this: TestFileProcess, message: ParentMessage) {
      if (message.type !== 'abort') return send.call(this, message)
      aborted.add(this)
      void hold().then(() => send.call(this, message))
    })
    const verdicts: (Failure | undefined)[] = []
    const listen = TestFileProcess.prototype.listen
    t.mock.method(TestFileProcess.prototype, 'listen', function (this: TestFileProcess, listener: ((event: ProcessEvent) => void) | undefined) {
      if (listener === undefined) return listen.call(this, undefined)
      listen.call(this, (event) => {
        if (event.kind === 'message' && event.message.type === 'test-finished') {
          verdicts.push(event.message.failure)
          answered.resolve()
        }
        listener(event)
      })
    })
    const controller = new AbortController()
    let looks = 0
    let heldCommand: BrowserCommand | undefined
    const { launch, browsers } = fakeLauncher({
      onCommand: (command) => {
        if (command.kind !== 'observe' || ++looks !== held) return
        heldCommand = command
        // The look reaches the page before the stop does; a stop by the test's own time comes on its own.
        if (timeoutMs === undefined) setImmediate(() => controller.abort())
      },
      holdAnswer: (command) => (command === heldCommand ? answered.promise : Promise.resolve()),
    })
    const folder = newRunFolder()
    const result = await runFiles(
      {
        files: [file],
        rootDir: tempProject({ [file]: source(timeoutMs === undefined ? '' : `{ timeout: ${timeoutMs} }, `) }),
        apps: { kind: 'browser', browserPath: '/fake/chromium', baseUrl: 'http://127.0.0.1:4173' },
        timeouts: { ...quickTimeouts, assertion: 10_000, test: 20_000 },
        outputDir: folder,
        headless: true,
        workers: 1,
        signal: controller.signal,
      },
      [],
      launch,
    )
    const { events } = readEvents(folder)
    const [stopped] = result.files.flatMap((each) => each.tests)
    const checks = eventsOfType(events, 'assertion.failed')
    const sentLooks = browsers[0]?.commands.filter((command) => command.kind === 'observe').length
    return { result, stopped, checks, verdicts, sentLooks }
  }

  for (const { name, held } of [{ name: 'first', held: 1 }, { name: 'second', held: 2 }, { name: 'fourth', held: 4 }]) {
    test(`interrupted while the page holds the check's ${name} look: the test is interrupted, and its check says so`, async (t) => {
      const { result, stopped, checks, verdicts, sentLooks } = await stoppedRun(t, { held })
      assert.equal(sentLooks, held, 'the stop landed on the look the page held')
      assert.equal(verdicts.length, 1, 'the process answered the stop before it was killed')
      assert.deepEqual([result.exitCode, stopped?.status, stopped?.failure], [130, 'error', interrupted])
      assert.deepEqual(checks.map((each) => [each.origin, each.failure.class, each.failure.message]), [['parent', 'interrupted', interrupted.message]])
    })
  }

  test('out of time while the page holds the check\'s second look: the test fails with its timeout, and its check says so', async (t) => {
    const { result, stopped, checks, verdicts, sentLooks } = await stoppedRun(t, { held: 2, timeoutMs: 1500 })
    assert.equal(sentLooks, 2)
    assert.equal(verdicts.length, 1)
    assert.equal(result.exitCode, 1)
    assert.deepEqual([stopped?.status, stopped?.failure?.class], ['failed', 'timeout'])
    assert.match(stopped?.failure?.message ?? '', /^The test ran longer than its 1500 ms budget\. It was waiting for /)
    assert.deepEqual(checks.map((each) => [each.origin, each.failure.class, each.failure.message]), [['parent', 'timeout', stopped?.failure?.message]])
  })
})
