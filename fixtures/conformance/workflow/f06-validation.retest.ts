import { expect, test } from '@rehearsal-labs/retest'
import { SIGN_UP_ERRORS, TAKEN_EMAIL } from '../../task-app/workflow-validation-page.ts'

// Workflow family 6, show validation errors: F6.1 to F6.4, as tests/integration/workflow-validation.test.ts runs them
// on Chrome.

test('a form with only a name shows the email, password and terms errors, and sends nothing', async ({ page }) => {
  await page.goto('/workflow/sign-up')
  await page.getByLabel('Name').fill('Grace Hopper')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toHaveText('Fix 3 problems to continue')
  await expect(page.getByTestId('name-error')).toHaveText('')
  await expect(page.getByTestId('email-error')).toHaveText(SIGN_UP_ERRORS.email)
  await expect(page.getByTestId('password-error')).toHaveText(SIGN_UP_ERRORS.password)
  await expect(page.getByTestId('confirmation-error')).toHaveText('')
  await expect(page.getByTestId('terms-error')).toHaveText(SIGN_UP_ERRORS.terms)
  await expect(page.getByTestId('welcome')).toHaveText('')
})

test('each wrong value gets its own message, fixing a field clears only its own, and a valid form is accepted', async ({ page }) => {
  await page.goto('/workflow/sign-up')
  await page.getByLabel('Email').fill('ada.example.com')
  await page.getByLabel('Password').fill('short')
  await page.getByLabel('Confirm password').fill('shorter')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toHaveText('Fix 5 problems to continue')
  await expect(page.getByTestId('name-error')).toHaveText(SIGN_UP_ERRORS.name)
  await expect(page.getByTestId('confirmation-error')).toHaveText(SIGN_UP_ERRORS.confirmation)
  await page.getByLabel('Email').fill('ada@example.com')
  await expect(page.getByTestId('email-error')).toHaveText('')
  await expect(page.getByTestId('password-error')).toHaveText(SIGN_UP_ERRORS.password)
  await page.getByLabel('Name').fill('Ada Lovelace')
  await page.getByLabel('Password').fill('analytical engine')
  await page.getByLabel('Confirm password').fill('analytical engine')
  await page.getByLabel('I accept the terms').check()
  await expect(page.getByTestId('terms-error')).toHaveText('')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByTestId('welcome')).toHaveText('Welcome, Ada Lovelace')
  await expect(page.getByTestId('error-summary')).toHaveText('')
})

test('an email the server knows is refused beside its field, and the typed values stay', async ({ page }) => {
  await page.goto('/workflow/sign-up')
  await page.getByLabel('Name').fill('Taken Person')
  await page.getByLabel('Email').fill(TAKEN_EMAIL)
  await page.getByLabel('Password').fill('long enough password')
  await page.getByLabel('Confirm password').fill('long enough password')
  await page.getByLabel('I accept the terms').check()
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByTestId('email-error')).toHaveText(SIGN_UP_ERRORS.taken)
  await expect(page.getByRole('alert')).toHaveText('Fix 1 problem to continue')
  await expect(page.getByLabel('Name')).toHaveValue('Taken Person')
  await expect(page.getByLabel('Email')).toHaveValue(TAKEN_EMAIL)
  await expect(page.getByTestId('welcome')).toHaveText('')
})

test('a form that accepts a short password fails at the password error', async ({ page }) => {
  await page.goto('/workflow/sign-up?defect=accepts-short-password')
  await page.getByLabel('Name').fill('Short Password')
  await page.getByLabel('Email').fill('short@example.com')
  await page.getByLabel('Password').fill('abc')
  await page.getByLabel('Confirm password').fill('abc')
  await page.getByLabel('I accept the terms').check()
  await page.getByRole('button', { name: 'Create account' }).click()
  await test.step('the short password is refused', async () => {
    await expect(page.getByTestId('password-error')).toHaveText(SIGN_UP_ERRORS.password)
  })
})
