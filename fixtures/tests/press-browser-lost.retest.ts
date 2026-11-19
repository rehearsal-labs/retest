import { expect, test } from 'retest'

test('presses a key on a page that stops answering', async ({ page }) => {
  await page.goto('/keys')
  await page.getByLabel('Frozen').press('a')
})

test('runs after the browser is lost', async ({ page }) => {
  await page.goto('/keys')
  await expect(page.getByLabel('Frozen')).toBeVisible()
})
