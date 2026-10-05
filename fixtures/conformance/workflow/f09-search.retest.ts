import { expect, test } from '@rehearsal-labs/retest'
import { BOOKS, PAGE_SIZE } from '../../task-app/workflow-search-page.ts'

// Workflow family 9, search, filter and paginate: F9.1 to F9.4, as tests/integration/workflow-search.test.ts runs them
// on Chrome.

const titles = BOOKS.map((book) => book.title)
const pageOf = (number: number): string[] => titles.slice((number - 1) * PAGE_SIZE, number * PAGE_SIZE)
const pages = Math.ceil(titles.length / PAGE_SIZE)

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
  await expect(page.getByTestId('result-count')).toHaveText(`${titles.length} results`)
  await expect(page.getByTestId('result-title')).toHaveText(pageOf(1))
  await expect(page.getByRole('link', { name: 'Previous page' })).toBeHidden()
  await page.getByRole('link', { name: 'Next page' }).click()
  await expect(page.getByTestId('page-status')).toHaveText(`Page 2 of ${pages}`)
  await expect(page.getByTestId('result-title')).toHaveText(pageOf(2))
  for (let next = 3; next <= pages; next += 1) {
    await page.getByRole('link', { name: 'Next page' }).click()
    await expect(page.getByTestId('page-status')).toHaveText(`Page ${next} of ${pages}`)
  }
  await expect(page.getByTestId('result-title')).toHaveText(pageOf(pages))
  await expect(page.getByRole('link', { name: 'Next page' })).toBeHidden()
  await page.getByRole('link', { name: 'Previous page' }).click()
  await expect(page.getByTestId('page-status')).toHaveText(`Page ${pages - 1} of ${pages}`)
})

test('a genre filter narrows a search, and a search with no match says so', async ({ page }) => {
  await page.goto('/workflow/catalog')
  await page.getByLabel('Search').fill('history')
  await page.getByRole('button', { name: 'Search' }).click()
  await expect(page.getByTestId('result-title')).toHaveText(['The Secret History', 'A Brief History of Time', 'A History of the World in 100 Objects'])
  await page.getByLabel('Genre').select('History')
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
