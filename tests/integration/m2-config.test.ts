import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import {
  configSource,
  eventsOf,
  exampleFile,
  freePort,
  onlyEvent,
  onlyTest,
  resultOf,
  runCli,
  runProject,
  runRetest,
  scratchFolder,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 1: a config is found, checked and named when it is wrong, and milestone 1's mode still runs.

const savesTask = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
})
`

test('no config and no --browser is a usage error that says how to go on, and nothing runs', async (t) => {
  const root = await writeProject(t, { 'tests/tasks.retest.ts': savesTask })
  for (const args of [['run'], ['run', 'tests/tasks.retest.ts']]) {
    const run = await runCli(t, args, { cwd: root })
    assert.equal(run.exit.code, 2)
    assert.equal(run.stdout, '')
    assert.equal(
      run.stderr,
      'error: No retest.config.ts here. Run npx retest init to write one, or pass --browser <path> to run without a config.\nSee retest help run.\n',
    )
  }
  assert.equal(existsSync(join(root, '.retest')), false, 'nothing was written')
})

test('an invalid config is a usage error that names the file and each key at fault, before any run starts', async (t) => {
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: 'ftp://tasks.example' }), admin: chromium({ emulate: 'Pixel 99' }) },
  defaultApp: 'mobile',
  retries: 2,
}`),
    'tests/tasks.retest.ts': savesTask,
  })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 2)
  assert.deepEqual(run.events, [], 'no run started')
  assert.equal(existsSync(run.output), false, 'no run folder was made')
  const lines = run.stderr.split('\n')
  assert.match(lines[0] ?? '', /^error: \/.+\/retest\.config\.ts has 4 problems:$/)
  assert.deepEqual(lines.slice(1, 5).sort(), [
    '  apps.admin.emulate: expected one of "Pixel 9", "Galaxy S24", "iPhone 17", "iPad Pro 11" or object, received "Pixel 99"',
    '  apps.web.baseUrl: expected an http or https URL, received "ftp://tasks.example"',
    '  defaultApp: expected one of "web", "admin", received "mobile"',
    '  retries: unknown key',
  ])
})

test('a config that cannot be loaded, or is not where --config says, is a usage error naming it', async (t) => {
  const root = await writeProject(t, {
    'retest.config.ts': `throw new Error('the config broke while loading')\n`,
    'other.config.ts': `export const config = {}\n`,
    'tests/tasks.retest.ts': savesTask,
  })
  const broken = await runProject(t, root)
  assert.equal(broken.exit.code, 2)
  assert.match(broken.stderr, /retest\.config\.ts could not be loaded: the config broke while loading/)
  const noDefault = await runProject(t, root, { args: ['--config', 'other.config.ts'] })
  assert.equal(noDefault.exit.code, 2)
  assert.match(noDefault.stderr, /other\.config\.ts has no default export\. Write export default defineConfig\(\{ \.\.\. \}\)\./)
  const missing = await runProject(t, root, { args: ['--config', 'missing.config.ts'] })
  assert.equal(missing.exit.code, 2)
  assert.match(missing.stderr, /No config at missing\.config\.ts\./)
})

test('--browser beside a config is a usage error, since the config names the browsers', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/tasks.retest.ts': savesTask,
  })
  const run = await runRetest(t, { files: ['tests/tasks.retest.ts'], cwd: root })
  assert.equal(run.exit.code, 2)
  assert.match(run.stderr, /--browser runs without a config, but retest\.config\.ts is here\. Leave out --browser to use its targets\./)
  assert.equal(app.requests(), 0)
})

test('a milestone 1 run, with --browser and no config, still runs one app named page on one browser', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url })
  assert.equal(run.exit.code, 0)
  const started = onlyEvent(run.events, 'run.started')
  assert.equal(started.options.baseUrl, app.url)
  assert.equal(started.options.config, undefined)
  assert.ok(started.options.browserPath !== undefined)
  const browser = onlyEvent(run.events, 'browser.started')
  assert.deepEqual([browser.app, browser.target], [undefined, undefined])
  for (const event of eventsOf(run.events, 'action.completed')) {
    assert.deepEqual([event.session, event.variant, event.variantKey], ['page', undefined, undefined])
  }
  const passed = onlyTest(run)
  assert.deepEqual([passed.status, passed.variant, passed.variantKey], ['passed', undefined, undefined])
  assert.equal(resultOf(run).browsers, undefined)
  assert.equal(app.submissions(), 1)
})

test('--base-url replaces the default app base URL, and app=url a named one, and the run records both', async (t) => {
  const [web, admin] = [await openApp(t), await openApp(t)]
  const nowhere = `http://127.0.0.1:${await freePort()}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(nowhere)} }), admin: chrome({ baseUrl: ${JSON.stringify(nowhere)} }) },
  defaultApp: 'web',
}`),
    'tests/tasks.retest.ts': savesTask,
    'tests/admin.retest.ts': savesTask.replace('async ({ page })', "{ apps: ['admin'] }, async ({ admin: page })"),
  })
  const run = await runProject(t, root, { args: ['--base-url', web.url, '--base-url', `admin=${admin.url}`] })
  assert.equal(run.exit.code, 0, run.stderr)
  assert.deepEqual(onlyEvent(run.events, 'run.started').options.baseUrls, { web: web.url, admin: admin.url })
  assert.equal(onlyEvent(run.events, 'run.started').options.config, 'retest.config.ts')
  assert.deepEqual([web.submissions(), admin.submissions()], [1, 1])
})

test('with a config and no files, every test file under the root runs, and folders starting with a dot are left out', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/tasks.retest.ts': savesTask,
    'more/nested/again.retest.ts': savesTask,
    '.hidden/skipped.retest.ts': 'throw new Error("a file in a dot folder was loaded")\n',
  })
  const run = await runProject(t, root)
  assert.equal(run.exit.code, 0, run.stderr)
  assert.deepEqual(onlyEvent(run.events, 'run.started').files, ['more/nested/again.retest.ts', 'tests/tasks.retest.ts'])
  assert.equal(app.submissions(), 2)
  const empty = await scratchFolder(t, 'retest-project-')
  const none = await runCli(t, ['run', '--config', join(root, 'retest.config.ts')], { cwd: empty })
  assert.equal(none.exit.code, 2)
  assert.match(none.stderr, /No test files found\. Test files end in \.retest\.ts\./)
})

test('config budgets apply under the command line ones, and several apps with no defaultApp need apps in each test', async (t) => {
  const app = await openApp(t)
  const baseUrl = JSON.stringify(app.url)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${baseUrl} }) }, timeouts: { action: 4321, test: 20000 } }`),
    'tests/tasks.retest.ts': savesTask,
  })
  const run = await runProject(t, root, { timeouts: 'test=15000' })
  assert.equal(run.exit.code, 0, run.stderr)
  const { timeouts } = onlyEvent(run.events, 'run.started').options
  assert.deepEqual([timeouts.action, timeouts.test, timeouts.assertion], [4321, 15000, 5000])

  const several = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${baseUrl} }), admin: chrome({ baseUrl: ${baseUrl} }) } }`),
    'tests/tasks.retest.ts': savesTask,
  })
  const unnamed = await runProject(t, several)
  assert.equal(unnamed.exit.code, 2)
  assert.equal(
    onlyEvent(unnamed.events, 'collection.failed').failure.message,
    '"saves a task": It declares no apps, and the config has several with no defaultApp. Name its apps, or set defaultApp.',
  )
})
