import type { TestContext } from 'node:test'
import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { lastRunFile, lastRunSchema } from '../../src/protocol/last-run.ts'
import { openApp } from './browser-harness.ts'
import { configSource, eventsOf, parseLine, resultOf, runCli, runProject, writeProject } from './cli-harness.ts'

// Acceptance check 11: --grep, --tag, file:line, --last-failed and --target choose the tests, and a selection
// that keeps none exits 2 with the reason.

const passes = `async () => {\n    expect(true).toBe(true)\n  }`

const taskTests = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', { tags: ['smoke'] }, ${passes})

test('archives a task', { tags: ['slow'] }, ${passes})

test.describe('admin', { tags: ['admin'] }, (test) => {
  test('lists users', ${passes})
  test('removes a user', { tags: ['slow'] }, ${passes})
})

test.for([{ n: 1 }, { n: 2 }, { n: 3 }])('row $n', { tags: ['smoke'] }, ${passes})
`

// Fails on the emulated phone only, so a run leaves one variant of it failed.
const deviceTest = `import { expect, test } from '@rehearsal-labs/retest'

test('has no touch screen', { apps: ['device'] }, async ({ device }) => {
  await device.goto('/device')
  await expect(device.getByTestId('touch')).toHaveText('false')
})
`

function lineOf(source: string, text: string): number {
  return source.split('\n').findIndex((line) => line.includes(text)) + 1
}

async function selectionProject(t: TestContext): Promise<string> {
  const app = await openApp(t)
  const baseUrl = JSON.stringify(app.url)
  return writeProject(t, {
    'retest.config.ts': configSource(`{
  apps: {
    web: chrome({ baseUrl: ${baseUrl} }),
    device: app({ baseUrl: ${baseUrl}, targets: { desktop: chrome(), phone: chrome({ emulate: 'Pixel 9' }) } }),
  },
  defaultApp: 'web',
  tags: ['smoke', 'slow', 'admin'],
}`),
    'tests/tasks.retest.ts': taskTests,
    'tests/device.retest.ts': deviceTest,
  })
}

/** The tests a run started, each with its variant when it has several targets. */
function ran(run: FinishedRun): string[] {
  return eventsOf(run.events, 'test.started').map((event) => (event.variant?.['device'] === undefined ? event.name : `${event.name} ${event.variantKey}`))
}

test('--grep matches a part of the full title, or a pattern, and --tag reads and, or, not and parentheses', async (t) => {
  const root = await selectionProject(t)
  const select = async (args: readonly string[]) => {
    const run = await runProject(t, root, { files: ['tests/tasks.retest.ts'], args })
    assert.equal(run.exit.code, 0, `${args.join(' ')}: ${run.stderr}`)
    return ran(run)
  }
  assert.deepEqual(await select(['--grep', 'a task']), ['saves a task', 'archives a task'])
  assert.deepEqual(await select(['--grep', '/^admin > .*user/']), ['lists users', 'removes a user'])
  assert.deepEqual(await select(['--grep', '/ROW [13]/i']), ['row 1', 'row 3'])
  assert.deepEqual(await select(['--tag', 'smoke and not slow']), ['saves a task', 'row 1', 'row 2', 'row 3'])
  assert.deepEqual(await select(['--tag', '(admin or slow) and not smoke']), ['archives a task', 'lists users', 'removes a user'])
  assert.deepEqual(await select(['--tag', 'admin', '--grep', 'remove']), ['removes a user'])
})

test('a tag the config does not list is a usage error that points at it, and nothing runs', async (t) => {
  const root = await selectionProject(t)
  const run = await runProject(t, root, { args: ['--tag', 'smoke and smok'] })
  assert.equal(run.exit.code, 2)
  assert.deepEqual(run.events, [])
  assert.equal(
    run.stderr,
    'error: --tag: Unknown tag "smok" at character 11. Did you mean smoke? The config\'s tags are smoke, slow and admin.\n  smoke and smok\n            ^\nSee retest help run.\n',
  )
})

test('file:line keeps the test, test.for or test.describe declared on that line', async (t) => {
  const root = await selectionProject(t)
  const select = async (...lines: string[]) => {
    const run = await runProject(t, root, { files: lines.map((line) => `tests/tasks.retest.ts:${line}`) })
    assert.equal(run.exit.code, 0, `${lines.join(' ')}: ${run.stderr}`)
    return ran(run)
  }
  assert.deepEqual(await select(String(lineOf(taskTests, "test('saves a task'"))), ['saves a task'])
  assert.deepEqual(await select(String(lineOf(taskTests, "test.describe('admin'"))), ['lists users', 'removes a user'])
  assert.deepEqual(await select(String(lineOf(taskTests, 'test.for('))), ['row 1', 'row 2', 'row 3'])
  assert.deepEqual(await select(String(lineOf(taskTests, "test('saves a task'")), `${lineOf(taskTests, "test('lists users'")}:3`), [
    'saves a task',
    'lists users',
  ])
})

test('file:line#row keeps one test.for row', async (t) => {
  const root = await selectionProject(t)
  const row = `tests/tasks.retest.ts:${lineOf(taskTests, 'test.for(')}#2`
  const run = await runProject(t, root, { files: [row] })
  assert.equal(run.exit.code, 0, run.stderr)
  assert.deepEqual(ran(run), ['row 2'])
  const listed = await runCli(t, ['list', row], { cwd: root, env: { NO_COLOR: '1' } })
  assert.equal(listed.exit.code, 0, listed.stderr)
  assert.match(listed.stdout, /^ {2}row 2 +tests\/tasks\.retest\.ts:\d+:\d+#2$/m, 'list names the row')
  assert.doesNotMatch(listed.stdout, /row [13]/)
})

test('--last-failed runs again only the variants the last run did not pass, and --target keeps one target', async (t) => {
  const root = await selectionProject(t)
  const first = await runProject(t, root, { args: ['--grep', 'touch', '--no-agent'], reporter: 'human' })
  assert.equal(first.exit.code, 1, first.stderr)
  assert.deepEqual(ran(first), ['has no touch screen device=desktop', 'has no touch screen device=phone'])
  const line = lineOf(deviceTest, "test('has no touch screen'")
  assert.match(first.stdout, new RegExp(`Rerun +npx retest run tests/device\\.retest\\.ts:${line} --target device=phone`), 'the failure card reruns the failed variant alone')
  const recorded = parseLine(lastRunSchema, readFileSync(join(root, lastRunFile), 'utf8'), lastRunFile)
  assert.deepEqual(recorded.tests, [{ testId: 'tests/device.retest.ts > has no touch screen', variantKey: 'device=phone', status: 'failed' }])
  assert.equal(recorded.runId, resultOf(first).runId)

  const again = await runProject(t, root, { args: ['--last-failed'] })
  assert.equal(again.exit.code, 1, again.stderr)
  assert.deepEqual(ran(again), ['has no touch screen device=phone'])
  assert.deepEqual(onlyFiles(again), ['tests/device.retest.ts'], 'only the file with a failed test was loaded')

  const desktop = await runProject(t, root, { args: ['--target', 'device=desktop'] })
  assert.equal(desktop.exit.code, 0, desktop.stderr)
  assert.deepEqual(ran(desktop), ['has no touch screen device=desktop'], 'a test that does not use the named app is left out')

  const nothingLeft = await runProject(t, root, { args: ['--last-failed'] })
  assert.equal(nothingLeft.exit.code, 2)
  assert.match(nothingLeft.stderr, /The last run passed every test it ran, so --last-failed has nothing to run\./)
})

function onlyFiles(run: FinishedRun): string[] {
  return eventsOf(run.events, 'collection.completed').map((event) => event.file)
}

test('a selection that keeps no test exits 2 with the reason, and starts no browser', async (t) => {
  const root = await selectionProject(t)
  const run = await runProject(t, root, { args: ['--grep', 'nothing like this', '--tag', 'smoke'] })
  assert.equal(run.exit.code, 2)
  assert.deepEqual(resultOf(run).failure, { class: 'usage', message: 'No test matches --grep "nothing like this" and --tag "smoke".' })
  assert.deepEqual(eventsOf(run.events, 'browser.started'), [])
  assert.deepEqual(eventsOf(run.events, 'test.started'), [])
})
