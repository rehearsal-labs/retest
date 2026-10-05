import { expect, secret, test } from '@rehearsal-labs/retest'

// Each test starts in a fresh browser context: what one test keeps in local storage, session storage and cookies is
// gone for the next, which runs right after it in the same process.

test('a test saves to local storage and signs in with a cookie', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Kept for later')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Kept for later')
  await page.reload()
  await expect(page.getByTestId('last-saved')).toHaveText('Kept for later')
  await expect(page.getByTestId('page-loads')).toHaveText('2')
  await page.goto('/login')
  await page.getByLabel('User name').fill('ada')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as ada')
  await expect(page.getByTestId('stored-user')).toHaveText('ada')
})

test('the next test starts with empty storage and no cookie', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('last-saved')).toHaveText('')
  await expect(page.getByTestId('page-loads')).toHaveText('1')
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('stored-user')).toHaveText('')
})
