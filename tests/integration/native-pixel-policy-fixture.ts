import type { CapturedFrame, StartCapture } from '../../src/media/capture.ts'
import assert from 'node:assert/strict'
import { CaptureSuspension } from '../../src/media/capture.ts'
import { defaultAppPixelRules, PixelCapturePolicy } from '../../src/media/policy.ts'
import { PolicedSource } from '../../src/runner/policed-source.ts'

/** A completed foreign privacy stretch must not suppress a fresh screenshot indefinitely. */
export async function assertFreshNativeScreenshotPolicy(): Promise<void> {
  let now = 2000
  const identity = { testId: 'pixel-policy', attemptId: 'policy-attempt', app: 'desk', sessionId: 'policy-attempt:desk' }
  const web = { ...identity, app: 'web', sessionId: 'policy-attempt:web' }
  const policy = new PixelCapturePolicy({ rules: () => defaultAppPixelRules, clock: () => now })
  let captured: StartCapture | undefined
  const delivered: CapturedFrame[] = []
  const gaps: { fromUs: number; toUs: number; reason: string }[] = []
  const source = new PolicedSource({
    open: () => ({
      name: 'window-crop', identity,
      availability: () => ({ available: true, mode: 'screenshot-loop' }),
      start: async (capture) => { captured = capture; return { ok: true, mode: 'screenshot-loop' } },
      stop: async () => ({ mode: 'screenshot-loop', requestedFps: 10, delivered: 0, superseded: 0, dropped: 0, problems: [] }),
    }),
    judge: policy, suspension: new CaptureSuspension(), clock: () => now, stopTimeoutMs: 1000,
  })
  assert.deepEqual(await source.start({ fps: 10, clock: () => now, deliver: frame => delivered.push(frame), gap: gap => gaps.push(gap), ended: reason => assert.fail(reason), timeoutMs: 1000 }), { ok: true, mode: 'screenshot-loop' })
  assert.ok(captured)
  const frame = (earliestUs?: number): CapturedFrame => ({ identity, timestampUs: now, ...(earliestUs === undefined ? {} : { earliestUs }), format: 'png', bytes: new Uint8Array([1]) })
  try {
    now = 3000
    policy.beginSecretEntry({ identity: web, secret: 'fixture', field: 'field', fact: { kind: 'unread', reason: 'fixture observation' } })
    now = 4000
    captured.deliver(frame(2500))
    assert.deepEqual(delivered, [], 'a crop overlapping another app\'s open secret stretch is withheld')
    now = 5000
    policy.fieldChanged(web, 'field', 'gone')
    now = 6000
    captured.deliver(frame(4500))
    assert.deepEqual(delivered, [], 'a late crop that began during the ended stretch stays withheld')
    now = 7000
    captured.deliver(frame())
    assert.deepEqual(delivered, [], 'an unstamped source remains conservative from its original start')
    now = 8000
    const fresh = frame(6000)
    captured.deliver(fresh)
    assert.deepEqual(delivered, [fresh], 'a screenshot requested wholly after the stretch ends is retained')
    assert.equal(source.withheld, 3)
    assert.equal(gaps.length, 3)
    assert.ok(gaps.every(gap => gap.reason === 'pixels_withheld'))
  } finally {
    assert.deepEqual((await source.stop(1000)).problems, [])
  }
}
