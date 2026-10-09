// Workflow family 5, edit and delete an object: F5.1 to F5.4 of docs/compatibility/workflow-cases.md, written
// as a Playwright test against the task app.
import { test, expect } from '@playwright/test'

test('edits a task and the change survives a reload', async ({ page }) => {
  await page.goto('/workflow/backlog')
  await page.getByRole('button', { name: 'Edit Book venue' }).click()
  await expect(page.getByLabel('Title')).toHaveValue('Book venue')
  await page.getByLabel('Title').fill('Book the main hall')
  await page.getByLabel('Priority').selectOption({ label: 'High' })
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book the main hall', 'Order badges'])
  await expect(page.getByTestId('item-priority')).toHaveText(['High', 'High', 'Low'])
  await page.reload()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book the main hall', 'Order badges'])
  await expect(page.getByTestId('item-priority')).toHaveText(['High', 'High', 'Low'])
})

test('asks before deleting, keeps the task on cancel and removes it on confirm', async ({ page }) => {
  await page.goto('/workflow/backlog')
  await page.getByRole('button', { name: 'Delete Book venue' }).click()
  await expect(page.getByTestId('delete-question')).toHaveText('Delete "Book venue"?')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book venue', 'Order badges'])
  await page.getByRole('button', { name: 'Delete Book venue' }).click()
  await page.getByRole('button', { name: 'Yes, delete' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Order badges'])
  await expect(page.getByTestId('backlog-count')).toHaveText('2 tasks')
  await page.reload()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Order badges'])
})

test('an edit the server never keeps fails after the reload', async ({ page }) => {
  await page.goto('/workflow/backlog?defect=edit-not-saved')
  await page.getByRole('button', { name: 'Edit Order badges' }).click()
  await page.getByLabel('Title').fill('Order name badges')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book venue', 'Order name badges'])
  await test.step('the change survives a reload', async () => {
    await page.reload()
    await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Book venue', 'Order name badges'])
  })
})

test('a delete that removes the wrong row fails at the remaining list', async ({ page }) => {
  await page.goto('/workflow/backlog?defect=deletes-wrong-row')
  await page.getByRole('button', { name: 'Delete Book venue' }).click()
  await page.getByRole('button', { name: 'Yes, delete' }).click()
  await test.step('only the deleted task is gone', async () => {
    await expect(page.getByTestId('item-title')).toHaveText(['Write release notes', 'Order badges'])
  })
})
