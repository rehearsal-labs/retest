import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('runs after the browser is lost', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
