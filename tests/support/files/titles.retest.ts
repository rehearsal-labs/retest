import { expect, test } from '@rehearsal-labs/retest'

test('opens the tasks through a link', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('tasks-link')).toBeVisible()
  await test.step('open the tasks', async () => {
    await page.getByTestId('tasks-link').click()
  })
})
