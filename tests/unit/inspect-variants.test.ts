import type { RetestEvent } from '../../src/protocol/events.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, test } from 'node:test'
import { rebuildResult } from '../../src/cli/inspect/rebuild-result.ts'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { parse } from '../../src/protocol/schema.ts'
import { fakeCli, writeRunFolder } from './cli-fixtures.ts'
import { savesTask, signsIn, variantProject, variantResult, variantRun } from './reporters-variant-fixtures.ts'

const root = variantProject()
mkdirSync(join(root, 'runs'))
const events = variantRun(root)
const finished = relative(root, writeRunFolder(join(root, 'runs'), 'finished', { events, result: variantResult(events) }))
const cutShort = relative(root, writeRunFolder(join(root, 'runs'), 'cut-short', { events: events.slice(0, -1) }))

async function inspect(args: string[]) {
  const fake = fakeCli({ cwd: root })
  const code = await fake.cli(['inspect', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

// The test and events `inspect --test --json` printed, each checked against its schema.
function report(stdout: string): { test: TestResult; events: RetestEvent[] } {
  const value: unknown = JSON.parse(stdout)
  assert.ok(typeof value === 'object' && value !== null && 'test' in value && 'events' in value && Array.isArray(value.events))
  const shown: RetestEvent[] = value.events.map((event: unknown) => {
    const parsed = parse(retestEventSchema, event)
    assert.ok(parsed.ok)
    return parsed.value
  })
  const result = parse(runResultSchema, { ...variantResult(events), files: [{ file: 'f', collection: 'ok', tests: [value.test] }] })
  assert.ok(result.ok, 'the test must be a valid test result')
  const test = result.value.files[0]?.tests[0]
  assert.ok(test !== undefined)
  return { test, events: shown }
}

describe('inspect a run with several targets', () => {
  test('replays the report with each variant labelled', async () => {
    const { code, stdout } = await inspect([finished])
    assert.equal(code, 0)
    assert.match(stdout, /✗ tasks › saves a task {2}web=pixel \(emulated\) {2}5\.6s/)
    assert.match(stdout, /Tests {3}1 failed · 3 passed across 2 targets/)
  })

  test('a test that ran on several targets needs --target, and says which there were', async () => {
    const { code, stdout, stderr } = await inspect([finished, '--test', savesTask])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(
      stderr,
      [
        'error: "tests/tasks.retest.ts > tasks > saves a task" ran on web=chromium and web=pixel. Name one with --target, such as --target web=chromium.',
        'See retest help inspect.',
        '',
      ].join('\n'),
    )
  })

  test('--target picks the variant: the timeline names it, and each action its app', async () => {
    const { code, stdout } = await inspect([finished, '--test', savesTask, '--target', 'web=pixel'])
    assert.equal(code, 0)
    const expectedOrder = [
      'tests/tasks.retest.ts › tasks › saves a task  web=pixel (emulated)  tests/tasks.retest.ts:8:3',
      'Failed · 5.6s · 1 check',
      'started',
      'restored state signed-in for web',
      "web  click getByRole('button', { name: 'Save' })  9 ms",
      "✗ toHaveText getByTestId('saved-task')  5s, 14 looks  check_failed",
      'failed  5.6s',
      'Rerun            npx retest run tests/tasks.retest.ts:8 --target web=pixel',
      'Inspect          npx retest inspect runs/finished --test "tests/tasks.retest.ts > tasks > saves a task" --target web=pixel',
    ]
    let from = 0
    for (const line of expectedOrder) {
      const at = stdout.indexOf(line, from)
      assert.ok(at >= from, `${line} is missing or out of order in:\n${stdout}`)
      from = at + line.length
    }
  })

  test('--json gives that variant and only its events', async () => {
    const { code, stdout } = await inspect([finished, '--test', savesTask, '--target', 'web=chromium', '--json'])
    assert.equal(code, 0)
    const focused = report(stdout)
    assert.equal(focused.test.variantKey, 'web=chromium')
    assert.equal(focused.test.status, 'passed')
    assert.ok(focused.events.length > 0)
    assert.ok(focused.events.every((event) => 'variantKey' in event && event.variantKey === 'web=chromium'))
  })

  test('a target the test did not run on, a bad pair, and --target without --test are errors', async () => {
    assert.match(
      (await inspect([finished, '--test', signsIn, '--target', 'web=beta'])).stderr,
      /"tests\/tasks\.retest\.ts > signs in" did not run on web=beta in this run\. It ran on web=chromium and web=pixel\./,
    )
    assert.match((await inspect([finished, '--test', signsIn, '--target', 'beta'])).stderr, /--target takes app=name/)
    const alone = await inspect([finished, '--target', 'web=pixel'])
    assert.equal(alone.code, 2)
    assert.match(alone.stderr, /--target picks a test's target, so it needs --test\./)
  })

  test('a run cut short is rebuilt with one result per variant, each screenshot naming its app', async () => {
    const rebuilt = rebuildResult(events.slice(0, -1))
    const tests = rebuilt.files.flatMap((file) => file.tests)
    assert.deepEqual(
      tests.map((found) => [found.testId, found.variantKey, found.status]),
      [
        [signsIn, 'web=chromium', 'passed'],
        [signsIn, 'web=pixel', 'passed'],
        [savesTask, 'web=chromium', 'passed'],
        [savesTask, 'web=pixel', 'failed'],
      ],
    )
    const failed = tests.at(-1)
    assert.deepEqual(failed?.evidence, [{ kind: 'screenshot', path: 'artifacts/tasks-saves-a-task-web-failure.png', app: 'web' }])
    assert.deepEqual(failed?.describePath, ['tasks'])
    assert.equal(tests[0]?.setup, true)
    assert.deepEqual(
      rebuilt.browsers?.map((browser) => [browser.app, browser.target?.name, browser.target?.device]),
      [
        ['web', 'chromium', undefined],
        ['web', 'pixel', 'Pixel 9'],
      ],
    )
    const { code, stdout } = await inspect([cutShort, '--test', savesTask, '--target', 'web=pixel', '--json'])
    assert.equal(code, 0)
    assert.equal(report(stdout).test.variantKey, 'web=pixel')
  })
})
