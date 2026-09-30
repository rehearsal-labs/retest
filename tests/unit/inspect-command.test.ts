import type { TestReport } from '../../src/cli/commands/inspect.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, test } from 'node:test'
import { retestEventSchema } from '../../src/protocol/events.ts'
import { runResultSchema } from '../../src/protocol/result.ts'
import { parse } from '../../src/protocol/schema.ts'
import { fakeCli, writeRunFolder } from './cli-fixtures.ts'
import {
  failingRun,
  lateError,
  lateErrorRun,
  launchFailureRun,
  passingRun,
  plain,
  projectFolder,
  resultOf,
  savesTask,
  showsCount,
} from './reporters-fixtures.ts'

const root = projectFolder()
const runs = join(root, 'runs')
mkdirSync(runs)
const runsName = relative(root, runs)

const failing = failingRun(root)
const finished = writeRunFolder(runs, 'finished', { events: failing, result: resultOf(failing) })
const killedEvents = failing.slice(
  0,
  failing.findIndex((event) => event.type === 'assertion.failed'),
)
const killed = writeRunFolder(runs, 'killed', { events: killedEvents, tail: '{"schemaVersion":1,"runId":"run-1","seq' })
const passedButUnwritten = writeRunFolder(runs, 'unwritten', { events: passingRun(root) })
const empty = writeRunFolder(runs, 'empty', { events: [] })
const killedAfterFileFailed = writeRunFolder(runs, 'killed-after-file-failed', { events: lateErrorRun(root).slice(0, -1) })
const launchEvents = launchFailureRun(root)
const notLaunched = writeRunFolder(runs, 'not-launched', { events: launchEvents, result: resultOf(launchEvents) })

function shown(folder: string): string {
  return relative(root, folder)
}

async function inspect(args: string[], options: { isTTY?: boolean } = {}) {
  const fake = fakeCli({ cwd: root, ...options })
  const code = await fake.cli(['inspect', ...args])
  return { code, stdout: fake.stdout.text, stderr: fake.stderr.text }
}

function report(stdout: string): TestReport {
  const value: unknown = JSON.parse(stdout)
  assert.ok(
    typeof value === 'object' && value !== null && 'test' in value && 'events' in value && Array.isArray(value.events),
  )
  const events: RetestEvent[] = value.events.map((event: unknown) => {
    const parsed = parse(retestEventSchema, event)
    assert.ok(parsed.ok)
    return parsed.value
  })
  const result = parse(runResultSchema, {
    ...resultOf(failing),
    files: [{ file: 'f', collection: 'ok', tests: [value.test] }],
  })
  assert.ok(result.ok, 'the test must be a valid test result')
  const test = result.value.files[0]?.tests[0]
  assert.ok(
    test !== undefined &&
      'runId' in value &&
      typeof value.runId === 'string' &&
      'complete' in value &&
      typeof value.complete === 'boolean',
  )
  return { schemaVersion: 1, runId: value.runId, complete: value.complete, test, events }
}

describe('inspect a finished run', () => {
  test('--json prints exactly the stored result', async () => {
    const { code, stdout, stderr } = await inspect([shown(finished), '--json'])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    const parsed = parse(runResultSchema, JSON.parse(stdout))
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.value, resultOf(failing))
  })

  test('prints the same report the run printed, from the folder', async () => {
    const { code, stdout, stderr } = await inspect([shown(finished)])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    assert.match(stdout, /✗ saves a task {2}5\.6s/)
    assert.match(stdout, /Check failed {5}toHaveText/)
    assert.match(stdout, /› 7 │ {3}await expect/)
    assert.match(stdout, new RegExp(`Screenshot {7}${shown(finished)}/artifacts/saves-a-task-failure\\.png`))
    assert.match(
      stdout,
      new RegExp(
        `Inspect {10}npx retest inspect ${shown(finished)} --test "examples/task\\.retest\\.ts > saves a task"`,
      ),
    )
    assert.match(stdout, /\n {2}Exit {4}1\n/)
  })

  test('shows the run failure once, in the report and in --json', async () => {
    const { stdout } = await inspect([shown(notLaunched)])
    assert.match(stdout, /\n {2}Run failed\n {4}Setup failed\n {4}No browser at \/opt\/chromium\./)
    assert.equal(stdout.split('No browser at').length, 2)
    const json = await inspect([shown(notLaunched), '--json'])
    const parsed = parse(runResultSchema, JSON.parse(json.stdout))
    assert.ok(parsed.ok)
    assert.equal(parsed.value.failure?.class, 'setup_failed')
  })

  test('colours a terminal', async () => {
    const { stdout } = await inspect([shown(finished)], { isTTY: true })
    assert.ok(stdout.includes('\u001b['))
    assert.equal(plain(stdout), (await inspect([shown(finished)])).stdout)
  })
})

describe('inspect a run that did not finish', () => {
  test('rebuilds the result from its events, incomplete, and reports the torn line', async () => {
    const { code, stdout, stderr } = await inspect([shown(killed), '--json'])
    assert.equal(code, 0)
    const parsed = parse(runResultSchema, JSON.parse(stdout))
    assert.ok(parsed.ok)
    assert.equal(parsed.value.complete, false)
    assert.equal(parsed.value.status, 'error')
    assert.equal(parsed.value.exitCode, 2)
    assert.deepEqual(parsed.value.counts, { passed: 0, failed: 0, error: 1, notRun: 1, inconclusive: 0 })
    assert.match(
      stderr,
      /^warning: result\.json is missing, so the run did not finish\. This result is rebuilt from \d+ events and marked incomplete\.\n/,
    )
    assert.match(
      stderr,
      new RegExp(
        `\\nwarning: events\\.jsonl ends in a line cut off while it was written \\(line ${killedEvents.length + 1}\\); it was left out\\.\\n$`,
      ),
    )
  })

  test('never reads as a completed pass, even when every test passed', async () => {
    const { code, stdout } = await inspect([shown(passedButUnwritten), '--json'])
    assert.equal(code, 0)
    const result: unknown = JSON.parse(stdout)
    assert.ok(typeof result === 'object' && result !== null)
    assert.deepEqual(
      [Reflect.get(result, 'complete'), Reflect.get(result, 'status'), Reflect.get(result, 'exitCode')],
      [false, 'error', 2],
    )
    const human = await inspect([shown(passedButUnwritten)])
    assert.match(human.stdout, /\n {2}Run failed\n {4}Reporting failed\n {4}The run finished without writing result\.json\.\n/)
    assert.match(human.stdout, /\n {2}Exit {4}2 · incomplete\n/)
  })

  test('a run killed after its file failed outside its tests still shows that failure', async () => {
    const json = await inspect([shown(killedAfterFileFailed), '--json'])
    assert.equal(json.code, 0)
    const parsed = parse(runResultSchema, JSON.parse(json.stdout))
    assert.ok(parsed.ok)
    assert.deepEqual(parsed.value.files[0]?.failure, lateError)
    const human = await inspect([shown(killedAfterFileFailed)])
    assert.match(human.stdout, /\n {2}✗ examples\/task\.retest\.ts {2}failed outside its tests\n\n {4}Test error\n {4}examples\/task\.retest\.ts threw an error/)
    assert.match(human.stdout, /\n {2}Run failed\n {4}Interrupted\n {4}The run stopped before it finished\.\n/)
    assert.match(human.stdout, /\n {2}Files {3}1 file failed outside its tests\n/)
  })

  test('a run with no events at all exits 2 and prints nothing on stdout', async () => {
    for (const args of [[shown(empty)], [shown(empty), '--json']]) {
      const { code, stdout, stderr } = await inspect(args)
      assert.equal(code, 2)
      assert.equal(stdout, '')
      assert.match(stderr, /the run stopped before it recorded anything\./)
    }
  })

  test('a missing folder exits 2', async () => {
    const { code, stdout, stderr } = await inspect([`${runsName}/nowhere`, '--json'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(stderr, `error: No run folder at ${runsName}/nowhere.\n`)
  })
})

describe('inspect one test', () => {
  test('--json gives the test and its events, in order', async () => {
    const { code, stdout, stderr } = await inspect([shown(finished), '--test', savesTask, '--json'])
    assert.equal(code, 0)
    assert.equal(stderr, '')
    const focused = report(stdout)
    assert.equal(focused.runId, 'run-1')
    assert.equal(focused.complete, true)
    assert.equal(focused.test.testId, savesTask)
    assert.equal(focused.test.failure?.class, 'check_failed')
    assert.deepEqual(
      focused.events.map((event) => event.type),
      [
        'test.started',
        'action.completed',
        'navigation',
        'action.completed',
        'action.completed',
        'assertion.failed',
        'evidence.captured',
        'test.finished',
      ],
    )
    assert.ok(focused.events.every((event) => 'testId' in event && event.testId === savesTask))
    const sequences = focused.events.map((event) => event.sequence)
    assert.deepEqual(
      sequences,
      [...sequences].sort((left, right) => left - right),
    )
  })

  test('prints the steps, actions and checks in order, then the failure card', async () => {
    const { code, stdout } = await inspect([shown(finished), '--test', savesTask])
    assert.equal(code, 0)
    const expectedOrder = [
      'examples/task.retest.ts › saves a task  examples/task.retest.ts:3:1',
      'Failed · 5.6s · 1 check',
      'started',
      'goto → http://127.0.0.1:4173/  12 ms',
      'navigated to http://127.0.0.1:4173/',
      "fill getByTestId('task-title'), 17 characters  8 ms",
      "click getByTestId('save-task')  9 ms",
      "✗ toHaveText getByTestId('saved-task')  5s, 14 looks  check_failed",
      `screenshot ${shown(finished)}/artifacts/saves-a-task-failure.png`,
      'failed  5.6s',
      'Check failed     toHaveText',
      '- Expected       "Release checklist"',
    ]
    let from = 0
    for (const line of expectedOrder) {
      const at = stdout.indexOf(line, from)
      assert.ok(at >= from, `${line} is missing or out of order in:\n${stdout}`)
      from = at + line.length
    }
  })

  test('a passing test shows its events and no card', async () => {
    const { code, stdout } = await inspect([shown(finished), '--test', showsCount])
    assert.equal(code, 0)
    assert.match(stdout, /Passed · 904 ms · 1 check/)
    assert.match(stdout, /✓ toHaveText getByTestId\('count'\)/)
    assert.doesNotMatch(stdout, /Check failed|Rerun/)
  })

  test('a test the killed run never started says it did not run', async () => {
    const { code, stdout } = await inspect([shown(killed), '--test', showsCount, '--json'])
    assert.equal(code, 0)
    const focused = report(stdout)
    assert.equal(focused.complete, false)
    assert.equal(focused.test.status, 'not_run')
    assert.deepEqual(focused.events, [])
  })

  test('a test that did not run shows why', async () => {
    const { code, stdout } = await inspect([shown(killed), '--test', showsCount])
    assert.equal(code, 0)
    assert.match(stdout, /Not run · 0 ms · 0 checks\n\n {2}No events were recorded for this test\.\n/)
    assert.match(stdout, /\n {4}Interrupted\n {4}The run stopped before this test started\.\n/)
  })

  test('an unknown test id exits 2 with a suggestion and the ids in the run', async () => {
    const { code, stdout, stderr } = await inspect([shown(finished), '--test', 'examples/task.retest.ts > saves a tsk'])
    assert.equal(code, 2)
    assert.equal(stdout, '')
    assert.equal(
      stderr,
      [
        'error: No test "examples/task.retest.ts > saves a tsk" in this run. Did you mean "examples/task.retest.ts > saves a task"?',
        'Tests in this run:',
        '  examples/task.retest.ts > saves a task',
        '  examples/task.retest.ts > shows the count',
        '',
      ].join('\n'),
    )
  })
})

describe('inspect usage', () => {
  test('takes exactly one run folder', async () => {
    const none = await inspect(['--json'])
    assert.equal(none.code, 2)
    assert.match(none.stderr, /Name the run folder to read/)
    const two = await inspect([shown(finished), shown(killed)])
    assert.equal(two.code, 2)
    assert.match(two.stderr, /inspect reads one run folder, received 2\./)
    assert.match((await inspect([shown(finished), '--tset', savesTask])).stderr, /Did you mean --test\?/)
    assert.equal((await inspect([shown(finished), '--test'])).code, 2)
  })

  test('never reruns anything', async () => {
    const fake = fakeCli({ cwd: tmpdir() })
    await fake.cli(['inspect', finished])
    assert.deepEqual([fake.runs.length, fake.collects.length], [0, 0])
  })
})
