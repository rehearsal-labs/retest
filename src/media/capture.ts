import type { Clock } from '../protocol/deadline.ts'
import type { CaptureSourceName, RecordIdentity } from '../protocol/identity.ts'
import type { Ended, FrameFormat, FrameOutcome, Recording, StartRecording, Started } from './client.ts'
import { monotonicClock } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { MAX_FRAME_BYTES } from './client.ts'

// A session's frames on their way to the media process. A source captures and stamps; `recordSource` checks each frame
// against the bounds and clock rules of the media protocol and hands it to one recording, counting everything. Frames
// stay as the target encoded them: nothing here decodes, resizes or re-encodes an image.

/**
 * How a source gets its frames. `screencast`: the target sends frames when it chooses to, as the page paints, and holds
 * back the next until the last is acknowledged, so some paints never arrive as a frame. `screenshot-loop`: the source
 * asks for one capture on each tick of its cadence; it is not a live stream. In either mode, no frame between two times
 * does not mean nothing appeared on the page between them: a change that came and went between two frames is in
 * neither, and nothing about the frames can show it was absent.
 */
export type CaptureMode = 'screencast' | 'screenshot-loop'

/**
 * One frame as a source hands it over: `bytes`, the PNG or JPEG exactly as the target produced it, in `format`;
 * `timestampUs`, when the frame reached Retest, in whole microseconds on the run's clock; and the identity of the
 * session it came from. Its `observationId` is the look id the parent gave this capture when it served it to the test
 * file's process, as `RunningTest` numbers looks, and is absent when the parent served it as none; an id a native
 * session keeps for its own references is never used. The bytes must not change once handed over.
 */
export type CapturedFrame = { readonly identity: RecordIdentity; readonly timestampUs: number; readonly format: FrameFormat; readonly bytes: Uint8Array }

/** Whether a source can capture, and how; or why it cannot, in words a report can show. */
export type CaptureAvailability = { readonly available: true; readonly mode: CaptureMode } | { readonly available: false; readonly reason: string }

/** How a start went: capture runs, in the mode named, or it never began, and why. */
export type CaptureStart = { readonly ok: true; readonly mode: CaptureMode } | { readonly ok: false; readonly reason: string }

/**
 * What a capture is started with. `fps` is the most frames a second the caller wants handed over; a source may hand
 * over fewer, and says how many it did. `clock` is the run's clock in whole microseconds, which stamps every frame.
 * `deliver` takes each frame as it comes, in order, and must not wait. `ended` is told once, with the reason, when
 * capture stops before `stop` is asked, as when the page closes. `timeoutMs` bounds the start.
 */
export type StartCapture = {
  readonly fps: number
  readonly clock: () => number
  readonly deliver: (frame: CapturedFrame) => void
  readonly ended: (reason: string) => void
  readonly timeoutMs: number
}

/**
 * What a capture did, as its source counted it. `delivered` frames were handed over. `superseded` frames arrived sooner
 * than the cadence allowed and a newer frame took their place before their turn, so the newest state was handed over.
 * `dropped` frames arrived and could not be handed over, such as one with no bytes. `skippedTicks` counts, for a
 * screenshot loop, the ticks on which no capture was asked because the one before had not come back. `startedAtUs` and
 * `stoppedAtUs` are when capture began and ended on the run's clock, so a stretch with no frames shows as the time
 * between frames and not as a shorter capture. `achievedFps` is the delivered frames a second over that whole time; it
 * can be above the request by one frame over that time at most, since the first frame goes at once. For a screencast it
 * follows how often Chrome sent a frame, never how often the page changed. `endedEarly` is why capture
 * stopped before `stop` was asked. `problems` names what went wrong without ending it, such as an acknowledgement the
 * target refused, oldest first and at most a few.
 */
export type CaptureStats = {
  readonly mode: CaptureMode
  readonly requestedFps: number
  readonly delivered: number
  readonly superseded: number
  readonly dropped: number
  readonly skippedTicks?: number
  readonly startedAtUs?: number
  readonly stoppedAtUs?: number
  readonly achievedFps?: number
  readonly firstTimestampUs?: number
  readonly lastTimestampUs?: number
  readonly endedEarly?: string
  readonly problems: readonly string[]
}

/**
 * What a session exposes so the media process can record it. One source captures one session, names itself and the
 * session's identity, says by name when it cannot capture, and counts what it captured.
 *
 * The contract, for every source:
 * - `availability` answers at once and sends nothing. A source that cannot capture says `available: false` with the
 *   reason, and `start` then answers `ok: false` with a reason too. It never starts an empty capture that looks like a
 *   working one.
 * - `start` resolves within its `timeoutMs`. Frames it delivers before it resolves wait; capture counts as begun only
 *   once it resolves `ok: true`, and frames are recorded only then.
 * - Every frame carries the source's `identity`, and a timestamp from `clock`, taken when the frame reached Retest;
 *   timestamps never go back. A frame's `observationId` is the parent's look id for that capture, when the parent
 *   served it to the test file's process as a look, and none otherwise. Bytes are the target's own encoding, PNG or
 *   JPEG, never decoded or re-encoded. A frame that did not arrive is never delivered, repeated or made up.
 * - `stop` resolves within its `timeoutMs`, whatever the target does, and is safe to call more than once and before
 *   `start`. Every frame that arrives before it resolves is counted, delivered or not, and nothing is delivered after.
 * - The source changes nothing in the app: capturing sends no input.
 *
 * A native session's source is a `screenshot-loop` over `NativeAppSession.capture`, named by the capture source it uses
 * (`executor-screen`, `simulator-display` or `window-crop`, as `captureSources` lists them for its platform), never as
 * a live stream. A frame's `observationId` is the look id `RunningTest` gave that capture when it served it to the test
 * file's process, or none; never the `reference.observationId` the native session numbers for itself, which restarts
 * with each session object and names a different look. Its timestamp is when `capture` answered. A capture takes its
 * turn in the session's one queue of requests, so a tick that comes while the capture before it, or an action, still
 * holds the session is counted in `skippedTicks`, never as a frame. A capture that fails is counted in `dropped` with
 * its failure among `problems`; a session that is lost or disposed ends capture with `ended`. Pixels are not redacted:
 * a capture shows what the window shows, secrets included, and the capture policy, not text redaction, decides whether
 * it is kept.
 */
export interface FrameSource {
  readonly name: CaptureSourceName
  readonly identity: RecordIdentity
  availability(): CaptureAvailability
  start(options: StartCapture): Promise<CaptureStart>
  stop(timeoutMs: number): Promise<CaptureStats>
}

/** What `recordSource` needs of a recording: the process's start reply, its one ending, frames and the finish. */
export type RecordingTarget = Pick<Recording, 'started' | 'ended' | 'frame' | 'finish'>

/** What `recordSource` needs of the media process: to start a recording. `MediaProcess` is one. */
export type MediaRecorder = {
  record(start: StartRecording, timeoutMs: number): Promise<{ kind: 'started'; recording: RecordingTarget } | { kind: 'ended'; ended: Ended }>
}

/**
 * How one source is to be recorded. `recordingId`, `output`, `width`, `height`, `fps` and `deadlineMs` go to the media
 * process's start, as `StartRecording` describes them, and `limits` with them when given; `fps` is also the cadence the
 * source is asked for. A still page sends no frames, so unless `limits.maxGapMs` says otherwise the gap the video may
 * hold a frame for is the recording's whole longest duration, and the video shows the page for as long as it stood
 * still; a shorter `maxGapMs` shortens longer gaps, which `ended.gaps` lists. `clock` is the run's clock in whole
 * microseconds. `startTimeoutMs` bounds starting the recording and the capture, each; `stopTimeoutMs` bounds stopping
 * the capture; `finishTimeoutMs` bounds waiting for the recording's ending once it is finished, and may not be shorter
 * than `deadlineMs`. Aborting `signal` stops capture, and the recording is finished with the frames that came.
 */
export type RecordSourceOptions = {
  readonly recordingId: string
  readonly output: string
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly deadlineMs: number
  readonly limits?: Pick<StartRecording, 'queueFrames' | 'queueBytes' | 'maxGapMs' | 'maxDurationMs' | 'stallMs'>
  readonly clock: () => number
  readonly startTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly finishTimeoutMs: number
  readonly signal: AbortSignal
}

/**
 * Frames `recordSource` refused before sending, by reason. `identity`: the frame named another session than its
 * source. `timestamp`: not a whole number of microseconds from 0. `clock`: stamped on another clock than the
 * recording's, later than the recording's clock read when the frame came, or earlier than the moment capture was asked
 * to start. `outOfOrder`: earlier than the frame before it. `outOfRange`: later than the recording's longest duration
 * after its first frame. `tooLarge`: more bytes than a frame may have. `empty`: no bytes at all.
 */
export type RefusedFrames = { identity: number; timestamp: number; clock: number; outOfOrder: number; outOfRange: number; tooLarge: number; empty: number }

/**
 * Every frame the source delivered while the recording took frames, and what became of it: `sent` into the pipe to
 * the media process; `dropped` because the pipe already held as much as the client allows; `notSent` because capture
 * had not begun when the start failed, more frames came before it began than are held, or the recording was finishing,
 * over or its process gone; or refused, by reason. `delivered` is the sum of the rest. What reached the process is its
 * own `ended.frames.received`.
 */
export type FrameTally = { delivered: number; sent: number; dropped: number; notSent: number; refused: RefusedFrames }

/**
 * How recording a source went, as it stood when `recordSource` returned; the report is frozen and frames a source
 * delivers afterwards are counted nowhere. `status`: `unavailable`, the source could not capture, and `reason` says
 * why; `not_started`, no recording was started, and `reason` or `ended` says why; `ended`, the process sent the
 * recording's one ending, `ended`, whose own status says whether a video was written; `lost`, no ending came, as when
 * the process died or the finish outlasted its time, and `reason` says which. `stoppedBy` says what ended capture: the
 * caller's `signal`, the `source` ending on its own, or the `recording` ending first. `started` is the process's start
 * reply and `capture` the source's own count, each when there was one. `problems` names what went wrong around the
 * recording without changing its status, such as a capture that did not stop in time.
 */
export type SourceRecording = {
  readonly source: CaptureSourceName
  readonly identity: RecordIdentity
  readonly status: 'unavailable' | 'not_started' | 'ended' | 'lost'
  readonly reason?: string
  readonly stoppedBy?: 'signal' | 'source' | 'recording'
  readonly started?: Started
  readonly capture?: CaptureStats
  readonly ended?: Ended
  readonly frames: Readonly<FrameTally>
  readonly problems: readonly string[]
}

// The media process's own longest recording when a start names none, as `StartRecording` documents it.
const defaultMaxDurationMs = 30 * 60 * 1000
// Frames held while a capture's start has not answered. Chrome sends one when its screencast starts, which can come
// before the start's answer; more than a few would mean a source that delivers long before it says it began.
const heldFrames = 16

/**
 * A clock that counts whole microseconds since `startedAt`, a moment on `clock`: the run's clock in the media
 * protocol's unit, when `startedAt` is when the run began. A reading before `startedAt` is negative, as it is; a frame
 * stamped with it is refused, never taken as time zero.
 *
 * @example const runClock = microsecondsSince(runStartedAt); runClock() // 1834012
 */
export function microsecondsSince(startedAt: number, clock: Clock = monotonicClock): () => number {
  return () => Math.round((clock() - startedAt) * 1000)
}

/**
 * Records one source into one recording of the media process until `signal` aborts, the source ends, or the recording
 * ends on its own; then stops the capture, finishes the recording with its last frame held until the moment capture
 * stopped, and reports. Each frame is checked against the media protocol's bounds and clock rules before it is sent:
 * whole microseconds from 0, on the recording's clock, never earlier than the frame before, within the recording's
 * longest duration of its first frame, at most `MAX_FRAME_BYTES`, and from the source's own session. Every wait is
 * bounded, nothing throws, whatever the source does, and a failure is in the report.
 *
 * @example const report = await recordSource(page.frameSource(identity), media, { recordingId, output, width: 1280, height: 720, fps: 10, deadlineMs: 20_000, clock, startTimeoutMs: 5000, stopTimeoutMs: 2000, finishTimeoutMs: 25_000, signal })
 */
export async function recordSource(source: FrameSource, media: MediaRecorder, options: RecordSourceOptions): Promise<SourceRecording> {
  const report = { source: source.name, identity: source.identity, frames: emptyTally(), problems: [] as string[] }
  if (options.finishTimeoutMs < options.deadlineMs) {
    return final({ ...report, status: 'not_started', reason: `finishTimeoutMs (${options.finishTimeoutMs} ms) is shorter than deadlineMs (${options.deadlineMs} ms), so the wait could end while the process is still finishing the video.` })
  }
  const availability = attempt(() => source.availability(), (problem): CaptureAvailability => ({ available: false, reason: `The ${source.name} source could not say whether it can capture: ${problem}` }))
  if (!availability.available) return final({ ...report, status: 'unavailable', reason: availability.reason })
  const maxDurationMs = options.limits?.maxDurationMs ?? defaultMaxDurationMs
  const start: StartRecording = {
    recordingId: options.recordingId,
    width: options.width,
    height: options.height,
    fps: options.fps,
    output: options.output,
    deadlineMs: options.deadlineMs,
    ...options.limits,
    maxDurationMs,
    maxGapMs: options.limits?.maxGapMs ?? maxDurationMs,
  }
  let begun: Awaited<ReturnType<MediaRecorder['record']>>
  try {
    begun = await media.record(start, options.startTimeoutMs)
  } catch (error) {
    return final({ ...report, status: 'not_started', reason: `The media process started no recording: ${errorMessage(error)}` })
  }
  if (begun.kind === 'ended') return final({ ...report, status: 'not_started', reason: begun.ended.message, ended: begun.ended })
  const { recording } = begun
  const recorded = { ...report, started: recording.started }
  const sender = new FrameSender({ identity: source.identity, recording, tally: report.frames, clock: options.clock, startUs: options.clock() })
  const stopping = Promise.withResolvers<'signal' | 'source' | 'recording'>()
  const onAbort = (): void => stopping.resolve('signal')
  options.signal.addEventListener('abort', onAbort, { once: true })
  if (options.signal.aborted) stopping.resolve('signal')
  const recordingOver = (): void => stopping.resolve('recording')
  recording.ended.then(recordingOver, recordingOver)
  const capture: StartCapture = { fps: options.fps, clock: options.clock, deliver: (frame) => sender.send(frame), ended: () => stopping.resolve('source'), timeoutMs: options.startTimeoutMs }
  const failedStart = (problem: string): CaptureStart => ({ ok: false, reason: `The ${source.name} capture failed to start: ${problem}` })
  const starting = attempt(() => source.start(capture), (problem) => Promise.resolve(failedStart(problem))).catch((error: unknown) => failedStart(errorMessage(error)))
  const begin = await within(starting, options.startTimeoutMs)
  if (begin === undefined || !begin.ok) {
    // Nothing the source delivers from now on is recorded, so an unavailable capture never leaves a video behind.
    sender.close()
    options.signal.removeEventListener('abort', onAbort)
    const reason = begin === undefined ? `The ${source.name} capture did not start within ${options.startTimeoutMs} ms.` : begin.reason
    // A start that answers late must not leave a capture running that nobody stops.
    const stats = await stopCapture(source, options.stopTimeoutMs, report.problems)
    const finished = await finishRecording(recording, options, undefined)
    sender.detach()
    return final({ ...recorded, ...finished, status: 'unavailable', reason, ...(stats === undefined ? {} : { capture: stats }) })
  }
  sender.open()
  const stoppedBy = await stopping.promise
  options.signal.removeEventListener('abort', onAbort)
  const stats = await stopCapture(source, options.stopTimeoutMs, report.problems)
  sender.close()
  const finished = await finishRecording(recording, options, sender.endTimestamp(options.clock()))
  sender.detach()
  return final({ ...recorded, ...finished, stoppedBy, ...(stats === undefined ? {} : { capture: stats }) })
}

// Stops a capture within its time, whatever the source does; one that does not answer in time, or fails, is named.
async function stopCapture(source: FrameSource, timeoutMs: number, problems: string[]): Promise<CaptureStats | undefined> {
  let failed: string | undefined
  const stopping = attempt<Promise<CaptureStats | undefined>>(
    () => source.stop(timeoutMs),
    (problem) => {
      failed = problem
      return Promise.resolve(undefined)
    },
  )
  const stopped = await within(
    stopping.catch((error: unknown) => {
      failed = errorMessage(error)
      return undefined
    }),
    timeoutMs,
  )
  if (failed !== undefined) problems.push(`Stopping the ${source.name} capture failed: ${failed}`)
  else if (stopped === undefined) problems.push(`The ${source.name} capture did not stop within ${timeoutMs} ms; nothing it delivers after this is recorded or counted.`)
  return stopped
}

// Finishes a recording and waits for its ending; a recording the process ended already answers with that ending.
async function finishRecording(recording: RecordingTarget, options: RecordSourceOptions, endTimestampUs: number | undefined): Promise<{ status: 'ended'; ended: Ended } | { status: 'lost'; reason: string }> {
  try {
    const ended = await recording.finish(options.finishTimeoutMs, endTimestampUs)
    return { status: 'ended', ended }
  } catch (error) {
    return { status: 'lost', reason: errorMessage(error) }
  }
}

type SenderOptions = { identity: RecordIdentity; recording: RecordingTarget; tally: FrameTally; clock: () => number; startUs: number }

/**
 * Sends a source's frames to one recording, refusing what the media process would refuse or what would end it, and
 * counts each frame once. Frames wait until the capture's start answers: `open` sends them, and `close` counts them as
 * not sent, as it does every frame after it. After `detach`, frames are not counted at all: the report is final.
 */
class FrameSender {
  readonly #options: SenderOptions
  readonly #held: CapturedFrame[] = []
  #state: 'waiting' | 'open' | 'closed' | 'detached' = 'waiting'
  #firstUs: number | undefined
  #lastUs: number | undefined

  constructor(options: SenderOptions) {
    this.#options = options
  }

  send(frame: CapturedFrame): void {
    if (this.#state === 'detached') return
    const { tally } = this.#options
    tally.delivered += 1
    const refusal = this.#refusal(frame)
    if (refusal !== undefined) {
      tally.refused[refusal] += 1
      return
    }
    if (this.#state === 'closed') {
      tally.notSent += 1
      return
    }
    this.#firstUs ??= frame.timestampUs
    this.#lastUs = frame.timestampUs
    if (this.#state === 'open') return this.#forward(frame)
    this.#held.push(frame)
    if (this.#held.length > heldFrames) {
      this.#held.shift()
      tally.notSent += 1
    }
  }

  open(): void {
    if (this.#state !== 'waiting') return
    this.#state = 'open'
    for (const frame of this.#held.splice(0)) this.#forward(frame)
  }

  close(): void {
    if (this.#state === 'detached') return
    this.#options.tally.notSent += this.#held.splice(0).length
    this.#state = 'closed'
  }

  detach(): void {
    this.close()
    this.#state = 'detached'
  }

  // The moment the last frame is held until: when capture stopped, never before the last frame sent.
  endTimestamp(nowUs: number): number | undefined {
    if (!Number.isSafeInteger(nowUs) || nowUs < 0) return undefined
    return this.#lastUs === undefined || nowUs >= this.#lastUs ? nowUs : undefined
  }

  #forward(frame: CapturedFrame): void {
    this.#count(this.#options.recording.frame({ timestampUs: frame.timestampUs, format: frame.format, bytes: frame.bytes }))
  }

  #refusal(frame: CapturedFrame): keyof RefusedFrames | undefined {
    const { identity, recording, clock, startUs } = this.#options
    if (!sameSession(frame.identity, identity)) return 'identity'
    if (!Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0) return 'timestamp'
    // A frame reached Retest before it is delivered and after capture was asked to start; one stamped otherwise was
    // stamped on another clock, however orderly its own timestamps are.
    if (frame.timestampUs > clock() || frame.timestampUs < startUs) return 'clock'
    if (frame.bytes.byteLength === 0) return 'empty'
    if (frame.bytes.byteLength > MAX_FRAME_BYTES) return 'tooLarge'
    if (this.#lastUs !== undefined && frame.timestampUs < this.#lastUs) return 'outOfOrder'
    if (this.#firstUs !== undefined && frame.timestampUs - this.#firstUs > recording.started.maxDurationMs * 1000) return 'outOfRange'
    return undefined
  }

  #count(outcome: FrameOutcome): void {
    const { tally } = this.#options
    if (outcome === 'sent') tally.sent += 1
    else if (outcome === 'dropped') tally.dropped += 1
    else tally.notSent += 1
  }
}

// A frame belongs to its source's session when it names the same test, attempt, app and session; each look the parent
// serves has its own id, so the look may differ from frame to frame.
function sameSession(frame: RecordIdentity, source: RecordIdentity): boolean {
  return frame.testId === source.testId && frame.attemptId === source.attemptId && frame.app === source.app && frame.sessionId === source.sessionId
}

function emptyTally(): FrameTally {
  return { delivered: 0, sent: 0, dropped: 0, notSent: 0, refused: { identity: 0, timestamp: 0, clock: 0, outOfOrder: 0, outOfRange: 0, tooLarge: 0, empty: 0 } }
}

// A copy of the report that nothing changes after it is returned, however late a source delivers.
function final(report: SourceRecording): SourceRecording {
  const frames = Object.freeze({ ...report.frames, refused: Object.freeze({ ...report.frames.refused }) })
  return Object.freeze({ ...report, frames, problems: Object.freeze([...report.problems]) })
}

// Calls a source's method, and turns a synchronous throw into the value `failed` makes of its message.
function attempt<T>(call: () => T, failed: (problem: string) => T): T {
  try {
    return call()
  } catch (error) {
    return failed(errorMessage(error))
  }
}

// Settles with the promise's value, or with undefined once `timeoutMs` passes first.
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, undefined)
  })
  try {
    return await Promise.race([promise, late])
  } finally {
    clearTimeout(timer)
  }
}
