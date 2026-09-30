import { expect, test } from '@rehearsal-labs/retest'

test('saves a task in steps', async ({ page }) => {
  await test.step('open the form', () => page.goto('/'))
  const title = await test.step('save a title', async () => {
    await page.getByTestId('task-title').fill('Release checklist')
    await test.step('press save', () => page.getByTestId('save-task').click())
    return 'Release checklist'
  })
  await expect(page.getByTestId('saved-task')).toHaveText(title)
})
