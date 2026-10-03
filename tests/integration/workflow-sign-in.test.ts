import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKFLOW_PASSWORD } from '../../fixtures/task-app/workflow-sign-in-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, testNamed, textHolds, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 2, password sign-in and sign-out, against real Chrome and the task app's workflow
// sign-in pages. The password comes from the run's environment as a secret, and no file of the run holds it. The
// cases are F2.1 to F2.4 in docs/plans/public-beta/workflow-cases.md.

const file = 'tests/sign-in.retest.ts'
const assertFailedAt = failedAtIn(file)
const variable = 'RETEST_E2E_WORKFLOW_PASSWORD'

const tests = `import type { Page } from '@rehearsal-labs/retest'
import { expect, secret, test } from '@rehearsal-labs/retest'

async function signIn(page: Page): Promise<void> {
  await page.goto('/workflow/sign-in')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
}

test('signs in with the password and lands on the account page', async ({ page }) => {
  await signIn(page)
  await expect(page.getByTestId('stored-user')).toHaveText('alice')
  await expect(page.getByTestId('project')).toHaveText(['Apollo', 'Borealis'])
})

test('a wrong password shows an error and leaves the person signed out', async ({ page }) => {
  await page.goto('/workflow/sign-in')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('alert')).toHaveText('Wrong user name or password')
  await expect(page.getByTestId('heading')).toHaveText('Sign in')
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('projects-status')).toHaveText('Sign in to see your projects')
})

test('signing out ends the session', async ({ page }) => {
  await signIn(page)
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByTestId('signed-out-notice')).toHaveText('You are signed out.')
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('stored-user')).toHaveText('')
  await expect(page.getByTestId('projects-status')).toHaveText('Sign in to see your projects')
})

test('a sign-out that keeps the session fails at the signed-out check', async ({ page }) => {
  await signIn(page)
  await page.goto('/workflow/account?defect=keeps-session')
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page.getByTestId('signed-out-notice')).toHaveText('You are signed out.')
  await test.step('the account page shows signed out', async () => {
    await page.goto('/workflow/account')
    await expect(page.getByTestId('account')).toHaveText('Signed out')
  })
})
`

const signsIn = 'signs in with the password and lands on the account page'
const wrongPassword = 'a wrong password shows an error and leaves the person signed out'
const signsOut = 'signing out ends the session'
const keepsSession = 'a sign-out that keeps the session fails at the signed-out check'

// The paths a test's page opened, in order.
function paths(run: FinishedRun, name: string, origin: string): string[] {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'navigation')
    .filter((event) => event.testId === testId)
    .map((event) => event.url.slice(origin.length))
}

test('workflow family 2: a password signs in, a wrong one is refused, sign-out ends the session, and one that keeps it fails at its check', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  secrets: { password: env('${variable}') },
}`),
    [file]: tests,
  })
  const run = await runProject(t, root, { env: { [variable]: WORKFLOW_PASSWORD }, timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F2.1: the secret is typed by the parent, recorded by name, and the session it opens loads the projects.
  assert.equal(testNamed(run, signsIn).status, 'passed')
  const passwordFills = eventsOf(run.events, 'action.completed').filter((event) => event.testId === testNamed(run, signsIn).testId && event.command === 'fill')
  assert.deepEqual(passwordFills.map((event) => event.secret), [undefined, 'password'])
  assert.deepEqual(paths(run, signsIn, app.url), ['/workflow/sign-in', '/workflow/account'])

  // F2.2: the refused password leaves the page where it was, and the account page has no session to show.
  assert.equal(testNamed(run, wrongPassword).status, 'passed')
  assert.deepEqual(paths(run, wrongPassword, app.url), ['/workflow/sign-in', '/workflow/account'])

  // F2.3: the server ended the session, so the account page opened afresh shows nobody.
  assert.equal(testNamed(run, signsOut).status, 'passed')
  assert.deepEqual(paths(run, signsOut, app.url), ['/workflow/sign-in', '/workflow/account', '/workflow/sign-in', '/workflow/account'])

  // F2.4: the page says signed out, but the session lives on, and the account page opened afresh shows it.
  assertFailedAt(run, keepsSession, {
    step: 'the account page shows signed out',
    failureClass: 'check_failed',
    line: lineOf(tests, "toHaveText('Signed out')", 'the account page shows signed out'),
    message: /^getByTestId\('account'\) has text "Signed in as alice", expected "Signed out"\./,
  })

  assert.deepEqual(filesHolding(run.output, WORKFLOW_PASSWORD), [], 'no file of the run holds the password')
  assert.ok(!textHolds(run.stdout, WORKFLOW_PASSWORD) && !textHolds(run.stderr, WORKFLOW_PASSWORD), 'the output does not hold the password')
})
