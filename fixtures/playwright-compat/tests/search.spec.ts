// Workflow family 9, search, filter and paginate: F9.1 to F9.4 of docs/compatibility/workflow-cases.md, written
// as a Playwright test against the task app.
import { test, expect } from '@playwright/test'

test('a search lists only the matching books', async ({ page }) => {
  await page.goto('/workflow/catalog')
  await page.getByLabel('Search').fill('garden')
  await page.getByLabel('Search').press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText('3 results')
  await expect(page.getByTestId('result-title')).toHaveText(['The Well-Tempered Garden', 'Garden Design Basics', 'A Year in the Garden'])
  await expect(page.getByLabel('Search')).toHaveValue('garden')
})

test('pages through every result and back', async ({ page }) => {
  await page.goto('/workflow/catalog')
  await expect(page.getByTestId('result-count')).toHaveText('23 results')
  await expect(page.getByTestId('result-title')).toHaveText(['The Well-Tempered Garden', 'Garden Design Basics', 'A Year in the Garden', 'The Secret History', 'Middlemarch'])
  await expect(page.getByRole('link', { name: 'Previous page' })).toBeHidden()
  await page.getByRole('link', { name: 'Next page' }).click()
  await expect(page.getByTestId('page-status')).toHaveText('Page 2 of 5')
  await expect(page.getByTestId('result-title')).toHaveText(['Beloved', 'The Remains of the Day', 'A Brief History of Time', 'The Selfish Gene', 'Cosmos'])
  for (const next of [3, 4, 5]) {
    await page.getByRole('link', { name: 'Next page' }).click()
    await expect(page.getByTestId('page-status')).toHaveText('Page ' + next + ' of 5')
  }
  await expect(page.getByTestId('result-title')).toHaveText(['The Gene', 'The Making of the Atomic Bomb', 'Planting in a Post-Wild World'])
  await expect(page.getByRole('link', { name: 'Next page' })).toBeHidden()
  await page.getByRole('link', { name: 'Previous page' }).click()
  await expect(page.getByTestId('page-status')).toHaveText('Page 4 of 5')
})

test('a genre filter narrows a search, and a search with no match says so', async ({ page }) => {
  await page.goto('/workflow/catalog')
  await page.getByLabel('Search').fill('history')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('result-title')).toHaveText(['The Secret History', 'A Brief History of Time', 'A History of the World in 100 Objects'])
  await page.getByLabel('Genre').selectOption({ label: 'History' })
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('result-count')).toHaveText('1 result')
  await expect(page.getByTestId('result-title')).toHaveText(['A History of the World in 100 Objects'])
  await page.getByLabel('Search').fill('zzzz')
  await page.getByLabel('Search').press('Enter')
  await expect(page.getByTestId('result-count')).toHaveText('No results')
  await expect(page.getByTestId('result-title')).toHaveCount(0)
  await expect(page.getByTestId('page-status')).toBeHidden()
})

test('a search that ignores its words fails at the result count', async ({ page }) => {
  await page.goto('/workflow/catalog?defect=ignores-query')
  await page.getByLabel('Search').fill('garden')
  await page.getByLabel('Search').press('Enter')
  await test.step('only the matching books are listed', async () => {
    await expect(page.getByTestId('result-count')).toHaveText('3 results')
  })
})
