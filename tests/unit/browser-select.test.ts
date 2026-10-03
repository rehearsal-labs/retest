import type { SentCommand } from './browser-fixtures.ts'
import type { BrowserCommand } from '../../src/browser/contract.ts'
import type { ActionIntent, Readiness } from '../../src/browser/element-queries.ts'
import type { CommandResult } from '../../src/protocol/commands.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { OptionChoiceRecord } from '../../src/protocol/option-choices.ts'
import type { FakePage } from './browser-fake-page.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitUntilActionable } from '../../src/browser/actionability.ts'
import { CdpDisconnectedError } from '../../src/browser/cdp/errors.ts'
import { describeAction, describeChoices } from '../../src/browser/element-queries.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { disarmFunction, prepareFunction, selectionFunction, setOffFunction, verdictFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { FakeOption, FakeSelect, fakePage, oneElement } from './browser-fake-page.ts'
import { functionsCalled, isRecord, never, scriptedPage, scriptedSession, value } from './browser-fixtures.ts'

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

// Runs a select's look on the element, which checks it and plans the keys that choose the options.
function choose(page: FakePage, element: FakeSelect, choices: OptionChoiceRecord[], multiple = false): Promise<unknown> {
  const intent = { action: 'select', choices, multiple }
  return Promise.resolve(page.call(prepareFunction, intent, oneElement, element))
}

function typed(...keys: string[]) {
  return { quietMs: 0, keys: keys.map((key) => ({ key, toggle: false })) }
}

function toggled(...keys: string[]) {
  return { quietMs: 0, keys: keys.map((key) => ({ key, toggle: true })) }
}

const colours: [string, string][] = [
  ['Red', 'r'],
  ['New  York ', 'ny'],
  ['Green', 'g'],
]

const readyFor = (plan: unknown) => ({ status: 'ready', point: { x: 50, y: 10 }, token: null, via: null, scale: 1, page: facts, plan })

test('a label names an option as a person reads it: whitespace normalised, whole and case-sensitive; a value names it exactly', async () => {
  const page = fakePage()
  const element = select(page, colours)
  assert.deepEqual(await choose(page, element, [{ label: ' New York' }]), readyFor(typed('n')))
  assert.deepEqual(await choose(page, element, [{ value: 'ny' }]), readyFor(typed('n')))
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

// Chrome jumps to the next option after the chosen one whose label starts with the key, case aside; with more keys
// typed within a second it looks from the chosen one for the whole start typed; a key typed again moves on.
test('a select that takes one option plans the shortest start of the label that lands on it, as Chrome reads typed keys', async () => {
  const page = fakePage()
  const countries = select(page, [
    ['Choose a country', ''],
    ['Canada', 'ca'],
    ['Chile', 'cl'],
    ['China', 'cn'],
    ['  Mexico', 'mx'],
  ])
  const [choose0] = countries.options
  assert.ok(choose0 !== undefined)
  choose0.selected = true
  assert.deepEqual((await choose(page, countries, [{ label: 'Canada' }])) as unknown, readyFor(typed('c')), 'the first C after the chosen option')
  assert.deepEqual(await choose(page, countries, [{ label: 'Chile' }]), readyFor(typed('c', 'h')), 'C lands on Canada, then Ch on Chile')
  assert.deepEqual(await choose(page, countries, [{ label: 'China' }]), readyFor(typed('c', 'h', 'i', 'n')), 'Chi is still Chile, Chin is China')
  assert.deepEqual(await choose(page, countries, [{ label: 'Mexico' }]), readyFor(typed('m')), 'leading spaces are skipped')
  assert.deepEqual(selected(countries), [''], 'planning chose nothing')
})

test('an option whose label another option shares is reached by typing its first letter again, and one with no label by nothing', async () => {
  const page = fakePage()
  const cities = select(page, [
    ['Choose a city', ''],
    ['Paris', 'fr'],
    ['Paris', 'tx'],
    ['', 'blank'],
  ])
  const [none] = cities.options
  assert.ok(none !== undefined)
  none.selected = true
  assert.deepEqual(await choose(page, cities, [{ value: 'fr' }]), readyFor(typed('p')))
  assert.deepEqual(await choose(page, cities, [{ value: 'tx' }]), readyFor(typed('p', 'p')), 'P lands on the first Paris, P again on the next')
  assert.deepEqual(await choose(page, cities, [{ value: 'blank' }]), { status: 'unreachable', element: '<select data-testid="select">' })
})

test('a select multiple plans to start at the first option and toggle each whose state is not the one asked for', async () => {
  const page = fakePage()
  const element = select(page, colours, true)
  const [red, , green] = element.options
  assert.ok(red !== undefined && green !== undefined)
  red.selected = true
  assert.deepEqual(await choose(page, element, [{ value: 'g' }, { label: 'New York' }], true), readyFor(toggled('Home', 'Space', 'ArrowDown', 'Space', 'ArrowDown', 'Space')))
  assert.deepEqual(await choose(page, element, [{ value: 'r' }], true), { status: 'unchanged', page: facts })
  assert.deepEqual(await choose(page, element, [{ value: 'r' }, { value: 'ny' }], true), readyFor(toggled('Home', 'ArrowDown', 'Space')), 'it stops after the last change')
  // A disabled option is skipped by the focus, so one that holds a state the list does not ask for cannot be changed.
  green.selected = true
  green.disabled = true
  assert.deepEqual(await choose(page, element, [{ value: 'r' }], true), { status: 'unreachable', element: '<select data-testid="select">' })
  assert.deepEqual(selected(element), ['r', 'g'], 'planning chose nothing')
})

test('a list for a select that takes one option, and an element that is not a select, fail at once', async () => {
  const page = fakePage()
  const single = select(page, colours)
  assert.deepEqual(await choose(page, single, [{ value: 'r' }], true), { status: 'unsupported', reason: 'multiple', element: '<select data-testid="select">' })
  const button = page.element('button')
  assert.deepEqual(await Promise.resolve(page.call(prepareFunction, { action: 'select', choices: [{ value: 'r' }], multiple: false }, oneElement, button)), {
    status: 'unsupported',
    reason: 'select',
    element: '<input data-testid="button">',
  })
})

test('a key of the plan readies the select as a press does: enabled, armed and focused, with the keys it holds', async () => {
  const page = fakePage()
  const element = select(page, colours)
  const intent = { action: 'select', choices: [{ value: 'g' }], multiple: false, typing: true, strokes: 2 }
  assert.deepEqual(await Promise.resolve(page.call(prepareFunction, intent, oneElement, element)), {
    status: 'ready',
    point: null,
    token: 1,
    via: null,
    scale: 1,
    page: facts,
    plan: null,
  })
  assert.equal(page.document.activeElement, element)
  element.disabled = true
  assert.deepEqual(await Promise.resolve(page.call(prepareFunction, intent, oneElement, element)), { status: 'blocked', check: 'enabled', detail: null })
})

test('a key typed to a select answers with what the select held as its own change arrived, or once the key was released', async () => {
  const page = fakePage()
  const element = select(page, colours)
  const [red, , green] = element.options
  assert.ok(red !== undefined && green !== undefined)
  const intent = { action: 'select', choices: [{ value: 'g' }], multiple: false, typing: true, strokes: 1 }
  const landed = '<select data-testid="select">'
  assert.equal(page.listening('change'), 1, 'the guard hears a select change from the start of the document, before the page can listen')
  await Promise.resolve(page.call(prepareFunction, intent, oneElement, element))
  let answered = false
  const verdict = Promise.resolve(page.call(verdictFunction, 1)).then((seen) => {
    answered = true
    return seen
  })
  assert.equal(page.dispatch('keydown', element).stopped, false)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(answered, false, 'a key typed to a select does not answer at its keydown')
  green.selected = true
  assert.equal(page.dispatch('change', element).stopped, false)
  const selection = { status: 'selected', selected: ['Green'], page: facts }
  assert.deepEqual(await verdict, { reached: ['keydown'], intercepted: null, landed, leaving: null, selection })
  // The page's own listener puts another option back after the guard read it; the look that follows reads that.
  red.selected = true
  assert.deepEqual(page.call(selectionFunction, intent.choices, oneElement, element), { status: 'other', selected: ['Red'], page: facts })
  assert.equal(page.dispatch('keyup', element).stopped, false)
  // A key that changes nothing answers once it is released, with what the select holds then.
  await Promise.resolve(page.call(prepareFunction, intent, oneElement, element))
  const unchanged = page.call(verdictFunction, 2)
  for (const type of ['keydown', 'keypress', 'keyup']) assert.equal(page.dispatch(type, element).stopped, false, type)
  assert.deepEqual(await unchanged, { reached: ['keydown'], intercepted: null, landed, leaving: null, selection: { status: 'other', selected: ['Red'], page: facts } })
  // With nothing armed, a change is the page's own, and passes untouched.
  green.selected = true
  assert.equal(page.dispatch('change', element).stopped, false)
  assert.equal(page.listening('change'), 1)
})

test('the guard notes the arming during which the page last set off for another document, and a move within it is not one', async () => {
  const page = fakePage()
  const element = select(page, colours)
  const intent = { action: 'select', choices: [{ value: 'g' }], multiple: false, typing: true, strokes: 1 }
  assert.equal(page.call(setOffFunction, 0), false, 'a document that never set off')
  await Promise.resolve(page.call(prepareFunction, intent, oneElement, element))
  page.navigate('http://app.test/start#later', true)
  assert.equal(page.call(setOffFunction, 1), false, 'a move within the document')
  page.navigate('http://app.test/next', false)
  assert.equal(page.call(setOffFunction, 1), true)
  assert.equal(page.navigate('http://app.test/next', false).stopped, false, 'the navigation itself goes on')
  await Promise.resolve(page.call(prepareFunction, intent, oneElement, element))
  assert.equal(page.call(setOffFunction, 2), false, 'nothing set off since the next arming began')
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

const formPage = { href: 'http://app.test/form', title: 'Form' }
const formFacts = { url: 'http://app.test/form', title: 'Form' }
const command: Extract<BrowserCommand, { kind: 'select' }> = { kind: 'select', locator: { by: 'testId', value: 'country' }, choices: [{ label: 'Canada' }] }
const listModifier = process.platform === 'darwin' ? { key: 'Meta', bit: 4 } : { key: 'Control', bit: 2 }

type SelectScript = {
  plan?: unknown
  looks?: unknown[]
  reached?: string[]
  heard?: string
  setOff?: boolean
  selections?: string[]
}

// A page whose select's look answers each of `looks` in turn and then plans `plan`, whose keys the guard saw reach the
// select as `reached`, holding, when `heard` names it, the selection the guard read as each key arrived, and whose
// selection reads each of `selections` in turn, then the last one again. Before each key after the first, the page
// says it set off for another document when `setOff` says so.
function selectPage({ plan = typed('c'), looks = [], reached = ['keydown', 'keyup'], heard, setOff = false, selections = ['selected'] }: SelectScript) {
  let look = 0
  let read = 0
  return scriptedPage({
    call: (source, params) => {
      if (source === prepareFunction) {
        const [intent] = Array.isArray(params['arguments']) ? params['arguments'] : []
        const typing = isRecord(intent) && isRecord(intent['value']) && intent['value']['typing'] === true
        if (typing) return value({ status: 'ready', point: null, token: 1, via: null, scale: 1, page: formPage, plan: null })
        return value(looks[look++] ?? { status: 'ready', point: { x: 10, y: 20 }, token: null, via: null, scale: 1, page: formPage, plan })
      }
      if (source === verdictFunction) {
        const selection = heard === undefined ? {} : { selection: { status: heard, selected: ['Canada'], page: { href: 'http://app.test/form?step=1', title: 'Form' } } }
        return value({ reached, intercepted: null, landed: '<select>', leaving: null, ...selection })
      }
      if (source === disarmFunction) return value(true)
      if (source === setOffFunction) return value(setOff)
      if (source === selectionFunction) {
        const status = selections[Math.min(read++, selections.length - 1)]
        return value({ status, selected: status === 'selected' ? ['Canada'] : ['Chile'], page: formPage })
      }
      return Promise.reject(new Error('unexpected call'))
    },
  })
}

function failureOfResult(result: CommandResult): Failure {
  assert.ok(!result.ok, JSON.stringify(result))
  return result.failure
}

function keyEvents(sent: SentCommand[]): Record<string, unknown>[] {
  return sent.flatMap(({ method, params }) => (method === 'Input.dispatchKeyEvent' && isRecord(params) ? [params] : []))
}

test('a select types the planned start of the label on its keyboard, each key guarded as a press, then reads the selection', async () => {
  const { page, sent } = selectPage({ plan: typed('c', 'h') })
  assert.deepEqual(await page.execute(command, 5000), { ok: true, kind: 'select', changed: true, page: formFacts })
  const keys = keyEvents(sent)
  assert.deepEqual(
    keys.map(({ type, key, text }) => [type, key, text]),
    [
      ['keyDown', 'c', 'c'],
      ['keyUp', 'c', undefined],
      ['keyDown', 'h', 'h'],
      ['keyUp', 'h', undefined],
    ],
  )
  const times = keys.map(({ timestamp }) => timestamp)
  assert.ok(times.every((time) => typeof time === 'number'), 'type-ahead keys carry their times')
  const [first = 0, , third = 0] = times.map(Number)
  assert.ok(third - first > 0 && third - first < 0.01, `typed together: ${third - first} s apart`)
  assert.deepEqual(functionsCalled(sent), [
    prepareFunction,
    prepareFunction,
    verdictFunction,
    disarmFunction,
    setOffFunction,
    prepareFunction,
    verdictFunction,
    disarmFunction,
    selectionFunction,
  ])
  assert.equal(sent.filter(({ method }) => method === 'Input.dispatchMouseEvent').length, 0, 'a select is chosen with keys, never by the mouse')
})

test('a select multiple moves its focus and toggles with the platform modifier held, and starts at once', async () => {
  const { page, sent } = selectPage({ plan: toggled('Home', 'ArrowDown', 'Space') })
  const started = performance.now()
  assert.deepEqual(await page.execute({ ...command, multiple: true }, 5000), { ok: true, kind: 'select', changed: true, page: formFacts })
  assert.ok(performance.now() - started < 900, 'only type-ahead waits for a quiet second')
  const keys = keyEvents(sent)
  assert.deepEqual(
    keys.map(({ type, key, modifiers }) => [type, key, modifiers]),
    [
      ['rawKeyDown', listModifier.key, listModifier.bit],
      ['rawKeyDown', 'Home', listModifier.bit],
      ['keyUp', 'Home', listModifier.bit],
      ['keyUp', listModifier.key, 0],
      ['rawKeyDown', listModifier.key, listModifier.bit],
      ['rawKeyDown', 'ArrowDown', listModifier.bit],
      ['keyUp', 'ArrowDown', listModifier.bit],
      ['keyUp', listModifier.key, 0],
      ['rawKeyDown', listModifier.key, listModifier.bit],
      ['rawKeyDown', ' ', listModifier.bit],
      ['keyUp', ' ', listModifier.bit],
      ['keyUp', listModifier.key, 0],
    ],
  )
  assert.ok(keys.every(({ timestamp }) => timestamp === undefined), 'only type-ahead keys carry times')
})

test("type-ahead waits for the rest of the select's own quiet second, as the page counts it, so no earlier key joins it", async () => {
  const { page } = selectPage({ plan: { ...typed('c'), quietMs: 400 } })
  const started = performance.now()
  assert.deepEqual(await page.execute(command, 5000), { ok: true, kind: 'select', changed: true, page: formFacts })
  const waited = performance.now() - started
  assert.ok(waited >= 390, `waited ${waited} ms`)
})

test('the page counts a select quiet once a second has passed since Retest last readied it for a key, a press included', async () => {
  const page = fakePage()
  const element = select(page, [
    ['Choose', ''],
    ['Canada', 'ca'],
  ])
  const [none] = element.options
  assert.ok(none !== undefined)
  none.selected = true
  const plan = async () => {
    const readiness = await choose(page, element, [{ value: 'ca' }])
    return isRecord(readiness) && isRecord(readiness['plan']) ? readiness['plan']['quietMs'] : undefined
  }
  assert.equal(await plan(), 0, 'a select no key was readied for has no quiet to wait for')
  await Promise.resolve(page.call(prepareFunction, { action: 'press', strokes: 1 }, oneElement, element))
  const quiet = await plan()
  assert.ok(typeof quiet === 'number' && quiet > 1000 && quiet <= 1100, `quiet for ${String(quiet)} ms`)
})

test('a select already as asked passes unchanged and types nothing, and one not ready yet is looked at again', async () => {
  const unchanged = selectPage({ looks: [{ status: 'unchanged', page: formPage }] })
  assert.deepEqual(await unchanged.page.execute(command, 1000), { ok: true, kind: 'select', changed: false, page: formFacts })
  assert.equal(keyEvents(unchanged.sent).length, 0)
  assert.equal(functionsCalled(unchanged.sent).length, 1)
  const moving = selectPage({ looks: [{ status: 'blocked', check: 'stable', detail: null }] })
  assert.deepEqual(await moving.page.execute(command, 5000), { ok: true, kind: 'select', changed: true, page: formFacts })
})

test('a key the select did not take fails the select by name, and types no more', async () => {
  const { page, sent } = selectPage({ plan: typed('c', 'h'), reached: [] })
  const result = await page.execute(command, 5000)
  assert.ok(!result.ok)
  assert.equal(result.failure.class, 'outcome_unknown')
  assert.match(result.failure.message, /^Retest typed to select 'Canada' in getByTestId\('country'\), but the key never reached the element's document/)
  assert.equal(keyEvents(sent).length, 2, 'the second key was never sent')
})

test('keys that leave the select holding another option fail once the time is up, and Retest never types again', async () => {
  const { page, sent } = selectPage({ selections: ['other'] })
  assert.deepEqual(await page.execute(command, 1500), {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: `Could not select 'Canada' in getByTestId('country'): Retest typed the keys that choose it, and the select holds "Chile". Retest does not type again.`,
      details: { check: 'selection', inputSent: true },
    },
  })
  assert.equal(keyEvents(sent).length, 2)
})

test('a select gone once its keys went passes on what the guard read as the last key arrived, and only then', async () => {
  const { page } = selectPage({ heard: 'selected', selections: ['lost'] })
  assert.deepEqual(await page.execute(command, 5000), { ok: true, kind: 'select', changed: true, page: formFacts })
  // A select still there is read as it stands: one holding another option fails, whatever the guard read before.
  const stayed = selectPage({ heard: 'selected', selections: ['other'] })
  assert.equal(failureOfResult(await stayed.page.execute(command, 600)).details?.['check'], 'selection')
  // A select gone after keys the guard read as choosing something else fails too.
  const missed = selectPage({ heard: 'other', selections: ['lost'] })
  assert.match(failureOfResult(await missed.page.execute(command, 600)).message, /no single select it matched still held the options asked for/)
})

test('a page that sets off for another document after a key types no more, and fails on what the guard read, or passes when it held the options asked for', async () => {
  const { page, sent } = selectPage({ plan: typed('c', 'h'), heard: 'other', setOff: true })
  const left = await page.execute(command, 5000)
  assert.deepEqual(failureOfResult(left), {
    class: 'not_actionable',
    message: `Could not select 'Canada' in getByTestId('country'): the page began to open another document after Retest typed 1 of the 2 keys that choose it, and the select held "Canada" as the last of them arrived. Retest typed no more.`,
    details: { check: 'selection', inputSent: true },
  })
  assert.equal(keyEvents(sent).length, 2, 'only the first key went down and up')
  const chosen = selectPage({ plan: typed('c', 'h'), heard: 'selected', setOff: true })
  assert.deepEqual(await chosen.page.execute(command, 5000), { ok: true, kind: 'select', changed: true, page: formFacts })
  assert.equal(keyEvents(chosen.sent).length, 2)
})

test('an answer lost to a closed connection after a key went is outcome_unknown, and a lost look sent nothing', async () => {
  const lost = new CdpDisconnectedError({ method: 'Input.dispatchKeyEvent', sessionId: 'S1' }, { reason: 'the browser closed the pipe', written: true })
  const typing = scriptedPage({
    call: (source, params) => {
      const [intent] = Array.isArray(params['arguments']) ? params['arguments'] : []
      const keyed = isRecord(intent) && isRecord(intent['value']) && intent['value']['typing'] === true
      if (source === prepareFunction) return value(keyed ? { status: 'ready', point: null, token: 1, via: null, scale: 1, page: formPage, plan: null } : { status: 'ready', point: { x: 10, y: 20 }, token: null, via: null, scale: 1, page: formPage, plan: typed('c') })
      if (source === verdictFunction) return never()
      return value(true)
    },
    input: () => Promise.reject(lost),
  })
  const unknown = await typing.page.execute(command, 5000)
  assert.ok(!unknown.ok && unknown.failure.class === 'outcome_unknown', JSON.stringify(unknown))
  const looking = scriptedPage({ call: () => Promise.reject(new CdpDisconnectedError({ method: 'Runtime.callFunctionOn', sessionId: 'S1' }, { reason: 'gone', written: true })) })
  const failed = await looking.page.execute(command, 1000)
  assert.ok(!failed.ok && failed.failure.class === 'session_lost', JSON.stringify(failed))
})

test('an empty list is usage, before the page is asked anything', async () => {
  const { page, sent } = selectPage({})
  const result = await page.execute({ ...command, choices: [] }, 1000)
  assert.deepEqual(result, { ok: false, failure: { class: 'usage', message: 'select() needs at least one option, received an empty list.' } })
  assert.deepEqual(sent, [])
})

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  return { value: await work, ms: performance.now() - start }
}
