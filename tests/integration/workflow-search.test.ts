import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BOOKS, PAGE_SIZE } from '../../fixtures/task-app/workflow-search-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 9, search, filter and paginate, against real Chrome and the task app's catalogue, which
// the server searches, filters and splits into pages for each submitted form. The cases are F9.1 to F9.4 in
// docs/compatibility/workflow-cases.md.

const file = 'tests/search.retest.ts'
const assertFailedAt = failedAtIn(file)

const titles = BOOKS.map((book) => book.title)
const pageOf = (page: number): string => JSON.stringify(titles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE))
const pages = Math.ceil(titles.length / PAGE_SIZE)

const tests = `import { expect, test } from '@rehearsal-labs/retest'

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
  await expect(page.getByTestId('result-count')).toHaveText('${titles.length} results')
  await expect(page.getByTestId('result-title')).toHaveText(${pageOf(1)})
  await expect(page.getByRole('link', { name: 'Previous page' })).toBeHidden()
  await page.getByRole('link', { name: 'Next page' }).click()
  await expect(page.getByTestId('page-status')).toHaveText('Page 2 of ${pages}')
  await expect(page.getByTestId('result-title')).toHaveText(${pageOf(2)})
  for (const next of ${JSON.stringify(Array.from({ length: pages - 2 }, (_unused, index) => index + 3))}) {
    await page.getByRole('link', { name: 'Next page' }).click()
    await expect(page.getByTestId('page-status')).toHaveText('Page ' + next + ' of ${pages}')
  }
  await expect(page.getByTestId('result-title')).toHaveText(${pageOf(pages)})
  await expect(page.getByRole('link', { name: 'Next page' })).toBeHidden()
  await page.getByRole('link', { name: 'Previous page' }).click()
  await expect(page.getByTestId('page-status')).toHaveText('Page ${pages - 1} of ${pages}')
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
`

const searches = 'a search lists only the matching books'
const paginates = 'pages through every result and back'
const filters = 'a genre filter narrows a search, and a search with no match says so'
const ignores = 'a search that ignores its words fails at the result count'

// How many documents the page's own form or links opened, which is how many times it asked the server.
function pagesOpenedByActions(run: FinishedRun, name: string): number {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'navigation').filter((event) => event.testId === testId && event.cause === 'action' && event.document === 'new').length
}

test('workflow family 9: the server searches, filters and pages the catalogue, an empty search says so, and a search that ignores its words fails at its check', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F9.1: Enter submitted the form once, and the server answered with the three matches.
  assert.equal(testNamed(run, searches).status, 'passed')
  assert.equal(pagesOpenedByActions(run, searches), 1)

  // F9.2: every page forward from the first, then one back, each a page the server sent.
  assert.equal(testNamed(run, paginates).status, 'passed')
  assert.equal(pagesOpenedByActions(run, paginates), pages - 1 + 1)

  // F9.3: a search, the same search within one genre, and a search with no match.
  assert.equal(testNamed(run, filters).status, 'passed')
  assert.equal(pagesOpenedByActions(run, filters), 3)

  // F9.4: the server dropped the words, so every book came back.
  assertFailedAt(run, ignores, {
    step: 'only the matching books are listed',
    failureClass: 'check_failed',
    line: lineOf(tests, "toHaveText('3 results')", 'only the matching books are listed'),
    message: new RegExp(`^getByTestId\\('result-count'\\) has text "${titles.length} results", expected "3 results"\\.`),
  })
})
