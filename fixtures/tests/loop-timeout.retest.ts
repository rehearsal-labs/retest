import { writeSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

writeSync(1, `pid ${process.pid}\n`)

test('loops forever', { timeout: 500 }, async ({ page }) => {
  await page.goto('/')
  for (;;) {
    // Never yields, so only ending the process stops this test.
  }
})

test('runs after the loop', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
