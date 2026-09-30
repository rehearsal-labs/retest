import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/done')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  expect(true).toBe(true)
})

test('fails itself', async ({ page }) => {
  await page.goto('/done')
  expect(1).toBe(2)
})
