import { expect, test } from '@rehearsal-labs/retest'

// The task app's frozen mode, as for the stop. The runner ends the browser's process group once the server has
// counted the press, so the click's outcome cannot be known.

test('a browser lost after a click pressed leaves the outcome unknown, and never clicks again', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('a test after the browser is lost does not run', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
