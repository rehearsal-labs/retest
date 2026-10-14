import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readPng } from '../../src/shared/png.ts'
import { openApp } from './browser-harness.ts'
import { budgets, eventsOf, filesHolding, onlyEvent, repositoryRoot, runCli, runProject, testNamed, writeProject } from './cli-harness.ts'

// A project whose tests find, act and check inside frames through page.frame(): a payment form in a frame of another
// site, filled with a secret its origin may take and posted to its own server; an order form and a notes frame inside
// it; a layout matcher inside a frame; and a check that fails inside each of the two frames, so their failures,
// screenshots and the report's step wording are read. Run through the CLI on Chrome, as a test author runs it.

// How many pixels of a PNG are of one colour, give or take a little for colour management.
function pixelsOf(png: Buffer, [red, green, blue]: readonly [number, number, number]): number {
  const { data } = readPng(png)
  let count = 0
  for (let index = 0; index < data.length; index += 4) {
    if (Math.abs((data[index] ?? 0) - red) <= 16 && Math.abs((data[index + 1] ?? 0) - green) <= 16 && Math.abs((data[index + 2] ?? 0) - blue) <= 16) count += 1
  }
  return count
}

const card = '4242 4242 4242 4242'

function checkoutTests(payment: string): string {
  const address = JSON.stringify(`/frames?payment=${encodeURIComponent(payment)}`)
  return `import { expect, secret, test } from '@rehearsal-labs/retest'

test('pays in the payment frame', async ({ page }) => {
  await page.goto(${address})
  const payment = page.frame(page.locator('iframe[title="Secure payment"]'))
  await expect(payment.getByRole('button', { name: 'Pay' })).toBeVisible()
  await payment.getByLabel('Card number').fill(secret('card'))
  await payment.getByLabel('Plan').select('Yearly')
  await payment.getByLabel('I agree to the terms').check()
  await payment.getByRole('button', { name: 'Pay' }).click()
  await expect(payment.getByText('Thank you')).toBeVisible()
  await expect(payment.getByTestId('paid')).toHaveText('Paid with card ending 4242 on the Yearly plan, terms yes')
  await expect(page).toHaveTitle('Checkout with frames')
})

test('fills the order and the notes frame inside it', async ({ page }) => {
  await page.goto(${address})
  const order = page.frame(page.getByTestId('order-frame'))
  await order.getByLabel('Name').fill('Ada')
  await order.getByRole('button', { name: 'Save order' }).click()
  await expect(order.getByTestId('order-status')).toHaveText('Saved Small order for Ada, express false')
  const notes = order.frame(order.locator('iframe'))
  await notes.getByLabel('Note').fill('Leave at the door')
  await notes.getByRole('button', { name: 'Add note' }).click()
  await expect(notes.getByTestId('note-status')).toHaveText('Note: Leave at the door')
  await expect(order.getByTestId('clipped')).toHaveClippedText()
  await expect(order.getByTestId('order-status')).not.toHaveClippedText()
})

test('a check inside the payment frame fails', async ({ page }) => {
  await page.goto(${address})
  const payment = page.frame(page.locator('iframe[title="Secure payment"]'))
  await expect(payment.getByTestId('press-status')).toHaveText('Tab pressed')
})

test('a check inside the order frame fails', async ({ page }) => {
  await page.goto(${address})
  const order = page.frame(page.getByTestId('order-frame'))
  await expect(order.getByTestId('order-status')).toHaveText('Never saved')
})

test('a frame that is not there fails by name', async ({ page }) => {
  await page.goto(${address})
  await page.frame(page.locator('iframe#gone')).getByRole('button', { name: 'Pay' }).click({ timeout: 500 })
})

test('frame() refuses a locator made on another frame', async ({ page }) => {
  await page.goto(${address})
  const order = page.frame(page.getByTestId('order-frame'))
  page.frame(order.locator('iframe'))
})
`
}

test('a project finds, acts and checks inside frames, and a failure inside a frame names the frame', async (t) => {
  const app = await openApp(t)
  const other = await openApp(t)
  // Another site than 127.0.0.1, so Chrome runs the payment form in a process of its own.
  const payment = other.url.replace('127.0.0.1', 'localhost')
  const config = `import { chrome, defineConfig, env } from '@rehearsal-labs/retest'

export default defineConfig({
  apps: { web: chrome({ baseUrl: ${JSON.stringify(app.url)} }) },
  secrets: { card: env('RETEST_FRAMES_CARD') },
  secretOrigins: { card: [${JSON.stringify(payment)}] },
})
`
  const root = await writeProject(t, { 'retest.config.ts': config, 'tests/checkout.retest.ts': checkoutTests(payment) })
  const run = await runProject(t, root, { timeouts: budgets({ assertion: 1500, action: 3000 }), env: { RETEST_FRAMES_CARD: card } })
  assert.equal(run.exit.code, 1, run.stderr)

  const outcome = (name: string) => {
    const found = testNamed(run, name)
    return [found.status, found.failure?.class ?? null]
  }
  assert.deepEqual(outcome('pays in the payment frame'), ['passed', null])
  assert.deepEqual(outcome('fills the order and the notes frame inside it'), ['passed', null])

  // The failure inside the payment frame names the frame in its locator, and the run kept its screenshot. The screenshot
  // is of the page's view, and the payment frame is below it: a check scrolls nothing, so the cyan payment form is
  // not in the picture.
  const failing = testNamed(run, 'a check inside the payment frame fails')
  assert.deepEqual([failing.status, failing.failure?.class], ['failed', 'check_failed'])
  assert.match(failing.failure?.message ?? '', /^frame\(locator\('iframe\[title="Secure payment"\]'\)\)\.getByTestId\('press-status'\) has text "No key"/)
  const screenshot = eventsOf(run.events, 'evidence.captured').find((event) => event.testId === failing.testId)
  assert.ok(screenshot !== undefined, 'the failure kept a screenshot')
  const paymentPicture = readFileSync(join(run.output, screenshot.path))
  assert.ok(paymentPicture.subarray(1, 4).toString() === 'PNG', 'the screenshot is a PNG')
  assert.equal(pixelsOf(paymentPicture, [0, 255, 255]), 0, 'the payment frame is below the view the screenshot holds')

  // The order frame is in the page's view, so the failure's screenshot shows its magenta form, frame and all.
  const inOrder = testNamed(run, 'a check inside the order frame fails')
  assert.deepEqual([inOrder.status, inOrder.failure?.class], ['failed', 'check_failed'])
  const orderShot = eventsOf(run.events, 'evidence.captured').find((event) => event.testId === inOrder.testId)
  assert.ok(orderShot !== undefined, 'the failure kept a screenshot')
  const shown = pixelsOf(readFileSync(join(run.output, orderShot.path)), [255, 0, 255])
  assert.ok(shown > 50_000, `the screenshot shows the order frame's document, ${shown} magenta pixels of its 480 by 400`)

  const gone = testNamed(run, 'a frame that is not there fails by name')
  assert.deepEqual([gone.status, gone.failure?.class], ['failed', 'not_found'])
  assert.equal(gone.failure?.message, `Could not click frame(locator('iframe#gone')).getByRole('button', { name: 'Pay' }): no element matched within 500 ms. frame(locator('iframe#gone')) found no frame.`)

  const elsewhere = testNamed(run, 'frame() refuses a locator made on another frame')
  assert.deepEqual([elsewhere.status, elsewhere.failure?.class], ['failed', 'usage'])
  assert.equal(elsewhere.failure?.message, 'frame() takes a locator made on the page or frame it is called on, and this one was made on another frame.')

  // Each step in a frame records the frame path in its locator; the payment's post is no navigation of the page.
  const paid = testNamed(run, 'pays in the payment frame')
  const fill = eventsOf(run.events, 'action.completed').find((event) => event.testId === paid.testId && event.command === 'fill')
  assert.deepEqual(fill?.locator, { by: 'label', text: 'Card number', frame: [{ by: 'css', selector: 'iframe[title="Secure payment"]' }] })
  const navigations = eventsOf(run.events, 'navigation').filter((event) => event.testId === paid.testId)
  assert.deepEqual(navigations.map((event) => event.url), [`${app.url}/frames`], 'only the goto opened a document of the page')
  assert.deepEqual(filesHolding(run.output, card), [], 'the card number is in no file of the run')

  // The report writes each step in a frame as the test wrote it, and the secret as its name.
  const reported = await runCli(t, ['report', run.output])
  assert.equal(reported.exit.code, 0, reported.stderr)
  const report = readFileSync(join(run.output, 'report.html'), 'utf8')
  assert.ok(report.includes('frame(locator(&#39;iframe[title=&quot;Secure payment&quot;]&#39;)).getByLabel(&#39;Card number&#39;)'), 'the report names the frame of the fill')
  assert.ok(report.includes('frame(getByTestId(&#39;order-frame&#39;)).frame(locator(&#39;iframe&#39;)).getByLabel(&#39;Note&#39;)'), 'the report names a frame inside a frame')
  assert.ok(!report.includes(card), 'the report holds no card number')
  assert.equal(onlyEvent(run.events, 'run.finished').type, 'run.finished')
})

// The official Electron release the Electron tests run, downloaded outside the repository, as electron.test.ts says.
const givenElectron = process.env['RETEST_TEST_ELECTRON']
const electronBinary = givenElectron ?? join(homedir(), 'Library/Caches/retest-proofs/electron', '44.5.1', 'dist/Electron.app/Contents/MacOS/Electron')
const noElectron = process.platform !== 'darwin' && givenElectron === undefined ? `unverified: RETEST_TEST_ELECTRON is not set, and Retest has no route yet to an Electron build on ${process.platform}` : false

test('an Electron window refuses a locator inside a frame by name, and sends it nothing', { skip: noElectron }, async (t) => {
  const config = `import { defineConfig, electron } from '@rehearsal-labs/retest'

export default defineConfig({ apps: { desktop: electron({ executablePath: ${JSON.stringify(electronBinary)}, appPath: ${JSON.stringify(join(repositoryRoot, 'fixtures/electron'))} }) } })
`
  const tests = `import { test } from '@rehearsal-labs/retest'

test('looks inside a frame of the window', async ({ page }) => {
  await page.frame(page.locator('iframe')).getByRole('button', { name: 'Pay' }).click()
})
`
  const root = await writeProject(t, { 'retest.config.ts': config, 'tests/frame.retest.ts': tests })
  const run = await runProject(t, root, { timeouts: budgets({ test: 20_000 }) })
  const refused = testNamed(run, 'looks inside a frame of the window')
  assert.deepEqual([run.exit.code, refused.status, refused.failure?.class], [2, 'error', 'unsupported'], JSON.stringify(refused))
  assert.equal(refused.failure?.message, "Retest looks inside frames on Chrome and Chromium only, and not on the window of the Electron app desktop yet, so it sent nothing for frame(locator('iframe')).getByRole('button', { name: 'Pay' }).")
  assert.deepEqual(refused.failure?.details, { inputSent: false })
})
