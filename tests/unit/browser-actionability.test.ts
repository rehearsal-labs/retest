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
  return answering(readiness, sent)
}

// A page whose every call answers `value`.
function answering(value: unknown, sent: unknown[]): IsolatedWorld {
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
        return Promise.resolve({ result: { value } })
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
  const readiness: Readiness = { status: 'unsupported', reason: 'multiline', element: '<input type="password">' }
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
  const missing = await failureFor({ status: 'missing', empty: null }, { by: 'text', text: 'Welcome' }, { action: 'click', multiline: false }, 50)
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
  assert.deepEqual(call['arguments'][0], { value: { action: 'fill', multiline: false, origins: intent.allowedOrigins } })
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

test('each action sends the page what it needs, and a fill without origins sends null in their place', async () => {
  const cases: [ActionIntent, Record<string, unknown>][] = [
    [{ action: 'click', multiline: false }, { action: 'click' }],
    [{ action: 'fill', multiline: true }, { action: 'fill', multiline: true, origins: null }],
    [{ action: 'check', pointer: 'click', multiline: false }, { action: 'check', checked: true, pointer: 'click' }],
    [{ action: 'uncheck', pointer: 'tap', multiline: false }, { action: 'check', checked: false, pointer: 'tap' }],
    [{ action: 'select', choices: [{ label: 'Red' }], multiple: false, multiline: false }, { action: 'select', choices: [{ label: 'Red' }], multiple: false }],
    [
      { action: 'select', choices: [{ label: 'Red' }], multiple: false, multiline: false, typing: { strokes: 2 } },
      { action: 'select', choices: [{ label: 'Red' }], multiple: false, typing: true, strokes: 2 },
    ],
    [{ action: 'press', key: 'Control+A', strokes: 2, multiline: false }, { action: 'press', strokes: 2 }],
    [{ action: 'hover', multiline: false }, { action: 'hover' }],
    [{ action: 'scroll', multiline: false }, { action: 'scroll' }],
  ]
  for (const [intent, sentIntent] of cases) {
    const sent: unknown[] = []
    await failureFor({ status: 'ambiguous', count: 2 }, byTestId, intent, 1000, sent)
    const [call] = sent.filter((params) => isObject(params) && 'functionDeclaration' in params)
    assert.ok(isObject(call) && Array.isArray(call['arguments']))
    assert.deepEqual(call['arguments'][0], { value: sentIntent }, intent.action)
  }
})

const facts = { href: 'http://127.0.0.1:4173/tasks?page=2', title: ' Tasks ' }
const ready: Readiness = { status: 'ready', point: { x: 10, y: 20 }, token: 1, via: null, scale: 1, page: facts, plan: null }
const readyTarget = {
  ok: true,
  kind: 'ready',
  point: { x: 10, y: 20 },
  context: 7,
  token: 1,
  via: undefined,
  scale: 1,
  page: { url: 'http://127.0.0.1:4173/tasks', title: ' Tasks ' },
  plan: null,
}
const calls = (sent: unknown[]) => sent.filter((params) => isObject(params) && 'functionDeclaration' in params).length

test('while the browser is opening another document, the page is not looked at, and the look resumes in the document that arrives', async () => {
  const sent: unknown[] = []
  let polls = 0
  const pendingNavigation = () => (++polls <= 3 ? { url: 'http://127.0.0.1:4173/next?code=1234' } : undefined)
  const target = await waitUntilActionable({ world: world(ready, sent), locator: byTestId, intent: { action: 'click', multiline: false }, deadline: new Deadline(1000), pendingNavigation })
  assert.deepEqual(target, readyTarget)
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

test("a key for the page's keyboard looks at no element: it waits out a navigation, then arms the guard for the document", async () => {
  const sent: unknown[] = []
  let polls = 0
  const pendingNavigation = () => (++polls <= 2 ? { url: 'http://127.0.0.1:4173/next' } : undefined)
  const keyboard = answering({ ...ready, point: null, token: 3 }, sent)
  const intent: ActionIntent = { action: 'press', key: 'Control+Enter', strokes: 2, multiline: false }
  const target = await waitUntilActionable({ world: keyboard, locator: undefined, intent, deadline: new Deadline(1000), pendingNavigation })
  assert.deepEqual(target, { ...readyTarget, point: null, token: 3 })
  const [call] = sent.filter((params) => isObject(params) && 'functionDeclaration' in params)
  assert.ok(isObject(call))
  assert.match(String(call['functionDeclaration']), /^function armDocument\(action, strokes\)/)
  assert.deepEqual(call['arguments'], [{ value: 'press' }, { value: 2 }])
})

test('a wheel for the page arms the document as a key does, at the point and scale the page gives', async () => {
  const sent: unknown[] = []
  const wheel = answering({ ...ready, point: { x: 400, y: 300 }, token: 5, scale: 0.5 }, sent)
  const target = await waitUntilActionable({ world: wheel, locator: undefined, intent: { action: 'scroll', multiline: false }, deadline: new Deadline(1000), pendingNavigation: settled })
  assert.deepEqual(target, { ...readyTarget, point: { x: 400, y: 300 }, token: 5, scale: 0.5 })
  const [call] = sent.filter((params) => isObject(params) && 'functionDeclaration' in params)
  assert.ok(isObject(call))
  assert.deepEqual(call['arguments'], [{ value: 'scroll' }, { value: 1 }])
})

test("a key for the page's keyboard whose page never stops navigating fails naming the key and the address", async () => {
  const pendingNavigation = () => ({ url: 'http://127.0.0.1:4173/next?code=1234' })
  const intent: ActionIntent = { action: 'press', key: 'Enter', strokes: 1, multiline: false }
  const target = await waitUntilActionable({ world: world(ready), locator: undefined, intent, deadline: new Deadline(100), pendingNavigation })
  assert.deepEqual(target, {
    ok: false,
    failure: {
      class: 'not_actionable',
      message: 'Could not press Enter within 100 ms: the page was still opening http://127.0.0.1:4173/next, and Retest does not press in a document about to be replaced.',
      details: { check: 'navigation', url: 'http://127.0.0.1:4173/next', waitedMs: 100 },
    },
  })
})

test('a press on an element sends its checks to the page and names the key in every failure', async () => {
  const sent: unknown[] = []
  const intent: ActionIntent = { action: 'press', key: 'Shift+Tab', strokes: 2, multiline: false }
  const ambiguous = await failureFor({ status: 'ambiguous', count: 3 }, password, intent, 1000, sent)
  assert.equal(
    ambiguous.message,
    "Could not press Shift+Tab on getByLabel('Password'): it matches 3 elements, and a locator must match exactly one. Retest did not press any of them.",
  )
  const [call] = sent.filter((params) => isObject(params) && 'functionDeclaration' in params)
  assert.ok(isObject(call) && Array.isArray(call['arguments']))
  assert.deepEqual(call['arguments'][0], { value: { action: 'press', strokes: 2 } })
  const unfocused = await failureFor({ status: 'blocked', check: 'focused', detail: null }, byTestId, intent, 50)
  assert.deepEqual(unfocused, {
    class: 'not_actionable',
    message: "Could not press Shift+Tab on getByTestId('password') within 50 ms: it did not keep the keyboard focus.",
    details: { check: 'focused', covering: null, waitedMs: 50 },
  })
})

test('an element ready for a key is ready with no point, since a key goes to the focus', async () => {
  const intent: ActionIntent = { action: 'press', key: 'a', strokes: 1, multiline: false }
  const target = await waitUntilActionable({ world: world({ ...ready, point: null, token: 4 }), locator: byTestId, intent, deadline: new Deadline(1000), pendingNavigation: settled })
  assert.deepEqual(target, { ...readyTarget, point: null, token: 4 })
})

test('a control already as a check asks is settled at once, with the page it is on, and no guard', async () => {
  const intent: ActionIntent = { action: 'check', pointer: 'click', multiline: false }
  const target = await waitUntilActionable({ world: world({ status: 'unchanged', page: facts }), locator: byTestId, intent, deadline: new Deadline(1000), pendingNavigation: settled })
  assert.deepEqual(target, { ok: true, kind: 'unchanged', page: { url: 'http://127.0.0.1:4173/tasks', title: ' Tasks ' }, context: 7 })
})

test('check and uncheck refuse an element they cannot use, and name it', async () => {
  const agree: LocatorRecipe = { by: 'label', text: 'Agree' }
  const check: ActionIntent = { action: 'check', pointer: 'click', multiline: false }
  assert.deepEqual(await failureFor({ status: 'unsupported', reason: 'checkable', element: '<div class="toggle">' }, agree, check), {
    class: 'unsupported',
    message: `Could not check getByLabel('Agree'): it is <div class="toggle">, and check() works on a checkbox, a radio button, or an element whose role is checkbox, radio, switch, menuitemcheckbox or menuitemradio.`,
    details: { element: '<div class="toggle">' },
  })
  assert.deepEqual(await failureFor({ status: 'unsupported', reason: 'radio', element: '<input id="red">' }, agree, { ...check, action: 'uncheck' }), {
    class: 'unsupported',
    message: `Could not uncheck getByLabel('Agree'): it is a radio button, <input id="red">. A person unchecks a radio button by choosing another one, so check that one instead.`,
    details: { element: '<input id="red">' },
  })
})

test('a scroll names the element, or the page, in its failures', async () => {
  const scroll: ActionIntent = { action: 'scroll', multiline: false }
  assert.equal((await failureFor({ status: 'missing', empty: null }, byTestId, scroll, 30)).message, "Could not scroll getByTestId('password'): no element matched within 30 ms.")
  const pendingNavigation = () => ({ url: 'http://127.0.0.1:4173/next?code=1234' })
  const target = await waitUntilActionable({ world: world(ready), locator: undefined, intent: scroll, deadline: new Deadline(30), pendingNavigation })
  assert.ok(!target.ok)
  assert.match(target.failure.message, /^Could not scroll the page within 30 ms: the page was still opening http:\/\/127\.0\.0\.1:4173\/next, and Retest does not scroll in a document about to be replaced\.$/)
})

test('a select ready to choose carries the keys the page planned for it', async () => {
  const intent: ActionIntent = { action: 'select', choices: [{ label: 'Red' }], multiple: false, multiline: false }
  const plan = { quietMs: 0, keys: [{ key: 'r', toggle: false }] }
  const target = await waitUntilActionable({ world: world({ ...ready, token: null, plan }), locator: byTestId, intent, deadline: new Deadline(1000), pendingNavigation: settled })
  assert.deepEqual(target, { ...readyTarget, token: null, plan })
})

test('a select whose options no key reaches fails at once as unsupported, and types nothing', async () => {
  const intent: ActionIntent = { action: 'select', choices: [{ value: 'blank' }], multiple: false, multiline: false }
  const { failure, ms } = await timedFailure({ status: 'unreachable', element: '<select id="size">' }, byTestId, intent)
  assert.deepEqual(failure, {
    class: 'unsupported',
    message: `Could not select { value: 'blank' } in getByTestId('password'): it is <select id="size">, and no key a person can press there reaches what was asked, such as an option with no label to type or a hidden option. Retest typed nothing.`,
    details: { element: '<select id="size">' },
  })
  assert.ok(ms < 500, `refused at once, in ${ms} ms`)
})

test('a CSS selector the page cannot read fails at once as usage, naming the step that holds it', async () => {
  const scoped: LocatorRecipe = { by: 'role', role: 'button', within: [{ by: 'css', selector: 'li:nope' }] }
  const { failure, ms } = await timedFailure({ status: 'invalid', step: 0, message: "'li:nope' is not a valid selector." }, scoped, { action: 'click', multiline: false })
  assert.deepEqual(failure, {
    class: 'usage',
    message: "Could not click locator('li:nope').getByRole('button'): the page cannot read the CSS selector in locator('li:nope'). 'li:nope' is not a valid selector.",
    details: { selector: "locator('li:nope')" },
  })
  assert.ok(ms < 500, `refused at once, in ${ms} ms`)
})

test('a scoped locator that matches nothing says which step kept nothing, and a pick that kept none says so', async () => {
  const scoped: LocatorRecipe = { by: 'role', role: 'button', name: 'Delete', within: [{ by: 'testId', value: 'tasks' }, { by: 'role', role: 'listitem', pick: 5 }] }
  const click: ActionIntent = { action: 'click', multiline: false }
  const outer = await failureFor({ status: 'missing', empty: { step: 0, matched: 0 } }, scoped, click, 30)
  assert.equal(
    outer.message,
    "Could not click getByTestId('tasks').getByRole('listitem').nth(5).getByRole('button', { name: 'Delete' }): no element matched within 30 ms. getByTestId('tasks') matched no element.",
  )
  const picked = await failureFor({ status: 'missing', empty: { step: 1, matched: 3 } }, scoped, click, 30)
  assert.match(picked.message, / no element matched within 30 ms\. getByTestId\('tasks'\)\.getByRole\('listitem'\) matched 3 elements, and nth\(5\) keeps none of them\.$/)
  const last = await failureFor({ status: 'missing', empty: { step: 2, matched: 0 } }, scoped, click, 30)
  assert.match(last.message, /: no element matched within 30 ms\.$/, 'the last step that matched nothing is the whole locator, which the message names already')
})

async function timedFailure(readiness: Readiness, locator: LocatorRecipe, intent: ActionIntent) {
  const startedAt = performance.now()
  const failure = await failureFor(readiness, locator, intent, 5000)
  return { failure, ms: performance.now() - startedAt }
}
