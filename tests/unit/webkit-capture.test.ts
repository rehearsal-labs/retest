import type { CapturedPage } from '../../src/browser/webkit/capture.ts'
import type { PageProxyEvent } from '../../src/browser/webkit/connection.ts'
import type { CapturedFrame, StartCapture } from '../../src/media/capture.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { WebKitFrameSource } from '../../src/browser/webkit/capture.ts'
import { microsecondsSince } from '../../src/media/capture.ts'

const identity = { testId: 'capture', attemptId: 'a1', app: 'web', sessionId: 'a1:web' }
class Page implements CapturedPage {
  readonly screen = { viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 }
  lostReason: string | undefined
  readonly calls: { method: string; params: object | undefined }[] = []
  readonly listeners = new Set<(event: PageProxyEvent) => void>()
  answer: (method: string) => Promise<unknown> = (method) => Promise.resolve(method === 'Screencast.startScreencast' ? { generation: 7 } : {})
  proxy(method: string, params: object | undefined): Promise<unknown> { this.calls.push({ method, params }); return this.answer(method) }
  onPageProxyEvent(listener: (event: PageProxyEvent) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  onLost(): () => void { return () => undefined }
  paint(): void { for (const listener of this.listeners) listener({ method: 'Screencast.screencastFrame', params: { data: Buffer.from([255, 216, 255, 217]).toString('base64') } }) }
}
function capture(frames: CapturedFrame[], reasons: string[] = []): StartCapture {
  return { fps: 30, clock: microsecondsSince(performance.now()), deliver: (frame) => frames.push(frame), ended: (reason) => reasons.push(reason), timeoutMs: 100 }
}

test('WebKit acknowledges frames that arrived before its start reply gave the generation', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity)
  const frames: CapturedFrame[] = []
  page.answer = (method) => { if (method === 'Screencast.startScreencast') page.paint(); return Promise.resolve(method === 'Screencast.startScreencast' ? { generation: 7 } : {}) }
  assert.deepEqual(await source.start(capture(frames)), { ok: true, mode: 'screencast' })
  assert.deepEqual(page.calls.find((call) => call.method.endsWith('FrameAck'))?.params, { generation: 7 })
  const stats = await source.stop(100)
  assert.deepEqual([...frames[0]?.bytes ?? []], [255, 216, 255, 217])
  assert.equal(stats.delivered, 1)
  assert.deepEqual(stats.clockMapping, { timestamp: 'run-arrival', targetClock: 'not-used', imageRead: 'previous-acknowledgement-to-arrival' })
  assert.equal(page.listeners.size, 0)
})

test('an unanswered WebKit start and stop are bounded independently of the page', async () => {
  const page = new Page()
  page.answer = () => new Promise(() => undefined)
  const source = new WebKitFrameSource(page, identity)
  const started = performance.now()
  const result = await source.start({ ...capture([]), timeoutMs: 20 })
  assert.equal(result.ok, false)
  assert.ok(performance.now() - started < 500)
  assert.equal(page.listeners.size, 0)
  const next = new Page()
  const running = new WebKitFrameSource(next, identity)
  await running.start(capture([]))
  next.answer = () => new Promise(() => undefined)
  const stopped = await running.stop(20)
  assert.match(stopped.problems[0] ?? '', /within 20 ms/)
  assert.equal(next.listeners.size, 0)
})

test('disposing a WebKit page ends a source even when the page stops its listeners first', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity)
  const frames: CapturedFrame[] = []
  const reasons: string[] = []
  await source.start(capture(frames, reasons))
  page.paint()
  page.lostReason = 'the page was closed'
  await sleep(80)
  const stats = await source.stop(100)
  assert.equal(reasons.length, 1)
  assert.match(stats.endedEarly ?? '', /the page was closed/)
  page.paint()
  assert.equal(frames.length, 1)
})

test('an identity refusal starts no WebKit command', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity, 'a different session')
  assert.deepEqual(source.availability(), { available: false, reason: 'a different session' })
  assert.deepEqual(await source.start(capture([])), { ok: false, reason: 'a different session' })
  assert.equal(page.calls.length, 0)
})

test('cleanup of an uncertain WebKit start stays bounded and its unknown end stays in the stats', async () => {
  const page = new Page()
  page.answer = (method) => method === 'Screencast.startScreencast' ? Promise.reject(new Error('start reply lost')) : new Promise(() => undefined)
  const source = new WebKitFrameSource(page, identity)
  assert.equal((await source.start(capture([]))).ok, false)
  const started = performance.now()
  const stats = await source.stop(20)
  assert.ok(performance.now() - started < 500)
  assert.deepEqual(stats.problems, ["WebKit did not confirm the end of its uncertain screencast start within 20 ms."])
  assert.equal(page.listeners.size, 0)
})

test('WebKit bounds each frame by the previous acknowledged frame rather than screencast start', async () => {
  const page = new Page()
  const source = new WebKitFrameSource(page, identity)
  const frames: CapturedFrame[] = []
  let now = 0
  await source.start({ ...capture(frames), fps: 20, clock: () => now })
  try {
    now = 100_000
    page.paint()
    now = 110_000
    page.paint()
    now = 120_000
    page.paint()
    now = 200_000
    page.paint()
    now = 300_000
    page.paint()
    assert.deepEqual(frames.map(({ timestampUs, earliestUs }) => [timestampUs, earliestUs]), [
      [100_000, 0], [200_000, 120_000], [300_000, 200_000],
    ])
  } finally { await source.stop(100) }
})
