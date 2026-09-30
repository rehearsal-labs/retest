import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, childLog, configSource, eventsOf, onlyEvent, resultOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// Acceptance check 9: hooks run in order, afterEach runs after a failure and keeps the original one, and
// test.describe and test.for name their tests, with duplicate names refused.

const log = (text: string) => `async () => {
    console.log('hook ${text}')
  }`

const hookTests = `import { expect, test } from '@rehearsal-labs/retest'

test.beforeEach(${log('file before')})
test.afterEach(${log('file after')})

test.describe('outer', (test) => {
  test.beforeEach(${log('outer before 1')})
  test.beforeEach(${log('outer before 2')})
  test.afterEach(${log('outer after 1')})
  test.afterEach(${log('outer after 2')})

  test.describe('inner', (test) => {
    test.beforeEach(${log('inner before')})
    test.afterEach(${log('inner after')})

    test('runs its hooks in order', async () => {
      console.log('hook test body')
      expect(1).toBe(1)
    })
  })
})

test.describe('cleanup', (test) => {
  test.afterEach(async ({ page }) => {
    console.log('hook cleanup after ran')
    await expect(page.getByTestId('saved-task')).toHaveText('never there')
  })

  test('fails before its afterEach', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  })
})

test.describe('rows', { tags: ['smoke'] }, (test) => {
  test.for([{ title: 'Release checklist', count: 1 }, { title: 'Groceries', count: 2 }])('saves "$title" as number $count', async (_context, { count }) => {
    expect(typeof count).toBe('number')
  })
})
`

// The line a hook that prints `hook <text>` is declared on: the line before the one that prints it.
function hookLine(text: string): number {
  return hookTests.split('\n').findIndex((line) => line.includes(`'hook ${text}'`))
}

function lineOf(source: string, text: string): number {
  return source.split('\n').findIndex((line) => line.includes(text)) + 1
}

test('hooks run outermost beforeEach first and innermost afterEach first, and afterEach keeps the first failure', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/hooks.retest.ts': hookTests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 500 }) })

  assert.equal(run.exit.code, 1, run.stderr)
  const ordered = testNamed(run, 'runs its hooks in order')
  assert.deepEqual([ordered.status, ordered.testId, ordered.describePath], [
    'passed',
    'tests/hooks.retest.ts > outer > inner > runs its hooks in order',
    ['outer', 'inner'],
  ])
  const printed = childLog(run, 'tests/hooks.retest.ts').split('\n').filter((line) => line.startsWith('hook '))
  assert.deepEqual(printed.slice(0, 9), [
    'hook file before',
    'hook outer before 1',
    'hook outer before 2',
    'hook inner before',
    'hook test body',
    'hook inner after',
    'hook outer after 1',
    'hook outer after 2',
    'hook file after',
  ])
  const hookSteps = eventsOf(run.events, 'step.started').filter((event) => event.testId === ordered.testId)
  assert.deepEqual(
    hookSteps.map((event) => [event.hook, event.location?.line]),
    [
      ['beforeEach', hookLine('file before')],
      ['beforeEach', hookLine('outer before 1')],
      ['beforeEach', hookLine('outer before 2')],
      ['beforeEach', hookLine('inner before')],
      ['afterEach', hookLine('inner after')],
      ['afterEach', hookLine('outer after 1')],
      ['afterEach', hookLine('outer after 2')],
      ['afterEach', hookLine('file after')],
    ],
  )

  const cleanup = testNamed(run, 'fails before its afterEach')
  assert.equal(cleanup.status, 'failed')
  assert.equal(cleanup.failure?.class, 'check_failed')
  assert.equal(cleanup.failure?.location?.line, lineOf(hookTests, "toHaveText('Release checklist')"), 'the failure is the test own, not the hook')
  assert.match(String(cleanup.failure?.details?.['also']), /check_failed: .*never there/s)
  assert.ok(printed.includes('hook cleanup after ran'))
  const cleanupSteps = eventsOf(run.events, 'step.finished').filter((event) => event.testId === cleanup.testId)
  assert.deepEqual(cleanupSteps.map((event) => event.status), ['passed', 'failed', 'passed'], 'file before, then the cleanup afterEach failed, then the file afterEach ran')

  const rows = resultOf(run).files.flatMap((file) => file.tests).filter((each) => each.describePath?.[0] === 'rows')
  assert.deepEqual(
    rows.map((each) => [each.testId, each.status]),
    [
      ['tests/hooks.retest.ts > rows > saves "Release checklist" as number 1', 'passed'],
      ['tests/hooks.retest.ts > rows > saves "Groceries" as number 2', 'passed'],
    ],
  )
  const collected = onlyEvent(run.events, 'collection.completed').tests.filter((each) => each.describePath?.[0] === 'rows')
  assert.deepEqual(collected.map((each) => each.tags), [['smoke'], ['smoke']], 'a block passes its tags down')
})

test('two tests, two test.for rows or two blocks with one name each fail their file, and nothing in it runs', async (t) => {
  const app = await openApp(t)
  const header = `import { expect, test } from '@rehearsal-labs/retest'\n\n`
  const body = `async () => {\n  expect(1).toBe(1)\n}`
  const blocks = `${header}test.describe('tasks', (test) => {\n  test('saves', ${body})\n})\n\ntest.describe('tasks', (test) => {\n  test('archives', ${body})\n})\n`
  const names = `${header}test.describe('tasks', (test) => {\n  test('saves', ${body})\n  test('saves', ${body})\n})\n`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/rows.retest.ts': `${header}test.for([{ title: 'Groceries' }, { title: 'Groceries' }])('saves $title', ${body})\n`,
    'tests/blocks.retest.ts': blocks,
    'tests/names.retest.ts': names,
  })
  const [firstBlock, secondBlock] = blocks.split('\n').flatMap((line, index) => (line.startsWith('test.describe') ? [index + 1] : []))
  const [firstName, secondName] = names.split('\n').flatMap((line, index) => (line.includes("test('saves'") ? [index + 1] : []))
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 2, run.stderr)
  const messages = Object.fromEntries(eventsOf(run.events, 'collection.failed').map((event) => [event.file, event.failure.message]))
  assert.deepEqual(messages, {
    'tests/blocks.retest.ts': `Two test.describe blocks are named "tasks", on lines ${firstBlock} and ${secondBlock}. Give each its own name.`,
    'tests/names.retest.ts': `Two tests are named "tasks > saves", on lines ${firstName} and ${secondName}. Give each test its own name.`,
    'tests/rows.retest.ts': 'Rows 1 and 2 of test.for() are both named "saves Groceries". Put a $key whose value differs between them in the name.',
  })
  assert.deepEqual(eventsOf(run.events, 'test.started'), [])
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [])
})
