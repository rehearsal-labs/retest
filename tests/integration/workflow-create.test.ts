import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 4, create an object through a form, against real Chrome and the task app's task board,
// which the server keeps for each browser context. The cases are F4.1 to F4.4 in
// docs/compatibility/workflow-cases.md.

const file = 'tests/create.retest.ts'
const assertFailedAt = failedAtIn(file)

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('adds a task with a title, notes and a priority', async ({ page }) => {
  await page.goto('/workflow/tasks')
  await expect(page.getByTestId('task-count')).toHaveText('No tasks yet')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByLabel('Notes').fill('Check the changelog and the docs')
  await page.getByLabel('Priority').select('High')
  await page.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByRole('status')).toHaveText('Task added')
  await expect(page.getByTestId('task-title')).toHaveText('Release checklist')
  await expect(page.getByTestId('task-priority')).toHaveText('High')
  await expect(page.getByTestId('task-notes')).toHaveText('Check the changelog and the docs')
  await expect(page.getByLabel('Title')).toHaveValue('')
  await expect(page.getByLabel('Priority')).toHaveValue('Normal')
  await page.reload()
  await expect(page.getByTestId('task-title')).toHaveText('Release checklist')
  await expect(page.getByTestId('task-count')).toHaveText('1 task')
})

test('Enter in the title field adds the task with the default priority', async ({ page }) => {
  await page.goto('/workflow/tasks')
  await page.getByLabel('Title').fill('Book the venue')
  await page.getByLabel('Title').press('Enter')
  await expect(page.getByTestId('task-title')).toHaveText('Book the venue')
  await expect(page.getByTestId('task-priority')).toHaveText('Normal')
})

test('refuses a second task with the same title and keeps what was typed', async ({ page }) => {
  await page.goto('/workflow/tasks')
  await page.getByLabel('Title').fill('Order badges')
  await page.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByTestId('task-count')).toHaveText('1 task')
  await page.getByLabel('Title').fill('order badges')
  await page.getByRole('button', { name: 'Add task' }).click()
  await expect(page.getByRole('alert')).toHaveText('A task named "order badges" already exists.')
  await expect(page.getByTestId('task-title')).toHaveCount(1)
  await expect(page.getByTestId('task-count')).toHaveText('1 task')
  await expect(page.getByLabel('Title')).toHaveValue('order badges')
})

test('a save that drops the last character fails at the listed title', async ({ page }) => {
  await page.goto('/workflow/tasks?defect=drops-last-character')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Add task' }).click()
  await test.step('the new task is listed with its title', async () => {
    await expect(page.getByTestId('task-title')).toHaveText('Release checklist')
  })
})
`

const adds = 'adds a task with a title, notes and a priority'
const enter = 'Enter in the title field adds the task with the default priority'
const duplicate = 'refuses a second task with the same title and keeps what was typed'
const dropped = 'a save that drops the last character fails at the listed title'

// The commands a test sent to its page, in order.
function commands(run: FinishedRun, name: string): string[] {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'action.completed')
    .filter((event) => event.testId === testId)
    .map((event) => event.command)
}

test('workflow family 4: a form adds a task the server keeps, Enter submits it, a duplicate is refused, and a save that drops a character fails at its check', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F4.1: typed, chosen and clicked through the page, listed from the server's answer, and still there after a reload.
  assert.equal(testNamed(run, adds).status, 'passed')
  assert.deepEqual(commands(run, adds), ['goto', 'fill', 'fill', 'select', 'click', 'reload'])

  // F4.2: the key alone submits the form.
  assert.equal(testNamed(run, enter).status, 'passed')
  assert.deepEqual(commands(run, enter), ['goto', 'fill', 'press'])

  // F4.3: the server refuses the same title in other letter case, and the list keeps one task.
  assert.equal(testNamed(run, duplicate).status, 'passed')

  // F4.4: the server kept "Release checklis", and the list shows what it kept.
  assertFailedAt(run, dropped, {
    step: 'the new task is listed with its title',
    failureClass: 'check_failed',
    line: lineOf(tests, "toHaveText('Release checklist')", 'the new task is listed with its title'),
    message: /^getByTestId\('task-title'\) has text "Release checklis", expected "Release checklist"\./,
  })
})
