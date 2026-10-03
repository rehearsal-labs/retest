import { expect, test } from '@rehearsal-labs/retest'

// Scoped locators, picks, CSS, placeholders and patterns; the state matchers and their negations; reload, back and
// forward with the page's address and title; hover; and shortcuts, on the task app's lookup pages.

test('scoped lookups find inside a list, and picks choose among its matches', async ({ page }) => {
  await page.goto('/lookup/find')
  const inbox = page.getByTestId('inbox')
  await expect(inbox.getByRole('button', { name: 'Delete' })).toHaveCount(3)
  await inbox.getByRole('button', { name: 'Delete' }).nth(1).click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Walk the dog')
  await inbox.getByRole('listitem').last().getByRole('button').click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Pay rent')
  await page.getByTestId('archive').getByRole('button', { name: 'Delete' }).click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Old task')
  await page.getByRole('button', { name: 'Delete' }).first().click()
  await expect(page.getByTestId('last-deleted')).toHaveText('Buy milk')
  await expect(page.getByRole('listitem').nth(-1)).toHaveText('Old task Delete')
  await expect(inbox.getByText('Old task')).toHaveCount(0)
})

test('CSS, placeholders and patterns find elements, and a step never finds the elements it looks inside', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.locator('.task.done span')).toHaveText('Pay rent')
  await expect(page.locator('section').first().locator('li')).toHaveCount(3)
  await expect(page.getByTestId('inbox').locator('section')).toHaveCount(0)
  await expect(page.getByPlaceholder('Search archive')).toHaveValue('archive search')
  await expect(page.getByPlaceholder('search', { exact: false })).toHaveCount(3)
  await expect(page.getByPlaceholder('Search everything')).toHaveValue('everything')
  await expect(page.getByPlaceholder(/^search (inbox|archive)$/i)).toHaveCount(2)
  await expect(page.getByTestId('archive').getByPlaceholder(/search/i)).toHaveValue('archive search')
  await expect(page.getByRole('heading', { name: /^Arch/ })).toHaveText('Archive')
  await expect(page.getByText(/^Saved \d+ tasks$/)).toBeVisible()
  await expect(page.getByLabel(/e-?mail/i)).toHaveValue('ada@tasks.example')
})

test('a scoped click that matches several elements is ambiguous', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.getByTestId('inbox').getByRole('button', { name: 'Delete' }).click()
})

test('a click whose outer step matches nothing names that step', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.getByTestId('trash').getByRole('button').click()
})

test('a click whose index is past the matches says how many there were', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.getByRole('listitem').nth(9).click()
})

test('a CSS selector the page cannot read fails at once', async ({ page }) => {
  await page.goto('/lookup/find')
  await page.locator('li:no-such-thing').click()
})

test('an assertion whose outer step matches nothing names that step', async ({ page }) => {
  await page.goto('/lookup/find')
  await expect(page.getByTestId('trash').getByRole('button')).toBeVisible()
})

test('state matchers and their negations pass on what the page shows', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('agree')).toBeChecked()
  await expect(page.getByLabel('Newsletter')).not.toBeChecked()
  await expect(page.getByRole('checkbox', { name: 'Remember me' })).toBeChecked()
  await expect(page.getByTestId('some')).not.toBeChecked()
  await expect(page.getByTestId('save')).toBeEnabled()
  await expect(page.getByTestId('send')).toBeDisabled()
  await expect(page.getByTestId('in-fieldset')).toBeDisabled()
  await expect(page.getByTestId('in-group')).not.toBeEnabled()
  await expect(page.getByTestId('enabled-again')).toBeEnabled()
  await expect(page.getByTestId('enabled-later')).toBeEnabled()
  await expect(page.getByTestId('status')).toContainText('3 tasks')
  await expect(page.getByTestId('status')).toHaveText(/^Saved \d tasks$/)
  await expect(page.getByTestId('status')).not.toHaveText('Saved')
  await expect(page.getByTestId('release')).toHaveValue(/^Release \d$/)
  await expect(page.getByTestId('missing')).not.toBeVisible()
  await expect(page.getByTestId('status')).not.toBeHidden()
  await expect(page.getByRole('checkbox')).not.toHaveCount(1)
})

test('toBeChecked fails on an unchecked box', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('newsletter')).toBeChecked()
})

test('toBeChecked fails on what cannot be checked', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('status')).toBeChecked()
})

test('toBeDisabled fails on an enabled button within its own shorter timeout', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('save')).toBeDisabled({ timeout: 300 })
})

test('a negation never passes on a missing element', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('missing')).not.toBeChecked()
})

test('a negation fails on what shows the condition true', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByTestId('status')).not.toContainText('3 tasks')
})

test('a negation of a single-element matcher is ambiguous on several matches', async ({ page }) => {
  await page.goto('/lookup/states')
  await expect(page.getByRole('checkbox')).not.toBeChecked()
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

test('goBack with no earlier entry fails and sends nothing', async ({ page }) => {
  await page.goBack()
})

test('toHaveURL fails naming both addresses', async ({ page }) => {
  await page.goto('/lookup/history/one')
  await expect(page).toHaveURL('/lookup/history/two', { timeout: 300 })
})

test('toHaveTitle fails naming the title', async ({ page }) => {
  await page.goto('/lookup/history/one')
  await expect(page).not.toHaveTitle(/^On/, { timeout: 300 })
})

test('toHaveURL compares the whole address, query and fragment included, and page.url() reads origin and path', async ({ page }) => {
  await page.goto('/lookup/find?tab=notes#top')
  await expect(page).toHaveURL('/lookup/find?tab=notes#top')
  await expect(page).not.toHaveURL('/lookup/find')
  await expect(page).toHaveURL(/\?tab=notes#top$/)
  expect(await page.url()).toMatch(/\/lookup\/find$/)
})

test('a negation of toHaveURL sees the query', async ({ page }) => {
  await page.goto('/lookup/find?error=1')
  await expect(page).not.toHaveURL(/[?&]error=/, { timeout: 300 })
})

test('a title longer than Retest records is compared whole, both ways', async ({ page }) => {
  await page.goto('/lookup/long-title')
  await expect(page).toHaveTitle('Quarterly report '.repeat(25).trim())
  await expect(page).not.toHaveTitle('Quarterly report '.repeat(25).trim(), { timeout: 300 })
})

test('hover moves the mouse onto an element, again at the same place, and onto a disabled one', async ({ page }) => {
  await page.goto('/lookup/hover')
  await page.getByTestId('share').hover()
  await expect(page.getByTestId('tip')).toBeVisible()
  await page.getByTestId('share').hover()
  await page.getByTestId('locked').hover()
  await expect(page.getByTestId('locked-tip')).toBeVisible()
  await expect(page.getByTestId('hovers')).toContainText('pointerover:share:true')
})

test.describe('a hover that cannot reach its element', (test) => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('hovers')).not.toContainText('under')
  })

  test('does not move onto a covered element', async ({ page }) => {
    await page.goto('/lookup/hover')
    await page.getByTestId('under').hover()
  })
})

test('shortcuts hold their modifiers, and the editing ones edit', async ({ page }) => {
  await page.goto('/lookup/shortcuts')
  await page.getByLabel('Note').press('ControlOrMeta+a')
  await page.getByLabel('Note').press('Backspace')
  await expect(page.getByLabel('Note')).toHaveValue('')
  await page.keyboard.press('Control+Shift+K')
  await expect(page.getByTestId('heard')).toContainText('Ctrl+Shift+K:true')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Palette' })).toBeVisible()
})
