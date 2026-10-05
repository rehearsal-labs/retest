import type { Page } from '@rehearsal-labs/retest/playwright'

// Finders as `@rehearsal-labs/retest/playwright` types them for a Playwright test file. A table row by name is
// refused when it runs, since Chrome gives a row no name from its cells where Playwright does, and its type refuses it
// first. A row by position, a cell by name and a role held in a variable are not refused. Each marked line fails.
export async function rows(page: Page, role: 'row' | 'cell'): Promise<void> {
  await page.getByRole('row').nth(2).getByRole('cell', { name: 'Grace Hopper' }).click()
  await page.getByTestId('team').getByRole('row', { exact: true }).first().click()
  await page.getByRole('columnheader', { name: 'Role' }).click()
  await page.getByRole(role, { name: 'Grace Hopper' }).click()
  page.getByRole('row', { name: 'Grace Hopper grace@example.com Editor 12' }) // type-error TS2322 Type 'string' is not assignable to type 'undefined'
  page.getByTestId('team').getByRole('row', { name: /Grace/ }) // type-error TS2322 Type 'RegExp' is not assignable to type 'undefined'
}
