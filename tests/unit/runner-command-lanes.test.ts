import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { EvaluationRequests } from '../../src/evaluation/attempt.ts'
import type { CommandResult, PageCommand } from '../../src/protocol/commands.ts'
import type { EvaluationAnswer, EvaluationCall } from '../../src/protocol/evaluation.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ParentMessage } from '../../src/protocol/messages.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { truncateText } from '../../src/protocol/failures.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { rebuildRecordedResult, rebuildResult } from '../../src/store/rebuild-result.ts'
import { FakeBrowser } from '../support/fake-browser.ts'
import { eventsOfType, quickTimeouts, runSupportFiles, testNamed } from '../support/run-harness.ts'
import { ScriptedProcess, scriptedTest } from '../support/scripted-process.ts'

const save: LocatorRecipe = { by: 'testId', value: 'save-task' }
const title: LocatorRecipe = { by: 'testId', value: 'task-title' }

test('an accepted failed value assertion stays failed when the test process finishes with a pass', async () => {
  const run = await scriptedTest()
  run.event({ type: 'assertion.failed', testId: run.testId, attemptId: run.attemptId, matcher: 'toBe', expected: truncateText('2'), actual: truncateText('1'), attempts: 1, durationMs: 0, failure: { class: 'check_failed', message: 'The values differ.' } })
  const report = await run.finish()
  assert.deepEqual(report.observed?.map((entry) => entry.class), ['check_failed'])
  assert.equal(report.failure, undefined, 'the claimed pass cannot remove the separately retained failure')
})

test('a failed assertion with a parent observation stays failed even when the child supplied another failure class', async () => {
  const run = await scriptedTest()
  const look = await run.command(1, { kind: 'observe', locator: title })
  assert.ok(look.ok && look.kind === 'observe' && look.observationId !== undefined && look.sessionId !== undefined, 'the parent served the look and named its session')
  run.event({ type: 'assertion.failed', testId: run.testId, attemptId: run.attemptId, matcher: 'toHaveText', locator: title, observationId: look.observationId, sessionId: look.sessionId, check: { matcher: 'toHaveText', text: 'A different title' }, expected: truncateText('A different title'), actual: truncateText('ignored'), attempts: 1, durationMs: 0, failure: { class: 'usage', message: 'The child calls this usage.' } })
  const report = await run.finish()
  // The parent's own rule fails on the look, so its check_failed leads and the class the child supplied follows.
  assert.deepEqual(report.observed?.map((entry) => entry.class), ['check_failed'])
  assert.match(String(report.observed?.[0]?.details?.['also'] ?? ''), /^usage: The child calls this usage\.$/)
})

test('an old attempt cannot send a command to the next attempt or name its identity in the failure', async () => {
  const seen: string[] = []
  const run = await scriptedTest({ attemptId: 'next-attempt', fake: { onCommand: (command) => seen.push(command.kind) } })
  run.process.deliver({ type: 'command', testId: 'another-run-secret-test', attemptId: 'previous-attempt', id: 1, app: 'page', command: { kind: 'click', locator: save }, timeoutMs: 500 })
  const report = await run.report
  assert.equal(report.failure?.class, 'test_error')
  assert.match(report.failure?.message ?? '', /inactive test attempt/)
  assert.doesNotMatch(JSON.stringify({ report, events: run.events }), /another-run-secret-test|previous-attempt/)
  assert.deepEqual(seen, [])
  run.running.close()
})

test('a delayed evaluation from an old attempt never captures the next attempt or reaches its judge', async () => {
  const run = await evaluatingTest([])
  run.process.deliver({ type: 'evaluate', testId: 'another-run-secret-test', attemptId: 'previous-attempt', id: 1, call: screenshotCheck })
  const report = await run.report
  assert.equal(report.failure?.class, 'test_error')
  assert.equal(run.evaluations.calls.length, 0)
  assert.deepEqual(run.page.seen, [])
  assert.doesNotMatch(JSON.stringify({ report, events: run.events }), /another-run-secret-test|previous-attempt/)
  run.running.close()
})

for (const moment of ['run.finished', 'onRunEnd'] as const) {
  test(`a reporter failure at ${moment} is in the exact result rebuilt from events`, async () => {
    const record = await runSupportFiles(['output.retest.ts'], { reporters: [{
      name: 'broken-final-reporter',
      onEvent: (event) => { if (moment === 'run.finished' && event.type === 'run.finished') throw new Error('Final event failed.') },
      onRunEnd: () => { if (moment === 'onRunEnd') throw new Error('Final summary failed.') },
    }] })
    assert.equal(record.result.exitCode, 2)
    assert.equal(record.result.failure?.class, 'reporting_failed')
    assert.deepEqual(rebuildRecordedResult(record.events), record.written)
    assert.equal(record.events.at(-1)?.type, 'run.outcome')
    assert.equal(rebuildResult(record.events).complete, false, 'a missing result file still cannot be reconstructed as a pass')
  })
}

test('a reporter cannot change parent verdicts by mutating its result or event objects', async () => {
  const record = await runSupportFiles(['failing.retest.ts'], { reporters: [{
    name: 'mutating-reporter',
    onEvent: (event) => {
      if (event.type === 'test.finished') { event.status = 'passed'; delete event.failure }
    },
    onRunEnd: (result) => {
      result.status = 'passed'
      result.exitCode = 0
      for (const test of result.files.flatMap((file) => file.tests)) { test.status = 'passed'; delete test.failure }
    },
  }] })
  assert.equal(record.result.exitCode, 1)
  assert.ok(record.result.files.some((file) => file.tests.some((test) => test.status === 'failed')))
  assert.deepEqual(rebuildRecordedResult(record.events), record.written)
})

/** A page whose answers to commands of `held` kinds wait until the test lets them go, so a command stays in flight. */
function heldPage(held: readonly BrowserCommand['kind'][]): { seen: BrowserCommand['kind'][]; release: () => void; options: { onCommand: (command: BrowserCommand) => void; holdAnswer: (command: BrowserCommand) => Promise<void> } } {
  const seen: BrowserCommand['kind'][] = []
  const gate = Promise.withResolvers<void>()
  return {
    seen,
    release: () => gate.resolve(),
    options: { onCommand: (command) => seen.push(command.kind), holdAnswer: (command) => (held.includes(command.kind) ? gate.promise : Promise.resolve()) },
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let turn = 0; turn < 200 && !condition(); turn++) await nextTurn()
  assert.ok(condition(), 'the condition came true')
}

function refusal(result: CommandResult): { class: string; message: string } | undefined {
  return result.ok ? undefined : { class: result.failure.class, message: result.failure.message }
}

describe('the parent sends one command at a time to each app, as the test file’s own lanes do', () => {
  test('an action while an action runs on the same app is refused, never reaches the page, and fails the test whatever the process claims', async () => {
    const page = heldPage(['click'])
    const run = await scriptedTest({ fake: page.options })
    const first = run.command(1, { kind: 'click', locator: save })
    await until(() => page.seen.length === 1)
    const second = await run.command(2, { kind: 'fill', locator: title, value: 'Two' })
    assert.deepEqual(refusal(second), {
      class: 'concurrent_commands',
      message: `The test file's process sent getByTestId('task-title').fill() to page while getByTestId('save-task').click() was still running there, so Retest did not send it. Retest sends one command at a time to each app, and no action while a check looks at it.`,
    })
    assert.deepEqual(page.seen, ['click'], 'the refused command never reached the page')
    page.release()
    assert.equal((await first).ok, true, 'the command already running goes on')
    assert.equal((await run.command(3, { kind: 'fill', locator: title, value: 'Two' })).ok, true, 'once it is over, the next action goes')
    const report = await run.finish()
    assert.equal(report.failure, undefined, 'the process claimed a pass')
    assert.deepEqual(report.observed?.map((each) => each.class), ['concurrent_commands'], 'the parent recorded its refusal, which fails the test')
    const events = run.events.map(({ body }) => stamped(body))
    assert.deepEqual(eventsOfType(events, 'action.completed').map((event) => event.command), ['click', 'fill'])
    assert.deepEqual(
      eventsOfType(events, 'action.failed').map((event) => [event.command, event.sessionId, event.durationMs, event.failure.class]),
      [['fill', 'attempt1:page', 0, 'concurrent_commands']],
      'the refused action is written as its own failed event',
    )
  })

  test('an assertion naming an app the test does not have is a protocol violation, and no session is made up for it', async () => {
    const run = await scriptedTest()
    run.event({ type: 'assertion.failed', testId: run.testId, attemptId: run.attemptId, session: 'phone', matcher: 'toBeVisible', locator: save, check: { matcher: 'toBeVisible' }, expected: null, actual: null, attempts: 1, durationMs: 1, failure: { class: 'check_failed', message: 'It did not show.' } })
    const report = await run.report
    assert.equal(report.failure?.class, 'test_error')
    assert.match(report.failure?.message ?? '', /sent assertion\.failed for the app "phone", which this test does not use/)
    assert.deepEqual(run.events.filter(({ body }) => body.type === 'assertion.failed'), [], 'no assertion is written')
  })

  test('a look while an action runs is refused, and an action while a look runs is refused', async () => {
    for (const [held, next] of [
      ['click', { kind: 'observe', locator: title }],
      ['observe', { kind: 'click', locator: save }],
    ] as const satisfies readonly (readonly [BrowserCommand['kind'], PageCommand])[]) {
      const page = heldPage([held])
      const run = await scriptedTest({ fake: page.options })
      const first = run.command(1, held === 'click' ? { kind: 'click', locator: save } : { kind: 'observe', locator: title })
      await until(() => page.seen.length === 1)
      assert.equal(refusal(await run.command(2, next))?.class, 'concurrent_commands', `${next.kind} while ${held} runs`)
      page.release()
      await first
      const report = await run.finish()
      assert.deepEqual(report.observed?.map((each) => each.class), ['concurrent_commands'])
      assert.deepEqual(page.seen, [held])
    }
  })

  test('looks at one app may overlap', async () => {
    const page = heldPage(['observe'])
    const run = await scriptedTest({ fake: page.options })
    const first = run.command(1, { kind: 'observe', locator: title })
    await until(() => page.seen.length === 1)
    const second = run.command(2, { kind: 'observePage' })
    await until(() => page.seen.length === 2)
    page.release()
    assert.deepEqual([(await first).ok, (await second).ok], [true, true])
    const report = await run.finish()
    assert.equal(report.observed, undefined)
  })

  test('two apps each take their own action at once', async () => {
    const page = heldPage(['click'])
    const browser = new FakeBrowser(page.options, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
    const owner = await browser.newPage({ baseUrl: 'http://127.0.0.1:4173' }, 1000)
    const member = await browser.newPage({ baseUrl: 'http://127.0.0.1:4173' }, 1000)
    const process = new ScriptedProcess()
    const events: EventBody[] = []
    const running = new RunningTest({
      process,
      pages: new Map([
        ['owner', owner],
        ['member', member],
      ]),
      testId: 'tests/a.retest.ts > shares',
      attemptId: 'attempt1',
      timeouts: quickTimeouts,
      emit: (body) => events.push(body),
    })
    const report = running.run()
    process.deliver({ type: 'command', ...process.scope, id: 1, app: 'owner', command: { kind: 'click', locator: save }, timeoutMs: 500 })
    process.deliver({ type: 'command', ...process.scope, id: 2, app: 'member', command: { kind: 'click', locator: save }, timeoutMs: 500 })
    await until(() => page.seen.length === 2)
    page.release()
    assert.deepEqual([(await process.answer(1)).ok, (await process.answer(2)).ok], [true, true])
    process.deliver({ type: 'test-finished', testId: 'tests/a.retest.ts > shares', attemptId: 'attempt1', status: 'passed', assertionCount: 0, durationMs: 0 })
    assert.equal((await report).observed, undefined)
    await running.settle(0)
    running.close()
    assert.deepEqual(
      events.flatMap((event) => (event.type === 'action.completed' ? [[event.session, event.sessionId]] : [])),
      [
        ['owner', 'attempt1:owner'],
        ['member', 'attempt1:member'],
      ],
    )
  })

  test('a command sent again under the id of one still running is a protocol violation', async () => {
    const page = heldPage(['click'])
    const run = await scriptedTest({ fake: page.options })
    void run.command(1, { kind: 'click', locator: save })
    await until(() => page.seen.length === 1)
    run.process.deliver({ type: 'command', ...run.process.scope, id: 1, app: 'page', command: { kind: 'observe', locator: title }, timeoutMs: 500 })
    const report = await run.report
    assert.equal(report.failure?.class, 'test_error')
    assert.match(report.failure?.message ?? '', /sent command 1 again while the first was still running/)
    page.release()
  })

  test('an evaluation cannot reuse an active evaluation id to release its app lane early', async () => {
    const run = await evaluatingTest([])
    run.process.deliver({ type: 'evaluate', ...run.process.scope, id: 1, call: screenshotCheck })
    run.process.deliver({ type: 'evaluate', ...run.process.scope, id: 1, call: { criteria: [{ id: 'text', requirement: 'Text is present.' }], evidence: [{ kind: 'text', text: 'Present' }], mode: 'required' } })
    assert.equal((await run.report).failure?.class, 'test_error')
    assert.equal(run.evaluations.calls.length, 1)
    run.evaluations.release()
    run.running.close()
  })
})

test('an assertion on one app naming a look another app’s session served is refused by the judge', async () => {
  const browser = new FakeBrowser({}, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
  const pages = new Map([
    ['owner', await browser.newPage({ baseUrl: 'http://127.0.0.1:4173' }, 1000)],
    ['member', await browser.newPage({ baseUrl: 'http://127.0.0.1:4173' }, 1000)],
  ])
  const process = new ScriptedProcess()
  const events: EventBody[] = []
  const running = new RunningTest({ process, pages, testId: 'tests/a.retest.ts > shares', attemptId: 'attempt1', timeouts: quickTimeouts, emit: (body) => events.push(body) })
  const report = running.run()
  process.deliver({ type: 'command', ...process.scope, id: 1, app: 'owner', command: { kind: 'observe', locator: title }, timeoutMs: 500 })
  const look = await process.answer(1)
  assert.ok(look.ok && look.kind === 'observe' && look.sessionId === 'attempt1:owner')
  process.deliver({
    type: 'event',
    event: { type: 'assertion.passed', testId: 'tests/a.retest.ts > shares', attemptId: 'attempt1', session: 'member', matcher: 'toBeVisible', locator: title, check: { matcher: 'toBeVisible' }, observationId: look.observationId, sessionId: look.sessionId, expected: null, actual: null, attempts: 1, durationMs: 1 },
  })
  const ended = await report
  assert.equal(ended.failure?.class, 'test_error')
  assert.match(ended.failure?.message ?? '', /named o1, a look at getByTestId\('task-title'\) on owner, for an assertion on getByTestId\('task-title'\) on member/)
  assert.deepEqual(events.filter((event) => event.type === 'assertion.passed'), [])
  running.close()
})

/** AI checks whose answers wait until the test lets them go, so a check stays in flight. */
class HeldEvaluations implements EvaluationRequests {
  readonly calls: EvaluationCall[] = []
  readonly #gate = Promise.withResolvers<void>()

  request(call: EvaluationCall): Promise<EvaluationAnswer> {
    this.calls.push(call)
    return this.#gate.promise.then((): EvaluationAnswer => ({ checkId: `evaluation-${this.calls.length}`, mode: call.mode, verdict: 'pass', criteria: [] }))
  }

  cancel(): void {}

  release(): void {
    this.#gate.resolve()
  }
}

const screenshotCheck: EvaluationCall = { criteria: [{ id: 'shown', requirement: 'The task shows.' }], evidence: [{ kind: 'screenshot' }], mode: 'required' }

/** One test body on one fake page whose process the test plays, with AI checks it holds. */
async function evaluatingTest(held: readonly BrowserCommand['kind'][]): Promise<{ process: ScriptedProcess; running: RunningTest; evaluations: HeldEvaluations; page: ReturnType<typeof heldPage>; events: EventBody[]; report: Promise<Awaited<ReturnType<RunningTest['run']>>> }> {
  const page = heldPage(held)
  const browser = new FakeBrowser(page.options, { executablePath: '/fake/chromium', logFile: '/dev/null', headless: true })
  const opened = await browser.newPage({ baseUrl: 'http://127.0.0.1:4173' }, 1000)
  const process = new ScriptedProcess()
  const evaluations = new HeldEvaluations()
  const events: EventBody[] = []
  const running = new RunningTest({ process, pages: new Map([['page', opened]]), testId: 'tests/a.retest.ts > judges', attemptId: 'attempt1', timeouts: quickTimeouts, emit: (body) => events.push(body), evaluations })
  return { process, running, evaluations, page, events, report: running.run() }
}

function evaluationAnswer(sent: readonly ParentMessage[], id: number): EvaluationAnswer | undefined {
  const message = sent.find((each) => each.type === 'evaluation-result' && each.id === id)
  return message?.type === 'evaluation-result' ? message.answer : undefined
}

describe('an AI check that captures an app holds that app, as the test file’s own lanes do', () => {
  async function finish(run: Awaited<ReturnType<typeof evaluatingTest>>): Promise<Awaited<ReturnType<RunningTest['run']>>> {
    run.process.deliver({ type: 'test-finished', testId: 'tests/a.retest.ts > judges', attemptId: 'attempt1', status: 'passed', assertionCount: 1, durationMs: 0 })
    const report = await run.report
    await run.running.settle(0)
    run.running.close()
    return report
  }

  test('an action on the app while the check runs is refused, written as failed, and goes once the check has answered', async () => {
    const run = await evaluatingTest([])
    run.process.deliver({ type: 'evaluate', ...run.process.scope, id: 1, call: screenshotCheck })
    run.process.deliver({ type: 'command', ...run.process.scope, id: 2, app: 'page', command: { kind: 'click', locator: save }, timeoutMs: 500 })
    const refused = await run.process.answer(2)
    assert.equal(refusal(refused)?.class, 'concurrent_commands')
    assert.match(refusal(refused)?.message ?? '', /sent getByTestId\('save-task'\)\.click\(\) to page while test\.evaluate\(\) was still running there/)
    assert.deepEqual(run.page.seen, [], 'the click never reached the page')
    run.evaluations.release()
    await until(() => evaluationAnswer(run.process.sent, 1) !== undefined)
    assert.equal(evaluationAnswer(run.process.sent, 1)?.verdict, 'pass')
    run.process.deliver({ type: 'command', ...run.process.scope, id: 3, app: 'page', command: { kind: 'click', locator: save }, timeoutMs: 500 })
    assert.equal((await run.process.answer(3)).ok, true, 'once the check answered, the action goes')
    const report = await finish(run)
    assert.deepEqual(report.observed?.map((each) => each.class), ['concurrent_commands'])
    assert.deepEqual(run.events.flatMap((event) => (event.type === 'action.failed' ? [event.failure.class] : [])), ['concurrent_commands'])
  })

  test('a check that captures an app while an action runs there is refused before it captures anything', async () => {
    const run = await evaluatingTest(['click'])
    run.process.deliver({ type: 'command', ...run.process.scope, id: 1, app: 'page', command: { kind: 'click', locator: save }, timeoutMs: 500 })
    await until(() => run.page.seen.length === 1)
    run.process.deliver({ type: 'evaluate', ...run.process.scope, id: 2, call: screenshotCheck })
    await until(() => evaluationAnswer(run.process.sent, 2) !== undefined)
    const answer = evaluationAnswer(run.process.sent, 2)
    assert.equal(answer?.failure?.class, 'concurrent_commands')
    assert.match(answer?.failure?.message ?? '', /asked for test\.evaluate\(\) on page while getByTestId\('save-task'\)\.click\(\) was still running there, so Retest did not run it/)
    assert.equal(run.evaluations.calls.length, 0, 'the judge was never asked')
    run.page.release()
    await run.process.answer(1)
    const report = await finish(run)
    assert.deepEqual(report.observed?.map((each) => each.class), ['concurrent_commands'])
  })

  test('a look may overlap the check, and a check of text alone holds no app', async () => {
    const run = await evaluatingTest([])
    run.process.deliver({ type: 'evaluate', ...run.process.scope, id: 1, call: screenshotCheck })
    run.process.deliver({ type: 'command', ...run.process.scope, id: 2, app: 'page', command: { kind: 'observe', locator: save }, timeoutMs: 500 })
    assert.equal((await run.process.answer(2)).ok, true, 'a look during the check is served')
    run.process.deliver({ type: 'evaluate', ...run.process.scope, id: 3, call: { criteria: [{ id: 'polite', requirement: 'The reply is polite.' }], evidence: [{ kind: 'text', text: 'Thank you.' }], mode: 'required' } })
    run.evaluations.release()
    await until(() => evaluationAnswer(run.process.sent, 1) !== undefined && evaluationAnswer(run.process.sent, 3) !== undefined)
    const text = await evaluatingTest([])
    text.process.deliver({ type: 'evaluate', ...text.process.scope, id: 1, call: { criteria: [{ id: 'polite', requirement: 'The reply is polite.' }], evidence: [{ kind: 'text', text: 'Thank you.' }], mode: 'required' } })
    text.process.deliver({ type: 'command', ...text.process.scope, id: 2, app: 'page', command: { kind: 'click', locator: save }, timeoutMs: 500 })
    assert.equal((await text.process.answer(2)).ok, true, 'an action goes while a check of text alone runs')
    text.evaluations.release()
    await until(() => evaluationAnswer(text.process.sent, 1) !== undefined)
    assert.equal((await finish(run)).observed, undefined)
    assert.equal((await finish(text)).observed, undefined)
  })
})

describe('a real test process that sends two clicks at once behind its runtime’s back', async () => {
  const clicks: number[] = []
  const record = await runSupportFiles(['forged-concurrent.retest.ts'], {
    fake: {
      onCommand: (command) => {
        if (command.kind === 'click') clicks.push(1)
      },
      holdAnswer: (command) => (command.kind === 'click' ? new Promise((resolve) => setTimeout(resolve, 150)) : Promise.resolve()),
    },
  })

  test('is failed by the parent’s refusal, and the page took only the first click', () => {
    const result = testNamed(record.result, 'sends two clicks at once behind the runtime’s back')
    assert.deepEqual([result.status, result.failure?.class], ['failed', 'concurrent_commands'])
    assert.equal(clicks.length, 1, 'the second click never reached the page')
    assert.deepEqual(eventsOfType(record.events, 'action.completed').map((event) => event.command), ['click'])
    assert.deepEqual(eventsOfType(record.events, 'assertion.passed').map((event) => [event.matcher, event.judgedBy]), [['toBe', 'child']])
    const printed = record.output.map((chunk) => chunk.text).join('')
    assert.match(printed, /answers \[true,false\]/, 'the process heard the first click answered and the second refused')
    assert.equal(record.result.exitCode, 1)
  })
})

// Events as the parent emitted them, stamped as the log would, so the run harness's helpers can read them.
function stamped(body: EventBody): Parameters<typeof eventsOfType>[0][number] {
  return { schemaVersion: 1, runId: 'run-1', sequence: 0, time: '2026-10-04T09:15:00.000Z', elapsedMs: 0, origin: 'parent', ...body }
}
