import type { FakeElement } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { syncBuiltinESMExports } from 'node:module'
import { test } from 'node:test'
import { earlyClock } from './early-waits-clock.ts'
import { deskSignIn, openFake, phoneSignIn } from './native-interaction-fake.ts'

// Actionability against a stand-in executor: one match in the session's own tree, visible, enabled where the action
// needs it, resolved by the executor with an exact predicate whose count equals the tree's, inside the owned window on
// macOS, the identifiers read back, a steady frame read the whole gap apart, hittable, and on macOS the app in front
// with nothing of another process over the element.

const elements = 'POST /session/:session/elements'
const within = 'POST /session/:session/element/:element/elements'
const attribute = 'GET /session/:session/element/:element/attribute/:name'
const click = 'POST /session/:session/element/:element/click'

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
  assert.deepEqual(JSON.parse(app.on(elements)[0]?.body ?? '{}'), { using: 'predicate string', value: 'type == "XCUIElementTypeButton" AND name == "sign-in-button" AND label == "Sign in"' })
  assert.deepEqual(app.on(attribute).map((request) => request.path.slice(request.path.lastIndexOf('/') + 1)), ['name', 'label', 'hittable'])
  // The second read of the frame comes the whole gap after the tree that gave the first.
  const [source] = app.on('GET /session/:session/source')
  const [rect] = app.on('GET /session/:session/element/:element/rect')
  assert.ok(source !== undefined && rect !== undefined && rect.at - source.at >= 100, `the frame was read again ${rect === undefined || source === undefined ? 'never' : Math.round(rect.at - source.at)} ms after the tree`)
})

test('on macOS the identifier is read back as identifier, and the app must be in front with nothing of another process over the element', async (t) => {
  const { app, interaction, windows } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  assert.equal((await interaction.resolve({ by: 'testId', value: 'sign-in-button' }, 2000)).ok, true)
  // The window is resolved first and its identifier read back; the element is looked for inside it only.
  assert.deepEqual(JSON.parse(app.on(elements)[0]?.body ?? '{}').value, 'elementType == 4 AND identifier == "main" AND title == "TaskDesk"')
  assert.deepEqual(JSON.parse(app.on(within)[0]?.body ?? '{}').value, 'elementType == 9 AND identifier == "sign-in-button" AND label == "Sign in"')
  assert.equal(app.on(elements).length, 1, 'nothing is looked for in the whole app but the window')
  assert.deepEqual(app.on(attribute).map((request) => request.path.slice(request.path.lastIndexOf('/') + 1)), ['identifier', 'identifier', 'hittable'])
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
  app.behaviours.set(within, { answer: [{ 'element-6066-11e4-a52e-4f735466cecf': 'a' }, { 'element-6066-11e4-a52e-4f735466cecf': 'b' }] })
  const result = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 400)
  assert.equal(!result.result.ok && result.result.failure.class, 'not_actionable')
  assert.match(!result.result.ok ? result.result.failure.message : '', /the executor found 2 element\(s\) for "elementType == 9 AND identifier == \\"sign-in-button\\" AND label == \\"Sign in\\"" where the tree showed 1/)
  assert.equal(app.on('POST /session/:session/element/:element/click').length, 0)
})

test('an identifier that reads back as another fails at once, and nothing is clicked', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  // The window's identifier reads back as itself; the button's, read next, as another.
  app.once(attribute, (fake) => fake.once(attribute, (again) => again.behaviours.set(attribute, { answer: 'other-button' })))
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

test('an element whose label changed after the tree was read is not taken on its identifier alone, and nothing is tapped', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'Button', identifier: 'primary-action', label: 'Save', frame: { x: 16, y: 300, width: 200, height: 44 } }] })
  // Between the tree Retest read and its lookup on the executor, the button now says Delete under the same identifier.
  app.once(elements, (fake) => {
    fake.find('primary-action').label = 'Delete'
  })
  const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'role', role: 'button', name: 'Save' } }, 800)
  assert.equal(!result.result.ok && result.result.failure.class, 'not_found', !result.result.ok ? result.result.failure.message : 'it tapped')
  assert.equal(app.on(click).length, 0)
  assert.match(app.on(elements)[0]?.body ?? '', /label == \\"Save\\"/)
})

test('an ancestor an element is resolved inside has its identifier read back first, and one that reads back as another is not searched', async (t) => {
  const row = (id: string, y: number): FakeElement => ({ type: 'Other', identifier: id, frame: { x: 0, y, width: 400, height: 44 }, children: [{ type: 'Button', label: 'Show', frame: { x: 300, y, width: 80, height: 44 } }] })
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: () => [row('row-1', 200), row('row-2', 260)] })
  // Only the first attribute read answers wrong: the ancestor's identifier, read back before anything inside it.
  app.once(attribute, (fake) => {
    fake.behaviours.set(attribute, { answer: 'row-1' })
    fake.once(attribute, (again) => again.behaviours.delete(attribute))
  })
  const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'role', role: 'button', name: 'Show', within: [{ by: 'testId', value: 'row-2' }] } }, 2000)
  assert.equal(!result.result.ok && result.result.failure.details?.['check'], 'identifier', !result.result.ok ? result.result.failure.message : 'it tapped')
  assert.match(!result.result.ok ? result.result.failure.message : '', /reads back as "row-1", not "row-2"/)
  assert.equal(app.on(within).length, 0, 'nothing was looked for inside the wrong row')
  assert.equal(app.on(click).length, 0)
})

test('on macOS only the full-screen Automation Mode overlay and the window server\'s pointer pass over an element; a smaller overlay window or another process at the pointer layer covers it', async (t) => {
  const { app, interaction, windows } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  const frame = app.windowFrame
  const own = [app.pid, 0, frame.x, frame.y, frame.width, frame.height] as const
  // The sign-in button's centre is at 139,208.
  await windows?.setWindows([[950, 1000, 100, 190, 200, 60], own])
  const overlay = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 2500)
  assert.match(!overlay.result.ok ? overlay.result.failure.message : 'it clicked', /1 window\(s\) of other processes lie over it \(layer 1000\)/)
  await windows?.setWindows([[777, 2147483630, 130, 200, 28, 28], own])
  const pointer = await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 2500)
  assert.match(!pointer.result.ok ? pointer.result.failure.message : 'it clicked', /1 window\(s\) of other processes lie over it \(layer 2147483630\)/)
  assert.equal(app.on(click).length, 0)
  await windows?.setWindows([[601, 2147483630, 130, 200, 28, 28], [950, 1000, 0, 0, 1728, 1117], own])
  assert.equal((await interaction.dispatch({ kind: 'click', locator: { by: 'testId', value: 'sign-in-button' } }, 2000)).input, 'sent')
})

test('an action with too little time left for the whole frame gap fails as not steady in time, and nothing is sent', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const clock = earlyClock(t)
  // Charge the first tree its read cost on the deadline clock. A wall-clock delay can exhaust an executor lookup
  // before this test reaches the frame-gap check, which correctly returns that lookup's timeout instead.
  app.once('GET /session/:session/source', () => clock.spend(220))
  try {
    const result = await clock.run(interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'sign-in-button' } }, 300))
    assert.equal(!result.result.ok && result.result.failure.details?.['check'], 'stable', !result.result.ok ? result.result.failure.message : 'it tapped')
    assert.match(!result.result.ok ? result.result.failure.message : '', /too little time was left to read its frame twice 100 ms apart/)
    assert.equal(app.on('GET /session/:session/element/:element/rect').length, 0, 'no frame was read on a shorter gap')
    assert.equal(app.on(click).length, 0)
    assert.ok(clock.now() >= 300 && clock.now() < 302, `readiness ended at ${clock.now()} ms`)
  } finally {
    t.mock.restoreAll()
    t.mock.timers.reset()
    syncBuiltinESMExports()
  }
})

test('an element whose tree carries no enabled is not taken for disabled or enabled: the action waits and names what was not reported', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: () => [{ type: 'Button', identifier: 'go', label: 'Go', omit: ['enabled'], frame: { x: 16, y: 300, width: 100, height: 44 } }] })
  const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'go' } }, 400)
  assert.match(!result.result.ok ? result.result.failure.message : '', /the executor did not report whether the Button "go" is enabled: its tree carries no enabled/)
  assert.equal(app.on(click).length, 0)
})
