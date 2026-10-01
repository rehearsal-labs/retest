import { expect, test } from '@rehearsal-labs/retest'

// The mouse wheel on the task app's scroll page, which lists every wheel event it hears.

test('scrolls the page, which loads more items', async ({ page }) => {
  await page.goto('/actions/scroll')
  await expect(page.getByTestId('items-count')).toHaveText('20')
  await page.scroll({ y: 5000 })
  await expect(page.getByTestId('items-count')).toHaveText('30')
})

test('scrolls the terms to their end, which enables Accept', async ({ page }) => {
  await page.goto('/actions/scroll')
  await page.getByTestId('terms').scroll({ y: 2000 })
  await expect(page.getByTestId('accept-state')).toHaveText('enabled')
  await page.getByRole('button', { name: 'Accept' }).click()
})

test.describe('a list a cover sits on', (test) => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('wheels-heard')).toHaveText('')
  })

  test('is not scrolled, and the page hears no wheel', async ({ page }) => {
    await page.goto('/actions/scroll')
    await page.getByTestId('covered-list').scroll({ y: 100 })
  })
})
