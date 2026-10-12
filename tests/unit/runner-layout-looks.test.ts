import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { ChildEvent, EventBody } from '../../src/protocol/events.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { LayoutLook, LayoutTarget } from '../../src/protocol/layout.ts'
import type { CheckRecord } from '../../src/protocol/locator-checks.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ScriptedTest } from '../support/scripted-process.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { formatSessionId } from '../../src/protocol/evidence.ts'
import { failure, truncateText } from '../../src/protocol/failures.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { scriptedApp, scriptedTest } from '../support/scripted-process.ts'

type Body<Type extends EventBody['type']> = Extract<EventBody, { type: Type }>

const save: LocatorRecipe = { by: 'testId', value: 'save' }
const help: LocatorRecipe = { by: 'testId', value: 'help' }

function shown(left: number, top: number, right: number, bottom: number): LayoutTarget {
  const box = { left, top, right, bottom }
  return { count: 1, element: { shown: true, box, seen: box, field: false } }
}

// A page where the two buttons overlap by 32 by 32 pixels at 768 pixels wide, and the document is 1024 pixels wide.
function overlapping(command: Extract<BrowserCommand, { kind: 'observeLayout' }>): LayoutLook {
  const targets = [command.locator, command.other].flatMap((locator, index) => (locator === undefined ? [] : [index === 0 ? shown(0, 0, 100, 40) : shown(68, 8, 200, 40)]))
  return { viewport: { width: 768, height: 1024 }, edge: 768, documentWidth: 1024, hidesSideways: false, targets }
}

function bodies<Type extends EventBody['type']>(run: ScriptedTest, type: Type): Body<Type>[] {
  return run.events.map(({ body }) => body).filter((body): body is Body<Type> => body.type === type)
}

type Claim = { type?: 'assertion.passed' | 'assertion.failed'; locator?: LocatorRecipe; check: CheckRecord; observationId?: string; failure?: Failure }

// An assertion as a test process sends it, with values and a measurement of its own that the parent must not keep.
function claim(run: ScriptedTest, { type = 'assertion.passed', failure: claimed = failure('check_failed', 'It did not match.'), ...fields }: Claim): Extract<ChildEvent, { type: 'assertion.passed' | 'assertion.failed' }> {
  const reference = fields.observationId === undefined ? {} : { sessionId: formatSessionId(run.attemptId, scriptedApp) }
  const common = {
    testId: run.testId,
    attemptId: run.attemptId,
    session: scriptedApp,
    matcher: 'as the process pleases',
    expected: truncateText('what the process says'),
    actual: truncateText('what the process saw'),
    attempts: 2,
    durationMs: 5,
    layout: { viewport: { width: 1, height: 1 }, edge: 1, shared: { across: 999, down: 999 } },
    ...reference,
    ...fields,
  }
  return type === 'assertion.passed' ? { type, ...common } : { type, ...common, failure: claimed }
}

async function violated(run: ScriptedTest, pattern: RegExp): Promise<void> {
  const report = await run.report
  assert.equal(report.failure?.class, 'test_error')
  assert.match(report.failure?.message ?? '', pattern)
  assert.deepEqual([...bodies(run, 'assertion.passed'), ...bodies(run, 'assertion.failed')], [], 'no assertion is written')
}

describe('layout looks', () => {
  test('a layout look is served with an id and its session, counted with the other looks, and writes no observation event and no action', async () => {
    const run = await scriptedTest({ fake: { layout: overlapping } })
    const look = await run.command(1, { kind: 'observeLayout', locator: save, other: help, check: true })
    await run.finish()
    assert.ok(look.ok && look.kind === 'observeLayout', JSON.stringify(look))
    assert.deepEqual([look.observationId, look.sessionId], ['o1', 'attempt1:page'])
    assert.deepEqual(bodies(run, 'observation'), [])
    assert.deepEqual(bodies(run, 'action.completed'), [])
  })

  test("a layout assertion is judged by the parent on the look it names, and records that look's measurement, not the process's", async () => {
    const run = await scriptedTest({ fake: { layout: overlapping } })
    await run.command(1, { kind: 'observeLayout', locator: save, other: help, check: true })
    await run.command(2, { kind: 'observeLayout', check: true })
    run.event(claim(run, { locator: save, check: { matcher: 'toOverlap', other: help }, observationId: 'o1' }))
    run.event(claim(run, { type: 'assertion.failed', locator: save, check: { matcher: 'toOverlap', other: help, not: true }, observationId: 'o1' }))
    run.event(claim(run, { check: { matcher: 'toScrollHorizontally' }, observationId: 'o2' }))
    run.event(claim(run, { type: 'assertion.failed', locator: save, check: { matcher: 'toOverlap', other: help, not: true }, observationId: 'o1', failure: failure('setup_failed', 'Something else.') }))
    await run.finish()
    const [checked, claimedOther] = bodies(run, 'assertion.failed')
    assert.equal(checked?.failure.message, 'It did not match.', "a check's own class keeps the process's words, which say how long it looked")
    assert.equal(claimedOther?.failure.class, 'check_failed', 'the parent saw the check fail, so no other class stands')
    assert.equal(claimedOther?.failure.message, "getByTestId('save') and getByTestId('help') overlap: they share 32 by 32 pixels at 768 pixels wide.")
    assert.equal(claimedOther?.failure.details?.['also'], 'setup_failed: Something else.')
    const written = [...bodies(run, 'assertion.passed'), ...bodies(run, 'assertion.failed')]
    assert.deepEqual(
      written.map((event) => [event.type, event.matcher, event.actual?.text, event.layout]),
      [
        ['assertion.passed', 'toOverlap', 'share 32 by 32 pixels at 768 pixels wide', { viewport: { width: 768, height: 1024 }, edge: 768, shared: { across: 32, down: 32 } }],
        ['assertion.passed', 'toScrollHorizontally', 'document 1024 pixels wide at 768 pixels wide', { viewport: { width: 768, height: 1024 }, edge: 768, documentWidth: 1024 }],
        ['assertion.failed', 'not.toOverlap', 'share 32 by 32 pixels at 768 pixels wide', { viewport: { width: 768, height: 1024 }, edge: 768, shared: { across: 32, down: 32 } }],
        ['assertion.failed', 'not.toOverlap', 'share 32 by 32 pixels at 768 pixels wide', { viewport: { width: 768, height: 1024 }, edge: 768, shared: { across: 32, down: 32 } }],
      ],
    )
    assert.deepEqual(bodies(run, 'assertion.passed').map((event) => event.judgedBy), ['parent', 'parent'])
  })

  test('a layout assertion that claims a pass the look it names does not show is a protocol violation', async () => {
    const run = await scriptedTest({ fake: { layout: overlapping } })
    await run.command(1, { kind: 'observeLayout', locator: save, other: help, check: true })
    run.event(claim(run, { locator: save, check: { matcher: 'toOverlap', other: help, not: true }, observationId: 'o1' }))
    await violated(run, /sent assertion\.passed for expect\(getByTestId\('save'\)\)\.not\.toOverlap\(\), which fails on o1, the look it named/)
  })

  test('a layout assertion must name a layout look that measured what its check needs', async () => {
    const otherElement = await scriptedTest({ fake: { layout: overlapping } })
    await otherElement.command(1, { kind: 'observeLayout', locator: save, other: save, check: true })
    otherElement.event(claim(otherElement, { locator: save, check: { matcher: 'toOverlap', other: help }, observationId: 'o1' }))
    await violated(otherElement, /named o1, a layout look on page, for expect\(getByTestId\('save'\)\)\.toOverlap\(\) on page, which measures something else/)
    const noWords = await scriptedTest({ fake: { layout: overlapping } })
    await noWords.command(1, { kind: 'observeLayout', locator: save, check: true })
    noWords.event(claim(noWords, { type: 'assertion.failed', locator: save, check: { matcher: 'toHaveClippedText' }, observationId: 'o1' }))
    await violated(noWords, /which measures something else/)
    const locatorLook = await scriptedTest({ fake: { layout: overlapping } })
    await locatorLook.command(1, { kind: 'observe', locator: { by: 'testId', value: 'task-title' } })
    locatorLook.event(claim(locatorLook, { check: { matcher: 'toScrollHorizontally' }, observationId: 'o1' }))
    await violated(locatorLook, /named o1, a look at getByTestId\('task-title'\) on page, for expect\(page\)\.toScrollHorizontally\(\)/)
  })

  test('a page layout check sent for a locator, and an element check sent without one, are protocol violations', async () => {
    const onLocator = await scriptedTest({ fake: { layout: overlapping } })
    onLocator.event(claim(onLocator, { type: 'assertion.failed', locator: save, check: { matcher: 'toScrollHorizontally' } }))
    await violated(onLocator, /sent assertion\.failed for getByTestId\('save'\) with toScrollHorizontally, a check of the page/)
    const without = await scriptedTest({ fake: { layout: overlapping } })
    without.event(claim(without, { type: 'assertion.failed', check: { matcher: 'toOverflowViewport', not: true } }))
    await violated(without, /sent assertion\.failed with not\.toOverflowViewport without the locator it measures/)
  })

  test('a layout look on a page that measures none fails as the page refused it, and a pass without a look is refused', async () => {
    const run = await scriptedTest()
    const look = await run.command(1, { kind: 'observeLayout', check: true })
    assert.equal(look.ok ? undefined : look.failure.class, 'unsupported')
    run.event(claim(run, { check: { matcher: 'toScrollHorizontally' } }))
    await violated(run, /sent assertion\.passed for expect\(page\)\.toScrollHorizontally\(\) without naming the look it rested on/)
  })

  test("the other element's locator is held to the same rules as the first: a secret's value in it is refused before the page is asked", async () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-7391')
    const run = await scriptedTest({ redactor, fake: { layout: overlapping } })
    const look = await run.command(1, { kind: 'observeLayout', locator: save, other: { by: 'text', text: 'hunter2-7391' }, check: true })
    assert.equal(look.ok ? undefined : look.failure.class, 'usage')
    assert.match(look.ok ? '' : look.failure.message, /its locator's text holds the value of a secret/)
    const row = await run.command(2, { kind: 'observeLayout', locator: save, other: { by: 'role', role: 'row', name: 'Ada' }, check: true })
    assert.equal(row.ok ? undefined : row.failure.class, 'unsupported')
  })
})
