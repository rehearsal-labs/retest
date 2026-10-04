import type { FakeElement } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deskSignIn, openFake, phoneSignIn } from './native-interaction-fake.ts'

// Actionability against a stand-in executor: one match in the session's own tree, visible, enabled where the action
// needs it, resolved by the executor with an exact predicate whose count equals the tree's, the identifier read back,
// a steady frame, hittable, and on macOS the app in front with nothing of another process over the element.

const elements = 'POST /session/:session/elements'
const attribute = 'GET /session/:session/element/:element/attribute/:name'

test('on iOS an element is resolved by an exact predicate, its identifier read back, its frame read twice and its hittable checked', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const resolved = await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 2000)
  assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.failure.message)
  assert.deepEqual(app.requests.map((request) => request.route), [
    'GET /session/:session/source',
    elements,
    attribute,
    attribute,
    'GET /session/:session/element/:element/rect',
    attribute,
  ])
  assert.deepEqual(JSON.parse(app.on(elements)[0]?.body ?? '{}'), { using: 'predicate string', value: 'type == "XCUIElementTypeButton" AND name == "sign-in-button"' })
  assert.deepEqual(app.on(attribute).map((request) => request.path.slice(request.path.lastIndexOf('/') + 1)), ['name', 'label', 'hittable'])
})

test('on macOS the identifier is read back as identifier, and the app must be in front with nothing of another process over the element', async (t) => {
  const { app, interaction, windows } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  assert.equal((await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 2000)).ok, true)
  assert.deepEqual(JSON.parse(app.on(elements)[0]?.body ?? '{}').value, 'elementType == 9 AND identifier == "sign-in-button"')
  assert.deepEqual(app.on(attribute).map((request) => request.path.slice(request.path.lastIndexOf('/') + 1)), ['identifier', 'hittable'])
  const frame = app.windowFrame
  // The pointer's window and Automation Mode's overlay lie over everything and take no click.
  await windows?.setWindows([[601, 2147483630, 130, 200, 28, 28], [950, 1000, 0, 0, 1728, 1117], [app.pid, 0, frame.x, frame.y, frame.width, frame.height]])
  assert.equal((await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 2000)).ok, true)
  await windows?.setWindows([[777, 1000, 100, 190, 200, 60], [app.pid, 0, frame.x, frame.y, frame.width, frame.height]])
  const covered = await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 5000)
  assert.equal(!covered.ok && covered.failure.class, 'not_actionable')
  assert.match(!covered.ok ? covered.failure.message : '', /1 window\(s\) of other processes lie over it \(layer 1000\)/)
  await windows?.setWindows([[app.pid, 0, frame.x, frame.y, frame.width, frame.height]])
  app.inFront = false
  const behind = await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 5000)
  assert.match(!behind.ok ? behind.failure.message : '', /the app is not in front/)
})

test('several matches fail at once as ambiguous, naming the count, and the executor is never asked', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: () => [{ type: 'Button', label: 'Show', frame: { x: 30, y: 90, width: 50, height: 20 } }, { type: 'Button', label: 'Show', frame: { x: 30, y: 120, width: 50, height: 20 } }] })
  const started = performance.now()
  const result = await interaction.dispatch({ kind: 'click', locator: { by: 'role', role: 'button', name: 'Show' } }, 5000)
  assert.ok(performance.now() - started < 2000, 'it did not wait')
  assert.equal(!result.result.ok && result.result.failure.class, 'ambiguous')
  assert.match(!result.result.ok ? result.result.failure.message : '', /it matches 2 elements, and a locator must match exactly one/)
  assert.equal(app.on(elements).length, 0)
  assert.equal(result.input, 'not_sent')
})

test('no match waits for the deadline and fails as not found; an iOS name equal to its label is named, never taken as an identifier', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'Button', label: 'Create task', frame: { x: 16, y: 505, width: 370, height: 55 } }] })
  const started = performance.now()
  const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'Create task' } }, 400)
  assert.ok(performance.now() - started >= 390)
  assert.equal(!result.result.ok && result.result.failure.class, 'not_found')
  assert.match(!result.result.ok ? result.result.failure.message : '', /no element matched within 400 ms\. 1 element has "Create task" as both name and label/)
  assert.equal(app.on('POST /session/:session/element/:element/click').length, 0)
})

test('an executor count that differs from the tree is refused: nothing is acted on, and the failure names both counts', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.behaviours.set(elements, { answer: [{ 'element-6066-11e4-a52e-4f735466cecf': 'a' }, { 'element-6066-11e4-a52e-4f735466cecf': 'b' }] })
  const result = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 400)
  assert.equal(!result.result.ok && result.result.failure.class, 'not_actionable')
  assert.match(!result.result.ok ? result.result.failure.message : '', /the executor found 2 element\(s\) for "elementType == 9 AND identifier == \\"sign-in-button\\"" where the tree showed 1/)
  assert.equal(app.on('POST /session/:session/element/:element/click').length, 0)
})

test('an identifier that reads back as another fails at once, and nothing is clicked', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.behaviours.set(attribute, { answer: 'other-button' })
  const result = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 3000)
  assert.equal(!result.result.ok && result.result.failure.class, 'not_actionable')
  assert.match(!result.result.ok ? result.result.failure.message : '', /reads back as "other-button", not "sign-in-button"/)
  assert.equal(app.on('POST /session/:session/element/:element/click').length, 0)
})

test('a disabled, hidden, moving or unhittable element is waited for and fails naming what was not true', async (t) => {
  const cases: { element: Partial<FakeElement>; reason: RegExp }[] = [
    { element: { enabled: false }, reason: /it is disabled: the Button "go" is disabled/ },
    { element: { visible: false }, reason: /it is not visible/ },
    { element: { moving: true }, reason: /it kept moving: its frame moved from/ },
    { element: { hittable: false }, reason: /the executor reports it is not hittable/ },
  ]
  for (const { element, reason } of cases) {
    const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'Button', identifier: 'go', label: 'Go', frame: { x: 16, y: 300, width: 100, height: 44 }, ...element }] })
    const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'go' } }, 500)
    assert.equal(!result.result.ok && result.result.failure.class, 'not_actionable', JSON.stringify(element))
    assert.match(!result.result.ok ? result.result.failure.message : '', reason)
    assert.equal(app.on('POST /session/:session/element/:element/click').length, 0)
  }
})

test('a lost executor during a lookup loses the session, and nothing more is sent', async (t) => {
  const { app, interaction, session } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  await app.close()
  const result = await interaction.observe({ by: 'testId', value: 'sign-in-button' }, 2000)
  assert.equal(!result.ok && result.failure.class, 'session_lost')
  const state = await session.appState(1000)
  assert.equal(!state.ok && state.failure.class, 'session_lost', 'the session refuses every later request')
})

test('a tree with no window yet, as just after a launch, is looked at again until the window comes, for an action and for a check', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.windowHidden = true
  setTimeout(() => {
    app.windowHidden = false
  }, 300)
  const resolved = await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 3000)
  assert.equal(resolved.ok, true, resolved.ok ? '' : resolved.failure.message)
  app.windowHidden = true
  setTimeout(() => {
    app.windowHidden = false
  }, 300)
  const checked = await interaction.expect({ by: 'testId', value: 'service-status' }, { matcher: 'toBeVisible' }, 3000)
  assert.equal(checked.passed, true, checked.failure?.message)
  app.windowHidden = true
  const never = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 400)
  assert.match(!never.result.ok ? never.result.failure.message : '', /within 400 ms: Retest could not read the app's tree: Reading the app's tree: The app has no window in its tree\./)
  const unread = await interaction.expect({ by: 'testId', value: 'service-status' }, { matcher: 'toBeVisible' }, 400)
  assert.match(unread.failure?.message ?? '', /The app has no window in its tree/)
})
