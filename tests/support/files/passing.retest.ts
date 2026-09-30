import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('returns values from nested steps', async ({ page }) => {
  const count = await test.step('outer', async () => {
    await page.goto('/tasks?draft=1#top')
    return test.step('inner', async () => {
      await expect(page.getByTestId('save-task')).toBeVisible()
      return 2
    })
  })
  expect(count).toBe(2)
})

test('reads each run of whitespace as one space', { timeout: 4000 }, async ({ page }) => {
  await expect(page.getByTestId('spaced-title')).toHaveText(' Release checklist ')
})
