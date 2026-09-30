import { expect, test } from '@rehearsal-labs/retest'

test('passes a promise to expect', async ({ page }) => {
  expect(page.goto('/')).toBe(undefined)
})

test('calls toBe on a locator', async ({ page }) => {
  expect(page.getByTestId('save-task')).toBe(1)
})

test('calls toBeVisible on a value', async () => {
  await expect(3).toBeVisible()
})

test('fills a number', async ({ page }) => {
  await page.getByTestId('task-title').fill(42)
})
