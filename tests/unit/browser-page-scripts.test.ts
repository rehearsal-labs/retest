import type { TextQuery } from '../../src/protocol/host-check.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  armKeyboardFunction,
  disarmFunction,
  guardScript,
  observeFunction,
  prepareFunction,
  readPageFunction,
  readStorageFunction,
  strayFunction,
  verdictFunction,
  writeStorageFunction,
} from '../../src/browser/page-scripts.ts'
import { pageTextHolds } from '../../src/protocol/host-check.ts'

const functions = [
  ['observe', observeFunction, 'function observe(limit, query, ...elements)'],
  ['prepare', prepareFunction, 'async function prepare(action, multiline, origins, query, ...elements)'],
  ['verdict', verdictFunction, 'function verdict(token'],
  ['disarm', disarmFunction, 'function disarm(token'],
  ['stray', strayFunction, 'function stray()'],
  ['armKeyboard', armKeyboardFunction, 'function armKeyboard()'],
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

test('the page scripts never read values from their own source', () => {
  for (const [, source] of [...functions, ['guard', guardScript]]) {
    assert.doesNotMatch(source, /\$\{/, 'nothing is interpolated into the page source')
    assert.doesNotMatch(source, /\b(eval|Function)\(/)
    assert.doesNotMatch(source, /\.click\(\)|\.value\s*=[^=]/, 'input goes through the browser, never through script')
  }
})

// A page small enough to hold in a test: elements that can take the focus, a window whose listeners the guard
// adds, and events that record whether the guard stopped them. Retest's functions are compiled against it.
class FakeNode {
  parent: FakeNode | null = null

  contains(node: unknown): boolean {
    for (let current = node; current instanceof FakeNode; current = current.parent) if (current === this) return true
    return false
  }

  getRootNode(): FakeNode {
    return this.parent === null ? this : this.parent.getRootNode()
  }
}

class FakeElement extends FakeNode {
  readonly localName: string
  readonly #testId: string
  readonly #document: FakeDocument
  disabled = false
  focusable = true

  constructor(document: FakeDocument, localName: string, testId: string) {
    super()
    this.localName = localName
    this.#testId = testId
    this.#document = document
    this.parent = document
  }

  getAttribute(name: string): string | null {
    return name === 'data-testid' ? this.#testId : null
  }

  checkVisibility(): boolean {
    return true
  }

  getBoundingClientRect(): { width: number; height: number } {
    return { width: 100, height: 20 }
  }

  matches(selector: string): boolean {
    return selector === ':disabled' && this.disabled
  }

  focus(): void {
    if (this.focusable) this.#document.activeElement = this
  }
}

class FakeDocument extends FakeNode {
  activeElement: FakeElement | null = null
  body: { innerText: string } | null = { innerText: '' }
}

class FakeEvent {
  readonly isTrusted = true
  readonly type: string
  readonly target: unknown
  stopped = false

  constructor(type: string, target: unknown) {
    this.type = type
    this.target = target
  }

  preventDefault(): void {
    this.stopped = true
  }

  stopImmediatePropagation(): void {
    this.stopped = true
  }
}

function fakePage() {
  const listeners = new Map<string, (event: FakeEvent) => void>()
  const document = new FakeDocument()
  const scope = {
    window: { addEventListener: (type: string, listener: (event: FakeEvent) => void) => listeners.set(type, listener) },
    navigation: { addEventListener: () => {} },
    document,
    Node: FakeNode,
    Element: FakeElement,
    globalThis: {},
    getComputedStyle: () => ({ visibility: 'visible' }),
    location: { origin: 'http://app.test' },
  }
  const call = (source: string, ...args: unknown[]): unknown => {
    const compiled: unknown = new Function(...Object.keys(scope), `return (${source})`)(...Object.values(scope))
    assert.ok(typeof compiled === 'function')
    return Reflect.apply(compiled, undefined, args)
  }
  const dispatch = (type: string, target: unknown): FakeEvent => {
    const event = new FakeEvent(type, target)
    listeners.get(type)?.(event)
    return event
  }
  const element = (testId: string) => new FakeElement(document, 'input', testId)
  return { document, call, dispatch, element }
}

// Readies a press on the element, and asks for the guard's verdict, which is still to come.
async function pressReady(page: ReturnType<typeof fakePage>, element: FakeElement): Promise<{ verdict: unknown }> {
  const readiness = await page.call(prepareFunction, 'press', false, null, { by: 'elements' }, element)
  assert.deepEqual(readiness, { status: 'ready', point: null, token: 1 })
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
  assert.deepEqual(await page.call(prepareFunction, 'press', false, null, { by: 'elements' }, disabled), { status: 'blocked', check: 'enabled', detail: null })
  const plain = page.element('plain')
  plain.focusable = false
  assert.deepEqual(await page.call(prepareFunction, 'press', false, null, { by: 'elements' }, plain), { status: 'blocked', check: 'focused', detail: null })
  assert.equal(page.dispatch('keydown', plain).stopped, true, 'nothing is armed, so a key is stray')
})

test("a key for the page's keyboard reaches the document wherever the focus is in it, and a key that never arrives is disarmed", async () => {
  const page = fakePage()
  const field = page.element('field')
  page.document.activeElement = field
  assert.equal(page.call(armKeyboardFunction), 1)
  const verdict = page.call(verdictFunction, 1)
  assert.equal(page.dispatch('keydown', field).stopped, false)
  assert.deepEqual(await verdict, { reached: ['keydown'], intercepted: null, landed: '<input data-testid="field">', leaving: null })
  assert.equal(page.dispatch('keyup', field).stopped, false)
  // A key that went into a frame never reaches this document; disarming answers with nothing reached.
  assert.equal(page.call(armKeyboardFunction), 2)
  const unreached = page.call(verdictFunction, 2)
  assert.equal(page.call(disarmFunction, 2), true)
  assert.deepEqual(await unreached, { reached: [], intercepted: null, landed: '<input data-testid="field">', leaving: null })
})

test('the page reads its visible text for each query by the rule pageTextHolds applies', () => {
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
  const found = page.call(readPageFunction, queries)
  assert.deepEqual(found, [true, true, false, true, false, true, true, false])
  assert.deepEqual(found, queries.map((query) => pageTextHolds(text, query)))
  page.document.body = null
  assert.deepEqual(page.call(readPageFunction, queries), queries.map((query) => pageTextHolds('', query)))
})
