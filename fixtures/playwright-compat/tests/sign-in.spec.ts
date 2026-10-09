// Workflow family 2, password sign-in and sign-out: F2.1 to F2.4 of docs/compatibility/workflow-cases.md,
// written as a Playwright test against the task app. The password comes from the environment, as a Playwright
// suite reads one.
import { test, expect, type Page } from '@playwright/test'

const password = process.env['WORKFLOW_PASSWORD'] ?? ''

async function signIn(page: Page): Promise<void> {
  await page.goto('/workflow/sign-in')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
}

test('signs in with the password and lands on the account page', async ({ page }) => {
  await signIn(page)
  await expect(page.getByTestId('stored-user')).toHaveText('alice')
  await expect(page.getByTestId('project')).toHaveText(['Apollo', 'Borealis'])
})

test('a wrong password shows an error and leaves the person signed out', async ({ page }) => {
  await page.goto('/workflow/sign-in')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong user name or password')
  await expect(page.getByTestId('heading')).toHaveText('Sign in')
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('projects-status')).toHaveText('Sign in to see your projects')
})

test('signing out ends the session', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByTestId('signed-out-notice')).toHaveText('You are signed out.')
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('stored-user')).toHaveText('')
  await expect(page.getByTestId('projects-status')).toHaveText('Sign in to see your projects')
})

test('a sign-out that keeps the session fails at the signed-out check', async ({ page }) => {
  await signIn(page)
  await page.goto('/workflow/account?defect=keeps-session')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByTestId('signed-out-notice')).toHaveText('You are signed out.')
  await test.step('the account page shows signed out', async () => {
    await page.goto('/workflow/account')
    await expect(page.getByTestId('account')).toHaveText('Signed out')
  })
})
