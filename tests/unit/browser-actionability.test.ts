import type { ActionIntent, Readiness } from '../../src/browser/element-queries.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { waitUntilActionable } from '../../src/browser/actionability.ts'
import { IsolatedWorld } from '../../src/browser/isolated-world.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { scriptedSession } from './browser-fixtures.ts'

// A page where every look at the element finds `readiness`, and where role and label find one element.
function world(readiness: Readiness, sent: unknown[] = []): IsolatedWorld {
  const { session } = scriptedSession((method, params) => {
    sent.push(params)
    switch (method) {
      case 'Page.createIsolatedWorld':
        return Promise.resolve({ executionContextId: 7 })
      case 'Runtime.evaluate':
        return Promise.resolve({ result: { objectId: 'document' } })
      case 'Accessibility.queryAXTree':
        return Promise.resolve({ nodes: [] })
      default:
        return Promise.resolve({ result: { value: readiness } })
    }
  })
  return new IsolatedWorld(session, () => 'F1')
}

const settled = () => undefined

async function failureFor(readiness: Readiness, locator: LocatorRecipe, intent: ActionIntent, budgetMs = 1000, sent: unknown[] = []) {
  const target = await waitUntilActionable({ world: world(readiness, sent), locator, intent, deadline: new Deadline(budgetMs), pendingNavigation: settled })
  assert.ok(!target.ok, 'expected the element not to be actionable')
  return target.failure
}

const password: LocatorRecipe = { by: 'label', text: 'Password' }
const byTestId: LocatorRecipe = { by: 'testId', value: 'password' }

test('a secret with a line break is refused by the name of the secret', async () => {
  const readiness: Readiness = { status: 'unsupported', reason: 'multiline', field: '<input type="password">' }
  const failure = await failureFor(readiness, password, { action: 'fill', multiline: true, secret: 'password' })
  assert.deepEqual(failure, {
    class: 'unsupported',
    message: `Could not fill getByLabel('Password') with {{password}}, which has a line break: it is <input type="password">, which holds one line. Use a textarea for text with \\n or \\r.`,
    details: { field: '<input type="password">' },
  })
  const plain = await failureFor(readiness, password, { action: 'fill', multiline: true })
  assert.match(plain.message, /^Could not fill getByLabel\('Password'\) with a line break: /)
})

test('failures name the action and the locator as the test wrote them', async () => {
  const save: LocatorRecipe = { by: 'role', role: 'button', name: 'Save', exact: false }
  const ambiguous = await failureFor({ status: 'ambiguous', count: 2 }, save, { action: 'tap', multiline: false })
  assert.equal(
    ambiguous.message,
    "Could not tap getByRole('button', { name: 'Save', exact: false }): it matches 2 elements, and a locator must match exactly one. Retest did not tap any of them.",
  )
  const missing = await failureFor({ status: 'missing' }, { by: 'text', text: 'Welcome' }, { action: 'click', multiline: false }, 50)
  assert.deepEqual(missing, { class: 'not_found', message: "Could not click getByText('Welcome'): no element matched within 50 ms.", details: { waitedMs: 50 } })
})

test('a point with no element at all is named as such, for any action', async () => {
  const readiness: Readiness = { status: 'blocked', check: 'hit-target', detail: null }
  const failure = await failureFor(readiness, password, { action: 'tap', multiline: false }, 50)
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message: "Could not tap getByLabel('Password') within 50 ms: no element is at its centre.",
    details: { check: 'hit-target', covering: null, waitedMs: 50 },
  })
})

test('a fill bound to origins asks the page to check them, and a page on another origin fails at once, naming it', async () => {
  const sent: unknown[] = []
  const intent: ActionIntent = { action: 'fill', multiline: false, secret: 'password', allowedOrigins: ['http://127.0.0.1:4173', 'https://login.example'] }
  const { value: failure, ms } = await timed(failureFor({ status: 'refused', origin: 'https://evil.example', leaving: false }, byTestId, intent, 5000, sent))
  assert.deepEqual(failure, {
    class: 'not_actionable',
    message:
      "Could not fill getByTestId('password') with {{password}}: the page is on https://evil.example, and {{password}} may be typed only on http://127.0.0.1:4173, https://login.example. Retest did not type it.",
    details: { origin: 'https://evil.example' },
  })
  assert.ok(ms < 1000, 'a refusal is not waited on')
  const [call] = sent.filter((params) => isObject(params) && 'functionDeclaration' in params)
  assert.ok(isObject(call) && Array.isArray(call['arguments']))
  assert.deepEqual(call['arguments'].slice(0, 3), [{ value: 'fill' }, { value: false }, { value: intent.allowedOrigins }])
})

test('a page that set off for another document as the field took focus fails at once, naming where it was going', async () => {
  const intent: ActionIntent = { action: 'fill', multiline: false, secret: 'password', allowedOrigins: [] }
  const failure = await failureFor({ status: 'refused', origin: 'http://localhost:4173', leaving: true }, password, intent)
  assert.equal(
    failure.message,
    "Could not fill getByLabel('Password') with {{password}}: the page started to open http://localhost:4173 before Retest typed. Retest kept the page where it was and did not type {{password}}.",
  )
  const nowhere = await failureFor({ status: 'refused', origin: 'null', leaving: false }, password, intent)
  assert.match(nowhere.message, /: the page is on a page with no web origin, and no origin may take \{\{password\}\}\. Retest did not type it\.$/)
})

test('an action without origins sends null in their place', async () => {
  const sent: unknown[] = []
  await failureFor({ status: 'ambiguous', count: 2 }, byTestId, { action: 'click', multiline: false }, 1000, sent)
  const [call] = sent.filter((params) => isObject(params) && 'functionDeclaration' in params)
  assert.ok(isObject(call) && Array.isArray(call['arguments']))
  assert.deepEqual(call['arguments'][2], { value: null })
})

const ready: Readiness = { status: 'ready', x: 10, y: 20, token: 1 }
const calls = (sent: unknown[]) => sent.filter((params) => isObject(params) && 'functionDeclaration' in params).length

test('while the browser is opening another document, the page is not looked at, and the look resumes in the document that arrives', async () => {
  const sent: unknown[] = []
  let polls = 0
  const pendingNavigation = () => (++polls <= 3 ? { url: 'http://127.0.0.1:4173/next?code=1234' } : undefined)
  const target = await waitUntilActionable({ world: world(ready, sent), locator: byTestId, intent: { action: 'click', multiline: false }, deadline: new Deadline(1000), pendingNavigation })
  assert.deepEqual(target, { ok: true, point: { x: 10, y: 20 }, guard: { context: 7, token: 1 } })
  assert.equal(calls(sent), 1, 'one look, once the navigation was over')
  assert.equal(polls, 4)
})

test('a navigation that never ends fails the action when the time runs out, naming the address without its query', async () => {
  const sent: unknown[] = []
  const pendingNavigation = () => ({ url: 'http://127.0.0.1:4173/next?code=1234' })
  const target = await waitUntilActionable({ world: world(ready, sent), locator: password, intent: { action: 'fill', multiline: false, secret: 'password' }, deadline: new Deadline(100), pendingNavigation })
  assert.deepEqual(target, {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: "Could not fill getByLabel('Password') within 100 ms: the page was still opening http://127.0.0.1:4173/next, and Retest does not fill in a document about to be replaced.",
      details: { check: 'navigation', url: 'http://127.0.0.1:4173/next', waitedMs: 100 },
    },
  })
  assert.equal(calls(sent), 0, 'the page was never looked at')
})

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function timed<T>(work: Promise<T>): Promise<{ value: T; ms: number }> {
  const start = performance.now()
  return { value: await work, ms: performance.now() - start }
}
