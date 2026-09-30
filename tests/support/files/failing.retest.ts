import { expect, test } from '@rehearsal-labs/retest'

test('shows the wrong text', async ({ page }) => {
  await page.getByTestId('task-title').fill('Draft')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('finds nothing', async ({ page }) => {
  await expect(page.getByTestId('missing')).toBeVisible()
})

test('finds two', async ({ page }) => {
  await expect(page.getByTestId('repeated-task')).toHaveText('One')
})

test('stays hidden', async ({ page }) => {
  await expect(page.getByTestId('hidden-note')).toBeVisible()
})

test('compares values', () => {
  expect(1 + 1).toBe(3)
})

test('clicks what is not there', async ({ page }) => {
  await page.getByTestId('missing').click()
})
