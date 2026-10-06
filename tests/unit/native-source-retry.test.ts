import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NativePageAdapter } from '../../src/runner/native-pool.ts'
import { waitUntilDeadline } from '../../src/assertions/wait-before-read.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { deskSignIn, openFake, phoneSignIn } from './native-interaction-fake.ts'
import { earlyClock } from './early-waits-clock.ts'

const sourceRoute = 'GET /session/:session/source'
const locator = { by: 'testId', value: 'service-status' } as const
const field = { by: 'testId', value: 'account-field' } as const
const keysRoute = 'POST /session/:session/wda/keys'
const clickRoute = 'POST /session/:session/element/:element/click'

for (const platform of ['ios-simulator', 'macos'] as const) {
  test(`a ${platform} runner observation looks again at a transient scope refusal within its budget`, async (t) => {
    const { app, interaction } = await openFake(t, { platform, screen: platform === 'macos' ? deskSignIn : phoneSignIn })
    if (platform === 'ios-simulator') app.foreignReads = 2
    else {
      app.windowHidden = true
      app.once(sourceRoute, () => app.once(sourceRoute, () => { app.windowHidden = false }))
    }
    const read = await new NativePageAdapter(interaction).execute({ kind: 'observe', locator }, 1000)
    assert.equal(read.ok, true, read.ok ? '' : read.failure.message)
    assert.ok(app.on(sourceRoute).length >= 2)
    assert.equal(app.requests.some(request => request.route.startsWith('POST')), false, 'only observations may repeat')
  })

  for (const phase of ['before input', 'after typing'] as const) {
    test(`a ${platform} account fill waits for its owned tree ${phase} and sends each input once`, async (t) => {
      const { app, interaction } = await openFake(t, { platform, screen: platform === 'macos' ? deskSignIn : phoneSignIn })
      app.find('account-field').text = 'old'
      const refuse = (): void => {
        if (platform === 'ios-simulator') app.foreignReads = 2
        else {
          app.windowHidden = true
          app.once(sourceRoute, () => app.once(sourceRoute, () => { app.windowHidden = false }))
        }
      }
      if (phase === 'before input') refuse()
      else app.once(keysRoute, () => app.once(keysRoute, refuse))
      const filled = await interaction.dispatch({ kind: 'fill', locator: field, value: 'ada' }, 3000)
      assert.deepEqual(filled, { result: { ok: true, kind: 'fill' }, input: 'sent' })
      assert.equal(app.find('account-field').text, 'ada')
      assert.equal(app.on(clickRoute).length, 1, 'focus is sent once')
      assert.equal(app.on(keysRoute).length, 2, 'one clear and one typing, including while read-back waits')
      assert.equal(interaction.inputs.at(-1)?.readBack, 'matched')
    })
  }
}

test('an account fill with no owned window keeps the scope refusal at its budget with no input sent', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'macos', screen: deskSignIn })
  app.windowHidden = true
  const started = performance.now()
  const filled = await interaction.dispatch({ kind: 'fill', locator: field, value: 'ada' }, 120)
  assert.equal(filled.input, 'not_sent')
  assert.equal(filled.result.ok, false)
  assert.match(filled.result.ok ? '' : filled.result.failure.message, /The app has no window in its tree\./)
  assert.ok(performance.now() - started >= 120)
  assert.ok(app.on(sourceRoute).length >= 2)
  assert.equal(app.on(clickRoute).length, 0)
  assert.equal(app.on(keysRoute).length, 0)
})

test('a permanent another-app tree keeps its refusal at the budget and sends no input', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.foreignReads = 1000
  const clock = earlyClock(t)
  const started = performance.now()
  const read = await clock.run(new NativePageAdapter(interaction).execute({ kind: 'observe', locator }, 120))
  assert.equal(read.ok, false)
  assert.match(read.ok ? '' : read.failure.message, /The tree is of another app, not dev\.retest\.fixtures\.taskphone\./)
  assert.ok(performance.now() - started >= 120, 'the refusal must allow the whole read budget')
  const reads = app.on(sourceRoute).length
  assert.ok(reads >= 2)
  assert.equal(app.requests.some(request => request.route.startsWith('POST')), false)
  clock.restore()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(app.on(sourceRoute).length, reads, 'nothing keeps reading after the refusal')
})

test("a source refusal after a rounded command allocation holds the observation's original deadline", async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const clock = earlyClock(t)
  let checks = 0
  t.mock.getter(interaction.session, 'cancelled', () => {
    if (++checks === 2) clock.spend(0.25)
    return false
  })
  const failure = { class: 'not_actionable', message: 'Reading the app tree: The tree is of another app, not dev.retest.fixtures.taskphone.' } as const
  let allocation = 0
  t.mock.method(interaction.session, 'readSource', async (timeoutMs: number, signal?: AbortSignal, deadline?: Deadline) => {
    allocation = timeoutMs
    await waitUntilDeadline(deadline ?? new Deadline(timeoutMs), signal)
    return { ok: false, failure } as const
  })
  const read = await clock.run(new NativePageAdapter(interaction).execute({ kind: 'observe', locator }, 120))
  assert.ok(allocation > 0 && allocation < 120, 'the source command uses only its remaining whole milliseconds')
  assert.deepEqual(read, { ok: false, failure: { ...failure, details: { check: 'tree' } } })
  assert.ok(clock.now() >= 120, `the observation returned at ${clock.now()} ms`)
  assert.ok(clock.now() < 122, 'the source refusal does not reset the original budget')
  assert.equal(app.requests.some(request => request.route.startsWith('POST')), false)
})

test('cancelling a transient scope wait stops observations and preserves not-sent input', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.foreignReads = 1000
  const controller = new AbortController()
  app.once(sourceRoute, () => controller.abort({ class: 'interrupted', message: 'Stopped by the test.' }))
  const read = await interaction.observe(locator, 1000, controller.signal)
  assert.equal(read.ok, false)
  assert.equal(read.ok ? undefined : read.failure.class, 'interrupted')
  assert.equal(app.on(sourceRoute).length, 1)
  assert.equal(app.requests.some(request => request.route.startsWith('POST')), false)
})

test('a malformed tree is refused once, without turning arbitrary read failures into scope retries', async (t) => {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  app.behaviours.set(sourceRoute, { answer: '<XCUIElementTypeWindow/>' })
  const read = await interaction.observe(locator, 1000)
  assert.equal(read.ok, false)
  assert.match(read.ok ? '' : read.failure.message, /The tree has no application element\./)
  assert.equal(app.on(sourceRoute).length, 1)
})
