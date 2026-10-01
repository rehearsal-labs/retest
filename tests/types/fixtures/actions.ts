import type { Same } from './support/same.ts'
import { expect, test, type Locator, type OptionChoice, type Page, type ScrollDelta } from '@rehearsal-labs/retest'

// select, check, uncheck and scroll. What the types cannot see, such as an empty list or a delta of 0, is refused when
// the test runs.
declare const chosen: string
declare const maybeY: number | undefined
declare const colours: readonly OptionChoice[]

export const choice: Same<OptionChoice, string | { readonly value: string }> = true
export const delta: Same<ScrollDelta, { readonly x?: number | undefined; readonly y?: number | undefined }> = true
export const selectTakes: Same<Parameters<Locator['select']>[0], OptionChoice | readonly OptionChoice[]> = true
export const scrollTakes: Same<Parameters<Page['scroll']>[0], ScrollDelta> = true

test('chooses, ticks and scrolls', async ({ page }) => {
  const country = page.getByLabel('Country')
  await country.select('Canada')
  await country.select({ value: 'ca' })
  await country.select(chosen)
  await page.getByTestId('colours').select(['Red', { value: 'b' }])
  await page.getByTestId('colours').select(['Red'] as const)
  await page.getByTestId('colours').select(colours)
  await page.getByRole('checkbox', { name: 'Remember me' }).check()
  await page.getByLabel('Newsletter').uncheck()
  await page.getByTestId('terms').scroll({ y: 600 })
  await page.getByTestId('terms').scroll({ x: -40.5, y: 1200 })
  await page.scroll({ y: maybeY })
  await page.scroll({ x: 120 })
  await expect(country).toBeVisible()
})

// A helper takes an option or a delta the way the actions do, and passes it on.
export async function chooseEach(field: Locator, options: readonly OptionChoice[]): Promise<void> {
  for (const option of options) await field.select(option)
}
export async function scrollBoth(page: Page, by: ScrollDelta): Promise<void> {
  await page.scroll(by)
  await page.getByTestId('terms').scroll(by)
}

test('refuses what the actions do not take', async ({ page }) => {
  const country = page.getByLabel('Country')
  await country.select(1) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type
  await country.select({ label: 'Canada' }) // type-error TS2353 'label' does not exist in type
  await country.select({ value: 3 }) // type-error TS2345 Type 'number' is not assignable to type 'string'
  await country.select(['Red', 3]) // type-error TS2322 Type 'number' is not assignable to type 'OptionChoice'
  await country.select() // type-error TS2554 Expected 1 arguments, but got 0.
  await country.select('Red', 'Blue') // type-error TS2554 Expected 1 arguments, but got 2.
  await country.check(true) // type-error TS2554 Expected 0 arguments, but got 1.
  await country.uncheck('Newsletter') // type-error TS2554 Expected 0 arguments, but got 1.
  await page.getByTestId('terms').scroll() // type-error TS2554 Expected 1 arguments, but got 0.
  await page.scroll() // type-error TS2554 Expected 1 arguments, but got 0.
  await page.scroll(600) // type-error TS2559 Type '600' has no properties in common with type 'ScrollDelta'.
  await page.scroll({ y: '600' }) // type-error TS2322 Type 'string' is not assignable to type 'number'
  await page.scroll({ top: 600 }) // type-error TS2353 'top' does not exist in type 'ScrollDelta'
  await page.select('Canada') // type-error TS2339 Property 'select' does not exist on type 'Page<false>'.
  await page.check() // type-error TS2339 Property 'check' does not exist on type 'Page<false>'.
  await page.keyboard.scroll({ y: 600 }) // type-error TS2339 Property 'scroll' does not exist on type 'Keyboard'.
})
