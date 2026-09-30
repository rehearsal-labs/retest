import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import {
  assertStdoutIsEvents,
  budgets,
  eventsOf,
  finishRun,
  runRetest,
  scenario,
  startRun,
  testNamed,
  waitFor,
} from './cli-harness.ts'

// Acceptance check 1, the short list's part: press on a locator and on the page's keyboard, through the command line
// against real Chrome and the task app, which counts what reaches it.

test('Enter submits a form once, from a field or from the keyboard; Tab and Shift+Tab move the focus; a key the focus left for another element is stopped', async (t) => {
  const app = await openApp(t)
  const file = scenario('press')
  const run = await runRetest(t, { files: [file], baseUrl: app.url, timeouts: budgets({ assertion: 3000 }) })
  assertStdoutIsEvents(run)

  assert.equal(run.exit.code, 1, run.stderr)
  const status = (name: string) => testNamed(run, name).status
  assert.equal(status('submits a search with Enter on its field'), 'passed')
  assert.equal(status("submits a search with Enter on the page's keyboard"), 'passed')
  assert.equal(status('moves the focus with Tab and back with Shift+Tab'), 'passed')

  // Each test's own check shows the answer to its own query, so each one's search reached the server.
  assert.equal(app.searches(), 2, 'one search for each of the two tests')
  for (const name of ['submits a search with Enter on its field', "submits a search with Enter on the page's keyboard"]) {
    const { testId } = testNamed(run, name)
    const moved = eventsOf(run.events, 'navigation').filter((event) => event.testId === testId).map((event) => event.url)
    assert.deepEqual(moved, [`${app.url}/actions`, `${app.url}/actions/submit`], `${name}: the answer to the form is recorded as a navigation`)
  }

  const presses = eventsOf(run.events, 'action.completed').filter((event) => event.command === 'press')
  assert.deepEqual(
    presses.map((event) => [event.key, event.locator]),
    [
      ['Enter', { by: 'label', text: 'Search' }],
      ['Enter', undefined],
      ['Tab', { by: 'label', text: 'First' }],
      ['Shift+Tab', undefined],
    ],
    'each press records its key, and its locator only when it has one',
  )

  const covered = testNamed(run, 'gets no key, and the page hears none')
  assert.deepEqual([covered.status, covered.failure?.class], ['failed', 'not_actionable'])
  assert.equal(
    covered.failure?.message,
    `Could not press Enter on getByLabel('Note'): the keyboard focus moved to another element, <div data-testid="notice">, before the key arrived. Retest stopped the key before the page received it.`,
  )
  assert.deepEqual(covered.failure?.details, { check: 'focused', focus: '<div data-testid="notice">', event: 'keydown' })
  // The afterEach hooks read the page after the stopped key: the notice holds the focus, and no listener heard a key.
  const afterwards = eventsOf(run.events, 'assertion.passed').filter((event) => event.testId === covered.testId)
  assert.deepEqual(
    afterwards.map((event) => [event.matcher, event.locator, event.actual?.text]),
    [
      ['toHaveText', { by: 'testId', value: 'focus' }, 'notice'],
      ['toHaveText', { by: 'testId', value: 'keys-heard' }, ''],
    ],
  )
  const failedPress = eventsOf(run.events, 'action.failed').find((event) => event.testId === covered.testId)
  assert.deepEqual([failedPress?.command, failedPress?.key, failedPress?.failure], ['press', 'Enter', covered.failure])
})

test('a browser killed during a press leaves its outcome unknown, and the key is not sent again', async (t) => {
  const app = await openApp(t)
  const timeouts = budgets({ action: 20_000, assertion: 20_000, test: 30_000 })
  const started = await startRun(t, { files: [scenario('press-browser-lost')], baseUrl: app.url, timeouts })
  const browser = await started.retest.waitForEvent('browser.started')
  // The frozen field tells the server of its key down, then its page never answers, so the press is still in flight.
  await waitFor('the key down reaching the app', () => app.keyDowns() === 1)
  process.kill(-browser.pid, 'SIGKILL')
  const run = await finishRun(started)
  assertStdoutIsEvents(run)

  assert.equal(run.exit.code, 2)
  const lost = testNamed(run, 'presses a key on a page that stops answering')
  assert.deepEqual([lost.status, lost.failure?.class], ['error', 'outcome_unknown'])
  assert.match(lost.failure?.message ?? '', /^Retest lost the page after it began to press a on getByLabel\('Frozen'\), so it cannot tell whether that took effect/)
  const failed = eventsOf(run.events, 'action.failed')
  assert.deepEqual(
    failed.map((event) => [event.command, event.key, event.failure]),
    [['press', 'a', lost.failure]],
    'the press and the test say the same',
  )
  assert.equal(eventsOf(run.events, 'action.completed').filter((event) => event.command === 'press').length, 0)
  const later = testNamed(run, 'runs after the browser is lost')
  assert.deepEqual([later.status, later.failure?.class], ['not_run', 'session_lost'])
  assert.equal(app.keyDowns(), 1, 'the key went down once')
})
