import type { ChildEvent, EventBody } from '../../src/protocol/events.ts'
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

const title: LocatorRecipe = { by: 'testId', value: 'task-title' }
const missing: LocatorRecipe = { by: 'testId', value: 'missing' }

function bodies<Type extends EventBody['type']>(run: ScriptedTest, type: Type): Body<Type>[] {
  return run.events.map(({ body }) => body).filter((body): body is Body<Type> => body.type === type)
}

type Claim = { type?: 'assertion.passed' | 'assertion.failed'; locator?: LocatorRecipe; check?: CheckRecord; matcher?: string; observationId?: string; sessionId?: string }

// An assertion as a test process sends it, with values of its own that the parent must not keep. One that names a
// look sends back the session this run's page was served in, as Retest's own test process does, unless it names
// another.
function claim(run: ScriptedTest, { type = 'assertion.passed', ...fields }: Claim): Extract<ChildEvent, { type: 'assertion.passed' | 'assertion.failed' }> {
  const reference = fields.observationId === undefined ? {} : { sessionId: formatSessionId(run.attemptId, scriptedApp) }
  const common = {
    testId: run.testId,
    attemptId: run.attemptId,
    session: 'page',
    matcher: 'as the process pleases',
    expected: truncateText('what the process says'),
    actual: truncateText('what the process saw'),
    attempts: 2,
    durationMs: 5,
    pageUrl: 'http://evil.example/claimed',
    ...reference,
    ...fields,
  }
  return type === 'assertion.passed' ? { type, ...common } : { type, ...common, failure: failure('check_failed', 'It did not match.') }
}

async function violated(run: ScriptedTest, pattern: RegExp): Promise<void> {
  const report = await run.report
  assert.equal(report.failure?.class, 'test_error')
  assert.match(report.failure?.message ?? '', pattern)
  assert.deepEqual([...bodies(run, 'assertion.passed'), ...bodies(run, 'assertion.failed')], [], 'no assertion is written')
}

describe('looks at the page', () => {
  test('a look at the page is served with an id and its session, counted with the looks at locators, and writes no observation event', async () => {
    const run = await scriptedTest({ fake: { titles: { '/tasks': 'Tasks' } } })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    const locator = await run.command(2, { kind: 'observe', locator: title })
    const look = await run.command(3, { kind: 'observePage' })
    await run.finish()
    assert.ok(look.ok && look.kind === 'observePage', JSON.stringify(look))
    assert.deepEqual([look.observationId, look.sessionId, look.observation], ['o2', 'attempt1:page', { url: 'http://127.0.0.1:4173/tasks', title: 'Tasks' }])
    assert.equal(locator.ok && locator.kind === 'observe' ? locator.observationId : undefined, 'o1')
    assert.deepEqual(bodies(run, 'observation').map((event) => event.observationId), ['o1'])
    assert.deepEqual(bodies(run, 'action.completed').map((event) => event.command), ['goto'], 'a look is no action')
  })

  test("a page assertion is judged by the parent on the look it names, and records that look's address and title", async () => {
    const run = await scriptedTest({ fake: { titles: { '/tasks': 'Tasks' } } })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    await run.command(2, { kind: 'observePage' })
    run.event(claim(run, { check: { matcher: 'toHaveURL', url: '/tasks' }, observationId: 'o1', sessionId: 'attempt1:page' }))
    run.event(claim(run, { check: { matcher: 'toHaveTitle', title: 'Login', not: true }, observationId: 'o1' }))
    run.event(claim(run, { type: 'assertion.failed', check: { matcher: 'toHaveTitle', pattern: { pattern: '^Log', flags: '' } }, observationId: 'o1' }))
    const report = await run.finish()
    assert.equal(report.failure, undefined)
    const written = [...bodies(run, 'assertion.passed'), ...bodies(run, 'assertion.failed')]
    assert.deepEqual(
      written.map((event) => [event.type, event.matcher, event.expected?.text, event.actual?.text, event.pageUrl, event.pageTitle, event.observationId]),
      [
        ['assertion.passed', 'toHaveURL', '/tasks', 'http://127.0.0.1:4173/tasks', 'http://127.0.0.1:4173/tasks', 'Tasks', 'o1'],
        ['assertion.passed', 'not.toHaveTitle', 'Login', 'Tasks', 'http://127.0.0.1:4173/tasks', 'Tasks', 'o1'],
        ['assertion.failed', 'toHaveTitle', '/^Log/', 'Tasks', 'http://127.0.0.1:4173/tasks', 'Tasks', 'o1'],
      ],
    )
    assert.deepEqual(bodies(run, 'assertion.passed').map((event) => event.judgedBy), ['parent', 'parent'])
  })

  test('a page assertion that claims a pass the look it names does not show is a protocol violation', async () => {
    const run = await scriptedTest({ fake: { titles: { '/tasks': 'Tasks' } } })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    await run.command(2, { kind: 'observePage' })
    run.event(claim(run, { check: { matcher: 'toHaveURL', url: '/login' }, observationId: 'o1' }))
    await violated(run, /sent assertion\.passed for expect\(page\)\.toHaveURL\(\), which fails on o1, the look it named/)
  })

  test('a page check on a locator, a locator check on a look at the page, and the reverse, are protocol violations', async () => {
    const onLocator = await scriptedTest()
    await onLocator.command(1, { kind: 'observePage' })
    onLocator.event(claim(onLocator, { locator: title, check: { matcher: 'toHaveTitle', title: '' }, observationId: 'o1' }))
    await violated(onLocator, /sent assertion\.passed for getByTestId\('task-title'\) with toHaveTitle, a check of the page/)
    const lookAtPage = await scriptedTest()
    await lookAtPage.command(1, { kind: 'observePage' })
    lookAtPage.event(claim(lookAtPage, { locator: title, check: { matcher: 'toBeHidden' }, observationId: 'o1' }))
    await violated(lookAtPage, /named o1, a look at the page of page, for an assertion on getByTestId\('task-title'\) on page/)
    const lookAtLocator = await scriptedTest()
    await lookAtLocator.command(1, { kind: 'observe', locator: title })
    lookAtLocator.event(claim(lookAtLocator, { check: { matcher: 'toHaveTitle', title: '' }, observationId: 'o1' }))
    await violated(lookAtLocator, /named o1, a look at getByTestId\('task-title'\) on page, for an assertion on the page of page/)
  })

  test("a look's session that another attempt served is refused, as for a locator", async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observePage' })
    run.event(claim(run, { check: { matcher: 'toHaveURL', pattern: { pattern: '.', flags: '' } }, observationId: 'o1', sessionId: 'earlier:page' }))
    await violated(run, /named o1 of the session "earlier:page", but the session "attempt1:page" served this test's o1/)
  })

  test("a page assertion that names its look without the session that served it is refused, as for a locator", async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observePage' })
    const { sessionId: _sessionId, ...withoutSession } = claim(run, { type: 'assertion.failed', check: { matcher: 'toHaveURL', url: '/tasks' }, observationId: 'o1' })
    run.event(withoutSession)
    await violated(run, /named the look "o1" without the session that served it/)
  })

  test('a secret in the title or address is hidden in what the process receives and in what the parent writes', async () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-7391')
    const run = await scriptedTest({ redactor, fake: { titles: { '/hunter2-7391': 'Hi hunter2-7391' } } })
    await run.command(1, { kind: 'goto', url: '/hunter2-7391' })
    const look = await run.command(2, { kind: 'observePage' })
    run.event(claim(run, { check: { matcher: 'toHaveTitle', title: 'Hi {{password}}' }, observationId: 'o1' }))
    await run.finish()
    assert.deepEqual(look.ok && look.kind === 'observePage' ? look.observation : undefined, { url: 'http://127.0.0.1:4173/{{password}}', title: 'Hi {{password}}', hidden: ['url', 'title'] })
    const [written] = bodies(run, 'assertion.passed')
    assert.deepEqual([written?.actual?.text, written?.pageUrl, written?.pageTitle], ['Hi {{password}}', 'http://127.0.0.1:4173/{{password}}', 'Hi {{password}}'])
  })

  test('a negated pass on a title that holds a hidden secret is refused: the parent judges the look as the process received it, and cannot tell', async () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2-7391')
    const run = await scriptedTest({ redactor, fake: { titles: { '/tasks': 'Hi hunter2-7391' } } })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    await run.command(2, { kind: 'observePage' })
    run.event(claim(run, { check: { matcher: 'toHaveTitle', title: 'Hi there', not: true }, observationId: 'o1' }))
    await violated(run, /sent assertion\.passed for expect\(page\)\.not\.toHaveTitle\(\), which fails on o1, the look it named/)
  })

  test('a pass of a page or locator matcher that sends no check and names no look is refused, as if it were a value', async () => {
    for (const matcher of ['toHaveURL', 'not.toHaveTitle', 'toBeVisible']) {
      const run = await scriptedTest()
      await run.command(1, { kind: 'observePage' })
      run.event(claim(run, { matcher }))
      await violated(run, new RegExp(`sent assertion\\.passed for ${matcher.replace('.', '\\.')} without the check it made or the look it rested on`))
    }
    const value = await scriptedTest()
    value.event(claim(value, { matcher: 'toBe' }))
    await value.finish()
    assert.deepEqual(bodies(value, 'assertion.passed').map((event) => [event.matcher, event.judgedBy]), [['toBe', 'child']], 'a value matcher is still the process\'s own claim')
  })
})

describe('negated locator assertions, as the parent judges them', () => {
  test('not.toBeVisible passes on a look with no match, as Playwright documents', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: missing })
    run.event(claim(run, { locator: missing, check: { matcher: 'toBeVisible', not: true }, observationId: 'o1' }))
    await run.finish()
    assert.deepEqual(bodies(run, 'assertion.passed').map((event) => [event.matcher, event.expected?.text, event.judgedBy]), [['not.toBeVisible', 'not visible', 'parent']])
  })

  test('a negated pass on a look that shows the condition true, or on a missing element, is a protocol violation', async () => {
    const visible = await scriptedTest()
    await visible.command(1, { kind: 'observe', locator: title })
    visible.event(claim(visible, { locator: title, check: { matcher: 'toBeVisible', not: true }, observationId: 'o1' }))
    await violated(visible, /sent assertion\.passed for expect\(getByTestId\('task-title'\)\)\.not\.toBeVisible\(\), which fails on o1/)
    const gone = await scriptedTest()
    await gone.command(1, { kind: 'observe', locator: missing })
    gone.event(claim(gone, { locator: missing, check: { matcher: 'toHaveText', text: 'Draft', not: true }, observationId: 'o1' }))
    await violated(gone, /\.not\.toHaveText\(\), which fails on o1, the look it named, where nothing matched/)
  })

  test('a check the parent cannot read, such as a broken pattern, is a protocol violation', async () => {
    const run = await scriptedTest()
    await run.command(1, { kind: 'observe', locator: title })
    run.event(claim(run, { locator: title, check: { matcher: 'toHaveText', pattern: { pattern: '(', flags: '' } }, observationId: 'o1' }))
    await violated(run, /with a check Retest cannot read: Invalid regular expression/)
  })
})
