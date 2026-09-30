import { expect, test } from '@rehearsal-labs/retest'

console.log(`pid ${process.pid}`)

test('waits for something that never comes', { timeout: 300 }, async () => {
  await new Promise(() => {})
})

test('runs after a timed out test', async ({ page }) => {
  await expect(page.getByTestId('save-task')).toBeVisible()
})
