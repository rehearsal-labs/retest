// Workflow family 7, select options, checkboxes and radios: F7.1 to F7.4 of
// docs/compatibility/workflow-cases.md, written as a Playwright test against the task app.
import { test, expect } from '@playwright/test'

test('chooses a plan, ticks a box and picks a theme, and the saved choices come back after a reload', async ({ page }) => {
  await page.goto('/workflow/preferences')
  await expect(page.getByTestId('current')).toHaveText('plan=free seats=none updates=on summary=off alerts=on theme=light')
  await page.getByLabel('Plan').selectOption({ label: 'Team' })
  await expect(page.getByTestId('price')).toHaveText('$12 a month')
  await page.getByLabel('Weekly summary').check()
  await page.getByLabel('Dark').check()
  await expect(page.getByLabel('Weekly summary')).toBeChecked()
  await expect(page.getByLabel('Dark')).toBeChecked()
  await expect(page.getByTestId('current')).toHaveText('plan=team seats=none updates=on summary=on alerts=on theme=dark')
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await expect(page.getByRole('status')).toHaveText('Saved plan=team seats=none updates=on summary=on alerts=on theme=dark')
  await page.reload()
  await expect(page.getByLabel('Plan')).toHaveValue('team')
  await expect(page.getByLabel('Weekly summary')).toBeChecked()
  await expect(page.getByLabel('Dark')).toBeChecked()
  await expect(page.getByTestId('current')).toHaveText('plan=team seats=none updates=on summary=on alerts=on theme=dark')
})

test('unticks a ticked box, chooses by value, and a second radio replaces the first', async ({ page }) => {
  await page.goto('/workflow/preferences')
  await page.getByLabel('Product updates').uncheck()
  await page.getByLabel('Plan').selectOption({ value: 'team' })
  await page.getByLabel('Dark').check()
  await page.getByLabel('System').check()
  await expect(page.getByLabel('Product updates')).not.toBeChecked()
  await expect(page.getByLabel('System')).toBeChecked()
  await expect(page.getByLabel('Dark')).not.toBeChecked()
  await expect(page.getByTestId('current')).toHaveText('plan=team seats=none updates=off summary=off alerts=on theme=system')
})

test('the Business plan shows a seats choice that the other plans hide', async ({ page }) => {
  await page.goto('/workflow/preferences')
  await expect(page.getByTestId('seats-field')).toBeHidden()
  await page.getByLabel('Plan').selectOption({ label: 'Business' })
  await expect(page.getByLabel('Seats')).toBeVisible()
  await page.getByLabel('Seats').selectOption({ label: '25 seats' })
  await expect(page.getByTestId('current')).toHaveText('plan=business seats=25 updates=on summary=off alerts=on theme=light')
  await page.getByLabel('Plan').selectOption({ label: 'Free' })
  await expect(page.getByTestId('seats-field')).toBeHidden()
  await expect(page.getByTestId('price')).toHaveText('$0 a month')
})

test('a save that ignores a checkbox fails at the saved summary', async ({ page }) => {
  await page.goto('/workflow/preferences?defect=ignores-checkbox')
  await page.getByLabel('Weekly summary').check()
  await page.getByRole('button', { name: 'Save preferences' }).click()
  await test.step('the saved preferences match the form', async () => {
    await expect(page.getByRole('status')).toHaveText('Saved plan=free seats=none updates=on summary=on alerts=on theme=light')
  })
})
