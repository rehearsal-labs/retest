import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { resultFile } from '../../src/protocol/run-folder.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'
import { openApp, waitForGroupEnd } from './browser-harness.ts'
import {
  answersAt,
  appServerCommand,
  appServersOn,
  assertStdoutIsEvents,
  budgets,
  childLog,
  configSource,
  eventsOf,
  finishRun,
  freePort,
  inspectJson,
  isRunning,
  onlyEvent,
  printedPids,
  readFinishedRun,
  resultOf,
  resultsNamed,
  runProject,
  secondBrowserPath,
  startRun,
  statesLeftIn,
  testNamed,
  waitFor,
  writeProject,
} from './cli-harness.ts'

// Acceptance check 16: milestone 1's guarantees hold for runs from a config, with several apps, targets, app
// servers and saved states: honest outcomes and exit codes, no repeated action, timeouts, lost browsers and
// signals, JSONL output that is only events, inspect on a run that was cut short, and cleanup of everything.

const savesTask = `async ({ page }) => {
  await page.goto('/')
  await page.getByLabel('Title').fill('Release checklist')
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByTestId('saved-task')).toHaveText('Release checklist')
}`

test('outcomes stay honest: a pass exits 0, a failed check 1, and a target whose browser is missing 2, with no action repeated', async (t) => {
  const [app, broken] = [await openApp(t), await openApp(t, { mode: 'broken' })]
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: app({ baseUrl: ${JSON.stringify(app.url)}, targets: { chrome: chrome(), missing: chromium({ executablePath: '/nonexistent/chromium' }) } }) },
}`),
    'tests/tasks.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('saves a task', ${savesTask})\n`,
  })

  const passing = await runProject(t, root, { args: ['--target', 'web=chrome'] })
  assert.equal(passing.exit.code, 0, passing.stderr)
  assert.deepEqual([resultOf(passing).status, resultOf(passing).complete], ['passed', true])

  const failing = await runProject(t, root, { args: ['--target', 'web=chrome', '--base-url', broken.url], timeouts: budgets({ assertion: 500 }) })
  assert.equal(failing.exit.code, 1, failing.stderr)
  assert.equal(testNamed(failing, 'saves a task').failure?.class, 'check_failed')

  const missing = await runProject(t, root)
  assert.equal(missing.exit.code, 2, missing.stderr)
  const [chrome, absent] = resultsNamed(missing, 'saves a task')
  assert.deepEqual([chrome?.variantKey, chrome?.status], ['web=chrome', 'passed'])
  assert.deepEqual([absent?.variantKey, absent?.status, absent?.failure?.class], ['web=missing', 'not_run', 'setup_failed'])
  assert.match(absent?.failure?.message ?? '', /No browser at \/nonexistent\/chromium/)
  assert.deepEqual([resultOf(missing).status, resultOf(missing).complete], ['error', false])

  // One save for each run that reached the button, and none for the target with no browser.
  assert.deepEqual([app.submissions(), broken.submissions()], [2, 1])
})

test('a test that runs out of time ends its file process, the rest of the file does not run, and the next file does', async (t) => {
  const app = await openApp(t)
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{ apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) } }`),
    'tests/a-waits.retest.ts': `import { writeSync } from 'node:fs'
import { expect, test } from '@rehearsal-labs/retest'

writeSync(1, \`pid \${process.pid}\\n\`)

test('waits forever', { timeout: 800 }, async ({ page }) => {
  await page.goto('/')
  await new Promise(() => {})
})

test('comes after it', ${savesTask})
`,
    'tests/b-next.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'\n\ntest('runs in the next file', ${savesTask})\n`,
  })
  const run = await runProject(t, root)

  assert.equal(run.exit.code, 1, run.stderr)
  const waited = testNamed(run, 'waits forever')
  assert.deepEqual([waited.status, waited.failure?.class], ['failed', 'timeout'])
  const after = testNamed(run, 'comes after it')
  assert.deepEqual([after.status, after.failure?.class], ['not_run', 'timeout'])
  assert.match(after.failure?.message ?? '', /waits forever/)
  assert.equal(testNamed(run, 'runs in the next file').status, 'passed')
  const [pid] = printedPids(childLog(run, 'tests/a-waits.retest.ts'))
  assert.ok(pid !== undefined && !isRunning(pid), 'the process of the file that timed out is gone')
  assert.equal(app.submissions(), 1)
})

test('a lost browser fails the test it was running honestly, later tests on it do not run, and tests on another browser do', async (t) => {
  const [app, frozen] = [await openApp(t), await openApp(t, { mode: 'frozen' })]
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    web: chrome({ baseUrl: ${JSON.stringify(app.url)} }),
    frozen: chromium({ baseUrl: ${JSON.stringify(frozen.url)}, executablePath: ${JSON.stringify(secondBrowserPath())} }),
  },
  defaultApp: 'web',
}`),
    'tests/lost.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test('clicks a button that freezes the page', { apps: ['frozen'] }, async ({ frozen }) => {
  await frozen.goto('/')
  await frozen.getByLabel('Title').fill('Release checklist')
  await frozen.getByRole('button', { name: 'Save' }).click()
  await expect(frozen.getByTestId('saved-task')).toHaveText('Release checklist')
})

test('runs on the other browser', ${savesTask})

test('needs the lost browser again', { apps: ['frozen'] }, async ({ frozen }) => {
  await frozen.goto('/')
  await expect(frozen.getByRole('button', { name: 'Save' })).toBeVisible()
})
`,
  })
  const started = await startRun(t, { files: [], cwd: root, browser: false, timeouts: budgets({ action: 20_000, test: 30_000 }) })
  const browser = await started.retest.waitForEvent('browser.started', (event) => event.app === 'frozen')
  await waitFor('the frozen page to count its save', () => frozen.submissions() === 1)
  // The browser is lost from outside, as a crash would lose it. It is killed through the record of what the command
  // launched, as the harness ends what it recorded, each process checked against its record first.
  const launched = new OwnedProcessGroup(started.retest.pid)
  launched.capture()
  const lostBrowser = launched.groupFor(browser.pid)
  assert.ok(lostBrowser !== undefined, 'the frozen browser is recorded as one the run launched')
  assert.deepEqual(lostBrowser.signalReport('SIGKILL').problems, [], 'every process of the frozen browser was killed after its identity was checked')
  const run = await finishRun(started)
  assertStdoutIsEvents(run)

  assert.equal(run.exit.code, 2, run.stderr)
  const lost = testNamed(run, 'clicks a button that freezes the page')
  assert.deepEqual([lost.status, lost.failure?.class], ['error', 'outcome_unknown'])
  const click = eventsOf(run.events, 'action.failed').find((event) => event.command === 'click')
  assert.deepEqual(click?.failure, lost.failure, 'the click and the test carry the same failure')
  const again = testNamed(run, 'needs the lost browser again')
  assert.deepEqual([again.status, again.failure?.class], ['not_run', 'session_lost'])
  assert.equal(frozen.submissions(), 1, 'the click that may have saved was not sent again')
  assert.equal(testNamed(run, 'runs on the other browser').status, 'passed', 'a test on a browser that was not lost still runs')
  assert.equal(app.submissions(), 1)
})

type SignalCase = { signal: 'SIGINT' | 'SIGTERM'; exitCode: 130 | 143; message: string }

async function waitingProject(t: TestContext): Promise<{ root: string; port: number }> {
  const port = await freePort()
  const url = `http://127.0.0.1:${port}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: { web: chrome({ baseUrl: ${JSON.stringify(url)}, start: { command: ${JSON.stringify(appServerCommand(port))}, ready: ${JSON.stringify(url)} } }) },
  states: ['visited'],
}`),
    'tests/waits.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test.setup('visited', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading')).toHaveText('Served by the app server')
})

test('waits for text that never comes', { state: 'visited' }, async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('never there')).toBeVisible()
})
`,
  })
  return { root, port }
}

for (const { signal, exitCode, message } of [
  { signal: 'SIGINT', exitCode: 130, message: 'The run was interrupted.' },
  { signal: 'SIGTERM', exitCode: 143, message: 'The run was stopped by SIGTERM.' },
] satisfies SignalCase[]) {
  test(`${signal} during a run from a config writes the result, stops the app server and browser, removes saved state, and exits ${exitCode}`, async (t) => {
    const { root, port } = await waitingProject(t)
    const started = await startRun(t, { files: [], cwd: root, browser: false, timeouts: budgets({ assertion: 30_000, test: 40_000 }) })
    await started.retest.waitForEvent('state.restored')
    await started.retest.waitForEvent('action.completed', (event) => event.command === 'goto' && event.testId.endsWith('never comes'))
    assert.equal(existsSync(join(started.output, 'states')), true, 'the saved state is there while the run goes on')
    started.retest.signal(signal)
    const run = await finishRun(started)
    assertStdoutIsEvents(run)

    assert.deepEqual(run.exit, { code: exitCode, signal: null })
    const result = resultOf(run)
    assert.deepEqual([result.status, result.exitCode, result.complete], ['interrupted', exitCode, false])
    const stopped = testNamed(run, 'waits for text that never comes')
    assert.deepEqual([stopped.status, stopped.failure?.message], ['error', message])
    assert.equal(testNamed(run, 'visited').status, 'passed')
    assert.deepEqual(await appServersOn(port), [])
  })
}

test('a second SIGINT quits at once, and the exit hooks still end the browser and the app server and remove saved state', async (t) => {
  const { root, port } = await waitingProject(t)
  const started = await startRun(t, { files: [], cwd: root, browser: false, timeouts: budgets({ assertion: 30_000, test: 40_000 }) })
  const server = await started.retest.waitForEvent('app.started')
  await started.retest.waitForEvent('state.restored')
  started.retest.signal('SIGINT')
  await waitFor('the notice that a second Ctrl+C quits', () => started.retest.stderr.includes('Press Ctrl+C again to quit at once.'))
  started.retest.signal('SIGINT')
  const run = await finishRun(started)

  assert.deepEqual(run.exit, { code: 130, signal: null })
  assert.equal(isRunning(server.pid), false)
  assert.deepEqual(await appServersOn(port), [])
  assert.deepEqual(statesLeftIn(run.output), [])
})

test('inspect reads a run from a config that was killed, keeping each variant, and marks it incomplete', async (t) => {
  const app = await openApp(t)
  const port = await freePort()
  const served = `http://127.0.0.1:${port}`
  const root = await writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    web: app({ baseUrl: ${JSON.stringify(app.url)}, targets: { chrome: chrome(), testing: chromium({ executablePath: ${JSON.stringify(secondBrowserPath())} }) } }),
    server: chrome({ baseUrl: ${JSON.stringify(served)}, start: { command: ${JSON.stringify(appServerCommand(port))}, ready: ${JSON.stringify(served)} } }),
  },
  defaultApp: 'web',
  states: ['visited'],
}`),
    'tests/killed.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'

test.setup('visited', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByLabel('Title')).toBeVisible()
})

test('saves a task', { state: 'visited' }, ${savesTask})

test('opens the served page', { apps: ['server'] }, async ({ server }) => {
  await server.goto('/')
  await expect(server.getByRole('heading')).toHaveText('Served by the app server')
})

test('waits for text that never comes', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('never there')).toBeVisible()
})
`,
  })
  const started = await startRun(t, { files: [], cwd: root, browser: false, timeouts: budgets({ assertion: 30_000, test: 40_000 }) })
  const waiting = await started.retest.waitForEvent('test.started', (event) => event.name === 'waits for text that never comes')
  await started.retest.waitForEvent('action.completed', (event) => event.command === 'goto' && event.attemptId === waiting.attemptId)
  started.retest.signal('SIGKILL')
  const run = await readFinishedRun(started)

  assert.deepEqual(run.exit, { code: null, signal: 'SIGKILL' })
  assert.equal(existsSync(join(run.output, resultFile)), false)
  for (const browser of eventsOf(run.events, 'browser.started')) await waitForGroupEnd(browser.pid, 5000)
  // Nothing of a killed process runs: the saved state it held stays in its run folder, and nothing stops the
  // server it started. The harness stops that server after the test.
  assert.notDeepEqual(statesLeftIn(run.output), [])
  assert.equal(await answersAt(served), true)

  const inspected = await inspectJson(t, run.output)
  assert.equal(inspected.exit.code, 0, inspected.stderr)
  const result = inspected.result
  assert.deepEqual([result.complete, result.status, result.exitCode], [false, 'error', 2])
  assert.deepEqual(result.failure, { class: 'interrupted', message: 'The run stopped before it finished.' })
  const tests = result.files.flatMap((file) => file.tests).map((each) => [each.name, each.variantKey, each.status])
  assert.deepEqual(tests.slice(0, 4), [
    ['visited', 'web=chrome', 'passed'],
    ['visited', 'web=testing', 'passed'],
    ['saves a task', 'web=chrome', 'passed'],
    ['saves a task', 'web=testing', 'passed'],
  ])
  assert.deepEqual(tests[4], ['opens the served page', 'server=chrome', 'passed'])
  assert.deepEqual(tests[5], ['waits for text that never comes', waiting.variantKey, 'error'])
  assert.equal(onlyEvent(run.events, 'run.started').options.config, 'retest.config.ts')
})
