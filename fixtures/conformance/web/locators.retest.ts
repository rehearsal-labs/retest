import { expect, test } from '@rehearsal-labs/retest'

// Locators on the task app's lookup pages: each kind, scoped lookups and picks, the exact rule by default and with
// `exact: false`, regular expressions, strict matching for actions and single-element checks, and an action whose
// locator matches nothing.

test('each kind of locator finds its element: test id, role and name, label, text, placeholder and CSS', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('Saved 3 tasks')
  await expect(page.getByRole('heading', { name: 'Archive' })).toHaveText('Archive')
  await expect(page.getByLabel('E-mail')).toHaveValue('ada@tasks.example')
  await expect(page.getByText('Walk the dog')).toHaveCount(1)
  await expect(page.getByPlaceholder('Search archive')).toHaveValue('archive search')
  await expect(page.locator('.task.done span')).toHaveText('Pay rent')
  await expect(page.locator('section').first().locator('li')).toHaveCount(3)
})

test('scoped lookups find inside an element, and first, last and nth pick among the matches', async ({ page }) => {
  await page.goto('/lookup/find')
  const inbox = page.getByTestId('inbox')
  await expect(inbox.getByRole('button', { name: 'Delete' })).toHaveCount(3)
  await inbox.getByRole('button', { name: 'Delete' }).nth(1).click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Walk the dog')
  await inbox.getByRole('listitem').last().getByRole('button').click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Pay rent')
  await page.getByTestId('archive').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Old task')
  await page.getByRole('button', { name: 'Delete' }).first().click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Buy milk')
  await expect(page.getByRole('listitem').nth(-1)).toHaveText('Old task Delete')
  await expect(inbox.getByText('Old task')).toHaveCount(0)
  await expect(page.getByTestId('inbox').locator('section')).toHaveCount(0)
})

test('a name, a label, a text and a placeholder match exactly by default: case and the whole text count, spaces aside', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByRole('button', { name: 'delete' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(4)
  await expect(page.getByRole('heading', { name: 'Arch' })).toHaveCount(0)
  await expect(page.getByLabel('e-mail')).toHaveCount(0)
  await expect(page.getByText('Walk the')).toHaveCount(0)
  await expect(page.getByPlaceholder('Search')).toHaveCount(0)
  await expect(page.getByPlaceholder('Search everything')).toHaveValue('everything')
})

test('exact: false matches any case and any part, and keeps only the innermost text', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByRole('button', { name: 'delete', exact: false })).toHaveCount(4)
  await expect(page.getByRole('heading', { name: 'arch', exact: false })).toHaveText('Archive')
  await expect(page.getByLabel('mail', { exact: false })).toHaveValue('ada@tasks.example')
  await expect(page.getByText('walk the', { exact: false })).toHaveText('Walk the dog')
  await expect(page.getByPlaceholder('search', { exact: false })).toHaveCount(3)
})

test('a regular expression matches a name, a label, a text and a placeholder with its own flags', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByRole('heading', { name: /^Arch/ })).toHaveText('Archive')
  await expect(page.getByRole('button', { name: /delete/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /delete/i })).toHaveCount(4)
  await expect(page.getByText(/^Saved \d+ tasks$/)).toBeVisible()
  await expect(page.getByLabel(/e-?mail/i)).toHaveValue('ada@tasks.example')
  await expect(page.getByPlaceholder(/^search (inbox|archive)$/i)).toHaveCount(2)
  await expect(page.getByTestId('archive').getByPlaceholder(/search/i)).toHaveValue('archive search')
})

test.describe('several matches', (test) => {
  // Runs after the failed click too: any Delete clicked would have named its task here.
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('last-deleted')).toHaveText('none')
  })

  test('an action on a locator that matches several elements fails at once as ambiguous, and clicks none of them', async ({ page }) => {
    await page.goto('/lookup/find')
    await page.getByTestId('inbox').getByRole('button', { name: 'Delete' }).click()
  })
})

test('a check that needs one element fails as ambiguous on several matches', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByRole('checkbox')).toBeChecked()
})

test('an action on a locator that matches nothing fails as not found when its time runs out', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.getByTestId('trash').getByRole('button').click()
})

test('a CSS selector the page cannot read fails at once', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.locator('li:no-such-thing').click()
})
