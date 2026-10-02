import type { HostCheckRecord } from '../../src/protocol/host-check.ts'
import type { TestResult } from '../../src/protocol/result.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { hostCheckRecord } from '../../src/protocol/host-check.ts'
import { formatDuration } from '../../src/reporters/format.ts'
import {
  countHostChecks,
  describeHostCheck,
  describeHostCheckWait,
  failedHostChecks,
  hostCheckExpectation,
  hostCheckHeading,
  hostCheckPage,
  notRunHostChecks,
} from '../../src/reporters/host-checks.ts'
import { recordEvents } from '../../src/reporters/run-record.ts'
import { checkoutProject, hostCheckFailureRun, hostCheckResult, noError, offThanks, onThanks, orderPlaced, placesOrder } from './reporters-host-check-fixtures.ts'

const origin = 'https://app.example'

describe('how a host check reads', () => {
  test('its heading is its kind, the name the caller gave it, and its app when there is one to name', () => {
    assert.equal(hostCheckHeading(onThanks), 'address')
    assert.equal(hostCheckHeading(orderPlaced, 'web'), 'text named "order confirmed" on web')
    assert.equal(hostCheckHeading({ kind: 'text', name: 'a\u001b[31m\u009b', text: 'x' }), 'text named "a\\u001b[31m\\u009b"')
  })

  test('what it asks of the page', () => {
    const address = (path?: string | RegExp): string => hostCheckExpectation(hostCheckRecord({ kind: 'address', origin, ...(path === undefined ? {} : { path }) }))
    assert.equal(address('/done'), 'https://app.example/done')
    assert.equal(address(), 'https://app.example, any path')
    assert.equal(address(/^\/orders\/\d+$/i), 'https://app.example, path matching /^\\/orders\\/\\d+$/i')
    assert.equal(hostCheckExpectation({ kind: 'text', text: 'Order placed' }), '"Order placed"')
    assert.equal(hostCheckExpectation({ kind: 'text', text: 'order placed', ignoreCase: true }), '"order placed", any case')
    assert.equal(hostCheckExpectation(noError), 'no "Error", any case')
    assert.equal(hostCheckExpectation({ kind: 'text', text: 'Error', absent: true }), 'no "Error"')
  })

  test('on one line, with its app when there is one to name', () => {
    assert.equal(describeHostCheck(onThanks, 'web'), 'address on web: http://127.0.0.1:4173/thanks')
    assert.equal(describeHostCheck(orderPlaced), 'text named "order confirmed": "Order placed"')
  })

  test('what the page showed it', () => {
    assert.equal(hostCheckPage(onThanks, { url: 'http://127.0.0.1:4173/cart' }), 'http://127.0.0.1:4173/cart')
    assert.equal(hostCheckPage(onThanks, {}), '(no web address)')
    assert.equal(hostCheckPage(orderPlaced, { url: 'http://127.0.0.1:4173/cart', found: false }), 'http://127.0.0.1:4173/cart, text not found')
    assert.equal(hostCheckPage(noError, { url: 'http://127.0.0.1:4173/cart', found: true }), 'http://127.0.0.1:4173/cart, text found')
    assert.equal(hostCheckPage(orderPlaced, { url: 'http://127.0.0.1:4173/feed', body: false }), 'http://127.0.0.1:4173/feed, no body to read')
    assert.equal(hostCheckPage(orderPlaced, { url: 'http://127.0.0.1:4173/\u009b' }), 'http://127.0.0.1:4173/\\u009b')
  })

  test('how long it looked', () => {
    assert.equal(describeHostCheckWait({ actual: {}, attempts: 1, timeoutMs: 5000, durationMs: 12 }, formatDuration), '12 ms, looked 1 time, limit 5s')
  })
})

describe("a test's host checks", () => {
  const events = hostCheckFailureRun(checkoutProject())
  const result = hostCheckResult(events)
  const placed = result.files[0]?.tests[0] ?? assert.fail('the run has its test')
  const recorded = recordEvents(events).test(placesOrder, placed.variantKey)?.events ?? []

  test('the failed ones come from their events, with what they saw', () => {
    const [first, second, ...rest] = failedHostChecks(recorded, placed)
    assert.deepEqual(first, { check: onThanks, app: 'web', failure: offThanks, looked: { actual: { url: 'http://127.0.0.1:4173/cart' }, attempts: 14, timeoutMs: 5000, durationMs: 5003 } })
    assert.equal(second?.check, orderPlaced)
    assert.deepEqual(rest, [])
  })

  test('without events they come from the result, and say nothing of what they saw', () => {
    assert.deepEqual(
      failedHostChecks([], placed).map((check) => [check.check.kind, check.app, check.looked]),
      [
        ['address', 'web', undefined],
        ['text', 'web', undefined],
      ],
    )
  })

  test("milestone 1's mode names no app", () => {
    const { variant, variantKey, ...plain } = placed
    assert.ok(variant !== undefined && variantKey !== undefined)
    const unnamed: TestResult = { ...plain, hostChecks: [{ check: orderPlaced, app: 'page', status: 'not_run' }] }
    assert.deepEqual(notRunHostChecks(unnamed), [{ check: orderPlaced }])
    assert.equal(failedHostChecks(recorded, unnamed)[0]?.app, undefined)
  })

  test('only the ones that did not run are listed as not run', () => {
    const checks: HostCheckRecord[] = [onThanks, orderPlaced]
    const listed: TestResult = { ...placed, hostChecks: [{ check: onThanks, app: 'web', status: 'passed' }, ...checks.map((check) => ({ check, app: 'admin', status: 'not_run' as const }))] }
    assert.deepEqual(notRunHostChecks(listed), [
      { check: onThanks, app: 'admin' },
      { check: orderPlaced, app: 'admin' },
    ])
  })

  test('counted across tests, worst first, and nothing when no test had any', () => {
    assert.deepEqual(countHostChecks([placed, { ...placed, hostChecks: [{ check: onThanks, app: 'web', status: 'not_run' }] }]), ['2 failed', '1 passed', '1 not run'])
    const { hostChecks, ...without } = placed
    assert.ok(hostChecks !== undefined)
    assert.deepEqual(countHostChecks([without]), [])
  })
})
