import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isDeepStrictEqual } from 'node:util'
import { openApp } from './browser-harness.ts'
import { assertStdoutIsEvents, eventsOf, runCli, runRetest, scenario, testNamed } from './cli-harness.ts'

// Acceptance check 1, the rest of wave 1: select, check, uncheck and scroll through the command line, against real
// Chrome and the task app's choices and scroll pages, which show every change, click and wheel event they hear.

const chooses = 'chooses by label, by value and from a list, and waits for an option that arrives late'
const ticks = 'ticks and unticks a checkbox, an element whose role is checkbox, and a hidden checkbox through its label'

// What each test's actions of one kind recorded, as the fields the check reads.
function actionsOf(run: FinishedRun, name: string, commands: readonly string[]): Record<string, unknown>[] {
  const { testId } = testNamed(run, name)
  return [...eventsOf(run.events, 'action.completed'), ...eventsOf(run.events, 'action.failed')]
    .filter((event) => event.testId === testId && commands.includes(event.command))
    .sort((first, second) => first.sequence - second.sequence)
    .map(({ command, locator, choices, multiple, changed, input, via, touch, scroll }) => ({ command, locator, choices, multiple, changed, input, via, touch, scroll }))
    .map((fields) => Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)))
}

// The assertions the afterEach hooks of a failed test made, each with the text it saw.
function afterwards(run: FinishedRun, name: string): [string | undefined, string | null | undefined][] {
  const { testId } = testNamed(run, name)
  return eventsOf(run.events, 'assertion.passed')
    .filter((event) => event.testId === testId)
    .map((event) => [event.locator?.by === 'testId' ? event.locator.value : undefined, event.actual?.text])
}

test('select chooses by label, by value and from a list with the keyboard; check and uncheck click once, through a label when the control is hidden; failures send nothing the page hears', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [scenario('choices')], baseUrl: app.url })
  assertStdoutIsEvents(run)
  assert.equal(run.exit.code, 1, run.stderr)

  // select: by label, by value, again with nothing to change, a list for a select multiple, a list of one, and an
  // option that arrived late. The page heard the browser's own input and change for each, trusted, and no event says
  // a script set anything.
  assert.equal(testNamed(run, chooses).status, 'passed')
  const country = { by: 'label', text: 'Country' }
  const toppings = { by: 'label', text: 'Toppings' }
  assert.deepEqual(actionsOf(run, chooses, ['select']), [
    { command: 'select', locator: country, choices: [{ label: 'Canada' }], changed: true },
    { command: 'select', locator: country, choices: [{ value: 'mx' }], changed: true },
    { command: 'select', locator: country, choices: [{ label: 'Mexico' }], changed: false },
    { command: 'select', locator: toppings, choices: [{ label: 'Basil' }, { value: 'olives' }], multiple: true, changed: true },
    { command: 'select', locator: toppings, choices: [{ label: 'Garlic' }], multiple: true, changed: true },
    { command: 'select', locator: country, choices: [{ label: 'Peru' }], changed: true },
  ])
  const late = eventsOf(run.events, 'action.completed').find((event) => isDeepStrictEqual(event.choices, [{ label: 'Peru' }]))
  assert.ok((late?.durationMs ?? 0) >= 150, `the select waited for Peru, which arrives 300 ms after the click: ${late?.durationMs} ms`)

  // check and uncheck: a native checkbox, the same one already checked, an element whose role is checkbox, and a
  // hidden checkbox through its styled label. The page counted one click for each change and none for the check that
  // found its box ticked.
  assert.equal(testNamed(run, ticks).status, 'passed')
  assert.deepEqual(actionsOf(run, ticks, ['check', 'uncheck']), [
    { command: 'check', locator: { by: 'label', text: 'I agree' }, changed: true },
    { command: 'check', locator: { by: 'testId', value: 'agree' }, changed: false },
    { command: 'uncheck', locator: { by: 'label', text: 'I agree' }, changed: true },
    { command: 'check', locator: { by: 'role', role: 'checkbox', name: 'Remember me' }, changed: true },
    { command: 'check', locator: { by: 'label', text: 'Newsletter' }, changed: true, via: 'label' },
    { command: 'uncheck', locator: { by: 'role', role: 'checkbox', name: 'Remember me' }, changed: true },
  ])

  // An option that never comes is waited for until the action's time runs out, and named.
  const missing = testNamed(run, 'waits for an option that never comes, and fails naming it')
  assert.deepEqual([missing.status, missing.failure?.class, missing.failure?.message, missing.failure?.details], [
    'failed',
    'not_found',
    "Could not select 'Atlantis' in getByLabel('Country'): no option matched 'Atlantis' within 2000 ms.",
    { choice: "'Atlantis'", waitedMs: 2000 },
  ])

  // Two options with one label are refused at once; a radio button cannot be unchecked; a covered checkbox is not
  // clicked, and one a cover takes as the pointer arrives has its press stopped before the page hears it. After each,
  // the page had heard no change and no pointer event.
  const ambiguous = testNamed(run, 'refuses two options with one label at once')
  assert.deepEqual([ambiguous.status, ambiguous.failure?.class, ambiguous.failure?.details], ['failed', 'ambiguous', { choice: "'Paris'", count: 2 }])
  const [refused] = eventsOf(run.events, 'action.failed').filter((event) => event.testId === ambiguous.testId)
  assert.ok((refused?.durationMs ?? Infinity) < 1000, `refused at once, in ${refused?.durationMs} ms`)
  assert.ok(refused !== undefined && !('input' in refused), 'a select that was refused set nothing, by script or otherwise')
  const radio = testNamed(run, 'refuses to uncheck a radio button')
  assert.deepEqual([radio.status, radio.failure?.class], ['error', 'unsupported'])
  assert.equal(
    radio.failure?.message,
    `Could not uncheck getByLabel('Small'): it is a radio button, <input data-testid="small">. A person unchecks a radio button by choosing another one, so check that one instead.`,
  )
  const covered = testNamed(run, 'does not tick a checkbox a cover sits on')
  assert.deepEqual([covered.status, covered.failure?.class, covered.failure?.details], [
    'failed',
    'not_actionable',
    { check: 'hit-target', covering: '<span class="cover" data-testid="cover">', waitedMs: 2000 },
  ])
  const taken = testNamed(run, 'stops the click on a checkbox a cover takes as the pointer arrives')
  assert.deepEqual([taken.status, taken.failure?.class, taken.failure?.details], [
    'failed',
    'not_actionable',
    { check: 'hit-target', interceptedBy: '<span class="cover" data-testid="hover-cover">', event: 'pointerdown' },
  ])
  for (const failed of [ambiguous, radio, covered, taken]) {
    assert.deepEqual(afterwards(run, failed.name), [
      ['changes-heard', ''],
      ['pointer-heard', ''],
    ], `${failed.name}: the page heard nothing`)
  }

  // A control that takes its click and stays as it was fails after one click, which the server heard once.
  const locked = testNamed(run, 'clicks a setting that ignores its click once, and fails')
  assert.deepEqual([locked.status, locked.failure?.class, locked.failure?.details], ['failed', 'not_actionable', { check: 'state', inputSent: true }])
  assert.equal(locked.failure?.message, "Could not check getByLabel('Locked setting'): Retest clicked it once, and it stayed unchecked. Retest does not click again.")
  assert.equal(app.toggles(), 1, 'the locked setting was clicked once')

  // inspect writes each action as the test wrote it, with what its call leaves out.
  const timeline = await runCli(t, ['inspect', run.output, '--test', testNamed(run, chooses).testId], { env: { NO_COLOR: '1' } })
  assert.equal(timeline.exit.code, 0, timeline.stderr)
  for (const line of [
    "getByLabel('Country').select('Canada')",
    "getByLabel('Country').select({ value: 'mx' })",
    "getByLabel('Country').select('Mexico'), already selected, sent nothing",
    "getByLabel('Toppings').select(['Basil', { value: 'olives' }])",
    "getByLabel('Toppings').select(['Garlic'])",
  ]) {
    assert.ok(timeline.stdout.includes(line), `inspect shows ${line}:\n${timeline.stdout}`)
  }
  assert.ok(!timeline.stdout.includes('set by script'), `nothing is set by script:\n${timeline.stdout}`)
  const ticked = await runCli(t, ['inspect', run.output, '--test', testNamed(run, ticks).testId], { env: { NO_COLOR: '1' } })
  assert.ok(ticked.stdout.includes("getByLabel('Newsletter').check(), clicked its label"), ticked.stdout)
  assert.ok(ticked.stdout.includes("getByTestId('agree').check(), already checked, sent nothing"), ticked.stdout)
})

test('the wheel scrolls the page, which loads more items, and the terms, which enables Accept; a covered list is not scrolled and the page hears no wheel', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [scenario('scroll')], baseUrl: app.url })
  assertStdoutIsEvents(run)
  assert.equal(run.exit.code, 1, run.stderr)

  const page = testNamed(run, 'scrolls the page, which loads more items')
  assert.equal(page.status, 'passed')
  assert.deepEqual(actionsOf(run, page.name, ['scroll']), [{ command: 'scroll', scroll: { x: 0, y: 5000 } }])
  assert.equal(app.loads(), 1, 'the feed asked for more items once')

  const terms = testNamed(run, 'scrolls the terms to their end, which enables Accept')
  assert.equal(terms.status, 'passed')
  assert.deepEqual(actionsOf(run, terms.name, ['scroll']), [{ command: 'scroll', locator: { by: 'testId', value: 'terms' }, scroll: { x: 0, y: 2000 } }])

  const covered = testNamed(run, 'is not scrolled, and the page hears no wheel')
  assert.deepEqual([covered.status, covered.failure?.class, covered.failure?.details], [
    'failed',
    'not_actionable',
    { check: 'hit-target', covering: '<div class="cover" data-testid="list-cover">', waitedMs: 2000 },
  ])
  assert.deepEqual(afterwards(run, covered.name), [['wheels-heard', '']], 'the page heard no wheel')
})
