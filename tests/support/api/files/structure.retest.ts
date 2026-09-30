import { expect, test } from '@rehearsal-labs/retest'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
})

test.describe('tasks', () => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('task-title')).toBeVisible()
  })

  test('saves a task', async ({ page }) => {
    await page.getByTestId('task-title').fill('Release checklist')
    await page.getByTestId('save-task').click()
    await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  })

  test('fails, and still cleans up', async ({ page }) => {
    await expect(page.getByTestId('saved-task')).toBeVisible()
  })
})

test.for([{ title: 'One' }, { title: 'Two' }])('types "$title"', async ({ page }, { title }) => {
  await page.getByTestId('task-title').fill(title)
  await expect.soft(page.getByTestId('task-title')).toHaveValue('Three')
  await expect.poll(() => title.length).toBe(3)
})
