import type { FrameSource, CaptureStart, CaptureStats, StartCapture } from '../../src/media/capture.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CaptureSuspension, ScreenshotLoopSource } from '../../src/media/capture.ts'
import { PolicedSource } from '../../src/runner/policed-source.ts'

const identity = { testId: 't', attemptId: 'a', app: 'web', sessionId: 'a:web' }
const stats: CaptureStats = { mode: 'screencast', requestedFps: 10, delivered: 0, superseded: 0, dropped: 0, problems: [] }
const never = <T>(): Promise<T> => new Promise(() => undefined)
function source(start: (capture: StartCapture) => Promise<CaptureStart>, stop: () => Promise<CaptureStats>): FrameSource {
  return { name: 'chromium', identity, availability: () => ({ available: true, mode: 'screencast' }), start, stop }
}
async function within<T>(work: Promise<T>): Promise<T | 'hung'> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([work, new Promise<'hung'>(resolve => { timer = setTimeout(() => resolve('hung'), 250) })]) }
  finally { clearTimeout(timer) }
}
const capture: StartCapture = { fps: 10, clock: () => 1000, deliver: () => undefined, ended: () => undefined, timeoutMs: 20 }

test('a restart whose old capture never stops is bounded and remains withheld', async () => {
  const suspension = new CaptureSuspension()
  const policed = new PolicedSource({ open: () => source(async () => ({ ok: true, mode: 'screencast' }), never), suspension, clock: capture.clock, stopTimeoutMs: 20 })
  await policed.start(capture)
  policed.withhold()
  assert.equal(await within(policed.resume()), false)
  assert.equal(suspension.suspended, true)
  const stopped = await within(policed.stop(20))
  assert.notEqual(stopped, 'hung')
  assert.ok(stopped !== 'hung' && stopped.problems.length > 0)
})

test('stop does not wait forever for a restart whose new capture never answers', async () => {
  let opens = 0
  const policed = new PolicedSource({ open: () => source(() => ++opens === 1 ? Promise.resolve({ ok: true, mode: 'screencast' }) : never(), async () => stats), suspension: new CaptureSuspension(), clock: capture.clock, stopTimeoutMs: 20 })
  await policed.start(capture)
  policed.withhold()
  const resumed = policed.resume()
  await new Promise(resolve => setImmediate(resolve))
  assert.notEqual(await within(policed.stop(20)), 'hung')
  assert.equal(await within(resumed), false)
})

test('a run cancelled while the encoder starts issues no later UI capture command', async () => {
  let starts = 0
  const controller = new AbortController()
  const policed = new PolicedSource({ open: () => source(async () => { starts += 1; return { ok: true, mode: 'screencast' } }, async () => stats), suspension: new CaptureSuspension(), clock: capture.clock, stopTimeoutMs: 20, runSignal: controller.signal })
  controller.abort('SIGINT')
  const started = await policed.start(capture)
  assert.equal(started.ok, false)
  assert.equal(starts, 0)
})

test('a stopped screenshot loop that returns no stats retains its actual mode and rate', async () => {
  const policed = new PolicedSource({ open: () => source(async () => ({ ok: true, mode: 'screenshot-loop' }), never), suspension: new CaptureSuspension(), clock: capture.clock, stopTimeoutMs: 20 })
  assert.equal((await policed.start(capture)).ok, true)
  const stopped = await policed.stop(20)
  assert.equal(stopped.mode, 'screenshot-loop')
  assert.equal(stopped.requestedFps, capture.fps)
  assert.ok(stopped.problems.length > 0)
})

test('a stop report with problems cannot authorize new capture after a secret stretch', async () => {
  let opens = 0
  const suspension = new CaptureSuspension()
  const policed = new PolicedSource({ open: () => { opens += 1; return source(async () => ({ ok: true, mode: 'screencast' }), async () => ({ ...stats, problems: ['The stop command failed; remote capture is unknown.'] })) }, suspension, clock: capture.clock, stopTimeoutMs: 20 })
  await policed.start(capture)
  policed.withhold()
  assert.equal(await policed.resume(), false)
  assert.equal(suspension.suspended, true)
  assert.equal(opens, 1)
  assert.ok((await policed.stop(20)).problems.length > 0)
})


test('run abort stops every already-running screenshot loop before any new grab', async () => {
  const controller = new AbortController()
  const grabs = [0, 0]
  const sources = grabs.map((_, index) => new PolicedSource({
    open: () => new ScreenshotLoopSource({ name: 'firefox', identity: { ...identity, sessionId: `session-${index}` }, unavailable: () => undefined, grabTimeoutMs: 100,
      grab: async () => { grabs[index] = (grabs[index] ?? 0) + 1; return { ok: true, format: 'png', bytes: Uint8Array.of(1) } },
    }), suspension: new CaptureSuspension(), clock: () => Math.floor(performance.now() * 1000), stopTimeoutMs: 20, runSignal: controller.signal,
  }))
  try {
    for (const policed of sources) assert.equal((await policed.start({ ...capture, clock: () => Math.floor(performance.now() * 1000), fps: 50 })).ok, true)
    const atAbort = [...grabs]
    controller.abort()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(grabs, atAbort, 'new captures were dispatched after cancellation')
  } finally { await Promise.all(sources.map(policed => policed.stop(20))) }
})

test('a screenshot grab already out at run abort is discarded when it arrives', async () => {
  const controller = new AbortController()
  const arrived = Promise.withResolvers<{ ok: true; format: 'png'; bytes: Uint8Array }>()
  const second = Promise.withResolvers<void>()
  let grabs = 0
  let delivered = 0
  const policed = new PolicedSource({ open: () => new ScreenshotLoopSource({ name: 'firefox', identity, unavailable: () => undefined, grabTimeoutMs: 100,
    grab: async () => { if (++grabs === 1) return { ok: true, format: 'png', bytes: Uint8Array.of(1) }; second.resolve(); return arrived.promise },
  }), suspension: new CaptureSuspension(), clock: () => Math.floor(performance.now() * 1000), stopTimeoutMs: 20, runSignal: controller.signal })
  try {
    assert.equal((await policed.start({ ...capture, clock: () => Math.floor(performance.now() * 1000), fps: 50, deliver: () => { delivered++ } })).ok, true)
    assert.notEqual(await within(second.promise), 'hung')
    controller.abort()
    arrived.resolve({ ok: true, format: 'png', bytes: Uint8Array.of(2) })
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(delivered, 1, 'the dispatched grab was delivered after cancellation')
    assert.equal(grabs, 2, 'another grab followed cancellation')
  } finally { arrived.resolve({ ok: true, format: 'png', bytes: Uint8Array.of(2) }); await policed.stop(20) }
})

test('capture clock mapping, achieved cadence and latency survive a restarted source', async () => {
  let stopped = 0
  const policed = new PolicedSource({ open: () => source(async () => ({ ok: true, mode: 'screenshot-loop' }), async () => {
    stopped++
    return { mode: 'screenshot-loop', requestedFps: 10, delivered: 2, superseded: 0, dropped: 0, problems: [], startedAtUs: stopped === 1 ? 0 : 500000, stoppedAtUs: stopped === 1 ? 400000 : 1000000, clockMapping: { timestamp: 'run-arrival', targetClock: 'not-used', imageRead: 'request-to-arrival' }, achievedFps: 5, captureMs: stopped === 1 ? { count: 2, minMs: 2, meanMs: 4, maxMs: 6 } : { count: 1, minMs: 8, meanMs: 8, maxMs: 8 } }
  }), suspension: new CaptureSuspension(), clock: capture.clock, stopTimeoutMs: 20 })
  await policed.start(capture)
  policed.withhold()
  assert.equal(await policed.resume(), true)
  const combined = await policed.stop(20)
  assert.deepEqual(combined.clockMapping, { timestamp: 'run-arrival', targetClock: 'not-used', imageRead: 'request-to-arrival' })
  assert.equal(combined.achievedFps, 4, 'cadence includes the withheld interval on the run clock')
  assert.deepEqual(combined.captureMs, { count: 3, minMs: 2, meanMs: 5.3, maxMs: 8 })
})
