import { expect, test } from '@rehearsal-labs/retest'

// Two checks pass on a locator no look ever finds, as a misspelt test id would; the third passes on a note that is on
// the page and hidden.
test('checks what a misspelt test id never finds', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('missing')).toBeHidden()
  await expect(page.getByTestId('missing')).toHaveCount(0)
})

test('checks a note that is there and hidden', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('hidden-note')).toBeHidden()
})
