import type { Clock } from '../protocol/deadline.ts'
import type { CaptureSourceName, RecordIdentity } from '../protocol/identity.ts'
import type { CaptureGap, Ended, Frame, FrameFormat, FrameOutcome, Recording, RecordingIdentity, StartRecording, Started } from './client.ts'
import { waitBeforeRead } from '../assertions/wait-before-read.ts'
import { Deadline, monotonicClock } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { MAX_FRAME_BYTES, MAX_FRAME_ID_CHARACTERS } from './client.ts'

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
export type CapturedFrame = { readonly identity: RecordIdentity; readonly timestampUs: number; readonly earliestUs?: number; readonly format: FrameFormat; readonly bytes: Uint8Array }

/**
 * Frames use host arrival time. A target clock is never silently substituted for the run clock. Screencasts bound
 * each read by the previous acknowledgement, or the capture start for the first frame; screenshot loops use the request.
 */
export type CaptureClockMapping = { readonly timestamp: 'run-arrival'; readonly targetClock: 'not-used'; readonly imageRead: 'request-to-arrival' | 'since-start' | 'previous-delivery-to-arrival' | 'previous-acknowledgement-to-arrival' }

/** Whether a source can capture, and how; or why it cannot, in words a report can show. */
export type CaptureAvailability = { readonly available: true; readonly mode: CaptureMode } | { readonly available: false; readonly reason: string }

/** How a start went: capture runs, in the mode named, or it never began, and why. */
export type CaptureStart = { readonly ok: true; readonly mode: CaptureMode } | { readonly ok: false; readonly reason: string }

/**
 * Why capture handed over nothing of what the target showed for a stretch of the run's clock, as a code the media
 * process keeps beside the recording. `capture_failed`: the source asked for captures and the target failed them.
 * `target_lost`: the target stopped answering or went away before capture stopped. `pixels_withheld`: the pixel capture
 * policy suspended the recording, so frames that came were withheld, never sent.
 */
export type CaptureGapReason = 'capture_failed' | 'target_lost' | 'pixels_withheld'

/** A stretch of the run's clock, in whole microseconds, in which capture handed over no frame, and why. */
export type SourceGap = { readonly fromUs: number; readonly toUs: number; readonly reason: CaptureGapReason }

/**
 * What a capture is started with. `fps` is the most frames a second the caller wants handed over; a source may hand
 * over fewer, and says how many it did. `clock` is the run's clock in whole microseconds, which stamps every frame.
 * `deliver` takes each frame as it comes, in order, and must not wait. `ended` is told once, with the reason, when
 * capture stops before `stop` is asked, as when the page closes. `timeoutMs` bounds the start. `gap`, when given, is
 * told of a stretch in which the source knows it captured nothing it could hand over, such as captures the target
 * failed one after another, on the same clock as the frames; a source never reports a quiet page as a gap.
 * `withheld`, when given, says whether frames are being withheld now; a source that asks for each capture may skip
 * asking while it says so, since nothing it took would be kept. `onWithholdingChange` lets pushed sources stop
 * immediately when a stretch opens and restart only once it closes.
 */
export type StartCapture = {
  readonly fps: number
  readonly clock: () => number
  readonly deliver: (frame: CapturedFrame) => void
  readonly ended: (reason: string) => void
  readonly timeoutMs: number
  readonly gap?: (gap: SourceGap) => void
  readonly withheld?: () => boolean
  readonly onWithholdingChange?: (listener: (withheld: boolean) => void) => () => void
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
 * target refused, oldest first and at most a few. For a screenshot loop, `withheldTicks` counts the ticks on which no
 * capture was asked because frames were being withheld, and `captureMs` how long the captures it asked for took to
 * come back, answered or failed, which bounds where in that time the screen it shows was read.
 */
export type CaptureStats = {
  readonly mode: CaptureMode
  readonly requestedFps: number
  readonly delivered: number
  readonly superseded: number
  readonly dropped: number
  readonly skippedTicks?: number
  readonly withheldTicks?: number
  readonly captureMs?: CaptureLatency
  readonly clockMapping?: CaptureClockMapping
  readonly startedAtUs?: number
  readonly stoppedAtUs?: number
  readonly achievedFps?: number
  readonly firstTimestampUs?: number
  readonly lastTimestampUs?: number
  readonly endedEarly?: string
  readonly problems: readonly string[]
}

/** How long captures took, in milliseconds rounded to a tenth: how many, the shortest, the mean and the longest. */
export type CaptureLatency = { readonly count: number; readonly minMs: number; readonly meanMs: number; readonly maxMs: number }

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
 * - A stretch in which the source knows it captured nothing it could hand over, such as captures the target failed,
 *   goes to `gap` when the start gave one, with its reason; a page that did not change is never a gap.
 * - `stop` resolves within its `timeoutMs`, whatever the target does, and is safe to call more than once and before
 *   `start`. Every frame that arrives before it resolves is counted, delivered or not, and nothing is delivered after.
 * - The source changes nothing in the app: capturing sends no input.
 *
 * A native session's source is a `screenshot-loop`, named by the capture source it uses
 * (`executor-screen`, `simulator-display` or `window-crop`, as `captureSources` lists them for its platform), never as
 * a live stream. A frame's `observationId` is the look id `RunningTest` gave that capture when it served it to the test
 * file's process, or none; never the `reference.observationId` the native session numbers for itself, which restarts
 * with each session object and names a different look. Its timestamp is when the image reached the source. Executor
 * and checked window captures take their turn through `NativeAppSession.capture`; direct simulator display captures
 * run outside that queue. A tick while an earlier grab is still pending counts in `skippedTicks`, never as a frame.
 * A capture that fails is counted in `dropped` with its failure among `problems`; loss of the session or its original
 * app launch ends capture with `ended`. Pixels are not redacted:
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

/**
 * One capture a screenshot loop asked for: the image exactly as the target encoded it, or why there is none. `lost`
 * says the target is gone, or is no longer the session the source names, which ends capture with `problem` as its
 * reason; any other failure is one capture that failed.
 */
export type GrabbedImage = { readonly ok: true; readonly format: FrameFormat; readonly bytes: Uint8Array } | { readonly ok: false; readonly problem: string; readonly lost?: true; readonly withheld?: true; readonly retryAtStart?: true }

/**
 * What a screenshot loop is made of. `unavailable` says at once, sending nothing, why the target cannot be captured now,
 * or undefined when it can. `grab` asks the target for one capture within `timeoutMs`, gives it up when `signal`
 * aborts, and never throws for the target's own problem. A completed read timeout may set `retryAtStart` to let startup
 * ask again within its original budget; a grab that has not settled or a privacy refusal never sets it. `onLost`, when the target
 * can say it went away, calls its listener once with the reason and returns a function that stops listening. `grabTimeoutMs` bounds each capture.
 * `captureCommandMs`, when given, is how much of a capture's time goes to its commands, and a start asks again only
 * with a whole capture's time or while the next capture's commands would get at least twice the start's longest capture.
 */
export type ScreenshotLoopOptions = {
  readonly name: CaptureSourceName
  readonly identity: RecordIdentity
  readonly unavailable: () => string | undefined
  readonly grab: (timeoutMs: number, signal: AbortSignal, withheld: () => boolean) => Promise<GrabbedImage>
  readonly onLost?: (listener: (reason: string) => void) => () => void
  readonly grabTimeoutMs: number
  readonly captureCommandMs?: (timeoutMs: number) => number
}

type LoopState = 'idle' | 'starting' | 'running' | 'stopping' | 'ended' | 'stopped'

/**
 * A `screenshot-loop` source: it asks the target for one capture at a time, at most `fps` a second, and hands over each
 * image as the target encoded it, stamped with the run's clock when the capture came back. `earliestUs` is when it was requested. It is not a live stream: the
 * screen between two captures is never seen, and a capture shows the screen at some moment between when it was asked
 * for and when it came back (`captureMs` in its stats). A capture is asked for on each tick of the cadence; when one
 * takes longer than a tick, the next is asked for as soon as it comes back, and each tick that passed wholly while it
 * was out is counted in `skippedTicks`, never as a frame. While frames are withheld, no capture is asked for and the
 * tick is counted in `withheldTicks`.
 *
 * `start` asks for the first capture and answers `ok` only once it came back with an image, unless pixels are withheld.
 * A completed read timeout marked `retryAtStart` may be read again within the original start budget, as long as
 * `captureCommandMs` allows; once it does not, the start fails with that capture's problem. Its dropped
 * observation, problem and failed stretch remain. A grab that has not settled ends the source without another request.
 * A withheld start asks for no pixels and waits on its cadence until the policy resumes. A target that cannot be
 * captured never starts an empty loop that looks like a working one; that first image is the first frame. A capture
 * that fails is counted in `dropped` with its failure among `problems`, and a run of failed captures is reported as a
 * `capture_failed` gap, from when the first was asked for to when the last came back. A capture that says the target
 * is lost, or the target telling `onLost`, ends capture with that reason. `stop` waits for a capture still out for at
 * most its time, hands over its image if it comes back first, then gives it up; nothing is handed over after.
 *
 * @example const source = new ScreenshotLoopSource({ name: 'simulator-display', identity, unavailable: () => undefined, grab, grabTimeoutMs: 5000 })
 */
export class ScreenshotLoopSource implements FrameSource {
  readonly name: CaptureSourceName
  readonly identity: RecordIdentity
  readonly #options: ScreenshotLoopOptions
  readonly #problems: string[] = []
  readonly #listeners: (() => void)[] = []
  readonly #giveUp = new AbortController()
  #state: LoopState = 'idle'
  #capture: StartCapture | undefined
  #intervalUs = 0
  #delivered = 0
  #dropped = 0
  #skippedTicks = 0
  #withheldTicks = 0
  #withholdingEpoch = 0
  #withheldFromUs: number | undefined
  #startedAtUs: number | undefined
  #stoppedAtUs: number | undefined
  #firstUs: number | undefined
  #lastUs: number | undefined
  // When the capture now out, or the last one, was asked for, on the run's clock.
  #askedUs: number | undefined
  #inFlight: Promise<void> | undefined
  #timer: NodeJS.Timeout | undefined
  #failingSinceUs: number | undefined
  #failedUntilUs: number | undefined
  #latency = { count: 0, totalMs: 0, minMs: Number.POSITIVE_INFINITY, maxMs: 0 }
  #endedEarly: string | undefined
  #stopping: Promise<CaptureStats> | undefined

  constructor(options: ScreenshotLoopOptions) {
    this.name = options.name
    this.identity = options.identity
    this.#options = options
  }

  availability(): CaptureAvailability {
    const reason = this.#options.unavailable()
    return reason === undefined ? { available: true, mode: 'screenshot-loop' } : { available: false, reason }
  }

  async start(capture: StartCapture): Promise<CaptureStart> {
    if (this.#state !== 'idle') return { ok: false, reason: 'This capture has started before; a source captures once.' }
    const unavailable = this.#options.unavailable()
    if (unavailable !== undefined) return { ok: false, reason: unavailable }
    if (!Number.isFinite(capture.fps) || capture.fps <= 0) return { ok: false, reason: `A capture needs a cadence above 0 frames a second, not ${capture.fps}.` }
    const deadline = new Deadline(capture.timeoutMs, { signal: this.#giveUp.signal })
    this.#state = 'starting'
    this.#capture = capture
    this.#intervalUs = Math.round(1_000_000 / capture.fps)
    this.#startedAtUs = capture.clock()
    if (capture.onWithholdingChange !== undefined) this.#listeners.push(capture.onWithholdingChange((held) => this.#withholding(held)))
    if (this.#options.onLost !== undefined) this.#listeners.push(this.#options.onLost((reason) => this.#end(reason)))
    if (capture.withheld?.() === true) {
      this.#withholding(true)
      this.#state = 'running'
      this.#withheldTicks += 1
      this.#askedUs = this.#startedAtUs
      this.#schedule()
      return { ok: true, mode: 'screenshot-loop' }
    }
    let first = await this.#grab(Math.min(capture.timeoutMs, this.#options.grabTimeoutMs))
    while (this.#state === 'starting' && !first.ok && first.retryAtStart === true && this.#mayAskAgain(deadline)) {
      try { await waitBeforeRead(deadline, Math.min(100, this.#intervalUs / 1000)) }
      catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error
        break
      }
      if (this.#state !== 'starting' || !this.#mayAskAgain(deadline)) break
      first = await this.#grab(Math.min(deadline.remainingMs, this.#options.grabTimeoutMs))
    }
    if (this.#state !== 'starting') return { ok: false, reason: this.#endedEarly ?? 'The capture was stopped before it started.' }
    if (!first.ok && first.withheld !== true) {
      // A loop that never began has no stretch to report: its failure is the start's answer.
      this.#failingSinceUs = undefined
      this.#stoppedAtUs = capture.clock()
      this.#release('stopped')
      return { ok: false, reason: `The first ${this.name} capture failed: ${first.problem}` }
    }
    this.#state = 'running'
    this.#schedule()
    return { ok: true, mode: 'screenshot-loop' }
  }

  // Whether a start with `deadline` left asks again. With less than a whole capture's time, its commands must get twice
  // the start's longest capture, as one macOS window capture took twice another (1.2 and 2.6 s); less may cut it short.
  #mayAskAgain(deadline: Deadline): boolean {
    if (deadline.expired) return false
    const commandMs = this.#options.captureCommandMs
    const timeoutMs = Math.min(deadline.remainingMs, this.#options.grabTimeoutMs)
    return commandMs === undefined || timeoutMs >= this.#options.grabTimeoutMs || commandMs(timeoutMs) >= 2 * this.#latency.maxMs
  }

  stop(timeoutMs: number): Promise<CaptureStats> {
    this.#stopping ??= this.#stop(timeoutMs)
    return this.#stopping
  }

  async #stop(timeoutMs: number): Promise<CaptureStats> {
    if (this.#state !== 'starting' && this.#state !== 'running') {
      if (this.#state === 'idle') this.#state = 'stopped'
      return this.#stats()
    }
    this.#state = 'stopping'
    this.#clearTimer()
    const out = this.#inFlight
    if (out !== undefined && !(await settledWithin(out, timeoutMs))) this.#problem(`A ${this.name} capture was still out when the stop's ${timeoutMs} ms were up; it was given up, and nothing it brings back is handed over.`)
    if (this.#state === 'stopping') {
      this.#stoppedAtUs = this.#capture?.clock()
      this.#release('stopped')
    }
    return this.#stats()
  }

  // Asks for the next capture on the next tick, or at once when that tick has passed.
  #schedule(): void {
    if (this.#state !== 'running' || this.#capture === undefined) return
    const now = this.#capture.clock()
    const due = (this.#askedUs ?? now) + this.#intervalUs
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#tick()
    }, Math.max(0, Math.ceil((due - now) / 1000)))
    // Capture never keeps the process alive on its own.
    this.#timer.unref()
  }

  #tick(): void {
    const capture = this.#capture
    if (this.#state !== 'running' || capture === undefined) return
    const unavailable = this.#options.unavailable()
    if (unavailable !== undefined) return this.#end(unavailable)
    if (capture.withheld?.() === true) {
      this.#withholding(true)
      this.#withheldTicks += 1
      this.#askedUs = capture.clock()
      this.#schedule()
      return
    }
    this.#withholding(false)
    void this.#grab(this.#options.grabTimeoutMs).then(() => this.#schedule())
  }

  // Asks for one capture and hands over what it brings back while capture runs; the answer says whether it was an image.
  async #grab(timeoutMs: number): Promise<GrabbedImage> {
    const capture = this.#capture
    if (capture === undefined) return { ok: false, problem: 'The capture has not started.' }
    const askedUs = capture.clock()
    const epoch = this.#withholdingEpoch
    const withheld = (): boolean => capture.withheld?.() === true || epoch !== this.#withholdingEpoch
    if (this.#askedUs !== undefined && askedUs - this.#askedUs > this.#intervalUs) this.#skippedTicks += Math.floor((askedUs - this.#askedUs) / this.#intervalUs) - 1
    this.#askedUs = askedUs
    const started = performance.now()
    const settled = Promise.withResolvers<void>()
    this.#inFlight = settled.promise
    let image: GrabbedImage
    const gaveUp = new AbortController()
    const cancelled = Promise.withResolvers<GrabbedImage>()
    const onStop = (): void => cancelled.resolve({ ok: false, problem: `The ${this.name} capture was stopped.` })
    this.#giveUp.signal.addEventListener('abort', onStop, { once: true })
    if (this.#giveUp.signal.aborted) onStop()
    try {
      const grabbing = Promise.race([this.#options.grab(timeoutMs, AbortSignal.any([this.#giveUp.signal, gaveUp.signal]), withheld), cancelled.promise])
      const answer = await within(grabbing, timeoutMs)
      if (answer === undefined) {
        gaveUp.abort()
        image = { ok: false, problem: `The ${this.name} capture did not answer within ${timeoutMs} ms; no further capture is requested.`, lost: true }
      } else image = answer
    } catch (error) {
      image = { ok: false, problem: errorMessage(error) }
    } finally {
      this.#giveUp.signal.removeEventListener('abort', onStop)
      this.#inFlight = undefined
      settled.resolve()
    }
    this.#timed(performance.now() - started)
    const answeredUs = capture.clock()
    if (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping') return image
    if ((image.ok && withheld()) || (!image.ok && image.withheld === true)) {
      this.#withheldTicks += 1
      try { capture.gap?.({ fromUs: askedUs, toUs: answeredUs, reason: 'pixels_withheld' }) }
      catch (error) { this.#problem('Reporting withheld pixels failed: ' + errorMessage(error)) }
      return { ok: false, problem: 'The capture overlapped a withheld stretch; no image was handed over.', withheld: true }
    }
    if (image.ok && image.bytes.byteLength > 0) {
      this.#recovered()
      this.#handOver({ identity: this.identity, timestampUs: answeredUs, earliestUs: askedUs, format: image.format, bytes: image.bytes })
      return image
    }
    if (!image.ok && image.lost === true) {
      this.#end(image.problem)
      return image
    }
    this.#dropped += 1
    const problem = image.ok ? `The ${this.name} capture came back with no image in it.` : image.problem
    this.#problem(problem)
    this.#failingSinceUs ??= askedUs
    this.#failedUntilUs = answeredUs
    return image.ok ? { ok: false, problem } : image
  }

  #withholding(held: boolean): void {
    const capture = this.#capture
    if (capture === undefined) return
    if (held) {
      if (this.#withheldFromUs === undefined) {
        this.#withholdingEpoch += 1
        this.#withheldFromUs = capture.clock()
      }
      return
    }
    if (this.#withheldFromUs === undefined) return
    const fromUs = this.#withheldFromUs
    this.#withheldFromUs = undefined
    try { capture.gap?.({ fromUs, toUs: capture.clock(), reason: 'pixels_withheld' }) }
    catch (error) { this.#problem('Reporting withheld pixels failed: ' + errorMessage(error)) }
  }

  #handOver(frame: CapturedFrame): void {
    try {
      this.#capture?.deliver(frame)
      this.#delivered += 1
      this.#firstUs ??= frame.timestampUs
      this.#lastUs = frame.timestampUs
    } catch (error) {
      this.#dropped += 1
      this.#problem(`Taking a frame failed: ${errorMessage(error)}`)
    }
  }

  // A run of failed captures ends: it is the stretch from when the first was asked for to when the last came back.
  #recovered(): void {
    const fromUs = this.#failingSinceUs
    const toUs = this.#failedUntilUs
    this.#failingSinceUs = undefined
    this.#failedUntilUs = undefined
    if (fromUs === undefined || toUs === undefined) return
    try {
      this.#capture?.gap?.({ fromUs, toUs, reason: 'capture_failed' })
    } catch (error) {
      this.#problem(`Reporting a stretch of failed captures failed: ${errorMessage(error)}`)
    }
  }

  #end(reason: string): void {
    if (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping') return
    this.#stoppedAtUs = this.#capture?.clock()
    this.#endedEarly = `The ${this.name} capture's target ended: ${reason}`
    const fromUs = this.#lastUs ?? this.#startedAtUs
    if (fromUs !== undefined && this.#stoppedAtUs !== undefined) {
      try { this.#capture?.gap?.({ fromUs, toUs: this.#stoppedAtUs, reason: 'target_lost' }) }
      catch (error) { this.#problem(`Reporting the lost target failed: ${errorMessage(error)}`) }
    }
    this.#release('ended')
    this.#capture?.ended(this.#endedEarly)
  }

  #release(state: 'ended' | 'stopped'): void {
    this.#withholding(false)
    this.#recovered()
    this.#state = state
    this.#clearTimer()
    this.#giveUp.abort()
    for (const stop of this.#listeners.splice(0)) stop()
  }

  #clearTimer(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #timed(milliseconds: number): void {
    const latency = this.#latency
    latency.count += 1
    latency.totalMs += milliseconds
    latency.minMs = Math.min(latency.minMs, milliseconds)
    latency.maxMs = Math.max(latency.maxMs, milliseconds)
  }

  #problem(problem: string): void {
    if (this.#problems.length < keptProblems) this.#problems.push(problem)
  }

  #stats(): CaptureStats {
    const started = this.#startedAtUs
    const stopped = this.#stoppedAtUs
    const span = started === undefined || stopped === undefined ? 0 : stopped - started
    const achievedFps = span > 0 ? Math.round((this.#delivered / (span / 1_000_000)) * 100) / 100 : undefined
    const { count, totalMs, minMs, maxMs } = this.#latency
    const tenth = (value: number): number => Math.round(value * 10) / 10
    return {
      mode: 'screenshot-loop',
      requestedFps: this.#capture?.fps ?? 0,
      delivered: this.#delivered,
      superseded: 0,
      dropped: this.#dropped,
      skippedTicks: this.#skippedTicks,
      withheldTicks: this.#withheldTicks,
      clockMapping: { timestamp: 'run-arrival', targetClock: 'not-used', imageRead: 'request-to-arrival' },
      ...(count === 0 ? {} : { captureMs: { count, minMs: tenth(minMs), meanMs: tenth(totalMs / count), maxMs: tenth(maxMs) } }),
      ...(started === undefined ? {} : { startedAtUs: started }),
      ...(stopped === undefined ? {} : { stoppedAtUs: stopped }),
      ...(achievedFps === undefined ? {} : { achievedFps }),
      ...(this.#firstUs === undefined ? {} : { firstTimestampUs: this.#firstUs }),
      ...(this.#lastUs === undefined ? {} : { lastTimestampUs: this.#lastUs }),
      ...(this.#endedEarly === undefined ? {} : { endedEarly: this.#endedEarly }),
      problems: [...this.#problems],
    }
  }
}

/** What `recordSource` needs of a recording: the process's start reply, its one ending, frames, capture gaps and the finish. */
export type RecordingTarget = Pick<Recording, 'started' | 'ended' | 'frame' | 'captureGap' | 'finish'>

/** What `recordSource` needs of the media process: to start a recording. `MediaProcess` is one. */
export type MediaRecorder = {
  record(start: StartRecording, timeoutMs: number): Promise<{ kind: 'started'; recording: RecordingTarget } | { kind: 'ended'; ended: Ended }>
}

/**
 * How one source is to be recorded. `recordingId`, `output`, `width`, `height`, `fps` and `deadlineMs` go to the media
 * process's start, as `StartRecording` describes them, and `limits` with them when given; `fps` is also the cadence the
 * source is asked for. `runId` names the run, and with the source's own test, attempt, app and session it is the
 * recording's identity, which the process writes beside the video. A still page sends no frames, so unless
 * `limits.maxGapMs` says otherwise the gap the video may hold a frame for is the recording's whole longest duration,
 * and the video shows the page for as long as it stood still; a shorter `maxGapMs` shortens longer gaps, which
 * `ended.gaps` lists. `clock` is the run's clock in whole microseconds. `startTimeoutMs` bounds starting the recording
 * and the capture, each; `stopTimeoutMs` bounds stopping the capture; `finishTimeoutMs` bounds waiting for the
 * recording's ending once it is finished, and may not be shorter than `deadlineMs`. Aborting `signal` stops capture,
 * and the recording is finished with the frames that came; a `signal` already aborted starts nothing. `suspension`,
 * when given, is how the pixel capture policy withholds frames from this recording for a while.
 */
export type RecordSourceOptions = {
  readonly recordingId: string
  readonly runId: string
  readonly output: string
  readonly width: number
  readonly height: number
  readonly fps: number
  readonly deadlineMs: number
  readonly limits?: Pick<StartRecording, 'queueFrames' | 'queueBytes' | 'maxGapMs' | 'maxDurationMs' | 'stallMs' | 'keepFrames' | 'frameStoreBytes' | 'encodedFormat'>
  readonly clock: () => number
  readonly startTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly finishTimeoutMs: number
  readonly signal: AbortSignal
  readonly suspension?: CaptureSuspension
}

/**
 * Withholds a source's frames from its recording while suspended, as the pixel capture policy decides; the policy, not
 * text redaction, decides which pixels are kept. While suspended, every frame the source delivers is counted as
 * withheld and never sent, and a frame stamped inside a suspended stretch stays withheld however late it comes. Each
 * stretch, from the suspend to the resume or to the end of capture, reaches the recording as a capture gap with the
 * reason `pixels_withheld`, so the video and its frame map say that frames were held back there, never that nothing
 * appeared. Suspending twice or resuming twice changes nothing. One suspension may serve one recording at a time.
 *
 * @example const suspension = new CaptureSuspension(); recordSource(source, media, { ...options, suspension }); suspension.suspend()
 */
export class CaptureSuspension {
  #suspended = false
  readonly #listeners = new Set<(suspended: boolean) => void>()

  /** Whether frames are being withheld now. */
  get suspended(): boolean {
    return this.#suspended
  }

  /** Withholds every frame from now until `resume`. */
  suspend(): void {
    if (this.#suspended) return
    this.#suspended = true
    for (const listener of this.#listeners) listener(true)
  }

  /** Lets frames through again from now. */
  resume(): void {
    if (!this.#suspended) return
    this.#suspended = false
    for (const listener of this.#listeners) listener(false)
  }

  /** Calls `listener` on every change until the returned function is called. `recordSource` is the one listener. */
  listen(listener: (suspended: boolean) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
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
 * over or its process gone; `withheld` because the pixel capture policy had suspended the recording, which is not a
 * loss of the capture; or refused, by reason. `delivered` is the sum of the rest. What reached the process is its own
 * `ended.frames.received`. Each frame is sent with a frame id, its place in the order the source delivered it from 1,
 * so a frame id missing from the recording's frame map is a frame counted here.
 */
export type FrameTally = { delivered: number; sent: number; dropped: number; notSent: number; withheld: number; refused: RefusedFrames }

/**
 * Every stretch without frames that reached the recording or was meant to: `reported` by the source or closed by the
 * suspension; `sent` to the media process as a capture gap; `notSent` because capture had not begun, more were held
 * than are kept, or the recording was finishing, over or its process gone; `refused` because the stretch was not whole
 * microseconds in order on the recording's clock, or its reason was not a code. `withheldStretches` counts the
 * suspensions among them and `withheldUs` their length in all, each from the suspend to the resume or the end of
 * capture.
 */
export type GapTally = { reported: number; sent: number; notSent: number; refused: number; withheldStretches: number; withheldUs: number }

/** A value nothing can change: every object and array in it is read only, as a frozen report holds it. */
export type Frozen<T> = T extends readonly (infer Item)[] ? readonly Frozen<Item>[] : T extends object ? { readonly [Key in keyof T]: Frozen<T[Key]> } : T

/**
 * How recording a source went, as it stood when `recordSource` returned. The report is frozen all the way down and
 * shares no object with the source, the recording or the caller, and frames a source delivers afterwards are counted
 * nowhere. `status`: `unavailable`, the source could not capture, and `reason` says why; `not_started`, no recording
 * was started, and `reason` or `ended` says why; `ended`, the process sent the recording's one ending, `ended`, whose
 * own status says whether a video was written; `lost`, no ending came, as when the process died or the finish outlasted
 * its time, and `reason` says which. `stoppedBy` says what ended capture, or kept it from starting: the caller's
 * `signal`, the `source` ending on its own, or the `recording` ending first. A signal that had aborted before anything
 * started starts nothing; one that aborts while the process starts the recording starts no capture, and the empty
 * recording is finished. `started` is the process's start reply and `capture` the source's own count, each when there
 * was one. `gaps` counts the stretches without frames, as `GapTally` says. `problems` names what went wrong around the
 * recording without changing its status, such as a capture that did not stop in time, or a recording lost as it was
 * finished after its capture failed to start.
 */
export type SourceRecording = {
  readonly source: CaptureSourceName
  readonly identity: Frozen<RecordIdentity>
  readonly status: 'unavailable' | 'not_started' | 'ended' | 'lost'
  readonly reason?: string
  readonly stoppedBy?: 'signal' | 'source' | 'recording'
  readonly started?: Frozen<Started>
  readonly capture?: Frozen<CaptureStats>
  readonly ended?: Frozen<Ended>
  readonly frames: Frozen<FrameTally>
  readonly gaps: Frozen<GapTally>
  readonly problems: readonly string[]
}

// The media process's own longest recording when a start names none, as `StartRecording` documents it.
const defaultMaxDurationMs = 30 * 60 * 1000
// Frames held while a capture's start has not answered. Chrome sends one when its screencast starts, which can come
// before the start's answer; more than a few would mean a source that delivers long before it says it began.
const heldFrames = 16
// Gaps held while a capture's start has not answered, for the same reason.
const heldGaps = 16
// Closed withheld stretches remembered so a frame stamped inside one stays withheld when it comes late. A frame earlier
// than the last frame sent is refused anyway, so only stretches after it matter; this bounds a policy that flips often.
const rememberedStretches = 64
// The same distinct failure of a call into the recording is named once in the report's problems, and only so many.
const keptProblems = 8
// A gap's reason as the media process takes it: a code, never free text.
const gapReasonPattern = /^[a-z0-9_]{1,64}$/

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
 * longest duration of its first frame, at most `MAX_FRAME_BYTES`, and from the source's own session. Each frame sent
 * gets a frame id, its place in the order the source delivered it, and the look id it carries. Gaps the source reports
 * and stretches the suspension withheld reach the recording as capture gaps, checked the same way. Every wait is
 * bounded, nothing throws, whatever the source does, and a failure is in the report.
 *
 * @example const report = await recordSource(page.frameSource(identity), media, { recordingId, runId, output, width: 1280, height: 720, fps: 10, deadlineMs: 20_000, clock, startTimeoutMs: 5000, stopTimeoutMs: 2000, finishTimeoutMs: 25_000, signal })
 */
export async function recordSource(source: FrameSource, media: MediaRecorder, options: RecordSourceOptions): Promise<SourceRecording> {
  const report = { source: source.name, identity: source.identity, frames: emptyTally(), gaps: emptyGaps(), problems: [] as string[] }
  if (options.finishTimeoutMs < options.deadlineMs) {
    return final({ ...report, status: 'not_started', reason: `finishTimeoutMs (${options.finishTimeoutMs} ms) is shorter than deadlineMs (${options.deadlineMs} ms), so the wait could end while the process is still finishing the video.` })
  }
  const availability = attempt(() => source.availability(), (problem): CaptureAvailability => ({ available: false, reason: `The ${source.name} source could not say whether it can capture: ${problem}` }))
  if (!availability.available) return final({ ...report, status: 'unavailable', reason: availability.reason })
  if (options.signal.aborted) return final({ ...report, status: 'not_started', reason: 'The signal had aborted before anything started, so no recording or capture began.', stoppedBy: 'signal' })
  const maxDurationMs = options.limits?.maxDurationMs ?? defaultMaxDurationMs
  const start: StartRecording = {
    recordingId: options.recordingId,
    identity: recordingIdentity(options.runId, source.identity),
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
  // The signal can abort while the process starts the recording; then no capture starts, and the empty recording is
  // finished rather than left running.
  if (options.signal.aborted) return final({ ...recorded, ...(await finishRecording(recording, options, undefined)), stoppedBy: 'signal' })
  const sender = new FrameSender({ identity: source.identity, recording, tally: report.frames, gaps: report.gaps, problems: report.problems, clock: options.clock, startUs: options.clock() })
  const { suspension } = options
  if (suspension?.suspended === true) sender.suspend(sender.startUs)
  const unlisten = suspension?.listen((suspended) => (suspended ? sender.suspend(options.clock()) : sender.resume(options.clock())))
  const stopping = Promise.withResolvers<'signal' | 'source' | 'recording'>()
  const onAbort = (): void => stopping.resolve('signal')
  options.signal.addEventListener('abort', onAbort, { once: true })
  const recordingOver = (): void => stopping.resolve('recording')
  recording.ended.then(recordingOver, recordingOver)
  const capture: StartCapture = {
    fps: options.fps,
    clock: options.clock,
    deliver: (frame) => sender.send(frame),
    ended: () => stopping.resolve('source'),
    timeoutMs: options.startTimeoutMs,
    gap: (gap) => sender.gap(gap),
    withheld: () => sender.withholding,
    ...(suspension === undefined ? {} : { onWithholdingChange: (listener: (held: boolean) => void) => suspension.listen(listener) }),
  }
  const failedStart = (problem: string): CaptureStart => ({ ok: false, reason: `The ${source.name} capture failed to start: ${problem}` })
  const starting = attempt(() => source.start(capture), (problem) => Promise.resolve(failedStart(problem))).catch((error: unknown) => failedStart(errorMessage(error)))
  const begin = await within(starting, options.startTimeoutMs)
  if (begin === undefined || !begin.ok) {
    // Nothing the source delivers from now on is recorded, so an unavailable capture never leaves a video behind.
    unlisten?.()
    sender.close(options.clock())
    options.signal.removeEventListener('abort', onAbort)
    const reason = begin === undefined ? `The ${source.name} capture did not start within ${options.startTimeoutMs} ms.` : begin.reason
    // A start that answers late must not leave a capture running that nobody stops.
    const stats = await stopCapture(source, options.stopTimeoutMs, report.problems)
    const finished = await finishRecording(recording, options, undefined)
    sender.detach()
    // The failed start stays the reason; a recording lost as it was finished keeps its own reason among the problems.
    if (finished.status === 'lost') report.problems.push(`The recording was lost as it was finished: ${finished.reason}`)
    const ending = finished.status === 'ended' ? { ended: finished.ended } : {}
    return final({ ...recorded, ...ending, status: 'unavailable', reason, ...(stats === undefined ? {} : { capture: stats }) })
  }
  sender.open()
  const stoppedBy = await stopping.promise
  options.signal.removeEventListener('abort', onAbort)
  const stats = await stopCapture(source, options.stopTimeoutMs, report.problems)
  unlisten?.()
  // A stretch still withheld ends where capture stopped, and reaches the recording before it is finished.
  sender.close(options.clock())
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

type SenderOptions = { identity: RecordIdentity; recording: RecordingTarget; tally: FrameTally; gaps: GapTally; problems: string[]; clock: () => number; startUs: number }

// A frame waiting for the capture's start, with the id it was given when it was delivered.
type HeldFrame = { frame: CapturedFrame; frameId: string }

/**
 * Sends a source's frames and gaps to one recording, refusing what the media process would refuse or what would end
 * it, withholding what the suspension holds back, and counts each once. Frames and gaps wait until the capture's start
 * answers: `open` sends them, and `close` counts them as not sent, as it does every one after it. After `detach`,
 * nothing is counted at all: the report is final.
 */
class FrameSender {
  readonly #options: SenderOptions
  readonly #held: HeldFrame[] = []
  readonly #heldGaps: CaptureGap[] = []
  // Closed withheld stretches, in the order they ended, and the start of the one still open.
  readonly #withheld: { fromUs: number; toUs: number }[] = []
  #withholdingFrom: number | undefined
  readonly #noted = new Set<string>()
  #state: 'waiting' | 'open' | 'closed' | 'detached' = 'waiting'
  #firstUs: number | undefined
  #lastUs: number | undefined

  constructor(options: SenderOptions) {
    this.#options = options
  }

  /** When capture was asked to start, on the recording's clock. */
  get startUs(): number {
    return this.#options.startUs
  }

  /** Whether the suspension is withholding frames now. */
  get withholding(): boolean {
    return this.#withholdingFrom !== undefined
  }

  send(frame: CapturedFrame): void {
    if (this.#state === 'detached') return
    const { tally } = this.#options
    tally.delivered += 1
    const frameId = String(tally.delivered)
    const refusal = this.#refusal(frame)
    if (refusal !== undefined) {
      tally.refused[refusal] += 1
      return
    }
    if (this.#withholds(frame.timestampUs, frame.earliestUs)) {
      tally.withheld += 1
      return
    }
    if (this.#state === 'closed') {
      tally.notSent += 1
      return
    }
    this.#firstUs ??= frame.timestampUs
    this.#lastUs = frame.timestampUs
    while (this.#withheld[0] !== undefined && this.#withheld[0].toUs < frame.timestampUs) this.#withheld.shift()
    if (this.#state === 'open') return this.#forward({ frame, frameId })
    this.#held.push({ frame, frameId })
    if (this.#held.length > heldFrames) {
      this.#held.shift()
      tally.notSent += 1
    }
  }

  gap(gap: SourceGap): void {
    if (this.#state === 'detached') return
    this.#report({ fromUs: gap.fromUs, toUs: gap.toUs, reason: gap.reason })
  }

  // A clock reading that is not whole microseconds starts the stretch at the start of capture: withholding more is the
  // side a pixel policy can take.
  suspend(nowUs: number): void {
    if (this.#state === 'closed' || this.#state === 'detached' || this.#withholdingFrom !== undefined) return
    const { startUs } = this.#options
    this.#withholdingFrom = Number.isSafeInteger(nowUs) ? Math.max(startUs, nowUs) : startUs
  }

  resume(nowUs: number): void {
    const fromUs = this.#withholdingFrom
    if (fromUs === undefined || this.#state === 'detached') return
    this.#withholdingFrom = undefined
    const toUs = Number.isSafeInteger(nowUs) && nowUs > fromUs ? nowUs : fromUs
    this.#withheld.push({ fromUs, toUs })
    if (this.#withheld.length > rememberedStretches) this.#withheld.shift()
    const { gaps } = this.#options
    gaps.withheldStretches += 1
    gaps.withheldUs += toUs - fromUs
    this.#report({ fromUs, toUs, reason: 'pixels_withheld' })
  }

  open(): void {
    if (this.#state !== 'waiting') return
    this.#state = 'open'
    for (const held of this.#held.splice(0)) this.#forward(held)
    for (const gap of this.#heldGaps.splice(0)) this.#forwardGap(gap)
  }

  // Ends a stretch still withheld at `nowUs`, and sends it while it can.
  close(nowUs: number): void {
    if (this.#state === 'closed' || this.#state === 'detached') return
    this.resume(nowUs)
    const { tally, gaps } = this.#options
    tally.notSent += this.#held.splice(0).length
    gaps.notSent += this.#heldGaps.splice(0).length
    this.#state = 'closed'
  }

  detach(): void {
    this.close(this.#options.clock())
    this.#state = 'detached'
  }

  // The moment the last frame is held until: when capture stopped, never before the last frame sent.
  endTimestamp(nowUs: number): number | undefined {
    if (!Number.isSafeInteger(nowUs) || nowUs < 0) return undefined
    return this.#lastUs === undefined || nowUs >= this.#lastUs ? nowUs : undefined
  }

  // A frame stamped inside a withheld stretch stays withheld, however late it comes, so a frame a source held back for
  // its cadence never shows what the policy withheld.
  #withholds(timestampUs: number, earliestUs = timestampUs): boolean {
    if (this.#withholdingFrom !== undefined && timestampUs >= this.#withholdingFrom) return true
    return this.#withheld.some((stretch) => timestampUs >= stretch.fromUs && earliestUs <= stretch.toUs)
  }

  #forward(held: HeldFrame): void {
    const { frame, frameId } = held
    const { observationId } = frame.identity
    const look = observationId !== undefined && protocolId(observationId) ? { observationId } : {}
    if (observationId !== undefined && !protocolId(observationId)) this.#note('A frame named a look id the media process does not take, so it was sent without one.')
    const sent: Frame = { frameId, ...look, timestampUs: frame.timestampUs, format: frame.format, bytes: frame.bytes }
    let outcome: FrameOutcome
    try {
      outcome = this.#options.recording.frame(sent)
    } catch (error) {
      this.#options.tally.notSent += 1
      this.#note(`The recording refused a frame: ${errorMessage(error)}`)
      return
    }
    this.#count(outcome)
  }

  #report(gap: CaptureGap): void {
    const { gaps } = this.#options
    gaps.reported += 1
    if (!this.#validGap(gap)) {
      gaps.refused += 1
      return
    }
    if (this.#state === 'closed') {
      gaps.notSent += 1
      return
    }
    if (this.#state === 'open') return this.#forwardGap(gap)
    this.#heldGaps.push(gap)
    if (this.#heldGaps.length > heldGaps) {
      this.#heldGaps.shift()
      gaps.notSent += 1
    }
  }

  // A gap on the recording's clock: whole microseconds, in order, from when capture was asked to start until now.
  #validGap(gap: CaptureGap): boolean {
    const { clock, startUs } = this.#options
    if (!Number.isSafeInteger(gap.fromUs) || !Number.isSafeInteger(gap.toUs)) return false
    if (gap.fromUs < 0 || gap.fromUs < startUs || gap.toUs < gap.fromUs || gap.toUs > clock()) return false
    return typeof gap.reason === 'string' && gapReasonPattern.test(gap.reason)
  }

  #forwardGap(gap: CaptureGap): void {
    const { gaps, recording } = this.#options
    try {
      if (recording.captureGap(gap)) gaps.sent += 1
      else gaps.notSent += 1
    } catch (error) {
      gaps.refused += 1
      this.#note(`The recording refused a capture gap: ${errorMessage(error)}`)
    }
  }

  #note(problem: string): void {
    if (this.#noted.has(problem) || this.#noted.size >= keptProblems) return
    this.#noted.add(problem)
    this.#options.problems.push(problem)
  }

  #refusal(frame: CapturedFrame): keyof RefusedFrames | undefined {
    const { identity, recording, clock, startUs } = this.#options
    if (!sameSession(frame.identity, identity)) return 'identity'
    if (!Number.isSafeInteger(frame.timestampUs) || frame.timestampUs < 0) return 'timestamp'
    // A frame reached Retest before it is delivered and after capture was asked to start; one stamped otherwise was
    // stamped on another clock, however orderly its own timestamps are.
    if (frame.timestampUs > clock() || frame.timestampUs < startUs) return 'clock'
    if (frame.earliestUs !== undefined && (!Number.isSafeInteger(frame.earliestUs) || frame.earliestUs < startUs || frame.earliestUs > frame.timestampUs)) return 'clock'
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

// The recording's identity: the run, and the source's own test, attempt, app and session. The look is per frame.
function recordingIdentity(runId: string, identity: RecordIdentity): RecordingIdentity {
  return { runId, attemptId: identity.attemptId, testId: identity.testId, app: identity.app, sessionId: identity.sessionId }
}

// An id the media process takes in a frame header: one to `MAX_FRAME_ID_CHARACTERS` characters, no control character.
function protocolId(value: string): boolean {
  const length = [...value].length
  return length >= 1 && length <= MAX_FRAME_ID_CHARACTERS && !/[\u0000-\u001f\u007f-\u009f]/u.test(value)
}

function emptyTally(): FrameTally {
  return { delivered: 0, sent: 0, dropped: 0, notSent: 0, withheld: 0, refused: { identity: 0, timestamp: 0, clock: 0, outOfOrder: 0, outOfRange: 0, tooLarge: 0, empty: 0 } }
}

function emptyGaps(): GapTally {
  return { reported: 0, sent: 0, notSent: 0, refused: 0, withheldStretches: 0, withheldUs: 0 }
}

// A copy of the report that nothing changes after it is returned, however late a source delivers. Every object in it is
// its own copy, frozen, so neither the report nor what the source and the recording hold can be changed through it.
function final(report: SourceRecording): SourceRecording {
  const { identity, started, capture, ended, frames, gaps, problems } = report
  return Object.freeze({
    ...report,
    identity: Object.freeze({ ...identity }),
    ...(started === undefined ? {} : { started: Object.freeze({ ...started, identity: Object.freeze({ ...started.identity }) }) }),
    ...(capture === undefined ? {} : { capture: Object.freeze({
      ...capture,
      ...(capture.clockMapping === undefined ? {} : { clockMapping: Object.freeze({ ...capture.clockMapping }) }),
      ...(capture.captureMs === undefined ? {} : { captureMs: Object.freeze({ ...capture.captureMs }) }),
      problems: Object.freeze([...capture.problems]),
    }) }),
    ...(ended === undefined ? {} : { ended: frozenEnding(ended) }),
    frames: Object.freeze({ ...frames, refused: Object.freeze({ ...frames.refused }) }),
    gaps: Object.freeze({ ...gaps }),
    problems: Object.freeze([...problems]),
  })
}

function frozenEnding(ended: Frozen<Ended>): Frozen<Ended> {
  const { encoder } = ended
  return Object.freeze({
    ...ended,
    identity: Object.freeze({ ...ended.identity }),
    frames: Object.freeze({ ...ended.frames }),
    gaps: Object.freeze(ended.gaps.map((gap) => Object.freeze({ ...gap }))),
    queue: Object.freeze({ ...ended.queue }),
    captureGaps: Object.freeze(ended.captureGaps.map((gap) => Object.freeze({ ...gap }))),
    evidence: Object.freeze({ ...ended.evidence, reasons: Object.freeze([...ended.evidence.reasons]) }),
    frameMap: Object.freeze(ended.frameMap.map((entry) => Object.freeze({ ...entry }))),
    ...(encoder === undefined ? {} : { encoder: Object.freeze({ ...encoder, stderr: Object.freeze([...encoder.stderr]) }) }),
  })
}

// Calls a source's method, and turns a synchronous throw into the value `failed` makes of its message.
function attempt<T>(call: () => T, failed: (problem: string) => T): T {
  try {
    return call()
  } catch (error) {
    return failed(errorMessage(error))
  }
}

// Whether the promise settled, either way, before `timeoutMs` passed.
async function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const settled = promise.then(
    () => true,
    () => true,
  )
  return (await within(settled, timeoutMs)) === true
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
