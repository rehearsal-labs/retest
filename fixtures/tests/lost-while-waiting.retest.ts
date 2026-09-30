import { test } from '@rehearsal-labs/retest'

test('clicks a button that never appears', async ({ page }) => {
  await page.goto('/')
  await test.step('click the missing button', async () => {
    await page.getByTestId('never-there').click()
  })
})
