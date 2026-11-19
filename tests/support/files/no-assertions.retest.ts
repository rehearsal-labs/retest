import { test } from 'retest'

test('only acts', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('save-task').click()
})
