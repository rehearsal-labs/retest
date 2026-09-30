import { expect, test } from '@rehearsal-labs/retest'

test('saves an empty title', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('last-saved')).toHaveText('')
})
