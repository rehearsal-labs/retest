import { expect, test } from '@rehearsal-labs/retest'

// Holds the task app's counter for the limited sessions for a while, and checks that no other page held it
// meanwhile. The host's budget allows one session at a time, so the other file's holder waits for this one's.

test('holder one keeps its session to itself under the limits', async ({ page }) => {
  await page.goto('/holders/hold?name=conformance-sessions&ms=700')
  await expect(page.getByTestId('overlap')).toHaveText('1')
})
