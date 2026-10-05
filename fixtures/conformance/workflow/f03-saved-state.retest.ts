import { expect, secret } from '@rehearsal-labs/retest'
import { stateTest as test } from '../unregistered.ts'

// Workflow family 3, reuse signed-in state: F3.1 to F3.4, as tests/integration/workflow-saved-state.test.ts runs them
// on Chrome. The config declares the states `signed-in` and `admin`.

test.setup('signed-in', async ({ page }) => {
  await page.goto('/workflow/sign-in')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})

test.setup('admin', async ({ page }) => {
  await page.goto('/workflow/sign-in?defect=signs-in-as-guest')
  await page.getByLabel('User name').fill('admin')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await test.step('the account page names admin', async () => {
    await expect(page.getByTestId('account')).toHaveText('Signed in as admin')
  })
})

test('starts signed in from the saved state', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
  await expect(page.getByTestId('stored-user')).toHaveText('alice')
  await expect(page.getByTestId('project')).toHaveText(['Apollo', 'Borealis'])
})

test('starts signed out without a state, after a test that was signed in', async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('stored-user')).toHaveText('')
  await expect(page.getByTestId('projects-status')).toHaveText('Sign in to see your projects')
})

test('pins a project while signed in', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await page.getByRole('button', { name: 'Pin Apollo' }).click()
  await expect(page.getByTestId('pinned')).toHaveText('Apollo')
})

test('starts from the saved state, not from what the test before it changed', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
  await expect(page.getByTestId('pinned')).toHaveText('nothing')
})

test('opens the admin tools', { state: 'admin' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as admin')
})
