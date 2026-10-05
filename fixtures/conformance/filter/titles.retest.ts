import { expect, test } from '@rehearsal-labs/retest'

// Three tests the runner filters with --grep "kept by the filter". The two others would fail if they ran.

test('reads the summary, kept by the filter', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('Saved 3 tasks')
})

test('reads a summary that is never there', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('never there')
})

test.describe('a block', (test) => {
  test('reads the status, kept by the filter', async ({ page }) => {
    await page.goto('/lookup/states')
    await expect(page.getByTestId('status')).toHaveText('Saved 3 tasks')
  })

  test('reads a status that is never there', async ({ page }) => {
    await page.goto('/lookup/states')
    await expect(page.getByTestId('status')).toHaveText('never there')
  })
})
