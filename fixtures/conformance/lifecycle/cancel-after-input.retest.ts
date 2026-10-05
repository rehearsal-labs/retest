import { expect, test } from '@rehearsal-labs/retest'

// The task app's frozen mode: pressing save sends the save to the server, which counts it, and then the page never
// answers again. The runner sends SIGINT once the server has counted the press, so the click's input was sent and
// cannot be taken back.

test('a run stopped after a click pressed says the input was sent, and never completes the click', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('a test after the stop does not run', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
