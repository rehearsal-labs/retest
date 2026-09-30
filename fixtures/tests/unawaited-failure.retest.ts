import { setTimeout as sleep } from 'node:timers/promises'
import { expect, test } from '@rehearsal-labs/retest'

test('lets a failed assertion go unawaited', async ({ page }) => {
  await page.goto('/')
  void expect(page.getByTestId('missing-task')).toBeVisible().catch(() => undefined)
  // Long enough for the assertion's own budget to run out while nothing awaits it.
  await sleep(2000)
  expect(1).toBe(1)
})
