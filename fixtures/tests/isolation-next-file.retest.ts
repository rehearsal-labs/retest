import { expect, test } from '@rehearsal-labs/retest'
import { countTest } from './tests-in-process.ts'

test('starts in a new process with clean storage', async ({ page }) => {
  expect(countTest()).toBe(1)
  await page.goto('/')
  await expect(page.getByTestId('last-saved')).toHaveText('')
  await expect(page.getByTestId('page-loads')).toHaveText('1')
})
