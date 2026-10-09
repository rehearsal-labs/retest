// Workflow family 10, wait for loading and asynchronous UI state: F10.1 to F10.5 of
// docs/compatibility/workflow-cases.md, written as a Playwright test against the task app. The server holds an
// export until the test asks it to finish one, so the "Preparing export…" check never races a timer.
import { test, expect } from '@playwright/test'

test('shows a loading line, then the reports that arrive late, and hides the line', async ({ page }) => {
  await page.goto('/workflow/reports')
  await expect(page.getByTestId('loading')).toBeVisible()
  await expect(page.getByTestId('report-row')).toHaveText(['Weekly sales', 'Open tickets', 'Release health'])
  await expect(page.getByTestId('loading')).toBeHidden()
})

test('waits for Export to be enabled, then for the export to finish', async ({ page }) => {
  await page.goto('/workflow/reports')
  await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled()
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByTestId('export-status')).toHaveText('Preparing export…')
  const released = await fetch(new URL('/workflow/api/export/release', process.env['WORKFLOW_APP_URL']), { method: 'POST' })
  expect(released.ok).toBe(true)
  await expect(page.getByTestId('export-status')).toHaveText('Export ready: 3 reports')
})

test('offers to try again after a failed load, and loads on the second try', async ({ page }) => {
  await page.goto('/workflow/reports?first-load=fails')
  await expect(page.getByRole('alert')).toHaveText('Could not load reports. Try again')
  await expect(page.getByTestId('loading')).toBeHidden()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('report-row')).toHaveCount(3)
  await expect(page.getByRole('alert')).toBeHidden()
})

test('a loading line that never goes away fails at the hidden check', async ({ page }) => {
  await page.goto('/workflow/reports?defect=spinner-stays')
  await expect(page.getByTestId('report-row')).toHaveCount(3)
  await test.step('the loading line goes once the reports are in', async () => {
    await expect(page.getByTestId('loading')).toBeHidden()
  })
})

test('reports that never arrive fail at the list check', async ({ page }) => {
  await page.goto('/workflow/reports?defect=never-answers')
  await test.step('the reports arrive', async () => {
    await expect(page.getByTestId('report-row')).toHaveCount(3)
  })
})
