import { writeSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

test('loops forever', { timeout: 300 }, async ({ page }) => {
  await page.goto('/')
  writeSync(1, `pid ${process.pid}\n`)
  for (;;) {
    // Never yields: only killing the process ends this test.
  }
})

test('never gets a turn', async ({ page }) => {
  await expect(page.getByTestId('save-task')).toBeVisible()
})
