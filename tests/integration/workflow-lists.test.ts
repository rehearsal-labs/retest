import assert from 'node:assert/strict'
import { test } from 'node:test'
import { INVOICE_COUNT, invoiceAmountOf, TEAM } from '../../fixtures/task-app/workflow-lists-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 8, find items in lists and tables, against real Chrome and the task app's team table
// and its long list of invoices. The cases are F8.1 to F8.4 in docs/compatibility/workflow-cases.md.

const file = 'tests/lists.retest.ts'
const assertFailedAt = failedAtIn(file)

const byName = TEAM.map((member) => member.name).sort((first, second) => first.localeCompare(second, 'en'))
const byTasks = TEAM.map((member) => member.tasks).sort((first, second) => first - second)

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('reads the table row by row and finds a member by name', async ({ page }) => {
  await page.goto('/workflow/team')
  await expect(page.getByTestId('member')).toHaveCount(${TEAM.length})
  await expect(page.getByRole('row')).toHaveText(${JSON.stringify(['Name Email Role Open tasks', ...TEAM.map((member) => `${member.name} ${member.email} ${member.role} ${member.tasks}`)])})
  await expect(page.getByRole('row').nth(2).getByRole('cell').first()).toHaveText('Grace Hopper')
  await expect(page.getByRole('row').nth(2).getByRole('cell').nth(1)).toHaveText('grace@example.com')
  await expect(page.getByRole('row').last().getByRole('cell').last()).toHaveText('10')
  await expect(page.getByRole('cell', { name: 'Grace Hopper' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'katherine@example.com' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Role' })).toBeVisible()
})

test('a check that no row has a name the table shows is refused, not passed', async ({ page }) => {
  await page.goto('/workflow/team')
  await expect(page.getByRole('row', { name: ${JSON.stringify(`${TEAM[1]?.name} ${TEAM[1]?.email} ${TEAM[1]?.role} ${TEAM[1]?.tasks}`)} })).toHaveCount(0)
})

test('a check that a row shown by name is hidden is refused, not passed', async ({ page }) => {
  await page.goto('/workflow/team')
  await expect(page.getByRole('row', { name: ${JSON.stringify(`${TEAM[1]?.name} ${TEAM[1]?.email} ${TEAM[1]?.role} ${TEAM[1]?.tasks}`)} })).toBeHidden()
})

test('sorts the table by name one way and then the other', async ({ page }) => {
  await page.goto('/workflow/team')
  await page.getByRole('button', { name: 'Name' }).click()
  await expect(page.getByTestId('member-name')).toHaveText(${JSON.stringify(byName)})
  await page.getByRole('button', { name: 'Name' }).click()
  await expect(page.getByTestId('member-name')).toHaveText(${JSON.stringify(byName.toReversed())})
})

test('finds an invoice far down a long list and opens it', async ({ page }) => {
  await page.goto('/workflow/invoices')
  await expect(page.getByTestId('invoice')).toHaveCount(${INVOICE_COUNT})
  await page.getByRole('link', { name: 'INV-0047' }).click()
  await expect(page.getByTestId('heading')).toHaveText('Invoice INV-0047')
  await expect(page.getByTestId('amount')).toHaveText('${invoiceAmountOf(47)}')
})

test('a sort that compares numbers as text fails at the sorted column', async ({ page }) => {
  await page.goto('/workflow/team?defect=sorts-as-text')
  await page.getByRole('button', { name: 'Open tasks' }).click()
  await test.step('the open tasks go from fewest to most', async () => {
    await expect(page.getByTestId('member-tasks')).toHaveText(${JSON.stringify(byTasks.map(String))})
  })
})
`

const findsRow = 'reads the table row by row and finds a member by name'
const namedRowCount = 'a check that no row has a name the table shows is refused, not passed'
const namedRowHidden = 'a check that a row shown by name is hidden is refused, not passed'
const sorts = 'sorts the table by name one way and then the other'
const longList = 'finds an invoice far down a long list and opens it'
const textSort = 'a sort that compares numbers as text fails at the sorted column'

test('workflow family 8: the rows read in order, cells are found by name, a column sorts both ways, a far item opens, and a text sort fails at its check', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F8.1 and F8.2: every row's text in order, cells by their names, and the name column sorted both ways.
  assert.equal(testNamed(run, findsRow).status, 'passed')
  assert.equal(testNamed(run, sorts).status, 'passed')
  // Chrome's accessibility tree gives a table row no name from its cells, so a named row would match nothing and both
  // checks would pass beside the row on screen. Each is refused as unsupported, naming why, before the page is asked.
  for (const name of [namedRowCount, namedRowHidden]) {
    const refused = testNamed(run, name)
    assert.deepEqual([refused.status, refused.failure?.class], ['error', 'unsupported'], name)
    assert.match(refused.failure?.message ?? '', /gives a table row no name from its cells/)
  }

  // F8.3: the link sits far below the first screen; the click brought it into view and opened its page.
  assert.equal(testNamed(run, longList).status, 'passed')
  const { testId } = testNamed(run, longList)
  const opened = eventsOf(run.events, 'navigation').filter((event) => event.testId === testId && event.cause === 'action')
  assert.deepEqual(opened.map((event) => event.url.slice(app.url.length)), ['/workflow/invoices/detail'])

  // F8.4: compared as text, "10" sorts before "3", so the first cell is wrong.
  assertFailedAt(run, textSort, {
    step: 'the open tasks go from fewest to most',
    failureClass: 'check_failed',
    line: lineOf(tests, "getByTestId('member-tasks')", 'the open tasks go from fewest to most'),
    message: /^Match 1 of getByTestId\('member-tasks'\) has text "10", expected "3"\./,
  })
})
