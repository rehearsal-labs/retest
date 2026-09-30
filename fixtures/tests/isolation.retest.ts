import { expect, test } from '@rehearsal-labs/retest'
import { countTest } from './tests-in-process.ts'

test('remembers a saved task in its own tab', async ({ page }) => {
  expect(countTest()).toBe(1)
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  await page.goto('/')
  await expect(page.getByTestId('last-saved')).toHaveText('Release checklist')
  await expect(page.getByTestId('page-loads')).toHaveText('2')
})

test('starts with clean storage in a new tab', async ({ page }) => {
  // Module state is shared by the tests in one file.
  expect(countTest()).toBe(2)
  await page.goto('/')
  await expect(page.getByTestId('last-saved')).toHaveText('')
  await expect(page.getByTestId('page-loads')).toHaveText('1')
})
