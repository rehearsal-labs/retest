import { expect, test } from '@rehearsal-labs/retest'

test('sends two actions at once', async ({ page }) => {
  const saving = page.getByTestId('save-task').click()
  await page.getByTestId('task-title').fill('Two')
  await saving
})

test('checks while an action runs', async ({ page }) => {
  const saving = page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toBeVisible()
  await saving
})

test('checks two things at once', async ({ page }) => {
  await Promise.all([expect(page.getByTestId('save-task')).toBeVisible(), expect(page.getByTestId('task-title')).toBeVisible()])
})
