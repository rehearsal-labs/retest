import type { RetestEvent } from '../../src/protocol/events.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createAgentReporter } from '../../src/reporters/agent.ts'
import { createHumanReporter } from '../../src/reporters/human.ts'
import { capture, plain, stamp } from './reporters-fixtures.ts'
import { runStarted, serverFailureRun, variantProject, variantResult, variantRun } from './reporters-variant-fixtures.ts'

const root = variantProject()
const runFolder = '.retest/runs/2026-09-30T09-15-00.000Z'

function human(events: RetestEvent[], color = false): string {
  const stdout = capture()
  const reporter = createHumanReporter({ stdout, stderr: capture(), color, runFolder })
  for (const event of events) reporter.onEvent(event)
  reporter.onRunEnd(variantResult(events))
  return stdout.text
}

function agent(events: RetestEvent[]): string {
  const stdout = capture()
  const reporter = createAgentReporter({ stdout, runFolder })
  for (const event of events) reporter.onEvent(event)
  reporter.onRunEnd(variantResult(events))
  return stdout.text
}

// The same run with the app narrowed to one of its targets.
function onlyTarget(events: RetestEvent[], target: 'chromium' | 'pixel'): RetestEvent[] {
  const other = target === 'pixel' ? 'chromium' : 'pixel'
  return events.flatMap((event): RetestEvent[] => {
    if ('variantKey' in event && event.variantKey === `web=${other}`) return []
    if (event.type === 'browser.started' && event.target?.name === other) return []
    if (event.type !== 'collection.completed') return [event]
    return [{ ...event, tests: event.tests.map((collected) => ({ ...collected, variants: [{ web: target }] })) }]
  })
}

describe('human reporter with a target spread over several browsers', () => {
  test("the target's first line says how many, and its further browsers print nothing", () => {
    const events = variantRun(root).flatMap((event): RetestEvent[] => {
      if (event.type !== 'browser.started' || event.target?.name !== 'chromium') return [event]
      return [{ ...event, instances: 2 }, { ...event, instance: 2, pid: event.pid + 1 }]
    })
    const lines = human(events).split('\n').filter((line) => line.includes('started web=chromium'))
    assert.deepEqual(lines, ['  started web=chromium  Chrome 154.0.7195.41 · 2 browsers'])
  })
})

describe('human reporter with targets', () => {
  test('labels each test with its variant, marks the emulated one, and shows servers, browsers and states quietly', () => {
    const stdout = human(variantRun(root))
    assert.equal(
      stdout.slice(0, stdout.indexOf('\n  ✗ tests/tasks.retest.ts')),
      [
        '',
        '  retest 0.0.0',
        '  web  started, http://127.0.0.1:4173 answered after 2.1s',
        '',
        '  tests/tasks.retest.ts  2 tests',
        '  started web=chromium  Chrome 154.0.7195.41',
        '    ✓ signs in (setup)  web=chromium  300 ms',
        '      saved state signed-in for web',
        '    ✓ tasks › saves a task  web=chromium  800 ms',
        '      restored state signed-in for web',
        '  started web=pixel  Chrome 154.0.7195.41 as Pixel 9 · emulated',
        '    ✓ signs in (setup)  web=pixel (emulated)  300 ms',
        '      saved state signed-in for web',
        '    ✗ tasks › saves a task  web=pixel (emulated)  5.6s',
        '      restored state signed-in for web',
        '',
      ].join('\n'),
    )
  })

  test('the failure card names the variant, and its rerun and inspect lines pick it out', () => {
    const stdout = human(variantRun(root))
    assert.match(stdout, /\n {2}✗ tests\/tasks\.retest\.ts › tasks › saves a task {2}web=pixel \(emulated\) {2}5\.6s\n/)
    assert.match(stdout, /\n {4}Rerun {12}npx retest run tests\/tasks\.retest\.ts:8 --target web=pixel\n/)
    assert.match(
      stdout,
      /\n {4}Inspect {10}npx retest inspect \S+ --test "tests\/tasks\.retest\.ts > tasks > saves a task" --target web=pixel\n/,
    )
  })

  test('prints a line for each target when there are several, and counts across them', () => {
    const stdout = human(variantRun(root))
    assert.equal(
      stdout.slice(stdout.indexOf('\n  web=chromium  Chrome 154.0.7195.41  ')),
      [
        '',
        '  web=chromium  Chrome 154.0.7195.41                        ✓ 2 passed             1.1s',
        '  web=pixel     Chrome 154.0.7195.41 as Pixel 9 · emulated  ✗ 1 failed · 1 passed  5.9s',
        '',
        '  Tests   1 failed · 3 passed across 2 targets',
        '  Checks  1 failed · 1 passed',
        '  Time    7.2s',
        `  Output  ${runFolder}`,
        '  Exit    1',
        '',
        '',
      ].join('\n'),
    )
  })

  test('one target prints no target lines and no --target to rerun, but still marks emulation', () => {
    const stdout = human(onlyTarget(variantRun(root), 'pixel'))
    assert.doesNotMatch(stdout, /across|--target/)
    assert.match(stdout, /Rerun {12}npx retest run tests\/tasks\.retest\.ts:8\n/)
    assert.match(stdout, /\n {4}✗ tasks › saves a task {2}web=pixel \(emulated\) {2}5\.6s\n/)
  })

  test('one target that is not emulated needs no label on its tests', () => {
    const stdout = human(onlyTarget(variantRun(root), 'chromium'))
    assert.match(stdout, /\n {2}started web=chromium {2}Chrome 154\.0\.7195\.41\n {4}✓ signs in \(setup\) {2}300 ms\n/)
    assert.match(stdout, /\n {4}✓ tasks › saves a task {2}800 ms\n/)
    assert.doesNotMatch(agent(onlyTarget(variantRun(root), 'chromium')), /\[|across/)
  })

  test('a server that never answers is one line, and the run failure says why no test ran', () => {
    const stdout = human(serverFailureRun(root))
    assert.match(
      stdout,
      /\n {2}✗ web {2}The server for web did not answer at http:\/\/127\.0\.0\.1:4173 within 60000 ms\. Its output is in logs\/app-web\.log\.\n/,
    )
    assert.match(stdout, /\n {2}Not run\n {4}tests\/tasks\.retest\.ts › signs in {2}web=chromium\n/)
    assert.match(stdout, /\n {2}Run failed\n {4}Setup failed\n {4}The server for web did not answer/)
    assert.equal(stdout.split('did not answer').length, 3, 'once as it happened and once as the run failure')
    assert.match(stdout, /\n {2}web=chromium {2}! 2 not run {2}0 ms\n/)
  })

  test('colours the variant, with the same words', () => {
    const coloured = human(variantRun(root), true)
    assert.ok(coloured.includes('\u001b[36mweb=pixel (emulated)\u001b[39m'))
    assert.equal(plain(coloured), human(variantRun(root)))
  })
})

describe('agent reporter with targets', () => {
  test('carries the variant on each block, counts across targets, and picks the variant in next', () => {
    assert.equal(
      agent(variantRun(root)),
      [
        'retest: 1 failed, 3 passed (4) across 2 targets in 7.2s, exit 1',
        'fail tests/tasks.retest.ts:10 tasks › saves a task [web=pixel (emulated)]',
        "  check_failed toHaveText getByTestId('saved-task')",
        '  expected "Release checklist" received "Saving…" waited 5003ms for toHaveText, looked 14 times, limit 5000ms',
        `  screenshot ${runFolder}/artifacts/tasks-saves-a-task-web-failure.png`,
        `next: npx retest inspect ${runFolder} --test "tests/tasks.retest.ts > tasks > saves a task" --target web=pixel --json`,
        '',
      ].join('\n'),
    )
  })

  test('tests kept from running name their variant, and the run failure comes once', () => {
    assert.equal(
      agent(serverFailureRun(root)),
      [
        'retest: 4 not run (4) across 2 targets in 1m 0s, exit 2, incomplete',
        'run failed: setup_failed The server for web did not answer at http://127.0.0.1:4173 within 60000 ms. Its output is in logs/app-web.log.',
        'not run tests/tasks.retest.ts:3 signs in [web=chromium]',
        'not run tests/tasks.retest.ts:3 signs in [web=pixel]',
        'not run tests/tasks.retest.ts:8 tasks › saves a task [web=chromium]',
        'not run tests/tasks.retest.ts:8 tasks › saves a task [web=pixel]',
        `next: npx retest inspect ${runFolder} --json`,
        '',
      ].join('\n'),
    )
  })
})

describe('rerun lines from a config', () => {
  test('repeat a config at another path and the base URLs the command line gave', () => {
    const events = variantRun(variantProject('e2e/retest.config.ts'), { config: 'e2e/retest.config.ts', baseUrls: { web: 'https://preview.example.com' } })
    assert.match(
      human(events),
      /Rerun {12}npx retest run tests\/tasks\.retest\.ts:8 --config e2e\/retest\.config\.ts --base-url web=https:\/\/preview\.example\.com --target web=pixel\n/,
    )
  })

  // A program may build its config in memory and name it with a path that has no file. No command runs that again.
  test('a config with no file behind it gets no rerun command, and the card and the next line point to inspect', () => {
    const events = variantRun(root, { config: 'in-memory.config.ts' })
    const report = human(events)
    assert.doesNotMatch(report, /Rerun|retest run/)
    assert.match(report, /\n {4}Inspect {10}npx retest inspect \S+ --test "tests\/tasks\.retest\.ts > tasks > saves a task" --target web=pixel\n/)
    assert.doesNotMatch(agent(events), /retest run/)
    assert.match(agent(events), /\nnext: npx retest inspect \S+ --test "tests\/tasks\.retest\.ts > tasks > saves a task" --target web=pixel --json\n$/)
  })
})

describe('run failures before any test', () => {
  test('a selection that keeps nothing reads as the run failure, in both reports', () => {
    const failure = { class: 'usage', message: 'No test matches --tag "smoke" and --target web=pixel.' } as const
    const events = stamp([
      { ...runStarted(root), files: [] },
      { type: 'run.finished', status: 'error', exitCode: 2, complete: false, counts: { passed: 0, failed: 0, error: 0, notRun: 0, inconclusive: 0 }, durationMs: 40, failure },
    ])
    assert.equal(
      human(events),
      [
        '',
        '  retest 0.0.0',
        '',
        '  Run failed',
        '    Usage error',
        '    No test matches --tag "smoke" and --target web=pixel.',
        '',
        '  Tests   none',
        '  Time    40 ms',
        `  Output  ${runFolder}`,
        '  Exit    2 · incomplete',
        '',
        '',
      ].join('\n'),
    )
    assert.equal(
      agent(events),
      [
        'retest: no tests ran in 40 ms, exit 2, incomplete',
        'run failed: usage No test matches --tag "smoke" and --target web=pixel.',
        `next: npx retest inspect ${runFolder} --json`,
        '',
      ].join('\n'),
    )
  })
})

