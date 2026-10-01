import type { CommandResult, PageCommand } from '../../src/protocol/commands.ts'
import type { ChildEvent, EventBody } from '../../src/protocol/events.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { SecretFillContext } from '../../src/runner/running-test.ts'
import type { ScriptedTest } from '../support/scripted-process.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { failure, truncateText } from '../../src/protocol/failures.ts'
import { resultFile, testId } from '../../src/protocol/run-folder.ts'
import { Redactor } from '../../src/runner/redactor.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType, runSupportFiles, supportFile } from '../support/run-harness.ts'
import { scriptedApp, scriptedTest } from '../support/scripted-process.ts'

type Body<Type extends EventBody['type']> = Extract<EventBody, { type: Type }>

const origin = 'http://127.0.0.1:4173'
const titles = { '/': 'Home', '/tasks': 'Tasks', '/login': 'Sign in' }
const link: LocatorRecipe = { by: 'testId', value: 'tasks-link' }
const field: LocatorRecipe = { by: 'testId', value: 'task-title' }
const saveTask: LocatorRecipe = { by: 'testId', value: 'save-task' }

function bodies<Type extends EventBody['type']>(run: ScriptedTest, type: Type): Body<Type>[] {
  return run.events.map(({ body }) => body).filter((body): body is Body<Type> => body.type === type)
}

// A command sent from inside a step, as the test process sends it.
function commandIn(run: ScriptedTest, id: number, command: PageCommand, stepId: string): Promise<CommandResult> {
  run.process.deliver({ type: 'command', id, app: scriptedApp, command, timeoutMs: 500, stepId })
  return run.process.answer(id)
}

function navigations(run: ScriptedTest): [string, string | undefined, string | undefined, string | undefined][] {
  return bodies(run, 'navigation').map((event) => [event.url.slice(origin.length), event.title, event.cause, event.stepId])
}

describe('navigations', () => {
  test('each names its title, what started it and the step the test was in when it committed', async () => {
    const run = await scriptedTest({ fake: { titles } })
    await commandIn(run, 1, { kind: 'goto', url: '/' }, 'step-1')
    await commandIn(run, 2, { kind: 'click', locator: link }, 'step-2')
    run.page.navigate('/login')
    await commandIn(run, 3, { kind: 'observe', locator: saveTask }, 'step-3')
    await run.finish()
    assert.deepEqual(navigations(run), [
      ['/', 'Home', 'goto', 'step-1'],
      ['/tasks', 'Tasks', 'action', 'step-2'],
      ['/login', 'Sign in', 'page', 'step-2'],
    ])
  })

  test('one whose title comes late waits for it, and is written before any event of a command that began after it committed', async () => {
    const run = await scriptedTest({ fake: { titles, titleDelayMs: 60_000 } })
    await run.command(1, { kind: 'goto', url: '/' })
    await run.command(2, { kind: 'click', locator: link })
    assert.deepEqual(navigations(run), [['/', 'Home', 'goto', undefined]], 'the link opened a page whose title has not come')
    run.page.documentTitle = 'Tasks (3)'
    await run.command(3, { kind: 'observe', locator: saveTask })
    await run.finish()
    const order = run.events.map(({ body }) => (body.type === 'navigation' ? `navigation ${body.url.slice(origin.length)}` : body.type))
    assert.deepEqual(order, ['navigation /', 'action.completed', 'action.completed', 'navigation /tasks', 'observation'])
    assert.deepEqual(navigations(run)[1], ['/tasks', 'Tasks (3)', 'action', undefined], 'the title the page had when it settled')
  })

  test('one whose title never comes is written without one when the test ends', async () => {
    const run = await scriptedTest({ fake: { titles, titleDelayMs: 60_000 } })
    await run.command(1, { kind: 'click', locator: link })
    assert.deepEqual(navigations(run), [], 'nothing is written while the title may still come')
    await run.finish()
    assert.deepEqual(navigations(run), [['/tasks', undefined, 'action', undefined]])
  })

  test('one still waiting when the browser is lost is written without its title, before the command the page answered, which keeps its answer', async () => {
    const run = await scriptedTest({ fake: { titles, titleDelayMs: 60_000, disconnect: { on: 'click', stage: 'before_input' } } })
    await run.command(1, { kind: 'goto', url: '/' })
    run.page.navigate('/login')
    const clicked = run.command(2, { kind: 'click', locator: saveTask })
    await new Promise((resolve) => setImmediate(resolve))
    run.running.browserLost('The browser process exited.')
    const answer = await clicked
    const report = await run.report
    await run.running.settle(0)
    run.running.close()
    const lost = "The page lost its browser before getByTestId('save-task').click() sent any input: The browser process exited."
    assert.deepEqual(answer.ok ? undefined : [answer.failure.class, answer.failure.message], ['session_lost', lost])
    assert.deepEqual([report.failure?.class, report.failure?.message.startsWith(lost)], ['session_lost', true], 'the test ends with the page\'s own answer')
    const order = run.events.map(({ body }) => (body.type === 'navigation' ? `navigation ${body.url.slice(origin.length)} ${body.title ?? '(no title)'} ${body.cause}` : body.type))
    assert.deepEqual(order, ['navigation / Home goto', 'action.completed', 'navigation /login (no title) page', 'action.failed'])
    const [click] = bodies(run, 'action.failed')
    assert.deepEqual([click?.failure.class, click?.failure.message], ['session_lost', lost], 'the page answered, so nothing about it is unknown')
  })

  describe('in a run', async () => {
    const file = supportFile('titles.retest.ts')
    const check = { kind: 'address', origin, path: '/tasks' } as const
    const run = (titleDelayMs: number) =>
      runSupportFiles(['titles.retest.ts'], { fake: { titles, titleDelayMs }, hostChecks: { [file]: [check] }, timeouts: { cleanup: 300 } })
    const late = await run(100)
    const never = await run(60_000)

    test('every navigation of the body is written before the host checks and before the test finishes, with the step it committed in', () => {
      const step = eventsOfType(late.events, 'step.started').find((event) => event.name === 'open the tasks')
      for (const [record, title] of [
        [late, 'Tasks'],
        [never, undefined],
      ] as const) {
        const written = eventsOfType(record.events, 'navigation').map((event) => [event.url.slice(origin.length), event.title, event.cause, event.stepId === undefined ? undefined : 'step'])
        assert.deepEqual(written, [
          ['/', 'Home', 'goto', undefined],
          ['/tasks', title, 'action', 'step'],
        ])
        const types = record.events.map((event) => event.type)
        assert.ok(types.lastIndexOf('navigation') < types.indexOf('host_check.passed'))
        assert.ok(types.indexOf('host_check.passed') < types.indexOf('test.finished'))
        assert.equal(record.result.exitCode, 0)
      }
      assert.equal(eventsOfType(late.events, 'navigation')[1]?.stepId, step?.stepId)
    })

    test("the app's last navigation before its host checks says what opened the page they read, and a check records the page's title", () => {
      const [last] = eventsOfType(late.events, 'navigation').slice(-1)
      assert.equal(last?.cause, 'action')
      assert.deepEqual(eventsOfType(late.events, 'host_check.passed')[0]?.actual, { url: `${origin}/tasks`, title: 'Tasks' })
    })
  })
})

describe('the page each event names', () => {
  test('an action, a look and the assertion that rests on it name the page they went to, with its title', async () => {
    const run = await scriptedTest({ fake: { titles } })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    await run.command(2, { kind: 'fill', locator: field, value: 'Release' })
    const look = await run.command(3, { kind: 'observe', locator: field })
    const passed: ChildEvent = {
      type: 'assertion.passed',
      testId: run.testId,
      attemptId: run.attemptId,
      matcher: 'toHaveValue',
      expected: truncateText('Release'),
      actual: truncateText('Release'),
      attempts: 1,
      durationMs: 1,
      locator: field,
      check: { matcher: 'toHaveValue', value: 'Release' },
      observationId: 'o1',
      pageUrl: 'http://evil.example/claimed',
      pageTitle: 'Claimed',
    }
    run.event(passed)
    await run.finish()
    const page = { pageUrl: `${origin}/tasks`, pageTitle: 'Tasks' }
    const named = [...bodies(run, 'action.completed'), ...bodies(run, 'observation'), ...bodies(run, 'assertion.passed')]
    assert.deepEqual(
      named.map((event) => [event.type, event.pageUrl, event.pageTitle]),
      [
        ['action.completed', page.pageUrl, page.pageTitle],
        ['action.completed', page.pageUrl, page.pageTitle],
        ['observation', page.pageUrl, page.pageTitle],
        ['assertion.passed', page.pageUrl, page.pageTitle],
      ],
    )
    assert.deepEqual(look.ok ? look.page : undefined, { url: `${origin}/tasks`, title: 'Tasks' }, 'the test process is told the page too')
  })

  test('an action that fails, and an assertion that named no look, name the page with the title it had', async () => {
    const run = await scriptedTest({ fake: { titles } })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    await run.command(2, { kind: 'click', locator: { by: 'testId', value: 'missing' } })
    run.event({
      type: 'assertion.failed',
      testId: run.testId,
      attemptId: run.attemptId,
      matcher: 'toBeVisible',
      expected: truncateText('visible'),
      actual: null,
      attempts: 1,
      durationMs: 1,
      locator: { by: 'testId', value: 'missing' },
      check: { matcher: 'toBeVisible' },
      pageTitle: 'Claimed',
      failure: failure('check_failed', 'It did not show.'),
    })
    await run.finish()
    const [click] = bodies(run, 'action.failed')
    const [assertion] = bodies(run, 'assertion.failed')
    assert.deepEqual([click?.pageUrl, click?.pageTitle], [`${origin}/tasks`, 'Tasks'])
    assert.deepEqual([assertion?.pageUrl, assertion?.pageTitle], [`${origin}/tasks`, 'Tasks'])
  })

  test('an action that fails after the page moved names the page it was looked for on, after that page\'s navigation', async () => {
    const run = await scriptedTest({ fake: { titles, titleDelayMs: 800 } })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    const clicked = run.command(2, { kind: 'click', locator: { by: 'testId', value: 'missing' } })
    await new Promise((resolve) => setImmediate(resolve))
    run.page.navigate('/login')
    const answer = await clicked
    await run.finish()
    assert.equal(answer.ok ? undefined : answer.failure.class, 'not_found')
    const [click] = bodies(run, 'action.failed')
    assert.deepEqual([click?.pageUrl, click?.pageTitle], [`${origin}/login`, 'Sign in'], 'the page the element was looked for on, with the title that came late')
    const order = run.events.map(({ body }) => (body.type === 'navigation' ? `navigation ${body.url.slice(origin.length)}` : body.type))
    assert.deepEqual(order, ['navigation /tasks', 'action.completed', 'navigation /login', 'action.failed'])
  })

  test('a title holding a secret reaches the test process redacted, in each answer that names the page', async () => {
    const redactor = new Redactor()
    redactor.learn('password', 'hunter2')
    const run = await scriptedTest({ redactor, fake: { titles: { '/tasks': 'Signed in as hunter2' } } })
    const answers = [
      await run.command(1, { kind: 'goto', url: '/tasks' }),
      await run.command(2, { kind: 'observe', locator: field }),
      await run.command(3, { kind: 'click', locator: saveTask }),
    ]
    await run.finish()
    for (const answer of answers) assert.deepEqual(answer.ok ? answer.page : undefined, { url: `${origin}/tasks`, title: 'Signed in as {{password}}' })
    assert.ok(!JSON.stringify(run.process.sent).includes('hunter2'), 'no message to the test process holds the value')
  })
})

describe('a secret fill', () => {
  test("checks the page's address as it stands now, and is told when its test is stopped", async () => {
    const asked = Promise.withResolvers<SecretFillContext>()
    const run = await scriptedTest({
      fake: { titles },
      fillSecret: async (_command, context) => {
        asked.resolve(context)
        await new Promise((resolve) => context.signal.addEventListener('abort', resolve, { once: true }))
        return { ok: false, failure: failure('interrupted', 'The fill was stopped.') }
      },
    })
    await run.command(1, { kind: 'goto', url: '/tasks' })
    run.page.url = 'https://evil.example/login'
    const filled = run.command(2, { kind: 'fill', locator: field, value: { secret: 'password' } })
    const context = await asked.promise
    assert.equal(context.pageUrl, 'https://evil.example/login', 'the address the page is on, which no navigation announced')
    assert.equal(context.signal.aborted, false)
    run.running.revoke(failure('interrupted', 'The run was interrupted.'), 0)
    await filled
    assert.equal(context.signal.aborted, true)
    await run.report
  })
})

describe('titles in a run', async () => {
  const variable = 'RETEST_UNIT_TITLE_PASSWORD'
  const password = 'hunter2-4410'
  const config = `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: '${origin}', executablePath: '/fake/chromium' }) },
  secrets: { password: env('${variable}') },
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('shows the account', async ({ page }) => {
  await page.goto('/account')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`
  const file = 'tests/account.retest.ts'
  const record = await runProject(tempProject({ 'retest.config.ts': config, [file]: tests }), {
    files: [file],
    env: { [variable]: password },
    fake: { titles: { '/account': `Signed in as ${password}` } },
    hostChecks: { [testId(file, 'shows the account')]: [{ kind: 'text', text: 'Save' }] },
  })

  test('a title holding a secret reads {{name}} in every event that records it, and nothing written holds the value', () => {
    const shown = 'Signed in as {{password}}'
    const events = record.events
    assert.equal(record.result.exitCode, 0)
    assert.deepEqual(eventsOfType(events, 'navigation').map((event) => event.title), [shown])
    assert.deepEqual(eventsOfType(events, 'action.completed').map((event) => event.pageTitle), [shown, shown])
    assert.deepEqual([...eventsOfType(events, 'observation'), ...eventsOfType(events, 'assertion.passed')].map((event) => event.pageTitle).slice(-2), [shown, shown])
    assert.equal(eventsOfType(events, 'host_check.passed')[0]?.actual.title, shown)
    assert.ok(!record.lines.some((line) => line.includes(password)), 'no event holds the value')
    assert.ok(!readFileSync(join(record.folder, resultFile), 'utf8').includes(password))
  })
})

// The browser hands a title over long, and the parent redacts it before it cuts it to the length it records.
describe('long titles in a run', async () => {
  const variable = 'RETEST_UNIT_LONG_TITLE_PASSWORD'
  const password = 'hunter2-4410'
  const kept = 'a'.repeat(295)
  const config = `import { chromium, defineConfig, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chromium({ baseUrl: '${origin}', executablePath: '/fake/chromium' }) },
  secrets: { password: env('${variable}') },
})
`
  const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('opens pages with long titles', async ({ page }) => {
  await page.goto('/spanning')
  await page.goto('/after')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
`
  const file = 'tests/long.retest.ts'
  const record = await runProject(tempProject({ 'retest.config.ts': config, [file]: tests }), {
    files: [file],
    env: { [variable]: password },
    fake: { titles: { '/spanning': `${kept}${password} is signed in`, '/after': `${'b'.repeat(305)} ${password}` } },
  })

  test('a secret that runs across the cut is hidden whole, and one that starts after it is gone with the rest', () => {
    assert.equal(record.result.exitCode, 0)
    const titles = eventsOfType(record.events, 'navigation').map((event) => event.title)
    assert.deepEqual(titles, [`${kept}{{pas`, 'b'.repeat(300)])
    assert.equal(eventsOfType(record.events, 'assertion.passed')[0]?.pageTitle, 'b'.repeat(300))
    assert.deepEqual(eventsOfType(record.events, 'action.completed').map((event) => event.pageTitle), titles)
    assert.ok(!record.lines.some((line) => line.includes(password.slice(0, 2))), 'no event holds any part of the value')
  })
})
