import type { CapturedPage } from '../../src/browser/webkit/capture.ts'
import type { CapturedFrame, StartCapture } from '../../src/media/capture.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebKitFrameSource } from '../../src/browser/webkit/capture.ts'
import { microsecondsSince } from '../../src/media/capture.ts'

const identity = { testId: 'capture', attemptId: 'a1', app: 'web', sessionId: 'a1:web' }
const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

// A WebKit page as its capture sees it: snapshots the test answers, and a loss it can announce.
class Page implements CapturedPage {
  lostReason: string | undefined
  readonly asked: number[] = []
  readonly losses = new Set<(loss: { reason: string }) => void>()
  answer: () => Promise<Uint8Array> = () => Promise.resolve(png)
  screenshot(timeoutMs: number): Promise<Uint8Array> { this.asked.push(timeoutMs); return this.answer() }
  onLost(listener: (loss: { reason: string }) => void): () => void { this.losses.add(listener); return () => { this.losses.delete(listener) } }
  lose(reason: string): void { this.lostReason = reason; for (const listener of [...this.losses]) listener({ reason }) }
}
function capture(frames: CapturedFrame[], reasons: string[] = []): StartCapture {
  return { fps: 30, clock: microsecondsSince(performance.now()), deliver: (frame) => frames.push(frame), ended: (reason) => reasons.push(reason), timeoutMs: 100 }
}

test("WebKit captures with the page's own snapshots, each the PNG the build encoded, stamped as it came back and bounded by its request", async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity)
  const frames: CapturedFrame[] = []
  let now = 0
  // The snapshot takes 5 ms of the run's clock.
  page.answer = () => { now += 5000; return Promise.resolve(png) }
  assert.deepEqual(source.availability(), { available: true, mode: 'screenshot-loop' })
  assert.deepEqual(await source.start({ ...capture(frames), clock: () => now }), { ok: true, mode: 'screenshot-loop' })
  const stats = await source.stop(100)
  assert.deepEqual(frames.map((frame) => [frame.format, [...frame.bytes], frame.earliestUs, frame.timestampUs, frame.identity]), [['png', [...png], 0, 5000, identity]])
  assert.equal(source.name, 'webkit')
  assert.deepEqual([stats.mode, stats.delivered, stats.dropped], ['screenshot-loop', 1, 0])
  assert.deepEqual(stats.clockMapping, { timestamp: 'run-arrival', targetClock: 'not-used', imageRead: 'request-to-arrival' })
  assert.deepEqual(page.asked, [100], "the start's own time bounds the first snapshot")
  assert.equal(page.losses.size, 0, 'the source stopped listening for the loss')
})

test('an unanswered WebKit snapshot bounds the start, and the stop of a source still waiting for one', async () => {
  const page = new Page()
  page.answer = () => new Promise(() => undefined)
  const source = new WebKitFrameSource(page, identity)
  const started = performance.now()
  const result = await source.start({ ...capture([]), timeoutMs: 20 })
  assert.equal(result.ok, false)
  assert.ok(performance.now() - started < 500)
  assert.equal(page.losses.size, 0)
  const next = new Page()
  const running = new WebKitFrameSource(next, identity)
  assert.equal((await running.start(capture([]))).ok, true)
  next.answer = () => new Promise(() => undefined)
  await sleep(60)
  const stopping = performance.now()
  const stopped = await running.stop(20)
  assert.ok(performance.now() - stopping < 500)
  assert.match(stopped.problems.join(' '), /A webkit capture was still out when the stop's 20 ms were up/)
  assert.equal(next.losses.size, 0)
})

test('a lost WebKit page ends its source once, with the reason, and nothing is handed over after', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity)
  const frames: CapturedFrame[] = []
  const reasons: string[] = []
  assert.equal((await source.start(capture(frames, reasons))).ok, true)
  page.lose('the page was closed')
  await sleep(80)
  const stats = await source.stop(100)
  assert.equal(reasons.length, 1)
  assert.match(reasons[0] ?? '', /the page was closed/)
  assert.match(stats.endedEarly ?? '', /the page was closed/)
  const before = frames.length
  await sleep(80)
  assert.equal(frames.length, before)
  assert.equal(page.losses.size, 0)
})

test('a snapshot that fails because the page went ends the capture with the loss', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity)
  const reasons: string[] = []
  assert.equal((await source.start(capture([], reasons))).ok, true)
  page.answer = () => {
    page.lostReason = 'the browser was lost'
    return Promise.reject(new Error('The connection to WebKit closed.'))
  }
  await sleep(80)
  const stats = await source.stop(100)
  assert.deepEqual(reasons.map((reason) => /the browser was lost/.test(reason)), [true])
  assert.equal(stats.dropped, 0, 'a loss is the capture ending, not a dropped frame')
})

test('a snapshot that fails while the page stays is one dropped frame, and capture goes on', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity)
  const frames: CapturedFrame[] = []
  const reasons: string[] = []
  assert.equal((await source.start(capture(frames, reasons))).ok, true)
  let failed = false
  page.answer = () => {
    if (failed) return Promise.resolve(png)
    failed = true
    return Promise.reject(new Error('Could not take a screenshot within 5000 ms.'))
  }
  await sleep(150)
  const stats = await source.stop(100)
  assert.equal(stats.dropped, 1)
  assert.deepEqual(stats.problems, ['Could not take a screenshot within 5000 ms.'])
  assert.ok(frames.length >= 2, `capture went on after the failed snapshot: ${frames.length} frames`)
  assert.deepEqual(reasons, [])
})

test('an identity refusal asks WebKit for no snapshot', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity, 'a different session')
  assert.deepEqual(source.availability(), { available: false, reason: 'a different session' })
  assert.deepEqual(await source.start(capture([])), { ok: false, reason: 'a different session' })
  assert.deepEqual(page.asked, [])
})

test('a page that is gone is not captured, and says why', async () => {
  const page = new Page()
  page.lostReason = 'the page crashed'
  const source = new WebKitFrameSource(page, identity)
  const reason = 'The page is gone, so WebKit cannot capture it: the page crashed.'
  assert.deepEqual(source.availability(), { available: false, reason })
  assert.deepEqual(await source.start(capture([])), { ok: false, reason })
  assert.deepEqual(page.asked, [])
})
