import type { TestContext } from 'node:test'
import type { OwnedBrowser, OwnedPage, PageNavigation } from '../../src/browser/contract.ts'
import type { TaskApp } from '../../fixtures/task-app/server.ts'
import type { FrameRecipe, LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  assertOk,
  byLabel,
  byRole,
  byTestId,
  check,
  click,
  failureOf,
  fill,
  goto,
  launchGated,
  observe,
  observeUntil,
  openApp,
  openPage,
  press,
  scratchFolder,
  scroll,
  select,
  sharedBrowser,
  timed,
} from './browser-harness.ts'

// Locators inside frames against the frames fixture: an order form in a frame of the page's own origin, a notes frame
// inside it, a payment form in a frame of another site, which Chrome runs in a process of its own, a receipt frame a
// button removes and adds again, a receipt in a hidden element, a frame drawn at half its size, a frame of slow steps,
// and a help frame inside an open shadow root. Each action is proven by what the page, or its server, says arrived.
// The shared browser is closed and its process group checked after the last test.

const browser = sharedBrowser()

const order: FrameRecipe[] = [{ by: 'css', selector: 'iframe[title="Order form"]' }]
const notes: FrameRecipe[] = [...order, { by: 'css', selector: 'iframe' }]
const payment: FrameRecipe[] = [{ by: 'css', selector: 'iframe[title="Secure payment"]' }]
const receipt: FrameRecipe[] = [{ by: 'css', selector: 'iframe[title="Receipt"]' }]
const help: FrameRecipe[] = [{ by: 'css', selector: 'help-panel iframe' }]
const hiddenReceipt: FrameRecipe[] = [{ by: 'testId', value: 'hidden-frame' }]
const sides: FrameRecipe[] = [{ by: 'testId', value: 'scaled-frame' }]
const steps: FrameRecipe[] = [{ by: 'testId', value: 'steps-frame' }]

const inFrame = (path: FrameRecipe[], locator: LocatorRecipe): LocatorRecipe => ({ ...locator, frame: path })

// What `promise` gives, or a failure that says `what` once `ms` pass without it.
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(what)), ms)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}

type Checkout = { page: OwnedPage; app: TaskApp; paymentOrigin: string }

// The payment form comes from a second app, addressed as localhost: another site than 127.0.0.1, so Chrome runs it in a
// process of its own.
async function checkoutPage(t: TestContext, on: OwnedBrowser = browser()): Promise<Checkout> {
  const app = await openApp(t)
  const other = await openApp(t)
  const paymentOrigin = other.url.replace('127.0.0.1', 'localhost')
  const page = await openPage(t, on, app.url)
  assertOk(await goto(page, `/frames?payment=${encodeURIComponent(paymentOrigin)}`))
  return { page, app, paymentOrigin }
}

test('the payment frame runs in a process of its own, as a target of its own, and the order frame does not', async (t) => {
  const attached: string[] = []
  const gated = await launchGated(t, {
    watch(message) {
      const params = message['params']
      if (message['method'] !== 'Target.attachedToTarget' || typeof params !== 'object' || params === null) return
      const info: unknown = Reflect.get(params, 'targetInfo')
      if (typeof info === 'object' && info !== null && Reflect.get(info, 'type') === 'iframe') attached.push(String(Reflect.get(info, 'url')))
    },
  })
  const { page, paymentOrigin } = await checkoutPage(t, gated)
  assert.equal((await observe(page, inFrame(payment, byLabel('Card number')))).count, 1)
  assert.equal((await observe(page, inFrame(order, byLabel('Name')))).count, 1)
  assert.deepEqual(attached, [`${paymentOrigin}/frames/payment`], 'the browser attached Retest to the payment frame alone, as a frame of another process')
})

test('a look by role and label finds inside a frame of another site that is out of view, without scrolling to it', async (t) => {
  const { page } = await checkoutPage(t)
  const frameTop = async (): Promise<{ top: number | undefined; height: number }> => {
    const look = await page.execute({ kind: 'observeLayout', locator: byTestId('payment-frame') }, 2000)
    assert.ok(look.ok && look.kind === 'observeLayout', JSON.stringify(look))
    return { top: look.observation.targets[0]?.element?.box.top, height: look.observation.viewport.height }
  }
  const before = await frameTop()
  assert.ok(before.top !== undefined && before.top > before.height, `the payment frame starts below the view, at ${before.top}`)
  assert.deepEqual((await observe(page, inFrame(payment, byRole('button', 'Pay')))).items, [{ text: 'Pay', visible: true }])
  assert.equal((await observe(page, inFrame(payment, byLabel('Card number')))).count, 1)
  assert.deepEqual(await frameTop(), before, 'the page was not scrolled')
})

test('fill, check, select, click, hover, scroll and press reach a frame of the same origin, and its server answers what arrived', async (t) => {
  const { page } = await checkoutPage(t)
  assertOk(await fill(page, inFrame(order, byLabel('Name')), 'Ada'))
  assertOk(await check(page, inFrame(order, byLabel('Express'))))
  assertOk(await select(page, inFrame(order, byLabel('Size')), 'Large', 5000))
  assertOk(await click(page, inFrame(order, byRole('button', 'Save order'))))
  await observeUntil(page, inFrame(order, byTestId('order-status')), (seen) => seen.text === 'Saved Large order for Ada, express true')
  assertOk(await page.execute({ kind: 'hover', locator: inFrame(order, byTestId('hover')) }, 2000))
  await observeUntil(page, inFrame(order, byTestId('hover-status')), (seen) => seen.text === 'Hovered')
  assertOk(await scroll(page, inFrame(order, byTestId('list')), { y: 100 }))
  await observeUntil(page, inFrame(order, byTestId('scroll-status')), (seen) => seen.text === 'Scrolled')
  assertOk(await press(page, inFrame(order, byLabel('Name')), 'Enter'))
  await observeUntil(page, inFrame(order, byTestId('key-status')), (seen) => seen.text === 'Enter pressed')
})

test('on a touch screen, a tap and a check reach a frame of the same origin and one of another site', async (t) => {
  const app = await openApp(t)
  const other = await openApp(t)
  const touch = { emulation: { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1, touch: true, isMobile: false } }
  const page = await openPage(t, browser(), app.url, touch)
  assertOk(await goto(page, `/frames?payment=${encodeURIComponent(other.url.replace('127.0.0.1', 'localhost'))}`))
  assertOk(await page.execute({ kind: 'tap', locator: inFrame(order, byRole('button', 'Save order')) }, 2000))
  await observeUntil(page, inFrame(order, byTestId('order-status')), (seen) => seen.text === 'Saved Small order for , express false')
  const checked = await check(page, inFrame(payment, byLabel('I agree to the terms')))
  assert.ok(checked.ok && checked.kind === 'check', JSON.stringify(checked))
  assert.equal((await observe(page, inFrame(payment, byLabel('I agree to the terms')))).checked, true)
})

test('a frame inside a frame takes typing and a click', async (t) => {
  const { page } = await checkoutPage(t)
  assertOk(await fill(page, inFrame(notes, byLabel('Note')), 'Leave at the door'))
  assertOk(await click(page, inFrame(notes, byRole('button', 'Add note'))))
  await observeUntil(page, inFrame(notes, byTestId('note-status')), (seen) => seen.text === 'Note: Leave at the door')
})

test('a frame of another site takes fill, select, check, hover, scroll and press, and its post is no navigation of the page', async (t) => {
  const { page } = await checkoutPage(t)
  const navigations: PageNavigation[] = []
  const stop = page.onNavigation((navigation) => navigations.push(navigation))
  t.after(stop)
  assertOk(await fill(page, inFrame(payment, byLabel('Card number')), '4242 4242 4242 4242'))
  assertOk(await select(page, inFrame(payment, byLabel('Plan')), 'Yearly', 5000))
  assertOk(await check(page, inFrame(payment, byLabel('I agree to the terms'))))
  assertOk(await page.execute({ kind: 'hover', locator: inFrame(payment, byTestId('hint')) }, 2000))
  await observeUntil(page, inFrame(payment, byTestId('hint-status')), (seen) => seen.text === 'Hint shown')
  assertOk(await scroll(page, inFrame(payment, byTestId('terms-text')), { y: 100 }))
  await observeUntil(page, inFrame(payment, byTestId('terms-status')), (seen) => seen.text === 'Terms read')
  assertOk(await press(page, inFrame(payment, byLabel('Card number')), 'Tab'))
  await observeUntil(page, inFrame(payment, byTestId('press-status')), (seen) => seen.text === 'Tab pressed')
  assertOk(await click(page, inFrame(payment, byRole('button', 'Pay'))))
  await observeUntil(page, inFrame(payment, byTestId('paid')), (seen) => seen.text === 'Paid with card ending 4242 on the Yearly plan, terms yes')
  assert.deepEqual(navigations, [], 'the frame opened its answer, and the page stayed on its document')
})

test('a secret is typed into a frame only when its origin is one the secret may reach', async (t) => {
  const { page, app, paymentOrigin } = await checkoutPage(t)
  const card = inFrame(payment, byLabel('Card number'))
  const refused = failureOf(await page.execute({ kind: 'fill', locator: card, value: '4242', secret: 'card', allowedOrigins: [app.url] }, 2000))
  assert.equal(refused.class, 'not_actionable')
  assert.match(refused.message, new RegExp(paymentOrigin.replace(/[.:/]/g, '\\$&')))
  assert.equal((await observe(page, card)).value, '', 'nothing was typed')
  assertOk(await page.execute({ kind: 'fill', locator: card, value: '4242', secret: 'card', allowedOrigins: [app.url, paymentOrigin] }, 2000))
  assert.equal((await observe(page, card)).value, '4242')
})

test('a layout look measures an element inside a frame, in the frame’s own document', async (t) => {
  const { page } = await checkoutPage(t)
  const look = await page.execute({ kind: 'observeLayout', locator: inFrame(order, byTestId('clipped')), words: true }, 2000)
  assert.ok(look.ok && look.kind === 'observeLayout', JSON.stringify(look))
  const element = look.observation.targets[0]?.element
  assert.equal(element?.shown, true)
  assert.ok((element?.cut ?? 0) > 0, `the label's words are cut off, by ${element?.cut ?? 'no'} pixels`)
  const apart = failureOf(await page.execute({ kind: 'observeLayout', locator: inFrame(order, byTestId('clipped')), other: byTestId('top-status') }, 2000))
  assert.equal(apart.class, 'usage')
})

test('a frame removed and added again is found again, and a look meanwhile finds no frame, naming it', async (t) => {
  const { page } = await checkoutPage(t)
  const shown = inFrame(receipt, byTestId('receipt'))
  assert.equal((await observe(page, shown)).text, 'Receipt 1001')
  assertOk(await click(page, byTestId('receipt-toggle')))
  const gone = await observeUntil(page, shown, (seen) => seen.count === 0)
  assert.deepEqual(gone.emptyStep, { frame: 0, step: 0, matched: 0 })
  assertOk(await click(page, byTestId('receipt-toggle')))
  await observeUntil(page, shown, (seen) => seen.text === 'Receipt 1001')
})

test('an action in a frame that is gone fails not_found, naming the frame, once its time runs out', async (t) => {
  const { page } = await checkoutPage(t)
  const { value: result, ms } = await timed(click(page, inFrame([{ by: 'css', selector: 'iframe#gone' }], byRole('button', 'Pay')), 800))
  const failure = failureOf(result)
  assert.equal(failure.class, 'not_found')
  assert.equal(failure.message, `Could not click frame(locator('iframe#gone')).getByRole('button', { name: 'Pay' }): no element matched within 800 ms. frame(locator('iframe#gone')) found no frame.`)
  assert.ok(ms >= 800, `waited ${ms} ms`)
})

test('a frame whose element is not a frame fails usage at once, and one that matches several fails ambiguous at once', async (t) => {
  const { page } = await checkoutPage(t)
  const { value: notFrame, ms } = await timed(click(page, inFrame([{ by: 'testId', value: 'not-a-frame' }], byRole('button', 'Pay')), 3000))
  assert.deepEqual(failureOf(notFrame), {
    class: 'usage',
    message: `Could not click frame(getByTestId('not-a-frame')).getByRole('button', { name: 'Pay' }): frame(getByTestId('not-a-frame')) found <div data-testid="not-a-frame">, which is not a frame. frame() takes the locator of an <iframe> or a <frame>.`,
    details: { frame: 0, element: '<div data-testid="not-a-frame">' },
  })
  assert.ok(ms < 1000, `refused at once, after ${ms} ms`)
  const several = failureOf(await page.execute({ kind: 'observe', locator: inFrame([{ by: 'css', selector: 'iframe' }], byTestId('receipt')) }, 2000))
  assert.equal(several.class, 'ambiguous')
  assert.match(several.message, /frame\(locator\('iframe'\)\) matches 7 elements/)
})

test('a frame inside an open shadow root is found, and takes a click', async (t) => {
  const { page } = await checkoutPage(t)
  assertOk(await click(page, inFrame(help, byRole('button', 'Ask'))))
  await observeUntil(page, inFrame(help, byTestId('help-status')), (seen) => seen.text === 'Question sent')
})

test('a click in a frame that an element of the page covers is refused, naming that element, and sends nothing', async (t) => {
  const { page } = await checkoutPage(t)
  assertOk(await click(page, byTestId('cover-toggle')))
  const covered = failureOf(await click(page, inFrame(order, byRole('button', 'Save order')), 600))
  assert.equal(covered.class, 'not_actionable')
  assert.deepEqual(covered.details, { check: 'hit-target', covering: '<div data-testid="cover">', waitedMs: 600 })
  assert.equal((await observe(page, inFrame(order, byTestId('order-status')))).text, 'Order ready', 'the order frame heard no click')
})

test('an element inside a frame the page hides is hidden to a look, a layout and an action, as an element the page hides is', async (t) => {
  const { page } = await checkoutPage(t)
  const hidden = inFrame(hiddenReceipt, byTestId('receipt'))
  const seen = await observe(page, hidden)
  assert.deepEqual([seen.count, seen.text, seen.visible], [1, 'Receipt 1001', false], 'the frame is inside an element whose visibility is hidden')
  assert.equal((await observe(page, inFrame(receipt, byTestId('receipt')))).visible, true, 'the same document in a frame the page shows is visible')
  const layout = await page.execute({ kind: 'observeLayout', locator: hidden }, 2000)
  assert.ok(layout.ok && layout.kind === 'observeLayout', JSON.stringify(layout))
  assert.equal(layout.observation.targets[0]?.element?.shown, false)
  const failure = failureOf(await click(page, hidden, 600))
  assert.equal(failure.class, 'not_actionable')
  assert.equal(failure.details?.['check'], 'visible')
})

test('a press that an element of the page takes as the mouse reaches a frame is stopped there, before any listener hears it', async (t) => {
  const { page } = await checkoutPage(t)
  const failure = failureOf(await click(page, inFrame(order, byTestId('trap'))))
  assert.equal(failure.class, 'not_actionable')
  assert.deepEqual(failure.details, { check: 'hit-target', interceptedBy: '<div data-testid="cover">', event: 'pointerdown' })
  assert.equal((await observe(page, byTestId('top-status'))).text, 'Top ready', 'the cover heard no click')
  assert.equal((await observe(page, inFrame(order, byTestId('order-status')))).text, 'Order ready', 'the trap heard no click')
})

test('a frame the page draws at half its size takes each click where its button is drawn', async (t) => {
  const { page } = await checkoutPage(t)
  assertOk(await click(page, inFrame(sides, byTestId('left'))))
  await observeUntil(page, inFrame(sides, byTestId('side-status')), (seen) => seen.text === 'left pressed')
  assertOk(await click(page, inFrame(sides, byTestId('right'))))
  await observeUntil(page, inFrame(sides, byTestId('side-status')), (seen) => seen.text === 'right pressed')
})

test('an action waits while a frame on its path opens another document, then acts in that document', async (t) => {
  const { page } = await checkoutPage(t)
  assertOk(await click(page, inFrame(steps, byTestId('next'))))
  assertOk(await click(page, inFrame(steps, byTestId('done')), 5000))
  await observeUntil(page, inFrame(steps, byTestId('step-status')), (seen) => seen.text === 'Done on step 2')
})

// A file picker a button in a frame opens: unwaited, it fails the click and is closed; waited for, it takes a file.
async function pickInFrame(t: TestContext, page: OwnedPage, button: LocatorRecipe, status: LocatorRecipe): Promise<void> {
  const { files } = page
  assert.ok(files !== undefined, 'a Chrome page catches its file pickers')
  const unwaited = failureOf(await click(page, button))
  assert.equal(unwaited.class, 'not_actionable')
  assert.match(unwaited.message, /^The page opened a file picker as Retest went to click frame\(.+\)\.getByRole\('button', \{ name: '.+' \}\), and nothing was waiting for one\. Retest closed the picker\.$/)
  await observeUntil(page, status, (seen) => seen.text === 'Picker closed')
  const arm = files.armFileChooser()
  assertOk(await click(page, button))
  const caught = await within(arm.opened, 2000, 'the frame opened no file picker')
  const path = join(await scratchFolder(t), 'receipt.txt')
  writeFileSync(path, 'Receipt 1001')
  const given = await page.execute({ kind: 'setChooserFiles', chooser: caught.id, files: [{ path, folder: '/' }], paths: [path], mimeTypes: [null] }, 2000)
  assert.ok(given.ok && given.kind === 'setChooserFiles', JSON.stringify(given))
  assert.deepEqual(given.files, [{ name: 'receipt.txt', size: 12, type: 'text/plain' }])
  await observeUntil(page, status, (seen) => seen.text === 'Attached receipt.txt')
}

test('a file picker a frame of another site opens fails a click nothing waited for, and goes to a test that waits for it', async (t) => {
  const { page } = await checkoutPage(t)
  await pickInFrame(t, page, inFrame(payment, byRole('button', 'Attach a receipt')), inFrame(payment, byTestId('attach-status')))
})

test('a file picker a frame of the page’s own origin opens fails a click nothing waited for, and goes to a test that waits for it', async (t) => {
  const { page } = await checkoutPage(t)
  await pickInFrame(t, page, inFrame(receipt, byRole('button', 'Attach a copy')), inFrame(receipt, byTestId('copy-status')))
})

test('a scroll in a frame on a phone page zoomed out to fit moves by the CSS pixels asked, as on the page', async (t) => {
  const app = await openApp(t)
  const other = await openApp(t)
  const phone = { emulation: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, touch: true, isMobile: true } }
  const page = await openPage(t, browser(), app.url, phone)
  assertOk(await goto(page, `/frames?payment=${encodeURIComponent(other.url.replace('127.0.0.1', 'localhost'))}`))
  assertOk(await scroll(page, inFrame(order, byTestId('list')), { y: 60 }))
  await observeUntil(page, inFrame(order, byTestId('list-top')), (seen) => Math.abs(Number(seen.text) - 60) <= 2)
})
