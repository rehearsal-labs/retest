import { expect, test } from '@rehearsal-labs/retest'

// Test structure on the task app: a suite whose beforeEach opens the page and whose afterEach checks it, steps,
// a parameterized test, and skipped tests and blocks, which never run and never pass.

test.describe('a suite with hooks', (test) => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/lookup/find')
  })

  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('summary')).toHaveText('Saved 3 tasks')
  })

  test('starts from what its beforeEach opened, and runs its steps in order', async ({ page }) => {
    await test.step('delete the first task', async () => {
      await page.getByRole('button', { name: 'Delete' }).first().click()
    })
    await test.step('the deleted task is named', async () => {
      await expect(page.getByTestId('last-deleted')).toHaveText('Buy milk')
    })
  })

  test.describe('with an afterEach of its own', (test) => {
    test.afterEach(async ({ page }) => {
      await expect(page.getByTestId('last-deleted')).toHaveText('none', { timeout: 300 })
    })

    test('a test whose afterEach check fails fails at that check', async ({ page }) => {
      await page.getByRole('button', { name: 'Delete' }).last().click()
    })
  })
})

test.for([
  { task: 'Buy milk', index: 0 },
  { task: 'Pay rent', index: 2 },
])('deletes $task by its place in the inbox', async ({ page }, row) => {
  await page.goto('/lookup/find')
  await page.getByTestId('inbox').getByRole('button', { name: 'Delete' }).nth(row.index).click()
  await expect(page.getByTestId('last-deleted')).toHaveText(row.task)
})

test.skip('a skipped test never runs', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('summary')).toHaveText('never there')
})

test.describe.skip('a skipped block', (test) => {
  test('a test in a skipped block never runs', async ({ page }) => {
    await page.goto('/lookup/find')
    await expect(page.getByTestId('summary')).toHaveText('never there')
  })
})
