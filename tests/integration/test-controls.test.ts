import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, inspectJson, onlyEvent, resultOf, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'

// Release 1 test controls on real Chrome: test.skip and test.only with their describe forms, forbid-only when CI is
// set, --allow-only, and a per-call timeout on actions and goto. Every run sets CI itself, so the machine's own
// setting decides nothing here.

const notCi = { CI: '' }

const skipping = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test.skip('would fail if it ran', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('never there')
})

test.describe.skip('archive', (test) => {
  test('archives a task', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('archived')).toBeVisible()
  })
})
`

const focusing = {
  'tests/a.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test.only('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Groceries')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Groceries')
})

test('left out', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('never there')
})
`,
  'tests/b.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('also left out', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('never there')
})

test.describe.only('headings', (test) => {
  test('shows the heading', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  })
})
`,
}

async function project(t: TestContext, files: Readonly<Record<string, string>>): Promise<string> {
  const app = await openApp(t)
  return writeProject(t, { 'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`), ...files })
}

test('a skipped test is reported as skipped, never as passed, starts nothing, and the run passes on what ran', async (t) => {
  const root = await project(t, { 'tests/skip.retest.ts': skipping })
  const run = await runProject(t, root, { env: notCi })
  assert.equal(run.exit.code, 0, run.stderr)
  const result = resultOf(run)
  assert.deepEqual(result.counts, { passed: 1, failed: 0, error: 0, notRun: 0, inconclusive: 0, skipped: 2 })
  assert.equal(result.complete, true)
  assert.deepEqual(
    result.files.flatMap((file) => file.tests).map((each) => [each.name, each.status, each.assertionCount, each.evidence.length]),
    // In the order the file declares them, as collection lists them, whatever order they ended in.
    [
      ['saves a task', 'passed', 1, 0],
      ['would fail if it ran', 'skipped', 0, 0],
      ['archives a task', 'skipped', 0, 0],
    ],
  )
  const skippedIds = [testNamed(run, 'would fail if it ran').testId, testNamed(run, 'archives a task').testId]
  assert.deepEqual(eventsOf(run.events, 'test.started').map((event) => event.name), ['saves a task'], 'only the test that ran started')
  assert.deepEqual(
    eventsOf(run.events, 'test.finished').filter((event) => skippedIds.includes(event.testId)).map((event) => event.status),
    ['skipped', 'skipped'],
  )
  assert.deepEqual(eventsOf(run.events, 'action.completed').map((event) => event.command), ['goto', 'fill', 'click'], 'no skipped test acted on a page')

  const inspected = await inspectJson(t, run.output)
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  assert.deepEqual(inspected.result.counts, result.counts)
  const shown = await runCli(t, ['inspect', run.output, '--test', skippedIds[0] ?? ''], { cwd: root })
  assert.equal(shown.exit.code, 0, shown.stderr)
  assert.match(shown.stdout, /\n {2}Skipped\n/, 'inspect names the status and shows no time or checks for it')
  assert.doesNotMatch(shown.stdout, /Check failed/, 'a skipped test has no failure card')

  const listed = await runCli(t, ['list'], { cwd: root })
  assert.equal(listed.exit.code, 0, listed.stderr)
  assert.match(listed.stdout, /would fail if it ran \(skip\)/)
  assert.match(listed.stdout, /archive › archives a task \(skip\)/)
})

test('the human report marks skipped tests and counts them apart from passes', async (t) => {
  const root = await project(t, { 'tests/skip.retest.ts': skipping })
  const run = await runProject(t, root, { env: notCi, reporter: 'human' })
  assert.equal(run.exit.code, 0, run.stderr)
  assert.match(run.stdout, /○ would fail if it ran {2}skipped/)
  assert.match(run.stdout, /○ archive › archives a task {2}skipped/)
  assert.match(run.stdout, /Tests +1 passed · 2 skipped/)
})

test('test.only keeps only what it marks, in every file, and the run warns that it checked less than the suite', async (t) => {
  const root = await project(t, focusing)
  const run = await runProject(t, root, { env: notCi })
  assert.equal(run.exit.code, 0, run.stderr)
  const result = resultOf(run)
  assert.deepEqual(result.files.flatMap((file) => file.tests).map((each) => [each.name, each.status]), [
    ['saves a task', 'passed'],
    ['shows the heading', 'passed'],
  ])
  const narrowed = {
    only: [
      { file: 'tests/a.retest.ts', line: 3, column: 6 },
      { file: 'tests/b.retest.ts', line: 8, column: 15 },
    ],
    kept: 2,
    collected: 4,
  }
  assert.deepEqual(result.narrowed, narrowed)
  const event = onlyEvent(run.events, 'run.narrowed')
  assert.deepEqual({ only: event.only, kept: event.kept, collected: event.collected }, narrowed)

  const human = await runProject(t, root, { env: notCi, reporter: 'human' })
  assert.equal(human.exit.code, 0, human.stderr)
  assert.ok(human.stdout.includes('! test.only at tests/a.retest.ts:3 and tests/b.retest.ts:8 keeps 2 of 4 tests, so the run checks less than the suite.'), human.stdout)
  assert.match(human.stdout, /Exit +0 · narrowed by test\.only/)
  const agent = await runProject(t, root, { env: notCi, reporter: 'agent' })
  assert.match(agent.stdout, /^retest: 2 passed \(2\) in [^,]+, exit 0, narrowed by test\.only\nwarning: test\.only at tests\/a\.retest\.ts:3 and tests\/b\.retest\.ts:8 keeps 2 of 4 tests/)
})

test('with CI set, a run containing test.only fails before any test runs, naming each file and line, and --allow-only runs it', async (t) => {
  const root = await project(t, focusing)
  const refused = await runProject(t, root, { env: { CI: 'true' } })
  assert.equal(refused.exit.code, 2, refused.stderr)
  const result = resultOf(refused)
  assert.equal(result.failure?.class, 'usage')
  assert.equal(
    result.failure?.message,
    'test.only leaves out the rest of the suite, and this run refuses it: tests/a.retest.ts:3, tests/b.retest.ts:8. CI is set: remove test.only, or pass --allow-only to run it anyway.',
  )
  assert.deepEqual(eventsOf(refused.events, 'test.started'), [], 'no test started')
  assert.deepEqual(eventsOf(refused.events, 'browser.started'), [], 'no browser started')
  assert.ok(result.files.flatMap((file) => file.tests).every((each) => each.status === 'not_run'))

  const allowed = await runProject(t, root, { env: { CI: 'true' }, args: ['--allow-only'] })
  assert.equal(allowed.exit.code, 0, allowed.stderr)
  assert.deepEqual(resultOf(allowed).narrowed?.kept, 2)
})

test('a per-call timeout shortens the action and navigation budgets for that call only, and its event records it', async (t) => {
  const root = await project(t, {
    'tests/timeouts.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('a click gives up at its own timeout', async ({ page }) => {
  await page.goto('/', { timeout: 4000 })
  await test.step('click a button that is not there', async () => {
    await page.getByRole('button', { name: 'Publish' }).click({ timeout: 300 })
  })
})

test('a longer timeout keeps the budget', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Groceries', { timeout: 60000 })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Groceries')
})

test('goto gives up at its own timeout', async ({ page }) => {
  await page.goto('/hang', { timeout: 400 })
})
`,
  })
  const run = await runProject(t, root, { env: notCi, timeouts: budgets({ action: 2000, navigation: 5000 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  const click = testNamed(run, 'a click gives up at its own timeout')
  assert.equal(click.status, 'failed')
  assert.equal(click.failure?.class, 'not_found')
  assert.match(click.failure?.message ?? '', /within 300 ms/)
  assert.equal(click.failure?.location?.line, 6)
  const step = eventsOf(run.events, 'step.finished').find((event) => event.testId === click.testId)
  assert.equal(step?.status, 'failed')
  const failedClick = eventsOf(run.events, 'action.failed').find((event) => event.testId === click.testId)
  assert.deepEqual([failedClick?.command, failedClick?.timeoutMs], ['click', 300])
  assert.ok(failedClick !== undefined && failedClick.durationMs < 1500, `the click gave up after ${failedClick?.durationMs} ms, before the 2000 ms action budget`)
  const firstGoto = eventsOf(run.events, 'action.completed').find((event) => event.testId === click.testId)
  assert.deepEqual([firstGoto?.command, firstGoto?.timeoutMs], ['goto', 4000])

  const longer = testNamed(run, 'a longer timeout keeps the budget')
  assert.equal(longer.status, 'passed')
  const fill = eventsOf(run.events, 'action.completed').find((event) => event.testId === longer.testId && event.command === 'fill')
  assert.equal(fill?.timeoutMs, 2000, 'a timeout longer than the action budget is cut to it')
  const plain = eventsOf(run.events, 'action.completed').find((event) => event.testId === longer.testId && event.command === 'click')
  assert.equal(plain?.timeoutMs, undefined, 'a call that sets no timeout records none')

  const hang = testNamed(run, 'goto gives up at its own timeout')
  assert.equal(hang.status, 'failed')
  assert.equal(hang.failure?.class, 'timeout')
  assert.match(hang.failure?.message ?? '', /400 ms/)
  const failedGoto = eventsOf(run.events, 'action.failed').find((event) => event.testId === hang.testId)
  assert.deepEqual([failedGoto?.command, failedGoto?.timeoutMs], ['goto', 400])
  assert.ok(failedGoto !== undefined && failedGoto.durationMs < 3000, `goto gave up after ${failedGoto?.durationMs} ms, before the 5000 ms navigation budget`)
})
