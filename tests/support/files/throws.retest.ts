import { expect, test } from '@rehearsal-labs/retest'

test('throws from test code', async ({ page }) => {
  await expect(page.getByTestId('save-task')).toBeVisible()
  throw new TypeError('The fixture data was wrong.')
})

test('declares a test inside a test', () => {
  test('nested', () => {})
})
