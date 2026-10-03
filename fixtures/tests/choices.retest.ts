import { expect, test } from '@rehearsal-labs/retest'

// select, check and uncheck on the task app's choices page, which shows every change it hears, whether each was
// trusted, and every click on a checkable control. A select is chosen with the keyboard, so its changes are trusted.

test('chooses by label, by value and from a list, and waits for an option that arrives late', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByLabel('Country').select('Canada')
  await expect(page.getByTestId('country-shown')).toHaveText('ca')
  await page.getByLabel('Country').select({ value: 'mx' })
  await page.getByLabel('Country').select('Mexico')
  await expect(page.getByTestId('country-shown')).toHaveText('mx')
  await page.getByLabel('Toppings').select(['Basil', { value: 'olives' }])
  await expect(page.getByTestId('toppings-shown')).toHaveText('olives,basil')
  await page.getByLabel('Toppings').select(['Garlic'])
  await expect(page.getByTestId('toppings-shown')).toHaveText('garlic')
  await page.getByRole('button', { name: 'Add Peru' }).click()
  await page.getByLabel('Country').select('Peru')
  await expect(page.getByTestId('country-shown')).toHaveText('pe')
  // The keyboard chooses: one change for each option typed to, and one for each option of the list toggled.
  await expect(page.getByTestId('changes-heard')).toHaveText(
    [
      'input:country:true change:country:true input:country:true change:country:true',
      'input:toppings:true change:toppings:true input:toppings:true change:toppings:true input:toppings:true change:toppings:true',
      'input:toppings:true change:toppings:true input:toppings:true change:toppings:true input:toppings:true change:toppings:true',
      'input:country:true change:country:true',
    ].join(' '),
  )
})

test('ticks and unticks a checkbox, an element whose role is checkbox, and a hidden checkbox through its label', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByLabel('I agree').check()
  await page.getByTestId('agree').check()
  await expect(page.getByTestId('clicks-heard')).toHaveText('agree=1')
  await page.getByLabel('I agree').uncheck()
  await page.getByRole('checkbox', { name: 'Remember me' }).check()
  await page.getByLabel('Newsletter').check()
  await expect(page.getByTestId('checks-shown')).toHaveText('agree=false newsletter=true locked=false small=true large=false covered=false remember=true')
  await page.getByRole('checkbox', { name: 'Remember me' }).uncheck()
  await expect(page.getByTestId('clicks-heard')).toHaveText('agree=2 remember=2 newsletter-label=1 newsletter=1')
})

test('waits for an option that never comes, and fails naming it', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByLabel('Country').select('Atlantis')
})

test.describe('a failed choice or tick changes nothing', (test) => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('changes-heard')).toHaveText('')
    await expect(page.getByTestId('pointer-heard')).toHaveText('')
  })

  test('refuses two options with one label at once', async ({ page }) => {
    await page.goto('/actions/choices')
    await page.getByLabel('City').select('Paris')
  })

  test('refuses to uncheck a radio button', async ({ page }) => {
    await page.goto('/actions/choices')
    await page.getByLabel('Small').uncheck()
  })

  test('does not tick a checkbox a cover sits on', async ({ page }) => {
    await page.goto('/actions/choices')
    await page.getByTestId('covered').check()
  })

  test('stops the click on a checkbox a cover takes as the pointer arrives', async ({ page }) => {
    await page.goto('/actions/choices')
    await page.getByTestId('hover-covered').check()
  })
})

test('clicks a setting that ignores its click once, and fails', async ({ page }) => {
  await page.goto('/actions/choices')
  await page.getByLabel('Locked setting').check()
})
