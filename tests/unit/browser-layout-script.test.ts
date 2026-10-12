import type { LayoutReading, ReadStyle } from '../../src/browser/layout.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { documentFactsSchema } from '../../src/browser/document-facts.ts'
import { layoutReadingSchema, measureLayout } from '../../src/browser/layout.ts'
import { layoutFunction } from '../../src/browser/page-scripts.ts'
import { parse, s } from '../../src/protocol/schema.ts'

// A document small enough to hold in a test: elements with a client rect, a computed style, text of their own and
// scroll sizes. Retest's layout function is compiled against it, so it reads here as it would in the page.

type Rect = { left: number; top: number; right: number; bottom: number }
type Sizes = { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number }

const defaults: ReadStyle = { display: 'block', visibility: 'visible', opacity: 1, position: 'static', overflowX: 'visible', overflowY: 'visible', textOverflow: 'clip', lineClamp: 'none' }

class FakeText {
  readonly nodeType = 3
  readonly data: string

  constructor(data: string) {
    this.data = data
  }
}

class FakeDocument {
  documentElement: FakeElement | null = null
  body: FakeElement | null = null
  title = 'Layout'
}

class FakeElement {
  readonly nodeType = 1
  readonly localName: string
  readonly rect: Rect
  readonly style: ReadStyle
  readonly sizes: Sizes
  readonly document: FakeDocument
  parentElement: FakeElement | null = null
  readonly childNodes: (FakeElement | FakeText)[] = []

  constructor(document: FakeDocument, localName: string, rect: Rect, style: Partial<ReadStyle> = {}, sizes: Partial<Sizes> = {}) {
    this.document = document
    this.localName = localName
    this.rect = rect
    this.style = { ...defaults, ...style }
    const width = rect.right - rect.left
    const height = rect.bottom - rect.top
    this.sizes = { scrollWidth: width, clientWidth: width, scrollHeight: height, clientHeight: height, ...sizes }
  }

  get scrollWidth(): number {
    return this.sizes.scrollWidth
  }

  get clientWidth(): number {
    return this.sizes.clientWidth
  }

  get scrollHeight(): number {
    return this.sizes.scrollHeight
  }

  get clientHeight(): number {
    return this.sizes.clientHeight
  }

  append(...nodes: (FakeElement | FakeText)[]): this {
    for (const node of nodes) {
      if (node instanceof FakeElement) node.parentElement = this
      this.childNodes.push(node)
    }
    return this
  }

  getBoundingClientRect(): Rect {
    return { ...this.rect }
  }

  getRootNode(): FakeDocument {
    return this.document
  }

  getAttribute(): null {
    return null
  }

  contains(other: FakeElement): boolean {
    for (let current: FakeElement | null = other; current !== null; current = current.parentElement) if (current === this) return true
    return false
  }

  // Every element inside, in document order, as `querySelectorAll('*')` lists them.
  querySelectorAll(selector: string): FakeElement[] {
    assert.equal(selector, '*')
    return this.childNodes.flatMap((node) => (node instanceof FakeElement ? [node, ...node.querySelectorAll('*')] : []))
  }
}

class FakeInput extends FakeElement {}

const rect = (left: number, top: number, right: number, bottom: number): Rect => ({ left, top, right, bottom })

// One element passed after the query, as role and label steps pass the elements they found.
const found = (from: number) => ({ steps: [{ by: 'elements', from, count: 1, pick: null }] })

type Page = { document: FakeDocument; html: FakeElement; body: FakeElement; element: (name: string, box: Rect, style?: Partial<ReadStyle>, sizes?: Partial<Sizes>) => FakeElement; input: (box: Rect) => FakeElement; read: (words: boolean, ...elements: FakeElement[]) => unknown }

function page(viewport = { width: 390, height: 844 }): Page {
  const document = new FakeDocument()
  const html = new FakeElement(document, 'html', rect(0, 0, viewport.width, viewport.height), {}, { clientWidth: viewport.width })
  const body = new FakeElement(document, 'body', rect(0, 0, viewport.width, viewport.height))
  html.append(body)
  document.documentElement = html
  document.body = body
  const scope = {
    document,
    Node: { TEXT_NODE: 3, DOCUMENT_POSITION_FOLLOWING: 4 },
    Element: FakeElement,
    HTMLInputElement: FakeInput,
    HTMLSelectElement: class {},
    HTMLTextAreaElement: class {},
    // A document with no shadow roots and no slots: nothing is ever one.
    ShadowRoot: class {},
    HTMLSlotElement: class {},
    getComputedStyle: (element: FakeElement) => ({ ...element.style, opacity: String(element.style.opacity), getPropertyValue: (name: string) => (name === '-webkit-line-clamp' ? element.style.lineClamp : '') }),
    innerWidth: viewport.width,
    innerHeight: viewport.height,
    location: { href: 'http://app.test/cart' },
  }
  const read = (words: boolean, ...elements: FakeElement[]): unknown => {
    const compiled: unknown = new Function(...Object.keys(scope), `return (${layoutFunction})`)(...Object.values(scope))
    assert.ok(typeof compiled === 'function')
    return Reflect.apply(compiled, undefined, [words, 200, elements.map((_, index) => found(index)), ...elements])
  }
  return {
    document,
    html,
    body,
    element: (name, box, style, sizes) => new FakeElement(document, name, box, style, sizes),
    input: (box) => new FakeInput(document, 'input', box),
    read,
  }
}

const answerSchema = s.object({ reading: layoutReadingSchema, page: documentFactsSchema })

function readingOf(answer: unknown): LayoutReading {
  const parsed = parse(answerSchema, answer)
  assert.ok(parsed.ok, JSON.stringify(parsed))
  return parsed.value.reading
}

describe('the layout page function', () => {
  test('is one self-contained function declaration that reads no value from its own source', () => {
    const compiled: unknown = new Function(`return (${layoutFunction})`)()
    assert.equal(typeof compiled, 'function')
    assert.ok(layoutFunction.startsWith('function readLayout(words, limit, queries, ...elements)'))
    assert.doesNotMatch(layoutFunction, /\$\{/)
    assert.doesNotMatch(layoutFunction, /\b(eval|Function)\(|\.click\(\)|dispatchEvent|\.value\s*=[^=]/)
  })

  test('lists the element after every element around it up to the body, with what each rule reads, and the words inside it', () => {
    const { body, element, read } = page()
    const wrap = element('div', rect(0, 0, 100, 20), { overflowX: 'hidden', overflowY: 'hidden' })
    const title = element('span', rect(0, 0, 114, 20))
    title.append(new FakeText('Release checklist'))
    wrap.append(new FakeText('  '), title)
    body.append(wrap)
    const answer = read(true, wrap)
    const reading = readingOf(answer)
    assert.deepEqual(reading.targets, [{ count: 1, node: 1, inner: [2] }])
    assert.deepEqual(reading.nodes.map((node) => [node.parent, node.words, node.style.overflowX]), [[-1, false, 'visible'], [0, false, 'hidden'], [1, true, 'visible']])
    assert.equal(reading.nodes[2]?.style.opacity, 1, 'opacity is read as a number')
    assert.deepEqual(reading.page, { width: 390, height: 844, edge: 390, scrollWidth: 390, rootOverflowX: 'visible', bodyOverflowX: 'visible' })
    assert.deepEqual(Reflect.get(Object(answer), 'page'), { href: 'http://app.test/cart', title: 'Layout' })
    assert.equal(measureLayout(reading, true).targets[0]?.element?.cut, 14)
  })

  test('reads two elements once each, shares what is around them, and marks a field', () => {
    const { body, element, input, read } = page()
    const search = input(rect(0, 30, 300, 70))
    const clear = element('button', rect(260, 38, 290, 62))
    const form = element('form', rect(0, 0, 390, 100))
    form.append(search, clear)
    body.append(form)
    const reading = readingOf(read(false, search, clear))
    assert.deepEqual(reading.targets, [{ count: 1, node: 2, inner: [] }, { count: 1, node: 3, inner: [] }])
    assert.deepEqual(reading.nodes.map((node) => [node.parent, node.field]), [[-1, false], [0, false], [1, true], [1, false]])
    const look = measureLayout(reading, false)
    assert.equal(look.nesting, undefined)
    assert.deepEqual(look.targets.map((target) => target.element?.field), [true, false])
  })

  test('an element outside the body, or the body itself, is found and not measured', () => {
    const { html, body, read } = page()
    const reading = readingOf(read(false, body, html))
    assert.deepEqual(reading.targets, [{ count: 1, node: null, inner: [] }, { count: 1, node: null, inner: [] }])
    assert.deepEqual(reading.nodes, [])
  })

  test("reads the page's widths and overflow as the page has them", () => {
    const { html, body, read } = page()
    Object.assign(html.sizes, { clientWidth: 375, scrollWidth: 1024 })
    Object.assign(body.style, { overflowX: 'hidden' })
    const reading = readingOf(read(false))
    assert.deepEqual(reading.page, { width: 390, height: 844, edge: 375, scrollWidth: 1024, rootOverflowX: 'visible', bodyOverflowX: 'hidden' })
    assert.equal(measureLayout(reading, false).hidesSideways, true)
  })
})
