import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WORKFLOW_PASSWORD, WORKFLOW_SESSION_COOKIE } from '../../fixtures/task-app/workflow-sign-in-page.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, filesHolding, runProject, testNamed, writeProject } from './cli-harness.ts'
import { failedAtIn, lineOf } from './workflow-harness.ts'

// Release 1 workflow family 3, reuse signed-in state, against real Chrome and the task app's workflow sign-in
// pages: a setup signs in once and saves its state, tests that name it start signed in, a test without it starts
// signed out, a change one test makes stays out of the next, and a setup that fails keeps its dependents from
// running. The cases are F3.1 to F3.4 in docs/plans/public-beta/workflow-cases.md.

const file = 'tests/saved-state.retest.ts'
const assertFailedAt = failedAtIn(file)
const variable = 'RETEST_E2E_WORKFLOW_PASSWORD'

const tests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test.setup('signed-in', async ({ page }) => {
  await page.goto('/workflow/sign-in')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})

test.setup('admin', async ({ page }) => {
  await page.goto('/workflow/sign-in?defect=signs-in-as-guest')
  await page.getByLabel('User name').fill('admin')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await test.step('the account page names admin', async () => {
    await expect(page.getByTestId('account')).toHaveText('Signed in as admin')
  })
})

test('starts signed in from the saved state', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
  await expect(page.getByTestId('stored-user')).toHaveText('alice')
  await expect(page.getByTestId('project')).toHaveText(['Apollo', 'Borealis'])
})

test('starts signed out without a state, after a test that was signed in', async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('stored-user')).toHaveText('')
  await expect(page.getByTestId('projects-status')).toHaveText('Sign in to see your projects')
})

test('pins a project while signed in', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await page.getByRole('button', { name: 'Pin Apollo' }).click()
  await expect(page.getByTestId('pinned')).toHaveText('Apollo')
})

test('starts from the saved state, not from what the test before it changed', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
  await expect(page.getByTestId('pinned')).toHaveText('nothing')
})

test('opens the admin tools', { state: 'admin' }, async ({ page }) => {
  await page.goto('/workflow/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as admin')
})
`

const signedIn = 'starts signed in from the saved state'
const signedOut = 'starts signed out without a state, after a test that was signed in'
const pins = 'pins a project while signed in'
const unpinned = 'starts from the saved state, not from what the test before it changed'
const adminTools = 'opens the admin tools'

test('workflow family 3: a saved sign-in starts the tests that name it signed in, and no others, and a failed setup keeps its dependents from running', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  secrets: { password: env('${variable}') },
  states: ['signed-in', 'admin'],
}`),
    [file]: tests,
  })
  const run = await runProject(t, root, { env: { [variable]: WORKFLOW_PASSWORD }, timeouts: budgets({ assertion: 1500 }) })
  assert.equal(run.exit.code, 1, run.stderr)

  // F3.1: the setup signed in once, the state was saved once, and the test that names it started from it.
  const setup = testNamed(run, 'signed-in')
  assert.deepEqual([setup.status, setup.setup], ['passed', true])
  assert.equal(testNamed(run, signedIn).status, 'passed')
  const saved = eventsOf(run.events, 'state.saved').map((event) => event.state)
  assert.deepEqual(saved, ['signed-in'], 'only the setup that passed saved its state')
  const restoredFor = eventsOf(run.events, 'state.restored').map((event) => event.testId)
  assert.deepEqual(restoredFor, [testNamed(run, signedIn).testId, testNamed(run, pins).testId, testNamed(run, unpinned).testId])
  const started = eventsOf(run.events, 'test.started').map((event) => event.name)
  assert.ok(started.indexOf('signed-in') < started.indexOf(signedIn), 'the setup ran before the test that needs it')

  // F3.2: a test without a state, run right after one that was signed in, starts with no session and nothing kept.
  assert.equal(testNamed(run, signedOut).status, 'passed')
  assert.ok(started.indexOf(signedIn) < started.indexOf(signedOut), 'the signed-out test ran after the signed-in one')

  // F3.3: the pin one test kept in the browser is not in the state the next test starts from.
  assert.equal(testNamed(run, pins).status, 'passed')
  assert.equal(testNamed(run, unpinned).status, 'passed')
  assert.ok(started.indexOf(pins) < started.indexOf(unpinned), 'the pinning test ran first')

  // F3.4: the server signed admin in as guest, so the setup failed at its check, and the test that needs its state
  // did not run, carrying the setup's failure as its reason.
  const adminLine = lineOf(tests, "toHaveText('Signed in as admin')", 'the account page names admin')
  const reason = /getByTestId\('account'\) has text "Signed in as guest", expected "Signed in as admin"\./
  assertFailedAt(run, 'admin', { step: 'the account page names admin', failureClass: 'check_failed', line: adminLine, message: reason })
  const skipped = testNamed(run, adminTools)
  assert.deepEqual([skipped.status, skipped.failure?.class, skipped.failure?.location?.line], ['not_run', 'check_failed', adminLine])
  assert.match(skipped.failure?.message ?? '', /^Not run: the setup "admin" did not pass on chrome\. /)
  assert.match(skipped.failure?.message ?? '', reason)
  assert.deepEqual(
    run.events.filter((event) => event.type.startsWith('action.') && 'testId' in event && event.testId === skipped.testId),
    [],
    'the test that needs the failed setup sent nothing to a page',
  )

  assert.deepEqual(filesHolding(run.output, WORKFLOW_PASSWORD), [], 'no file of the run holds the password')
  assert.deepEqual(filesHolding(run.output, WORKFLOW_SESSION_COOKIE), [], 'no file of the run holds the session cookie')
})
