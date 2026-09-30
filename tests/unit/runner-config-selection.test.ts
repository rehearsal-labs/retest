import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import { lastRunFile, lastRunSchema } from '../../src/protocol/last-run.ts'
import { parse } from '../../src/protocol/schema.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { runProject, tempProject } from '../support/project.ts'
import { eventsOfType } from '../support/run-harness.ts'
import { capture } from './reporters-fixtures.ts'

const config = `import { app, chromium, defineConfig } from '@rehearsal-labs/retest'
export default defineConfig({
  apps: {
    web: app({
      baseUrl: 'http://127.0.0.1:4173',
      targets: { stable: chromium({ executablePath: '/fake/stable' }), beta: chromium({ executablePath: '/fake/beta' }) },
    }),
  },
  tags: ['smoke', 'slow'],
})
`

const tests = `import { expect, test } from '@rehearsal-labs/retest'

test('saves a task', { tags: ['smoke'] }, async ({ page }) => {
  await expect(page.getByTestId('save-task')).toBeVisible()
})

test.describe('archive', { tags: ['slow'] }, () => {
  test('archives a task', async ({ page }) => {
    await expect(page.getByTestId('save-task')).toBeVisible()
  })

  test.for([{ title: 'one' }, { title: 'two' }])('archives "$title"', async ({ page }) => {
    await expect(page.getByTestId('save-task')).toBeVisible()
  })
})
`

function project(): string {
  return tempProject({ 'retest.config.ts': config, 'tests/tasks.retest.ts': tests })
}

const files = ['tests/tasks.retest.ts']

function ran(record: Awaited<ReturnType<typeof runProject>>): string[] {
  return record.result.files.flatMap((file) => file.tests).map((result) => `${result.testId.replace('tests/tasks.retest.ts > ', '')} ${result.variantKey}`)
}

describe('choosing tests in a run', () => {
  test('describe blocks and test.for rows give each test its id, and pass their tags down', async () => {
    const record = await runProject(project(), { files, selection: { tags: { kind: 'tag', tag: 'slow' }, targets: { web: 'stable' } } })
    assert.deepEqual(ran(record), ['archive > archives a task web=stable', 'archive > archives "one" web=stable', 'archive > archives "two" web=stable'])
    const listed = eventsOfType(record.events, 'collection.completed')[0]?.tests.map((entry) => [entry.name, entry.describePath, entry.tags])
    assert.deepEqual(listed, [
      ['saves a task', undefined, ['smoke']],
      ['archives a task', ['archive'], ['slow']],
      ['archives "one"', ['archive'], ['slow']],
      ['archives "two"', ['archive'], ['slow']],
    ])
  })

  test('file:line on a describe block keeps the tests inside it', async () => {
    const record = await runProject(project(), { files, selection: { locations: [{ file: 'tests/tasks.retest.ts', line: 7 }], targets: { web: 'beta' } } })
    assert.deepEqual(ran(record), ['archive > archives a task web=beta', 'archive > archives "one" web=beta', 'archive > archives "two" web=beta'])
  })

  test('file:line#row keeps one test.for row, and each collected row records its number', async () => {
    const at = (row?: number) => ({ files, selection: { locations: [{ file: 'tests/tasks.retest.ts', line: 12, ...(row === undefined ? {} : { row }) }], targets: { web: 'beta' } } })
    assert.deepEqual(ran(await runProject(project(), at(2))), ['archive > archives "two" web=beta'])
    const record = await runProject(project(), at())
    assert.deepEqual(ran(record), ['archive > archives "one" web=beta', 'archive > archives "two" web=beta'])
    const rows = eventsOfType(record.events, 'collection.completed')[0]?.tests.map((entry) => [entry.name, entry.location.line, entry.row])
    assert.deepEqual(rows, [
      ['saves a task', 3, undefined],
      ['archives a task', 8, undefined],
      ['archives "one"', 12, 1],
      ['archives "two"', 12, 2],
    ])
    const missing = await runProject(project(), at(3))
    assert.deepEqual([missing.result.exitCode, missing.result.failure?.message], [2, 'No test matches tests/tasks.retest.ts:12#3 and --target web=beta.'])
  })

  test('the rerun line of a failed row names its row', async () => {
    const rows = `import { expect, test } from '@rehearsal-labs/retest'

test.for([{ id: 'save-task' }, { id: 'hidden-note' }])('shows $id', async ({ page }, { id }) => {
  await expect(page.getByTestId(id)).toBeVisible()
})
`
    const stdout = capture()
    const human = createHumanReporter({ stdout, stderr: capture(), color: false, runFolder: 'run' })
    const root = tempProject({ 'retest.config.ts': config, 'tests/rows.retest.ts': rows })
    const record = await runProject(root, { files: ['tests/rows.retest.ts'], selection: { targets: { web: 'beta' } }, reporters: [human] })
    assert.equal(record.result.exitCode, 1)
    assert.match(stdout.text, /\n {4}Rerun {12}npx retest run "tests\/rows\.retest\.ts:3#2" --target web=beta --timeouts /)
  })

  test('a selection that matches nothing exits 2 with the reason, and starts no browser', async () => {
    const record = await runProject(project(), { files, selection: { grep: 'nothing like it' } })
    assert.deepEqual(record.result.failure, { class: 'usage', message: 'No test matches --grep "nothing like it".' })
    assert.deepEqual([record.result.exitCode, record.result.status, record.result.complete], [2, 'error', false])
    assert.deepEqual(record.result.files, [{ file: 'tests/tasks.retest.ts', collection: 'ok', tests: [] }])
    assert.equal(record.browsers.length, 0)
  })

  test('a tag the config does not list is a usage failure before anything loads', async () => {
    const record = await runProject(project(), { files, selection: { tags: { kind: 'tag', tag: 'flaky' } } })
    assert.equal(record.result.failure?.message, 'The tag "flaky" is not in the config\'s tags: smoke, slow.')
    assert.equal(record.result.files[0]?.collection, 'failed')
    assert.equal(record.result.exitCode, 2)
  })

  test('--last-failed runs what the last run did not pass, each for the variant it recorded', async () => {
    const root = tempProject({
      'retest.config.ts': config,
      'tests/tasks.retest.ts': tests,
      'tests/flaky.retest.ts': `import { expect, test } from '@rehearsal-labs/retest'
test('shows a note', async ({ page }) => {
  await expect(page.getByTestId('hidden-note')).toBeVisible()
})
`,
    })
    const first = await runProject(root, { files: ['tests/tasks.retest.ts', 'tests/flaky.retest.ts'], selection: { targets: { web: 'beta' } } })
    assert.equal(first.result.exitCode, 1)
    const lastRun = parse(lastRunSchema, JSON.parse(readFileSync(join(root, lastRunFile), 'utf8')))
    assert.ok(lastRun.ok)
    assert.deepEqual(lastRun.value.tests, [{ testId: 'tests/flaky.retest.ts > shows a note', variantKey: 'web=beta', status: 'failed' }])
    const again = await runProject(root, { files: ['tests/tasks.retest.ts', 'tests/flaky.retest.ts'], selection: { lastFailed: lastRun.value.tests } })
    assert.deepEqual(
      again.result.files.flatMap((file) => file.tests).map((result) => [result.testId, result.variantKey]),
      [['tests/flaky.retest.ts > shows a note', 'web=beta']],
    )
  })
})
