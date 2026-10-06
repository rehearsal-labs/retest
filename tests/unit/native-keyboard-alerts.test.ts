import type { FakeElement } from './native-interaction-fake.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deskSignIn, openFake, phoneSignIn } from './native-interaction-fake.ts'

// The iOS software keyboard and basic app alerts against a stand-in executor: the keyboard waited for and dismissed by
// its return key once, the first-run card named and dismissed through its own button, an alert blocking an action, and
// an alert answered by pressing one named button once.

const click = 'POST /session/:session/element/:element/click'
const elements = 'POST /session/:session/elements'
const within = 'POST /session/:session/element/:element/elements'
const interrupted = { class: 'interrupted', message: 'The run was interrupted.' } as const

function deleteAlert(platform: 'ios-simulator' | 'macos'): FakeElement {
  const y = platform === 'macos' ? 100 : 300
  return { type: platform === 'macos' ? 'Sheet' : 'Alert', frame: { x: 40, y, width: 300, height: 160 }, children: [
    { type: 'StaticText', label: 'Delete this task?', value: 'Delete this task?', frame: { x: 60, y: y + 20, width: 260, height: 20 } },
    { type: 'Button', label: 'Cancel', frame: { x: 60, y: y + 100, width: 100, height: 40 } },
    { type: 'Button', label: 'Delete', frame: { x: 200, y: y + 100, width: 100, height: 40 } },
  ] }
}

test('the keyboard is waited for after a field is tapped, and its return key dismisses it with one press', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const early = await interaction.waitForKeyboard(300)
  assert.equal(!early.ok && early.failure.message, 'The software keyboard did not come up within 300 ms.')
  app.find('account-field').returnDismisses = true
  await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, 2000)
  assert.deepEqual(await interaction.waitForKeyboard(1000), { ok: true, state: { shown: true, firstRunCard: false } })
  const before = app.on(click).length
  assert.deepEqual(await interaction.dismissKeyboard(2000), { result: { ok: true }, input: 'sent' })
  assert.equal(app.on(click).length, before + 1)
  assert.deepEqual(JSON.parse(app.on(elements).at(-1)?.body ?? '{}').value, 'type == "XCUIElementTypeButton" AND name == "Return" AND label == "done"')
  assert.deepEqual(await interaction.keyboardState(1000), { ok: true, state: { shown: false, firstRunCard: false } })
  assert.deepEqual(await interaction.dismissKeyboard(1000), { result: { ok: true }, input: 'not_sent' }, 'no keyboard, nothing pressed')
})

test('a return key that does not dismiss the keyboard is said after its one press, and nothing more is pressed', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, 2000)
  const before = app.on(click).length
  const result = await interaction.dismissKeyboard(800)
  assert.equal(result.input, 'sent')
  assert.match(!result.result.ok ? result.result.failure.message : '', /pressed the keyboard's "done" key once, and the keyboard was still up when the time ran out: this field's return key does not dismiss it/)
  assert.equal(app.on(click).length, before + 1)
})

test('the first-run card about sliding to type is named and dismissed through its own Continue button, resolved exactly', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.firstRunCard = true
  app.find('account-field').returnDismisses = true
  await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, 2000)
  assert.deepEqual(await interaction.keyboardState(1000), { ok: true, state: { shown: true, firstRunCard: true } })
  const clicks = app.on(click).length
  assert.deepEqual(await interaction.dismissFirstRunCard(2000), { result: { ok: true }, input: 'sent' })
  assert.equal(app.on(click).length, clicks + 1)
  assert.deepEqual(JSON.parse(app.on(elements).at(-1)?.body ?? '{}').value, 'type == "XCUIElementTypeButton" AND label == "Continue"')
  assert.deepEqual(await interaction.keyboardState(1000), { ok: true, state: { shown: true, firstRunCard: false } })
  assert.deepEqual(await interaction.dismissFirstRunCard(1000), { result: { ok: true }, input: 'not_sent' })
})

test('dismissing the keyboard with the first-run card up presses Continue first, then the return key', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.firstRunCard = true
  app.find('account-field').returnDismisses = true
  await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, 2000)
  const clicks = app.on(click).length
  assert.deepEqual(await interaction.dismissKeyboard(3000), { result: { ok: true }, input: 'sent' })
  assert.equal(app.on(click).length, clicks + 2)
})

test('an element under the keyboard is not tapped: the action fails naming the keyboard', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: () => [...phoneSignIn(), { type: 'Button', identifier: 'low-button', label: 'Low', frame: { x: 16, y: 700, width: 370, height: 44 } }] })
  await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, 2000)
  const clicks = app.on(click).length
  const result = await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'low-button' } }, 400)
  assert.match(!result.result.ok ? result.result.failure.message : '', /the software keyboard covers it; dismiss the keyboard first/)
  assert.equal(app.on(click).length, clicks)
})

test('a macOS app has no software keyboard, and says so', async (t) => {
  const { interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  const result = await interaction.dismissKeyboard(1000)
  assert.equal(!result.result.ok && result.result.failure.class, 'unsupported')
})

test('an open alert blocks an action outside it, which fails naming the alert; Retest never taps through it', async (t) => {
  for (const platform of ['ios-simulator', 'macos'] as const) {
    const { app, interaction } = await openFake(t, { platform, screen: platform === 'macos' ? deskSignIn : phoneSignIn })
    app.alert = deleteAlert(platform)
    const verb = platform === 'macos' ? 'click' : 'tap'
    const result = await interaction.dispatch({ kind: verb, locator: { by: 'testId', value: 'sign-in-button' } }, 400)
    assert.equal(!result.result.ok && result.result.failure.class, 'not_actionable', platform)
    assert.match(!result.result.ok ? result.result.failure.message : '', new RegExp(`an alert blocks it: the ${platform === 'macos' ? 'Sheet' : 'Alert'} "Delete this task\\?" with buttons "Cancel", "Delete" is open over it`))
    assert.equal(app.on(click).length, 0)
  }
})

test('on iOS an alert is read from the tree and answered through the alert route with its one named button, once', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.alert = deleteAlert('ios-simulator')
  assert.deepEqual(await interaction.readAlert(1000), { ok: true, alert: { open: true, source: 'tree', text: 'Delete this task?', buttons: ['Cancel', 'Delete'] } })
  assert.deepEqual(await interaction.answerAlert({ button: 'Delete', route: 'accept' }, 2000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(app.on('POST /session/:session/alert/accept').map((request) => request.body), ['{"name":"Delete"}'])
  assert.deepEqual(await interaction.readAlert(1000), { ok: true, alert: { open: false } })
  const none = await interaction.answerAlert({ button: 'Delete', route: 'accept' }, 1000)
  assert.equal(none.input, 'not_sent')
  assert.match(!none.result.ok ? none.result.failure.message : '', /No alert is open/)
})

test('a button label two buttons share, or none, presses nothing', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.systemAlert = { text: 'Allow access?', buttons: ['OK', 'OK'] }
  const twice = await interaction.answerAlert({ button: 'OK', route: 'accept' }, 1000)
  assert.equal(!twice.result.ok && twice.result.failure.class, 'ambiguous')
  const missing = await interaction.answerAlert({ button: 'Allow', route: 'dismiss' }, 1000)
  assert.equal(!missing.result.ok && missing.result.failure.class, 'not_found')
  assert.equal(app.requests.filter((request) => request.route.includes('/alert/accept') || request.route.includes('/alert/dismiss')).length, 0)
})

test('a system alert outside the app\'s tree is read through WebDriverAgent\'s alert routes, redacted, and answered through them', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn, redact: (text) => text.replaceAll('hunter2', '{{password}}') })
  app.systemAlert = { text: 'Save hunter2 for this app?', buttons: ['Not Now', 'Save'] }
  assert.deepEqual(await interaction.readAlert(1000), { ok: true, alert: { open: true, source: 'executor', text: 'Save {{password}} for this app?', buttons: ['Not Now', 'Save'] } })
  assert.deepEqual(await interaction.answerAlert({ button: 'Not Now', route: 'dismiss' }, 2000), { result: { ok: true }, input: 'sent' })
  assert.deepEqual(app.on('POST /session/:session/alert/dismiss').map((request) => request.body), ['{"name":"Not Now"}'])
  assert.deepEqual(await interaction.readAlert(1000), { ok: true, alert: { open: false } }, 'the alert closed')
})

test('on macOS, whose runner has no alert routes, a sheet\'s named button is clicked once, resolved exactly inside the sheet', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.alert = deleteAlert('macos')
  const button = app.alert.children?.[2]
  if (button !== undefined) button.onClick = (fake) => { fake.alert = undefined }
  assert.deepEqual(await interaction.readAlert(1000), { ok: true, alert: { open: true, source: 'tree', text: 'Delete this task?', buttons: ['Cancel', 'Delete'] } })
  assert.deepEqual(await interaction.answerAlert({ button: 'Delete', route: 'accept' }, 2000), { result: { ok: true }, input: 'sent' })
  assert.equal(app.on(click).length, 1)
  assert.deepEqual(JSON.parse(app.on(within).at(-1)?.body ?? '{}').value, 'elementType == 9 AND label == "Delete"')
  assert.equal(app.requests.some((request) => request.route.includes('/alert/')), false)
})

test('after an iOS alert press, an alert route answer other than "no such alert" is no proof the alert closed: the answer fails with the press sent', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.systemAlert = { text: 'Allow access?', buttons: ['Allow', "Don't Allow"] }
  app.once('POST /session/:session/alert/accept', (fake) => fake.behaviours.set('GET /session/:session/alert/text', { error: 'unknown error' }))
  const answered = await interaction.answerAlert({ button: 'Allow', route: 'accept' }, 2000)
  assert.equal(answered.input, 'sent')
  assert.equal(answered.result.ok, false, 'an unreadable alert route is not a closed alert')
  assert.equal(!answered.result.ok && answered.result.failure.details?.['inputSent'], 'sent')
  assert.match(!answered.result.ok ? answered.result.failure.message : '', /Retest cannot tell whether the alert closed/)
  assert.equal(app.on('POST /session/:session/alert/accept').length, 1)
})

test('an alert press that went and got no answer is an unknown outcome, said as one, with the executor\'s error kept', async (t) => {
  const refused = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  refused.app.systemAlert = { text: 'Allow access?', buttons: ['Allow'] }
  refused.app.behaviours.set('POST /session/:session/alert/accept', { error: 'unknown error' })
  const failed = await refused.interaction.answerAlert({ button: 'Allow', route: 'accept' }, 2000)
  assert.equal(failed.input, 'unknown')
  assert.equal(!failed.result.ok && failed.result.failure.class, 'outcome_unknown')
  assert.equal(!failed.result.ok && failed.result.failure.details?.['executorError'], 'unknown error')
  assert.equal(!failed.result.ok && failed.result.failure.details?.['inputSent'], 'unknown')
  const cancelled = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  cancelled.app.systemAlert = { text: 'Allow access?', buttons: ['Allow'] }
  cancelled.app.behaviours.set('POST /session/:session/alert/accept', { hang: true })
  cancelled.interaction.onInput((sending) => {
    if (sending.kind === 'alert') setTimeout(() => cancelled.interaction.cancel(interrupted), 50)
  })
  const stopped = await cancelled.interaction.answerAlert({ button: 'Allow', route: 'accept' }, 3000)
  assert.equal(stopped.input, 'unknown')
  assert.match(!stopped.result.ok ? stopped.result.failure.message : '', /The request had gone; it is not taken back/)
  assert.doesNotMatch(!stopped.result.ok ? stopped.result.failure.message : '', /stopped before it sent/)
  assert.equal(cancelled.interaction.unknownOutcomes.filter((entry) => entry.source === 'input').length, 1)
})

test('an app\'s own text about sliding to type with a Continue button is never taken for the keyboard\'s first-run card', async (t) => {
  const screen = (): FakeElement[] => [
    { type: 'Other', frame: { x: 0, y: 400, width: 402, height: 200 }, children: [
      { type: 'StaticText', label: 'Slide to type faster with our keyboard', frame: { x: 20, y: 410, width: 360, height: 40 } },
      { type: 'Button', label: 'Continue', frame: { x: 150, y: 460, width: 100, height: 44 } },
    ] },
    ...phoneSignIn(),
  ]
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen })
  // No keyboard: nothing to dismiss, and the app's Continue is not pressed.
  assert.deepEqual(await interaction.keyboardState(1000), { ok: true, state: { shown: false, firstRunCard: false } })
  assert.deepEqual(await interaction.dismissKeyboard(1000), { result: { ok: true }, input: 'not_sent' })
  assert.deepEqual(await interaction.dismissFirstRunCard(1000), { result: { ok: true }, input: 'not_sent' })
  // With the keyboard up the app's text is still in the app's own window, so it is still not the card.
  app.find('account-field').returnDismisses = true
  await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, 2000)
  assert.deepEqual(await interaction.keyboardState(1000), { ok: true, state: { shown: true, firstRunCard: false } })
  const clicks = app.on(click).length
  assert.deepEqual(await interaction.dismissKeyboard(2000), { result: { ok: true }, input: 'sent' })
  assert.equal(app.on(click).length, clicks + 1, 'only the return key was pressed')
  assert.equal(app.requests.filter((request) => request.route === elements && request.body.includes('Continue')).length, 0)
})

test('an alert button still moving into place is not pressed: the press waits for a steady frame and fails naming it', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.alert = deleteAlert('macos')
  const button = app.alert.children?.[2]
  if (button !== undefined) button.moving = true
  const answered = await interaction.answerAlert({ button: 'Delete', route: 'accept' }, 800)
  assert.equal(answered.input, 'not_sent')
  assert.match(!answered.result.ok ? answered.result.failure.message : 'it pressed', /it kept moving/)
  assert.equal(app.on(click).length, 0)
})

test('a tree of another app read in passing is looked at again, while waiting for the keyboard and after its return key is pressed', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.find('account-field').returnDismisses = true
  await interaction.dispatch({ kind: 'tap', locator: { by: 'testId', value: 'account-field' } }, 2000)
  app.foreignReads = 1
  assert.deepEqual(await interaction.waitForKeyboard(2000), { ok: true, state: { shown: true, firstRunCard: false } })
  app.once(click, (fake) => {
    fake.foreignReads = 1
  })
  assert.deepEqual(await interaction.dismissKeyboard(3000), { result: { ok: true }, input: 'sent' })
  assert.equal(app.foreignReads, 0, 'the other app\'s tree was served and looked past')
})

test('a macOS app has no first-run card either: dismissing it is refused by name and sends nothing', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  const result = await interaction.dismissFirstRunCard(1000)
  assert.equal(result.input, 'not_sent')
  assert.equal(!result.result.ok && result.result.failure.class, 'unsupported')
  assert.equal(!result.result.ok && result.result.failure.message, 'A macOS app has no software keyboard.')
  assert.equal(app.requests.length, 0)
})
