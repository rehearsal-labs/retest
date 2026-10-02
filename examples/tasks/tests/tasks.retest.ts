import { expect, test } from '@rehearsal-labs/retest'

const baseUrl = process.env['TASK_APP_URL'] ?? 'http://127.0.0.1:4173'

// A title no other test saves, so the server's count of it is this test's alone while other files run beside it.
const countedTitle = 'Counted once'

// What the task app's server has counted for that title, read from its API rather than from the page.
async function savedTasks(): Promise<number> {
  const response = await fetch(new URL(`/api/submissions?title=${encodeURIComponent(countedTitle)}`, baseUrl))
  const body: unknown = await response.json()
  return typeof body === 'object' && body !== null && 'count' in body && typeof body.count === 'number' ? body.count : -1
}

test.describe('tasks', { tags: ['smoke'] }, (test) => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Tasks' })).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    await expect(page.getByText('Could not save')).toBeHidden()
  })

  test.for([{ title: 'Release checklist' }, { title: 'Groceries' }])('saves "$title"', async ({ page }, { title }) => {
    await page.getByLabel('Title').fill(title)
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByTestId('saved-task')).toHaveText(title)
    await expect(page.getByLabel('Title')).toHaveValue(title)
  })

  test('the server counts one save for one click', async ({ page }) => {
    const before = await savedTasks()
    await page.getByLabel('Title').fill(countedTitle)
    await page.getByRole('button', { name: 'Save' }).click()
    // The function only reads, so looking again never saves again.
    await expect.poll(savedTasks, { timeout: 5000 }).toBe(before + 1)
    await expect.soft(page.getByTestId('page-loads')).toHaveText('1')
    expect.soft(await savedTasks()).toBe(before + 1)
  })
})

test('lists the buttons whose names contain "save"', async ({ page }) => {
  await page.goto('/locators')
  const saves = page.getByRole('button', { name: 'save', exact: false })
  await expect(saves).toHaveCount(3)
  await expect(saves).toHaveText(['Save', 'save', 'Save draft'])
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveText('shown')
  await expect(page.getByLabel('Full name')).toHaveValue('name by wrapping label')
  await expect(page.getByText('Hidden note')).toBeHidden()
})

test('compares values', async () => {
  const task = { title: 'Release checklist', tags: ['smoke', 'release'], due: new Date('2026-10-01T09:00:00Z') }
  expect(task).toEqual({ title: 'Release checklist', tags: ['smoke', 'release'], due: new Date('2026-10-01T09:00:00Z') })
  expect(task.tags).toContain('release')
  expect(task.title).toContain('checklist')
  expect(task.title).toMatch(/^release/i)
})
