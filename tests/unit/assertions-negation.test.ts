import type { ObservedItem, PageObservation } from '../../src/protocol/commands.ts'
import type { LocatorCheckRecord } from '../../src/protocol/locator-checks.ts'
import type { Responder } from '../support/api/in-process-run.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { expect } from '../../src/index.ts'
import { checkRecordSchema, locatorCheck, pageAddress, pageCheck } from '../../src/protocol/locator-checks.ts'
import { textPatternOf } from '../../src/protocol/locator.ts'
import { parse } from '../../src/protocol/schema.ts'
import { originAndPath } from '../../src/browser/page-url.ts'
import { callLoosely } from '../support/api/call-loosely.ts'
import { inProcessRun } from '../support/api/in-process-run.ts'
import { observationOf } from '../support/observation.ts'

const file = 'tests/unit/assertions-negation.test.ts'
const locator = "getByLabel('Agree')"
const one = (text: string, visible = true): ObservedItem[] => [{ text, visible }]
const none = observationOf([])
const two = observationOf([...one('a'), ...one('b')])

function check(record: LocatorCheckRecord) {
  return { plain: locatorCheck(record), negated: locatorCheck({ ...record, not: true }) }
}

describe('locator checks and their negations', () => {
  test('toBeChecked reads a checkable control, and a negation passes only on one that shows unchecked', () => {
    const { plain, negated } = check({ matcher: 'toBeChecked' })
    const ticked = observationOf(one('Agree'), null, { checked: true })
    const unticked = observationOf(one('Agree'), null, { checked: false })
    const plainText = observationOf(one('Agree'))
    assert.deepEqual([plain.passes(ticked), plain.passes(unticked), plain.passes(plainText), plain.passes(none)], [true, false, false, false])
    assert.deepEqual([negated.passes(ticked), negated.passes(unticked), negated.passes(plainText), negated.passes(none), negated.passes(two)], [false, true, false, false, false])
    assert.equal(negated.matcher, 'not.toBeChecked')
    assert.equal(negated.expected, 'unchecked')
    assert.equal(plain.mismatch(unticked, locator), `${locator} is unchecked.`)
    assert.equal(negated.mismatch(ticked, locator), `${locator} is checked.`)
    assert.equal(negated.mismatch(plainText, locator), `${locator} is not a checkbox, a radio button or an element with a checkable role.`)
    assert.equal(plain.actual(plainText), null)
  })

  test('toBeEnabled and toBeDisabled read the one match, and each negation is the other, never on no element', () => {
    const enabled = observationOf(one('Save'), null, { enabled: true })
    const disabled = observationOf(one('Save'), null, { enabled: false })
    const on = check({ matcher: 'toBeEnabled' })
    const off = check({ matcher: 'toBeDisabled' })
    assert.deepEqual([on.plain.passes(enabled), on.plain.passes(disabled), on.negated.passes(disabled), on.negated.passes(none)], [true, false, true, false])
    assert.deepEqual([off.plain.passes(disabled), off.plain.passes(enabled), off.negated.passes(enabled), off.negated.passes(none)], [true, false, true, false])
    assert.equal(off.plain.mismatch(enabled, locator), `${locator} is enabled.`)
    assert.equal(off.plain.actual(disabled), 'disabled')
  })

  test('not.toBeVisible passes on a hidden match or on none, as Playwright documents, and fails on several', () => {
    const { negated } = check({ matcher: 'toBeVisible' })
    assert.equal(negated.passes(none), true)
    assert.equal(negated.passes(observationOf(one('x', false))), true)
    assert.equal(negated.passes(observationOf(one('x'))), false)
    assert.equal(negated.passes(two), false)
    assert.equal(negated.single, true, 'several matches are ambiguous, not a pass')
    assert.equal(negated.mismatch(observationOf(one('x')), locator), `${locator} is visible.`)
  })

  test('not.toBeHidden passes once the one match is visible, never on none, and several fail as ambiguous', () => {
    const { negated } = check({ matcher: 'toBeHidden' })
    assert.equal(negated.passes(none), false)
    assert.equal(negated.passes(observationOf(one('x', false))), false)
    assert.equal(negated.passes(observationOf(one('x'))), true)
    assert.equal(negated.passes(observationOf([...one('a', false), ...one('b')])), false, 'one visible of several is not a pass')
    assert.equal(negated.passes(two), false)
    assert.equal(negated.single, true)
    assert.equal(negated.matcher, 'not.toBeHidden')
    assert.equal(negated.mismatch(observationOf(one('x', false)), locator), `${locator} is hidden.`)
  })

  test('text checks: regex, contains, and negations that pass only on text that shows the opposite', () => {
    const saved = observationOf(one('  Saved   3 tasks '))
    assert.equal(locatorCheck({ matcher: 'toHaveText', pattern: { pattern: '^Saved \\d tasks$', flags: '' } }).passes(saved), true, 'the pattern reads the trimmed text')
    assert.equal(locatorCheck({ matcher: 'toHaveText', pattern: { pattern: '^saved', flags: '' } }).passes(saved), false)
    assert.equal(locatorCheck({ matcher: 'toHaveText', pattern: { pattern: '^saved', flags: 'i' } }).passes(saved), true)
    const contains = check({ matcher: 'toContainText', text: 'Saved 3' })
    assert.deepEqual([contains.plain.passes(saved), contains.negated.passes(saved), contains.negated.passes(none)], [true, false, false])
    assert.equal(locatorCheck({ matcher: 'toContainText', text: 'saved' }).passes(saved), false, 'case counts')
    const whole = check({ matcher: 'toHaveText', text: 'Saved' })
    assert.deepEqual([whole.negated.passes(saved), whole.negated.passes(observationOf(one('Saved'))), whole.negated.passes(none)], [true, false, false])
    assert.equal(whole.negated.mismatch(observationOf(one('Saved')), locator), `${locator} has text "Saved", expected any other text. Compared whole text, ends trimmed, each run of spaces or line breaks read as one space.`)
    assert.equal(contains.plain.expected, 'Saved 3')
    assert.equal(locatorCheck({ matcher: 'toContainText', pattern: { pattern: 'tasks?', flags: 'g' } }).expected, '/tasks?/g')
  })

  test('a list of texts takes patterns, and its negation passes on another count or a text that differs, never when unsure', () => {
    const list = check({ matcher: 'toHaveText', texts: ['One', { pattern: '^Tw', flags: '' }] })
    assert.equal(list.plain.passes(observationOf([...one('One'), ...one('Two')])), true)
    assert.equal(list.plain.expected, '["One",/^Tw/]')
    assert.equal(list.negated.passes(observationOf([...one('One'), ...one('Two')])), false)
    assert.equal(list.negated.passes(observationOf(one('One'))), true)
    assert.equal(list.negated.passes(none), true, 'no element is another count')
    assert.equal(list.negated.passes(observationOf([...one('One'), ...one('Three')])), true)
  })

  test('value checks take a pattern on the value as it is, and negations need a field', () => {
    const field = observationOf(one(''), 'Release 2')
    const value = check({ matcher: 'toHaveValue', pattern: { pattern: 'release \\d', flags: 'i' } })
    assert.deepEqual([value.plain.passes(field), value.negated.passes(field)], [true, false])
    const exact = check({ matcher: 'toHaveValue', value: 'Release' })
    assert.deepEqual([exact.negated.passes(field), exact.negated.passes(observationOf(one('x')))], [true, false])
    assert.equal(exact.negated.mismatch(observationOf(one('x')), locator), `${locator} is not a field with a value.`)
  })

  test('not.toHaveCount passes on any other number, none included', () => {
    const { negated } = check({ matcher: 'toHaveCount', count: 2 })
    assert.deepEqual([negated.passes(two), negated.passes(none), negated.passes(observationOf(one('a')))], [false, true, true])
  })

  test('every check record, negated or not, has a schema, and an old flat record still reads', () => {
    for (const record of [
      { matcher: 'toBeVisible' },
      { matcher: 'toHaveText', text: 'x', not: true },
      { matcher: 'toHaveText', texts: ['a', { pattern: 'b', flags: 'i' }] },
      { matcher: 'toContainText', pattern: { pattern: 'x', flags: '' } },
      { matcher: 'toBeDisabled', not: true },
      { matcher: 'toHaveURL', url: '/tasks' },
      { matcher: 'toHaveTitle', pattern: { pattern: 'Tasks', flags: '' }, not: true },
    ]) {
      assert.equal(parse(checkRecordSchema, record).ok, true, JSON.stringify(record))
    }
    assert.equal(parse(checkRecordSchema, { matcher: 'toBeVisible', not: false }).ok, false, 'not is written only as true')
  })
})

describe('page checks', () => {
  const at = (url: string | null, title: string | null, baseUrl?: string): PageObservation & { baseUrl?: string } => ({ url, title, ...(baseUrl === undefined ? {} : { baseUrl }) })

  test('toHaveURL compares the whole address, query and fragment included, resolving a relative URL against the base URL', () => {
    const tasks = pageCheck({ matcher: 'toHaveURL', url: '/tasks' })
    const base = 'http://127.0.0.1:4173/'
    assert.equal(tasks.passes(at('http://127.0.0.1:4173/tasks', 'Tasks', base)), true)
    assert.equal(tasks.passes(at('http://127.0.0.1:4173/tasks?x=1', 'Tasks', base)), false, 'a query makes another address, as Playwright compares it')
    assert.equal(tasks.passes(at('http://127.0.0.1:4173/tasks#top', 'Tasks', base)), false, 'so does a fragment')
    assert.equal(pageCheck({ matcher: 'toHaveURL', url: '/tasks?x=1#top' }).passes(at('http://127.0.0.1:4173/tasks?x=1#top', 'Tasks', base)), true)
    assert.equal(tasks.mismatch(at('http://127.0.0.1:4173/tasks?x=1', 'Tasks', base)), 'The page is at "http://127.0.0.1:4173/tasks?x=1", expected "http://127.0.0.1:4173/tasks".')
    assert.equal(tasks.passes(at('http://evil.test/tasks', 'Tasks', 'http://127.0.0.1:4173/')), false, 'another origin is another address')
    assert.equal(tasks.passes(at('http://127.0.0.1:4173/tasks', 'Tasks')), false, 'no base URL, no relative address')
    assert.equal(tasks.mismatch(at('http://127.0.0.1:4173/tasks', 'Tasks')), `"/tasks" is not a full URL, and the app has no base URL to resolve it against.`)
    const full = pageCheck({ matcher: 'toHaveURL', url: 'http://127.0.0.1:4173/tasks' })
    assert.equal(full.passes(at('http://127.0.0.1:4173/tasks', null)), true)
    assert.equal(full.mismatch(at('http://127.0.0.1:4173/done', null)), 'The page is at "http://127.0.0.1:4173/done", expected "http://127.0.0.1:4173/tasks".')
    const negated = pageCheck({ matcher: 'toHaveURL', url: '/login', not: true })
    assert.deepEqual([negated.passes(at('http://127.0.0.1:4173/tasks', '', 'http://127.0.0.1:4173')), negated.passes(at(null, null, 'http://127.0.0.1:4173'))], [true, false])
  })

  test('toHaveURL with a pattern searches the whole address', () => {
    const pattern = pageCheck({ matcher: 'toHaveURL', pattern: textPatternOf(/\/tasks\/\d+$/) })
    assert.equal(pattern.passes(at('http://127.0.0.1:4173/tasks/12', null)), true)
    assert.equal(pattern.passes(at('http://127.0.0.1:4173/tasks/12/edit', null)), false)
    assert.equal(pattern.passes(at('http://127.0.0.1:4173/tasks/12?tab=notes', null)), false, 'the query is part of what $ ends')
    assert.equal(pattern.expected, '/\\/tasks\\/\\d+$/')
    const noError = pageCheck({ matcher: 'toHaveURL', pattern: textPatternOf(/[?&]error=/), not: true })
    assert.equal(noError.passes(at('http://127.0.0.1:4173/login?error=1', null)), false, 'a negation sees the query')
    assert.equal(noError.passes(at('http://127.0.0.1:4173/login', null)), true)
  })

  test('a part the page held more of than Retest read passes neither way, and a negation on a part with a placeholder fails, saying it could not judge', () => {
    const title = 'Report '.repeat(10)
    const cut = { ...at('http://x/', title), cut: ['title' as const] }
    const same = pageCheck({ matcher: 'toHaveTitle', title })
    const other = pageCheck({ matcher: 'toHaveTitle', title, not: true })
    assert.deepEqual([same.passes(cut), other.passes(cut)], [false, false])
    assert.equal(other.mismatch(cut), "The page's title is longer than the 65536 characters Retest reads, so Retest could not judge it.")
    assert.equal(pageCheck({ matcher: 'toHaveURL', url: 'http://x/' }).passes(cut), true, 'only the part it compares counts')
    const hidden = { ...at('http://x/reset?token={{token}}', 'Reset'), hidden: ['url' as const] }
    const notReset = pageCheck({ matcher: 'toHaveURL', pattern: textPatternOf(/token=abc/), not: true })
    assert.equal(notReset.passes(hidden), false)
    assert.equal(notReset.mismatch(hidden), "The page's address holds a secret Retest hides, so Retest could not judge that it is not the one expected.")
    assert.equal(pageCheck({ matcher: 'toHaveURL', pattern: textPatternOf(/\/reset\?/) }).passes(hidden), true, 'a positive check reads the redacted address')
  })

  test('toHaveTitle normalises spaces, and a title not read yet passes neither way', () => {
    const plain = pageCheck({ matcher: 'toHaveTitle', title: 'Tasks  list' })
    const negated = pageCheck({ matcher: 'toHaveTitle', title: 'Login', not: true })
    assert.deepEqual([plain.passes(at('http://x/', ' Tasks list ')), plain.passes(at('http://x/', null)), negated.passes(at('http://x/', null)), negated.passes(at('http://x/', ''))], [true, false, false, true])
    assert.equal(plain.mismatch(at('http://x/', null)), 'The page was opening another document, so Retest could not read its title.')
    assert.equal(pageCheck({ matcher: 'toHaveTitle', pattern: { pattern: '^Tas', flags: '' } }).passes(at('http://x/', 'Tasks')), true)
  })

  test("the address page.url() gives is the one the browser records for the page's own address", () => {
    for (const address of ['https://app.test/tasks?page=2#top', 'http://ada:secret@127.0.0.1:4173/a/b/', 'about:blank', 'file:///tmp/x.html', 'data:text/html,hi']) {
      const url = new URL(address)
      assert.equal(pageAddress(url), originAndPath(url), address)
    }
  })
})

/** A page whose one locator match is this element, whose page is at `url` with `title`, and whose base URL is the task app's. */
function page(items: readonly ObservedItem[], state: { checked?: boolean; enabled?: boolean } = {}, url = 'http://127.0.0.1:4173/tasks', title: string | null = 'Tasks'): Responder {
  return (command) => {
    if (command.kind === 'observe') return { ok: true, kind: 'observe', observation: observationOf(items, null, state) }
    if (command.kind === 'observePage') return { ok: true, kind: 'observePage', observation: { url, title }, baseUrl: 'http://127.0.0.1:4173/' }
    return { ok: true, kind: 'click' }
  }
}

describe('matchers in a test', () => {
  test('a negated matcher sends its check with not, names itself not.matcher, and passes on the opposite', async () => {
    const run = inProcessRun(file, page([]), { timeouts: { assertion: 200 } })
    const verdict = await run.runPage(async ({ page: handle }) => {
      await expect(handle.getByRole('dialog')).not.toBeVisible()
      await expect.soft(handle.getByRole('dialog')).not.toHaveCount(1)
    })
    assert.equal(verdict.status, 'passed')
    const passed = run.events().filter((event) => event.type === 'assertion.passed')
    assert.deepEqual(
      passed.map((event) => [event.matcher, event.check]),
      [
        ['not.toBeVisible', { matcher: 'toBeVisible', not: true }],
        ['not.toHaveCount', { matcher: 'toHaveCount', count: 1, not: true }],
      ],
    )
  })

  test('a negated matcher on a missing element fails as not found, after looking until its time is up', async () => {
    const run = inProcessRun(file, page([]), { timeouts: { assertion: 120 } })
    const verdict = await run.runPage(({ page: handle }) => expect(handle.getByLabel('Agree')).not.toBeChecked())
    assert.equal(verdict.failure?.class, 'not_found')
    assert.match(verdict.failure?.message ?? '', /^getByLabel\('Agree'\) matched no element\. Looked \d+ times in 120 ms\.$/)
  })

  test('toBeChecked, toBeEnabled and toBeDisabled pass on what the look read, and fail naming it', async () => {
    const ticked = inProcessRun(file, page(one('Agree'), { checked: true, enabled: false }), { timeouts: { assertion: 120 } })
    assert.equal((await ticked.runPage(async ({ page: handle }) => {
      await expect(handle.getByLabel('Agree')).toBeChecked()
      await expect(handle.getByLabel('Agree')).toBeDisabled()
      await expect(handle.getByLabel('Agree')).not.toBeEnabled()
    })).status, 'passed')
    const failing = inProcessRun(file, page(one('Agree'), { checked: false }), { timeouts: { assertion: 120 } })
    const verdict = await failing.runPage(({ page: handle }) => expect(handle.getByLabel('Agree')).toBeChecked())
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.match(verdict.failure?.message ?? '', /^getByLabel\('Agree'\) is unchecked\. Looked \d+ times in 120 ms\.$/)
  })

  test('a timeout of its own shortens the assertion budget, and a longer one is cut to it', async () => {
    const run = inProcessRun(file, page(one('Draft')), { timeouts: { assertion: 400 } })
    await run.runPage(async ({ page: handle }) => {
      await expect.soft(handle.getByTestId('state')).toHaveText('Saved', { timeout: 100 })
      await expect.soft(handle.getByTestId('state')).toHaveText('Saved', { timeout: 60_000 })
    })
    const failed = run.events().flatMap((event) => (event.type === 'assertion.failed' ? [event.timeoutMs] : []))
    assert.deepEqual(failed, [100, 400])
  })

  test('page matchers look at the page and judge its address and title', async () => {
    const run = inProcessRun(file, page([]), { timeouts: { assertion: 150 } })
    const verdict = await run.runPage(async ({ page: handle }) => {
      await expect(handle).toHaveURL('/tasks')
      await expect(handle).toHaveURL(/\/tasks$/)
      await expect(handle).toHaveTitle('Tasks')
      await expect(handle).not.toHaveURL('/login')
      await expect.soft(handle).toHaveTitle(/^Login/)
    })
    assert.equal(verdict.failure?.class, 'check_failed')
    assert.match(verdict.failure?.message ?? '', /^The page's title is "Tasks", expected it to match \/\^Login\/\. Looked \d+ times in 150 ms\.$/)
    const events = run.events().filter((event) => event.type === 'assertion.passed' || event.type === 'assertion.failed')
    // Run in this process, no parent serves the looks, so the events name no look; the parent's own tests cover that.
    assert.deepEqual(events.map((event) => [event.type, event.matcher, event.locator, event.check?.matcher]), [
      ['assertion.passed', 'toHaveURL', undefined, 'toHaveURL'],
      ['assertion.passed', 'toHaveURL', undefined, 'toHaveURL'],
      ['assertion.passed', 'toHaveTitle', undefined, 'toHaveTitle'],
      ['assertion.passed', 'not.toHaveURL', undefined, 'toHaveURL'],
      ['assertion.failed', 'toHaveTitle', undefined, 'toHaveTitle'],
    ])
    assert.ok(run.commands.every((command) => command.kind === 'observePage'), 'page matchers only look')
  })

  test('page and negated matchers refuse what they cannot compare, and look at nothing', async () => {
    const cases: [string, (handle: Parameters<Parameters<ReturnType<typeof inProcessRun>['runPage']>[0]>[0]['page']) => unknown, string][] = [
      ['an empty URL', (handle) => expect(handle).toHaveURL(' '), "toHaveURL() takes the address as a string, such as '/tasks', or a RegExp, received ' '."],
      ['a title that is a number', (handle) => callLoosely(expect(handle), 'toHaveTitle', [3]), 'toHaveTitle() takes the title as a string or a RegExp, received 3.'],
      ['options with more than a timeout', (handle) => callLoosely(expect(handle.getByRole('dialog')), 'toBeVisible', [{ timeout: 10, ignoreCase: true }]), "toBeVisible() takes options such as { timeout: 2000 }, in milliseconds, received { timeout: 10, ignoreCase: true }. Its only option is timeout."],
      ['a timeout that is not whole', (handle) => callLoosely(expect(handle.getByRole('dialog')), 'toBeVisible', [{ timeout: 1.5 }]), 'The timeout option of toBeVisible() must be a whole number of milliseconds from 1 to 2147483647, received 1.5.'],
      ['not on a value', (handle) => Reflect.get(expect(handle.url), 'not'), '.not is for locator and page matchers. Write the value matcher that says what you expect.'],
    ]
    for (const [what, call, message] of cases) {
      const run = inProcessRun(file, page([]))
      const verdict = await run.runPage(({ page: handle }) => call(handle))
      assert.equal(verdict.failure?.class, 'usage', what)
      assert.equal(verdict.failure?.message, message, what)
      assert.deepEqual(run.commands, [], what)
    }
    const twice = inProcessRun(file, page([]))
    const verdict = await twice.runPage(({ page: handle }) => Reflect.get(Reflect.get(expect(handle.getByRole('dialog')), 'not'), 'not'))
    assert.equal(verdict.failure?.message, '.not is written once.')
  })
})
