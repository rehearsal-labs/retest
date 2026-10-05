import { expect, test } from '@rehearsal-labs/retest'

// A test and a block marked only, and a test beside them that would fail if it ran.

test.only('a test marked only runs', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('Saved 3 tasks')
})

test('a test beside one marked only is left out', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('never there')
})

test.describe.only('a block marked only', (test) => {
  test('runs the tests inside it', async ({ page }) => {
    await page.goto('/lookup/states')
    await expect(page.getByTestId('save')).toBeEnabled()
  })
})
