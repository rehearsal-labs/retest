import { expect, test } from '@rehearsal-labs/retest'

// Never runs: the app's server never answers.

test('a test whose app server never answers does not run', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading')).toHaveText('Served by the app server')
})
