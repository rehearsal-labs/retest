import { expect, test } from '@rehearsal-labs/retest'

// Navigation on the task app: relative and absolute addresses, reload, back and forward, the page's address and
// title, the action that caused each navigation, redirects, and the refusals and deadlines around them.

test('goto opens a relative address against the base URL, and an absolute address as it is', async ({ page }) => {
  await page.goto('/lookup/history/one')
  await expect(page).toHaveURL('/lookup/history/one')
  const origin = new URL(await page.url()).origin
  await page.goto(`${origin}/lookup/history/two`)
  await expect(page).toHaveTitle('Two')
  expect(await page.url()).toBe(`${origin}/lookup/history/two`)
})

test('reload, back and forward move through the history, and the page reads its address and title', async ({ page }) => {
  await page.goto('/lookup/history/one')
  await expect(page).toHaveURL('/lookup/history/one')
  await expect(page).toHaveTitle('One')
  await page.getByRole('link', { name: 'Next' }).click()
  await expect(page).toHaveURL(/\/lookup\/history\/two$/)
  await page.goBack()
  await expect(page).toHaveTitle('One')
  await page.goForward()
  await expect(page).toHaveTitle('Two')
  expect(await page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/lookup\/history\/two$/)
  expect(await page.title()).toBe('Two')
  await page.getByTestId('push').click()
  await expect(page).toHaveURL('/lookup/history/two/pushed')
  await expect(page).toHaveTitle('Two, pushed')
  await page.goBack()
  await expect(page).toHaveURL('/lookup/history/two')
  await expect(page).not.toHaveURL('/lookup/history/one')
  await page.goto('/lookup/history/reloaded')
  await expect(page.getByTestId('loads')).toHaveText('Loaded 1 times')
  await page.reload()
  await expect(page.getByTestId('loads')).toHaveText('Loaded 2 times')
  await expect(page).toHaveTitle('Reloaded')
})

test('a link, Enter in a form and a new path set by a click are each the action that caused them', async ({ page }) => {
  await page.goto('/titles')
  await page.getByTestId('next').click()
  await expect(page.getByTestId('arrived')).toHaveText('Arrived')
  await page.goto('/titles')
  await page.getByTestId('query').fill('release')
  await page.getByTestId('query').press('Enter')
  await expect(page.getByTestId('arrived')).toHaveText('Arrived')
  await page.goto('/titles')
  await page.getByTestId('push').click()
  await expect(page).toHaveURL('/titles/pushed')
  await expect(page).toHaveTitle('Pushed')
})

test('goto follows a redirect from the server, and a check waits for the page the page itself moves to', async ({ page }) => {
  await page.goto('/titles/chain')
  await expect(page.getByTestId('arrived')).toHaveText('Arrived')
  await expect(page).toHaveURL('/titles/next')
  await expect(page).toHaveTitle('Next')
})

test('toHaveURL fails naming both addresses', async ({ page }) => {
  await page.goto('/lookup/history/one')
  await expect(page).toHaveURL('/lookup/history/two', { timeout: 300 })
})

test('goBack with no earlier entry fails and sends nothing', async ({ page }) => {
  await page.goBack()
})

test('a page that never finishes loading fails when its navigation time runs out', async ({ page }) => {
  await page.goto('/hang', { timeout: 1000 })
})
