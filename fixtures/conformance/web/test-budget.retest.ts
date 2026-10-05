import { test } from '@rehearsal-labs/retest'

// A test that runs past its own budget is stopped and fails as a timeout, and the tests after it in its file do not
// run, since its process is ended with it.

test('a test that waits past its own budget fails as a timeout', { timeout: 1500 }, async ({ page }) => {
  await page.goto('/lookup/find')
  await new Promise<void>(() => undefined)
})

test('a test after a timed out one in its file does not run', async ({ page }) => {
  await page.goto('/lookup/find')
})
