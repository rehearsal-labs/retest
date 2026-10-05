import { expect, test } from '@rehearsal-labs/retest'

// The page the app server the run started serves.

test('opens the page the app server serves once it answers', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading')).toHaveText('Served by the app server')
})
