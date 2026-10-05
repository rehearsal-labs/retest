import { expect, test } from '@rehearsal-labs/retest'
import { INVOICE_COUNT, invoiceAmountOf, TEAM } from '../../task-app/workflow-lists-page.ts'

// Workflow family 8, find items in lists and tables: F8.1 to F8.4, as tests/integration/workflow-lists.test.ts runs
// them on Chrome, with F8.1 as two tests: the table read by position and its cells by name, and a row by name refused.

const byName = TEAM.map((member) => member.name).sort((first, second) => first.localeCompare(second, 'en'))
const byTasks = TEAM.map((member) => member.tasks).sort((first, second) => first - second)
const rows = ['Name Email Role Open tasks', ...TEAM.map((member) => `${member.name} ${member.email} ${member.role} ${member.tasks}`)]
const second = TEAM[1]
const secondRow = second === undefined ? '' : `${second.name} ${second.email} ${second.role} ${second.tasks}`

test('reads the table row by row and finds a member by name', async ({ page }) => {
  await page.goto('/workflow/team')
  await expect(page.getByTestId('member')).toHaveCount(TEAM.length)
  await expect(page.getByRole('row')).toHaveText(rows)
  await expect(page.getByRole('row').nth(2).getByRole('cell').first()).toHaveText('Grace Hopper')
  await expect(page.getByRole('row').nth(2).getByRole('cell').nth(1)).toHaveText('grace@example.com')
  await expect(page.getByRole('row').last().getByRole('cell').last()).toHaveText('10')
  await expect(page.getByRole('cell', { name: 'Grace Hopper' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'katherine@example.com' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Role' })).toBeVisible()
})

// Chrome's accessibility tree gives a table row no name from its cells and Retest computes none, so a row found by its
// name would match nothing, and a check that it is hidden would pass beside a row on screen. Retest refuses the lookup
// by name before the page is asked, on every engine; a row is taken by position, as above.
test('a table row found by its name is refused by name at once', async ({ page }) => {
  await page.goto('/workflow/team')
  await expect(page.getByRole('row', { name: secondRow })).toBeVisible()
})

test('sorts the table by name one way and then the other', async ({ page }) => {
  await page.goto('/workflow/team')
  await page.getByRole('button', { name: 'Name' }).click()
  await expect(page.getByTestId('member-name')).toHaveText(byName)
  await page.getByRole('button', { name: 'Name' }).click()
  await expect(page.getByTestId('member-name')).toHaveText(byName.toReversed())
})

test('finds an invoice far down a long list and opens it', async ({ page }) => {
  await page.goto('/workflow/invoices')
  await expect(page.getByTestId('invoice')).toHaveCount(INVOICE_COUNT)
  await page.getByRole('link', { name: 'INV-0047' }).click()
  await expect(page.getByTestId('heading')).toHaveText('Invoice INV-0047')
  await expect(page.getByTestId('amount')).toHaveText(invoiceAmountOf(47))
})

test('a sort that compares numbers as text fails at the sorted column', async ({ page }) => {
  await page.goto('/workflow/team?defect=sorts-as-text')
  await page.getByRole('button', { name: 'Open tasks' }).click()
  await test.step('the open tasks go from fewest to most', async () => {
    await expect(page.getByTestId('member-tasks')).toHaveText(byTasks.map(String))
  })
})
