import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { ChildEvent, EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { LocatorCheckRecord } from '../../src/protocol/locator-checks.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ScriptedTest } from '../support/scripted-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { failure, truncateText } from '../../src/protocol/failures.ts'
import { textComparison } from '../../src/protocol/text.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { eventsOfType, isGoneWithin, printedPids, runSupportFiles, testNamed } from '../support/run-harness.ts'
import { scriptedApp, scriptedTest } from '../support/scripted-process.ts'

type Body<Type extends EventBody['type']> = Extract<EventBody, { type: Type }>

const title: LocatorRecipe = { by: 'testId', value: 'task-title' }
const missing: LocatorRecipe = { by: 'testId', value: 'missing' }

function bodies<Type extends EventBody['type']>(run: ScriptedTest, type: Type): Body<Type>[] {
  return run.events.map(({ body }) => body).filter((body): body is Body<Type> => body.type === type)
}

type Claim = {
  type?: 'assertion.passed' | 'assertion.failed'
  locator?: LocatorRecipe
  check?: LocatorCheckRecord
  observationId?: string
  sessionId?: string
  session?: string
  pageUrl?: string
}

// An assertion as a test process sends it, with values of its own that the parent must not keep. One that names a
// look sends back the session this run's page was served in, as Retest's own test process does, unless it names
// another.
function claim(run: ScriptedTest, { type = 'assertion.passed', ...fields }: Claim): ChildEvent {
  const reference = fields.observationId === undefined ? {} : { sessionId: formatSessionId(run.attemptId, scriptedApp) }
  const common = {
    testId: run.testId,
    attemptId: run.attemptId,
    matcher: 'toBeVisible',
    expected: truncateText('what the process says'),
    actual: truncateText('what the process saw'),
    comparison: 'as the process pleases',
    attempts: 2,
    durationMs: 5,
    ...reference,
    ...fields,
  }
  return type === 'assertion.passed' ? { type, ...common } : { type, ...common, failure: failure('check_failed', 'It did not show.') }
}

async function violated(run: ScriptedTest, pattern: RegExp): Promise<void> {
  const report = await run.report
  assert.equal(report.failure?.class, 'test_error')
  assert.match(report.failure?.message ?? '', pattern)
  assert.equal(run.process.killed, true, 'its process is killed')
  assert.deepEqual([...bodies(run, 'assertion.passed'), ...bodies(run, 'assertion.failed')], [], 'no assertion is written')
}

describe('observations', () => {
  test('every look the page answers is written, with its id, before the answer goes, and ids count from o1', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'goto', url: '/tasks' })
    const first = await run.command(2, { kind: 'observe', locator: title })
    const second = await run.command(3, { kind: 'observe', locator: { by: 'testId', value: 'repeated-task' } })
    await run.finish()
    assert.deepEqual([first.ok && first.kind === 'observe' ? first.observationId : undefined, second.ok && second.kind === 'observe' ? second.observationId : undefined], ['o1', 'o2'])
    const looks = bodies(run, 'observation')
    assert.deepEqual(
      looks.map((look) => [look.observationId, look.locator, look.session, look.pageUrl, look.observed.count]),
      [
        ['o1', title, 'page', 'http://127.0.0.1:4173/tasks', 1],
        ['o2', { by: 'testId', value: 'repeated-task' }, 'page', 'http://127.0.0.1:4173/tasks', 2],
      ],
    )
    assert.deepEqual(looks[1]?.observed.items, [
      { text: { text: 'One', truncated: false, length: 3 }, visible: true },
      { text: { text: 'One', truncated: false, length: 3 }, visible: true },
    ])
    assert.ok(looks.every((look) => look.durationMs >= 0))
    assert.ok(run.events.filter(({ body }) => body.type === 'observation').every(({ origin }) => origin === 'parent'))
    const order = run.timeline.filter((entry) => entry === 'observation' || entry === 'command-result')
    assert.deepEqual(order, ['command-result', 'observation', 'command-result', 'observation', 'command-result'])
  })

  test('a look that failed served nothing, writes no event and uses no id', async () => {
    const run = await scriptedTest()
    const failed = await run.command(1, { kind: 'observe', locator: { by: 'role', role: 'button', name: 'Save' } })
    const served = await run.command(2, { kind: 'observe', locator: title })
    await run.finish()
    assert.deepEqual(failed.ok ? undefined : failed.failure.class, 'unsupported')
    assert.ok(!('observationId' in failed))
    assert.equal(served.ok && served.kind === 'observe' ? served.observationId : undefined, 'o1')
    assert.deepEqual(bodies(run, 'observation').map((look) => look.observationId), ['o1'])
  })

  test('a look answered after the test was stopped is neither sent nor written', async () => {
    const received = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const heldBack = (command: BrowserCommand): boolean => command.kind === 'observe' && command.locator === missing
    const run = await scriptedTest({
      fake: {
        onCommand: (command) => void (heldBack(command) && received.resolve()),
        holdAnswer: async (command) => {
          if (heldBack(command)) await released.promise
        },
      },
    })
    await run.command(1, { kind: 'observe', locator: title })
    const answer = run.command(2, { kind: 'observe', locator: missing })
    await received.promise
    run.running.revoke(failure('interrupted', 'The run was interrupted.'), 0)
    released.resolve()
    await run.report
    await run.running.settle(1000)
    run.running.close()
    const stopped = await answer
    assert.equal(stopped.ok ? undefined : stopped.failure.class, 'interrupted')
    assert.deepEqual(bodies(run, 'observation').map((look) => [look.observationId, look.locator]), [['o1', title]], 'only the look served before the stop is written')
    assert.equal(run.process.sent.filter((message) => message.type === 'command-result').length, 2)
  })

  test("page text is observed as the test process received it: redacted, and a secret reads as its name", async () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-7391')
    const run = await scriptedTest({ redactor })
    await run.command(1, { kind: 'fill', locator: title, value: 'hunter2-7391' })
    const answer = await run.command(2, { kind: 'observe', locator: { by: 'testId', value: 'typed-value' } })
    await run.finish()
    assert.equal(answer.ok && answer.kind === 'observe' ? answer.observation.text : undefined, '{{password}}')
    assert.equal(bodies(run, 'observation')[0]?.observed.text?.text, '{{password}}')
  })
})

describe("the parent's judgement", () => {
  test('a pass the check agrees with is written as the parent judged it: its matcher, expected, comparison, actual and look', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'fill', locator: title, value: 'Release checklist' })
    await run.command(2, { kind: 'observe', locator: title })
    run.event(claim(run, { locator: title, observationId: 'o1', check: { matcher: 'toHaveText', text: 'Release checklist' }, session: 'page' }))
    const report = await run.finish()
    assert.equal(report.failure, undefined)
    const passed = bodies(run, 'assertion.passed')
    assert.equal(passed.length, 1)
    const [written] = passed
    assert.deepEqual(
      [written?.matcher, written?.expected, written?.comparison, written?.actual, written?.observationId, written?.judgedBy],
      ['toHaveText', truncateText('Release checklist'), textComparison, truncateText('Release checklist'), 'o1', 'parent'],
    )
    assert.ok(written !== undefined && !('check' in written), 'the check the process sent is never written')
    assert.deepEqual([written?.attempts, written?.durationMs], [2, 5], 'what the process measured of its own polling stays')
    assert.equal(run.events.find(({ body }) => body.type === 'assertion.passed')?.origin, 'child')
  })

  test('toBeHidden and toHaveCount(0) pass on a look with no match, and name it', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: missing })
    run.event(claim(run, { locator: missing, observationId: 'o1', check: { matcher: 'toBeHidden' } }))
    run.event(claim(run, { locator: missing, observationId: 'o1', check: { matcher: 'toHaveCount', count: 0 } }))
    await run.finish()
    assert.deepEqual(
      bodies(run, 'assertion.passed').map((event) => [event.matcher, event.actual?.text, event.judgedBy]),
      [
        ['toBeHidden', 'no element', 'parent'],
        ['toHaveCount', '0', 'parent'],
      ],
    )
  })

  test('a test process that claims toBeVisible passed on a look with no match ends test_error, is killed, and no pass is written', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: missing })
    run.event(claim(run, { locator: missing, observationId: 'o1', check: { matcher: 'toBeVisible' } }))
    await violated(run, /sent assertion\.passed for expect\(getByTestId\('missing'\)\)\.toBeVisible\(\), which fails on o1, the look it named, where nothing matched/)
  })

  test('a value assertion is written as the test process judged it, and says so', async () => {
    const run = await scriptedTest()
    const value = { type: 'assertion.passed', testId: run.testId, attemptId: run.attemptId, matcher: 'toBe', expected: truncateText('2'), actual: truncateText('2'), attempts: 1, durationMs: 0 } as const
    run.event({ ...value, pageUrl: 'http://evil.example/claimed' })
    await run.finish()
    const [written] = bodies(run, 'assertion.passed')
    assert.deepEqual([written?.matcher, written?.expected, written?.actual, written?.judgedBy], ['toBe', truncateText('2'), truncateText('2'), 'child'])
    assert.ok(written !== undefined && !('pageUrl' in written), 'the address the process claimed is dropped')
  })

  test("a locator assertion takes the address of the look it names, never the one the process sent", async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'goto', url: '/tasks' })
    await run.command(2, { kind: 'observe', locator: title })
    await run.command(3, { kind: 'goto', url: '/elsewhere' })
    run.event(claim(run, { locator: title, observationId: 'o1', check: { matcher: 'toBeVisible' }, pageUrl: 'http://evil.example/claimed' }))
    await run.finish()
    assert.equal(bodies(run, 'assertion.passed')[0]?.pageUrl, 'http://127.0.0.1:4173/tasks')
  })

  test("a failed locator assertion keeps its failure, takes the parent's check and the look's value, and carries no judge", async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'goto', url: '/tasks' })
    await run.command(2, { kind: 'fill', locator: title, value: 'Draft' })
    await run.command(3, { kind: 'observe', locator: title })
    run.event(claim(run, { type: 'assertion.failed', locator: title, observationId: 'o1', check: { matcher: 'toHaveText', text: 'Release checklist' } }))
    run.event(claim(run, { type: 'assertion.failed', locator: missing, check: { matcher: 'toBeVisible' }, pageUrl: 'http://evil.example/claimed' }))
    await run.finish()
    const [named, unnamed] = bodies(run, 'assertion.failed')
    assert.deepEqual(
      [named?.matcher, named?.expected?.text, named?.actual?.text, named?.observationId, named?.failure.message],
      ['toHaveText', 'Release checklist', 'Draft', 'o1', 'It did not show.'],
    )
    assert.deepEqual([unnamed?.matcher, unnamed?.expected?.text, unnamed?.actual, unnamed?.observationId, unnamed?.pageUrl], ['toBeVisible', 'visible', null, undefined, 'http://127.0.0.1:4173/tasks'])
    assert.ok([named, unnamed].every((event) => event !== undefined && !('judgedBy' in event)))
  })

  test('the look is judged as the test process received it, redacted: a claim about the value itself fails', async () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-7391')
    const agreed = await scriptedTest({ redactor })
    await agreed.command(1, { kind: 'fill', locator: title, value: 'hunter2-7391' })
    await agreed.command(2, { kind: 'observe', locator: { by: 'testId', value: 'typed-value' } })
    agreed.event(claim(agreed, { locator: { by: 'testId', value: 'typed-value' }, observationId: 'o1', check: { matcher: 'toHaveText', text: '{{password}}' } }))
    await agreed.finish()
    assert.deepEqual(bodies(agreed, 'assertion.passed').map((event) => [event.actual?.text, event.judgedBy]), [['{{password}}', 'parent']])

    const forged = await scriptedTest({ redactor })
    await forged.command(1, { kind: 'fill', locator: title, value: 'hunter2-7391' })
    await forged.command(2, { kind: 'observe', locator: { by: 'testId', value: 'typed-value' } })
    forged.event(claim(forged, { locator: { by: 'testId', value: 'typed-value' }, observationId: 'o1', check: { matcher: 'toHaveText', text: 'hunter2-7391' } }))
    await violated(forged, /toHaveText\(\), which fails on o1/)
    assert.ok(!((await forged.report).failure?.message ?? '').includes('hunter2-7391'), 'the refusal never quotes the value')
  })

  test('an expected text longer than the event keeps is judged whole', async () => {
    const long = `${'a'.repeat(4500)}b${'c'.repeat(499)}`
    const agreed = await scriptedTest()
    await agreed.command(1, { kind: 'fill', locator: title, value: long })
    await agreed.command(2, { kind: 'observe', locator: title })
    agreed.event(claim(agreed, { locator: title, observationId: 'o1', check: { matcher: 'toHaveText', text: long } }))
    await agreed.finish()
    const [written] = bodies(agreed, 'assertion.passed')
    assert.deepEqual([written?.expected?.truncated, written?.expected?.length, written?.expected?.text.length], [true, 5000, 4096])

    const differs = await scriptedTest()
    await differs.command(1, { kind: 'fill', locator: title, value: long })
    await differs.command(2, { kind: 'observe', locator: title })
    differs.event(claim(differs, { locator: title, observationId: 'o1', check: { matcher: 'toHaveText', text: long.replace('b', 'x') } }))
    await violated(differs, /toHaveText\(\), which fails on o1/)
  })
})

// A value can be learned after the look that showed it was served, as a function source's is at its first fill. The
// parent still judges the look as it served it, but writes what it judged with every value it knows by then hidden,
// before it quotes or cuts anything.
describe('a value learned after the look was served', () => {
  const echoed: LocatorRecipe = { by: 'testId', value: 'typed-value' }

  async function judgedAfterLearning(typed: string, check: LocatorCheckRecord, value: string): Promise<RetestEvent | undefined> {
    const redactor = new Redactor()
    const run = await scriptedTest({ redactor })
    await run.command(1, { kind: 'fill', locator: title, value: typed })
    await run.command(2, { kind: 'observe', locator: echoed })
    redactor.learn('password', value)
    run.event(claim(run, { locator: echoed, observationId: 'o1', check }))
    await run.finish()
    const [passed] = bodies(run, 'assertion.passed')
    if (passed === undefined) return undefined
    const stamped: RetestEvent = { schemaVersion: 1, runId: 'run', sequence: 0, time: '', elapsedMs: 0, origin: 'child', ...passed }
    return redactor.redactFields(retestEventSchema, stamped)
  }

  test('is hidden whole in what the parent writes, even where the event cuts the text inside it', async () => {
    const value = 'SYNTHETIC-PASSWORD'
    const typed = `${'x'.repeat(4091)}${value}`
    const written = await judgedAfterLearning(typed, { matcher: 'toHaveText', text: typed }, value)
    assert.ok(written?.type === 'assertion.passed', 'the pass is judged on the look as it was served')
    assert.deepEqual([written.judgedBy, written.expected?.text.slice(4091), written.actual?.text.slice(4091)], ['parent', '{{pas', '{{pas'])
    assert.ok(!JSON.stringify(written).includes('SYNT'), 'no part of the value is written')
  })

  test('is hidden before it is quoted, so a value with a quote in it is not written escaped', async () => {
    const value = 'ab"cd'
    const typed = `Welcome ${value}`
    const written = await judgedAfterLearning(typed, { matcher: 'toHaveText', texts: [typed] }, value)
    assert.ok(written?.type === 'assertion.passed')
    assert.deepEqual([written.expected?.text, written.actual?.text], ['["Welcome {{password}}"]', '["Welcome {{password}}"]'])
  })
})

// A locator's text is matched against the page as it is, not redacted. A locator that holds a whole value never goes
// to the page, and the refusal never repeats it. Part of a value is not refused: refusing it would answer, without any
// page, which texts are part of a secret.
describe('a locator whose text or name holds a secret', () => {
  test('is refused as usage before the page is asked, and the refusal never quotes it', async () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-7391')
    const run = await scriptedTest({ redactor })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    const refused = [
      await run.command(2, { kind: 'observe', locator: { by: 'text', text: 'Signed in as hunter2-7391' } }),
      await run.command(3, { kind: 'click', locator: { by: 'role', role: 'button', name: 'Forget HUNTER2-7391', exact: false } }),
      await run.command(4, { kind: 'fill', locator: { by: 'label', text: ' hunter2-7391 ' }, value: 'new' }),
    ]
    // The fake page finds only test ids, so these fail there; what matters is that they reached it.
    await run.command(5, { kind: 'observe', locator: { by: 'text', text: 'hunter', exact: false } })
    await run.command(6, { kind: 'observe', locator: { by: 'role', role: 'button', name: 'HUNTER2-7391' } })
    await run.finish()
    for (const answer of refused) {
      assert.ok(!answer.ok, JSON.stringify(answer))
      assert.equal(answer.failure.class, 'usage')
      assert.match(answer.failure.message, /holds the value of a secret/)
      assert.ok(!answer.failure.message.includes('unter2') && !answer.failure.message.includes('Signed in'), answer.failure.message)
    }
    assert.deepEqual(run.page.browser.commands.map((command) => command.kind), ['goto', 'observe', 'observe'], 'part of a value, and an exact name in another case, still go to the page')
    assert.deepEqual(bodies(run, 'action.failed').map((event) => [event.command, event.failure.class]), [['click', 'usage'], ['fill', 'usage']])
  })
})

describe('claims the parent cannot accept', () => {
  test('a passed locator assertion that names no look', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: title })
    run.event(claim(run, { locator: title, check: { matcher: 'toBeVisible' } }))
    await violated(run, /sent assertion\.passed for getByTestId\('task-title'\) without naming the look it rested on/)
  })

  test('a locator assertion without the check it made, passed or failed', async () => {
    for (const type of ['assertion.passed', 'assertion.failed'] as const) {
      const run = await scriptedTest()
      await run.command(1, { kind: 'observe', locator: title })
      run.event(claim(run, { type, locator: title, observationId: 'o1' }))
      await violated(run, new RegExp(`sent ${type.replace('.', '\\.')} for getByTestId\\('task-title'\\) without the check it made`))
    }
  })

  test('a look this attempt never served', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: title })
    run.event(claim(run, { locator: title, observationId: 'o7', check: { matcher: 'toBeVisible' } }))
    await violated(run, /named the look "o7", which Retest did not serve to this test/)
  })

  test("a look served to an earlier attempt: ids count per attempt", async () => {
    const earlier = await scriptedTest({ attemptId: 'attempt1' })
    await earlier.command(1, { kind: 'observe', locator: title })
    await earlier.finish()
    const later = await scriptedTest({ attemptId: 'attempt2' })
    later.event(claim(later, { locator: title, observationId: 'o1', sessionId: formatSessionId(earlier.attemptId, scriptedApp), check: { matcher: 'toBeVisible' } }))
    await violated(later, /named the look "o1", which Retest did not serve to this test/)
  })

  test('a look at another locator, or on another app', async () => {
    const other = await scriptedTest()
    await other.command(1, { kind: 'observe', locator: { by: 'testId', value: 'save-task' } })
    other.event(claim(other, { locator: title, observationId: 'o1', check: { matcher: 'toBeVisible' } }))
    await violated(other, /named o1, a look at getByTestId\('save-task'\) on page, for an assertion on getByTestId\('task-title'\) on page/)

    const app = await scriptedTest()
    await app.command(1, { kind: 'observe', locator: title })
    app.event(claim(app, { locator: title, observationId: 'o1', check: { matcher: 'toBeVisible' }, session: 'admin' }))
    await violated(app, /named o1, a look at getByTestId\('task-title'\) on page, for an assertion on getByTestId\('task-title'\) on admin/)
  })

  test('the same locator with its keys in another order is the same locator', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: { by: 'testId', value: 'task-title' } })
    run.event(claim(run, { locator: { value: 'task-title', by: 'testId' }, observationId: 'o1', check: { matcher: 'toBeVisible' } }))
    await run.finish()
    assert.deepEqual(bodies(run, 'assertion.passed').map((event) => [event.observationId, event.judgedBy]), [['o1', 'parent']])
  })

  test('a value assertion that names a look or a check', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: title })
    const value = { type: 'assertion.passed', testId: run.testId, attemptId: run.attemptId, matcher: 'toBe', expected: truncateText('2'), actual: truncateText('2'), attempts: 1, durationMs: 0 } as const
    run.event({ ...value, observationId: 'o1', sessionId: formatSessionId(run.attemptId, scriptedApp) })
    await violated(run, /sent assertion\.passed for a value, naming a look or a locator check, which only a locator assertion has/)
  })
})

describe('a real test process that forges a pass', async () => {
  const record = await runSupportFiles(['forged-assertion.retest.ts'])

  test('ends test_error, its process is gone, and no assertion.passed is written for it', async () => {
    const result = testNamed(record.result, 'claims a missing element is visible')
    assert.deepEqual([result.status, result.failure?.class], ['failed', 'test_error'])
    assert.match(result.failure?.message ?? '', /^The process for this file sent assertion\.passed for expect\(getByTestId\('missing'\)\)\.toBeVisible\(\), which fails on o1, the look it named, where nothing matched\.$/)
    assert.deepEqual(eventsOfType(record.events, 'assertion.passed'), [])
    assert.deepEqual(eventsOfType(record.events, 'observation').map((event) => [event.observationId, event.observed.count]), [['o1', 0]])
    const [pid] = printedPids(record.output)
    assert.ok(pid !== undefined && (await isGoneWithin(pid, 1000)), 'the process is gone')
    assert.equal(testNamed(record.result, 'never gets a turn').status, 'not_run')
  })
})

describe('a real test process that claims a pass after the parent failed its assertion on a look it served', async () => {
  const record = await runSupportFiles(['forged-pass.retest.ts'])

  test('is failed by what the parent saw, and the failed assertion is written as the child reported it', () => {
    const result = testNamed(record.result, 'claims a pass after the parent failed its assertion')
    assert.deepEqual([result.status, result.failure?.class, result.ending?.kind], ['failed', 'check_failed', 'assertion_failed'])
    assert.equal(result.failure?.message, "expect(getByTestId('missing')).toBeVisible() failed: nothing matched.")
    assert.deepEqual(eventsOfType(record.events, 'assertion.failed').map((event) => [event.origin, event.observationId, event.failure.class]), [['child', 'o1', 'check_failed']])
    assert.deepEqual(eventsOfType(record.events, 'assertion.passed').map((event) => [event.matcher, event.judgedBy]), [['toBe', 'child']], "only the process's own value assertion passed")
    assert.equal(record.result.exitCode, 1)
  })
})
