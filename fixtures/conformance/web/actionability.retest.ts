import { expect, test } from '@rehearsal-labs/retest'

// Actionability on the task app: an action waits for its element to be ready, and refuses one that is covered,
// disabled or hidden when its time runs out, naming the check that failed. A cover that appears as the pointer
// arrives takes the press, and Retest stops the click before the page hears it. After a refusal the page is read
// again in an afterEach, which runs after a failed test too, so the record shows what the page heard.

test('a click waits for a button that is enabled a moment after the page loads, and clicks it once', async ({ page }) => {
  await page.goto('/lookup/states')
  await page.getByTestId('enabled-later').click()
  await expect(page.getByTestId('enabled-later')).toBeEnabled()
  // A disabled button hears no click, so one click heard is one click sent once it was enabled.
  await expect(page.getByTestId('later-clicks')).toHaveText('1')
})

test('a click on a covered button is refused when its time runs out, naming what covers it', async ({ page }) => {
  await page.goto('/lookup/hover')
  await page.getByTestId('under').click({ timeout: 500 })
})

test('a click on a disabled button is refused when its time runs out', async ({ page }) => {
  await page.goto('/lookup/states')
  await page.getByTestId('send').click({ timeout: 500 })
})

test('a click on a hidden element is refused when its time runs out', async ({ page }) => {
  await page.goto('/lookup/hover')
  await page.getByTestId('tip').click({ timeout: 500 })
})

test.describe('a checkbox a cover sits on', (test) => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('pointer-heard')).toHaveText('')
    await expect(page.getByTestId('changes-heard')).toHaveText('')
    await expect(page.getByTestId('checks-shown')).toHaveText('agree=false newsletter=false locked=false small=true large=false covered=false remember=false')
  })

  test('a covered checkbox is not checked', async ({ page }) => {
    await page.goto('/actions/choices')
    await page.getByTestId('covered').check({ timeout: 500 })
  })

  test('a checkbox covered as the pointer arrives takes no click, and the page hears no part of one', async ({ page }) => {
    await page.goto('/actions/choices')
    await page.getByTestId('hover-covered').check()
  })
})

test.describe('a list a cover sits on', (test) => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByTestId('wheels-heard')).toHaveText('')
  })

  test('a covered list is not scrolled', async ({ page }) => {
    await page.goto('/actions/scroll')
    await page.getByTestId('covered-list').scroll({ y: 100 }, { timeout: 500 })
  })
})
