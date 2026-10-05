import { expect, test } from '@rehearsal-labs/retest'

// Holds the task app's counter for the inbox for a while under the lock, and checks that nobody held it meanwhile.
// The counter is the app's own, so it sees two holders whichever process or browser they come from.

test('holder a keeps the inbox to itself while it holds the lock', { locks: ['inbox'] }, async ({ page }) => {
  await page.goto('/holders/hold?name=conformance-inbox&ms=600')
  await expect(page.getByTestId('overlap')).toHaveText('1')
})
