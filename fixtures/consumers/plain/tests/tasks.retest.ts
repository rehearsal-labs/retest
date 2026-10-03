import { expect, test } from '@rehearsal-labs/retest'
import { save, saved, title } from '../support/controls.ts'
import { trimmed } from '../support/format.mjs'
import legacy from '../support/legacy-data.cjs'
import { releaseTitle } from '../support/titles.js'

test('saves a task', async ({ page }) => {
  expect(legacy.heading).toBe('Tasks')
  await page.goto('/')
  await page.getByTestId(title).fill(trimmed(` ${releaseTitle()} `))
  await page.getByTestId(save).click()
  await expect(page.getByTestId(saved)).toHaveText('Release checklist')
})
