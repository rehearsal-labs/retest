import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SIGN_UP_ERRORS, TAKEN_EMAIL } from '../../fixtures/task-app/workflow-validation-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 6, show validation errors, against real Chrome and the task app's sign-up form, which
// checks itself on submit and is checked again by the server. The cases are F6.1 to F6.4 in
// docs/plans/public-beta/workflow-cases.md.

const file = 'tests/validation.retest.ts'
const assertFailedAt = failedAtIn(file)

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('a form with only a name shows the email, password and terms errors, and sends nothing', async ({ page }) => {
  await page.goto('/workflow/sign-up')
  await page.getByLabel('Name').fill('Grace Hopper')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toHaveText('Fix 3 problems to continue')
  await expect(page.getByTestId('name-error')).toHaveText('')
  await expect(page.getByTestId('email-error')).toHaveText('${SIGN_UP_ERRORS.email}')
  await expect(page.getByTestId('password-error')).toHaveText('${SIGN_UP_ERRORS.password}')
  await expect(page.getByTestId('confirmation-error')).toHaveText('')
  await expect(page.getByTestId('terms-error')).toHaveText('${SIGN_UP_ERRORS.terms}')
  await expect(page.getByTestId('welcome')).toHaveText('')
})

test('each wrong value gets its own message, fixing a field clears only its own, and a valid form is accepted', async ({ page }) => {
  await page.goto('/workflow/sign-up')
  await page.getByLabel('Email').fill('ada.example.com')
  await page.getByLabel('Password').fill('short')
  await page.getByLabel('Confirm password').fill('shorter')
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('alert')).toHaveText('Fix 5 problems to continue')
  await expect(page.getByTestId('name-error')).toHaveText('${SIGN_UP_ERRORS.name}')
  await expect(page.getByTestId('confirmation-error')).toHaveText('${SIGN_UP_ERRORS.confirmation}')
  await page.getByLabel('Email').fill('ada@example.com')
  await expect(page.getByTestId('email-error')).toHaveText('')
  await expect(page.getByTestId('password-error')).toHaveText('${SIGN_UP_ERRORS.password}')
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
  await page.getByLabel('Email').fill('${TAKEN_EMAIL}')
  await page.getByLabel('Password').fill('long enough password')
  await page.getByLabel('Confirm password').fill('long enough password')
  await page.getByLabel('I accept the terms').check()
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByTestId('email-error')).toHaveText('${SIGN_UP_ERRORS.taken}')
  await expect(page.getByRole('alert')).toHaveText('Fix 1 problem to continue')
  await expect(page.getByLabel('Name')).toHaveValue('Taken Person')
  await expect(page.getByLabel('Email')).toHaveValue('${TAKEN_EMAIL}')
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
    await expect(page.getByTestId('password-error')).toHaveText('${SIGN_UP_ERRORS.password}')
  })
})
`

const onlyName = 'a form with only a name shows the email, password and terms errors, and sends nothing'
const fixes = 'each wrong value gets its own message, fixing a field clears only its own, and a valid form is accepted'
const taken = 'an email the server knows is refused beside its field, and the typed values stay'
const shortPassword = 'a form that accepts a short password fails at the password error'

// How many sign-ups under this name reached the server.
async function received(origin: string, name: string): Promise<number> {
  const response = await fetch(`${origin}/workflow/api/sign-ups?name=${encodeURIComponent(name)}`)
  const body: unknown = await response.json()
  assert.ok(typeof body === 'object' && body !== null && 'received' in body && typeof body.received === 'number', 'the server says how many it received')
  return body.received
}

test('workflow family 6: a wrong form shows an error per field and sends nothing, the server refuses a taken email, and a missing rule fails at its check', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    [file]: tests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F6.1: the page refused the form itself, so nothing under that name reached the server.
  assert.equal(testNamed(run, onlyName).status, 'passed')
  assert.equal(await received(app.url, 'Grace Hopper'), 0)

  // F6.2: the first submit was refused by the page and only the corrected one was sent.
  assert.equal(testNamed(run, fixes).status, 'passed')
  assert.equal(await received(app.url, ''), 0, 'the submit without a name was never sent')
  assert.equal(await received(app.url, 'Ada Lovelace'), 1)

  // F6.3: the page let the form through, and the server refused it.
  assert.equal(testNamed(run, taken).status, 'passed')
  assert.equal(await received(app.url, 'Taken Person'), 1)

  // F6.4: neither the page nor the server checked the length, so the account was made and no error shows.
  assertFailedAt(run, shortPassword, {
    step: 'the short password is refused',
    failureClass: 'check_failed',
    line: lineOf(tests, "getByTestId('password-error')", 'the short password is refused'),
    message: new RegExp(`^getByTestId\\('password-error'\\) has text "", expected "${SIGN_UP_ERRORS.password}"\\.`),
  })
  assert.equal(await received(app.url, 'Short Password'), 1)
})
