import type { StorageState } from '../../src/protocol/storage-state.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { emulationSchema } from '../../src/protocol/emulation.ts'
import { eventSchemaFileName, eventSchemaUrl, resultSchemaFileName, resultSchemaUrl } from '../../src/protocol/json-schemas.ts'
import { lastRunFile, lastRunSchema, type LastRun } from '../../src/protocol/last-run.ts'
import { parse, type Issue } from '../../src/protocol/schema.ts'
import { secretPlaceholder, secretRefSchema } from '../../src/protocol/secret.ts'
import { storageStateSchema } from '../../src/protocol/storage-state.ts'

function issues(result: { ok: true } | { ok: false; issues: Issue[] }): Issue[] {
  assert.equal(result.ok, false)
  return result.ok ? [] : result.issues
}

describe('secrets', () => {
  test('a secret stands in as {{name}}', () => {
    assert.equal(secretPlaceholder('password'), '{{password}}')
    assert.equal(secretPlaceholder('otp-code'), '{{otp-code}}')
  })

  test('a reference carries the name and never a value', () => {
    assert.equal(parse(secretRefSchema, { secret: 'password' }).ok, true)
    assert.deepEqual(issues(parse(secretRefSchema, { secret: 'password', value: 'hunter2' })), [{ path: '$.value', message: 'unknown key' }])
  })
})

describe('storage state', () => {
  const state: StorageState = {
    cookies: [
      { name: 'session', value: 'abc', domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Lax' },
      { name: 'theme', value: 'dark', domain: '.example.test', path: '/app', expires: 1_790_000_000.5, httpOnly: false, secure: true },
    ],
    origins: [{ origin: 'http://127.0.0.1:4173', localStorage: [{ name: 'token', value: 'xyz' }] }],
  }

  test('keeps cookies and each origin local storage', () => {
    assert.deepEqual(parse(storageStateSchema, JSON.parse(JSON.stringify(state))), { ok: true, value: state })
    assert.equal(parse(storageStateSchema, { cookies: [], origins: [] }).ok, true)
  })

  test('rejects what a browser would not give back', () => {
    const [cookie] = state.cookies
    assert.deepEqual(issues(parse(storageStateSchema, { ...state, cookies: [{ ...cookie, sameSite: 'lax' }] })), [
      { path: '$.cookies[0].sameSite', message: 'expected one of "Strict", "Lax", "None", received "lax"' },
    ])
    assert.deepEqual(issues(parse(storageStateSchema, { ...state, cookies: [{ ...cookie, expires: -2 }] })), [
      { path: '$.cookies[0].expires', message: 'expected number >= -1, received -2' },
    ])
    assert.deepEqual(issues(parse(storageStateSchema, { ...state, sessionStorage: [] })), [{ path: '$.sessionStorage', message: 'unknown key' }])
  })
})

describe('last run', () => {
  const lastRun: LastRun = {
    schemaVersion: 1,
    runId: 'run-1',
    finishedAt: '2026-09-30T09:15:06.000Z',
    tests: [
      { testId: 'tests/a.retest.ts > saves a task', status: 'failed' },
      { testId: 'tests/a.retest.ts > saves a task', variantKey: 'web=beta', status: 'error' },
      { testId: 'tests/b.retest.ts > archive > archives', variantKey: 'mobile=pixel,web=beta', status: 'not_run' },
    ],
  }

  test('lives in the project, beside the runs', () => {
    assert.equal(lastRunFile, '.retest/last-run.json')
  })

  test('records the tests that did not pass, each with its variant', () => {
    assert.deepEqual(parse(lastRunSchema, JSON.parse(JSON.stringify(lastRun))), { ok: true, value: lastRun })
    assert.deepEqual(issues(parse(lastRunSchema, { ...lastRun, tests: [{ testId: 'x', status: 'passed' }] })), [
      { path: '$.tests[0].status', message: 'expected one of "failed", "error", "not_run", received "passed"' },
    ])
    assert.deepEqual(issues(parse(lastRunSchema, { ...lastRun, schemaVersion: 2 })), [{ path: '$.schemaVersion', message: 'expected 1, received 2' }])
  })
})

describe('emulation', () => {
  const pixel = { viewport: { width: 412, height: 923 }, deviceScaleFactor: 2.625, touch: true, isMobile: true }

  test('has a viewport of whole pixels, a ratio, touch and mobile, and may replace the user agent', () => {
    assert.equal(parse(emulationSchema, pixel).ok, true)
    assert.equal(parse(emulationSchema, { ...pixel, userAgent: 'Mozilla/5.0' }).ok, true)
    assert.deepEqual(issues(parse(emulationSchema, { ...pixel, viewport: { width: 0, height: 923.5 } })), [
      { path: '$.viewport.width', message: 'expected integer >= 1, received 0' },
      { path: '$.viewport.height', message: 'expected integer >= 1, received 923.5' },
    ])
    assert.deepEqual(issues(parse(emulationSchema, { ...pixel, hasTouch: true })), [{ path: '$.hasTouch', message: 'unknown key' }])
  })
})

describe('JSON Schema files', () => {
  test('are named once and found in dist/schemas from the source or the build', () => {
    assert.equal(eventSchemaFileName, 'event-v1.schema.json')
    assert.equal(resultSchemaFileName, 'result-v1.schema.json')
    const root = fileURLToPath(new URL('../../', import.meta.url))
    assert.equal(fileURLToPath(eventSchemaUrl), `${root}dist/schemas/event-v1.schema.json`)
    assert.equal(fileURLToPath(resultSchemaUrl), `${root}dist/schemas/result-v1.schema.json`)
  })
})
