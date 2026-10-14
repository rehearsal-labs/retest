import type { TestContext } from 'node:test'
import type { OwnedPage } from '../../src/browser/contract.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { DeclaredValue } from './engine-expectations.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assertOk,
  byLabel,
  byRole,
  byTestId,
  byText,
  check,
  click,
  fill,
  goto,
  observe,
  observeUntil,
  openApp,
  openPage,
  press,
  scroll,
  select,
  sharedBrowser,
} from './browser-harness.ts'
import { engineExpectations } from './engine-expectations.ts'

// Every finder against the shadow checkout fixture, whose controls and text live in open shadow roots nested two deep,
// with slots and one closed root: what each finder finds through the roots, in the order the page shows them, and each
// action on an element inside a root, with the status line the page writes as proof of what arrived. Role and label
// read the browser's accessibility tree, which is each engine's own, so their cases assert through the engine's
// declared outcome; every other case is the same on every engine. The shared browser is closed and its process group
// checked after the last test.

const browser = sharedBrowser()

const engineCase = engineExpectations('browser-shadow-dom')

async function shadowPage(t: TestContext): Promise<OwnedPage> {
  const app = await openApp(t)
  const page = await openPage(t, browser(), app.url)
  assertOk(await goto(page, '/shadow'))
  return page
}

async function texts(page: OwnedPage, locator: LocatorRecipe): Promise<string[]> {
  return (await observe(page, locator)).items.map((item) => item.text.trim())
}

async function count(page: OwnedPage, locator: LocatorRecipe): Promise<number> {
  return (await observe(page, locator)).count
}

// A look's matches by their text, or the failure that refused it, as a declared outcome holds it.
async function lookup(page: OwnedPage, locator: LocatorRecipe): Promise<DeclaredValue> {
  const result = await page.execute({ kind: 'observe', locator }, 2000)
  if (!result.ok) return { class: result.failure.class, message: result.failure.message }
  assert.equal(result.kind, 'observe')
  return result.observation.items.map((item) => item.text.trim())
}

const css = (selector: string): LocatorRecipe => ({ by: 'css', selector })
const status = byTestId('status')
const buyStatus = byTestId('buy-status')

// A click, and then the line the page writes once the click reached it, or the failure that refused it.
async function clickAndRead(page: OwnedPage, locator: LocatorRecipe, expected: string): Promise<DeclaredValue> {
  const clicked = await click(page, locator)
  if (!clicked.ok) return { class: clicked.failure.class, message: clicked.failure.message }
  return (await observeUntil(page, buyStatus, (seen) => seen.text === expected)).text
}

test('role and label find through open shadow roots, two deep, and never into a closed one', async (t) => {
  const page = await shadowPage(t)
  const observed = {
    buttons: await lookup(page, byRole('button')),
    ariaLabel: await lookup(page, byRole('button', 'Close panel')),
    labelFor: await lookup(page, byLabel('Coupon')),
    twoDeep: await lookup(page, byLabel('Card number')),
    acrossRoots: await lookup(page, byLabel('Outside name')),
    closed: await lookup(page, byRole('button', 'Sealed button')),
    scoped: await lookup(page, { by: 'role', role: 'button', name: 'Pay', within: [byTestId('panel')] }),
  }
  engineCase.assertOutcome(t, observed, {
    buttons: ['Pay', 'x', 'Covered', 'Help', '', ''],
    ariaLabel: ['x'],
    labelFor: [''],
    twoDeep: [''],
    acrossRoots: [],
    closed: [],
    scoped: ['Pay'],
  })
})

test('an action by label on a field inside a shadow root', async (t) => {
  const page = await shadowPage(t)
  const filled = await fill(page, byLabel('Card number'), '4242')
  const observed: DeclaredValue = filled.ok ? (await observe(page, byTestId('card'))).value : { class: filled.failure.class, message: filled.failure.message }
  engineCase.assertOutcome(t, observed, '4242')
})

test('test id, text and placeholder find through open shadow roots, and count matches across roots', async (t) => {
  const page = await shadowPage(t)
  assert.deepEqual(await texts(page, byTestId('task')), ['Task one', 'Task two', 'Task three'], 'two items in roots of their own around one in the document')
  assert.deepEqual(await texts(page, byText('Checkout')), ['Checkout'])
  assert.deepEqual(await texts(page, byTestId('total')), ['$42.00'])
  assert.equal(await count(page, { by: 'placeholder', text: 'Coupon code' }), 1)
  assert.equal(await count(page, byTestId('unnamed')), 1)
})

test('a host’s text is its own children’s and then its root’s, as Playwright reads it, and a slot holds none of it', async (t) => {
  const page = await shadowPage(t)
  assert.deepEqual(await texts(page, byTestId('info')), ['ShippingFree over $50Note:'])
  assert.deepEqual(await texts(page, byText('Shipping')), ['Shipping'])
  assert.deepEqual(await texts(page, byText('Note:', false)), ['Note:'], 'the heading in the root, without the title its slot shows')
})

test('text a slot shows is found on the element that holds it, which is visible and takes a click', async (t) => {
  const page = await shadowPage(t)
  const payNow = await observe(page, byText('Pay now'))
  assert.equal(payNow.count, 1)
  assert.equal(payNow.visible, true, "the host's own box, which its root's button fills")
  assert.equal(await count(page, { by: 'css', selector: 'button', within: [byText('Pay now')] }), 1, 'the match is the host, whose root holds the button')
  assert.deepEqual(await texts(page, byText('Refund')), ['Refund'])
  assert.equal(await clickAndRead(page, byText('Pay now'), 'Pressed Pay now'), 'Pressed Pay now')
  assert.equal(await clickAndRead(page, byText('Refund'), 'Pressed Refund'), 'Pressed Refund')
})

test('a button that shows its host’s text or element through a slot takes a click found by its role', async (t) => {
  const page = await shadowPage(t)
  const observed = {
    payNow: await clickAndRead(page, byRole('button', 'Pay now'), 'Pressed Pay now'),
    refund: await clickAndRead(page, byRole('button', 'Refund'), 'Pressed Refund'),
  }
  engineCase.assertOutcome(t, observed, { payNow: 'Pressed Pay now', refund: 'Pressed Refund' })
})

test('CSS crosses open shadow roots one compound selector at a time, and an invalid selector is still refused', async (t) => {
  const page = await shadowPage(t)
  assert.deepEqual(await texts(page, css('checkout-panel button.primary')), ['Pay'])
  assert.equal(await count(page, css('card-field > input')), 1, 'a child combinator crosses into the host')
  assert.equal(await count(page, css('checkout-panel input[aria-label="Card number"]')), 1, 'a descendant combinator crosses two roots')
  assert.equal(await count(page, css('li > .task-name, li.task-name')), 1, 'a list of selectors, each read on its own')
  assert.equal(await count(page, css('.task-name')), 3)
  const invalid = await page.execute({ kind: 'observe', locator: css('checkout-panel ::nope') }, 2000)
  assert.equal(invalid.ok ? 'passed' : invalid.failure.class, 'usage')
})

test('a step inside another finds through the roots of the elements the step before kept', async (t) => {
  const page = await shadowPage(t)
  const panel = byTestId('panel')
  assert.deepEqual(await texts(page, { by: 'css', selector: 'button.primary', within: [panel] }), ['Pay'], 'a scope that starts outside a root and ends inside it')
  assert.deepEqual(await texts(page, { by: 'text', text: 'Checkout', within: [panel] }), ['Checkout'])
  assert.deepEqual(await texts(page, { by: 'testId', value: 'task', within: [byTestId('tasks')] }), ['Task one', 'Task two', 'Task three'])
  assert.equal(await count(page, { by: 'testId', value: 'card', within: [css('card-field')] }), 1, "a host's own root is inside it")
  assert.equal(await count(page, { by: 'testId', value: 'task', within: [panel] }), 0, 'nothing of another host')
})

test('a closed shadow root stays invisible to test id, text and CSS', async (t) => {
  const page = await shadowPage(t)
  assert.equal(await count(page, byTestId('sealed')), 0)
  assert.equal(await count(page, byText('Sealed text')), 0)
  assert.equal(await count(page, css('secret-box button')), 0)
  assert.equal(await count(page, byTestId('secret')), 1, 'its host is in the document')
})

test('fill, click, check, select and press reach elements inside open shadow roots, and the page heard each', async (t) => {
  const page = await shadowPage(t)
  assertOk(await fill(page, byTestId('card'), '4242'))
  assertOk(await fill(page, byTestId('coupon'), 'SAVE10'))
  assertOk(await click(page, byTestId('pay')))
  await observeUntil(page, status, (seen) => seen.text === 'Paid with card 4242 and coupon SAVE10')
  assertOk(await check(page, byTestId('gift')))
  await observeUntil(page, status, (seen) => seen.text === 'Gift wrapped')
  assert.equal((await observe(page, byTestId('gift'))).checked, true)
  assertOk(await select(page, byTestId('speed'), 'Express', 5000))
  await observeUntil(page, status, (seen) => seen.text === 'Delivery Express')
  assertOk(await press(page, byTestId('coupon'), 'Enter'))
  await observeUntil(page, status, (seen) => seen.text === 'Coupon applied')
})

test('hover and scroll reach elements inside open shadow roots', async (t) => {
  const page = await shadowPage(t)
  assertOk(await page.execute({ kind: 'hover', locator: byTestId('tip') }, 2000))
  await observeUntil(page, byTestId('tip-status'), (seen) => seen.text === 'Tip shown')
  assertOk(await scroll(page, byTestId('feed'), { y: 100 }))
  await observeUntil(page, byTestId('feed-status'), (seen) => seen.text === 'Scrolled')
})

test('a click on a button inside a root that an element of the root covers is refused, naming that element', async (t) => {
  const page = await shadowPage(t)
  const covered = await click(page, byTestId('covered'), 600)
  assert.ok(!covered.ok, JSON.stringify(covered))
  assert.equal(covered.failure.class, 'not_actionable')
  assert.deepEqual(covered.failure.details, { check: 'hit-target', covering: '<span data-testid="overlay">', waitedMs: 600 })
})
