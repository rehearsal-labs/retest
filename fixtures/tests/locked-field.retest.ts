import { expect, test } from '@rehearsal-labs/retest'

test('keeps the value of a field it cannot fill', async ({ page }) => {
  await page.goto('/')
  // Retest records the failed fill either way; catching it lets the test show the value that was saved.
  await page.getByTestId('task-title').fill('Release checklist').catch(() => undefined)
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Existing task')
})
