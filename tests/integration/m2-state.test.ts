import type { TestContext } from 'node:test'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SESSION_COOKIE, TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { openApp } from './browser-harness.ts'
import {
  budgets,
  configSource,
  eventsOf,
  filesHolding,
  onlyEvent,
  resultOf,
  resultsNamed,
  runProject,
  secondBrowserPath,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 8: a setup signs in through the fixture's login page once per target, the tests that need its
// state start signed in, the others start signed out, a failed setup keeps its dependents from running, and no
// saved state outlives the run.

const setups = `import { expect, secret, test } from '@rehearsal-labs/retest'

test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})

test.setup('wrong-password', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill('bob')
  await page.getByLabel('Password').fill('not the password')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as bob')
})
`

const accountTests = `import { expect, test } from '@rehearsal-labs/retest'

test('starts signed in', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
  await expect(page.getByTestId('stored-user')).toHaveText('alice')
})

test('starts signed out without state', async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
  await expect(page.getByTestId('stored-user')).toHaveText('')
})

test('needs the setup that fails', { state: 'wrong-password' }, async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as bob')
})
`

async function stateProject(t: TestContext, app: TaskApp, files: Record<string, string>): Promise<string> {
  const targets = `targets: { chrome: chrome(), testing: chromium({ executablePath: ${JSON.stringify(secondBrowserPath())} }) }`
  return writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: app({ baseUrl: ${JSON.stringify(app.url)}, ${targets} }) },
  secrets: { password: env('RETEST_E2E_PASSWORD') },
  states: ['signed-in', 'wrong-password'],
}`),
    ...files,
  })
}

const environment = { RETEST_E2E_PASSWORD: TASK_APP_PASSWORD }

test('a setup signs in once per target, its dependents start signed in, a failed one keeps them from running, and no state is left', async (t) => {
  const app = await openApp(t)
  const root = await stateProject(t, app, { 'tests/setup.retest.ts': setups, 'tests/account.retest.ts': accountTests })
  const run = await runProject(t, root, { env: environment, timeouts: budgets({ assertion: 1000 }) })

  assert.equal(run.exit.code, 1, run.stderr)
  const outcomes = (name: string) => resultsNamed(run, name).map((each) => [each.variantKey, each.status, each.failure?.class])
  assert.deepEqual(outcomes('signed-in'), [
    ['web=chrome', 'passed', undefined],
    ['web=testing', 'passed', undefined],
  ])
  // The site refused the password, so the account line the setup waits for never appears.
  assert.deepEqual(outcomes('wrong-password'), [
    ['web=chrome', 'failed', 'not_found'],
    ['web=testing', 'failed', 'not_found'],
  ])
  assert.ok(resultsNamed(run, 'signed-in').every((each) => each.setup === true))
  assert.deepEqual(outcomes('starts signed in'), [
    ['web=chrome', 'passed', undefined],
    ['web=testing', 'passed', undefined],
  ])
  assert.deepEqual(outcomes('starts signed out without state'), [
    ['web=chrome', 'passed', undefined],
    ['web=testing', 'passed', undefined],
  ])
  for (const skipped of resultsNamed(run, 'needs the setup that fails')) {
    assert.equal(skipped.status, 'not_run')
    assert.match(skipped.failure?.message ?? '', /wrong-password/)
    assert.match(JSON.stringify(skipped.failure), /getByTestId\('account'\)/, 'the reason carries the setup failure')
  }

  // Setups run before the tests that need them, and the saved state is named in events without its contents.
  const started = eventsOf(run.events, 'test.started').map((event) => event.name)
  assert.ok(started.indexOf('signed-in') < started.indexOf('starts signed in'))
  const saved = eventsOf(run.events, 'state.saved')
  assert.deepEqual(saved.map((event) => [event.state, event.app, event.target]).sort(), [
    ['signed-in', 'web', 'chrome'],
    ['signed-in', 'web', 'testing'],
  ])
  const restored = eventsOf(run.events, 'state.restored')
  assert.deepEqual(restored.map((event) => [event.state, event.target]).sort(), [
    ['signed-in', 'chrome'],
    ['signed-in', 'testing'],
  ])
  // A saved state names the session of the setup's page it was read from, and a restored one the session of the
  // dependent test's own page it was put into: identities, never the state.
  assert.deepEqual(saved.map((event) => event.sessionId === `${event.attemptId}:web`), [true, true])
  const dependents = resultsNamed(run, 'starts signed in').map((each) => `${each.attemptId}:web`)
  assert.deepEqual(restored.map((event) => event.sessionId).sort(), dependents.sort())
  for (const event of [...saved, ...restored]) {
    assert.deepEqual(Object.keys(event).filter((key) => !['state', 'app', 'target', 'testId', 'attemptId', 'sessionId', 'variant', 'variantKey'].includes(key)).sort(), [
      'elapsedMs',
      'origin',
      'runId',
      'schemaVersion',
      'sequence',
      'time',
      'type',
    ])
  }
  assert.deepEqual(filesHolding(run.output, SESSION_COOKIE), [], 'no session cookie is kept in the run folder')
  assert.equal(onlyEvent(run.events, 'run.finished').counts.notRun, 2)
  assert.equal(resultOf(run).complete, false, 'tests that did not run leave the run incomplete')
})

test('a test file run on its own brings in the setup it needs from another file', async (t) => {
  const app = await openApp(t)
  const root = await stateProject(t, app, { 'tests/setup.retest.ts': setups, 'tests/account.retest.ts': accountTests })
  const run = await runProject(t, root, { env: environment, files: ['tests/account.retest.ts'], args: ['--grep', 'starts signed in'] })

  assert.equal(run.exit.code, 0, `${run.stderr}\n${JSON.stringify(resultOf(run).files.map((file) => file.failure))}`)
  assert.deepEqual(resultsNamed(run, 'signed-in').map((each) => each.status), ['passed', 'passed'])
  assert.deepEqual(resultsNamed(run, 'starts signed in').map((each) => each.status), ['passed', 'passed'])
  assert.equal(eventsOf(run.events, 'test.started').filter((event) => event.name === 'wrong-password').length, 0, 'only the setup it needs runs')
  const borrowed = eventsOf(run.events, 'collection.completed').flatMap((event) => event.tests).find((each) => each.name === 'signed-in')
  assert.deepEqual(borrowed?.setupFor, ['tests/account.retest.ts'], 'the setup says which file it was brought in for')
})

test('a test that starts from a state no setup saves fails collection, naming the state', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/orphan.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('needs a state nobody saves', { state: 'nowhere' }, async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})
`,
  })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 2)
  const failed = onlyEvent(run.events, 'collection.failed')
  assert.equal(failed.failure.class, 'collection_failed')
  assert.match(failed.failure.message, /^"needs a state nobody saves": No .*saves the state "nowhere"\. Declare test\.setup\("nowhere", \.\.\.\)/)
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [])
})
