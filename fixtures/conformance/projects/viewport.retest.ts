import { expect, test } from '@rehearsal-labs/retest'

// Runs once per target. A test does not know its target, so it checks the size is one of the two; the runner reads
// which one the parent saw for each target from the run's own record.

test('the page opens at the size of its target, with no touch screen and a pixel ratio of 1', async ({ page }) => {
  await page.goto('/device')
  await expect(page.getByTestId('width')).toHaveText(/^(1280|600)$/)
  await expect(page.getByTestId('height')).toHaveText(/^(720|800)$/)
  await expect(page.getByTestId('pixel-ratio')).toHaveText('1')
  await expect(page.getByTestId('touch')).toHaveText('false')
  await page.getByTestId('touch-target').click()
  await expect(page.getByTestId('touch-events')).toHaveText('click:mouse')
})
