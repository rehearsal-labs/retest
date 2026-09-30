import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { openApp } from './browser-harness.ts'
import { budgets, configSource, eventsOf, onlyEvent, resultOf, runProject, testNamed, writeProject } from './cli-harness.ts'

// Acceptance check 4: two apps in one test, each with its own browser context, its commands routed to its page,
// and a screenshot of each when the test fails.

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const roleTests = `import { expect, test } from '@rehearsal-labs/retest'

test('storage stays with its app', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await owner.goto('/login')
  await owner.getByLabel('User name').fill('alice')
  await owner.getByLabel('Password').fill(${JSON.stringify(TASK_APP_PASSWORD)})
  await owner.getByRole('button', { name: 'Sign in' }).click()
  await expect(owner.getByTestId('account')).toHaveText('Signed in as alice')
  await owner.goto('/')
  await owner.getByLabel('Title').fill('Release checklist')
  await owner.getByRole('button', { name: 'Save' }).click()
  await expect(owner.getByTestId('saved-task')).toHaveText('Release checklist')
  await member.goto('/account')
  await expect(member.getByTestId('account')).toHaveText('Signed out')
  await expect(member.getByTestId('stored-user')).toHaveText('')
  await member.goto('/')
  await expect(member.getByTestId('last-saved')).toHaveText('')
  await expect(member.getByTestId('page-loads')).toHaveText('1')
})

test('each app takes its own commands, and two apps may act at once', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await Promise.all([owner.goto('/'), member.goto('/')])
  await member.getByLabel('Title').fill('Groceries')
  await member.getByRole('button', { name: 'Save' }).click()
  await Promise.all([
    expect(member.getByTestId('saved-task')).toHaveText('Groceries'),
    expect(owner.getByTestId('saved-task')).toHaveText(''),
  ])
})

test('a failure takes a screenshot of each app', { apps: ['owner', 'member'] }, async ({ owner, member }) => {
  await owner.goto('/')
  await member.goto('/account')
  await expect(member.getByTestId('account')).toHaveText('Signed in as alice')
})
`

test('two apps in one test keep separate storage, get their own commands, and each gets a failure screenshot', async (t) => {
  const app = await openApp(t)
  const baseUrl = JSON.stringify(app.url)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { owner: chrome({ baseUrl: ${baseUrl} }), member: chrome({ baseUrl: ${baseUrl} }) } }`),
    'tests/roles.retest.ts': roleTests,
  })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1000 }) })

  assert.equal(run.exit.code, 1, run.stderr)
  assert.equal(testNamed(run, 'storage stays with its app').status, 'passed')
  assert.equal(testNamed(run, 'each app takes its own commands, and two apps may act at once').status, 'passed')
  assert.equal(app.submissions(), 2)

  // Apps on one target share its browser process, and each announces it once.
  const browsers = eventsOf(run.events, 'browser.started')
  assert.deepEqual(browsers.map((event) => event.app).sort(), ['member', 'owner'])
  assert.equal(new Set(browsers.map((event) => event.pid)).size, 1, 'both apps use one browser process')

  for (const event of [...eventsOf(run.events, 'action.completed'), ...eventsOf(run.events, 'assertion.passed'), ...eventsOf(run.events, 'navigation')]) {
    assert.ok(event.session === 'owner' || event.session === 'member', `${event.type} names its app: ${event.session}`)
    assert.equal(event.origin, event.type === 'assertion.passed' ? 'child' : 'parent')
  }
  const concurrent = testNamed(run, 'each app takes its own commands, and two apps may act at once')
  const actions = eventsOf(run.events, 'action.completed').filter((event) => event.testId === concurrent.testId)
  // The two gotos ran at once, so either may finish first.
  assert.deepEqual(
    actions.map((event) => `${event.session} ${event.command}`).sort(),
    ['member click', 'member fill', 'member goto', 'owner goto'],
    'the actions went to the apps that named them',
  )
  assert.deepEqual(eventsOf(run.events, 'action.failed'), [], 'no action clashed with the other app')

  const failed = testNamed(run, 'a failure takes a screenshot of each app')
  assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'check_failed'])
  assert.deepEqual(failed.evidence.map((evidence) => evidence.app).sort(), ['member', 'owner'])
  for (const evidence of failed.evidence) {
    assert.match(evidence.path, new RegExp(`-${evidence.app}-[a-z0-9]+-failure\\.png$`))
    assert.deepEqual([...readFileSync(join(run.output, evidence.path)).subarray(0, 8)], pngSignature)
  }
  const captured = eventsOf(run.events, 'evidence.captured').filter((event) => event.testId === failed.testId)
  assert.deepEqual(captured.map((event) => event.path).sort(), failed.evidence.map((evidence) => evidence.path).sort())
  assert.equal(onlyEvent(run.events, 'run.finished').counts.failed, 1)
  assert.equal(resultOf(run).browsers?.length, 2)
})
