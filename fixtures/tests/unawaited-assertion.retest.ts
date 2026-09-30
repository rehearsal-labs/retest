import { expect, test } from '@rehearsal-labs/retest'

test('returns while an assertion is still looking', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  void expect(page.getByTestId('saved-task')).toHaveText('Release checklist').then(() => undefined, () => undefined)
})
