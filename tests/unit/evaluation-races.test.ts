import type { TestContext } from 'node:test'
import type { LoadedEvaluation } from '../../src/config/read-evaluation.ts'
import type { EvaluationRequest, EvaluatorSetup } from '../../src/evaluation/contract.ts'
import type { EvaluationRecord } from '../../src/protocol/evaluation.ts'
import type { EventBody } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { PagesContext } from '../../src/runner/test-pages.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { AttemptEvaluations } from '../../src/evaluation/attempt.ts'
import { CallBudget, defaultEvaluationLimits } from '../../src/evaluation/budget.ts'
import { Judges } from '../../src/evaluation/judges.ts'
import { withEvaluationFailures } from '../../src/evaluation/run-evaluations.ts'
import { testStatus } from '../../src/runner/outcome.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { runProject, tempProject } from '../support/project.ts'
import { newRunFolder, quickTimeouts } from '../support/run-harness.ts'

// The races of an AI check, each against a fake judge: the budget running out, a stop while the judge works, a late
// answer from an attempt that ended, an answer after the run ended, and each way a provider can fail. In each, a
// required check never passes, an earlier failure is never cleared and nothing is recorded twice. The first part
// drives the parent's own `AttemptEvaluations`; the last runs real test file processes for the exit codes.

type Script = (request: EvaluationRequest, call: number) => unknown | Promise<unknown>

type Shared = { judges: Judges; budget: CallBudget; calls: EvaluationRequest[]; evaluation: LoadedEvaluation }

function shared(t: TestContext, script: Script, options: { limits?: Partial<typeof defaultEvaluationLimits>; factoryFails?: string } = {}): Shared {
  const calls: EvaluationRequest[] = []
  const factory = (setup: EvaluatorSetup): unknown => {
    if (options.factoryFails !== undefined) throw new Error(options.factoryFails)
    return {
      identity: { provider: 'races', model: `scripted-${setup.judge}`, version: 'races/1' },
      async evaluate(request: EvaluationRequest) {
        calls.push(request)
        return script(request, calls.length)
      },
    }
  }
  const limits = { ...defaultEvaluationLimits, ...options.limits }
  const evaluation: LoadedEvaluation = { judges: new Map([['judge', { name: 'judge', adapter: { kind: 'factory', factory }, credentials: new Map(), options: {}, accepts: ['text'] }]]), defaultJudge: 'judge', timeoutMs: 2000, limits }
  const judges = new Judges({ evaluation, redactor: new Redactor(), env: {} })
  t.after(() => judges.close(1000))
  return { judges, budget: new CallBudget(limits), calls, evaluation }
}

type Attempt = { evaluations: AttemptEvaluations; events: EventBody[]; run: AbortController; interrupt: (failure: Failure) => void }

function attempt(t: TestContext, from: Shared, attemptId: string): Attempt {
  const store = RunStore.create(newRunFolder())
  t.after(() => store.close())
  store.setClock(() => 1000)
  const events: EventBody[] = []
  let interruption: Failure | undefined
  const run = new AbortController()
  const context: PagesContext = {
    store,
    timeouts: quickTimeouts,
    stopped: new Promise(() => undefined),
    interruption: () => interruption,
    connected: () => true,
    release: () => undefined,
    named: true,
    emit: (body) => events.push(body),
    redact: (text) => text,
    testId: 'races.retest.ts > judges',
    attemptId,
  }
  const evaluations = new AttemptEvaluations({ context, pages: [], evaluation: from.evaluation, judges: from.judges, budget: from.budget, hostChecks: [], runSignal: run.signal })
  return {
    evaluations,
    events,
    run,
    interrupt: (failure) => {
      interruption = failure
      run.abort(failure)
    },
  }
}

const evidence = [{ kind: 'text' as const, text: 'Your task "Release checklist" was saved.', label: 'banner' }]

function ask(evaluations: AttemptEvaluations, criterion = 'saved'): Promise<unknown> {
  return evaluations.request({ criteria: [{ id: criterion, requirement: 'The banner says the task was saved.' }], evidence, mode: 'required' }, { remainingMs: 5000 })
}

function verdict(request: EvaluationRequest, value: 'pass' | 'fail'): unknown {
  return { criteria: request.criteria.map(({ id }) => ({ id, verdict: value, citations: ['e1'] })), justification: `Scripted ${value}.` }
}

// Each check writes exactly one event, and the records the attempt keeps are those events.
function onceEach(each: Attempt): EvaluationRecord[] {
  const written = each.events.flatMap((event) => (event.type === 'evaluation.finished' ? [event.evaluation] : []))
  assert.deepEqual(written, [...each.evaluations.records], 'one event per check, and nothing written twice')
  assert.equal(new Set(written.map((record) => record.checkId)).size, written.length)
  return written
}

function held(): { promise: Promise<void>; release: () => void; arrived: Promise<void>; arrive: () => void } {
  const gate = Promise.withResolvers<void>()
  const arrival = Promise.withResolvers<void>()
  return { promise: gate.promise, release: () => gate.resolve(), arrived: arrival.promise, arrive: () => arrival.resolve() }
}

describe('the call budget running out', () => {
  test('refuses the call past the run limit across attempts, before it is sent: the judge is asked once and the check is an error', async (t) => {
    const judge = shared(t, (request) => verdict(request, 'pass'), { limits: { callsPerRun: 1 } })
    const first = attempt(t, judge, 'first')
    const second = attempt(t, judge, 'second')
    await ask(first.evaluations)
    await ask(second.evaluations)
    assert.deepEqual([judge.calls.length, judge.budget.calls], [1, 1])
    const [refused] = onceEach(second)
    assert.deepEqual([refused?.verdict, refused?.failure?.class], ['error', 'evaluation_error'])
    assert.match(refused?.reason ?? '', /The run has used all 1 of its AI check calls \(evaluation\.limits\.callsPerRun\)\./)
    assert.equal(testStatus(refused?.failure), 'error')
  })

  test('refuses the call past the test limit, and a pass before it clears nothing', async (t) => {
    const judge = shared(t, (request) => verdict(request, 'pass'), { limits: { callsPerTest: 1 } })
    const only = attempt(t, judge, 'only')
    await ask(only.evaluations, 'first')
    await ask(only.evaluations, 'second')
    const [passed, refused] = onceEach(only)
    assert.deepEqual([passed?.verdict, refused?.verdict, judge.calls.length], ['pass', 'error', 1])
    const failures = await only.evaluations.failures()
    assert.deepEqual(failures.map((failure) => failure.class), ['evaluation_error'])
  })
})

describe('a stop while the judge is answering', () => {
  test('ends the check cancelled at once; the answer that comes afterwards is never read', async (t) => {
    const gate = held()
    const judge = shared(t, async (request) => {
      gate.arrive()
      await gate.promise
      return verdict(request, 'pass')
    })
    const only = attempt(t, judge, 'only')
    const asking = ask(only.evaluations)
    await gate.arrived
    only.evaluations.cancel({ class: 'test_error', message: 'The test ended before its check.' })
    await asking
    gate.release()
    await new Promise((resolve) => setImmediate(resolve))
    const [record] = onceEach(only)
    assert.deepEqual([record?.verdict, record?.reason], ['cancelled', 'The test ended before its check.'])
    assert.deepEqual((await only.evaluations.failures()).map((failure) => failure.class), ['evaluation_error'])
    assert.equal(only.evaluations.records.length, 1, 'the late pass wrote nothing')
  })

  test('a check asked after the stop is cancelled before it is sent and spends no call', async (t) => {
    const judge = shared(t, (request) => verdict(request, 'pass'))
    const only = attempt(t, judge, 'only')
    only.evaluations.cancel({ class: 'test_error', message: 'The test ended.' })
    await ask(only.evaluations)
    assert.deepEqual([judge.calls.length, judge.budget.calls, onceEach(only)[0]?.verdict], [0, 0, 'cancelled'])
  })
})

describe('a late answer from an attempt that ended', () => {
  test("changes neither that attempt's record nor the next attempt's verdict", async (t) => {
    const gate = held()
    const judge = shared(t, async (request, call) => {
      if (call > 1) return verdict(request, 'fail')
      gate.arrive()
      await gate.promise
      return verdict(request, 'pass')
    })
    const earlier = attempt(t, judge, 'earlier')
    const asking = ask(earlier.evaluations)
    await gate.arrived
    earlier.evaluations.cancel({ class: 'timeout', message: 'The attempt ran out of time.' })
    await asking
    const later = attempt(t, judge, 'later')
    await ask(later.evaluations)
    gate.release()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(onceEach(earlier).map((record) => record.verdict), ['cancelled'])
    assert.deepEqual(onceEach(later).map((record) => record.verdict), ['fail'])
    assert.deepEqual(judge.calls.map((call) => call.requestId), ['earlier:evaluation-1', 'later:evaluation-1'], 'each request names its own attempt')
    assert.equal(judge.budget.calls, 2, 'the call the earlier attempt sent is spent')
  })
})

describe('an answer after the run ended', () => {
  test('the run stops the check with its interruption, the judges close, and the answer that comes afterwards writes nothing', async (t) => {
    const gate = held()
    const judge = shared(t, async (request) => {
      gate.arrive()
      await gate.promise
      return verdict(request, 'pass')
    })
    const only = attempt(t, judge, 'only')
    const asking = ask(only.evaluations)
    await gate.arrived
    const stop: Failure = { class: 'interrupted', message: 'The run was interrupted.' }
    only.interrupt(stop)
    await asking
    await judge.judges.close(1000)
    gate.release()
    await new Promise((resolve) => setImmediate(resolve))
    const [record] = onceEach(only)
    assert.deepEqual([record?.verdict, record?.failure], ['cancelled', stop])
    assert.deepEqual(await only.evaluations.failures(), [stop])
  })
})

describe('a provider that fails', () => {
  const failing: [string, Script, RegExp][] = [
    ['an error', () => Promise.reject(new Error('500 Internal Server Error')), /The judge failed: 500 Internal Server Error/],
    ['a rate limit', () => Promise.reject(new Error('429 Too Many Requests: rate limit reached')), /The judge failed: 429 Too Many Requests/],
    ['a model it does not have', () => Promise.reject(new Error('404 The model "judge-9" does not exist')), /The judge failed: 404 The model "judge-9" does not exist/],
    ['malformed output', () => ({ verdict: 'yes' }), /The judge's answer breaks the contract: it does not have the shape of an answer/],
    ['an answer for another check', (request) => ({ criteria: [{ id: 'other', verdict: 'pass', citations: ['e1'] }, ...request.criteria.map(({ id }) => ({ id, verdict: 'pass', citations: ['e1'] }))], justification: 'Two answers.' }), /judges a criterion the check does not have/],
  ]
  for (const [what, script, reason] of failing) {
    test(`with ${what}: an error, asked once and never again, the call spent, and an earlier failure keeps the lead`, async (t) => {
      const judge = shared(t, script)
      const only = attempt(t, judge, 'only')
      await ask(only.evaluations)
      const [record] = onceEach(only)
      assert.deepEqual([record?.verdict, record?.failure?.class], ['error', 'evaluation_error'])
      assert.match(record?.reason ?? '', reason)
      assert.deepEqual([judge.calls.length, judge.budget.calls], [1, 1], 'no retry')
      const earlier: Failure = { class: 'check_failed', message: 'Expected the banner to read "Saved".' }
      const lead = withEvaluationFailures({ reported: earlier, recorded: await only.evaluations.failures(), observed: [earlier] })
      assert.equal(lead?.class, 'check_failed')
      assert.equal(testStatus(lead), 'failed')
      assert.equal(testStatus(withEvaluationFailures({ reported: undefined, recorded: await only.evaluations.failures(), observed: [] })), 'error')
    })
  }

  test('with a model it cannot set up: the check is an error naming the judge, and no call is spent', async (t) => {
    const judge = shared(t, (request) => verdict(request, 'pass'), { factoryFails: 'The model "judge-9" is not available to this key.' })
    const only = attempt(t, judge, 'only')
    await ask(only.evaluations)
    const [record] = onceEach(only)
    assert.equal(record?.verdict, 'error')
    assert.match(record?.reason ?? '', /The judge "judge" could not be set up: its factory failed: The model "judge-9" is not available to this key\./)
    assert.deepEqual([judge.calls.length, judge.budget.calls], [0, 0])
  })
})

// A judge module as a project gives it, which answers by the first criterion's id.
const racesJudge = `export default (setup) => {
  if (setup.options.model === 'missing') throw new Error('The model "missing" is not available to this key.')
  return {
    identity: { provider: 'races', model: String(setup.options.model), version: 'races/1' },
    async evaluate(request) {
      const behaviour = request.criteria[0]?.id
      if (behaviour === 'rate') throw new Error('429 Too Many Requests: rate limit reached')
      if (behaviour === 'gone') throw new Error('404 The model does not exist')
      if (behaviour === 'malformed') return { verdict: 'yes' }
      return { criteria: request.criteria.map(({ id }) => ({ id, verdict: behaviour === 'fail' ? 'fail' : 'pass', citations: ['e1'] })), justification: 'Scripted.' }
    },
  }
}
`

const racesConfig = `import { chromium, defineConfig } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: 'http://127.0.0.1:4173', executablePath: '/fake/chromium' }) },
  evaluation: {
    judges: {
      scripted: { adapter: './judges/races.mjs', options: { model: 'scripted-1' }, accepts: ['text'] },
      missing: { adapter: './judges/races.mjs', options: { model: 'missing' }, accepts: ['text'] },
    },
    defaultJudge: 'scripted',
    timeoutMs: 2000,
    limits: { callsPerRun: 4 },
  },
})
`

const racesTests = `import { expect, test } from '@rehearsal-labs/retest'

const evidence = { text: 'Your task was saved.', label: 'banner' }
const check = (id, judge) => test.evaluate({ ...(judge === undefined ? {} : { judge }), requirement: { [id]: 'The banner says the task was saved.' }, evidence })

test('rate limit', async () => { await check('rate') })
test('model gone', async () => { await check('gone') })
test('missing model', async () => { await check('pass', 'missing') })
test('malformed', async () => { await check('malformed') })
test('earlier failure, then a pass', async () => {
  expect.soft(1).toBe(2)
  await check('pass')
})
test('budget spent', async () => { await check('pass') })
`

describe('through test file processes', async () => {
  const root = tempProject({ 'retest.config.ts': racesConfig, 'judges/races.mjs': racesJudge, 'tests/races.retest.ts': racesTests })
  const exits: Record<string, number> = {}
  const records = new Map<string, EvaluationRecord[]>()
  for (const name of ['rate limit', 'model gone', 'missing model', 'malformed']) {
    const record = await runProject(root, { files: ['tests/races.retest.ts'], selection: { grep: new RegExp(`^${name}$`) } })
    exits[name] = record.result.exitCode
    records.set(name, record.result.files.flatMap((file) => file.tests).flatMap((each) => each.evaluations ?? []))
  }
  const whole = await runProject(root, { files: ['tests/races.retest.ts'] })

  test('a rate limit, a model the provider does not have, one that cannot be set up and malformed output each exit 2, never 0', () => {
    assert.deepEqual(exits, { 'rate limit': 2, 'model gone': 2, 'missing model': 2, malformed: 2 })
    for (const [name, list] of records) assert.deepEqual(list.map((record) => record.verdict), ['error'], name)
  })

  test('in one run, the budget runs out after four calls, and the earlier failure survives a pass', () => {
    const tests = whole.result.files.flatMap((file) => file.tests)
    const status = Object.fromEntries(tests.map((each) => [each.name, [each.status, each.failure?.class]]))
    assert.deepEqual(status, {
      'rate limit': ['error', 'evaluation_error'],
      'model gone': ['error', 'evaluation_error'],
      'missing model': ['error', 'evaluation_error'],
      malformed: ['error', 'evaluation_error'],
      'earlier failure, then a pass': ['failed', 'check_failed'],
      'budget spent': ['error', 'evaluation_error'],
    })
    const passed = tests.find((each) => each.name === 'earlier failure, then a pass')?.evaluations?.[0]
    assert.equal(passed?.verdict, 'pass', 'the check passed and cleared nothing')
    const spent = tests.find((each) => each.name === 'budget spent')?.evaluations?.[0]
    assert.match(spent?.reason ?? '', /The run has used all 4 of its AI check calls/)
    const evaluations = whole.events.filter((event) => event.type === 'evaluation.finished')
    assert.equal(evaluations.length, tests.flatMap((each) => each.evaluations ?? []).length, 'one event for each record')
    assert.equal(whole.result.exitCode, 1)
  })
})
