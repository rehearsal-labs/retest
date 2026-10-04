import type { FakeApp } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { elementRoutes, ExecutorElements, executorRoutes } from '../../src/native/webdriver-client.ts'
import { deskSignIn, openFake, phoneSignIn } from './native-interaction-fake.ts'

// Native input against a stand-in executor: each input sent once through the exact routes, Retest's own clear and type
// for fill, byte for byte, an unanswered request recorded as an unknown outcome and never sent again, and a stale
// reference refused with nothing sent.

const click = 'POST /session/:session/element/:element/click'
const keys = 'POST /session/:session/wda/keys'
const actions = 'POST /session/:session/actions'
const interrupted = { class: 'interrupted', message: 'The run was interrupted.' } as const

function inputBodies(app: FakeApp): string[] {
  return app.requests.filter((request) => request.route === click || request.route === keys || request.route === actions || request.route.endsWith('/scroll')).map((request) => `${request.route.slice(request.route.lastIndexOf('/') + 1)} ${request.body}`)
}

function noRepeatingRoute(app: FakeApp): void {
  for (const request of app.requests) assert.doesNotMatch(request.path, /\/(value|clear)$/, request.path)
}

test('the interaction layer adds nine exact routes to the client\'s sixteen, none of which types, clears or repeats input', () => {
  assert.equal(new Set(elementRoutes).size, 9)
  assert.equal(new Set([...executorRoutes, ...elementRoutes]).size, 25, 'no route is listed twice')
  for (const route of elementRoutes) assert.doesNotMatch(route, /\/value|\/clear|\/keyboard\/dismiss/, route)
  assert.deepEqual(Object.getOwnPropertyNames(ExecutorElements.prototype).filter((name) => /value|clear/i.test(name)), [])
})

test('an iOS tap and a macOS click are one click request; each platform refuses the other\'s verb with nothing sent', async (t) => {
  const phone = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  assert.deepEqual(await phone.interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 2000), { result: { ok: true, kind: 'tap' }, input: 'sent' })
  assert.deepEqual(inputBodies(phone.app), ['click {}'])
  const wrong = await phone.interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 2000)
  assert.equal(!wrong.result.ok && wrong.result.failure.class, 'unsupported')
  const desk = await openFake(t, { platform: 'macos', screen: deskSignIn })
  assert.deepEqual((await desk.interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 2000)).input, 'sent')
  const tap = await desk.interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 2000)
  assert.equal(!tap.result.ok && tap.result.failure.message, 'A macOS app has no touch screen. Use click().')
  assert.deepEqual(inputBodies(desk.app), ['click {}'])
})

test('a macOS fill is one click, Command-A and Delete as one keys request, the text as another, then a read-back, byte for byte', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.find('account-field').text = 'old'
  assert.deepEqual(await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: 'Ada' }, 3000), { result: { ok: true, kind: 'fill' }, input: 'sent' })
  assert.deepEqual(inputBodies(app), ['click {}', 'keys {"keys":[{"key":"a","modifierFlags":16},"XCUIKeyboardKeyDelete"]}', 'keys {"keys":[{"key":"a","modifierFlags":2},"d","a"]}'])
  assert.equal(app.find('account-field').text, 'Ada')
  assert.deepEqual(interaction.inputs.map((record) => [record.kind, record.input, record.readBack ?? '']), [['click', 'sent', ''], ['clear', 'sent', ''], ['keys', 'sent', 'matched']])
  noRepeatingRoute(app)
})

test('an iOS fill clears with one backspace and forward delete per character it read, then types once, byte for byte', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.find('account-field').text = 'ad'
  assert.equal((await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: 'ada' }, 4000)).input, 'sent')
  // JSON escapes the backspace and leaves the forward delete, U+007F, as its own byte.
  assert.deepEqual(inputBodies(app), ['click {}', 'keys {"value":["\\b\u007f\\b\u007f"]}', 'keys {"value":["ada"]}'])
  assert.equal(app.find('account-field').text, 'ada')
  noRepeatingRoute(app)
})

test('an empty field is typed into without a clear; its placeholder is not taken for text', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  assert.equal((await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: 'ada' }, 4000)).input, 'sent')
  assert.deepEqual(inputBodies(app), ['click {}', 'keys {"value":["ada"]}'])
})

test('a secure field reads back as masking characters, counted and never shown; a macOS secure field is always cleared, and one that shows nothing is said unread', async (t) => {
  const phone = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  assert.equal((await phone.interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter2-secret', secret: 'password' }, 4000)).input, 'sent')
  assert.equal(phone.interaction.inputs.at(-1)?.readBack, 'length_matched')
  const desk = await openFake(t, { platform: 'macos', screen: deskSignIn })
  assert.equal((await desk.interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter2-secret', secret: 'password' }, 4000)).input, 'sent')
  assert.deepEqual(inputBodies(desk.app).slice(0, 2), ['click {}', 'keys {"keys":[{"key":"a","modifierFlags":16},"XCUIKeyboardKeyDelete"]}'])
  assert.equal(desk.interaction.inputs.at(-1)?.readBack, 'length_matched', "AppKit masks the text it is editing with U+F79A, one per character")
  const blank = await openFake(t, { platform: 'macos', screen: deskSignIn })
  blank.app.find('password-field').showsNothing = true
  assert.equal((await blank.interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter2-secret', secret: 'password' }, 4000)).input, 'sent')
  assert.equal(blank.interaction.inputs.at(-1)?.readBack, 'not_exposed')
  // A secure field whose read-back disagrees is said with counts only.
  const lost = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  lost.app.behaviours.set(keys, { answer: null })
  const failed = await lost.interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'password-field' }, value: 'hunter2-secret', secret: 'password' }, 4000)
  assert.equal(failed.input, 'sent')
  const message = !failed.result.ok ? failed.result.failure.message : ''
  assert.match(message, /Filled getByTestId\('password-field'\) with \{\{password\}\} once, and the secure field shows 0 character\(s\) where 14 were typed/)
  assert.doesNotMatch(JSON.stringify(failed), /hunter2/)
})

test('a read-back that differs fails after the one typing, naming what the field shows, and nothing is typed again', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.behaviours.set(keys, { answer: null })
  const result = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: 'ada' }, 3000)
  assert.equal(result.input, 'sent')
  assert.equal(!result.result.ok && result.result.failure.class, 'not_actionable')
  assert.match(!result.result.ok ? result.result.failure.message : '', /reads back as ""\. Retest typed nothing more\./)
  assert.equal(app.on(keys).length, 1)
})

test('fill takes a field, and a single-line field refuses a line break, with nothing sent', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  const button = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'sign-in-button' }, value: 'x' }, 5000)
  assert.equal(!button.result.ok && button.result.failure.class, 'unsupported')
  const multiline = await interaction.dispatch({ kind: 'fill', locator: { by: 'testId', value: 'account-field' }, value: 'a\nb' }, 5000)
  assert.equal(!multiline.result.ok && multiline.result.failure.class, 'unsupported')
  assert.deepEqual(inputBodies(app), [])
})

test('a click with no answer by its deadline is an unknown outcome in the ledger, sent once and never again', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.behaviours.set(click, { hang: true })
  const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 800)
  assert.equal(result.input, 'unknown')
  assert.equal(!result.result.ok && result.result.failure.class, 'timeout')
  assert.equal(!result.result.ok && result.result.failure.details?.['inputSent'], 'unknown')
  assert.equal(app.on(click).length, 1)
  const [unknown] = interaction.unknownOutcomes
  assert.equal(unknown?.source === 'input' && unknown.outcome.kind, 'tap')
  const reconciled = await interaction.reconcile(1000)
  assert.deepEqual(reconciled[0]?.source === 'input' && reconciled[0].outcome.reconciled, { ok: true, running: true, pids: [4242] })
  assert.equal(app.on(click).length, 1, 'reconciliation sends nothing to the app')
})

test('a cancel after the click went leaves its outcome unknown, takes nothing back, and sends nothing more', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.behaviours.set(click, { hang: true })
  interaction.onInput((sending) => {
    if (sending.kind === 'click') setTimeout(() => interaction.cancel(interrupted), 50)
  })
  const result = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 5000)
  assert.equal(result.input, 'unknown')
  assert.equal(!result.result.ok && result.result.failure.class, 'interrupted')
  assert.match(!result.result.ok ? result.result.failure.message : '', /The request had gone; it is not taken back/)
  assert.equal(interaction.unknownOutcomes.length, 1)
  const later = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 2000)
  assert.equal(later.input, 'not_sent')
  assert.equal(app.on(click).length, 1)
})

test('a connection dropped after the click went is an unknown outcome, and the session is lost', async (t) => {
  const { app, interaction, session } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.behaviours.set(click, { drop: true })
  const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 2000)
  assert.equal(result.input, 'unknown')
  assert.equal(!result.result.ok && result.result.failure.class, 'outcome_unknown')
  const state = await session.appState(1000)
  assert.equal(!state.ok && state.failure.class, 'session_lost')
})

test('an element resolved before a relaunch is refused afterwards, as the session refuses its reference, with nothing sent', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const resolved = await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 2000)
  if (!resolved.ok) throw new Error(resolved.failure.message)
  assert.equal((await interaction.terminate(2000)).result.ok, true)
  assert.equal((await interaction.launch(2000)).result.ok, true)
  assert.equal(interaction.checkReference(resolved.element.reference)?.details?.['stale'], true)
  const pressed = await interaction.pressResolved(resolved.element, 2000)
  assert.equal(pressed.input, 'not_sent')
  assert.match(!pressed.result.ok ? pressed.result.failure.message : '', /is from launch 1; the app is on launch 2/)
  assert.equal(app.on(click).length, 0)
})

test('press sends named keys and chords through the keys route; iOS takes text only, so a chord or a key with no text is refused', async (t) => {
  const desk = await openFake(t, { platform: 'macos', screen: deskSignIn })
  for (const key of ['Meta+A', 'Enter', 'Shift+Tab', 'ControlOrMeta+Z', 'a']) assert.equal((await desk.interaction.dispatch({ kind: 'press', key }, 2000)).input, 'sent', key)
  assert.deepEqual(inputBodies(desk.app), [
    'keys {"keys":[{"key":"a","modifierFlags":16}]}',
    'keys {"keys":["XCUIKeyboardKeyReturn"]}',
    'keys {"keys":[{"key":"XCUIKeyboardKeyTab","modifierFlags":2}]}',
    'keys {"keys":[{"key":"z","modifierFlags":16}]}',
    'keys {"keys":["a"]}',
  ])
  const phone = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  assert.equal((await phone.interaction.dispatch({ kind: 'press', key: 'Enter' }, 2000)).input, 'sent')
  for (const key of ['Control+A', 'ArrowUp', 'Escape']) {
    const refused = await phone.interaction.dispatch({ kind: 'press', key }, 2000)
    assert.equal(!refused.result.ok && refused.result.failure.class, 'unsupported', key)
  }
  assert.deepEqual(inputBodies(phone.app), ['keys {"value":["\\n"]}'])
})

test('press on an element focuses a field by clicking it once, and refuses a button that lacks the focus rather than press it', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  const button = await interaction.dispatch({ kind: 'press', locator: { by: 'testId', value: 'sign-in-button' }, key: 'Enter' }, 2000)
  assert.equal(!button.result.ok && button.result.failure.class, 'unsupported')
  assert.deepEqual(inputBodies(app), [])
  assert.equal((await interaction.dispatch({ kind: 'press', locator: { by: 'testId', value: 'account-field' }, key: 'Enter' }, 2000)).input, 'sent')
  assert.deepEqual(inputBodies(app), ['click {}', 'keys {"keys":["XCUIKeyboardKeyReturn"]}'])
})

test('an iOS scroll is one touch drag through exactly the points asked, inside the element; a macOS scroll is one runner scroll', async (t) => {
  const phone = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'CollectionView', identifier: 'form', frame: { x: 0, y: 100, width: 400, height: 600 } }] })
  assert.equal((await phone.interaction.dispatch({ kind: 'scroll', locator: { by: 'testId', value: 'form' }, x: 0, y: 200 }, 3000)).input, 'sent')
  assert.deepEqual(JSON.parse(phone.app.on(actions)[0]?.body ?? '{}'), { actions: [{ type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' }, actions: [
    { type: 'pointerMove', duration: 0, x: 200, y: 400 },
    { type: 'pointerDown', button: 0 },
    { type: 'pointerMove', duration: 600, x: 200, y: 200 },
    { type: 'pause', duration: 200 },
    { type: 'pointerUp', button: 0 },
  ] }] })
  const far = await phone.interaction.dispatch({ kind: 'scroll', locator: { by: 'testId', value: 'form' }, x: 0, y: 400 }, 3000)
  assert.equal(!far.result.ok && far.result.failure.class, 'usage')
  assert.equal(phone.app.on(actions).length, 1)
  const desk = await openFake(t, { platform: 'macos', screen: () => [{ type: 'Outline', identifier: 'task-list', frame: { x: 40, y: 260, width: 600, height: 240 } }] })
  assert.equal((await desk.interaction.dispatch({ kind: 'scroll', locator: { by: 'testId', value: 'task-list' }, x: 0, y: 120 }, 3000)).input, 'sent')
  assert.deepEqual(inputBodies(desk.app), ['scroll {"deltaX":0,"deltaY":-120}'])
})

test('a swipe is one touch drag on iOS and refused on macOS; a tap with no element is refused rather than sent to a point', async (t) => {
  const phone = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'CollectionView', identifier: 'form', frame: { x: 0, y: 100, width: 402, height: 600 } }] })
  assert.equal((await phone.interaction.gesture({ kind: 'swipe', direction: 'up', locator: { by: 'testId', value: 'form' } }, 3000)).input, 'sent')
  const swiped = JSON.parse(phone.app.on(actions)[0]?.body ?? '{}')
  assert.deepEqual(swiped.actions[0].actions.map((step: { x?: number; y?: number }) => [step.x, step.y]), [[201, 400], [undefined, undefined], [201, 200], [undefined, undefined]])
  const blind = await phone.interaction.gesture({ kind: 'tap' }, 1000)
  assert.equal(!blind.result.ok && blind.result.failure.class, 'unsupported')
  const desk = await openFake(t, { platform: 'macos', screen: deskSignIn })
  const swipe = await desk.interaction.gesture({ kind: 'swipe', direction: 'up' }, 1000)
  assert.equal(!swipe.result.ok && swipe.result.failure.class, 'unsupported')
  assert.equal(phone.app.on(actions).length, 1)
})

test('an observe answers with the look, its id and the session that served it, and sends no input', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  const looked = await interaction.dispatch({ kind: 'observe', locator: { by: 'testId', value: 'service-status' } }, 2000)
  assert.equal(looked.input, 'not_sent')
  assert.equal(looked.result.ok && looked.result.kind === 'observe' && looked.result.observation.text, 'Connected to http://127.0.0.1:4310')
  assert.equal(looked.result.ok && looked.result.kind === 'observe' && looked.result.sessionId, 'attempt:desk')
  assert.deepEqual(inputBodies(app), [])
})


test('press refuses a field whose click redirects keyboard focus and sends no global key', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.find('account-field').onClick = (current) => { current.focused = current.find('password-field') }
  const pressed = await interaction.dispatch({ kind: 'press', locator: { by: 'testId', value: 'account-field' }, key: 'a' }, 2000)
  assert.equal(!pressed.result.ok && pressed.result.failure.class, 'not_actionable')
  assert.equal(pressed.input, 'sent', 'the one focusing click went, but no key')
  assert.deepEqual(inputBodies(app), ['click {}'])
  assert.equal(app.find('password-field').text, '')
})

test('press sends no iOS key when the executor cannot confirm the requested field focus', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const field = app.find('account-field')
  field.reportedFocus = false
  const pressed = await interaction.dispatch({ kind: 'press', locator: { by: 'testId', value: 'account-field' }, key: 'a' }, 2000)
  assert.equal(!pressed.result.ok && pressed.result.failure.class, 'not_actionable')
  assert.equal(app.focused, field, 'the executor can type here but does not expose that fact')
  assert.deepEqual(inputBodies(app), ['click {}'])
  assert.equal(field.text, '')
})
