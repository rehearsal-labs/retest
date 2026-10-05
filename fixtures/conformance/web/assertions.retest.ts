import { expect, test } from '@rehearsal-labs/retest'

// Assertions on the task app: every locator and page matcher, their negations, regular expressions, value
// assertions, a soft assertion, polling until the page shows what is expected, and failures after a check's own
// deadline or at once where the page can never satisfy it.

test('state matchers and their negations pass on what the page shows', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('agree')).toBeChecked()
  await expect(page.getByLabel('Newsletter')).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Remember me' })).toBeChecked()
  await expect(page.getByTestId('some')).not.toBeChecked()
  await expect(page.getByTestId('save')).toBeEnabled()
  await expect(page.getByTestId('send')).toBeDisabled()
  await expect(page.getByTestId('in-fieldset')).toBeDisabled()
  await expect(page.getByTestId('in-group')).not.toBeEnabled()
  await expect(page.getByTestId('enabled-again')).toBeEnabled()
  await expect(page.getByTestId('status')).toContainText('3 tasks')
  await expect(page.getByTestId('status')).not.toHaveText('Saved')
  await expect(page.getByTestId('missing')).not.toBeVisible()
  await expect(page.getByTestId('missing')).toBeHidden()
  await expect(page.getByTestId('status')).not.toBeHidden()
  await expect(page.getByRole('checkbox')).not.toHaveCount(1)
})

test('text, value and count compare the whole text with spaces read as one, and a list in order', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('Saved 3 tasks')
  await expect(page.getByTestId('summary')).toBeVisible()
  await expect(page.getByTestId('inbox').getByRole('listitem')).toHaveText(['Buy milk Delete', 'Walk the dog Delete', 'Pay rent Delete'])
  await expect(page.getByTestId('inbox').getByRole('listitem')).toHaveCount(3)
  await expect(page.getByPlaceholder('Search inbox')).toHaveValue('inbox search')
  await page.goto('/lookup/states')
  await expect(page.getByTestId('status')).toHaveText('Saved 3 tasks')
})

test('regular expressions match text, a value, the address and the title', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('status')).toHaveText(/^Saved \d tasks$/)
  await expect(page.getByTestId('status')).toContainText(/\d tasks/)
  await expect(page.getByTestId('release')).toHaveValue(/^Release \d$/)
  await expect(page).toHaveURL(/\/lookup\/states$/)
  await expect(page).toHaveTitle(/^Sta/)
  await expect(page).not.toHaveTitle(/^Find$/)
})

test('value assertions compare what the test holds, and poll reads again until it matches', async ({ page }) => {
  await page.goto('/lookup/find')
  expect(await page.title()).toBe('Find')
  expect({ tasks: ['Buy milk', 'Walk the dog'] }).toEqual({ tasks: ['Buy milk', 'Walk the dog'] })
  expect(['Buy milk', 'Walk the dog']).toContain('Walk the dog')
  expect(await page.url()).toMatch(/\/lookup\/find$/)
  await expect.poll(() => page.title()).toBe('Find')
  // A value that turns true only after a moment, so the poll must read it more than once before it matches.
  const asked = performance.now()
  await expect.poll(() => performance.now() - asked >= 200).toBe(true)
})

test('a check looks again until the page shows what it expects', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('enabled-later')).toBeEnabled()
})

test('a soft check that fails lets the test go on, and the test fails at it', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect.soft(page.getByTestId('summary')).toHaveText('Saved 4 tasks', { timeout: 300 })
  await page.getByRole('button', { name: 'Delete' }).first().click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Buy milk')
})

test('toHaveText fails after looking for its whole time, naming what the page showed', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('Saved 4 tasks')
})

test('a negation fails on what shows the condition true', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('status')).not.toContainText('3 tasks')
})

test('a negation never passes on a missing element', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('missing')).not.toBeChecked()
})

test('toBeDisabled fails on an enabled button within its own shorter time', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('save')).toBeDisabled({ timeout: 300 })
})

test('a negated title check fails naming the title', async ({ page }) => {
  await page.goto('/lookup/history/one')
  await expect(page).not.toHaveTitle(/^On/, { timeout: 300 })
})
