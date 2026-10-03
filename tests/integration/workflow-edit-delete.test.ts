import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 5, edit and delete an object, against real Chrome and the task app's backlog, which
// starts with three tasks for each browser context and is kept on the server. The cases are F5.1 to F5.4 in
// docs/plans/public-beta/workflow-cases.md.

const file = 'tests/edit-delete.retest.ts'
const assertFailedAt = failedAtIn(file)

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('edits a task and the change survives a reload', async ({ page }) => {
  await page.goto('/workflow/backlog')
  await page.getByRole('button', { name: 'Edit Book venue' }).click()
  await expect(page.getByLabel('Title')).toHaveValue('Book venue')
  await page.getByLabel('Title').fill('Book the main hall')
  await page.getByLabel('Priority').select('High')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book the main hall', 'Order badges'])
  await expect(page.getByTestId('item-priority')).toHaveText(['High', 'High', 'Low'])
  await page.reload()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book the main hall', 'Order badges'])
  await expect(page.getByTestId('item-priority')).toHaveText(['High', 'High', 'Low'])
})

test('asks before deleting, keeps the task on cancel and removes it on confirm', async ({ page }) => {
  await page.goto('/workflow/backlog')
  await page.getByRole('button', { name: 'Delete Book venue' }).click()
  await expect(page.getByTestId('delete-question')).toHaveText('Delete "Book venue"?')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book venue', 'Order badges'])
  await page.getByRole('button', { name: 'Delete Book venue' }).click()
  await page.getByRole('button', { name: 'Yes, delete' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Order badges'])
  await expect(page.getByTestId('backlog-count')).toHaveText('2 tasks')
  await page.reload()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Order badges'])
})

test('an edit the server never keeps fails after the reload', async ({ page }) => {
  await page.goto('/workflow/backlog?defect=edit-not-saved')
  await page.getByRole('button', { name: 'Edit Order badges' }).click()
  await page.getByLabel('Title').fill('Order name badges')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book venue', 'Order name badges'])
  await test.step('the change survives a reload', async () => {
    await page.reload()
    await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book venue', 'Order name badges'])
  })
})

test('a delete that removes the wrong row fails at the remaining list', async ({ page }) => {
  await page.goto('/workflow/backlog?defect=deletes-wrong-row')
  await page.getByRole('button', { name: 'Delete Book venue' }).click()
  await page.getByRole('button', { name: 'Yes, delete' }).click()
  await test.step('only the deleted task is gone', async () => {
    await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Order badges'])
  })
})
`

const edits = 'edits a task and the change survives a reload'
const deletes = 'asks before deleting, keeps the task on cancel and removes it on confirm'
const unsaved = 'an edit the server never keeps fails after the reload'
const wrongRow = 'a delete that removes the wrong row fails at the remaining list'

test('workflow family 5: an edit and a delete reach the server and survive a reload, and an unsaved edit or a wrong delete fails at its check', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F5.1 and F5.2: each test starts from the same three tasks, since each has a browser context of its own.
  assert.equal(testNamed(run, edits).status, 'passed')
  assert.equal(testNamed(run, deletes).status, 'passed')

  // F5.3: the page showed the edit, but the server kept the old title, which the reload shows.
  assertFailedAt(run, unsaved, {
    step: 'the change survives a reload',
    failureClass: 'check_failed',
    line: lineOf(tests, "toHaveText(['Write release notes', 'Book venue', 'Order name badges'])", 'the change survives a reload'),
    message: /^Match 3 of getByTestId\('item-title'\) has text "Order badges", expected "Order name badges"\./,
  })

  // F5.4: the server removed Order badges instead of Book venue, and the list shows what it kept.
  assertFailedAt(run, wrongRow, {
    step: 'only the deleted task is gone',
    failureClass: 'check_failed',
    line: lineOf(tests, "toHaveText(['Write release notes', 'Order badges'])", 'only the deleted task is gone'),
    message: /^Match 2 of getByTestId\('item-title'\) has text "Book venue", expected "Order badges"\./,
  })
})
