import type { FakeElement, FakePage } from './browser-fake-page.ts'
import type { BrowserCommand, DispatchedCommand } from '../../src/browser/contract.ts'
import type { Readiness } from '../../src/browser/element-queries.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { waitUntilActionable } from '../../src/browser/actionability.ts'
import { dispatchPinned } from '../../src/browser/element-queries.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { locatorsArguments } from '../../src/browser/locate.ts'
import { checkedFunction, keyedObserveFunction, observeFunction, prepareFunction, selectionFunction } from '../../src/browser/page-scripts.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { FakeInput, FakeOption, FakeSelect, fakePage, oneElement } from './browser-fake-page.ts'
import { scriptedSession } from './browser-fixtures.ts'

// Element identity in the shared page code every engine runs: the keyed look, the pinned readying look, the arguments
// of several locators in one call, and the pin a driver's `dispatchTo` puts around its own dispatch. The real engines
// run it in tests/integration/agent-identity.test.ts.

// An element showing `text`, as one text node of its own.
function shown(page: FakePage, testId: string, text: string): FakeElement {
  return Object.assign(page.element(testId), { childNodes: [{ data: text }] })
}

// A query whose step takes `count` of the elements passed after the queries, from `from`, keeping `pick`.
function taking(from: number, count: number, pick: number | null = null): unknown {
  return { steps: [{ by: 'elements', from, count, pick }] }
}

type KeyedAnswer = { reads: { observation: { items: unknown[] }; keys: string[] }[]; page: unknown }

function keyed(page: FakePage, limit: number, queries: unknown[], ...elements: FakeElement[]): KeyedAnswer {
  const answer = page.call(keyedObserveFunction, limit, queries, ...elements)
  assert.ok(isKeyedAnswer(answer), JSON.stringify(answer))
  return answer
}

function isKeyedAnswer(value: unknown): value is KeyedAnswer {
  return typeof value === 'object' && value !== null && 'reads' in value && Array.isArray(value.reads)
}

describe('the keyed look', () => {
  test('reads each locator exactly as observe reads it, all in one call, and keys every element it lists', () => {
    const page = fakePage()
    const first = shown(page, 'row-1', 'Delete')
    const second = shown(page, 'row-2', 'Delete')
    const answer = keyed(page, 100, [taking(0, 2), taking(2, 1)], first, second, second)
    assert.deepEqual(answer.reads[0]?.observation, observationIn(page.call(observeFunction, 100, taking(0, 2), first, second)))
    assert.deepEqual(answer.reads[1]?.observation, observationIn(page.call(observeFunction, 100, oneElement, second)))
    assert.deepEqual(answer.page, { href: 'http://app.test/start?token=1', title: 'Fake page' })
    const [both, alone] = answer.reads
    assert.ok(both !== undefined && alone !== undefined)
    assert.equal(both.keys.length, 2)
    assert.notEqual(both.keys[0], both.keys[1], 'two elements that show the same have two keys')
    assert.deepEqual(alone.keys, [both.keys[1]], 'the same node has the same key in every query of the call')
  })

  test('gives a node the same key in every later look at the document, and only as many keys as it lists elements', () => {
    const page = fakePage()
    const first = shown(page, 'f-1', '')
    const second = shown(page, 'f-2', '')
    const before = keyed(page, 100, [taking(0, 2)], first, second).reads[0]?.keys
    const after = keyed(page, 100, [taking(0, 2)], first, second).reads[0]?.keys
    const alone = keyed(page, 100, [taking(0, 1)], second).reads[0]?.keys
    assert.ok(before !== undefined)
    assert.deepEqual(after, before, 'a later look keys the same nodes alike')
    assert.deepEqual(alone, [before[1]], 'listed at another place, a node keeps its own key')
    const cut = keyed(page, 1, [taking(0, 2)], first, second).reads[0]
    assert.deepEqual([cut?.observation.items.length, cut?.keys], [1, [before[0]]])
  })

  test('gives no key of one document to a node of another', () => {
    const one = fakePage()
    const other = fakePage()
    const [key] = keyed(one, 100, [taking(0, 1)], shown(one, 'save', 'Save')).reads[0]?.keys ?? []
    const [otherKey] = keyed(other, 100, [taking(0, 1)], shown(other, 'save', 'Save')).reads[0]?.keys ?? []
    assert.ok(key !== undefined && otherKey !== undefined)
    assert.notEqual(key.split('-')[0], otherKey.split('-')[0], "each document's world draws a token of its own")
  })

  test('names the query of a CSS selector the page could not read', () => {
    const page = fakePage()
    Object.assign(page.document, {
      querySelectorAll: () => {
        throw new DOMException("'::nope' is not a valid selector.", 'SyntaxError')
      },
    })
    const answer = page.call(keyedObserveFunction, 100, [taking(0, 0), { steps: [{ by: 'css', selector: '::nope', pick: null }] }])
    assert.deepEqual(typeof answer === 'object' && answer !== null && 'invalid' in answer ? answer.invalid : undefined, { step: 0, message: "'::nope' is not a valid selector." })
    assert.equal(typeof answer === 'object' && answer !== null && 'query' in answer ? answer.query : undefined, 1)
  })
})

describe('the readying look pinned to one node', () => {
  test('readies the node its key names', async () => {
    const page = fakePage()
    const field = shown(page, 'f-1', '')
    const [key] = keyed(page, 100, [taking(0, 1)], field).reads[0]?.keys ?? []
    const readiness = await page.call(prepareFunction, { action: 'press', strokes: 1, element: key }, oneElement, field)
    assert.equal(statusOf(readiness), 'ready')
    assert.equal(page.document.activeElement, field)
  })

  test('answers moved for another node in its place, before it focuses, arms or settles anything', async () => {
    const page = fakePage()
    const first = shown(page, 'f-1', '')
    const second = shown(page, 'f-2', '')
    const [firstKey] = keyed(page, 100, [taking(0, 2)], first, second).reads[0]?.keys ?? []
    assert.deepEqual(await page.call(prepareFunction, { action: 'fill', multiline: false, origins: null, element: firstKey }, oneElement, second), { status: 'moved' })
    assert.equal(page.document.activeElement, null, 'nothing took the focus')
    assert.equal(page.dispatch('keydown', second).stopped, true, 'no guard was armed for it, so typing there is stopped as stray')
    assert.deepEqual(await page.call(prepareFunction, { action: 'press', strokes: 1, element: 'never-a-key' }, oneElement, first), { status: 'moved' })
  })

  test('answers moved for a key read in an earlier document, even on a node that shows the same', async () => {
    const earlier = fakePage()
    const [key] = keyed(earlier, 100, [taking(0, 1)], shown(earlier, 'save', 'Save')).reads[0]?.keys ?? []
    const now = fakePage()
    const save = shown(now, 'save', 'Save')
    keyed(now, 100, [taking(0, 1)], save)
    assert.deepEqual(await now.call(prepareFunction, { action: 'press', strokes: 1, element: key }, oneElement, save), { status: 'moved' })
  })

  test('without a key, readies as it always did', async () => {
    const page = fakePage()
    const field = shown(page, 'f-1', '')
    assert.equal(statusOf(await page.call(prepareFunction, { action: 'press', strokes: 1 }, oneElement, field)), 'ready')
  })
})

describe('the reads that confirm a pinned action', () => {
  // A checkbox and a select, each with a twin that shows the same, keyed by one look.
  function twins(page: FakePage): { first: FakeInput; second: FakeInput; keys: readonly string[] } {
    const first = Object.assign(new FakeInput(page.document, 'checkbox', { 'data-testid': 'box-1' }), { childNodes: [] })
    const second = Object.assign(new FakeInput(page.document, 'checkbox', { 'data-testid': 'box-2' }), { childNodes: [] })
    const keys = keyed(page, 100, [taking(0, 2)], first, second).reads[0]?.keys ?? []
    return { first, second, keys }
  }

  test("read whether the pinned checkbox is checked, and never another's in its place", () => {
    const page = fakePage()
    const { first, second, keys } = twins(page)
    first.checked = true
    const pinned = (key: string | undefined) => ({ steps: [{ by: 'elements', from: 0, count: 1, pick: null }], element: key })
    assert.equal(page.call(checkedFunction, pinned(keys[1]), second), false, 'the pinned box, unchecked')
    assert.equal(page.call(checkedFunction, pinned(keys[1]), first), null, 'another box at its place says nothing, though it is checked')
    assert.equal(page.call(checkedFunction, oneElement, first), true, 'unpinned, the read is as it was')
  })

  test("read the pinned select's options, and call another select in its place lost", () => {
    const page = fakePage()
    const options = () => [new FakeOption(page.document, 'Ann', 'ann'), new FakeOption(page.document, 'Bob', 'bob')]
    const mine = Object.assign(new FakeSelect(page.document, options(), false), { childNodes: [] })
    const other = Object.assign(new FakeSelect(page.document, options(), false), { childNodes: [] })
    const [, otherBob] = other.options
    assert.ok(otherBob !== undefined)
    otherBob.selected = true
    const [mineKey] = keyed(page, 100, [taking(0, 1)], mine).reads[0]?.keys ?? []
    keyed(page, 100, [taking(0, 1)], other)
    const pinned = { steps: [{ by: 'elements', from: 0, count: 1, pick: null }], element: mineKey }
    const read = (select: FakeSelect, query: unknown) => page.call(selectionFunction, [{ label: 'Bob' }], query, select)
    assert.deepEqual(read(other, pinned), { status: 'lost', selected: [], page: { href: 'http://app.test/start?token=1', title: 'Fake page' } }, 'another select holding Bob confirms nothing')
    assert.equal(statusOf(read(mine, pinned)), 'other', 'the pinned select does not hold Bob')
    assert.equal(statusOf(read(other, oneElement)), 'selected', 'unpinned, the read is as it was')
  })
})

describe('the pin a driver puts around its dispatch', () => {
  // A page whose every readying look answers `readiness`, keeping the arguments of each call.
  function world(readiness: Readiness, sent: unknown[]): IsolatedWorld {
    const { session } = scriptedSession((method, params) => {
      if (method === 'Page.createIsolatedWorld') return Promise.resolve({ executionContextId: 7 })
      sent.push(params)
      return Promise.resolve({ result: { value: readiness } })
    })
    return new IsolatedWorld(session, () => 'F1')
  }

  const save: LocatorRecipe = { by: 'testId', value: 'save' }
  const notReady: Readiness = { status: 'blocked', check: 'visible', detail: null }
  const elementOf = (params: unknown): unknown => {
    const args = typeof params === 'object' && params !== null && 'arguments' in params && Array.isArray(params.arguments) ? params.arguments : []
    const [intent] = args
    return typeof intent === 'object' && intent !== null && 'value' in intent && typeof intent.value === 'object' && intent.value !== null && 'element' in intent.value ? intent.value.element : undefined
  }

  test('reaches every readying look of the command it wraps, and no look of another command', async () => {
    const pinnedSent: unknown[] = []
    const plainSent: unknown[] = []
    const looking = (sent: unknown[]) => waitUntilActionable({ world: world(notReady, sent), locator: save, intent: { action: 'click', multiline: false }, deadline: new Deadline(120), pendingNavigation: () => undefined })
    const pinned = dispatchPinned({ kind: 'click', locator: save }, 'k-7', async (): Promise<DispatchedCommand> => {
      const target = await looking(pinnedSent)
      return { result: { ok: false, failure: target.ok ? { class: 'test_error', message: 'The fake look was ready.' } : target.failure }, input: 'not_sent' }
    })
    const plain = looking(plainSent)
    await Promise.all([pinned, plain])
    assert.ok(pinnedSent.length > 1 && plainSent.length > 1, 'both waited through several looks')
    assert.deepEqual(new Set(pinnedSent.map(elementOf)), new Set(['k-7']))
    assert.deepEqual(new Set(plainSent.map(elementOf)), new Set([undefined]))
  })

  test('a look that answers moved fails the command at once, as not actionable, with no input sent', async () => {
    const sent: unknown[] = []
    const target = await waitUntilActionable({ world: world({ status: 'moved' }, sent), locator: save, intent: { action: 'click', multiline: false }, deadline: new Deadline(1000), pendingNavigation: () => undefined })
    assert.ok(!target.ok)
    assert.deepEqual(target.failure, {
      class: 'not_actionable',
      message: "Could not click getByTestId('save'): it finds another element than the one Retest was asked to act on, which the page moved or replaced, and Retest sent nothing to it.",
      details: { refused: 'moved', inputSent: false },
    })
    assert.equal(sent.length, 1, 'one look, and no wait for the node to come back')
  })

  test('refuses a command that names no element, and calls nothing', async () => {
    let called = 0
    const dispatch = (): Promise<DispatchedCommand> => {
      called += 1
      return Promise.resolve({ result: { ok: false, failure: { class: 'test_error', message: 'The dispatch was called.' } }, input: 'not_sent' })
    }
    const commands: BrowserCommand[] = [{ kind: 'press', key: 'Enter' }, { kind: 'goto', url: '/' }, { kind: 'observe', locator: save }]
    for (const command of commands) {
      const answer = await dispatchPinned(command, 'k-1', dispatch)
      assert.equal(answer.input, 'not_sent')
      assert.equal(answer.result.ok ? undefined : answer.result.failure.class, 'usage', command.kind)
    }
    assert.equal(called, 0)
  })
})

describe('the arguments of several locators', () => {
  test('put every query in one list, in order, after the values', () => {
    assert.deepEqual(locatorsArguments([{ by: 'testId', value: 'save' }, { by: 'css', selector: 'form', dialect: 'playwright' }], [100]), [
      100,
      [{ steps: [{ by: 'testId', value: 'save', pick: null }] }, { steps: [{ by: 'css', selector: 'form', pick: null }], shadow: 'refused' }],
    ])
  })

  test("count each locator's role elements after those of the locators before it", async () => {
    const { session } = scriptedSession((method, params) => {
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { objectId: 'document' } })
      if (method === 'DOM.resolveNode') {
        const id = typeof params === 'object' && params !== null && 'backendNodeId' in params ? params.backendNodeId : 0
        return Promise.resolve({ object: { objectId: `element-${String(id)}` } })
      }
      const role = typeof params === 'object' && params !== null && 'role' in params ? params.role : undefined
      const nodes = role === 'button' ? [{ ignored: false, name: { value: 'Delete' }, backendDOMNodeId: 1 }, { ignored: false, name: { value: 'Delete' }, backendDOMNodeId: 2 }] : []
      return Promise.resolve({ nodes })
    })
    const args = locatorsArguments([{ by: 'role', role: 'button' }, { by: 'testId', value: 'row-2' }, { by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'row-2' }] }], [100])
    assert.equal(typeof args, 'function')
    const built = typeof args === 'function' ? await args({ session, context: 7, objectGroup: 'g' }, new Deadline(1000)) : []
    assert.deepEqual(built, [
      { value: 100 },
      {
        value: [
          { steps: [{ by: 'elements', from: 0, count: 2, pick: null }] },
          { steps: [{ by: 'testId', value: 'row-2', pick: null }] },
          { steps: [{ by: 'testId', value: 'row-2', pick: null }, { by: 'elements', from: 2, count: 2, pick: null }] },
        ],
      },
      { objectId: 'element-1' },
      { objectId: 'element-2' },
      { objectId: 'element-1' },
      { objectId: 'element-2' },
    ])
  })
})

function observationIn(observed: unknown): unknown {
  return typeof observed === 'object' && observed !== null && 'observation' in observed ? observed.observation : undefined
}

function statusOf(readiness: unknown): unknown {
  return typeof readiness === 'object' && readiness !== null && 'status' in readiness ? readiness.status : undefined
}
