import { expect, test } from '@rehearsal-labs/retest'
import { EXPORT_RELEASE_PATH, REPORTS } from '../../task-app/workflow-async-page.ts'
import { conformanceBaseUrl } from '../config.ts'

// Workflow family 10, wait for loading and asynchronous UI state: F10.1 to F10.5, as
// tests/integration/workflow-async.test.ts runs them on Chrome. The task app's address, which the runner names, is
// where the test asks the server to finish the export.

test('shows a loading line, then the reports that arrive late, and hides the line', async ({ page }) => {
  await page.goto('/workflow/reports')
  await expect(page.getByTestId('loading')).toBeVisible()
  await expect(page.getByTestId('report-row')).toHaveText(REPORTS)
  await expect(page.getByTestId('loading')).toBeHidden()
})

test('waits for Export to be enabled, then for the export to finish', async ({ page }) => {
  await page.goto('/workflow/reports')
  await expect(page.getByRole('button', { name: 'Export' })).toBeEnabled()
  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByTestId('export-status')).toHaveText('Preparing export…')
  // The server holds the export until this asks it to finish, so the state above stays until it has been checked.
  const released = await fetch(new URL(EXPORT_RELEASE_PATH, conformanceBaseUrl()), { method: 'POST' })
  expect(released.ok).toBe(true)
  await expect(page.getByTestId('export-status')).toHaveText(`Export ready: ${REPORTS.length} reports`)
})

test('offers to try again after a failed load, and loads on the second try', async ({ page }) => {
  await page.goto('/workflow/reports?first-load=fails')
  await expect(page.getByRole('alert')).toHaveText('Could not load reports. Try again')
  await expect(page.getByTestId('loading')).toBeHidden()
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('report-row')).toHaveCount(REPORTS.length)
  await expect(page.getByRole('alert')).toBeHidden()
})

test('a loading line that never goes away fails at the hidden check', async ({ page }) => {
  await page.goto('/workflow/reports?defect=spinner-stays')
  await expect(page.getByTestId('report-row')).toHaveCount(REPORTS.length)
  await test.step('the loading line goes once the reports are in', async () => {
    await expect(page.getByTestId('loading')).toBeHidden()
  })
})

test('reports that never arrive fail at the list check', async ({ page }) => {
  await page.goto('/workflow/reports?defect=never-answers')
  await test.step('the reports arrive', async () => {
    await expect(page.getByTestId('report-row')).toHaveCount(REPORTS.length)
  })
})
