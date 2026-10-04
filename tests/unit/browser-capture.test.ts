import type { CaptureSession } from '../../src/browser/capture.ts'
import type { CapturedFrame, StartCapture } from '../../src/media/capture.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { ChromiumFrameSource } from '../../src/browser/capture.ts'

const identity: RecordIdentity = { testId: 'tests/tasks.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }

type Sent = { method: string; params: object | undefined }

/** A page's DevTools session a test drives: it keeps what was sent and plays Chrome's frames and its end. */
class FakeSession implements CaptureSession {
  readonly id = 'session-1'
  readonly sent: Sent[] = []
  detachReason: string | undefined
  blockReason: string | undefined
  readonly #listeners = new Map<string, Set<(params: unknown) => void>>()
  readonly #detach = new Set<(reason: string) => void>()
  readonly #answer: (method: string) => Promise<unknown>

  constructor(answer: (method: string) => Promise<unknown> = () => Promise.resolve({})) {
    this.#answer = answer
  }

  send(method: string, params?: object): Promise<unknown> {
    this.sent.push({ method, params })
    return this.#answer(method)
  }

  on(method: string, listener: (params: unknown) => void): () => void {
    const listeners = this.#listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.#listeners.set(method, listeners)
    return () => listeners.delete(listener)
  }

  onDetach(listener: (reason: string) => void): () => void {
    this.#detach.add(listener)
    return () => this.#detach.delete(listener)
  }

  /** Chrome sends a screencast frame. */
  paint(sessionId: number, data: string = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')): void {
    for (const listener of this.#listeners.get('Page.screencastFrame') ?? []) listener({ data, sessionId, metadata: { timestamp: 1 } })
  }

  detach(reason: string): void {
    this.detachReason = reason
    for (const listener of this.#detach) listener(reason)
  }

  listening(): number {
    return [...this.#listeners.values()].reduce((sum, listeners) => sum + listeners.size, 0) + this.#detach.size
  }

  acknowledged(): number[] {
    return this.sent.flatMap(({ method, params }) => (method === 'Page.screencastFrameAck' && params !== undefined && 'sessionId' in params && typeof params.sessionId === 'number' ? [params.sessionId] : []))
  }
}

type Capture = { start: StartCapture; frames: CapturedFrame[]; ended: string[]; setNow(us: number): void }

function capture(fps: number): Capture {
  let now = 0
  const frames: CapturedFrame[] = []
  const ended: string[] = []
  const start: StartCapture = { fps, clock: () => now, deliver: (frame) => frames.push(frame), ended: (reason) => ended.push(reason), timeoutMs: 1000 }
  return { start, frames, ended, setNow: (us) => (now = us) }
}

describe('the Chromium frame source over one page’s session', () => {
  test('starts Chrome’s screencast on that session, acknowledges every frame and keeps its bytes as Chrome encoded them', async () => {
    const session = new FakeSession()
    const source = new ChromiumFrameSource(session, identity, { format: 'png', maxWidth: 1280 })
    assert.deepEqual(source.availability(), { available: true, mode: 'screencast' })
    const run = capture(1000)
    assert.deepEqual(await source.start(run.start), { ok: true, mode: 'screencast' })
    assert.deepEqual(session.sent[0], { method: 'Page.startScreencast', params: { format: 'png', maxWidth: 1280 } })
    run.setNow(5000)
    session.paint(7, Buffer.from('a png').toString('base64'))
    assert.deepEqual(session.acknowledged(), [7])
    assert.deepEqual(run.frames, [{ identity, timestampUs: 5000, format: 'png', bytes: Buffer.from('a png') }])
    run.setNow(2_005_000)
    const stats = await source.stop(1000)
    assert.equal(session.sent.at(-1)?.method, 'Page.stopScreencast')
    assert.equal(session.listening(), 0, 'nothing is left listening')
    assert.deepEqual(stats, {
      mode: 'screencast',
      requestedFps: 1000,
      delivered: 1,
      superseded: 0,
      dropped: 0,
      startedAtUs: 0,
      stoppedAtUs: 2_005_000,
      achievedFps: 0.5,
      firstTimestampUs: 5000,
      lastTimestampUs: 5000,
      problems: [],
    })
  })

  test('hands over at most one frame each turn of the cadence, and the newest frame waiting when its turn comes', async () => {
    const session = new FakeSession()
    const source = new ChromiumFrameSource(session, identity)
    const run = capture(20)
    await source.start(run.start)
    session.paint(1)
    run.setNow(10_000)
    session.paint(2)
    run.setNow(20_000)
    session.paint(3)
    assert.deepEqual(run.frames.map((frame) => frame.timestampUs), [0], 'frames sooner than 50 ms wait')
    await delay(80)
    assert.deepEqual(run.frames.map((frame) => frame.timestampUs), [0, 20_000], 'the newest frame was handed over when its turn came')
    run.setNow(200_000)
    session.paint(4)
    assert.deepEqual(run.frames.map((frame) => frame.timestampUs), [0, 20_000, 200_000], 'a frame after its turn goes at once')
    assert.deepEqual(session.acknowledged(), [1, 2, 3, 4], 'every frame is acknowledged, kept or not')
    run.setNow(300_000)
    const stats = await source.stop(1000)
    assert.equal(stats.delivered, 3)
    assert.equal(stats.superseded, 1)
    assert.equal(stats.achievedFps, 10, 'three frames over the whole 300 ms of capture, never more than were asked for')
  })

  test('a frame waiting for its turn when capture stops is handed over before the stop resolves', async () => {
    const session = new FakeSession()
    const source = new ChromiumFrameSource(session, identity)
    const run = capture(1)
    await source.start(run.start)
    session.paint(1)
    run.setNow(30_000)
    session.paint(2)
    const stats = await source.stop(1000)
    assert.deepEqual(run.frames.map((frame) => frame.timestampUs), [0, 30_000])
    assert.equal(stats.delivered, 2)
    run.setNow(40_000)
    session.paint(3)
    assert.equal(run.frames.length, 2, 'nothing is handed over once stopped')
  })

  test('a frame it cannot read, or one with no image, is dropped and counted, never handed over', async () => {
    const session = new FakeSession()
    const source = new ChromiumFrameSource(session, identity)
    const run = capture(1000)
    await source.start(run.start)
    session.paint(1, '')
    session.paint(2, Buffer.from('ok').toString('base64'))
    const stats = await source.stop(1000)
    assert.equal(stats.dropped, 1)
    assert.equal(stats.delivered, 1)
    assert.deepEqual(stats.problems, ['Chrome sent a frame with no image in it.'])
  })

  test('the page’s session ending ends capture, says why, and hands over what was waiting', async () => {
    const session = new FakeSession()
    const source = new ChromiumFrameSource(session, identity)
    const run = capture(1)
    await source.start(run.start)
    session.paint(1)
    run.setNow(10_000)
    session.paint(2)
    session.detach('the target crashed')
    assert.deepEqual(run.ended, ["The page's session ended: the target crashed."])
    assert.equal(run.frames.length, 2)
    const stats = await source.stop(1000)
    assert.equal(stats.endedEarly, "The page's session ended: the target crashed.")
    assert.equal(session.sent.filter((each) => each.method === 'Page.stopScreencast').length, 0, 'a gone session is sent nothing more')
    assert.deepEqual(source.availability(), { available: false, reason: 'The page is gone, so Chrome cannot capture it: the target crashed.' })
  })

  test('a page that cannot answer, or is gone, is named unavailable, and its start is refused with the same reason', async () => {
    const held = new FakeSession()
    held.blockReason = 'a JavaScript alert dialog holds the page'
    const source = new ChromiumFrameSource(held, identity)
    assert.deepEqual(source.availability(), { available: false, reason: 'Chrome cannot capture the page while a JavaScript alert dialog holds the page.' })
    assert.deepEqual(await source.start(capture(10).start), { ok: false, reason: 'Chrome cannot capture the page while a JavaScript alert dialog holds the page.' })
    assert.equal(held.sent.length, 0)
  })

  test('a screencast Chrome refuses to start is not a capture, and leaves nothing listening', async () => {
    const session = new FakeSession((method) => (method === 'Page.startScreencast' ? Promise.reject(new Error('Not supported')) : Promise.resolve({})))
    const source = new ChromiumFrameSource(session, identity)
    const started = await source.start(capture(10).start)
    assert.deepEqual(started, { ok: false, reason: 'Chrome did not start its screencast of the page: Not supported' })
    assert.equal(session.listening(), 0)
    assert.deepEqual(session.sent.map((each) => each.method), ['Page.startScreencast', 'Page.stopScreencast'], 'a start that may have begun late is ended')
    assert.deepEqual(await source.start(capture(10).start), { ok: false, reason: 'This capture has started before; a source captures once.' })
  })

  test('a frame waiting when the screencast start fails is counted as dropped', async () => {
    const answer = Promise.withResolvers<unknown>()
    const session = new FakeSession((method) => method === 'Page.startScreencast' ? answer.promise : Promise.resolve({}))
    const source = new ChromiumFrameSource(session, identity)
    const run = capture(1)
    const starting = source.start(run.start)
    session.paint(1)
    run.setNow(100)
    session.paint(2)
    answer.reject(new Error('answer lost'))
    assert.equal((await starting).ok, false)
    const stats = await source.stop(100)
    assert.deepEqual([stats.delivered, stats.superseded, stats.dropped], [1, 0, 1])
    assert.equal(stats.stoppedAtUs, 100)
    assert.equal(session.listening(), 0)
  })

  test('a frame the receiver refuses is dropped and is not reported as delivered', async () => {
    const session = new FakeSession()
    const source = new ChromiumFrameSource(session, identity)
    const run = capture(10)
    await source.start({ ...run.start, deliver: () => { throw new Error('receiver unavailable') } })
    session.paint(1)
    const stats = await source.stop(100)
    assert.deepEqual([stats.delivered, stats.dropped], [0, 1])
    assert.equal(stats.firstTimestampUs, undefined)
    assert.match(stats.problems.join(' '), /receiver unavailable/)
  })

  test('a stop during the start ends the screencast after its start, and the start says it was stopped', async () => {
    const answer = Promise.withResolvers<unknown>()
    const session = new FakeSession((method) => (method === 'Page.startScreencast' ? answer.promise : Promise.resolve({})))
    const source = new ChromiumFrameSource(session, identity)
    const starting = source.start(capture(10).start)
    const stopping = source.stop(1000)
    answer.resolve({})
    assert.deepEqual(await starting, { ok: false, reason: 'The capture was stopped before it started.' })
    await stopping
    assert.deepEqual(session.sent.map((each) => each.method), ['Page.startScreencast', 'Page.stopScreencast'])
  })

  test('a stop Chrome refuses is named, and capture ends', async () => {
    const session = new FakeSession((method) => (method === 'Page.stopScreencast' ? Promise.reject(new Error('Target closed')) : Promise.resolve({})))
    const source = new ChromiumFrameSource(session, identity)
    await source.start(capture(10).start)
    const stats = await source.stop(50)
    assert.deepEqual(stats.problems, ['Chrome did not answer the end of its screencast: Target closed'])
    assert.equal(session.listening(), 0)
  })

  test('a stop Chrome never answers resolves within its time, named, with nothing left listening', async () => {
    const session = new FakeSession((method) => (method === 'Page.stopScreencast' ? new Promise(() => {}) : Promise.resolve({})))
    const source = new ChromiumFrameSource(session, identity)
    await source.start(capture(10).start)
    const startedAt = performance.now()
    const stats = await source.stop(50)
    assert.ok(performance.now() - startedAt < 1000, 'the stop did not wait on Chrome')
    assert.deepEqual(stats.problems, ['Chrome did not answer the end of its screencast within 50 ms.'])
    assert.equal(session.listening(), 0)
  })

  test('frames Chrome sends while the stop is on its way are counted, and the newest is handed over', async () => {
    const answer = Promise.withResolvers<unknown>()
    const session = new FakeSession((method) => (method === 'Page.stopScreencast' ? answer.promise : Promise.resolve({})))
    const source = new ChromiumFrameSource(session, identity)
    const run = capture(1)
    await source.start(run.start)
    session.paint(1)
    const stopping = source.stop(1000)
    run.setNow(10_000)
    session.paint(2)
    run.setNow(20_000)
    session.paint(3)
    answer.resolve({})
    const stats = await stopping
    assert.deepEqual(session.acknowledged(), [1, 2, 3])
    assert.equal(stats.delivered + stats.superseded + stats.dropped, 3, 'every frame Chrome sent is counted once')
    assert.deepEqual(run.frames.map((frame) => frame.timestampUs), [0, 20_000], 'the newest frame waiting was handed over before the stop resolved')
    session.paint(4)
    assert.equal(run.frames.length, 2, 'nothing after the stop resolved')
  })

  test('a source the page refused names why, and starts nothing', async () => {
    const session = new FakeSession()
    const source = new ChromiumFrameSource(session, identity, {}, 'This page is session k3v9q0x2mb:web, not k3v9q0x2mb:phone.')
    assert.deepEqual(source.availability(), { available: false, reason: 'This page is session k3v9q0x2mb:web, not k3v9q0x2mb:phone.' })
    assert.deepEqual(await source.start(capture(10).start), { ok: false, reason: 'This page is session k3v9q0x2mb:web, not k3v9q0x2mb:phone.' })
    assert.equal(session.sent.length, 0)
  })

  test('a stop before any start captures nothing, and a refused acknowledgement is named', async () => {
    const idle = new ChromiumFrameSource(new FakeSession(), identity)
    assert.deepEqual(await idle.stop(100), { mode: 'screencast', requestedFps: 0, delivered: 0, superseded: 0, dropped: 0, problems: [] })
    const session = new FakeSession((method) => (method === 'Page.screencastFrameAck' ? Promise.reject(new Error('a JavaScript alert dialog holds the page')) : Promise.resolve({})))
    const source = new ChromiumFrameSource(session, identity)
    await source.start(capture(1000).start)
    session.paint(1)
    await delay(0)
    const stats = await source.stop(100)
    assert.deepEqual(stats.problems, ["Chrome did not take a frame's acknowledgement: a JavaScript alert dialog holds the page"])
    assert.equal(stats.delivered, 1)
  })
})
