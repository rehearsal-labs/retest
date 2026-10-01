import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { ActionIntent, Readiness } from '../../src/browser/element-queries.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { OptionChoiceRecord } from '../../src/protocol/option-choices.ts'
import type { FakePage } from './browser-fake-page.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitUntilActionable } from '../../src/browser/actionability.ts'
import { CdpDisconnectedError } from '../../src/browser/cdp/errors.ts'
import { describeAction, describeChoices } from '../../src/browser/element-queries.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { prepareFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { FakeOption, FakeSelect, fakePage } from './browser-fake-page.ts'
import { functionsCalled, isRecord, protocolError, scriptedPage, scriptedSession, value } from './browser-fixtures.ts'

const facts = { href: 'http://app.test/start?token=1', title: 'Fake page' }

function select(page: FakePage, options: [label: string, value: string][], multiple = false): FakeSelect {
  const element = new FakeSelect(
    page.document,
    options.map(([label, optionValue]) => new FakeOption(page.document, label, optionValue)),
    multiple,
  )
  page.document.atPoint = element
  return element
}

function selected(element: FakeSelect): string[] {
  return element.selectedOptions.map((option) => option.value)
}

// Runs a select's page call on the element: a look, or, with `apply`, the call that makes the selection.
function choose(page: FakePage, element: FakeSelect, choices: OptionChoiceRecord[], options: { multiple?: boolean; apply?: boolean } = {}): Promise<unknown> {
  const intent = { action: 'select', choices, multiple: options.multiple ?? false, apply: options.apply ?? false }
  return Promise.resolve(page.call(prepareFunction, intent, { by: 'elements' }, element))
}

const colours: [string, string][] = [
  ['Red', 'r'],
  ['New  York ', 'ny'],
  ['Green', 'g'],
]

test('a label names an option as a person reads it: whitespace normalised, whole and case-sensitive; a value names it exactly', async () => {
  const page = fakePage()
  const element = select(page, colours)
  const ready = { status: 'ready', point: { x: 50, y: 10 }, token: null, via: null, scale: 1, page: facts }
  assert.deepEqual(await choose(page, element, [{ label: ' New York' }]), ready)
  assert.deepEqual(await choose(page, element, [{ value: 'ny' }]), ready)
  for (const choice of [{ label: 'new york' }, { label: 'New' }, { value: 'NY' }, { value: 'n' }]) {
    assert.deepEqual(await choose(page, element, [choice]), { status: 'option', problem: 'missing', choice: 0, count: 0 }, JSON.stringify(choice))
  }
  assert.deepEqual(selected(element), [], 'looking chose nothing')
  assert.deepEqual(element.dispatched, [], 'and dispatched nothing')
})

test('two options with one label, even one that differs only in spacing, are ambiguous; a disabled one waits', async () => {
  const page = fakePage()
  const twins = select(page, [
    ['Paris', 'fr'],
    [' Paris  ', 'tx'],
    ['Rome', 'it'],
  ])
  assert.deepEqual(await choose(page, twins, [{ label: 'Rome' }, { label: 'Paris' }]), { status: 'option', problem: 'ambiguous', choice: 1, count: 2 })
  const [, , rome] = twins.options
  assert.ok(rome !== undefined)
  rome.disabled = true
  assert.deepEqual(await choose(page, twins, [{ value: 'it' }]), { status: 'option', problem: 'disabled', choice: 0, count: 1 })
  // A choice that names several options fails before one that names none, whatever their order.
  assert.deepEqual(await choose(page, twins, [{ label: 'Oslo' }, { label: 'Paris' }]), { status: 'option', problem: 'ambiguous', choice: 1, count: 2 })
})

test('the call that applies selects the option, then dispatches input and change as the browser does', async () => {
  const page = fakePage()
  const element = select(page, colours)
  assert.deepEqual(await choose(page, element, [{ label: 'Green' }], { apply: true }), { status: 'selected', page: facts })
  assert.deepEqual(selected(element), ['g'])
  assert.deepEqual(element.dispatched, [
    { type: 'input', bubbles: true, composed: true },
    { type: 'change', bubbles: true, composed: false },
  ])
  // A selection that already is the one asked for dispatches nothing.
  assert.deepEqual(await choose(page, element, [{ value: 'g' }], { apply: true }), { status: 'unchanged', page: facts })
  assert.equal(element.dispatched.length, 2)
})

test('a list chooses exactly those options of a select multiple and clears the others; one choice chooses just that one', async () => {
  const page = fakePage()
  const element = select(page, colours, true)
  const [red] = element.options
  assert.ok(red !== undefined)
  red.selected = true
  assert.deepEqual(await choose(page, element, [{ value: 'g' }, { label: 'New York' }], { multiple: true, apply: true }), { status: 'selected', page: facts })
  assert.deepEqual(selected(element), ['ny', 'g'])
  assert.deepEqual(await choose(page, element, [{ value: 'ny' }, { value: 'g' }], { multiple: true, apply: true }), { status: 'unchanged', page: facts })
  assert.deepEqual(await choose(page, element, [{ value: 'r' }], { apply: true }), { status: 'selected', page: facts })
  assert.deepEqual(selected(element), ['r'])
})

test('a list for a select that takes one option, and an element that is not a select, fail at once', async () => {
  const page = fakePage()
  const single = select(page, colours)
  assert.deepEqual(await choose(page, single, [{ value: 'r' }], { multiple: true }), { status: 'unsupported', reason: 'multiple', element: '<select data-testid="select">' })
  const button = page.element('button')
  assert.deepEqual(await Promise.resolve(page.call(prepareFunction, { action: 'select', choices: [{ value: 'r' }], multiple: false, apply: false }, { by: 'elements' }, button)), {
    status: 'unsupported',
    reason: 'select',
    element: '<input data-testid="button">',
  })
})

// A world whose every look answers `readiness`.
function answering(readiness: Readiness): IsolatedWorld {
  const { session } = scriptedSession((method) => {
    if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 })
    if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'document' } })
    if (method === 'Accessibility.queryAXTree') return Promise.resolve({ nodes: [] })
    return value(readiness)
  })
  return new IsolatedWorld(session, () => 'F1')
}

const country: LocatorRecipe = { by: 'label', text: 'Country' }

function intentOf(choices: OptionChoiceRecord[], multiple = false): Extract<ActionIntent, { action: 'select' }> {
  return { action: 'select', choices, multiple, multiline: false }
}

async function failureFor(readiness: Readiness, intent: ActionIntent, budgetMs = 1000) {
  const target = await waitUntilActionable({ world: answering(readiness), locator: country, intent, deadline: new Deadline(budgetMs), pendingNavigation: () => undefined })
  assert.ok(!target.ok, JSON.stringify(target))
  return target.failure
}

test('a select names its choices as the test wrote them: one on its own, a list as a list, even of one', () => {
  assert.equal(describeChoices(intentOf([{ label: 'Canada' }])), "'Canada'")
  assert.equal(describeChoices(intentOf([{ label: 'Canada' }], true)), "['Canada']")
  assert.equal(describeChoices(intentOf([{ value: 'ca' }, { label: 'Peru' }], true)), "[{ value: 'ca' }, 'Peru']")
  assert.equal(describeAction(intentOf([{ label: 'Canada' }]), country), "select 'Canada' in getByLabel('Country')")
})

test('each failure of a select names the choice it was about', async () => {
  const intent = intentOf([{ label: 'Mexico' }, { value: 'ca' }], true)
  const { value: ambiguous, ms } = await timed(failureFor({ status: 'option', problem: 'ambiguous', choice: 1, count: 2 }, intent, 5000))
  assert.deepEqual(ambiguous, {
    class: 'ambiguous',
    message: "Could not select ['Mexico', { value: 'ca' }] in getByLabel('Country'): 2 options match { value: 'ca' }, and each choice must match exactly one. Retest selected nothing.",
    details: { choice: "{ value: 'ca' }", count: 2 },
  })
  assert.ok(ms < 1000, 'ambiguity fails at once')
  assert.deepEqual(await failureFor({ status: 'option', problem: 'missing', choice: 0, count: 0 }, intent, 60), {
    class: 'not_found',
    message: "Could not select ['Mexico', { value: 'ca' }] in getByLabel('Country'): no option matched 'Mexico' within 60 ms.",
    details: { choice: "'Mexico'", waitedMs: 60 },
  })
  assert.deepEqual(await failureFor({ status: 'option', problem: 'disabled', choice: 0, count: 1 }, intent, 60), {
    class: 'not_actionable',
    message: "Could not select ['Mexico', { value: 'ca' }] in getByLabel('Country') within 60 ms: the option 'Mexico' is disabled.",
    details: { check: 'enabled', choice: "'Mexico'", waitedMs: 60 },
  })
  assert.deepEqual(await failureFor({ status: 'unsupported', reason: 'multiple', element: '<select id="country">' }, intent), {
    class: 'usage',
    message: `Could not select ['Mexico', { value: 'ca' }] in getByLabel('Country'): it is <select id="country">, which takes one option, and select() was given a list. Pass one option, not a list.`,
    details: { element: '<select id="country">' },
  })
  assert.deepEqual(await failureFor({ status: 'unsupported', reason: 'select', element: '<div class="picker">' }, intentOf([{ label: 'Mexico' }])), {
    class: 'unsupported',
    message: `Could not select 'Mexico' in getByLabel('Country'): it is <div class="picker">, and select() chooses from a <select> element. Choose from a list the page draws itself with click().`,
    details: { element: '<div class="picker">' },
  })
})

const ready = { status: 'ready', point: { x: 10, y: 20 }, token: null, via: null, scale: 1, page: { href: 'http://app.test/form', title: 'Form' } }
const command: Extract<BrowserCommand, { kind: 'select' }> = { kind: 'select', locator: { by: 'testId', value: 'country' }, choices: [{ label: 'Canada' }] }

// The select calls the page answered, as looks or as the call that applies.
function applies(params: Record<string, unknown>): boolean {
  const [intent] = Array.isArray(params['arguments']) ? params['arguments'] : []
  return isRecord(intent) && isRecord(intent['value']) && intent['value']['apply'] === true
}

test('a select looks until the page is ready, then one more call checks it again and sets it, and sends no input', async () => {
  const { page, sent } = scriptedPage({
    call: (_source, params) => value(applies(params) ? { status: 'selected', page: ready.page } : ready),
  })
  assert.deepEqual(await page.execute(command, 1000), { ok: true, kind: 'select', changed: true, page: { url: 'http://app.test/form', title: 'Form' } })
  assert.deepEqual(functionsCalled(sent), [prepareFunction, prepareFunction])
  assert.equal(sent.filter(({ method }) => method.startsWith('Input.')).length, 0)
})

test('a select already as asked passes unchanged, and one the page moved looks again', async () => {
  const unchanged = scriptedPage({ call: () => value({ status: 'unchanged', page: ready.page }) })
  assert.deepEqual(await unchanged.page.execute(command, 1000), { ok: true, kind: 'select', changed: false, page: { url: 'http://app.test/form', title: 'Form' } })
  assert.equal(functionsCalled(unchanged.sent).length, 1, 'a look that finds it so applies nothing')
  let applied = 0
  const moved = scriptedPage({
    call: (_source, params) => {
      if (!applies(params)) return value(ready)
      applied += 1
      return value(applied === 1 ? { status: 'blocked', check: 'stable', detail: null } : { status: 'selected', page: ready.page })
    },
  })
  assert.deepEqual(await moved.page.execute(command, 1000), { ok: true, kind: 'select', changed: true, page: { url: 'http://app.test/form', title: 'Form' } })
  assert.deepEqual(functionsCalled(moved.sent).length, 4)
})

test('a call that never ran, because its document had gone, is looked at again and counts as no input', async () => {
  let applied = 0
  const { page } = scriptedPage({
    call: (_source, params) => {
      if (!applies(params)) return value(ready)
      applied += 1
      if (applied === 1) return Promise.reject(protocolError('Runtime.callFunctionOn', 'Cannot find context with specified id'))
      return value({ status: 'selected', page: ready.page })
    },
  })
  assert.deepEqual(await page.execute(command, 1000), { ok: true, kind: 'select', changed: true, page: { url: 'http://app.test/form', title: 'Form' } })
})

test('a document that went away while the call ran leaves the outcome unknown', async () => {
  const { page } = scriptedPage({
    call: (_source, params) => (applies(params) ? Promise.reject(protocolError('Runtime.callFunctionOn', 'Execution context was destroyed.')) : value(ready)),
  })
  assert.deepEqual(await page.execute(command, 1000), {
    ok: false,
    failure: {
      class: 'outcome_unknown',
      message: "The page moved to a new document while Retest tried to select 'Canada' in getByTestId('country'), so Retest cannot tell whether the select took effect.",
      details: { reason: 'the page moved to a new document' },
    },
  })
})

test('an answer lost to a closed connection is outcome_unknown on the call that applies, and a lost look sent nothing', async () => {
  const lost = new CdpDisconnectedError({ method: 'Runtime.callFunctionOn', sessionId: 'S1' }, { reason: 'the browser closed the pipe', written: true })
  const applying = scriptedPage({ call: (_source, params) => (applies(params) ? Promise.reject(lost) : value(ready)) })
  const unknown = await applying.page.execute(command, 1000)
  assert.ok(!unknown.ok && unknown.failure.class === 'outcome_unknown', JSON.stringify(unknown))
  const looking = scriptedPage({ call: () => Promise.reject(lost) })
  const failed = await looking.page.execute(command, 1000)
  assert.ok(!failed.ok && failed.failure.class === 'session_lost', JSON.stringify(failed))
})

test('an empty list is usage, before the page is asked anything', async () => {
  const { page, sent } = scriptedPage({ call: () => value(ready) })
  const result = await page.execute({ ...command, choices: [] }, 1000)
  assert.deepEqual(result, { ok: false, failure: { class: 'usage', message: 'select() needs at least one option, received an empty list.' } })
  assert.deepEqual(sent, [])
})

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  return { value: await work, ms: performance.now() - start }
}
