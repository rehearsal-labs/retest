import { expect, test, type Finders, type Locator, type Page } from '@rehearsal-labs/retest'

// Finders on a page and on a locator, picks and patterns. Each marked line fails the type check.
export const finders: Finders = {} as Page
export async function deleteSecond(page: Page): Promise<void> {
  const inbox: Locator = page.getByTestId('inbox')
  await inbox.getByRole('listitem').nth(1).getByRole('button', { name: 'Delete' }).click()
  await inbox.getByRole('listitem').first().getByText(/milk/i).hover()
  await page.locator('.task').last().locator('button').click()
  await page.getByPlaceholder('Search').fill('release')
  await inbox.getByPlaceholder(/search/i, { exact: false }).fill('release')
  await page.getByLabel(/e-?mail/i).fill('ada@tasks.example')
  await page.reload()
  await page.goBack({ timeout: 2000 })
  await page.goForward()
  const address: string = await page.url()
  const title: string = await page.title()
  expect(`${address} ${title}`).toContain('tasks')
}

test('refuses what a locator does not take', async ({ page }) => {
  await page.getByRole('listitem').nth('1').click() // type-error TS2345 Argument of type 'string' is not assignable to parameter of type 'number'
  page.locator(/\.task/) // type-error TS2345 Argument of type 'RegExp' is not assignable to parameter of type 'string'
  page.getByPlaceholder(3) // type-error TS2345 Argument of type 'number' is not assignable to parameter of type 'string | RegExp'
  page.getByRole('button', { name: 3 }) // type-error TS2322 Type 'number' is not assignable to type 'string | RegExp | undefined'
  await page.getByTestId('menu').hover('slowly') // type-error TS2559 Type '"slowly"' has no properties in common with type 'CallOptions'.
  const url: string = page.url() // type-error TS2322 Type 'Promise<string>' is not assignable to type 'string'
  await page.reload('/tasks') // type-error TS2559 Type '"/tasks"' has no properties in common with type 'CallOptions'.
  await expect(page.getByRole('listitem').first()).toBeVisible()
})
