import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { budgets, eventsOf, exampleFile, onlyEvent, onlyTest, runRetest, scenario } from './cli-harness.ts'

test('duplicate targets: two matching test ids fail as ambiguous, and neither is clicked', async (t) => {
  const app = await openApp(t, { mode: 'duplicate' })
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url })

  assert.equal(run.exit.code, 1)
  const failed = onlyTest(run)
  assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'ambiguous'])
  const click = onlyEvent(run.events, 'action.failed')
  const clicked = click.locator?.by === 'testId' ? click.locator.value : undefined
  assert.deepEqual([click.command, clicked, click.failure.details?.['count']], ['click', 'save-task', 2])
  assert.equal(app.submissions(), 0)
})

test('covered target: an overlay stops the click, names what covers it, and nothing is submitted', async (t) => {
  const app = await openApp(t, { mode: 'overlay' })
  const run = await runRetest(t, { files: [scenario('save-empty')], baseUrl: app.url, timeouts: budgets({ action: 500 }) })

  assert.equal(run.exit.code, 1)
  const failed = onlyTest(run)
  assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'not_actionable'])
  const click = onlyEvent(run.events, 'action.failed')
  assert.equal(click.command, 'click')
  assert.deepEqual(click.failure.details, { check: 'hit-target', covering: '<div>', waitedMs: 500 })
  assert.equal(app.submissions(), 0)
})

for (const [mode, reason] of [
  ['disabled', /it is disabled/],
  ['readonly', /it is read-only/],
] as const) {
  test(`${mode} field: fill fails clearly and the field keeps its value`, async (t) => {
    const app = await openApp(t, { mode })
    const run = await runRetest(t, { files: [scenario('locked-field')], baseUrl: app.url, timeouts: budgets({ action: 500 }) })

    assert.equal(run.exit.code, 1)
    const failed = onlyTest(run)
    assert.deepEqual([failed.status, failed.failure?.class], ['failed', 'not_actionable'])
    assert.match(failed.failure?.message ?? '', reason)
    assert.equal(onlyEvent(run.events, 'action.failed').command, 'fill')
    const kept = onlyEvent(run.events, 'assertion.passed')
    assert.equal(kept.actual?.text, 'Existing task', 'the saved title is the value the field already had')
    assert.equal(app.submissions(), 1)
  })
}

test('replaced element: a locator used after the element was replaced acts on the current one', async (t) => {
  const app = await openApp(t, { mode: 'replaced' })
  const run = await runRetest(t, { files: [scenario('replaced-button')], baseUrl: app.url })

  assert.equal(run.exit.code, 0)
  assert.equal(onlyTest(run).status, 'passed')
  assert.equal(app.submissions(), 1)
})

test('delayed result: the assertion waits by looking again, and the save is submitted once', async (t) => {
  const delayMs = 1500
  const app = await openApp(t, { mode: 'delayed', delayMs })
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url, timeouts: budgets({ assertion: 5000 }) })

  assert.equal(run.exit.code, 0)
  const check = onlyEvent(run.events, 'assertion.passed')
  assert.ok(check.attempts > 1, `looked ${check.attempts} times`)
  assert.ok(check.durationMs >= delayMs - 100, `waited ${check.durationMs} ms`)
  assert.equal(app.submissions(), 1)
})

test('submit counter: one click is one submission, however often the failing assertion looks', async (t) => {
  const app = await openApp(t, { mode: 'broken' })
  const run = await runRetest(t, { files: [exampleFile], baseUrl: app.url, timeouts: budgets({ assertion: 1500 }) })

  assert.equal(run.exit.code, 1)
  assert.equal(eventsOf(run.events, 'action.completed').filter((event) => event.command === 'click').length, 1)
  const check = onlyEvent(run.events, 'assertion.failed')
  assert.ok(check.attempts >= 5, `looked ${check.attempts} times`)
  assert.equal(app.submissions(), 1)
})
