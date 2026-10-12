import { expect, test } from '@rehearsal-labs/retest'

// The layout matchers: three on a locator, one on a page, each with `.not` and its own timeout. Each marked line fails
// the type check.
test('layout matchers', async ({ page }) => {
  const save = page.getByRole('button', { name: 'Save' })
  const help = page.getByRole('link', { name: 'Help' })
  await expect(save).toOverlap(help)
  await expect(save).not.toOverlap(help, { timeout: 2000 })
  await expect(page.getByTestId('price')).toOverflowViewport()
  await expect(page.getByTestId('price')).not.toOverflowViewport()
  await expect(page.getByRole('heading')).not.toHaveClippedText()
  await expect.soft(page.getByRole('heading')).toHaveClippedText({ timeout: 1000 })
  await expect(page).toScrollHorizontally()
  await expect(page).not.toScrollHorizontally({ timeout: 500 })
  await expect(save).toOverlap('help') // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'Locator<boolean>'
  await expect(save).toOverlap() // type-error TS2554 Expected 1-2 arguments, but got 0.
  await expect(save).toOverflowViewport({ ratio: 0.5 }) // type-error TS2353 'ratio' does not exist in type 'AssertionOptions'
  await expect(save).toHaveClippedText({ timeout: '1s' }) // type-error TS2322 Type 'string' is not assignable to type 'number'
  await expect(save).not.not.toOverlap(help) // type-error TS2339 Property 'toOverlap' does not exist on type 'RetestTypeError<".not is written once.">'
  await expect(save).toScrollHorizontally() // type-error TS2339 Property 'toScrollHorizontally' does not exist on type 'LocatorAssertions'
  await expect(page).toOverlap(help) // type-error TS2339 Property 'toOverlap' does not exist on type 'PageAssertions'
  await expect(page).not.toHaveClippedText() // type-error TS2339 Property 'toHaveClippedText' does not exist on type 'NegatedPageAssertions'
  await expect(3).toOverflowViewport() // type-error TS2349 RetestTypeError<"toOverflowViewport is for locators. Use toBe on a value.">
  await expect('Save').toOverlap(help) // type-error TS2349 RetestTypeError<"toOverlap is for locators. Use toBe on a value.">
  await expect({ width: 390 }).toHaveClippedText() // type-error TS2349 RetestTypeError<"toHaveClippedText is for locators. Use toBe on a value.">
  await expect('page').toScrollHorizontally() // type-error TS2349 RetestTypeError<"toScrollHorizontally is for a page. Use toBe on a value.">
  await expect.poll(() => 390).toScrollHorizontally() // type-error TS2339 Property 'toScrollHorizontally' does not exist on type 'PollAssertions<number>'
})
