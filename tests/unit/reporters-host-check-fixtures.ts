import type { EventBody, RetestEvent } from '../../src/protocol/events.ts'
import type { Failure, SourceLocation } from '../../src/protocol/failures.ts'
import type { HostCheckRecord, HostCheckResult } from '../../src/protocol/host-check.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { ObservedRecord } from '../../src/protocol/observation-record.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { Variant } from '../../src/protocol/variant.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { truncateText, withAlso } from '../../src/protocol/failures.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { textComparison } from '../../src/protocol/text.ts'
import { defaultTimeouts } from '../../src/protocol/timeouts.ts'
import { variantKey } from '../../src/protocol/variant.ts'
import { tempFolder } from '../support/temp-folder.ts'
import { resultOf, stamp } from './reporters-fixtures.ts'

// A host's run from a config: one app, web, on one target behind a proxy. The test fills a coupon, presses Enter,
// checks the total, presses Enter on the page's keyboard to place the order, and the host checks the final page.

export const checkoutFile = 'tests/checkout.retest.ts'
export const baseUrl = 'http://127.0.0.1:4173'
export const cartUrl: string = `${baseUrl}/cart`
export const thanksUrl: string = `${baseUrl}/thanks`

export const checkoutSource = `import { expect, test } from '@rehearsal-labs/retest'

test('places an order', async ({ page }) => {
  await page.goto('/cart')
  await page.getByLabel('Coupon').fill('SPRING')
  await page.getByLabel('Coupon').press('Enter')
  await expect(page.getByTestId('total')).toHaveText('$18.00')
  await page.keyboard.press('Enter')
})
`

export const placesOrder: string = testId(checkoutFile, 'places an order')
export const chromeTarget: Variant = { web: 'chrome' }
const proxy = { server: 'http://127.0.0.1:8080', bypass: ['<-loopback>', '*.internal'] }

export const onThanks: HostCheckRecord = { kind: 'address', origin: baseUrl, path: '/thanks' }
export const orderPlaced: HostCheckRecord = { kind: 'text', name: 'order confirmed', text: 'Order placed' }
export const noError: HostCheckRecord = { kind: 'text', text: 'Error', absent: true, ignoreCase: true }
const hostChecks: HostCheckRecord[] = [onThanks, orderPlaced, noError]

const at = (line: number, column = 3): SourceLocation => ({ file: checkoutFile, line, column })
const ids = { testId: placesOrder, attemptId: 'attempt-1', variant: chromeTarget, variantKey: variantKey(chromeTarget) }
const onWeb = { ...ids, session: 'web' }
const coupon: LocatorRecipe = { by: 'label', text: 'Coupon' }
const total: LocatorRecipe = { by: 'testId', value: 'total' }

/** A folder with the test file in it, to be the run's root directory. */
export function checkoutProject(): string {
  const root = tempFolder('retest-host-checks-')
  mkdirSync(join(root, 'tests'))
  writeFileSync(join(root, checkoutFile), checkoutSource)
  return root
}

function runStarted(rootDir: string): EventBody {
  return {
    type: 'run.started',
    retestVersion: '0.0.0',
    node: 'v24.12.0',
    platform: 'darwin',
    rootDir,
    files: [checkoutFile],
    options: { config: 'host.config.ts', timeouts: defaultTimeouts, reporter: 'human', hostChecks: { [checkoutFile]: hostChecks } },
  }
}

const browserStarted: EventBody = {
  type: 'browser.started',
  product: 'Chrome',
  version: '154.0.7195.41',
  userAgent: 'Mozilla/5.0 Chrome/154.0.7195.41',
  pid: 4242,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  app: 'web',
  target: { name: 'chrome', proxy },
}

const collected: EventBody = {
  type: 'collection.completed',
  file: checkoutFile,
  tests: [{ testId: placesOrder, name: 'places an order', location: at(3, 1), apps: ['web'], variants: [chromeTarget] }],
}

export function observed(text: string): ObservedRecord {
  return { count: 1, visible: true, text: truncateText(text), value: null, items: [{ text: truncateText(text), visible: true }], itemsTruncated: false }
}

function look(observationId: string, text: string): EventBody {
  return { type: 'observation', ...onWeb, observationId, locator: total, pageUrl: cartUrl, observed: observed(text), durationMs: 3 }
}

function totalChecked(passed: boolean): EventBody[] {
  const fields = {
    ...onWeb,
    matcher: 'toHaveText',
    locator: total,
    expected: truncateText('$18.00'),
    comparison: textComparison,
    timeoutMs: 5000,
    location: at(7),
    pageUrl: cartUrl,
  }
  if (passed) {
    return [
      look('o1', '$20.00'),
      look('o2', '$18.00'),
      { type: 'assertion.passed', ...fields, actual: truncateText('$18.00'), attempts: 2, durationMs: 60, observationId: 'o2', judgedBy: 'parent' },
    ]
  }
  const failure: Failure = { class: 'check_failed', message: 'Expected the text "$18.00", received "$20.00". Looked 3 times in 5000 ms.', location: at(7) }
  return [
    look('o1', '$20.00'),
    look('o2', '$20.00'),
    look('o3', '$20.00'),
    { type: 'assertion.failed', ...fields, actual: truncateText('$20.00'), attempts: 3, durationMs: 5002, observationId: 'o3', failure },
  ]
}

// Everything up to the coupon, typed and not yet sent.
function couponTyped(rootDir: string): EventBody[] {
  return [
    runStarted(rootDir),
    browserStarted,
    collected,
    { type: 'test.started', ...ids, name: 'places an order', file: checkoutFile, location: at(3, 1) },
    { type: 'action.completed', ...onWeb, command: 'goto', pageUrl: cartUrl, durationMs: 40, location: at(4) },
    { type: 'navigation', ...onWeb, url: cartUrl },
    { type: 'action.completed', ...onWeb, command: 'fill', locator: coupon, pageUrl: cartUrl, durationMs: 12, location: at(5), valueLength: 6 },
  ]
}

// Everything the test does before its checks.
function body(rootDir: string, passed: boolean): EventBody[] {
  return [
    ...couponTyped(rootDir),
    { type: 'action.completed', ...onWeb, command: 'press', locator: coupon, key: 'Enter', pageUrl: cartUrl, durationMs: 9, location: at(6) },
    ...totalChecked(passed),
  ]
}

// A press of Enter that failed where the failure says, on a field or, without a locator, on the page's keyboard.
function pressFailed(failure: Failure, target: { locator?: LocatorRecipe }): EventBody[] {
  const location = failure.location ?? at(3, 1)
  return [
    { type: 'action.failed', ...onWeb, command: 'press', ...target, key: 'Enter', pageUrl: cartUrl, durationMs: 15, location, failure },
    { type: 'test.finished', ...ids, status: failure.class === 'not_actionable' ? 'failed' : 'error', durationMs: 400, assertionCount: 0, failure },
  ]
}

const keyTaken: Failure = {
  class: 'not_actionable',
  message: "getByLabel('Coupon') did not get the key: div.toast took it.",
  location: at(6),
  details: { check: 'focus', element: 'div.toast' },
}

/** An overlay takes the key pressed in the coupon field. */
export function pressFailureRun(rootDir: string): RetestEvent[] {
  return stamp([
    ...couponTyped(rootDir),
    ...pressFailed(keyTaken, { locator: coupon }),
    { type: 'run.finished', status: 'failed', exitCode: 1, complete: true, counts: failedCounts, durationMs: 700 },
  ])
}

/** The browser is lost while the page's keyboard presses Enter to place the order. */
export function keyboardPressLostRun(rootDir: string): RetestEvent[] {
  const lost: Failure = { class: 'outcome_unknown', message: 'The browser closed after the key was sent.', location: at(8) }
  return stamp([
    ...body(rootDir, true),
    ...pressFailed(lost, {}),
    { type: 'run.finished', status: 'error', exitCode: 2, complete: true, counts: { ...failedCounts, failed: 0, error: 1 }, durationMs: 700 },
  ])
}

function placed(): EventBody[] {
  return [{ type: 'action.completed', ...onWeb, command: 'press', key: 'Enter', pageUrl: cartUrl, durationMs: 7, location: at(8) }]
}

function checked(check: HostCheckRecord, actual: { url?: string; found?: boolean }, attempts: number): EventBody {
  return { type: 'host_check.passed', ...onWeb, check, actual, attempts, timeoutMs: 5000, durationMs: attempts * 10 }
}

export const offThanks: Failure = { class: 'host_check_failed', message: `The page was at ${cartUrl}, not ${thanksUrl}.` }
export const notPlaced: Failure = { class: 'host_check_failed', message: 'The page did not show "Order placed".' }

function failedCheck(check: HostCheckRecord, actual: { url?: string; found?: boolean }, failure: Failure): EventBody {
  return { type: 'host_check.failed', ...onWeb, check, actual, attempts: 14, timeoutMs: 5000, durationMs: 5003, failure }
}

const passedCounts = { passed: 1, failed: 0, error: 0, notRun: 0, inconclusive: 0 }
const failedCounts = { passed: 0, failed: 1, error: 0, notRun: 0, inconclusive: 0 }

/** The order is placed and every host check passes. */
export function hostChecksPassRun(rootDir: string): RetestEvent[] {
  return stamp([
    ...body(rootDir, true),
    ...placed(),
    checked(onThanks, { url: thanksUrl }, 1),
    checked(orderPlaced, { url: thanksUrl, found: true }, 2),
    checked(noError, { url: thanksUrl, found: false }, 1),
    { type: 'test.finished', ...ids, status: 'passed', durationMs: 900, assertionCount: 1 },
    { type: 'run.finished', status: 'passed', exitCode: 0, complete: true, counts: passedCounts, durationMs: 1200 },
  ])
}

/** The test's own check passes, but the page never leaves the cart: two host checks fail, the third passes. */
export function hostCheckFailureRun(rootDir: string): RetestEvent[] {
  const failure = withAlso(offThanks, [notPlaced])
  return stamp([
    ...body(rootDir, true),
    ...placed(),
    failedCheck(onThanks, { url: cartUrl }, offThanks),
    failedCheck(orderPlaced, { url: cartUrl, found: false }, notPlaced),
    checked(noError, { url: cartUrl, found: false }, 1),
    { type: 'evidence.captured', ...onWeb, kind: 'screenshot', path: 'artifacts/checkout-places-an-order-web-failure.png', reason: 'failure' },
    { type: 'test.finished', ...ids, status: 'failed', durationMs: 11_000, assertionCount: 1, failure },
    { type: 'run.finished', status: 'failed', exitCode: 1, complete: true, counts: failedCounts, durationMs: 11_300 },
  ])
}

/** The total is wrong, so the body fails and no host check runs. */
export function bodyFailureRun(rootDir: string): RetestEvent[] {
  const events = body(rootDir, false)
  const finalAssertion = events.at(-1)
  if (finalAssertion?.type !== 'assertion.failed') throw new Error('fixture')
  return stamp([
    ...events,
    { type: 'evidence.captured', ...onWeb, kind: 'screenshot', path: 'artifacts/checkout-places-an-order-web-failure.png', reason: 'failure' },
    { type: 'test.finished', ...ids, status: 'failed', durationMs: 5100, assertionCount: 1, failure: finalAssertion.failure },
    { type: 'run.finished', status: 'failed', exitCode: 1, complete: true, counts: failedCounts, durationMs: 5400 },
  ])
}

/** The result the runner stores: every check the test had, in order, whatever happened to it. */
export function hostCheckResult(events: RetestEvent[]): RunResult {
  const result = resultOf(events)
  return {
    ...result,
    files: result.files.map((file) => ({
      ...file,
      tests: file.tests.map((test) => {
        const recorded = test.hostChecks ?? []
        const listed: HostCheckResult[] = hostChecks.map((check, index) => recorded[index] ?? { check, app: 'web', status: 'not_run' })
        return { ...test, hostChecks: listed }
      }),
    })),
  }
}
