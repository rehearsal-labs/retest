import type { CapturedFrame, SourceGap } from '../../src/media/capture.ts'
import type { NativeCaptureSession } from '../../src/native/capture.ts'
import assert from 'node:assert/strict'
import { setTimeout as sleep } from 'node:timers/promises'
import { nativeCaptureTimeoutMs, nativeFrameSource, sessionFrameSource, sessionRecordIdentity } from '../../src/native/capture.ts'

/** A queued capture's confirmed not-dispatched timeout remains a dropped observation, without losing the source. */
export async function assertQueuedNativeCaptureDeadline(): Promise<void> {
  let requests = 0
  const identity = {
    sessionId: 'capture-deadline:phone',
    owner: { runId: 'capture-deadline', testId: 'queued capture', attemptId: 'capture-deadline', app: 'phone' },
    runtime: { kind: 'ios-simulator' as const, bundleId: 'dev.retest.capturefixture', appPath: '/fixture/Phone.app', device: 'fixture', runtime: 'fixture', processIds: [] },
  }
  const session: NativeCaptureSession = {
    identity, ended: false, cancelled: false, appStatus: { generation: 1, expectedRunning: true },
    capture: async timeoutMs => {
      requests += 1
      assert.ok(timeoutMs <= nativeCaptureTimeoutMs, 'the capture command stays within the original capture budget')
      if (requests === 2) {
        // Native queue expiry and the caller's response watchdog used the same deadline. Retain the reply-turn delay.
        await sleep(timeoutMs + 25)
        return { ok: false, failure: { class: 'timeout', message: 'The queued capture expired before dispatch; no capture request went.' } }
      }
      return { ok: true, capture: { png: Uint8Array.of(0x89, 0x50), width: 1, height: 1, source: 'executor-screen', capturedAt: new Date(0).toISOString(), reference: { sessionId: identity.sessionId, instance: 'fixture', generation: 1, observationId: `o${requests}` } } }
    },
  }
  const source = sessionFrameSource(session, sessionRecordIdentity(identity), 'executor-screen')
  const frames: CapturedFrame[] = [], ended: string[] = []
  const started = performance.now()
  try {
    assert.deepEqual(await source.start({ fps: 30, clock: () => Math.floor((performance.now() - started) * 1000), deliver: frame => frames.push(frame), ended: reason => ended.push(reason), timeoutMs: 1000 }), { ok: true, mode: 'screenshot-loop' })
    await sleep(nativeCaptureTimeoutMs + 200)
    const stats = await source.stop(1000)
    assert.deepEqual(ended, [], 'a confirmed queued timeout is not an unresponsive target')
    assert.ok(frames.length >= 2, 'capture recovers after the action lane becomes available')
    assert.equal(stats.dropped, 1)
    assert.deepEqual(stats.problems, ['The queued capture expired before dispatch; no capture request went.'])
  } finally {
    await source.stop(1000)
  }
  await assertUnansweredCaptureStops(session)
  await assertCheckedWindowCaptureDeadline()
  await assertWindowCaptureStartup()
}

/** Reconciliation is bounded: an unanswered read still ends once, aborts and issues no further request. */
async function assertUnansweredCaptureStops(template: NativeCaptureSession, makeSource: (session: NativeCaptureSession) => ReturnType<typeof sessionFrameSource> = session => sessionFrameSource(session, sessionRecordIdentity(session.identity), 'executor-screen')): Promise<void> {
  let requests = 0
  let aborted = false
  const pending = Promise.withResolvers<Awaited<ReturnType<NativeCaptureSession['capture']>>>()
  const ended = Promise.withResolvers<string>()
  const frames: CapturedFrame[] = []
  const source = makeSource({ ...template, capture: async (timeoutMs, options) => {
    assert.ok(timeoutMs <= nativeCaptureTimeoutMs)
    requests += 1
    if (requests === 1) return template.capture(timeoutMs, options)
    options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
    return pending.promise
  } })
  const started = performance.now()
  try {
    assert.equal((await source.start({ fps: 30, clock: () => Math.floor((performance.now() - started) * 1000), deliver: frame => frames.push(frame), ended: reason => ended.resolve(reason), timeoutMs: 1000 })).ok, true)
    const guard = new AbortController()
    const exhausted = sleep(nativeCaptureTimeoutMs + 1500, undefined, { signal: guard.signal }).then(() => { throw new Error('An unanswered native capture did not stop within the bounded reconciliation window.') }, error => {
      if (!(error instanceof Error && error.name === 'AbortError')) throw error
      return ''
    })
    let reason: string
    try { reason = await Promise.race([ended.promise, exhausted]) } finally { guard.abort(); await exhausted }
    assert.ok(reason.includes(`did not answer within ${nativeCaptureTimeoutMs} ms; no further capture is requested`), 'the original unanswered-capture bound is unchanged')
    assert.equal(aborted, true)
    assert.equal(requests, 2)
    assert.equal(frames.length, 1)
    pending.resolve({ ok: false, failure: { class: 'timeout', message: 'Late capture settlement remains an unknown read outcome.' } })
    await sleep(50)
    assert.equal(requests, 2, 'no new capture is requested after an unanswered read')
    assert.equal(frames.length, 1, 'late settlement cannot deliver a new frame')
  } finally {
    await source.stop(1000)
  }
}

/** The checked production window route shares the reply margin and preserves the original unanswered bound. */
async function assertCheckedWindowCaptureDeadline(): Promise<void> {
  let requests = 0
  const identity = { sessionId: 'window-deadline:desk', owner: { runId: 'window-deadline', testId: 'window capture deadline', attemptId: 'window-deadline', app: 'desk' }, runtime: { kind: 'macos' as const, bundleId: 'dev.retest.windowfixture', appPath: '/fixture/Desk.app', processIds: [] } }
  const session: NativeCaptureSession = { identity, ended: false, cancelled: false, appStatus: { generation: 1, expectedRunning: true }, capture: async timeoutMs => {
    requests += 1
    assert.ok(timeoutMs <= nativeCaptureTimeoutMs, 'a window request never extends the original capture budget')
    if (requests === 2) {
      await sleep(timeoutMs + 25)
      return { ok: false, failure: { class: 'timeout', message: 'The checked window capture supplied its confirmed timeout reply.' } }
    }
    return { ok: true, capture: { png: Uint8Array.of(0x89, 0x50), width: 1, height: 1, source: 'window-crop', capturedAt: new Date(0).toISOString(), reference: { sessionId: identity.sessionId, instance: 'fixture', generation: 1, observationId: `o${requests}` } } }
  } }
  const source = nativeFrameSource(session, sessionRecordIdentity(identity), async () => { throw new Error('a Mac window never requests the simulator display') }, async () => undefined)
  const frames: CapturedFrame[] = [], ended: string[] = []
  const start = performance.now()
  try {
    assert.equal((await source.start({ fps: 30, clock: () => Math.floor((performance.now() - start) * 1000), deliver: frame => frames.push(frame), ended: reason => ended.push(reason), timeoutMs: 1000 })).ok, true)
    await sleep(nativeCaptureTimeoutMs + 200)
    const stats = await source.stop(1000)
    assert.deepEqual(ended, [], 'a confirmed window read refusal does not prove an unresponsive target')
    assert.ok(frames.length >= 2, 'window capture recovers after its confirmed failed read')
    assert.equal(stats.dropped, 1)
    assert.deepEqual(stats.problems, ['The checked window capture supplied its confirmed timeout reply.'])
  } finally { await source.stop(1000) }
  await assertUnansweredCaptureStops(session, next => nativeFrameSource(next, sessionRecordIdentity(next.identity), async () => { throw new Error('a Mac window never requests the simulator display') }, async () => undefined))
}

/** Startup retains completed read failures and its original budget; it never retries an unknown read or privacy refusal. */
async function assertWindowCaptureStartup(): Promise<void> {
  let requests = 0
  const identity = { sessionId: 'window-startup:desk', owner: { runId: 'window-startup', testId: 'window startup deadline', attemptId: 'window-startup', app: 'desk' }, runtime: { kind: 'macos' as const, bundleId: 'dev.retest.windowfixture', appPath: '/fixture/Desk.app', processIds: [] } }
  const session: NativeCaptureSession = { identity, ended: false, cancelled: false, appStatus: { generation: 1, expectedRunning: true }, capture: async timeoutMs => {
    requests += 1
    assert.ok(timeoutMs <= 1000, 'every startup read stays inside the original start budget')
    if (requests === 1) {
      await sleep(5)
      return { ok: false, failure: { class: 'timeout', message: 'The first window read supplied a completed timeout reply.' } }
    }
    return { ok: true, capture: { png: Uint8Array.of(0x89, 0x50), width: 1, height: 1, source: 'window-crop', capturedAt: new Date(0).toISOString(), reference: { sessionId: identity.sessionId, instance: 'fixture', generation: 1, observationId: `o${requests}` } } }
  } }
  const source = nativeFrameSource(session, sessionRecordIdentity(identity), async () => { throw new Error('a Mac window never requests the simulator display') }, async () => undefined)
  const frames: CapturedFrame[] = [], gaps: SourceGap[] = [], ended: string[] = []
  const started = performance.now()
  try {
    assert.deepEqual(await source.start({ fps: 30, clock: () => Math.floor((performance.now() - started) * 1000), deliver: frame => frames.push(frame), ended: reason => ended.push(reason), gap: gap => gaps.push(gap), timeoutMs: 1000 }), { ok: true, mode: 'screenshot-loop' })
    const stats = await source.stop(1000)
    assert.ok(performance.now() - started < 1000)
    assert.equal(requests, 2)
    assert.equal(frames.length, 1, 'start succeeds only with an actual image')
    assert.deepEqual(ended, [])
    assert.equal(stats.dropped, 1)
    assert.deepEqual(stats.problems, ['The first window read supplied a completed timeout reply.'])
    assert.equal(gaps.length, 1)
    assert.equal(gaps[0]?.reason, 'capture_failed')
    assert.ok(gaps[0] && gaps[0].toUs >= gaps[0].fromUs)
    assert.ok(gaps[0] && frames[0] && gaps[0].toUs <= (frames[0].earliestUs ?? -1))
  } finally { await source.stop(1000) }
  await assertFailedWindowStartup(session)
}

function checkedWindowSource(session: NativeCaptureSession): ReturnType<typeof nativeFrameSource> {
  return nativeFrameSource(session, sessionRecordIdentity(session.identity), async () => { throw new Error('a Mac window never requests the simulator display') }, async () => undefined)
}

async function assertFailedWindowStartup(template: NativeCaptureSession): Promise<void> {
  const refusal = '2 windows of the app are on screen where its tree places it, so Retest cannot tell which one to capture. Retest captured nothing.'
  let refusedReads = 0
  const refused = checkedWindowSource({ ...template, capture: async () => {
    refusedReads += 1
    return { ok: false, failure: { class: 'not_actionable', message: refusal } }
  } })
  const start = (frames: CapturedFrame[], ended: string[], timeoutMs: number, gaps: SourceGap[] = []) => {
    const began = performance.now()
    return { fps: 30, clock: () => Math.floor((performance.now() - began) * 1000), deliver: (frame: CapturedFrame) => frames.push(frame), ended: (reason: string) => ended.push(reason), gap: (gap: SourceGap) => gaps.push(gap), timeoutMs }
  }
  const refusedFrames: CapturedFrame[] = []
  try {
    assert.deepEqual(await refused.start(start(refusedFrames, [], 1000)), { ok: false, reason: `The first window-crop capture failed: ${refusal}` })
    assert.equal(refusedReads, 1, 'a window refusal is preserved without a startup retry')
    assert.deepEqual(refusedFrames, [])
    assert.deepEqual((await refused.stop(100)).problems, [refusal])
  } finally { await refused.stop(100) }

  let expiredReads = 0
  const timeouts: number[] = []
  const noImages = checkedWindowSource({ ...template, capture: async timeoutMs => {
    expiredReads += 1
    timeouts.push(timeoutMs)
    return { ok: false, failure: { class: 'timeout', message: 'The window read completed without an image before the start budget expired.' } }
  } })
  const noFrames: CapturedFrame[] = [], noGaps: SourceGap[] = []
  const began = performance.now()
  try {
    const result = await noImages.start(start(noFrames, [], 120, noGaps))
    assert.equal(result.ok, false, 'a start that receives no image cannot claim capture works')
    assert.ok(performance.now() - began < 240, 'read retries do not extend the original startup budget')
    assert.ok(expiredReads > 1)
    assert.ok(timeouts.every(timeout => timeout <= 120))
    const firstBudget = timeouts[0], lastBudget = timeouts.at(-1)
    assert.ok(firstBudget !== undefined && lastBudget !== undefined && lastBudget < firstBudget, 'each retry spends only the remaining start budget')
    assert.deepEqual(noFrames, [])
    assert.deepEqual(noGaps, [], 'a loop that never started reports the failure as its start result')
    const stats = await noImages.stop(100)
    assert.equal(stats.dropped, expiredReads)
    assert.equal(stats.problems.length, expiredReads)
    assert.ok(stats.problems.every(problem => problem === 'The window read completed without an image before the start budget expired.'))
  } finally { await noImages.stop(100) }

  let unknownReads = 0, aborted = false
  const pending = Promise.withResolvers<Awaited<ReturnType<NativeCaptureSession['capture']>>>()
  const unknown = checkedWindowSource({ ...template, capture: async (_timeoutMs, options) => {
    unknownReads += 1
    options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
    return pending.promise
  } })
  const unknownFrames: CapturedFrame[] = [], unknownEnded: string[] = []
  try {
    const result = await unknown.start(start(unknownFrames, unknownEnded, 80))
    assert.equal(result.ok, false)
    assert.equal(unknownReads, 1, 'startup issues no second capture after an unanswered read')
    assert.equal(aborted, true)
    assert.equal(unknownEnded.length, 1)
    assert.ok(unknownEnded[0]?.includes('did not answer within 80 ms; no further capture is requested'))
    pending.resolve(await template.capture(1000, {}))
    await sleep(50)
    assert.equal(unknownReads, 1)
    assert.deepEqual(unknownFrames, [], 'a late first capture cannot make startup succeed')
  } finally { await unknown.stop(100) }

  let stoppedReads = 0
  const firstReply = Promise.withResolvers<void>()
  const stopped = checkedWindowSource({ ...template, capture: async () => {
    stoppedReads += 1
    firstReply.resolve()
    return { ok: false, failure: { class: 'timeout', message: 'A completed read timeout before startup was stopped.' } }
  } })
  const stoppedFrames: CapturedFrame[] = []
  try {
    const starting = stopped.start(start(stoppedFrames, [], 1000))
    await firstReply.promise
    await sleep(5)
    await stopped.stop(100)
    assert.equal((await starting).ok, false)
    await sleep(50)
    assert.equal(stoppedReads, 1, 'stop cancels startup backoff and prevents another capture request')
    assert.deepEqual(stoppedFrames, [])
  } finally { await stopped.stop(100) }
}
