import type { EventBody } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { PlannedTest } from '../../src/runner/plan.ts'
import type { CleanupContext, HostPreparation, PrepareOptions, PreparationContext, TestPreparation } from '../../src/runner/preparation.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  declaredBackend,
  preparationsScopeProblem,
  preparationsShapeProblem,
  prepareAttempt,
  readPreparations,
  testPreparations,
} from '../../src/runner/preparation.ts'
import { Redactor } from '../../src/runner/redactor.ts'

const never = new Promise<void>(() => undefined)
const scope = { testId: 'tests/a.retest.ts > shares a record', attemptId: 'k3v9q0x2mb', file: 'tests/a.retest.ts', owner: 'agent-1' }

type Run = { options: PrepareOptions; events: EventBody[] }

/** The options a preparation run takes, with every event kept and the run's secret known to the redactor. */
function run(preparations: TestPreparation[], extra: Partial<PrepareOptions> = {}): Run {
  const events: EventBody[] = []
  const redactor = new Redactor()
  redactor.learn('password', 'correct horse battery staple')
  const options: PrepareOptions = {
    preparations,
    scope,
    timeouts: { setup: 1000, cleanup: 1000 },
    stopped: never,
    interruption: () => undefined,
    emit: (body) => void events.push(body),
    redact: (text) => redactor.redact(text),
    ...extra,
  }
  return { options, events }
}

function entry(key: string, preparation: HostPreparation, apps: readonly string[] = ['owner', 'member']): TestPreparation {
  return { key, preparation, apps }
}

describe('prepareAttempt', () => {
  test('a preparation that prepares is recorded, redacted, and its cleanup is told what it prepared', async () => {
    const told: PreparationContext[] = []
    const cleaned: CleanupContext[] = []
    const { options, events } = run([
      entry('tests/a.retest.ts', {
        prepare: async (context) => {
          told.push(context)
          return { status: 'prepared', recipe: 'shared-records@2', seed: 42, receipt: 'seed-op-correct horse battery staple', metadata: { accounts: 2, reset: true } }
        },
        cleanup: async (context) => void cleaned.push(context),
      }),
    ])
    const prepared = await prepareAttempt(options)
    assert.equal(prepared.failure, undefined)
    assert.deepEqual(prepared.records.map(({ durationMs: _durationMs, ...record }) => record), [
      {
        key: 'tests/a.retest.ts',
        apps: ['owner', 'member'],
        backendData: 'prepared',
        outcome: 'prepared',
        recipe: 'shared-records@2',
        seed: 42,
        receipt: 'seed-op-{{password}}',
        metadata: { accounts: 2, reset: true },
      },
    ])
    assert.deepEqual(told.map(({ signal: _signal, ...context }) => context), [{ key: 'tests/a.retest.ts', ...scope, apps: ['owner', 'member'], timeoutMs: 1000 }])
    assert.ok(Object.isFrozen(told[0]), 'the context is the parent’s, and frozen')
    const cleanup = await prepared.cleanUp(false)
    assert.deepEqual(cleanup.failures, [])
    assert.deepEqual(cleaned.map((context) => [context.preparation, context.prepared?.recipe, context.failed]), [['prepared', 'shared-records@2', false]])
    assert.deepEqual(events.map((event) => event.type), ['preparation.finished', 'cleanup.finished'])
  })

  test('a preparation that says it failed, or throws, ends the attempt with setup_failed, and the ones after it do not run', async () => {
    const order: string[] = []
    const { options } = run([
      entry('tests/a.retest.ts', { prepare: async () => ({ status: 'prepared', recipe: 'accounts@1' }), cleanup: async () => void order.push('file cleanup') }),
      entry('tests/a.retest.ts > shares a record', { prepare: async () => ({ status: 'failed', reason: 'the fixture service refused the seed' }), cleanup: async () => void order.push('test cleanup') }),
      entry('third', { prepare: async () => assert.fail('never runs'), cleanup: async () => void order.push('never cleaned') }),
    ])
    const prepared = await prepareAttempt(options)
    assert.equal(prepared.failure?.class, 'setup_failed')
    assert.equal(prepared.failure?.message, 'The host\'s preparation for "tests/a.retest.ts > shares a record" failed, so the test did not act on any app: it said: the fixture service refused the seed.')
    assert.deepEqual(prepared.failure?.details, { preparation: 'tests/a.retest.ts > shares a record', outcome: 'failed' })
    assert.deepEqual(prepared.records.map((record) => record.outcome), ['prepared', 'failed', 'not_run'])
    await prepared.cleanUp(true)
    assert.deepEqual(order, ['test cleanup', 'file cleanup'], 'every cleanup whose preparation started runs, in reverse order')

    const thrown = await prepareAttempt(run([entry('k', { prepare: () => Promise.reject(new Error('no database at correct horse battery staple')) })]).options)
    assert.equal(thrown.records[0]?.outcome, 'failed')
    assert.equal(thrown.records[0]?.reason, 'it threw: no database at {{password}}', 'the reason is redacted')
    assert.equal(thrown.failure?.class, 'setup_failed')
  })

  test('a preparation that does not answer in time is uncertain, and its signal is aborted', async () => {
    let signal: AbortSignal | undefined
    const { options } = run([
      entry('k', {
        timeoutMs: 30,
        prepare: (context) => {
          signal = context.signal
          return new Promise(() => undefined)
        },
      }),
    ])
    const prepared = await prepareAttempt(options)
    assert.equal(prepared.records[0]?.outcome, 'uncertain')
    assert.equal(prepared.failure?.message, 'The host\'s preparation for "k" could not be confirmed, so the test did not act on any app: it did not answer within 30 ms, and what it started may still be running.')
    assert.equal(signal?.aborted, true)
    assert.equal(signal?.reason instanceof DOMException ? signal.reason.name : '', 'TimeoutError')
  })

  test('an answer Retest cannot read leaves the state uncertain, whatever it claims', async () => {
    const answers: unknown[] = [
      'prepared',
      { status: 'done' },
      { status: 'prepared' },
      { status: 'prepared', recipe: 'x'.repeat(501) },
      { status: 'prepared', recipe: 'r', dump: 'rows' },
      { status: 'prepared', recipe: 'r', metadata: { nested: { a: 1 } } },
      { status: 'prepared', recipe: 'r', metadata: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`k${index}`, index])) },
      { status: 'uncertain' },
    ]
    for (const answer of answers) {
      // A host written in JavaScript may answer anything, so the preparation comes in as a JavaScript host gives it.
      const host = readPreparations({ k: { prepare: () => Promise.resolve(answer) } })?.['k']
      assert.ok(host !== undefined)
      const prepared = await prepareAttempt(run([entry('k', host)]).options)
      assert.equal(prepared.records[0]?.outcome, 'uncertain', JSON.stringify(answer))
      assert.equal(prepared.failure?.class, 'setup_failed', JSON.stringify(answer))
    }
    const said = await prepareAttempt(run([entry('k', { prepare: async () => ({ status: 'uncertain', reason: 'the reset was sent, no answer came' }) })]).options)
    assert.equal(said.records[0]?.reason, 'it said: the reset was sent, no answer came')
  })

  test('a run stopped while it prepares cancels the preparation with the run’s interruption, and its cleanup still runs', async () => {
    const stop = Promise.withResolvers<void>()
    const interruption: Failure = { class: 'interrupted', message: 'The host is shutting down, so it stopped the run.' }
    let stopped = false
    let interrupted = false
    void stop.promise.then(() => void (interrupted = true))
    const cleaned: CleanupContext[] = []
    const { options } = run(
      [
        entry('k', {
          prepare: (context) => {
            context.signal.addEventListener('abort', () => void (stopped = true))
            setImmediate(() => stop.resolve())
            return new Promise(() => undefined)
          },
          cleanup: async (context) => void cleaned.push(context),
        }),
      ],
      { stopped: stop.promise, interruption: () => (interrupted ? interruption : undefined) },
    )
    const prepared = await prepareAttempt(options)
    assert.deepEqual(prepared.failure, interruption)
    assert.equal(prepared.records[0]?.outcome, 'cancelled')
    assert.equal(stopped, true, 'the preparation is told to stop')
    await prepared.cleanUp(true)
    assert.deepEqual(cleaned.map((context) => [context.preparation, context.failed]), [['cancelled', true]])

    let called = false
    let cleanedLate = false
    const late = await prepareAttempt(
      run([entry('k', { prepare: async () => ((called = true), { status: 'prepared', recipe: 'r' }), cleanup: async () => void (cleanedLate = true) })], {
        stopped: Promise.resolve(),
        interruption: () => interruption,
      }).options,
    )
    assert.deepEqual([late.failure, late.records[0]?.outcome, called], [interruption, 'not_run', false], 'a run already stopped calls no preparation, and says it was not run, not cancelled')
    assert.match(late.records[0]?.reason ?? '', /^The run stopped before it was called: The host is shutting down/)
    await late.cleanUp(true)
    assert.equal(cleanedLate, false, 'a preparation never called is never cleaned up')
  })

  test('the host’s cleanup gets what its preparation answered as it answered it, while only the record is redacted, and thrown text is cut', async () => {
    let told: CleanupContext | undefined
    const { options } = run([
      entry('k', {
        prepare: async () => ({ status: 'prepared', recipe: 'r', seed: 'seed correct horse battery staple', receipt: 'receipt correct horse battery staple', metadata: { token: 'correct horse battery staple' } }),
        cleanup: async (context) => void (told = context),
      }),
    ])
    const prepared = await prepareAttempt(options)
    assert.deepEqual([prepared.records[0]?.seed, prepared.records[0]?.receipt, prepared.records[0]?.metadata], ['seed {{password}}', 'receipt {{password}}', { token: '{{password}}' }])
    await prepared.cleanUp(false)
    assert.deepEqual(told?.prepared, { recipe: 'r', seed: 'seed correct horse battery staple', receipt: 'receipt correct horse battery staple', metadata: { token: 'correct horse battery staple' } })

    const long = 'x'.repeat(5000)
    const thrown = await prepareAttempt(run([entry('k', { prepare: () => Promise.reject(new Error(long)), cleanup: () => Promise.reject(new Error(long)) })]).options)
    const thrownReason = thrown.records[0]?.reason
    assert.ok(thrownReason !== undefined && thrownReason.length > 400 && thrownReason.length <= 501, 'the preparation record keeps at most 500 characters of what was thrown')
    const cleanup = await thrown.cleanUp(true)
    const cleanupReason = cleanup.records[0]?.reason
    assert.ok(cleanupReason !== undefined && cleanupReason.length > 400 && cleanupReason.length <= 501, 'and so does the cleanup record')
    const cleanupFailure = cleanup.failures[0]
    assert.ok(cleanupFailure !== undefined && cleanupFailure.message.length > 400 && cleanupFailure.message.length < 700, 'the cleanup failure is bounded too')
  })

  test('a cleanup that fails or runs out of time is reported as cleanup_failed, beside the attempt’s failure', async () => {
    const { options, events } = run([
      entry('first', { cleanup: () => Promise.reject(new Error('could not drop the rows of correct horse battery staple')) }),
      entry('second', { cleanupTimeoutMs: 20, cleanup: () => new Promise(() => undefined) }),
    ])
    const prepared = await prepareAttempt(options)
    assert.equal(prepared.failure, undefined)
    assert.deepEqual(prepared.records, [], 'a declaration with nothing to prepare has no record of its own')
    const cleanup = await prepared.cleanUp(true)
    assert.deepEqual(
      cleanup.failures.map((each) => [each.class, each.message]),
      [
        ['cleanup_failed', 'The host\'s cleanup for "second" did not finish within 20 ms, and what it started may still be running.'],
        ['cleanup_failed', 'The host\'s cleanup for "first" failed: it threw: could not drop the rows of {{password}}.'],
      ],
    )
    assert.deepEqual(cleanup.records.map((record) => record.outcome), ['timed_out', 'failed'])
    assert.deepEqual(events.map((event) => event.type), ['cleanup.finished', 'cleanup.finished'])
  })
})

describe('the prepare option', () => {
  const planned = (testId: string, file: string, apps: string[]): PlannedTest => ({
    file,
    testId,
    registered: { name: testId.split(' > ').at(-1) ?? testId, location: { file, line: 1, column: 1 } },
    describePath: [],
    apps,
    states: new Map(),
    variants: [],
  })

  test('refuses a shape that would leave a preparation doing nothing on purpose', () => {
    assert.equal(preparationsShapeProblem(undefined), undefined)
    assert.equal(preparationsShapeProblem({ 'a.retest.ts': { prepare: async () => ({ status: 'prepared', recipe: 'r' }), apps: ['web'], timeoutMs: 500 } }), undefined)
    const problem = preparationsShapeProblem({
      'a.retest.ts': { prepare: 'reset', backendData: 'fresh', timeoutMs: 0, reset: true },
      'b.retest.ts': { prepare: async () => ({ status: 'prepared', recipe: 'r' }), backendData: 'reused', apps: [] },
    })
    assert.equal(problem?.class, 'usage')
    for (const expected of [
      'prepare["a.retest.ts"].reset: unknown key',
      'prepare["a.retest.ts"].prepare: expected a function, received "reset"',
      'prepare["a.retest.ts"].backendData: expected "reused" or "external", received "fresh"',
      'prepare["a.retest.ts"].timeoutMs: expected a whole number of milliseconds from 1 to 2147483647, received 0',
      'prepare["b.retest.ts"].backendData: a preparation that prepares declares "prepared" itself, so give prepare or backendData, not both',
      'prepare["b.retest.ts"].apps: expected a list of app names, received array',
    ]) {
      assert.ok(problem?.message.includes(expected), `${expected}\nin\n${problem?.message}`)
    }
    assert.equal(readPreparations({ 'a.retest.ts': { prepare: 'reset' } }), undefined)
  })

  test('refuses a key that names no test of the run and an app a test does not use, and orders a test’s preparations', () => {
    const one = planned('tests/a.retest.ts > shares', 'tests/a.retest.ts', ['owner', 'member'])
    const preparations = readPreparations({
      'tests/a.retest.ts': { backendData: 'external' },
      'tests/a.retest.ts > shares': { prepare: async () => ({ status: 'prepared', recipe: 'r' }), apps: ['member'] },
    })
    assert.ok(preparations !== undefined)
    assert.equal(preparationsScopeProblem(preparations, [one], []), undefined)
    assert.deepEqual(testPreparations(preparations, one).map((each) => [each.key, each.apps]), [
      ['tests/a.retest.ts', ['owner', 'member']],
      ['tests/a.retest.ts > shares', ['member']],
    ])
    assert.equal(declaredBackend(testPreparations(preparations, one), 'member'), 'prepared')
    assert.equal(declaredBackend(testPreparations(preparations, one), 'owner'), 'external')
    assert.equal(declaredBackend([], 'owner'), 'unavailable')
    const wrong = readPreparations({ 'tests/b.retest.ts': { backendData: 'reused' }, 'tests/a.retest.ts': { backendData: 'reused', apps: ['admin'] } })
    assert.ok(wrong !== undefined)
    const problem = preparationsScopeProblem(wrong, [one], [])
    assert.match(problem?.message ?? '', /prepare\["tests\/b\.retest\.ts"\]: names no test this run will run, and no file one comes from\./)
    assert.match(problem?.message ?? '', /prepare\["tests\/a\.retest\.ts"\]\.apps: admin is not an app of "tests\/a\.retest\.ts > shares", which uses owner, member\./)
  })
})
