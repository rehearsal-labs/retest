import type { TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { NativePageAdapter } from '../../src/runner/native-pool.ts'
import { earlyClock } from '../unit/early-waits-clock.ts'
import { openFake, phoneSignIn } from '../unit/native-interaction-fake.ts'

/** A rounded read timeout retains its failure and the observation's exact deadline, without sending another read. */
export async function assertNativeObservationTimeoutDeadline(t: TestContext): Promise<void> {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const clock = earlyClock(t)
  const failure = { class: 'timeout', message: 'Reading the app tree: the allocated source request expired.', details: { original: true } } as const
  let reads = 0
  t.mock.method(interaction.session, 'readSource', async () => {
    reads += 1
    clock.spend(119.35)
    return { ok: false, failure } as const
  })
  try {
    const result = await clock.run(new NativePageAdapter(interaction).execute({ kind: 'observe', locator: { by: 'testId', value: 'service-status' } }, 120))
    assert.deepEqual(result, { ok: false, failure }, 'the timed-out read stays a failure with its original details')
    assert.ok(clock.now() >= 120, `the observation returned at ${clock.now()} ms before its original deadline`)
    assert.ok(clock.now() < 122, 'holding the failure does not reset the observation budget')
    assert.equal(reads, 1, 'a timed-out read is held to its deadline without issuing another command')
    assert.equal(app.requests.some(request => request.route.startsWith('POST')), false)
  } finally {
    clock.restore()
  }
  await assertTimeoutWaitCancellation(t)
}

async function assertTimeoutWaitCancellation(t: TestContext): Promise<void> {
  const { app, interaction } = await openFake(t, { platform: 'ios-simulator', screen: phoneSignIn })
  const clock = earlyClock(t)
  const controller = new AbortController()
  const failure = { class: 'timeout', message: 'The source request expired before cancellation.', details: { original: true } } as const
  let reads = 0
  t.mock.method(interaction.session, 'readSource', async () => {
    reads += 1
    clock.spend(20)
    setTimeout(() => controller.abort({ class: 'interrupted', message: 'Stopped while holding the read failure.' }), 10)
    return { ok: false, failure } as const
  })
  try {
    const result = await clock.run(interaction.observe({ by: 'testId', value: 'service-status' }, 120, controller.signal))
    assert.equal(result.ok, false)
    if (result.ok) assert.fail('cancelled observations cannot succeed')
    assert.equal(result.failure.class, 'interrupted')
    assert.equal(result.failure.details?.['earlierReadFailure'], JSON.stringify(failure))
    assert.equal(result.failure.details?.['inputSent'], 'not_sent')
    assert.ok(clock.now() < 120, 'cancellation stops the wait before its deadline')
    assert.equal(reads, 1, 'cancellation sends no further source request')
    assert.equal(app.requests.some(request => request.route.startsWith('POST')), false)
  } finally {
    clock.restore()
  }
}
