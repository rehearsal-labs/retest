import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import {
  budgets,
  eventsOf,
  exampleFile,
  onlyEvent,
  onlyTest,
  resultOf,
  runRetest,
  scenario,
} from './cli-harness.ts'

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

test('passing save: one action sequence, the exact text, a passing result and exit 0', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url })

  assert.equal(run.exit.code, 0)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.exitCode, result.complete], ['passed', 0, true])
  assert.deepEqual(result.counts, { passed: 1, failed: 0, error: 0, notRun: 0, inconclusive: 0 })
  const browser = onlyEvent(run.events, 'browser.started')
  assert.deepEqual(result.browser, { product: browser.product, version: browser.version, executablePath: browser.executablePath })
  const actions = eventsOf(run.events, 'action.completed').map((event) => [event.command, event.locator?.value ?? null])
  assert.deepEqual(actions, [
    ['goto', null],
    ['fill', 'task-title'],
    ['click', 'save-task'],
  ])
  const fill = eventsOf(run.events, 'action.completed').find((event) => event.command === 'fill')
  assert.equal(fill?.valueLength, 'Release checklist'.length)
  for (const action of eventsOf(run.events, 'action.completed')) {
    assert.equal(JSON.stringify(action).includes('Release checklist'), false, 'actions record no typed value')
  }
  const check = onlyEvent(run.events, 'assertion.passed')
  assert.equal(check.matcher, 'toHaveText')
  assert.deepEqual([check.expected?.text, check.actual?.text], ['Release checklist', 'Release checklist'])
  assert.deepEqual([onlyTest(run).status, onlyTest(run).assertionCount], ['passed', 1])
  assert.equal(app.submissions(), 1)
})

test('broken application: the same test fails its check on the wrong text, with a screenshot, and exits 1', async (t) => {
  const app = await openApp(t, { mode: 'broken' })
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url, timeouts: budgets({ assertion: 1000 }) })

  assert.equal(run.exit.code, 1)
  const result = resultOf(run)
  assert.deepEqual([result.status, result.exitCode, result.complete], ['failed', 1, true])
  const failed = onlyTest(run)
  assert.equal(failed.status, 'failed')
  assert.equal(failed.failure?.class, 'check_failed')
  assert.match(failed.failure?.message ?? '', /"Release checklis"/)
  const check = onlyEvent(run.events, 'assertion.failed')
  assert.deepEqual([check.expected?.text, check.actual?.text], ['Release checklist', 'Release checklis'])
  assert.equal(check.location?.line, 7)

  const [screenshot] = failed.evidence
  assert.ok(screenshot !== undefined, 'the failure has a screenshot')
  assert.equal(onlyEvent(run.events, 'evidence.captured').path, screenshot.path)
  assert.deepEqual([...readFileSync(join(run.output, screenshot.path)).subarray(0, 8)], pngSignature)
  assert.equal(app.submissions(), 1)
})

test('zero assertions: a test that only acts fails, and the run cannot pass', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [scenario('zero-assertions')], baseUrl: app.url })

  assert.equal(run.exit.code, 1)
  const acted = onlyTest(run)
  assert.deepEqual([acted.status, acted.assertionCount, acted.failure?.class], ['failed', 0, 'no_assertions'])
  assert.equal(eventsOf(run.events, 'action.completed').length, 3, 'every action still ran')
  assert.equal(app.submissions(), 1)
})

test('unawaited work: an assertion still looking when the test returns fails the test', async (t) => {
  const app = await openApp(t, { mode: 'delayed', delayMs: 1500 })
  const run = await runRetest(t, { files: [scenario('unawaited-assertion')], baseUrl: app.url })

  assert.equal(run.exit.code, 1)
  const returned = onlyTest(run)
  assert.equal(returned.status, 'failed')
  assert.equal(returned.failure?.class, 'not_awaited')
  assert.match(returned.failure?.message ?? '', /still running when the test returned/)
  assert.equal(returned.failure?.location?.line, 7)
})

test('unawaited work: a failed assertion nothing awaited still fails the test', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [scenario('unawaited-failure')], baseUrl: app.url, timeouts: budgets({ assertion: 300 }) })

  assert.equal(run.exit.code, 1)
  const swallowed = onlyTest(run)
  assert.equal(swallowed.status, 'failed')
  assert.equal(swallowed.failure?.class, 'not_found')
  assert.equal(onlyEvent(run.events, 'assertion.failed').locator?.value, 'missing-task')
  assert.ok(eventsOf(run.events, 'assertion.passed').length === 1, 'the later value check still ran and passed')
})

// Retest's own usage errors thrown outside a test's scope are never recorded, and the child ignores them.
for (const [name, file, message] of [
  ['a test declared after the file loaded', 'late-test', /test\(\) registers tests while retest loads a test file/],
  ['a check that fails outside the running test', 'outside-check', /expect\(\) can only run inside a test/],
] as const) {
  test(`unawaited work: ${name} cannot leave a passing run`, async (t) => {
    const run = await runRetest(t, { files: [scenario(file)] })

    assert.notEqual(run.exit.code, 0, 'the run passed')
    assert.match(JSON.stringify(resultOf(run)), message)
  })
}
