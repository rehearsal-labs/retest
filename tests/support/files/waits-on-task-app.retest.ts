import { expect, test } from '@rehearsal-labs/retest'

console.log(`pid ${process.pid}`)

test('waits on the task app for a task that never appears', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('never-there')).toBeVisible()
})
