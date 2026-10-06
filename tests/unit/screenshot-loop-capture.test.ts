import type { TestContext } from 'node:test'
import type { CapturedFrame, GrabbedImage, ScreenshotLoopOptions, SourceGap, StartCapture } from '../../src/media/capture.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ScreenshotLoopSource } from '../../src/media/capture.ts'

const identity: RecordIdentity = { testId: 'tests/phone.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'phone', sessionId: 'k3v9q0x2mb:phone' }
const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)
const image: GrabbedImage = { ok: true, format: 'jpeg', bytes: jpeg }

/** A target whose captures the test answers one by one, and whose loss it can announce. */
class FakeTarget {
  unavailable: string | undefined
  readonly asked: { timeoutMs: number; signal: AbortSignal }[] = []
  readonly #pending: ((image: GrabbedImage) => void)[] = []
  #lost: ((reason: string) => void) | undefined
  listening = 0

  options(overrides: Partial<ScreenshotLoopOptions> = {}): ScreenshotLoopOptions {
    return {
      name: 'simulator-display',
      identity,
      unavailable: () => this.unavailable,
      grab: (timeoutMs, signal) => {
        this.asked.push({ timeoutMs, signal })
        return new Promise<GrabbedImage>((resolve) => this.#pending.push(resolve))
      },
      onLost: (listener) => {
        this.#lost = listener
        this.listening += 1
        return () => {
          this.listening -= 1
          this.#lost = undefined
        }
      },
      grabTimeoutMs: 3000,
      ...overrides,
    }
  }

  get waiting(): number {
    return this.#pending.length
  }

  answer(next: GrabbedImage = image): void {
    const resolve = this.#pending.shift()
    assert.ok(resolve, 'a capture was out to answer')
    resolve(next)
  }

  lose(reason: string): void {
    this.#lost?.(reason)
  }
}

type Run = { start: StartCapture; frames: CapturedFrame[]; gaps: SourceGap[]; ended: string[]; clock: { now: number }; withheld: { now: boolean } }

function run(fps = 10): Run {
  const frames: CapturedFrame[] = []
  const gaps: SourceGap[] = []
  const ended: string[] = []
  const clock = { now: 0 }
  const withheld = { now: false }
  const start: StartCapture = { fps, clock: () => clock.now, deliver: (frame) => frames.push(frame), ended: (reason) => ended.push(reason), timeoutMs: 1000, gap: (gap) => gaps.push(gap), withheld: () => withheld.now }
  return { start, frames, gaps, ended, clock, withheld }
}

// Lets the loop's promises settle.
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

// Moves the run's clock and the mocked timers on together.
async function advance(t: TestContext, capture: Run, milliseconds: number): Promise<void> {
  capture.clock.now += milliseconds * 1000
  t.mock.timers.tick(milliseconds)
  await settle()
}

// Starts a loop whose first capture comes back at once with an image.
async function started(t: TestContext, target: FakeTarget, capture: Run): Promise<ScreenshotLoopSource> {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const source = new ScreenshotLoopSource(target.options())
  const starting = source.start(capture.start)
  await settle()
  target.answer()
  assert.deepEqual(await starting, { ok: true, mode: 'screenshot-loop' })
  return source
}

describe('a screenshot loop is never an empty capture that looks like a working one', () => {
  test('it says it is a screenshot loop, or why it cannot capture, and sends nothing to say so', () => {
    const target = new FakeTarget()
    const source = new ScreenshotLoopSource(target.options())
    assert.deepEqual(source.availability(), { available: true, mode: 'screenshot-loop' })
    target.unavailable = 'The simulator is shut down.'
    assert.deepEqual(source.availability(), { available: false, reason: 'The simulator is shut down.' })
    assert.equal(target.asked.length, 0)
  })

  test('start answers only once the first capture came back with an image, which is the first frame, bytes untouched', async (t) => {
    const target = new FakeTarget()
    const capture = run()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const source = new ScreenshotLoopSource(target.options())
    let answered = false
    const starting = source.start(capture.start).then((answer) => ((answered = true), answer))
    await settle()
    assert.equal(answered, false, 'start waits for the first capture')
    assert.equal(target.asked[0]?.timeoutMs, 1000, 'the first capture has the start’s time at most')
    capture.clock.now = 140_000
    target.answer()
    assert.deepEqual(await starting, { ok: true, mode: 'screenshot-loop' })
    assert.equal(capture.frames.length, 1)
    assert.equal(capture.frames[0]?.bytes, jpeg, 'the image is handed over as the target encoded it, the same bytes')
    assert.deepEqual([capture.frames[0]?.timestampUs, capture.frames[0]?.format, capture.frames[0]?.identity], [140_000, 'jpeg', identity])
    await source.stop(100)
  })

  test('a first capture that fails starts nothing, reports no stretch, and says why', async (t) => {
    const target = new FakeTarget()
    const capture = run()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const source = new ScreenshotLoopSource(target.options())
    const starting = source.start(capture.start)
    await settle()
    target.answer({ ok: false, problem: 'simctl exited with code 164' })
    assert.deepEqual(await starting, { ok: false, reason: 'The first simulator-display capture failed: simctl exited with code 164' })
    assert.deepEqual(capture.gaps, [])
    assert.equal(target.listening, 0, 'nothing is left listening to the target')
    await advance(t, capture, 500)
    assert.equal(target.asked.length, 1, 'no capture is asked for after a failed start')
    const stats = await source.stop(100)
    assert.deepEqual([stats.delivered, stats.dropped, stats.problems], [0, 1, ['simctl exited with code 164']])
  })

  test('a start refuses a cadence of 0, an unavailable target, and a second start', async (t) => {
    const target = new FakeTarget()
    assert.deepEqual(await new ScreenshotLoopSource(target.options()).start({ ...run(0).start }), { ok: false, reason: 'A capture needs a cadence above 0 frames a second, not 0.' })
    target.unavailable = 'The session is disposed.'
    assert.deepEqual(await new ScreenshotLoopSource(target.options()).start(run().start), { ok: false, reason: 'The session is disposed.' })
    target.unavailable = undefined
    const source = await started(t, target, run())
    assert.deepEqual(await source.start(run().start), { ok: false, reason: 'This capture has started before; a source captures once.' })
    await source.stop(100)
  })
})

describe('a screenshot loop asks for one capture at a time, at most the cadence asked for', () => {
  test('a capture that comes back within its tick is followed by one on the next tick', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    // Each capture takes 20 ms, so the next tick is 80 ms after it came back.
    let untilTick = 100
    for (let tick = 1; tick <= 5; tick++) {
      await advance(t, capture, untilTick - 1)
      assert.equal(target.waiting, 0, 'nothing is asked for before the tick')
      await advance(t, capture, 1)
      assert.equal(target.waiting, 1, `tick ${tick} asks for a capture`)
      await advance(t, capture, 20)
      target.answer()
      await settle()
      untilTick = 80
    }
    const stats = await source.stop(100)
    assert.deepEqual([stats.delivered, stats.skippedTicks, stats.dropped], [6, 0, 0])
    assert.deepEqual(capture.frames.map((frame) => frame.timestampUs), [0, 120_000, 220_000, 320_000, 420_000, 520_000])
  })

  test('a slow capture is followed at once by the next, and the ticks that passed while it was out are skipped', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    await advance(t, capture, 100)
    assert.equal(target.waiting, 1)
    await advance(t, capture, 350)
    assert.equal(target.waiting, 1, 'no second capture is asked for while one is out')
    target.answer()
    await settle()
    await advance(t, capture, 0)
    assert.equal(target.waiting, 1, 'the next capture is asked for as soon as the slow one came back')
    target.answer()
    await settle()
    const stats = await source.stop(100)
    assert.equal(stats.skippedTicks, 2, 'ticks at 200 and 300 ms passed wholly while the capture was out; 400 ms was served late')
    assert.equal(stats.delivered, 3)
  })

  test('while frames are withheld no capture is asked for, and the ticks are counted apart', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    capture.withheld.now = true
    await advance(t, capture, 100)
    await advance(t, capture, 100)
    assert.equal(target.waiting, 0)
    capture.withheld.now = false
    await advance(t, capture, 100)
    assert.equal(target.waiting, 1)
    target.answer()
    await settle()
    const stats = await source.stop(100)
    assert.deepEqual([stats.withheldTicks, stats.skippedTicks, stats.delivered], [2, 0, 2])
  })
})

describe('a screenshot loop counts what failed, and ends when its target goes', () => {
  test('failed captures are dropped and named, and a run of them is one capture_failed stretch reported when a capture comes back', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    await advance(t, capture, 100)
    await advance(t, capture, 30)
    target.answer({ ok: false, problem: 'WebDriverAgent did not answer the screenshot' })
    await settle()
    await advance(t, capture, 70)
    await advance(t, capture, 40)
    target.answer({ ok: true, format: 'png', bytes: new Uint8Array(0) })
    await settle()
    assert.deepEqual(capture.gaps, [], 'the stretch is reported once it is over')
    await advance(t, capture, 60)
    await advance(t, capture, 10)
    target.answer()
    await settle()
    assert.deepEqual(capture.gaps, [{ fromUs: 100_000, toUs: 240_000, reason: 'capture_failed' }])
    const stats = await source.stop(100)
    assert.deepEqual([stats.delivered, stats.dropped], [2, 2])
    assert.deepEqual(stats.problems, ['WebDriverAgent did not answer the screenshot', 'The simulator-display capture came back with no image in it.'])
  })

  test('a stretch of failed captures still open when capture stops is reported, ending at the last failure', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    await advance(t, capture, 100)
    await advance(t, capture, 25)
    target.answer({ ok: false, problem: 'timed out' })
    await settle()
    await source.stop(100)
    assert.deepEqual(capture.gaps, [{ fromUs: 100_000, toUs: 125_000, reason: 'capture_failed' }])
  })

  test('a grab that throws is one failed capture, not the end of the loop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const capture = run(10)
    let calls = 0
    const source = new ScreenshotLoopSource({
      ...new FakeTarget().options(),
      grab: () => {
        calls += 1
        if (calls === 2) throw new Error('the pipe broke')
        return Promise.resolve(image)
      },
    })
    assert.deepEqual(await source.start(capture.start), { ok: true, mode: 'screenshot-loop' })
    await advance(t, capture, 100)
    await advance(t, capture, 100)
    const stats = await source.stop(100)
    assert.deepEqual([stats.delivered, stats.dropped, stats.problems], [2, 1, ['the pipe broke']])
  })

  test('a capture that says the target is lost ends capture with that reason, and asks for nothing more', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    await advance(t, capture, 100)
    target.answer({ ok: false, problem: 'the session was disposed', lost: true })
    await settle()
    assert.deepEqual(capture.ended, ["The simulator-display capture's target ended: the session was disposed"])
    assert.equal(target.asked[1]?.signal.aborted, true, 'whatever is out is given up')
    await advance(t, capture, 500)
    assert.equal(target.asked.length, 2)
    const stats = await source.stop(100)
    assert.equal(stats.endedEarly, "The simulator-display capture's target ended: the session was disposed")
    assert.equal(stats.dropped, 0, 'a loss is the end of capture, not a dropped frame')
  })

  test('the target telling it went away ends capture once, and nothing is left listening', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    target.lose('the simulator shut down')
    target.lose('again')
    assert.deepEqual(capture.ended, ["The simulator-display capture's target ended: the simulator shut down"])
    assert.equal(target.listening, 0)
    const stats = await source.stop(100)
    assert.equal(stats.stoppedAtUs, 0)
  })
})

describe('a screenshot loop stops on time', () => {
  test('stop waits for a capture still out and hands over its image when it comes back in time', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    await advance(t, capture, 100)
    const stopping = source.stop(1000)
    await settle()
    target.answer()
    const stats = await stopping
    assert.equal(stats.delivered, 2)
    await advance(t, capture, 500)
    assert.equal(target.asked.length, 2, 'nothing is asked for after the stop')
  })

  test('a capture that does not come back within the stop’s time is given up, named, and nothing it brings back is handed over', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    await advance(t, capture, 100)
    const stopping = source.stop(50)
    await settle()
    t.mock.timers.tick(50)
    const stats = await stopping
    assert.equal(target.asked[1]?.signal.aborted, true)
    assert.deepEqual(stats.problems, ["A simulator-display capture was still out when the stop's 50 ms were up; it was given up, and nothing it brings back is handed over."])
    target.answer()
    await settle()
    assert.equal(capture.frames.length, 1)
    assert.equal(stats.delivered, 1)
    assert.deepEqual(await source.stop(50), stats, 'a second stop answers the same')
  })

  test('a stop before start starts nothing, and a start after it is refused', async () => {
    const target = new FakeTarget()
    const source = new ScreenshotLoopSource(target.options())
    const stats = await source.stop(100)
    assert.deepEqual([stats.mode, stats.delivered, stats.requestedFps], ['screenshot-loop', 0, 0])
    assert.deepEqual(await source.start(run().start), { ok: false, reason: 'This capture has started before; a source captures once.' })
    assert.equal(target.asked.length, 0)
  })

  test('a stop while the first capture is out ends the start, which says it was stopped', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const target = new FakeTarget()
    const capture = run(10)
    const source = new ScreenshotLoopSource(target.options())
    const starting = source.start(capture.start)
    await settle()
    const stopping = source.stop(1000)
    await settle()
    target.answer()
    assert.deepEqual(await starting, { ok: false, reason: 'The capture was stopped before it started.' })
    const stats = await stopping
    assert.equal(stats.delivered, 1, 'the image that came back before the stop answered was handed over and counted')
  })

  test('its stats name the time each capture took', async (t) => {
    const target = new FakeTarget()
    const capture = run(10)
    const source = await started(t, target, capture)
    const stats = await source.stop(100)
    assert.equal(stats.captureMs?.count, 1)
    assert.ok((stats.captureMs?.minMs ?? -1) >= 0 && (stats.captureMs?.maxMs ?? -1) >= (stats.captureMs?.minMs ?? 0))
  })
})

test('a screenshot grab that ignores its timeout cannot hold the start open or deliver a late image', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const target = new FakeTarget()
  const capture = run()
  const source = new ScreenshotLoopSource(target.options())
  const starting = source.start(capture.start)
  await settle()
  t.mock.timers.tick(1000)
  await settle()
  assert.equal((await starting).ok, false)
  assert.equal(target.asked[0]?.signal.aborted, true)
  target.answer()
  await settle()
  assert.equal(capture.frames.length, 0)
  assert.equal((await source.stop(100)).delivered, 0)
})
