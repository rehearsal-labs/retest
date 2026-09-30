import { expect, test } from '@rehearsal-labs/retest'

console.log(`pid ${process.pid}`)

test('clicks something that never answers', { timeout: 400 }, async ({ page }) => {
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toBeVisible()
})

test('runs next', async ({ page }) => {
  await expect(page.getByTestId('save-task')).toBeVisible()
})
