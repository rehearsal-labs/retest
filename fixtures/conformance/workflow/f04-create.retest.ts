import { expect, test } from '@rehearsal-labs/retest'

// Workflow family 4, create an object through a form: F4.1 to F4.4, as tests/integration/workflow-create.test.ts
// runs them on Chrome.

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
