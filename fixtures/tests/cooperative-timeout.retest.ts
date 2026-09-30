import { writeSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

writeSync(1, `pid ${process.pid}\n`)

test('waits for something that never comes', { timeout: 500 }, async ({ page }) => {
  await page.goto('/')
  await new Promise(() => {})
})

test('runs after the timeout', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('save-task')).toBeVisible()
})
