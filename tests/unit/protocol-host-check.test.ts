import type { HostCheck, HostCheckRecord, HostCheckResult } from '../../src/protocol/host-check.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  hostCheckActualSchema,
  hostCheckProblems,
  hostCheckRecord,
  hostCheckRecordSchema,
  hostCheckResultSchema,
  hostChecksFor,
  matchesAddress,
  normalizePageText,
  pageTextHolds,
  unmatchedHostCheckKeys,
} from '../../src/protocol/host-check.ts'
import { testId } from '../../src/protocol/run-folder.ts'
import { parse } from '../../src/protocol/schema.ts'
import { maxTimeout } from '../../src/protocol/timeouts.ts'

describe('address checks', () => {
  test('the page origin must be the check origin, as the URL standard writes it', () => {
    assert.equal(matchesAddress('https://app.example/done', { origin: 'https://app.example' }), true)
    assert.equal(matchesAddress('https://app.example/done', { origin: 'https://APP.example/' }), true)
    assert.equal(matchesAddress('https://app.example:443/', { origin: 'https://app.example' }), true)
    assert.equal(matchesAddress('http://app.example/done', { origin: 'https://app.example' }), false)
    assert.equal(matchesAddress('https://app.example:8443/done', { origin: 'https://app.example' }), false)
    assert.equal(matchesAddress('https://evil.example/app.example', { origin: 'https://app.example' }), false)
  })

  test('a path string equals the page path exactly; the query and fragment are never read', () => {
    const check = { origin: 'https://app.example', path: '/orders/done' }
    assert.equal(matchesAddress('https://app.example/orders/done', check), true)
    assert.equal(matchesAddress('https://app.example/orders/done?id=7#top', check), true)
    assert.equal(matchesAddress('https://app.example/orders/done/', check), false)
    assert.equal(matchesAddress('https://app.example/Orders/done', check), false)
    assert.equal(matchesAddress('https://app.example/a%20b', { origin: 'https://app.example', path: '/a%20b' }), true)
    assert.equal(matchesAddress('https://app.example/a%20b', { origin: 'https://app.example', path: '/a b' }), false)
  })

  test('a RegExp path searches the page path, and never its query', () => {
    assert.equal(matchesAddress('https://app.example/orders/42', { origin: 'https://app.example', path: /^\/orders\/\d+$/ }), true)
    assert.equal(matchesAddress('https://app.example/orders/new', { origin: 'https://app.example', path: /^\/orders\/\d+$/ }), false)
    assert.equal(matchesAddress('https://app.example/login?next=/done', { origin: 'https://app.example', path: /done/ }), false)
    assert.equal(matchesAddress('https://app.example/DONE', { origin: 'https://app.example', path: /done/i }), true)
  })

  test('a page with no web address, or a check whose origin is not one, passes nothing', () => {
    for (const url of [undefined, 'about:blank', 'data:text/html,x', 'not a url']) assert.equal(matchesAddress(url, { origin: 'https://app.example' }), false)
    assert.equal(matchesAddress('https://app.example/', { origin: 'https://app.example/login' }), false)
  })
})

describe('text checks', () => {
  test('page text holds the text with whitespace normalised as locators normalise it', () => {
    const page = 'Thank you.\n\n  Your   order\tis placed.  '
    assert.equal(pageTextHolds(page, { text: 'Your order is placed.', ignoreCase: false }), true)
    assert.equal(pageTextHolds(page, { text: '  order \n is ', ignoreCase: false }), true)
    assert.equal(pageTextHolds(page, { text: 'your order', ignoreCase: false }), false)
    assert.equal(pageTextHolds(page, { text: 'your ORDER', ignoreCase: true }), true)
    assert.equal(pageTextHolds('', { text: 'Saved', ignoreCase: false }), false)
    assert.equal(pageTextHolds('Save\u00a0changes', { text: 'Save changes', ignoreCase: false }), true)
  })

  test('normalizePageText lowercases only when the check ignores case', () => {
    assert.equal(normalizePageText('  Order\n  PLACED ', false), 'Order PLACED')
    assert.equal(normalizePageText('  Order\n  PLACED ', true), 'order placed')
  })
})

describe('records', () => {
  test('an address check keeps its origin as the URL standard writes it, and a RegExp path as its source and flags', () => {
    assert.deepEqual(hostCheckRecord({ kind: 'address', origin: 'https://App.example/', app: 'web', timeoutMs: 3000 }), { kind: 'address', origin: 'https://app.example' })
    assert.deepEqual(hostCheckRecord({ kind: 'address', origin: 'https://app.example', path: '/done', name: 'on the done page' }), {
      kind: 'address',
      name: 'on the done page',
      origin: 'https://app.example',
      path: '/done',
    })
    assert.deepEqual(hostCheckRecord({ kind: 'address', origin: 'https://app.example', path: /^\/orders\/\d+$/i }), {
      kind: 'address',
      origin: 'https://app.example',
      path: { pattern: '^\\/orders\\/\\d+$', flags: 'i' },
    })
  })

  test('a text check records ignoreCase and absent only when they are true', () => {
    assert.deepEqual(hostCheckRecord({ kind: 'text', text: 'Saved', ignoreCase: false, absent: false }), { kind: 'text', text: 'Saved' })
    assert.deepEqual(hostCheckRecord({ kind: 'text', text: 'Error', ignoreCase: true, absent: true, name: 'no error', app: 'web' }), {
      kind: 'text',
      name: 'no error',
      text: 'Error',
      ignoreCase: true,
      absent: true,
    })
  })

  test('records, what a check saw, and results survive a JSON round trip; anything else is refused', () => {
    const onDone: HostCheckRecord = { kind: 'address', origin: 'https://app.example', path: '/done' }
    const records: HostCheckRecord[] = [
      onDone,
      hostCheckRecord({ kind: 'address', origin: 'https://app.example', path: /done/g }),
      hostCheckRecord({ kind: 'text', text: 'Saved', ignoreCase: true, absent: true }),
    ]
    for (const record of records) assert.deepEqual(parse(hostCheckRecordSchema, JSON.parse(JSON.stringify(record))), { ok: true, value: record })
    const results: HostCheckResult[] = [
      { check: onDone, app: 'web', status: 'passed' },
      { check: { kind: 'text', text: 'Saved' }, app: 'web', status: 'failed', failure: { class: 'check_failed', message: 'No "Saved".' } },
      { check: { kind: 'text', text: 'Saved' }, app: 'mobile', status: 'not_run' },
    ]
    for (const result of results) assert.equal(parse(hostCheckResultSchema, result).ok, true)
    for (const actual of [{}, { url: 'https://app.example/login' }, { url: 'https://app.example/', found: false }]) assert.equal(parse(hostCheckActualSchema, actual).ok, true)
    assert.equal(parse(hostCheckRecordSchema, { kind: 'text', text: 'Saved', ignoreCase: false }).ok, false)
    assert.equal(parse(hostCheckRecordSchema, { kind: 'address', origin: 'https://app.example', app: 'web' }).ok, false)
    assert.equal(parse(hostCheckRecordSchema, { kind: 'title', text: 'Done' }).ok, false)
    assert.equal(parse(hostCheckResultSchema, { check: { kind: 'text', text: 'x' }, app: 'web', status: 'skipped' }).ok, false)
    assert.equal(parse(hostCheckActualSchema, { url: 'https://app.example/', text: 'Your order is placed.' }).ok, false)
  })
})

describe('which checks a test gets', () => {
  const file = 'tests/checkout.retest.ts'
  const placesOrder = { testId: testId(file, 'checkout > places an order'), file }
  const signsIn = { testId: testId(file, 'signs in'), file }
  const other = { testId: testId('tests/other.retest.ts', 'x'), file: 'tests/other.retest.ts' }
  const onDone: HostCheck = { kind: 'address', origin: 'https://app.example', path: '/done' }
  const saved: HostCheck = { kind: 'text', text: 'Saved' }
  const noError: HostCheck = { kind: 'text', text: 'Error', absent: true }

  test('a file key applies to every test of the file, before a test key names its own', () => {
    const hostChecks = { [placesOrder.testId]: [saved], [file]: [onDone, noError] }
    assert.deepEqual(hostChecksFor(hostChecks, placesOrder), [onDone, noError, saved])
    assert.deepEqual(hostChecksFor(hostChecks, signsIn), [onDone, noError])
    assert.deepEqual(hostChecksFor(hostChecks, other), [])
  })

  test('a key names a test only by its whole id, and a file only by its whole path', () => {
    const hostChecks = { 'checkout > places an order': [saved], 'checkout.retest.ts': [saved], [file.toUpperCase()]: [saved] }
    assert.deepEqual(hostChecksFor(hostChecks, placesOrder), [])
    assert.deepEqual(unmatchedHostCheckKeys(hostChecks, [placesOrder, signsIn]), Object.keys(hostChecks))
  })

  test('only keys the option holds itself count, never what every object inherits', () => {
    assert.deepEqual(hostChecksFor<HostCheck>({}, { testId: 'toString', file: 'constructor' }), [])
  })

  test('a key that names no selected test and no file a selected test comes from is unmatched', () => {
    const hostChecks = { [file]: [onDone], [placesOrder.testId]: [saved], 'tests/other.retest.ts': [saved], [testId(file, 'deleted test')]: [saved] }
    assert.deepEqual(unmatchedHostCheckKeys(hostChecks, [placesOrder, signsIn]), ['tests/other.retest.ts', testId(file, 'deleted test')])
    assert.deepEqual(unmatchedHostCheckKeys(hostChecks, [other]), [file, placesOrder.testId, testId(file, 'deleted test')])
    assert.deepEqual(unmatchedHostCheckKeys({}, []), [])
  })
})

describe('hostCheckProblems', () => {
  const key = (index: number, field?: string): string => `hostChecks["a.retest.ts"][${index}]${field === undefined ? '' : `.${field}`}`
  const problems = (...checks: unknown[]): string[] => hostCheckProblems({ 'a.retest.ts': checks })

  test('well-formed checks have none, and a key set to undefined counts as absent', () => {
    assert.deepEqual(
      problems(
        { kind: 'address', origin: 'https://app.example' },
        { kind: 'address', app: 'web', origin: 'https://app.example/', path: /^\/done/i, name: 'done', timeoutMs: 1 },
        { kind: 'text', text: 'Saved', ignoreCase: true, absent: false, timeoutMs: maxTimeout },
        { kind: 'text', text: 'Saved', path: undefined, ignoreCase: undefined },
      ),
      [],
    )
    assert.deepEqual(hostCheckProblems({}), [])
    assert.deepEqual(hostCheckProblems({ 'a.retest.ts': [] }), [])
  })

  test('the option and each list must have their shape', () => {
    assert.deepEqual(hostCheckProblems([]), ['hostChecks: expected lists of checks by test id or file, received array'])
    assert.deepEqual(hostCheckProblems(null), ['hostChecks: expected lists of checks by test id or file, received null'])
    assert.deepEqual(hostCheckProblems({ 'a.retest.ts': { kind: 'text', text: 'x' } }), ['hostChecks["a.retest.ts"]: expected a list of checks, received object'])
    assert.deepEqual(problems('text'), [`${key(0)}: expected a check, received "text"`])
  })

  test('a check needs a kind it knows, and a misspelt key is refused rather than dropped', () => {
    assert.deepEqual(problems({ origin: 'https://app.example' }), [`${key(0, 'kind')}: missing required key`])
    assert.deepEqual(problems({ kind: 'title', text: 'Done' }), [`${key(0, 'kind')}: expected one of "address", "text", received "title"`])
    assert.deepEqual(problems({ kind: 'address', origin: 'https://app.example', pathh: '/done' }), [`${key(0, 'pathh')}: unknown key`])
    assert.deepEqual(problems({ kind: 'text', text: 'Saved', path: '/done' }), [`${key(0, 'path')}: unknown key`])
  })

  test('an origin that is not an http or https origin', () => {
    assert.deepEqual(problems({ kind: 'address' }), [`${key(0, 'origin')}: missing required key`])
    for (const origin of ['ftp://app.example', 'https://app.example/done', 'app.example', '', 7]) {
      assert.deepEqual(problems({ kind: 'address', origin }), [
        `${key(0, 'origin')}: expected an http or https origin such as https://example.com, received ${JSON.stringify(origin)}`,
      ])
    }
  })

  test('a RegExp path with the g or y flag, and a path that is neither a string nor a RegExp', () => {
    assert.deepEqual(problems({ kind: 'address', origin: 'https://app.example', path: /done/g }), [`${key(0, 'path')}: expected a RegExp without the g or y flag, received /done/g`])
    assert.deepEqual(problems({ kind: 'address', origin: 'https://app.example', path: /done/iy }), [`${key(0, 'path')}: expected a RegExp without the g or y flag, received /done/iy`])
    assert.deepEqual(problems({ kind: 'address', origin: 'https://app.example', path: ['/done'] }), [`${key(0, 'path')}: expected a string or a RegExp, received array`])
  })

  test('empty text, including text that is only whitespace', () => {
    assert.deepEqual(problems({ kind: 'text' }), [`${key(0, 'text')}: missing required key`])
    for (const text of ['', ' \n\t ', 42]) assert.deepEqual(problems({ kind: 'text', text }), [`${key(0, 'text')}: expected text to look for, received ${JSON.stringify(text)}`])
  })

  test('a timeout that is not a whole number of milliseconds from 1', () => {
    for (const timeoutMs of [0, -1, 1.5, maxTimeout + 1, '100', Number.NaN]) {
      assert.deepEqual(problems({ kind: 'text', text: 'Saved', timeoutMs }), [
        `${key(0, 'timeoutMs')}: expected a whole number of milliseconds from 1 to ${maxTimeout}, received ${typeof timeoutMs === 'string' ? JSON.stringify(timeoutMs) : String(timeoutMs)}`,
      ])
    }
  })

  test('app, name, ignoreCase and absent of the wrong type', () => {
    assert.deepEqual(problems({ kind: 'text', text: 'Saved', app: 1, name: false, ignoreCase: 'yes', absent: 0 }), [
      `${key(0, 'app')}: expected string, received 1`,
      `${key(0, 'name')}: expected string, received false`,
      `${key(0, 'ignoreCase')}: expected boolean, received "yes"`,
      `${key(0, 'absent')}: expected boolean, received 0`,
    ])
  })

  test('every problem of every check is listed, each with its key', () => {
    const found = hostCheckProblems({
      'a.retest.ts > saves': [{ kind: 'text', text: '' }, { kind: 'address', origin: 'https://app.example', path: /x/g }],
      'b.retest.ts': [{ kind: 'nope' }],
    })
    assert.deepEqual(found, [
      'hostChecks["a.retest.ts > saves"][0].text: expected text to look for, received ""',
      'hostChecks["a.retest.ts > saves"][1].path: expected a RegExp without the g or y flag, received /x/g',
      'hostChecks["b.retest.ts"][0].kind: expected one of "address", "text", received "nope"',
    ])
  })
})
