import { expect, test } from '@rehearsal-labs/retest'

// Actions on the task app: fill and click, hover, keys with and without modifiers, select, check and uncheck, and
// the wheel. Each page shows what it heard, and whether the browser marked it as trusted input.

test('fill types into a field, a click saves once, and the saved title is read back', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('task-title').fill('Release checklist')
  await page.getByTestId('save-task').click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('a click is a real press and release that the page hears once, as trusted input', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByTestId('agree').click()
  await expect(page.getByTestId('pointer-heard')).toHaveText('pointerdown:agree mousedown:agree click:agree')
  await expect(page.getByTestId('clicks-heard')).toHaveText('agree=1')
  await expect(page.getByTestId('changes-heard')).toHaveText('input:agree:true change:agree:true')
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

test('keys move the focus, Enter submits a form once, and shortcuts hold their modifiers', async ({ page }) => {
  await page.goto('/actions')
  await page.getByTestId('first').fill('one')
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('focus')).toHaveText('second')
  await page.keyboard.press('Shift+Tab')
  await expect(page.getByTestId('focus')).toHaveText('first')
  await page.getByTestId('query').fill('release')
  await page.getByTestId('query').press('Enter')
  await expect(page.getByTestId('submitted')).toHaveText('Searched for release')
  await page.goto('/lookup/shortcuts')
  await page.getByLabel('Note').press('ControlOrMeta+a')
  await page.getByLabel('Note').press('Backspace')
  await expect(page.getByLabel('Note')).toHaveValue('')
  await page.keyboard.press('Control+Shift+K')
  await expect(page.getByTestId('heard')).toContainText('Ctrl+Shift+K:true')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByRole('dialog', { name: 'Palette' })).toBeVisible()
})

test('select chooses by label, by value and several options at once, and the page hears trusted input', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByLabel('Country').select('Canada')
  await expect(page.getByTestId('country-shown')).toHaveText('ca')
  await page.getByLabel('Country').select({ value: 'mx' })
  await expect(page.getByTestId('country-shown')).toHaveText('mx')
  await page.getByLabel('Toppings').select(['Olives', 'Basil'])
  await expect(page.getByTestId('toppings-shown')).toHaveText('olives,basil')
  await expect(page.getByTestId('changes-heard')).toContainText('input:country:true change:country:true')
  await expect(page.getByTestId('changes-heard')).not.toContainText(':false')
})

test('check and uncheck work a checkbox, an element whose role is checkbox, a hidden checkbox through its label, and radios', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByTestId('agree').check()
  await page.getByTestId('remember').check()
  await page.getByTestId('newsletter').check()
  await page.getByTestId('large').check()
  await page.getByTestId('agree').uncheck()
  await page.getByTestId('agree').uncheck()
  await expect(page.getByTestId('checks-shown')).toHaveText('agree=false newsletter=true locked=false small=false large=true covered=false remember=true')
  await expect(page.getByTestId('clicks-heard')).toContainText('agree=2')
})

test('the wheel scrolls an element to its end and the page near its end, which each answer once', async ({ page }) => {
  await page.goto('/actions/scroll')
  await expect(page.getByTestId('accept')).toBeDisabled()
  await page.getByTestId('terms').scroll({ y: 2000 })
  await expect(page.getByTestId('accept')).toBeEnabled()
  await page.getByTestId('accept').click()
  await expect(page.getByTestId('items-count')).toHaveText('20')
  await page.scroll({ y: 5000 })
  await expect(page.getByTestId('items-count')).toHaveText('30')
})
