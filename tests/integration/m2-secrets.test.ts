import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { TASK_APP_PASSWORD } from '../../fixtures/task-app/sign-in.ts'
import { appLogFile } from '../../src/protocol/run-folder.ts'
import { openApp, servePages } from './browser-harness.ts'
import {
  appServerCommand,
  budgets,
  childLog,
  configSource,
  eventsOf,
  filesHolding,
  freePort,
  runProject,
  testNamed,
  textHolds,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 7: secrets are read in the process that runs Retest and never reach the test file's process,
// the events, the logs or the results; page text that holds one is read with its name instead; a secret is typed
// only on the origins it is bound to. Screenshots are not redacted, so none of these tests shows a value on screen.

const trusted = 'trusted-value-5b1c9e'
const environment = { RETEST_E2E_PASSWORD: TASK_APP_PASSWORD, RETEST_E2E_TRUSTED: trusted }
// The function source counts its calls, so each fill types a new value, as a one-time code would.
const codes = ['one-time-1-code', 'one-time-2-code']

function secretTests(elsewhere: string): string {
  return `import { expect, secret, test } from '@rehearsal-labs/retest'

test('signs in with a secret, and reads the page with the value written as its name', async ({ page }) => {
  console.log('the variable in the test process is', process.env['RETEST_E2E_PASSWORD'] === undefined ? 'absent' : 'present')
  console.log('a secret prints as', String(secret('password')), JSON.stringify({ password: secret('password') }))
  await page.goto('/login')
  await page.getByLabel('User name').fill(secret('password'))
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed in as {{password}}')
  await expect(page.getByTestId('stored-user')).toHaveText('{{password}}')
  await expect(page.getByLabel('Password')).toHaveCount(0)
})

test('a failure that quotes page text quotes the name, not the value', async ({ page }) => {
  await page.goto('/login')
  await page.getByLabel('User name').fill(secret('password'))
  await page.getByLabel('Password').fill(secret('password'))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByTestId('account')).toHaveText('Signed out')
})

test('a function source is read on each use', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill(secret('code'))
  await expect(page.getByLabel('Title')).toHaveValue('{{code}}')
  await page.getByLabel('Title').fill(secret('code'))
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('{{code}}')
})

test('a function source that fails fails the fill, naming the secret', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill(secret('broken'))
})

test.describe('origins', (test) => {
  test.afterEach(async ({ page }) => {
    await expect(page.getByLabel('Title')).toHaveValue('')
  })

  test('a secret is never typed on an origin it is not bound to', async ({ page }) => {
    await page.goto(${JSON.stringify(`${elsewhere}/`)})
    await page.getByLabel('Title').fill(secret('password'))
  })
})

test('a secret is typed on an origin secretOrigins binds it to', async ({ page }) => {
  await page.goto(${JSON.stringify(`${elsewhere}/`)})
  await page.getByLabel('Title').fill(secret('trusted'))
  await expect(page.getByLabel('Title')).toHaveValue('{{trusted}}')
})

test('an app server that prints a secret has it written as its name in its log', { apps: ['server'] }, async ({ server }) => {
  await server.goto('/')
  await expect(server.getByRole('heading')).toHaveText('Served by the app server')
})
`
}

test('a secret never reaches the test process, the run folder or the output, and is typed only where it is bound', async (t) => {
  const [app, elsewhere] = [await openApp(t), await openApp(t)]
  const port = await freePort()
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    web: chrome({ baseUrl: ${JSON.stringify(app.url)} }),
    server: chrome({
      baseUrl: 'http://127.0.0.1:${port}',
      start: { command: ${JSON.stringify(appServerCommand(port, { printEnv: 'RETEST_E2E_PASSWORD' }))}, ready: 'http://127.0.0.1:${port}' },
    }),
  },
  defaultApp: 'web',
  secrets: {
    password: env('RETEST_E2E_PASSWORD'),
    trusted: env('RETEST_E2E_TRUSTED'),
    code: (() => {
      let calls = 0
      return () => 'one-time-' + ++calls + '-code'
    })(),
    broken: async () => {
      throw new Error('the vault is down')
    },
  },
  secretOrigins: { trusted: [${JSON.stringify(elsewhere.url)}] },
}`),
    'tests/secrets.retest.ts': secretTests(elsewhere.url),
  })
  const run = await runProject(t, root, { env: environment, reporter: 'human', args: ['--no-agent'], timeouts: budgets({ assertion: 1000 }) })

  // A test failed its checks, which decides the exit code over the fill that could not read its secret.
  assert.equal(run.exit.code, 1, `${run.stdout}\n${run.stderr}`)
  const outcome = (name: string) => {
    const found = testNamed(run, name)
    return [found.status, found.failure?.class]
  }
  assert.deepEqual(outcome('signs in with a secret, and reads the page with the value written as its name'), ['passed', undefined])
  assert.deepEqual(outcome('a failure that quotes page text quotes the name, not the value'), ['failed', 'check_failed'])
  assert.deepEqual(outcome('a function source is read on each use'), ['passed', undefined])
  assert.deepEqual(outcome('a function source that fails fails the fill, naming the secret'), ['error', 'setup_failed'])
  assert.deepEqual(outcome('a secret is never typed on an origin it is not bound to'), ['failed', 'not_actionable'])
  assert.deepEqual(outcome('a secret is typed on an origin secretOrigins binds it to'), ['passed', undefined])
  assert.deepEqual(outcome('an app server that prints a secret has it written as its name in its log'), ['passed', undefined])

  const quoted = testNamed(run, 'a failure that quotes page text quotes the name, not the value')
  assert.match(quoted.failure?.message ?? '', /"Signed in as \{\{password\}\}"/)
  const broken = testNamed(run, 'a function source that fails fails the fill, naming the secret')
  assert.equal(broken.failure?.message, 'Retest could not read the secret "broken": the vault is down')
  const wrongOrigin = testNamed(run, 'a secret is never typed on an origin it is not bound to')
  assert.equal(
    wrongOrigin.failure?.message,
    `Retest did not type the secret "password": the page is on ${elsewhere.url}, and it may be typed only on ${app.url}. Add the origin to secretOrigins if it belongs there.`,
  )
  const afterWrongOrigin = eventsOf(run.events, 'assertion.passed').filter((event) => event.testId === wrongOrigin.testId)
  assert.deepEqual(
    afterWrongOrigin.map((event) => [event.matcher, event.actual?.text]),
    [['toHaveValue', '']],
    'the field on the other origin stayed empty',
  )

  const fills = eventsOf(run.events, 'action.completed').filter((event) => event.command === 'fill')
  assert.ok(fills.length >= 5)
  for (const fill of fills) assert.deepEqual([fill.valueLength, typeof fill.secret], [undefined, 'string'], 'a secret fill names its secret')
  const refused = eventsOf(run.events, 'action.failed').find((event) => event.testId === wrongOrigin.testId)
  assert.deepEqual([refused?.secret, refused?.valueLength, refused?.failure.details], ['password', undefined, { origin: elsewhere.url }])

  const log = childLog(run, 'tests/secrets.retest.ts')
  assert.match(log, /the variable in the test process is absent/)
  assert.match(log, /a secret prints as \{\{password\}\} \{"password":"\{\{password\}\}"\}/)
  assert.equal(eventsOf(run.events, 'app.started').length, 1)
  const serverLog = readFileSync(join(run.output, appLogFile('server')), 'utf8')
  assert.match(serverLog, /^RETEST_E2E_PASSWORD=\{\{password\}\}$/m, 'the server printed the secret, and its log holds the name')

  assert.ok(filesHolding(run.output, '{{password}}').includes('events.jsonl'), 'the search finds what is there')
  for (const value of [TASK_APP_PASSWORD, trusted, ...codes]) {
    assert.deepEqual(filesHolding(run.output, value), [], `no file in the run folder holds ${value}`)
    assert.deepEqual(filesHolding(join(root, '.retest'), value), [], `.retest/last-run.json does not hold ${value}`)
    assert.ok(!textHolds(run.stdout, value) && !textHolds(run.stderr, value), `the terminal output does not show ${value}`)
  }
})

// Found by the verification phase: the value is hidden only as it was typed. A page that puts it in its address,
// where spaces become %20, or shows that address, gets the encoded value into events, results and the terminal.
const echoPage = `<!doctype html><meta charset="utf-8"><title>Echo</title>
<label for="value">Value</label><input id="value">
<button type="button" id="show">Show</button>
<p data-testid="path"></p>
<script>
document.getElementById('show').addEventListener('click', () => {
  history.pushState(null, '', '/echo/' + encodeURIComponent(document.getElementById('value').value))
  document.querySelector('[data-testid="path"]').textContent = location.pathname
})
</script>`

test('a secret a page writes into its address, where it is percent-encoded, is hidden there too', async (t) => {
  const site = await servePages(t, { '/': echoPage })
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(site.url)} }) }, secrets: { password: env('RETEST_E2E_PASSWORD') } }`),
    'tests/echo.retest.ts': `import { expect, secret, test } from '@rehearsal-labs/retest'

test('shows the path the secret went into', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Value').fill(secret('password'))
  await page.getByRole('button', { name: 'Show' }).click()
  await expect(page.getByTestId('path')).toHaveText('/echo/')
})
`,
  })
  const run = await runProject(t, root, { env: environment, reporter: 'human', args: ['--no-agent'], timeouts: budgets({ assertion: 500 }) })

  assert.equal(run.exit.code, 1, run.stderr)
  assert.deepEqual(filesHolding(run.output, TASK_APP_PASSWORD), [], 'no file in the run folder holds the value in any form')
  assert.ok(!textHolds(run.stdout, TASK_APP_PASSWORD), 'the terminal does not show the value in any form')
})

// Found by the verification phase: a function source's value is learned only when a fill reads it. A server that
// printed the value before then, as a dev server prints a one-time code it sends, keeps it in its log.
test('a one-time code a server printed before the fill read it is hidden in the server log too', async (t) => {
  const code = 'one-time-code-7f3a91'
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(url)}, start: { command: ${JSON.stringify(appServerCommand(port, { printEnv: 'RETEST_E2E_CODE' }))}, ready: ${JSON.stringify(url)} } }) },
  secrets: { code: async () => process.env['RETEST_E2E_CODE'] ?? '' },
}`),
    'tests/code.retest.ts': `import { expect, secret, test } from '@rehearsal-labs/retest'

test('types the code the server sent', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Code').fill(secret('code'))
  await expect(page.getByLabel('Code')).toHaveValue('{{code}}')
})
`,
  })
  const run = await runProject(t, root, { env: { RETEST_E2E_CODE: code } })

  assert.equal(run.exit.code, 0, run.stderr)
  assert.match(readFileSync(join(run.output, appLogFile('web')), 'utf8'), /^RETEST_E2E_CODE=/m, 'the server printed the code')
  assert.deepEqual(filesHolding(run.output, code), [], 'no file in the run folder holds the code')
})

test('a secret whose variable is not set stops the run before any test starts, and names the variable', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  secrets: { password: env('RETEST_E2E_PASSWORD'), token: env('RETEST_E2E_TOKEN') },
}`),
    'tests/secrets.retest.ts': secretTests(app.url),
  })
  const run = await runProject(t, root, { env: { RETEST_E2E_PASSWORD: '', RETEST_E2E_TOKEN: 'abc' } })

  assert.equal(run.exit.code, 2)
  assert.deepEqual(run.events, [], 'no run started')
  assert.equal(existsSync(run.output), false, 'no run folder was made')
  assert.equal(
    run.stderr,
    'error: The secret "password" reads RETEST_E2E_PASSWORD, which is empty. Set it in the environment that runs Retest. The secret "token", read from RETEST_E2E_TOKEN, is shorter than 4 characters, too short to redact safely. Use a longer value.\n',
  )
  assert.equal(app.requests(), 0)
})
