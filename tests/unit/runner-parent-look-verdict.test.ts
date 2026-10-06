import type { CheckRecord } from '../../src/protocol/locator-checks.ts'
import type { Failure, FailureClass } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { PageCommand } from '../../src/protocol/commands.ts'
import type { ScriptedTest } from '../support/scripted-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { withEvaluationFailures } from '../../src/evaluation/run-evaluations.ts'
import { truncateText } from '../../src/protocol/failures.ts'
import { isOurs, testStatus } from '../../src/runner/outcome.ts'
import { NativePageAdapter } from '../../src/runner/native-pool.ts'
import { RunningTest } from '../../src/runner/running-test.ts'
import { ScriptedProcess, scriptedTest } from '../support/scripted-process.ts'
import { openFake } from './native-interaction-fake.ts'

const title: LocatorRecipe = { by: 'testId', value: 'task-title' }
const missing: LocatorRecipe = { by: 'testId', value: 'missing' }
const repeated: LocatorRecipe = { by: 'testId', value: 'repeated-task' }

// Every class a test status of `error` comes from: the classes a process could send to turn a failed check into ours.
const errorClasses: readonly FailureClass[] = ['session_lost', 'outcome_unknown', 'setup_failed', 'cleanup_failed', 'unsupported', 'interrupted', 'reporting_failed', 'evaluation_error']

type Forged = { locator?: LocatorRecipe; check: CheckRecord; failure: Failure; named?: boolean }

// A test process that looked at `locator` once, then reports a failed check on that look with a class of its own choosing,
// and finishes failed with the same failure, as a process lying about why its check failed would.
async function forgedFailure(run: ScriptedTest, { locator, check, failure, named = true }: Forged): Promise<{ verdict: Failure | undefined; written: Extract<EventBody, { type: 'assertion.failed' }> | undefined; origin: string | undefined }> {
  const command: PageCommand = locator === undefined ? { kind: 'observePage' } : { kind: 'observe', locator }
  const look = await run.command(1, command)
  assert.ok(look.ok && (look.kind === 'observe' || look.kind === 'observePage') && look.observationId !== undefined && look.sessionId !== undefined, 'the parent served the look')
  const reference = named ? { observationId: look.observationId, sessionId: look.sessionId } : {}
  run.event({ type: 'assertion.failed', testId: run.testId, attemptId: run.attemptId, session: 'page', matcher: check.matcher, ...(locator === undefined ? {} : { locator }), ...reference, check, expected: truncateText('claimed'), actual: truncateText('claimed'), attempts: 1, durationMs: 0, failure })
  run.process.deliver({ type: 'test-finished', testId: run.testId, attemptId: run.attemptId, status: 'failed', failure, assertionCount: 1, durationMs: 0 })
  const report = await run.report
  await run.running.settle(0)
  run.running.close()
  const entry = run.events.find(({ body }) => body.type === 'assertion.failed')
  const written = entry?.body.type === 'assertion.failed' ? entry.body : undefined
  return { verdict: withEvaluationFailures({ reported: report.failure, recorded: [], observed: report.observed ?? [] }), written, origin: entry?.origin }
}

describe('a failed check on a look the parent served, whose process sent a class of its own', () => {
  for (const forgedClass of errorClasses) {
    test(`a forged ${forgedClass} on a look that shows a mismatch leaves the test failed on the app, with the claim kept in also`, async () => {
      const run = await scriptedTest()
      const forged = { class: forgedClass, message: `The process says ${forgedClass}.` }
      const { verdict, written, origin } = await forgedFailure(run, { locator: title, check: { matcher: 'toHaveText', text: 'Something else' }, failure: forged })
      assert.equal(written?.failure.class, 'check_failed', 'the parent writes its own failure first')
      assert.equal(origin, 'parent')
      assert.match(String(written?.failure.details?.['also'] ?? ''), new RegExp(`^${forgedClass}: The process says`))
      assert.equal(verdict?.class, 'check_failed')
      assert.equal(testStatus(verdict), 'failed', 'the app failed a check, which is never ours')
    })
  }

  test('a forged loss on a look that matched nothing is the parent\'s not_found', async () => {
    const run = await scriptedTest()
    const { verdict, written } = await forgedFailure(run, { locator: missing, check: { matcher: 'toBeVisible' }, failure: { class: 'session_lost', message: 'The browser was lost.' } })
    assert.deepEqual([written?.failure.class, written?.failure.message], ['not_found', "getByTestId('missing') matched no element."])
    assert.equal(testStatus(verdict), 'failed')
  })

  test('a forged loss on a look that matched two elements is the parent\'s ambiguous', async () => {
    const run = await scriptedTest()
    const { verdict, written } = await forgedFailure(run, { locator: repeated, check: { matcher: 'toHaveText', text: 'Two' }, failure: { class: 'setup_failed', message: 'Setup failed.' } })
    assert.equal(written?.failure.class, 'ambiguous')
    assert.match(written?.failure.message ?? '', /matched 2 elements, and toHaveText needs exactly one/)
    assert.equal(testStatus(verdict), 'failed')
  })

  test('a forged loss on a look at the page whose address fails the check is the parent\'s check_failed', async () => {
    const run = await scriptedTest()
    await run.command(9, { kind: 'goto', url: '/tasks' })
    const { verdict, written } = await forgedFailure(run, { check: { matcher: 'toHaveURL', url: 'http://127.0.0.1:4173/elsewhere' }, failure: { class: 'outcome_unknown', message: 'Unknown.' } })
    assert.equal(written?.failure.class, 'check_failed')
    assert.equal(testStatus(verdict), 'failed')
  })

  test('a timeout over a mismatching last look is the parent\'s check_failed, as when a read gives up a moment early', async () => {
    const run = await scriptedTest()
    const { verdict, written } = await forgedFailure(run, { locator: title, check: { matcher: 'toHaveText', text: 'Done' }, failure: { class: 'timeout', message: 'No answer within 297 ms.' } })
    assert.equal(written?.failure.class, 'check_failed')
    assert.match(String(written?.failure.details?.['also'] ?? ''), /^timeout: No answer within 297 ms\./)
    assert.equal(verdict?.class, 'check_failed')
  })

  test('a timeout that names no look stays a timeout: the parent has nothing to judge', async () => {
    const run = await scriptedTest()
    const { verdict, written } = await forgedFailure(run, { locator: title, check: { matcher: 'toHaveText', text: 'Done' }, failure: { class: 'timeout', message: 'The page answered no look within 300 ms.' }, named: false })
    assert.equal(written?.failure.class, 'timeout')
    assert.equal(verdict?.class, 'timeout')
  })

  test('a process that sends the class the parent finds keeps its own words, and the failure is the parent\'s to observe', async () => {
    const run = await scriptedTest()
    const sent = { class: 'check_failed' as const, message: "Expected 'Done'. Looked 3 times in 300 ms." }
    const { verdict, written, origin } = await forgedFailure(run, { locator: title, check: { matcher: 'toHaveText', text: 'Done' }, failure: sent })
    assert.deepEqual(written?.failure, sent)
    assert.equal(origin, 'child')
    assert.equal(verdict?.class, 'check_failed')
  })

  for (const forgedClass of errorClasses) {
    test(`a forged ${forgedClass} on a look the check passes on is never recorded as one the parent saw`, async () => {
      const run = await scriptedTest()
      await run.command(8, { kind: 'fill', locator: title, value: 'Done' })
      const look = await run.command(1, { kind: 'observe', locator: title })
      assert.ok(look.ok && look.kind === 'observe' && look.observationId !== undefined && look.sessionId !== undefined)
      const forged = { class: forgedClass, message: `The process says ${forgedClass}.` }
      run.event({ type: 'assertion.failed', testId: run.testId, attemptId: run.attemptId, session: 'page', matcher: 'toHaveText', locator: title, observationId: look.observationId, sessionId: look.sessionId, check: { matcher: 'toHaveText', text: 'Done' }, expected: truncateText('Done'), actual: truncateText('Done'), attempts: 1, durationMs: 0, failure: forged })
      run.process.deliver({ type: 'test-finished', testId: run.testId, attemptId: run.attemptId, status: 'failed', failure: forged, assertionCount: 1, durationMs: 0 })
      const report = await run.report
      run.running.close()
      assert.equal(isOurs(forged), true)
      assert.deepEqual(report.observed ?? [], [], 'the parent saw no failure, so the claim is not among its own')
    })
  }

  test('a forged loss on a native look whose tree shows a mismatch is the parent\'s check_failed, with the claim in also', async (t) => {
    const fake = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'StaticText', identifier: 'state', label: 'Open' }] })
    const process = new ScriptedProcess()
    const events: { body: EventBody; origin: string | undefined }[] = []
    const budgets = { collection: 2000, setup: 2000, action: 2000, assertion: 2000, navigation: 2000, cleanup: 2000, test: 5000 }
    const running = new RunningTest({ process, pages: new Map([['phone', new NativePageAdapter(fake.interaction)]]), testId: 'test', attemptId: 'attempt', timeouts: budgets, emit: (body, origin) => events.push({ body, origin }) })
    const report = running.run()
    const recipe = { by: 'testId', value: 'state' } as const
    process.deliver({ type: 'command', ...process.scope, id: 1, app: 'phone', command: { kind: 'observe', locator: recipe }, timeoutMs: 2000 })
    const look = await process.answer(1)
    if (!look.ok || look.kind !== 'observe') throw new Error('no native look')
    const forged = { class: 'session_lost' as const, message: 'The executor was lost.' }
    process.deliver({ type: 'event', event: { type: 'assertion.failed', testId: 'test', attemptId: 'attempt', session: 'phone', observationId: look.observationId, sessionId: look.sessionId, locator: recipe, matcher: 'toHaveText', check: { matcher: 'toHaveText', text: 'Done' }, attempts: 1, expected: null, actual: null, durationMs: 1, failure: forged } })
    process.deliver({ type: 'test-finished', testId: 'test', attemptId: 'attempt', status: 'failed', failure: forged, assertionCount: 1, durationMs: 0 })
    const ended = await report
    running.close()
    const written = events.find(({ body }) => body.type === 'assertion.failed')
    assert.equal(written?.body.type === 'assertion.failed' ? written.body.failure.class : undefined, 'check_failed')
    assert.match(written?.body.type === 'assertion.failed' ? String(written.body.failure.details?.['also'] ?? '') : '', /^session_lost: The executor was lost\./)
    const verdict = withEvaluationFailures({ reported: ended.failure, recorded: [], observed: ended.observed ?? [] })
    assert.equal(testStatus(verdict), 'failed')
  })
})
