import { expect, test } from '@rehearsal-labs/retest'

test('submits a search with Enter on its field', async ({ page }) => {
  await page.goto('/actions')
  await page.getByLabel('Search').fill('alpha')
  await page.getByLabel('Search').press('Enter')
  await expect(page.getByTestId('submitted')).toHaveText('Searched for alpha')
})

test("submits a search with Enter on the page's keyboard", async ({ page }) => {
  await page.goto('/actions')
  await page.getByLabel('Search').fill('beta')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('submitted')).toHaveText('Searched for beta')
})

test('moves the focus with Tab and back with Shift+Tab', async ({ page }) => {
  await page.goto('/actions')
  await page.getByLabel('First').press('Tab')
  await expect(page.getByTestId('focus')).toHaveText('second')
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('focus')).toHaveText('first')
  await expect(page.getByTestId('keys-heard')).toHaveText('Tab Shift:shift Tab:shift')
})

test.describe('a field whose focus a notice takes', (test) => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('focus')).toHaveText('notice')
    await expect(page.getByTestId('keys-heard')).toHaveText('')
  })

  test('gets no key, and the page hears none', async ({ page }) => {
    await page.goto('/keys')
    await page.getByLabel('Note').press('Enter')
  })
})
