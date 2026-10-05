// Workflow family 8, find items in lists and tables: F8.1 to F8.4 of docs/plans/public-beta/workflow-cases.md,
// written as a Playwright test against the task app. Playwright names a table row from its cells, so F8.1 finds the
// row by that name.
import { test, expect } from '@playwright/test'

test('reads the table row by row and finds a member by name', async ({ page }) => {
  await page.goto('/workflow/team')
  await expect(page.getByTestId('member')).toHaveCount(6)
  await expect(page.getByRole('row')).toHaveText([
    'Name Email Role Open tasks',
    'Ada Lovelace ada@example.com Admin 3',
    'Grace Hopper grace@example.com Editor 12',
    'Alan Turing alan@example.com Viewer 9',
    'Katherine Johnson katherine@example.com Editor 25',
    'Edsger Dijkstra edsger@example.com Viewer 4',
    'Barbara Liskov barbara@example.com Admin 10',
  ])
  await expect(page.getByRole('row').nth(2).getByRole('cell').first()).toHaveText('Grace Hopper')
  await expect(page.getByRole('row').nth(2).getByRole('cell').nth(1)).toHaveText('grace@example.com')
  await expect(page.getByRole('row').last().getByRole('cell').last()).toHaveText('10')
  await expect(page.getByRole('cell', { name: 'Grace Hopper' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'katherine@example.com' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Role' })).toBeVisible()
  await expect(page.getByRole('row', { name: 'Grace Hopper grace@example.com Editor 12' })).toHaveCount(1)
})

test('sorts the table by name one way and then the other', async ({ page }) => {
  await page.goto('/workflow/team')
  await page.getByRole('button', { name: 'Name' }).click()
  await expect(page.getByTestId('member-name')).toHaveText(['Ada Lovelace', 'Alan Turing', 'Barbara Liskov', 'Edsger Dijkstra', 'Grace Hopper', 'Katherine Johnson'])
  await page.getByRole('button', { name: 'Name' }).click()
  await expect(page.getByTestId('member-name')).toHaveText(['Katherine Johnson', 'Grace Hopper', 'Edsger Dijkstra', 'Barbara Liskov', 'Alan Turing', 'Ada Lovelace'])
})

test('finds an invoice far down a long list and opens it', async ({ page }) => {
  await page.goto('/workflow/invoices')
  await expect(page.getByTestId('invoice')).toHaveCount(60)
  await page.getByRole('link', { name: 'INV-0047' }).click()
  await expect(page.getByTestId('heading')).toHaveText('Invoice INV-0047')
  await expect(page.getByTestId('amount')).toHaveText('$739.11')
})

test('a sort that compares numbers as text fails at the sorted column', async ({ page }) => {
  await page.goto('/workflow/team?defect=sorts-as-text')
  await page.getByRole('button', { name: 'Open tasks' }).click()
  await test.step('the open tasks go from fewest to most', async () => {
    await expect(page.getByTestId('member-tasks')).toHaveText(['3', '4', '9', '10', '12', '25'])
  })
})
