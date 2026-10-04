import { expect, secret, test } from '@rehearsal-labs/retest'

// Runs against a service started with --read-delay-ms, so each refresh of the list answers with the tasks as they
// stood when it was asked, well after a save made meanwhile has answered. The page must not put the older list over
// the saved task. Signed in as ada, whose password is the secret `password`.

test('a save made while the list is refreshing stays on the page when the older list arrives', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('account').fill('ada')
  await page.getByTestId('password').fill(secret('password'))
  await page.getByTestId('sign-in').click()
  await page.getByTestId('open-task-id').fill('seed-ada-3')
  await page.getByTestId('open-task').click()
  await expect(page.getByTestId('selected-task-id')).toHaveText('seed-ada-3')
  await expect(page.getByTestId('task-state-seed-ada-3')).toHaveText('Open')

  await expect(page.getByTestId('list-status')).toHaveText('Refreshing')
  await page.getByTestId('edit-done').check()
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('save-status')).toHaveText('Saved revision 2.')

  // The refresh that was on its way when the save went out has now arrived; the next one is a second away.
  await expect(page.getByTestId('list-status')).toHaveText('Up to date')
  await expect(page.getByTestId('selected-task-state')).toHaveText('Done', { timeout: 300 })
  await expect(page.getByTestId('task-state-seed-ada-3')).toHaveText('Done', { timeout: 300 })
})
