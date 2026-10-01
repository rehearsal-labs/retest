import assert from 'node:assert/strict'
import { guardScript } from '../../src/browser/page-scripts.ts'

// A page small enough to hold in a test: elements that can take the focus, be checked or chosen from, a window
// whose listeners the guard adds and removes, and events that record whether the guard stopped them. Retest's page
// functions are compiled against it, so they run here as they would in the page, without a browser.

export class FakeNode {
  parent: FakeNode | null = null

  contains(node: unknown): boolean {
    for (let current = node; current instanceof FakeNode; current = current.parent) if (current === this) return true
    return false
  }

  getRootNode(): FakeNode {
    return this.parent === null ? this : this.parent.getRootNode()
  }
}

export class FakeElement extends FakeNode {
  readonly localName: string
  readonly #attributes: Map<string, string>
  readonly #document: FakeDocument
  disabled = false
  focusable = true
  visible = true
  isConnected = true

  constructor(document: FakeDocument, localName: string, attributes: Record<string, string>) {
    super()
    this.localName = localName
    this.#attributes = new Map(Object.entries(attributes))
    this.#document = document
    this.parent = document
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, value)
  }

  checkVisibility(): boolean {
    return this.visible
  }

  getBoundingClientRect(): { x: number; y: number; left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return { x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }
  }

  matches(selector: string): boolean {
    return selector === ':disabled' && this.disabled
  }

  focus(): void {
    if (this.focusable) this.#document.activeElement = this
  }

  scrollIntoView(): void {
    // Every element is in view already.
  }
}

export class FakeInput extends FakeElement {
  type: string
  checked = false
  labels: FakeElement[] = []

  constructor(document: FakeDocument, type: string, attributes: Record<string, string>) {
    super(document, 'input', attributes)
    this.type = type
  }
}

export class FakeOption extends FakeElement {
  label: string
  value: string
  #selected = false
  select: FakeSelect | undefined

  constructor(document: FakeDocument, label: string, value: string) {
    super(document, 'option', {})
    this.label = label
    this.value = value
  }

  get selected(): boolean {
    return this.#selected
  }

  // A single select keeps one option chosen, as the browser's does.
  set selected(value: boolean) {
    if (value && this.select?.multiple === false) for (const other of this.select.options) other.#selected = false
    this.#selected = value
  }
}

export class FakeSelect extends FakeElement {
  multiple: boolean
  readonly options: FakeOption[]
  readonly dispatched: { type: string; bubbles: boolean; composed: boolean }[] = []

  constructor(document: FakeDocument, options: FakeOption[], multiple: boolean) {
    super(document, 'select', { 'data-testid': 'select' })
    this.multiple = multiple
    this.options = options
    for (const option of options) {
      option.select = this
      option.parent = this
    }
  }

  get selectedOptions(): FakeOption[] {
    return this.options.filter((option) => option.selected)
  }

  dispatchEvent(event: { type: string; bubbles: boolean; composed: boolean }): boolean {
    this.dispatched.push({ type: event.type, bubbles: event.bubbles, composed: event.composed })
    return true
  }
}

export class FakeDocument extends FakeNode {
  activeElement: FakeElement | null = null
  body: { innerText: string } | null = { innerText: '' }
  title = 'Fake page'
  // What is at every point: the element a test says, or none.
  atPoint: FakeElement | null = null

  elementFromPoint(): FakeElement | null {
    return this.atPoint
  }
}

type EventOptions = { bubbles?: boolean; composed?: boolean }

// Made as the DOM makes one, `new Event(type, init)`; the page sets its target when it dispatches it.
export class FakeEvent {
  readonly isTrusted: boolean = true
  readonly type: string
  readonly bubbles: boolean
  readonly composed: boolean
  target: unknown = null
  stopped = false

  constructor(type: string, init: EventOptions = {}) {
    this.type = type
    this.bubbles = init.bubbles ?? false
    this.composed = init.composed ?? false
  }

  preventDefault(): void {
    this.stopped = true
  }

  stopImmediatePropagation(): void {
    this.stopped = true
  }
}

export class FakeKeyboardEvent extends FakeEvent {}

export class FakeInputEvent extends FakeEvent {}

export class FakeWheelEvent extends FakeEvent {}

type Listener = (event: FakeEvent) => void

/** A fake page and the ways a test drives it. */
export type FakePage = {
  readonly document: FakeDocument
  /** Compiles one of Retest's page functions against the page and calls it with `args`. */
  call(source: string, ...args: unknown[]): unknown
  /** Sends a trusted event through the window's listeners, as the capture phase at the window would. */
  dispatch(type: string, target: unknown, kind?: typeof FakeEvent): FakeEvent
  element(testId: string): FakeElement
  /** How many listeners the window has for `type`. */
  listening(type: string): number
  readonly visualViewport: { offsetLeft: number; offsetTop: number; width: number; height: number; scale: number }
}

/** A new document, which runs Retest's guard script before anything else, as every document the page opens does. */
export function fakePage(): FakePage {
  const listeners = new Map<string, Set<Listener>>()
  const document = new FakeDocument()
  const window = {
    addEventListener: (type: string, listener: Listener) => {
      const forType = listeners.get(type) ?? new Set()
      forType.add(listener)
      listeners.set(type, forType)
    },
    removeEventListener: (type: string, listener: Listener) => void listeners.get(type)?.delete(listener),
  }
  const scope = {
    window,
    navigation: { addEventListener: () => {} },
    document,
    Node: FakeNode,
    Element: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    HTMLSelectElement: FakeSelect,
    Event: FakeEvent,
    KeyboardEvent: FakeKeyboardEvent,
    InputEvent: FakeInputEvent,
    globalThis: {},
    getComputedStyle: () => ({ visibility: 'visible' }),
    location: { origin: 'http://app.test', href: 'http://app.test/start?token=1' },
    visualViewport: { offsetLeft: 0, offsetTop: 0, width: 800, height: 600, scale: 1 },
    requestAnimationFrame: (callback: () => void) => queueMicrotask(callback),
  }
  const call = (source: string, ...args: unknown[]): unknown => {
    const compiled: unknown = new Function(...Object.keys(scope), `return (${source})`)(...Object.values(scope))
    assert.ok(typeof compiled === 'function')
    return Reflect.apply(compiled, undefined, args)
  }
  new Function(...Object.keys(scope), guardScript)(...Object.values(scope))
  const dispatch = (type: string, target: unknown, kind: typeof FakeEvent = eventClass(type)): FakeEvent => {
    const event = new kind(type)
    event.target = target
    for (const listener of listeners.get(type) ?? []) listener(event)
    return event
  }
  const element = (testId: string) => new FakeElement(document, 'input', { 'data-testid': testId })
  const listening = (type: string) => listeners.get(type)?.size ?? 0
  return { document, call, dispatch, element, listening, visualViewport: scope.visualViewport }
}

function eventClass(type: string): typeof FakeEvent {
  if (type.startsWith('key')) return FakeKeyboardEvent
  if (type === 'input' || type === 'beforeinput') return FakeInputEvent
  if (type === 'wheel') return FakeWheelEvent
  return FakeEvent
}
