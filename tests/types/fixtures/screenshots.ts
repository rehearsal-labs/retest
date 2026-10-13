import type { ScreenshotOptions } from '@rehearsal-labs/retest'
import { expect, test } from '@rehearsal-labs/retest'

// `toHaveScreenshot` on a page and on a locator, with its options typed. It has no `.not`, and a value has no
// screenshot. Each marked line fails the type check.
test('screenshot matcher', async ({ page }) => {
  const options: ScreenshotOptions = { maxDiffPixels: 50, maxDiffPixelRatio: 0.001, threshold: 0.2, timeout: 2000 }
  await expect(page).toHaveScreenshot('dashboard')
  await expect(page.getByTestId('chart')).toHaveScreenshot('chart', { maxDiffPixels: 50 })
  await expect(page).toHaveScreenshot('settings', { maxDiffPixelRatio: 0.001, threshold: 0.2 })
  await expect.soft(page).toHaveScreenshot('settings', options)
  await expect(page).toHaveScreenshot() // type-error TS2554 Expected 1-2 arguments, but got 0.
  await expect(page).toHaveScreenshot('dashboard', { maxDiff: 5 }) // type-error TS2353 'maxDiff' does not exist in type 'ScreenshotOptions'
  await expect(page).toHaveScreenshot('dashboard', { threshold: '0.2' }) // type-error TS2322 Type 'string' is not assignable to type 'number'
  await expect(page.getByTestId('chart')).toHaveScreenshot(3) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string'
  await expect(page).not.toHaveScreenshot('dashboard') // type-error TS2349 RetestTypeError<"toHaveScreenshot has no .not. Save a baseline of the picture you expect instead.">
  await expect(page.getByTestId('chart')).not.toHaveScreenshot('chart') // type-error TS2349 RetestTypeError<"toHaveScreenshot has no .not. Save a baseline of the picture you expect instead.">
  await expect('dashboard').toHaveScreenshot('dashboard') // type-error TS2349 RetestTypeError<"toHaveScreenshot is for locators and pages. Use toEqual on a value.">
  await expect.poll(() => 'dashboard').toHaveScreenshot('dashboard') // type-error TS2339 Property 'toHaveScreenshot' does not exist on type 'PollAssertions<string>'
})
