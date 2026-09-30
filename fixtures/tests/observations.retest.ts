import { expect, test } from '@rehearsal-labs/retest'

test('checks a saved task every way a locator can be checked', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await expect(page.getByLabel('Title')).toHaveValue('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  await expect(page.getByRole('heading')).toHaveText(['Tasks'])
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
  await expect(page.getByTestId('missing')).toBeHidden()
  await expect(page.getByTestId('missing')).toHaveCount(0)
  await expect.soft(page.getByTestId('saved-task')).toHaveText('Release checklist')
  expect('Release checklist').toMatch(/checklist/)
  await expect.poll(async () => 'saved').toBe('saved')
})
