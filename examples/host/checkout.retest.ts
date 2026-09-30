import { expect, secret, test } from '@rehearsal-labs/retest'

// The test examples/host/host.ts writes for the task app. It signs in with a password and a one-time code, both
// secrets the host gives as functions, and saves a task. It prints which of the host's variables it can see.

test('signs in with a code and saves a task', async ({ page }) => {
  for (const name of ['CANARY', 'HOST_TOKEN', 'HOST_PASSWORD']) console.log(`${name} is ${process.env[name] === undefined ? 'not set' : 'set'}`)
  await page.goto('/code/sign-in')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Send code' }).click()
  // Retest reads the code as the fill begins, so the test waits until the page asks for it.
  await expect(page.getByLabel('Code')).toBeVisible()
  await page.getByLabel('Code').fill(secret('code'))
  await page.getByLabel('Code').press('Enter')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
