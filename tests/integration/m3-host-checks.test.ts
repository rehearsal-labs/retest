import type { TestContext } from 'node:test'
import type { HostRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { openApp } from './browser-harness.ts'
import { eventsOf, filesHolding, hostScript, repositoryRoot, runCli, runHost, testNamed, writeProject } from './cli-harness.ts'

// Acceptance check 2: host checks, given through `runFiles` from the runner subpath by a host's own script, against
// real Chrome and the task app. The parent runs them after each test's body, and they decide the test with it.

const signInTests = `import { expect, secret, test } from '@rehearsal-labs/retest'

test.setup('signed-in', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill('alice')
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})

test('shows the account', { state: 'signed-in' }, async ({ page }) => {
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed in as alice')
})
`

const taskTests = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('saves a task and ends on the account page', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
  await page.goto('/account')
  await expect(page.getByTestId('account')).toHaveText('Signed out')
})

test('fails its own check', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
`

const signIn = 'tests/sign-in.retest.ts'
const tasks = 'tests/tasks.retest.ts'

// A project whose host script runs `files` with more options, such as `hostChecks`, as TypeScript source.
async function hostProject(t: TestContext, appUrl: string, script: { files: readonly string[]; options: string }): Promise<string> {
  const baseUrl = JSON.stringify(appUrl)
  const config = `{
  apps: { web: chrome({ baseUrl: ${baseUrl} }), admin: chrome({ baseUrl: ${baseUrl} }) },
  defaultApp: 'web',
  states: ['signed-in'],
  secrets: { password: () => process.env['HOST_PASSWORD'] ?? '' },
}`
  return writeProject(t, { 'package.json': '{ "type": "module" }\n', 'host.ts': hostScript({ config, ...script }), [signIn]: signInTests, [tasks]: taskTests })
}

function runHostScript(t: TestContext, root: string): Promise<HostRun> {
  return runHost(t, { cwd: root, command: [process.execPath, '--conditions=retest-source', 'host.ts'], env: { HOST_PASSWORD: TASK_APP_PASSWORD } })
}

function statuses(run: HostRun, name: string): string[] {
  return (testNamed(run, name).hostChecks ?? []).map((entry) => entry.status)
}

test('checks decide each test with its body: by test id and by file, in order, every one of them, and not after a failed body', async (t) => {
  const app = await openApp(t)
  const origin = JSON.stringify(app.url)
  const root = await hostProject(t, app.url, {
    files: [signIn, tasks],
    options: `hostChecks: {
      '${signIn}': [
        { kind: 'address', origin: ${origin}, path: /^\\/ACCOUNT$/i },
        { kind: 'text', text: 'SIGNED IN AS ALICE', ignoreCase: true },
      ],
      '${signIn} > shows the account': [{ kind: 'text', text: 'Signed out', absent: true }],
      '${tasks} > saves a task': [
        { kind: 'address', origin: ${origin}, path: '/' },
        { kind: 'text', text: 'Release checklist' },
        { kind: 'text', text: 'Could not save', absent: true },
      ],
      '${tasks} > saves a task and ends on the account page': [
        { kind: 'address', origin: ${origin}, path: '/', timeoutMs: 300 },
        { kind: 'text', text: 'signed out', timeoutMs: 300 },
        { kind: 'text', text: 'signed out', ignoreCase: true },
        { kind: 'text', text: 'Account', absent: true, timeoutMs: 300 },
        { kind: 'text', text: 'Release checklist', absent: true },
        { kind: 'address', origin: ${origin}, path: /^\\/$/, timeoutMs: 300 },
      ],
      '${tasks} > fails its own check': [{ kind: 'text', text: 'Release checklist' }],
    },`,
  })
  const run = await runHostScript(t, root)

  assert.equal(run.exit.code, 1, run.stderr)

  // Passing checks pass the test, as the parent's events and in the result.
  assert.equal(testNamed(run, 'saves a task').status, 'passed')
  assert.deepEqual(statuses(run, 'saves a task'), ['passed', 'passed', 'passed'])
  const passed = eventsOf(run.events, 'host_check.passed')
  assert.ok(passed.every((event) => event.origin === 'parent'))
  assert.deepEqual(
    passed.filter((event) => event.testId === `${tasks} > saves a task`).map((event) => [event.session, event.check, event.actual]),
    [
      ['web', { kind: 'address', origin: app.url, path: '/' }, { url: `${app.url}/` }],
      ['web', { kind: 'text', text: 'Release checklist' }, { url: `${app.url}/`, found: true }],
      ['web', { kind: 'text', text: 'Could not save', absent: true }, { url: `${app.url}/`, found: false }],
    ],
  )

  // A file's checks cover every test of the file, the setup included, and come before a test's own.
  assert.deepEqual(statuses(run, 'signed-in'), ['passed', 'passed'])
  assert.equal(eventsOf(run.events, 'state.saved').length, 1, 'the setup saved its state once its checks passed')
  assert.deepEqual(
    (testNamed(run, 'shows the account').hostChecks ?? []).map((entry) => [entry.check, entry.status]),
    [
      [{ kind: 'address', origin: app.url, path: { pattern: '^\\/ACCOUNT$', flags: 'i' } }, 'passed'],
      [{ kind: 'text', text: 'SIGNED IN AS ALICE', ignoreCase: true }, 'passed'],
      [{ kind: 'text', text: 'Signed out', absent: true }, 'passed'],
    ],
  )

  // A test whose own assertions pass, but which ends on the wrong page, fails its checks: every one runs, the first
  // that failed leads, and the screenshot is taken after them, of the page they read.
  const wrong = testNamed(run, 'saves a task and ends on the account page')
  assert.deepEqual([wrong.status, wrong.failure?.class], ['failed', 'host_check_failed'])
  assert.deepEqual(statuses(run, 'saves a task and ends on the account page'), ['failed', 'failed', 'passed', 'failed', 'passed', 'failed'])
  assert.equal(
    wrong.failure?.message,
    `The address check on web failed: the page is on ${app.url}/account, expected ${app.url}/. Looked ${wrong.failure?.details?.['attempts']} times in 300 ms.`,
  )
  const also = wrong.failure?.details?.['also']
  assert.equal(typeof also === 'string' ? also.split('\n').length : 0, 3, 'the other three failed checks are in details.also')
  assert.equal(eventsOf(run.events, 'assertion.passed').filter((event) => event.testId === wrong.testId).length, 2, 'its own checks passed')
  const [screenshot] = wrong.evidence
  assert.ok(screenshot !== undefined)
  assert.deepEqual([...readFileSync(join(run.output, screenshot.path)).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], 'a PNG')
  const order = run.events.filter((event) => 'testId' in event && event.testId === wrong.testId).map((event) => event.type)
  assert.ok(order.lastIndexOf('host_check.failed') < order.indexOf('evidence.captured'), 'the screenshot comes after the checks')

  // A test whose body failed lists its checks as not run, and runs none.
  const own = testNamed(run, 'fails its own check')
  assert.deepEqual([own.status, own.failure?.class, own.hostChecks], [
    'failed',
    'check_failed',
    [{ check: { kind: 'text', text: 'Release checklist' }, app: 'web', status: 'not_run' }],
  ])
  assert.ok(!eventsOf(run.events, 'host_check.passed').some((event) => event.testId === own.testId))

  assert.deepEqual(Object.keys(eventsOf(run.events, 'run.started')[0]?.options.hostChecks ?? {}).length, 5, 'run.started records every key')
  assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [])

  // The command line cannot give host checks, so the report replayed from the folder prints no command to run the
  // tests again; each card points to inspect.
  const report = await runCli(t, ['inspect', run.output], { env: { NO_COLOR: '1' } })
  assert.equal(report.exit.code, 0, report.stderr)
  assert.match(report.stdout, /\n {4}Host check failed {2}address on web\n {4}Expected {9}http:\/\/127\.0\.0\.1:\d+\/\n {4}Page {13}http:\/\/127\.0\.0\.1:\d+\/account\n/)
  assert.match(report.stdout, /\n {4}Not run {10}host check text on web: "Release checklist"\n/)
  assert.match(report.stdout, /\n {2}Host checks {2}4 failed · 10 passed · 1 not run\n/)
  assert.doesNotMatch(report.stdout, /Rerun|retest run/)
  assert.equal(report.stdout.match(/\n {4}Inspect {10}npx retest inspect /g)?.length, 2, 'both failure cards point to inspect')
  const timeline = await runCli(t, ['inspect', run.output, '--test', wrong.testId], { env: { NO_COLOR: '1' } })
  // The checks come after the body's last assertion and the look it rested on, each with what the page showed.
  assert.match(
    timeline.stdout,
    /✓ toHaveText getByTestId\('account'\) [^\n]*\n +looked 1 time, passed on o\d+: 1 match, text "Signed out"\n +[\d.]+ m?s {2}web {2}✗ host check address: http:\/\/127\.0\.0\.1:\d+\/ {2}[^\n]*host_check_failed\n +page http:\/\/127\.0\.0\.1:\d+\/account\n/,
  )
})

test('a key that names no selected test and no selected file stops the run before any browser starts', async (t) => {
  const app = await openApp(t)
  const origin = JSON.stringify(app.url)
  const root = await hostProject(t, app.url, {
    files: [tasks],
    options: `selection: { grep: 'saves' },
    hostChecks: {
      '${tasks} > fails its own check': [{ kind: 'text', text: 'Release checklist' }],
      'tests/task.retest.ts': [{ kind: 'address', origin: ${origin} }],
    },`,
  })
  const run = await runHostScript(t, root)

  assert.equal(run.exit.code, 2, run.stderr)
  assert.equal(run.result?.failure?.class, 'usage')
  assert.equal(
    run.result?.failure?.message,
    [
      'The host checks have 2 problems:',
      `  hostChecks["${tasks} > fails its own check"]: names no test this run will run, and no file one comes from. Keys are test ids, such as "${tasks} > saves a task", or files as the run lists them.`,
      '  hostChecks["tests/task.retest.ts"]: names no test this run will run, and no file one comes from.',
    ].join('\n'),
  )
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [])
  assert.equal(app.requests(), 0)
})

test('a check on an app the test does not use stops the run before any browser starts', async (t) => {
  const app = await openApp(t)
  const root = await hostProject(t, app.url, {
    files: [tasks],
    options: `hostChecks: { '${tasks} > saves a task': [{ kind: 'text', text: 'Release checklist', app: 'admin' }] },`,
  })
  const run = await runHostScript(t, root)

  assert.equal(run.exit.code, 2, run.stderr)
  assert.deepEqual(run.result?.failure, {
    class: 'usage',
    message: `hostChecks["${tasks} > saves a task"][0].app: "admin" is not an app of "${tasks} > saves a task", which uses web.`,
  })
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [])
  assert.equal(app.requests(), 0)
  assert.ok(!root.startsWith(repositoryRoot), 'the host project lives outside the repository')
})
