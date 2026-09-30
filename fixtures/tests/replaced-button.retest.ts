import { expect, test } from '@rehearsal-labs/retest'

test('clicks the save button that replaced the first one', async ({ page }) => {
  await page.goto('/')
  const save = page.getByTestId('save-task')
  await expect(save).toBeVisible()
  await expect(page.getByTestId('save-replaced')).toBeVisible()
  await page.getByTestId('task-title').fill('Release checklist')
  await save.click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
