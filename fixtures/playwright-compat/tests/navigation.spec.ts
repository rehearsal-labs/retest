// Workflow family 1, open a page, navigate and reload: F1.1 to F1.4 of docs/compatibility/workflow-cases.md,
// written as a Playwright test against the task app.
import { test, expect } from '@playwright/test'

test('opens pages by link, by a moved address and by an absolute address', async ({ page }) => {
  await page.goto('/workflow/site')
  await expect(page.getByTestId('heading')).toHaveText('Home')
  await page.getByRole('link', { name: 'Projects' }).click()
  await expect(page.getByTestId('heading')).toHaveText('Projects')
  await page.getByRole('link', { name: 'Apollo' }).click()
  await expect(page.getByTestId('heading')).toHaveText('Apollo')
  await expect(page.getByTestId('summary')).toHaveText('The launch checklist for the spring release.')
  await page.getByRole('link', { name: 'Back to projects' }).click()
  await expect(page.getByRole('link', { name: 'Borealis' })).toBeVisible()
  await page.goto('/workflow/site/old-projects')
  await expect(page.getByTestId('heading')).toHaveText('Projects')
  await page.goto(`${process.env['WORKFLOW_APP_URL']}/workflow/site`)
  await expect(page.getByTestId('welcome')).toHaveText('Welcome back. Pick a project to carry on.')
})

test('a reload keeps the saved name and loses the unsaved draft', async ({ page }) => {
  await page.goto('/workflow/site/settings')
  await expect(page.getByTestId('loads')).toHaveText('Loaded 1 time in this tab')
  await page.getByLabel('Display name').fill('Ada')
  await page.getByRole('button', { name: 'Save profile' }).click()
  await expect(page.getByTestId('profile-status')).toHaveText('Profile saved')
  await page.getByLabel('Draft note').fill('Pay the venue deposit')
  await page.reload()
  await expect(page.getByTestId('loads')).toHaveText('Loaded 2 times in this tab')
  await expect(page.getByLabel('Display name')).toHaveValue('Ada')
  await expect(page.getByTestId('saved-name')).toHaveText('Ada')
  await expect(page.getByLabel('Draft note')).toHaveValue('')
})

test('a section opened by a client-side route survives a reload', async ({ page }) => {
  await page.goto('/workflow/site/settings')
  await page.getByRole('tab', { name: 'Notifications' }).click()
  await expect(page.getByTestId('notifications-intro')).toBeVisible()
  await expect(page.getByTestId('profile-section')).toBeHidden()
  await expect(page).toHaveURL('/workflow/site/settings/notifications')
  await page.reload()
  await expect(page.getByTestId('notifications-intro')).toBeVisible()
  await expect(page.getByTestId('loads')).toHaveText('Loaded 2 times in this tab')
  await page.getByRole('tab', { name: 'Profile' }).click()
  await expect(page.getByLabel('Display name')).toBeVisible()
})

test('a menu link that leads to the wrong page fails at the heading check', async ({ page }) => {
  await page.goto('/workflow/site?defect=wrong-link')
  await test.step('open settings from the menu', async () => {
    await page.getByRole('link', { name: 'Settings' }).click()
    await expect(page.getByTestId('heading')).toHaveText('Settings')
  })
})
