import { expect, secret, test } from '@rehearsal-labs/retest'

// Runs before any test that starts from 'signed-in', once for each browser those tests use.
test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})

test('starts signed in from the saved state', { state: 'signed-in', tags: ['smoke'] }, async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByText('Signed in as alice')).toBeVisible()
  await expect(page.getByTestId('stored-user')).toHaveText('alice')
})

test('starts signed out without it', async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByText('Signed in as alice')).toBeHidden()
})
