import { test } from '@rehearsal-labs/retest'

test('only acts', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('save-task').click()
})
