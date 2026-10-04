import type { CaptureAvailability, CaptureStart, CaptureStats, CapturedFrame, FrameSource, MediaRecorder, RecordingTarget, RecordSourceOptions, StartCapture } from '../../src/media/capture.ts'
import type { Ended, FrameOutcome, StartRecording, Started } from '../../src/media/client.ts'
import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../../src/shared/process-ownership.ts'
import type { CaptureSourceName, RecordIdentity } from '../../src/protocol/identity.ts'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { describe, test } from 'node:test'
import { microsecondsSince, recordSource } from '../../src/media/capture.ts'
import { captureEncoderOwnership, MAX_FRAME_BYTES } from '../../src/media/client.ts'
import { OwnedProcessGroup } from '../../src/shared/process-ownership.ts'

const identity: RecordIdentity = { testId: 'tests/tasks.retest.ts > saves', attemptId: 'k3v9q0x2mb', app: 'web', sessionId: 'k3v9q0x2mb:web' }
const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9)

function frame(timestampUs: number, overrides: Partial<CapturedFrame> = {}): CapturedFrame {
  return { identity, timestampUs, format: 'jpeg', bytes: jpeg, ...overrides }
}

function stats(overrides: Partial<CaptureStats> = {}): CaptureStats {
  return { mode: 'screencast', requestedFps: 10, delivered: 0, superseded: 0, dropped: 0, problems: [], ...overrides }
}

function ended(status: Ended['status'], received = 0): Ended {
  return {
    type: 'ended',
    recordingId: 'rec-1',
    status,
    message: status === 'ok' ? 'The video is written.' : `The recording ended ${status}.`,
    frames: { received, shown: received, superseded: 0, dropped: 0, outOfOrder: 0, outOfRange: 0, undecodable: 0, unprocessed: 0, resized: 0 },
    framesBeforeFirst: 0,
    gaps: [],
    gapsShortened: 0,
    endClipped: false,
    outputFrames: received,
    durationUs: 0,
    bytesReceived: 0,
    bytesToEncoder: 0,
  }
}

const started: Started = {
  type: 'started',
  recordingId: 'rec-1',
  codec: 'h264',
  container: 'mp4',
  encoder: 'libx264',
  encoderVersion: '9.0.2',
  encoderPid: 4242,
  path: '/tmp/rec-1.mp4',
  width: 800,
  height: 600,
  fps: 10,
  queueFrames: 60,
  queueBytes: 64 * 1024 * 1024,
  maxGapMs: 10_000,
  maxDurationMs: 2000,
  stallMs: 10_000,
}

/** A recording that keeps what it was sent and answers each frame as `outcome` says. */
class FakeRecording implements RecordingTarget {
  readonly started: Started = started
  readonly sent: { timestampUs: number; byteLength: number }[] = []
  readonly finishes: (number | undefined)[] = []
  readonly #ended = Promise.withResolvers<Ended>()
  readonly #outcome: (index: number) => FrameOutcome
  readonly #finish: 'ok' | 'lost'

  constructor(options: { outcome?: (index: number) => FrameOutcome; finish?: 'ok' | 'lost' } = {}) {
    this.#outcome = options.outcome ?? (() => 'sent')
    this.#finish = options.finish ?? 'ok'
    this.#ended.promise.catch(() => {})
  }

  get ended(): Promise<Ended> {
    return this.#ended.promise
  }

  frame(sent: { timestampUs: number; bytes: Uint8Array }): FrameOutcome {
    const outcome = this.#outcome(this.sent.length)
    if (outcome === 'sent') this.sent.push({ timestampUs: sent.timestampUs, byteLength: sent.bytes.byteLength })
    return outcome
  }

  finish(_timeoutMs: number, endTimestampUs?: number): Promise<Ended> {
    this.finishes.push(endTimestampUs)
    if (this.#finish === 'lost') return Promise.reject(new Error('the media process ended with signal SIGKILL; recording rec-1 did not end'))
    this.end(ended('ok', this.sent.length))
    return this.#ended.promise
  }

  /** Ends the recording as the process would on its own. */
  end(reply: Ended): void {
    this.#ended.resolve(reply)
  }
}

/** A media process that starts the one recording it is given, or answers as told. */
class FakeMedia implements MediaRecorder {
  readonly starts: StartRecording[] = []
  readonly #answer: () => Promise<{ kind: 'started'; recording: RecordingTarget } | { kind: 'ended'; ended: Ended }>

  constructor(answer: () => Promise<{ kind: 'started'; recording: RecordingTarget } | { kind: 'ended'; ended: Ended }>) {
    this.#answer = answer
  }

  static starting(recording: FakeRecording): FakeMedia {
    return new FakeMedia(() => Promise.resolve({ kind: 'started', recording }))
  }

  record(start: StartRecording): Promise<{ kind: 'started'; recording: RecordingTarget } | { kind: 'ended'; ended: Ended }> {
    this.starts.push(start)
    return this.#answer()
  }
}

type FakeSourceOptions = {
  name?: CaptureSourceName
  availability?: CaptureAvailability
  /** What start does: deliver these frames and answer, or answer as told. */
  start?: (capture: StartCapture) => Promise<CaptureStart>
  stop?: () => Promise<CaptureStats>
  /** Throws from `availability`, as a broken source might. */
  availabilityThrows?: true
}

/** A source a test drives: it delivers frames when told, and counts its starts and stops. */
class FakeSource implements FrameSource {
  readonly name: CaptureSourceName
  readonly identity: RecordIdentity = identity
  capture: StartCapture | undefined
  stops = 0
  readonly #options: FakeSourceOptions

  constructor(options: FakeSourceOptions = {}) {
    this.name = options.name ?? 'chromium'
    this.#options = options
  }

  availability(): CaptureAvailability {
    if (this.#options.availabilityThrows === true) throw new Error('the source has no session')
    return this.#options.availability ?? { available: true, mode: 'screencast' }
  }

  start(capture: StartCapture): Promise<CaptureStart> {
    this.capture = capture
    return this.#options.start?.(capture) ?? Promise.resolve({ ok: true, mode: 'screencast' })
  }

  stop(): Promise<CaptureStats> {
    this.stops += 1
    return this.#options.stop?.() ?? Promise.resolve(stats({ requestedFps: this.capture?.fps ?? 0 }))
  }

  deliver(...frames: CapturedFrame[]): void {
    for (const each of frames) this.capture?.deliver(each)
  }
}

/** The run's clock as a test sets it, in microseconds. */
class TestClock {
  now = 0
  readonly read = (): number => this.now
}

function options(signal: AbortSignal, overrides: Partial<RecordSourceOptions> = {}, clock: TestClock = new TestClock()): RecordSourceOptions {
  return {
    recordingId: 'rec-1',
    output: '/tmp/rec-1',
    width: 800,
    height: 600,
    fps: 10,
    deadlineMs: 5000,
    clock: clock.read,
    startTimeoutMs: 200,
    stopTimeoutMs: 100,
    finishTimeoutMs: 6000,
    signal,
    ...overrides,
  }
}

// Lets the capture's start answer before the test drives it.
async function captureStarted(source: FakeSource): Promise<StartCapture> {
  for (let turn = 0; turn < 50; turn++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(source.capture, 'the capture started')
  return source.capture
}

const noneRefused = { identity: 0, timestamp: 0, clock: 0, outOfOrder: 0, outOfRange: 0, tooLarge: 0, empty: 0 }

describe('recordSource sends what the media protocol accepts and counts every frame once', () => {
  test('frames outside the bounds or clock rules, or of another session, are refused before they are sent', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource()
    const stop = new AbortController()
    const clock = new TestClock()
    clock.now = 500
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, {}, clock))
    await captureStarted(source)
    clock.now = 10_000_000
    source.deliver(
      frame(1000),
      frame(2000, { identity: { ...identity, observationId: 'o4' } }),
      frame(2500, { identity: { ...identity, sessionId: 'k3v9q0x2mb:phone' } }),
      frame(3000.5),
      frame(-1),
      frame(1500),
      frame(3000, { bytes: new Uint8Array(0) }),
      frame(3000, { bytes: new Uint8Array(MAX_FRAME_BYTES + 1) }),
      frame(4000),
    )
    clock.now = 1000 + 2000 * 1000 + 10
    source.deliver(frame(1000 + 2000 * 1000 + 1))
    stop.abort()
    const report = await running
    assert.deepEqual(report.frames, { delivered: 10, sent: 3, dropped: 0, notSent: 0, refused: { ...noneRefused, identity: 1, timestamp: 2, outOfOrder: 1, outOfRange: 1, tooLarge: 1, empty: 1 } })
    assert.deepEqual(recording.sent.map((each) => each.timestampUs), [1000, 2000, 4000], 'a frame naming its own look in the same session is sent')
    assert.equal(report.status, 'ended')
    assert.equal(report.stoppedBy, 'signal')
    assert.deepEqual(report.identity, identity)
  })

  test('a frame stamped on another clock is refused, though its own timestamps keep in order', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource()
    const stop = new AbortController()
    const clock = new TestClock()
    clock.now = 50_000
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, {}, clock))
    await captureStarted(source)
    clock.now = 60_000
    // Stamped before capture was asked to start, as a clock that began later would, then from the future, as one that
    // began earlier would; only the frame on the recording's own clock is sent.
    source.deliver(frame(10_000), frame(20_000), frame(900_000), frame(55_000))
    stop.abort()
    const report = await running
    assert.deepEqual(report.frames.refused, { ...noneRefused, clock: 3 })
    assert.deepEqual(recording.sent.map((each) => each.timestampUs), [55_000])
  })

  test('a full pipe, and a recording that is over, are counted apart from what was sent', async () => {
    const outcomes: FrameOutcome[] = ['sent', 'dropped', 'sent', 'closed', 'not_sent']
    let answered = 0
    const recording = new FakeRecording({ outcome: () => outcomes[answered++] ?? 'sent' })
    const source = new FakeSource()
    const stop = new AbortController()
    const clock = new TestClock()
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, {}, clock))
    await captureStarted(source)
    clock.now = 100
    source.deliver(frame(1), frame(2), frame(3), frame(4), frame(5))
    stop.abort()
    const report = await running
    assert.deepEqual([report.frames.sent, report.frames.dropped, report.frames.notSent], [2, 1, 2])
    assert.equal(report.frames.delivered, 5)
    assert.deepEqual(recording.sent.map((each) => each.timestampUs), [1, 3])
  })

  test('frames that come before the capture’s start answers wait, and go in order once it begins', async () => {
    const recording = new FakeRecording()
    const clock = new TestClock()
    const source = new FakeSource({
      start: (capture) => {
        clock.now = 10
        capture.deliver(frame(5))
        capture.deliver(frame(8))
        assert.equal(recording.sent.length, 0, 'nothing is sent before the start answers')
        return Promise.resolve({ ok: true, mode: 'screencast' })
      },
    })
    const stop = new AbortController()
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, {}, clock))
    await captureStarted(source)
    stop.abort()
    const report = await running
    assert.deepEqual(recording.sent.map((each) => each.timestampUs), [5, 8])
    assert.equal(report.frames.sent, 2)
  })

  test('the cadence asked for goes to the source and to the recording, and the source’s own count is reported', async () => {
    const recording = new FakeRecording()
    const reported = stats({ requestedFps: 4, delivered: 7, superseded: 3, dropped: 1, startedAtUs: 0, stoppedAtUs: 2_000_000, achievedFps: 3.5, problems: ['Chrome did not take a frame’s acknowledgement'] })
    const source = new FakeSource({ stop: () => Promise.resolve(reported) })
    const media = FakeMedia.starting(recording)
    const stop = new AbortController()
    const running = recordSource(source, media, options(stop.signal, { fps: 4, limits: { queueFrames: 30 } }))
    const capture = await captureStarted(source)
    assert.equal(capture.fps, 4)
    stop.abort()
    const report = await running
    assert.equal(media.starts[0]?.fps, 4)
    assert.equal(media.starts[0]?.queueFrames, 30)
    assert.deepEqual(report.capture, reported)
    assert.deepEqual(report.started, started)
  })

  test('a still page is held for as long as it stood still: the gap a frame may be held for is the whole recording', async () => {
    const plain = FakeMedia.starting(new FakeRecording())
    const stop = new AbortController()
    stop.abort()
    await recordSource(new FakeSource(), plain, options(stop.signal))
    assert.deepEqual([plain.starts[0]?.maxDurationMs, plain.starts[0]?.maxGapMs], [30 * 60 * 1000, 30 * 60 * 1000])
    const bounded = FakeMedia.starting(new FakeRecording())
    await recordSource(new FakeSource(), bounded, options(stop.signal, { limits: { maxDurationMs: 120_000 } }))
    assert.deepEqual([bounded.starts[0]?.maxDurationMs, bounded.starts[0]?.maxGapMs], [120_000, 120_000])
    const shortened = FakeMedia.starting(new FakeRecording())
    await recordSource(new FakeSource(), shortened, options(stop.signal, { limits: { maxGapMs: 5000 } }))
    assert.equal(shortened.starts[0]?.maxGapMs, 5000, 'a caller who asks for shorter gaps gets them')
  })
})

describe('recordSource stops on time, whatever the source does', () => {
  test('aborting stops the capture, then finishes the recording with its last frame held until the capture stopped', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource()
    const stop = new AbortController()
    const clock = new TestClock()
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, {}, clock))
    await captureStarted(source)
    clock.now = 6000
    source.deliver(frame(1000), frame(5000))
    clock.now = 9000
    stop.abort()
    const report = await running
    assert.equal(source.stops, 1)
    assert.deepEqual(recording.finishes, [9000])
    assert.equal(report.ended?.status, 'ok')
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0, 'nothing is left listening to the signal')
  })

  test('the report is final: frames a source delivers after it is returned change nothing', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource()
    const stop = new AbortController()
    const clock = new TestClock()
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, {}, clock))
    await captureStarted(source)
    clock.now = 2000
    source.deliver(frame(1000))
    stop.abort()
    const report = await running
    source.deliver(frame(1500))
    assert.deepEqual([report.frames.delivered, report.frames.notSent], [1, 0])
    assert.ok(Object.isFrozen(report) && Object.isFrozen(report.frames) && Object.isFrozen(report.frames.refused) && Object.isFrozen(report.problems))
  })

  test('a clock behind the last frame gives no end time rather than one before it', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource()
    const stop = new AbortController()
    let reads = 0
    // The clock reads 0 at the start, 6000 when the frame comes and 10 at the end, as a clock that went back would.
    const clock = (): number => [0, 6000][reads++] ?? 10
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, { clock }))
    await captureStarted(source)
    source.deliver(frame(5000))
    stop.abort()
    await running
    assert.deepEqual(recording.finishes, [undefined])
  })

  // Changed on purpose by the review: the report used to be the live tally, so a frame delivered after a stop that timed
  // out was counted into a report the caller already held. Now the report is a frozen copy and such a frame counts nowhere.
  test('a capture that does not stop in time is given up on, named, and the recording is still finished', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource({ stop: () => new Promise<CaptureStats>(() => {}) })
    const stop = new AbortController()
    const clock = new TestClock()
    const running = recordSource(source, FakeMedia.starting(recording), options(stop.signal, { stopTimeoutMs: 30 }, clock))
    await captureStarted(source)
    clock.now = 2000
    source.deliver(frame(1000))
    stop.abort()
    const report = await running
    assert.equal(report.status, 'ended')
    assert.equal(report.capture, undefined)
    assert.deepEqual(report.problems, ['The chromium capture did not stop within 30 ms; nothing it delivers after this is recorded or counted.'])
    source.deliver(frame(1500))
    assert.deepEqual([report.frames.delivered, report.frames.notSent], [1, 0], 'the returned report does not change')
  })

  test('a capture whose stop fails, at once or later, is named and the recording is finished', async () => {
    for (const [stopping, said] of [
      [() => Promise.reject(new Error('the page is gone')), 'the page is gone'],
      [
        () => {
          throw new Error('the session is closed')
        },
        'the session is closed',
      ],
    ] as const) {
      const recording = new FakeRecording()
      const source = new FakeSource({ stop: stopping })
      const stop = new AbortController()
      stop.abort()
      const report = await recordSource(source, FakeMedia.starting(recording), options(stop.signal))
      assert.equal(report.status, 'ended')
      assert.deepEqual(recording.finishes.length, 1)
      assert.deepEqual(report.problems, [`Stopping the chromium capture failed: ${said}`])
    }
  })

  test('a source that ends on its own stops the recording', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource()
    const clock = new TestClock()
    const running = recordSource(source, FakeMedia.starting(recording), options(new AbortController().signal, {}, clock))
    const capture = await captureStarted(source)
    clock.now = 2000
    source.deliver(frame(1000))
    capture.ended('The page’s session ended: the target closed.')
    const report = await running
    assert.equal(report.stoppedBy, 'source')
    assert.equal(report.status, 'ended')
    assert.equal(source.stops, 1)
  })

  test('a recording the process ends first stops the capture, and its own ending is the report', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource()
    const clock = new TestClock()
    const running = recordSource(source, FakeMedia.starting(recording), options(new AbortController().signal, {}, clock))
    await captureStarted(source)
    clock.now = 2000
    source.deliver(frame(1000))
    const failed = ended('encoder_failed', 1)
    recording.end(failed)
    const report = await running
    assert.equal(report.stoppedBy, 'recording')
    assert.equal(report.status, 'ended')
    assert.equal(report.ended, failed)
    assert.equal(source.stops, 1)
  })

  test('a recording that ends without its ending is lost, and says why', async () => {
    const recording = new FakeRecording({ finish: 'lost' })
    const source = new FakeSource()
    const stop = new AbortController()
    stop.abort()
    const report = await recordSource(source, FakeMedia.starting(recording), options(stop.signal))
    assert.equal(report.status, 'lost')
    assert.match(report.reason ?? '', /did not end/)
    assert.equal(report.ended, undefined)
  })

  test('a wait for the ending shorter than the process’s own deadline is refused by name, and nothing starts', async () => {
    const media = FakeMedia.starting(new FakeRecording())
    const source = new FakeSource()
    const report = await recordSource(source, media, options(new AbortController().signal, { deadlineMs: 20_000, finishTimeoutMs: 10_000 }))
    assert.equal(report.status, 'not_started')
    assert.equal(report.reason, 'finishTimeoutMs (10000 ms) is shorter than deadlineMs (20000 ms), so the wait could end while the process is still finishing the video.')
    assert.equal(media.starts.length, 0)
    assert.equal(source.capture, undefined)
  })
})

describe('a source that cannot capture says so, and nothing pretends it recorded', () => {
  test('an unavailable source starts no recording', async () => {
    const media = FakeMedia.starting(new FakeRecording())
    const source = new FakeSource({ availability: { available: false, reason: 'The page is gone, so Chrome cannot capture it: target closed.' } })
    const report = await recordSource(source, media, options(new AbortController().signal))
    assert.deepEqual(report, {
      source: 'chromium',
      identity,
      status: 'unavailable',
      reason: 'The page is gone, so Chrome cannot capture it: target closed.',
      frames: { delivered: 0, sent: 0, dropped: 0, notSent: 0, refused: noneRefused },
      problems: [],
    })
    assert.equal(media.starts.length, 0)
    assert.equal(source.capture, undefined)
  })

  test('a source whose availability throws is unavailable with the reason, and starts no recording', async () => {
    const media = FakeMedia.starting(new FakeRecording())
    const report = await recordSource(new FakeSource({ availabilityThrows: true }), media, options(new AbortController().signal))
    assert.deepEqual([report.status, report.reason], ['unavailable', 'The chromium source could not say whether it can capture: the source has no session'])
    assert.equal(media.starts.length, 0)
  })

  test('a source whose start fails is reported unavailable with its reason, and the empty recording is finished', async () => {
    const recording = new FakeRecording()
    const source = new FakeSource({ name: 'window-crop', start: () => Promise.resolve({ ok: false, reason: 'The window is off screen.' }) })
    const report = await recordSource(source, FakeMedia.starting(recording), options(new AbortController().signal))
    assert.equal(report.status, 'unavailable')
    assert.equal(report.source, 'window-crop')
    assert.equal(report.reason, 'The window is off screen.')
    assert.equal(report.ended?.frames.received, 0)
    assert.equal(source.stops, 1, 'a start that failed is still stopped, in case it answers late')
  })

  test('a start that throws at once or later, or does not answer in time, is unavailable, and nothing is left listening', async () => {
    const stop = new AbortController()
    const thrown = await recordSource(new FakeSource({ start: () => Promise.reject(new Error('no session')) }), FakeMedia.starting(new FakeRecording()), options(stop.signal))
    assert.equal(thrown.status, 'unavailable')
    assert.equal(thrown.reason, 'The chromium capture failed to start: no session')
    const atOnce = new FakeRecording()
    const synchronous = new FakeSource({
      start: () => {
        throw new Error('the page has no session')
      },
    })
    const threw = await recordSource(synchronous, FakeMedia.starting(atOnce), options(stop.signal))
    assert.deepEqual([threw.status, threw.reason], ['unavailable', 'The chromium capture failed to start: the page has no session'])
    assert.equal(atOnce.finishes.length, 1, 'the recording is finished')
    assert.equal(getEventListeners(stop.signal, 'abort').length, 0, 'nothing is left listening to the signal')
    const silent = new FakeSource({ start: () => new Promise<CaptureStart>(() => {}) })
    const late = await recordSource(silent, FakeMedia.starting(new FakeRecording()), options(stop.signal, { startTimeoutMs: 20 }))
    assert.equal(late.status, 'unavailable')
    assert.equal(late.reason, 'The chromium capture did not start within 20 ms.')
    assert.equal(silent.stops, 1)
  })

  test('a start that times out sends nothing, before or after, so an unavailable capture leaves no video', async () => {
    const recording = new FakeRecording()
    const clock = new TestClock()
    let deliver: ((frame: CapturedFrame) => void) | undefined
    const source = new FakeSource({
      start: (capture) => {
        deliver = capture.deliver
        clock.now = 100
        capture.deliver(frame(50))
        return new Promise<CaptureStart>(() => {})
      },
      stop: () => {
        deliver?.(frame(80))
        return Promise.resolve(stats())
      },
    })
    const report = await recordSource(source, FakeMedia.starting(recording), options(new AbortController().signal, { startTimeoutMs: 20 }, clock))
    assert.equal(report.status, 'unavailable')
    assert.deepEqual([report.frames.delivered, report.frames.sent, report.frames.notSent], [2, 0, 2])
    assert.equal(recording.sent.length, 0)
    assert.equal(report.ended?.frames.received, 0)
  })

  test('a recording the process could not start, or refused, starts no capture', async () => {
    const source = new FakeSource()
    const missing = ended('encoder_unavailable')
    const refused = await recordSource(source, new FakeMedia(() => Promise.resolve({ kind: 'ended', ended: missing })), options(new AbortController().signal))
    assert.equal(refused.status, 'not_started')
    assert.equal(refused.ended, missing)
    const gone = await recordSource(source, new FakeMedia(() => Promise.reject(new Error('the media process has ended with code 2'))), options(new AbortController().signal))
    assert.equal(gone.status, 'not_started')
    assert.equal(gone.reason, 'The media process started no recording: the media process has ended with code 2')
    assert.equal(source.capture, undefined)
  })
})

test('the run clock counts whole microseconds from its start, and a reading before it is negative, never 0', () => {
  let now = 1000.25
  const clock = microsecondsSince(1000, () => now)
  assert.equal(clock(), 250)
  now = 1012.3456
  assert.equal(clock(), 12_346)
  now = 999
  assert.equal(clock(), -1000)
})


/** A host snapshot and signal recorder. No system process is read or signaled by these tests. */
class OwnershipHost implements ProcessOwnershipSystem {
  processes: OwnedProcessIdentity[]
  readonly signals: { pid: number; signal: NodeJS.Signals }[] = []
  unreadable = false

  constructor(processes: OwnedProcessIdentity[]) {
    this.processes = processes
  }

  read(): OwnedProcessIdentity[] {
    if (this.unreadable) throw new Error('The process table could not be read.')
    return this.processes.map((entry) => ({ ...entry }))
  }

  signal(pid: number, signal: NodeJS.Signals | 0): void {
    const present = this.processes.some((entry) => pid < 0 ? entry.groupId === -pid : entry.pid === pid)
    if (!present) throw Object.assign(new Error('The process is gone.'), { code: 'ESRCH' })
    if (signal === 0) return
    assert.ok(pid > 0, 'cleanup must signal a verified pid, never a numeric group')
    this.signals.push({ pid, signal })
    if (signal === 'SIGKILL') this.processes = this.processes.filter((entry) => entry.pid !== pid)
  }
}

function ownedProcess(pid: number, parentPid: number, groupId: number, command: string): OwnedProcessIdentity {
  return { pid, parentPid, groupId, command, startedAt: `start-${pid}` }
}

function encoderHost(): OwnershipHost {
  return new OwnershipHost([
    ownedProcess(100, 50, 100, '/usr/bin/time retest-media'),
    ownedProcess(101, 100, 100, 'retest-media'),
    ownedProcess(200, 101, 200, 'ffmpeg output.partial'),
    ownedProcess(201, 200, 200, 'encoder-helper'),
  ])
}

describe('media cleanup uses recorded launch ownership', () => {
  test('a confirmed zombie is ended even when ps changes its displayed command, and receives no signal', () => {
    const process = ownedProcess(100, 50, 100, 'retest-media')
    const host = new OwnershipHost([process])
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    host.processes = [
      { ...process, command: '(retest-media)', state: 'Z' },
      { ...ownedProcess(101, 1, 100, '(unrecorded-child)'), state: 'Z' },
    ]
    assert.deepEqual(worker.capture(), [])
    assert.deepEqual(worker.signal('SIGKILL'), [])
    assert.deepEqual(host.signals, [])
    host.unreadable = true
    assert.equal(worker.remains(), true, 'an unanswered reading still cannot prove completion')
    host.unreadable = false
    assert.equal(worker.remains(), false)
  })

  test('an encoder under a wrapped worker is recorded before worker death, including its verified helper', () => {
    const host = encoderHost()
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    const ownership = captureEncoderOwnership(worker, 200)
    assert.deepEqual(ownership.problems, [])
    assert.ok(ownership.owner !== undefined)
    host.processes = host.processes.filter((entry) => entry.pid !== 100 && entry.pid !== 101).map((entry) => entry.pid === 200 ? { ...entry, parentPid: 1 } : entry)
    assert.deepEqual(ownership.owner.signal('SIGKILL'), [])
    assert.deepEqual(host.signals, [{ pid: 201, signal: 'SIGKILL' }, { pid: 200, signal: 'SIGKILL' }])
    assert.equal(ownership.owner.remains(), false)
  })

  test('a late started reply cannot claim a live encoder after the recorded worker has ended', () => {
    const host = encoderHost()
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    host.processes = host.processes.filter((entry) => entry.pid !== 100 && entry.pid !== 101).map((entry) => entry.pid === 200 ? { ...entry, parentPid: 1 } : entry)
    const ownership = captureEncoderOwnership(worker, 200)
    assert.equal(ownership.owner, undefined)
    assert.match(ownership.problems.join(' '), /worker could not be verified.*cleanup are unknown/)
    assert.deepEqual(host.signals, [])
    assert.equal(host.processes.some((entry) => entry.pid === 200), true)
  })

  test('a reported pid or encoder group that belongs to no recorded launch chain is left alone', () => {
    const host = encoderHost()
    host.processes = host.processes.map((entry) => entry.pid === 200 ? { ...entry, parentPid: 1 } : entry)
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    const ownership = captureEncoderOwnership(worker, 200)
    assert.equal(ownership.owner, undefined)
    assert.match(ownership.problems.join(' '), /not recorded.*left alone.*completion is unknown/)
    assert.deepEqual(host.signals, [])
  })

  test('the final SIGKILL checks both the exact command and the start identity again', () => {
    for (const changed of ['command', 'startedAt'] as const) {
      const host = encoderHost()
      const worker = new OwnedProcessGroup(100, 50, host)
      assert.deepEqual(worker.capture(), [])
      const ownership = captureEncoderOwnership(worker, 200)
      assert.ok(ownership.owner !== undefined)
      assert.deepEqual(ownership.owner.signal('SIGTERM'), [])
      host.processes = host.processes.map((entry) => entry.pid === 200 ? { ...entry, [changed]: 'another process' } : entry)
      const problems = ownership.owner.signal('SIGKILL')
      assert.match(problems.join(' '), /different identity.*left alone/)
      assert.equal(host.signals.some((entry) => entry.pid === 200 && entry.signal === 'SIGKILL'), false)
      assert.equal(host.processes.some((entry) => entry.pid === 200), true)
      assert.equal(ownership.owner.remains(), changed === 'command', 'an exec with the same birth reading stays unknown and held; a different birth reading is a replacement')
      host.processes.push(ownedProcess(202, 1, 200, 'another group member'))
      assert.equal(ownership.owner.remains(), changed === 'command', 'a reused numeric group cannot revive ended ownership')
    }
  })

  test('an unreadable process table is unknown ownership, and a missed initial launch cannot later claim a reused pid', () => {
    const host = encoderHost()
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    host.unreadable = true
    assert.equal(worker.remains(), true, 'a failed reading keeps cleanup unknown')
    const unreadable = captureEncoderOwnership(worker, 200)
    assert.equal(unreadable.owner, undefined)
    assert.match(unreadable.problems.join(' '), /could not be read|could not be verified/)
    assert.deepEqual(host.signals, [])
    const missed = new OwnershipHost([])
    const unrecorded = new OwnedProcessGroup(100, 50, missed)
    assert.match(unrecorded.capture().join(' '), /could not be recorded/)
    missed.processes = encoderHost().processes.map((entry) => entry.pid === 100 ? { ...entry, command: 'another media process' } : entry)
    assert.equal(captureEncoderOwnership(unrecorded, 200).owner, undefined)
    assert.deepEqual(missed.signals, [])
    const failed = encoderHost()
    failed.unreadable = true
    const failedFirst = new OwnedProcessGroup(100, 50, failed)
    assert.match(failedFirst.capture().join(' '), /could not be read/)
    failed.unreadable = false
    assert.equal(captureEncoderOwnership(failedFirst, 200).owner, undefined, 'an initially failed read cannot later adopt a launch')
    assert.equal(failedFirst.remains(), true, 'a failed first read cannot make a still-live launch free')
    assert.deepEqual(failed.signals, [])
  })

  test('a child first seen after its recorded parent exits holds cleanup without granting signal authority', () => {
    const host = new OwnershipHost([ownedProcess(100, 50, 100, 'retest-media')])
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    host.processes = [ownedProcess(101, 1, 100, 'unrecorded-child')]
    assert.match(worker.capture().join(' '), /ownership could not be verified/)
    assert.equal(worker.remains(), true)
    assert.match(worker.signal('SIGKILL').join(' '), /left alone/)
    assert.deepEqual(host.signals, [])
    host.processes = []
    assert.equal(worker.remains(), false)
  })

  test('natural exit cannot retire ownership before a newly observed group child is gone', () => {
    const host = new OwnershipHost([ownedProcess(100, 50, 100, 'retest-media')])
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    host.processes = [ownedProcess(101, 1, 100, 'unrecorded-child')]
    assert.equal(worker.remains(), true, 'liveness alone must retain the unknown child')
    assert.match(worker.signal('SIGKILL').join(' '), /ownership could not be verified/)
    assert.deepEqual(host.signals, [])
    host.processes = []
    assert.equal(worker.remains(), false)
  })

  test('a new group leader with a different birth identity cannot hold a fully ended launch', () => {
    const host = new OwnershipHost([ownedProcess(100, 50, 100, 'retest-media')])
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    host.processes = [{ ...ownedProcess(100, 70, 100, 'another app'), startedAt: 'a later start' }, ownedProcess(101, 100, 100, 'another child')]
    assert.match(worker.signal('SIGKILL').join(' '), /different identity/)
    assert.deepEqual(host.signals, [])
    assert.equal(worker.remains(), false)
  })

  test('an already recorded helper survives reparenting before the encoder ownership handoff', () => {
    const host = encoderHost()
    const worker = new OwnedProcessGroup(100, 50, host)
    assert.deepEqual(worker.capture(), [])
    host.processes = host.processes.map((entry) => entry.pid === 201 ? { ...entry, parentPid: 1 } : entry)
    const ownership = captureEncoderOwnership(worker, 200)
    assert.ok(ownership.owner !== undefined)
    assert.deepEqual(ownership.problems, [])
    host.processes = host.processes.filter((entry) => entry.pid !== 100 && entry.pid !== 101).map((entry) => entry.pid === 200 ? { ...entry, parentPid: 1 } : entry)
    assert.deepEqual(ownership.owner.signal('SIGKILL'), [])
    assert.deepEqual(host.signals, [{ pid: 201, signal: 'SIGKILL' }, { pid: 200, signal: 'SIGKILL' }])
    assert.equal(ownership.owner.remains(), false)
  })
})
