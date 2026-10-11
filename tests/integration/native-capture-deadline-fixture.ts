import type { TestContext } from 'node:test'
import type { CapturedFrame, SourceGap } from '../../src/media/capture.ts'
import type { NativeCaptureSession } from '../../src/native/capture.ts'
import type { ControlledClock } from '../support/controlled-clock.ts'
import assert from 'node:assert/strict'
import { nativeCaptureTimeoutMs, nativeFrameSource, sessionFrameSource, sessionRecordIdentity } from '../../src/native/capture.ts'
import { controlledClock } from '../support/controlled-clock.ts'

// The source samples at 30 fps, rounded up to the next whole timer millisecond.
const frameIntervalMs = Math.ceil(1000 / 30)
type CaptureAnswer = Awaited<ReturnType<NativeCaptureSession['capture']>>

/** A queued capture's confirmed not-dispatched timeout remains a dropped observation, without losing the source. */
export async function assertQueuedNativeCaptureDeadline(t: TestContext): Promise<void> {
  const clock = controlledClock(t)
  let requests = 0
  const queued = Promise.withResolvers<number>()
  const reply = Promise.withResolvers<CaptureAnswer>()
  const recovered = Promise.withResolvers<void>()
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
        queued.resolve(timeoutMs)
        return reply.promise
      }
      return { ok: true, capture: { png: Uint8Array.of(0x89, 0x50), width: 1, height: 1, source: 'executor-screen', capturedAt: new Date(0).toISOString(), reference: { sessionId: identity.sessionId, instance: 'fixture', generation: 1, observationId: `o${requests}` } } }
    },
  }
  const source = sessionFrameSource(session, sessionRecordIdentity(identity), 'executor-screen')
  const frames: CapturedFrame[] = [], ended: string[] = []
  const started = clock.now()
  try {
    assert.deepEqual(await source.start({ fps: 30, clock: () => Math.floor((clock.now() - started) * 1000), deliver: frame => { frames.push(frame); if (frames.length === 2) recovered.resolve() }, ended: reason => ended.push(reason), timeoutMs: 1000 }), { ok: true, mode: 'screenshot-loop' })
    await clock.advance(frameIntervalMs)
    assert.equal(requests, 2, 'the queued capture was dispatched')
    const commandMs = await queued.promise
    // A completed reply arrives after the command deadline but before the caller's response deadline.
    await clock.advance(commandMs + 1)
    reply.resolve({ ok: false, failure: { class: 'timeout', message: 'The queued capture expired before dispatch; no capture request went.' } })
    await clock.flush()
    await clock.advance(frameIntervalMs)
    assert.equal(frames.length, 2, 'capture recovers after the action lane becomes available')
    await recovered.promise
    const stats = await source.stop(1000)
    assert.deepEqual(ended, [], 'a confirmed queued timeout is not an unresponsive target')
    assert.equal(stats.dropped, 1)
    assert.deepEqual(stats.problems, ['The queued capture expired before dispatch; no capture request went.'])
  } finally {
    await source.stop(1000)
  }
  await assertUnansweredCaptureStops(session, clock)
  await assertCheckedWindowCaptureDeadline(clock)
  await assertWindowCaptureStartup(clock)
}

/** Reconciliation is bounded: an unanswered read still ends once, aborts and issues no further request. */
async function assertUnansweredCaptureStops(template: NativeCaptureSession, clock: ControlledClock, makeSource: (session: NativeCaptureSession) => ReturnType<typeof sessionFrameSource> = session => sessionFrameSource(session, sessionRecordIdentity(session.identity), 'executor-screen')): Promise<void> {
  let requests = 0
  let aborted = false
  const pending = Promise.withResolvers<CaptureAnswer>()
  const ended = Promise.withResolvers<string>()
  const frames: CapturedFrame[] = []
  const endings: string[] = []
  const source = makeSource({ ...template, capture: async (timeoutMs, options) => {
    assert.ok(timeoutMs <= nativeCaptureTimeoutMs)
    requests += 1
    if (requests === 1) return template.capture(timeoutMs, options)
    options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
    return pending.promise
  } })
  const started = clock.now()
  try {
    assert.equal((await source.start({ fps: 30, clock: () => Math.floor((clock.now() - started) * 1000), deliver: frame => frames.push(frame), ended: reason => { endings.push(reason); ended.resolve(reason) }, timeoutMs: 1000 })).ok, true)
    await clock.advance(frameIntervalMs)
    assert.equal(requests, 2)
    await clock.advance(nativeCaptureTimeoutMs - 1)
    assert.deepEqual(endings, [], 'an unanswered capture keeps its original response deadline')
    await clock.advance(1)
    const reason = await ended.promise
    assert.ok(reason.includes(`did not answer within ${nativeCaptureTimeoutMs} ms; no further capture is requested`), 'the original unanswered-capture bound is unchanged')
    assert.equal(aborted, true)
    assert.equal(requests, 2)
    assert.equal(frames.length, 1)
    assert.equal(endings.length, 1)
    pending.resolve({ ok: false, failure: { class: 'timeout', message: 'Late capture settlement remains an unknown read outcome.' } })
    await pending.promise
    await clock.flush()
    await clock.advance(nativeCaptureTimeoutMs)
    assert.equal(requests, 2, 'no new capture is requested after an unanswered read')
    assert.equal(frames.length, 1, 'late settlement cannot deliver a new frame')
    assert.equal(endings.length, 1, 'the source ends once')
  } finally {
    await source.stop(1000)
  }
}

/** The checked production window route shares the reply margin and preserves the original unanswered bound. */
async function assertCheckedWindowCaptureDeadline(clock: ControlledClock): Promise<void> {
  let requests = 0
  const queued = Promise.withResolvers<number>()
  const reply = Promise.withResolvers<CaptureAnswer>()
  const recovered = Promise.withResolvers<void>()
  const identity = { sessionId: 'window-deadline:desk', owner: { runId: 'window-deadline', testId: 'window capture deadline', attemptId: 'window-deadline', app: 'desk' }, runtime: { kind: 'macos' as const, bundleId: 'dev.retest.windowfixture', appPath: '/fixture/Desk.app', processIds: [] } }
  const session: NativeCaptureSession = { identity, ended: false, cancelled: false, appStatus: { generation: 1, expectedRunning: true }, capture: async timeoutMs => {
    requests += 1
    assert.ok(timeoutMs <= nativeCaptureTimeoutMs, 'a window request never extends the original capture budget')
    if (requests === 2) { queued.resolve(timeoutMs); return reply.promise }
    return { ok: true, capture: { png: Uint8Array.of(0x89, 0x50), width: 1, height: 1, source: 'window-crop', capturedAt: new Date(0).toISOString(), reference: { sessionId: identity.sessionId, instance: 'fixture', generation: 1, observationId: `o${requests}` } } }
  } }
  const source = checkedWindowSource(session)
  const frames: CapturedFrame[] = [], ended: string[] = []
  const start = clock.now()
  try {
    assert.equal((await source.start({ fps: 30, clock: () => Math.floor((clock.now() - start) * 1000), deliver: frame => { frames.push(frame); if (frames.length === 2) recovered.resolve() }, ended: reason => ended.push(reason), timeoutMs: 1000 })).ok, true)
    await clock.advance(frameIntervalMs)
    assert.equal(requests, 2)
    await clock.advance((await queued.promise) + 1)
    reply.resolve({ ok: false, failure: { class: 'timeout', message: 'The checked window capture supplied its confirmed timeout reply.' } })
    await clock.flush()
    await clock.advance(frameIntervalMs)
    assert.equal(frames.length, 2, 'window capture recovers after its confirmed failed read')
    await recovered.promise
    const stats = await source.stop(1000)
    assert.deepEqual(ended, [], 'a confirmed window read refusal does not prove an unresponsive target')
    assert.equal(stats.dropped, 1)
    assert.deepEqual(stats.problems, ['The checked window capture supplied its confirmed timeout reply.'])
  } finally { await source.stop(1000) }
  await assertUnansweredCaptureStops(session, clock, checkedWindowSource)
}

/** Startup retains completed read failures and its original budget; it never retries an unknown read or privacy refusal. */
async function assertWindowCaptureStartup(clock: ControlledClock): Promise<void> {
  let requests = 0
  const first = Promise.withResolvers<CaptureAnswer>()
  const identity = { sessionId: 'window-startup:desk', owner: { runId: 'window-startup', testId: 'window startup deadline', attemptId: 'window-startup', app: 'desk' }, runtime: { kind: 'macos' as const, bundleId: 'dev.retest.windowfixture', appPath: '/fixture/Desk.app', processIds: [] } }
  const session: NativeCaptureSession = { identity, ended: false, cancelled: false, appStatus: { generation: 1, expectedRunning: true }, capture: async timeoutMs => {
    requests += 1
    assert.ok(timeoutMs <= 1000, 'every startup read stays inside the original start budget')
    if (requests === 1) return first.promise
    return { ok: true, capture: { png: Uint8Array.of(0x89, 0x50), width: 1, height: 1, source: 'window-crop', capturedAt: new Date(0).toISOString(), reference: { sessionId: identity.sessionId, instance: 'fixture', generation: 1, observationId: `o${requests}` } } }
  } }
  const source = checkedWindowSource(session)
  const frames: CapturedFrame[] = [], gaps: SourceGap[] = [], ended: string[] = []
  const started = clock.now()
  try {
    const starting = source.start({ fps: 30, clock: () => Math.floor((clock.now() - started) * 1000), deliver: frame => frames.push(frame), ended: reason => ended.push(reason), gap: gap => gaps.push(gap), timeoutMs: 1000 })
    await clock.flush()
    assert.equal(requests, 1)
    first.resolve({ ok: false, failure: { class: 'timeout', message: 'The first window read supplied a completed timeout reply.' } })
    await clock.flush()
    await clock.advance(frameIntervalMs)
    assert.equal(requests, 2, 'a completed read refusal leaves time to request the first valid frame')
    assert.deepEqual(await starting, { ok: true, mode: 'screenshot-loop' })
    const stats = await source.stop(1000)
    assert.ok(clock.now() - started < 1000)
    assert.equal(frames.length, 1, 'start succeeds only with an actual image')
    assert.deepEqual(ended, [])
    assert.equal(stats.dropped, 1)
    assert.deepEqual(stats.problems, ['The first window read supplied a completed timeout reply.'])
    assert.equal(gaps.length, 1)
    assert.equal(gaps[0]?.reason, 'capture_failed')
    assert.ok(gaps[0] && gaps[0].toUs >= gaps[0].fromUs)
    assert.ok(gaps[0] && frames[0] && gaps[0].toUs <= (frames[0].earliestUs ?? -1))
  } finally { await source.stop(1000) }
  await assertFailedWindowStartup(session, clock)
}

function checkedWindowSource(session: NativeCaptureSession): ReturnType<typeof nativeFrameSource> {
  return nativeFrameSource(session, sessionRecordIdentity(session.identity), async () => { throw new Error('a Mac window never requests the simulator display') }, async () => undefined)
}

async function assertFailedWindowStartup(template: NativeCaptureSession, clock: ControlledClock): Promise<void> {
  const refusal = '2 windows of the app are on screen where its tree places it, so Retest cannot tell which one to capture. Retest captured nothing.'
  let refusedReads = 0
  const refused = checkedWindowSource({ ...template, capture: async () => {
    refusedReads += 1
    return { ok: false, failure: { class: 'not_actionable', message: refusal } }
  } })
  const start = (frames: CapturedFrame[], ended: string[], timeoutMs: number, gaps: SourceGap[] = []) => {
    const began = clock.now()
    return { fps: 30, clock: () => Math.floor((clock.now() - began) * 1000), deliver: (frame: CapturedFrame) => frames.push(frame), ended: (reason: string) => ended.push(reason), gap: (gap: SourceGap) => gaps.push(gap), timeoutMs }
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
  const began = clock.now()
  try {
    let answered = false
    const starting = noImages.start(start(noFrames, [], 120, noGaps)).then(result => { answered = true; return result })
    await clock.flush()
    for (let tick = 0; tick < 3; tick += 1) await clock.advance(frameIntervalMs)
    assert.ok(expiredReads > 1)
    await clock.advance(119 - (clock.now() - began))
    assert.equal(answered, false, 'read failures do not shorten the original startup deadline')
    await clock.advance(1)
    const result = await starting
    assert.equal(result.ok, false, 'a start that receives no image cannot claim capture works')
    assert.equal(clock.now() - began, 120, 'read retries do not extend the original startup budget')
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

  let imageReads = 0
  const imageProblem = 'The image process timed out and its owned process was ended.'
  const imageTimeout = checkedWindowSource({ ...template, capture: async () => {
    imageReads += 1
    return { ok: false, failure: { class: 'timeout', message: imageProblem, details: { imageCommandTimedOut: true } } }
  } })
  const imageFrames: CapturedFrame[] = []
  try {
    let answered = false
    const starting = imageTimeout.start(start(imageFrames, [], 1000)).then(result => { answered = true; return result })
    await clock.flush()
    await clock.advance(frameIntervalMs)
    assert.equal(imageReads, 1, 'a timed-out image process needs the configured cleanup allocation before another request')
    await clock.advance(999 - frameIntervalMs)
    assert.equal(answered, false, 'cleanup allocation does not shorten the original startup deadline')
    await clock.advance(1)
    assert.deepEqual(await starting, { ok: false, reason: `The first window-crop capture failed: ${imageProblem}` })
    assert.deepEqual(imageFrames, [])
    assert.deepEqual((await imageTimeout.stop(100)).problems, [imageProblem])
  } finally { await imageTimeout.stop(100) }

  let unknownReads = 0, aborted = false
  const pending = Promise.withResolvers<CaptureAnswer>()
  const unknown = checkedWindowSource({ ...template, capture: async (_timeoutMs, options) => {
    unknownReads += 1
    options.signal?.addEventListener('abort', () => { aborted = true }, { once: true })
    return pending.promise
  } })
  const unknownFrames: CapturedFrame[] = [], unknownEnded: string[] = []
  try {
    const starting = unknown.start(start(unknownFrames, unknownEnded, 80))
    await clock.flush()
    await clock.advance(79)
    assert.equal(unknownEnded.length, 0)
    await clock.advance(1)
    assert.equal((await starting).ok, false)
    assert.equal(unknownReads, 1, 'startup issues no second capture after an unanswered read')
    assert.equal(aborted, true)
    assert.equal(unknownEnded.length, 1)
    assert.ok(unknownEnded[0]?.includes('did not answer within 80 ms; no further capture is requested'))
    pending.resolve(await template.capture(1000, {}))
    await pending.promise
    await clock.flush()
    await clock.advance(frameIntervalMs)
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
    await clock.flush()
    await stopped.stop(100)
    assert.equal((await starting).ok, false)
    await clock.advance(frameIntervalMs)
    assert.equal(stoppedReads, 1, 'stop cancels startup backoff and prevents another capture request')
    assert.deepEqual(stoppedFrames, [])
  } finally { await stopped.stop(100) }
}
