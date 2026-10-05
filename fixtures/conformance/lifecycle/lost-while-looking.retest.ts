import { expect, test } from '@rehearsal-labs/retest'

// The task app's delayed mode, whose save answers only after a minute. The runner ends the browser's process group
// once the click has completed, while the check looks for the saved title: the session is lost, and no check failed.

test('a browser lost while a check looks is a lost session, not a failed check', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('a test after the browser is lost does not run', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
