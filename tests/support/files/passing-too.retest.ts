import { expect, test } from '@rehearsal-labs/retest'

test('saves another task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Second task')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Second task')
})

test('saves a third task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Third task')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Third task')
})
