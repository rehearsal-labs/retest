import type { FinishedRun } from './cli-harness.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openApp } from './browser-harness.ts'
import { assertStdoutIsEvents, budgets, eventsOf, runRetest, scenario, testNamed } from './cli-harness.ts'

// The lookup scenario against real Chrome and the task app: scoped locators, picks, CSS, placeholders and patterns,
// the state matchers and their negations, reload, back and forward, page matchers, hover and shortcuts. Every locator
// and page assertion that passed is the parent's own judgement of the look it names.

function outcome(run: FinishedRun, name: string): [string, string | undefined, string | undefined] {
  const found = testNamed(run, name)
  return [found.status, found.failure?.class, found.failure?.message]
}

function durationOf(run: FinishedRun, name: string, type: 'action.failed' | 'assertion.failed'): number {
  const { testId } = testNamed(run, name)
  const [event] = eventsOf(run.events, type).filter((each) => each.testId === testId)
  return event?.durationMs ?? Number.POSITIVE_INFINITY
}

test('scoped locators, picks, CSS, placeholders, patterns, state and page matchers, history, hover and shortcuts, against real Chrome', async (t) => {
  const app = await openApp(t)
  const run = await runRetest(t, { files: [scenario('lookup')], baseUrl: app.url, timeouts: budgets({ action: 1500, assertion: 1500 }) })
  assertStdoutIsEvents(run)
  assert.equal(run.exit.code, 1, run.stderr)

  for (const name of [
    'scoped lookups find inside a list, and picks choose among its matches',
    'CSS, placeholders and patterns find elements, and a step never finds the elements it looks inside',
    'state matchers and their negations pass on what the page shows',
    'reload, back and forward move through the history, and the page reads its address and title',
    'hover moves the mouse onto an element, again at the same place, and onto a disabled one',
    'shortcuts hold their modifiers, and the editing ones edit',
    'toHaveURL compares the whole address, query and fragment included, and page.url() reads origin and path',
  ]) {
    const [status, kind, message] = outcome(run, name)
    assert.equal(status, 'passed', `${name}: ${kind} ${message}`)
  }

  // Every locator and page assertion that passed rests on a look the parent served and judged again.
  const passed = eventsOf(run.events, 'assertion.passed')
  const looked = passed.filter((event) => event.locator !== undefined || event.matcher.endsWith('URL') || event.matcher.endsWith('Title'))
  assert.ok(looked.length > 40, `${looked.length} looking assertions`)
  for (const event of passed.filter((each) => each.matcher !== 'toBe' && each.matcher !== 'toMatch')) {
    assert.equal(event.judgedBy, 'parent', `${event.matcher} on ${JSON.stringify(event.locator)}`)
    assert.match(event.observationId ?? '', /^o\d+$/, event.matcher)
  }
  const matchers = new Set(passed.map((event) => event.matcher))
  for (const matcher of ['toBeChecked', 'not.toBeChecked', 'toBeEnabled', 'not.toBeEnabled', 'toBeDisabled', 'toContainText', 'not.toHaveText', 'not.toBeVisible', 'not.toBeHidden', 'not.toHaveCount', 'toHaveURL', 'not.toHaveURL', 'toHaveTitle']) {
    assert.ok(matchers.has(matcher), `${matcher} passed somewhere`)
  }
  const pageLook = passed.find((event) => event.matcher === 'toHaveTitle')
  assert.deepEqual([pageLook?.locator, pageLook?.pageUrl, pageLook?.actual?.text], [undefined, `${app.url}/lookup/history/one`, 'One'])

  // Actions on chains record the whole chain as their locator, and describe it as the test wrote it.
  const clicks = eventsOf(run.events, 'action.completed').filter((event) => event.command === 'click' && event.locator?.within !== undefined)
  assert.deepEqual(clicks[0]?.locator, { by: 'role', role: 'button', name: 'Delete', pick: 1, within: [{ by: 'testId', value: 'inbox' }] })

  assert.deepEqual(outcome(run, 'a scoped click that matches several elements is ambiguous'), [
    'failed',
    'ambiguous',
    "Could not click getByTestId('inbox').getByRole('button', { name: 'Delete' }): it matches 3 elements, and a locator must match exactly one. Retest did not click any of them.",
  ])
  assert.deepEqual(outcome(run, 'a click whose outer step matches nothing names that step'), [
    'failed',
    'not_found',
    "Could not click getByTestId('trash').getByRole('button'): no element matched within 1500 ms. getByTestId('trash') matched no element.",
  ])
  assert.deepEqual(outcome(run, 'a click whose index is past the matches says how many there were'), [
    'failed',
    'not_found',
    "Could not click getByRole('listitem').nth(9): no element matched within 1500 ms. getByRole('listitem') matched 4 elements, and nth(9) keeps none of them.",
  ])
  const [invalidStatus, invalidKind, invalidMessage] = outcome(run, 'a CSS selector the page cannot read fails at once')
  assert.deepEqual([invalidStatus, invalidKind], ['failed', 'usage'])
  assert.match(invalidMessage ?? '', /^Could not click locator\('li:no-such-thing'\): the page cannot read the CSS selector in locator\('li:no-such-thing'\)\. .*not a valid selector/)
  assert.ok(durationOf(run, 'a CSS selector the page cannot read fails at once', 'action.failed') < 1000, 'it fails at once')
  const [stepStatus, stepKind, stepMessage] = outcome(run, 'an assertion whose outer step matches nothing names that step')
  assert.deepEqual([stepStatus, stepKind], ['failed', 'not_found'])
  assert.match(stepMessage ?? '', /^getByTestId\('trash'\)\.getByRole\('button'\) matched no element\. getByTestId\('trash'\) matched no element\. Looked \d+ times in 1500 ms\.$/)

  const states: [string, string, RegExp][] = [
    ['toBeChecked fails on an unchecked box', 'check_failed', /^getByTestId\('newsletter'\) is unchecked\. Looked/],
    ['toBeChecked fails on what cannot be checked', 'check_failed', /^getByTestId\('status'\) is not a checkbox, a radio button or an element with a checkable role\./],
    ['toBeDisabled fails on an enabled button within its own shorter timeout', 'check_failed', /^getByTestId\('save'\) is enabled\. Looked \d+ times in 300 ms\.$/],
    ['a negation never passes on a missing element', 'not_found', /^getByTestId\('missing'\) matched no element\./],
    ['a negation fails on what shows the condition true', 'check_failed', /^getByTestId\('status'\) has text "Saved   3 tasks", which contains "3 tasks", expected it not to\./],
    ['a negation of a single-element matcher is ambiguous on several matches', 'ambiguous', /matched 4 elements, and not\.toBeChecked needs exactly one/],
  ]
  for (const [name, kind, message] of states) {
    const [status, failed, text] = outcome(run, name)
    assert.deepEqual([status, failed], ['failed', kind], name)
    assert.match(text ?? '', message, name)
  }
  const shortened = eventsOf(run.events, 'assertion.failed').find((event) => event.testId === testNamed(run, 'toBeDisabled fails on an enabled button within its own shorter timeout').testId)
  assert.equal(shortened?.timeoutMs, 300)

  assert.deepEqual(outcome(run, 'goBack with no earlier entry fails and sends nothing'), [
    'failed',
    'not_actionable',
    'Could not go back: the page has no earlier entry in its history, so Retest sent nothing.',
  ])
  const [urlStatus, urlKind, urlMessage] = outcome(run, 'toHaveURL fails naming both addresses')
  assert.deepEqual([urlStatus, urlKind], ['failed', 'check_failed'])
  assert.equal(urlMessage?.replace(/Looked \d+ times/, 'Looked n times'), `The page is at "${app.url}/lookup/history/one", expected "${app.url}/lookup/history/two". Looked n times in 300 ms.`)
  const [titleStatus, titleKind, titleMessage] = outcome(run, 'toHaveTitle fails naming the title')
  assert.deepEqual([titleStatus, titleKind], ['failed', 'check_failed'])
  assert.match(titleMessage ?? '', /^The page's title is "One", which matches \/\^On\/, expected it not to\./)
  const [queryStatus, queryKind, queryMessage] = outcome(run, 'a negation of toHaveURL sees the query')
  assert.deepEqual([queryStatus, queryKind], ['failed', 'check_failed'])
  assert.match(queryMessage ?? '', new RegExp(`^The page is at "${app.url}/lookup/find\\?error=1", which matches /\\[\\?&\\]error=/, expected it not to\\.`))
  const [longStatus, longKind, longMessage] = outcome(run, 'a title longer than Retest records is compared whole, both ways')
  assert.deepEqual([longStatus, longKind], ['failed', 'check_failed'], 'the whole title passed toHaveTitle, so its negation fails')
  assert.match(longMessage ?? '', /^The page's title is "Quarterly report Quarterly report .*, expected any other title\./)
  const wholeUrl = eventsOf(run.events, 'assertion.passed').find((event) => event.matcher === 'toHaveURL' && event.pageUrl?.includes('?tab=notes') === true)
  assert.equal(wholeUrl?.pageUrl, `${app.url}/lookup/find?tab=notes#top`, 'a page assertion records the whole address it judged')

  const covered = testNamed(run, 'does not move onto a covered element')
  assert.deepEqual([covered.status, covered.failure?.class, covered.failure?.details], [
    'failed',
    'not_actionable',
    { check: 'hit-target', covering: '<span class="cover" data-testid="cover">', waitedMs: 1500 },
  ])

  const reloads = eventsOf(run.events, 'action.completed').filter((event) => ['reload', 'goBack', 'goForward', 'hover'].includes(event.command))
  assert.deepEqual(reloads.map((event) => event.command), ['goBack', 'goForward', 'goBack', 'reload', 'hover', 'hover', 'hover'])
  const navigations = eventsOf(run.events, 'navigation').filter((event) => event.testId === testNamed(run, 'reload, back and forward move through the history, and the page reads its address and title').testId)
  assert.ok(navigations.filter((event) => event.cause === 'goto').length >= 5, 'goto, back, forward and reload each opened a page as the test asked')
})
