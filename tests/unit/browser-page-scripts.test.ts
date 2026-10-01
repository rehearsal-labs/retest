import type { TextQuery } from '../../src/protocol/host-check.ts'
import type { FakeElement, FakePage } from './browser-fake-page.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  armDocumentFunction,
  checkedFunction,
  disarmFunction,
  guardScript,
  observeFunction,
  pageFactsFunction,
  prepareFunction,
  readPageFunction,
  readStorageFunction,
  strayFunction,
  verdictFunction,
  writeStorageFunction,
} from '../../src/browser/page-scripts.ts'
import { pageTextHolds } from '../../src/protocol/host-check.ts'
import { FakeEvent, FakeInput, fakePage } from './browser-fake-page.ts'

const functions = [
  ['observe', observeFunction, 'function observe(limit, query, ...elements)'],
  ['prepare', prepareFunction, 'async function prepare(intent, query, ...elements)'],
  ['verdict', verdictFunction, 'function verdict(token'],
  ['disarm', disarmFunction, 'function disarm(token'],
  ['stray', strayFunction, 'function stray()'],
  ['armDocument', armDocumentFunction, 'function armDocument(action)'],
  ['checked', checkedFunction, 'function checked(query, ...elements)'],
  ['readPageFacts', pageFactsFunction, 'function readPageFacts()'],
  ['readPage', readPageFunction, 'function readPage(queries)'],
  ['readStorage', readStorageFunction, 'function readStorage()'],
  ['writeStorage', writeStorageFunction, 'function writeStorage(items)'],
] as const

for (const [name, source, start] of functions) {
  test(`the ${name} function is one self-contained function declaration`, () => {
    const compiled: unknown = new Function(`return (${source})`)()
    assert.equal(typeof compiled, 'function')
    assert.ok(source.startsWith(start), source.slice(0, 80))
  })
}

test('the guard script is one self-contained script that installs the guard when it runs', () => {
  assert.doesNotThrow(() => new Function(guardScript))
  assert.match(guardScript, /^\(\(\) => \{[\s\S]*installGuard\(\)\n\}\)\(\)$/)
})

test('the page scripts never read values from their own source, and only a select is chosen by script', () => {
  for (const [name, source] of [...functions, ['guard', guardScript]]) {
    assert.doesNotMatch(source, /\$\{/, 'nothing is interpolated into the page source')
    assert.doesNotMatch(source, /\b(eval|Function)\(/)
    assert.doesNotMatch(source, /\.click\(\)|\.value\s*=[^=]|\.checked\s*=[^=]/, 'input goes through the browser, never through script')
    // A select's list is drawn outside the page, where input cannot reach it (fact F3).
    if (name !== 'prepare') assert.doesNotMatch(source, /\.selected\s*=[^=]|dispatchEvent/)
  }
})

const facts = { href: 'http://app.test/start?token=1', title: 'Fake page' }

// Readies a press on the element, and asks for the guard's verdict, which is still to come.
async function pressReady(page: FakePage, element: FakeElement): Promise<{ verdict: unknown }> {
  const readiness = await page.call(prepareFunction, { action: 'press' }, { by: 'elements' }, element)
  assert.deepEqual(readiness, { status: 'ready', point: null, token: 1, via: null, scale: 1, page: facts })
  assert.equal(page.document.activeElement, element, 'Retest focused the element')
  return { verdict: page.call(verdictFunction, 1) }
}

test('a press decides at its keydown and answers then, and the rest of the keystroke belongs to the page, wherever it goes', async () => {
  const page = fakePage()
  const field = page.element('field')
  const next = page.element('next')
  const { verdict } = await pressReady(page, field)
  assert.equal(page.dispatch('keydown', field).stopped, false)
  assert.deepEqual(await verdict, { reached: ['keydown'], intercepted: null, landed: '<input data-testid="field">', leaving: null })
  // The page moves the focus on the key, as Tab does, and the rest of the keystroke goes to the next field.
  page.document.activeElement = next
  for (const type of ['keypress', 'beforeinput', 'input', 'keyup']) assert.equal(page.dispatch(type, next).stopped, false, type)
  // The arming lasted until the key was released, and no longer: typing after it is stray, and stopped.
  assert.equal(page.dispatch('keyup', next).stopped, true)
  assert.deepEqual(page.call(strayFunction), { event: 'keyup', by: '<input data-testid="next">', origin: 'http://app.test' })
})

test('a keydown another element takes is stopped, and so is the rest of that keystroke', async () => {
  const page = fakePage()
  const field = page.element('field')
  const dialog = page.element('dialog')
  const { verdict } = await pressReady(page, field)
  page.document.activeElement = dialog
  assert.equal(page.dispatch('keydown', dialog).stopped, true)
  assert.deepEqual(await verdict, {
    reached: [],
    intercepted: { event: 'keydown', by: '<input data-testid="dialog">' },
    landed: '<input data-testid="dialog">',
    leaving: null,
  })
  assert.equal(page.dispatch('keyup', field).stopped, true, 'even a release on the element itself')
  assert.equal(page.call(strayFunction), null, 'none of it was stray')
})

test('a key is not armed for an element that is disabled or cannot keep the focus', async () => {
  const page = fakePage()
  const disabled = page.element('disabled')
  disabled.disabled = true
  assert.deepEqual(await page.call(prepareFunction, { action: 'press' }, { by: 'elements' }, disabled), { status: 'blocked', check: 'enabled', detail: null })
  const plain = page.element('plain')
  plain.focusable = false
  assert.deepEqual(await page.call(prepareFunction, { action: 'press' }, { by: 'elements' }, plain), { status: 'blocked', check: 'focused', detail: null })
  assert.equal(page.dispatch('keydown', plain).stopped, true, 'nothing is armed, so a key is stray')
})

test("a key for the page's keyboard reaches the document wherever the focus is in it, and a key that never arrives is disarmed", async () => {
  const page = fakePage()
  const field = page.element('field')
  page.document.activeElement = field
  assert.deepEqual(page.call(armDocumentFunction, 'press'), { status: 'ready', point: null, token: 1, via: null, scale: 1, page: facts })
  const verdict = page.call(verdictFunction, 1)
  assert.equal(page.dispatch('keydown', field).stopped, false)
  assert.deepEqual(await verdict, { reached: ['keydown'], intercepted: null, landed: '<input data-testid="field">', leaving: null })
  assert.equal(page.dispatch('keyup', field).stopped, false)
  // A key that went into a frame never reaches this document; disarming answers with nothing reached.
  page.call(armDocumentFunction, 'press')
  const unreached = page.call(verdictFunction, 2)
  assert.equal(page.call(disarmFunction, 2), true)
  assert.deepEqual(await unreached, { reached: [], intercepted: null, landed: '<input data-testid="field">', leaving: null })
})

test('stray typing is stopped, and the plain input event a checkbox or a select fires after it changes is not', () => {
  const page = fakePage()
  const box = page.element('box')
  assert.equal(page.dispatch('input', box, FakeEvent).stopped, false, "the control's own input event")
  assert.equal(page.dispatch('keydown', box).stopped, true, 'a key nothing was armed for')
  assert.equal(page.dispatch('input', box).stopped, true, 'text nothing was armed for')
})

test('the wheel is listened for only while a scroll is armed, and a wheel that reaches the element settles it', async () => {
  const page = fakePage()
  assert.equal(page.listening('wheel'), 0, 'no wheel listener slows the page before a scroll')
  assert.equal(page.listening('click'), 1)
  const box = page.element('terms')
  page.document.atPoint = box
  page.visualViewport.scale = 0.5
  const readiness = await page.call(prepareFunction, { action: 'scroll' }, { by: 'elements' }, box)
  assert.deepEqual(readiness, { status: 'ready', point: { x: 50, y: 10 }, token: 1, via: null, scale: 0.5, page: facts })
  assert.equal(page.listening('wheel'), 1, 'armed')
  const verdict = page.call(verdictFunction, 1)
  assert.equal(page.dispatch('wheel', box).stopped, false)
  assert.deepEqual(await verdict, { reached: ['wheel'], intercepted: null, landed: '<input data-testid="terms">', leaving: null })
  assert.equal(page.listening('wheel'), 0, 'removed once the wheel settled the arming')
})

test('a wheel another element takes is stopped, and a scroll disarmed without one removes its listener too', async () => {
  const page = fakePage()
  const box = page.element('terms')
  const cover = page.element('cover')
  page.document.atPoint = box
  await page.call(prepareFunction, { action: 'scroll' }, { by: 'elements' }, box)
  const verdict = page.call(verdictFunction, 1)
  assert.equal(page.dispatch('wheel', cover).stopped, true)
  assert.deepEqual(await verdict, { reached: [], intercepted: { event: 'wheel', by: '<input data-testid="cover">' }, landed: '<input data-testid="terms">', leaving: null })
  assert.equal(page.listening('wheel'), 0)
  page.call(armDocumentFunction, 'scroll')
  assert.equal(page.listening('wheel'), 1)
  assert.equal(page.call(disarmFunction, 2), true)
  assert.equal(page.listening('wheel'), 0)
})

test('a wheel for the page is turned at the centre of the viewport, and any element of the document may take it', async () => {
  const page = fakePage()
  const anywhere = page.element('anywhere')
  page.document.atPoint = anywhere
  const readiness = page.call(armDocumentFunction, 'scroll')
  assert.deepEqual(readiness, { status: 'ready', point: { x: 400, y: 300 }, token: 1, via: null, scale: 1, page: facts })
  const verdict = page.call(verdictFunction, 1)
  assert.equal(page.dispatch('wheel', anywhere).stopped, false)
  assert.deepEqual(await verdict, { reached: ['wheel'], intercepted: null, landed: '<input data-testid="anywhere">', leaving: null })
})

function checkbox(page: FakePage, type = 'checkbox', testId = 'agree'): FakeInput {
  return new FakeInput(page.document, type, { 'data-testid': testId })
}

function label(page: FakePage, control: FakeInput, testId: string): FakeElement {
  const element = page.element(testId)
  control.labels.push(element)
  return element
}

const check = { action: 'check', checked: true, pointer: 'click' }
const uncheck = { action: 'check', checked: false, pointer: 'click' }

test('a hidden checkbox is checked through its one visible label, and the guard counts the label and what is inside it as the element', async () => {
  const page = fakePage()
  const box = checkbox(page)
  box.visible = false
  const own = label(page, box, 'agree-label')
  const inside = page.element('slider')
  inside.parent = own
  page.document.atPoint = inside
  const readiness = await page.call(prepareFunction, check, { by: 'elements' }, box)
  assert.deepEqual(readiness, { status: 'ready', point: { x: 50, y: 10 }, token: 1, via: 'label', scale: 1, page: facts })
  const verdict = page.call(verdictFunction, 1)
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) assert.equal(page.dispatch(type, inside).stopped, false, type)
  assert.deepEqual(await verdict, {
    reached: ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'],
    intercepted: null,
    landed: '<input data-testid="slider">',
    leaving: null,
  })
  // The click the label passes on to its control comes after, and belongs to the page.
  assert.equal(page.dispatch('click', box).stopped, false)
})

test('a hidden checkbox without exactly one visible label of its own is not visible, and a disabled one is not enabled', async () => {
  const page = fakePage()
  const box = checkbox(page)
  box.visible = false
  assert.deepEqual(await page.call(prepareFunction, check, { by: 'elements' }, box), { status: 'blocked', check: 'visible', detail: null })
  label(page, box, 'first')
  label(page, box, 'second')
  assert.deepEqual(await page.call(prepareFunction, check, { by: 'elements' }, box), { status: 'blocked', check: 'visible', detail: null })
  const single = checkbox(page, 'checkbox', 'single')
  single.visible = false
  single.disabled = true
  page.document.atPoint = label(page, single, 'single-label')
  assert.deepEqual(await page.call(prepareFunction, check, { by: 'elements' }, single), { status: 'blocked', check: 'enabled', detail: null })
})

test('a control already in the state asked for is unchanged, and nothing is armed for it', async () => {
  const page = fakePage()
  const box = checkbox(page)
  box.checked = true
  assert.deepEqual(await page.call(prepareFunction, check, { by: 'elements' }, box), { status: 'unchanged', page: facts })
  const role = page.element('role')
  role.setAttribute('role', 'switch')
  role.setAttribute('aria-checked', 'false')
  assert.deepEqual(await page.call(prepareFunction, uncheck, { by: 'elements' }, role), { status: 'unchanged', page: facts })
  assert.equal(page.call(disarmFunction, 1), false, 'no arming was made')
})

test('a role says what can be checked, by its first word, and aria-checked="mixed" is not checked', async () => {
  const page = fakePage()
  const mixed = page.element('mixed')
  mixed.setAttribute('role', 'checkbox')
  mixed.setAttribute('aria-checked', 'mixed')
  page.document.atPoint = mixed
  assert.deepEqual(await page.call(prepareFunction, check, { by: 'elements' }, mixed), { status: 'ready', point: { x: 50, y: 10 }, token: 1, via: null, scale: 1, page: facts })
  assert.equal(page.call(checkedFunction, { by: 'elements' }, mixed), false)
  mixed.setAttribute('aria-checked', 'true')
  assert.equal(page.call(checkedFunction, { by: 'elements' }, mixed), true)
  for (const role of ['menuitemcheckbox', 'menuitemradio', 'radio switch']) {
    const element = page.element(role)
    element.setAttribute('role', role)
    element.setAttribute('aria-checked', 'true')
    assert.equal(page.call(checkedFunction, { by: 'elements' }, element), true, role)
  }
  const second = page.element('second-word')
  second.setAttribute('role', 'button checkbox')
  assert.deepEqual(await page.call(prepareFunction, check, { by: 'elements' }, second), {
    status: 'unsupported',
    reason: 'checkable',
    element: '<input data-testid="second-word">',
  })
  assert.equal(page.call(checkedFunction, { by: 'elements' }, second), null)
})

test('uncheck refuses a radio button, native or by role, and check refuses what cannot be checked', async () => {
  const page = fakePage()
  const radio = checkbox(page, 'radio', 'red')
  radio.checked = true
  assert.deepEqual(await page.call(prepareFunction, uncheck, { by: 'elements' }, radio), { status: 'unsupported', reason: 'radio', element: '<input data-testid="red">' })
  const menuRadio = page.element('menu-radio')
  menuRadio.setAttribute('role', 'menuitemradio')
  assert.deepEqual(await page.call(prepareFunction, uncheck, { by: 'elements' }, menuRadio), {
    status: 'unsupported',
    reason: 'radio',
    element: '<input data-testid="menu-radio">',
  })
  const text = checkbox(page, 'text', 'name')
  assert.deepEqual(await page.call(prepareFunction, check, { by: 'elements' }, text), { status: 'unsupported', reason: 'checkable', element: '<input data-testid="name">' })
})

test('the page reads its visible text for each query by the rule pageTextHolds applies, and its title', () => {
  const page = fakePage()
  const text = '  Thank you.\n\n  Your ORDER\tis   placed. Straße '
  const queries: TextQuery[] = [
    { text: 'Your ORDER is placed.', ignoreCase: false },
    { text: ' your order ', ignoreCase: true },
    { text: 'your order', ignoreCase: false },
    { text: 'Thank you. Your', ignoreCase: false },
    { text: 'STRASSE', ignoreCase: true },
    { text: 'straße', ignoreCase: true },
    { text: 'placed.\nStraße', ignoreCase: false },
    { text: 'missing', ignoreCase: true },
  ]
  page.document.body = { innerText: text }
  page.document.title = 'Order placed'
  const found = [true, true, false, true, false, true, true, false]
  assert.deepEqual(page.call(readPageFunction, queries), { found, title: 'Order placed' })
  assert.deepEqual(found, queries.map((query) => pageTextHolds(text, query)))
  page.document.body = null
  assert.deepEqual(page.call(readPageFunction, queries), { found: queries.map((query) => pageTextHolds('', query)), title: 'Order placed' })
})

test('the page facts are its address and title as the page has them', () => {
  const page = fakePage()
  page.document.title = ' Raw\ttitle '
  assert.deepEqual(page.call(pageFactsFunction), { href: 'http://app.test/start?token=1', title: ' Raw\ttitle ' })
})
