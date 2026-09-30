import { test } from '@rehearsal-labs/retest'

test('saves without checking the result', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
})
