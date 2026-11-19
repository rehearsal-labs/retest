import { secret, test } from 'retest'

test('fills a secret without a config', async ({ page }) => {
  await page.getByTestId('task-title').fill(secret('password'))
})
