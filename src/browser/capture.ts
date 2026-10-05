import type { CdpSession } from './cdp/session.ts'
import type { CaptureAvailability, CaptureStart, CaptureStats, CapturedFrame, FrameSource, StartCapture } from '../media/capture.ts'
import type { CaptureSourceName, RecordIdentity } from '../protocol/identity.ts'
import { errorMessage } from '../protocol/failures.ts'
import { s } from '../protocol/schema.ts'
import { readProtocol, request } from './cdp-results.ts'

/** The part of a page's own DevTools session a capture uses. */
export type CaptureSession = Pick<CdpSession, 'id' | 'send' | 'on' | 'onDetach' | 'detachReason' | 'blockReason'>

/**
 * How Chrome encodes the screencast's frames: `jpeg`, the default, at Chrome's own quality unless `quality` (0 to 100)
 * is given, or `png`. `maxWidth` and `maxHeight` cap a frame's size in pixels; Chrome keeps the page's proportions.
 */
export type ChromiumCaptureOptions = { format?: 'jpeg' | 'png'; quality?: number; maxWidth?: number; maxHeight?: number }

const frameSchema = s.object({ data: s.string(), sessionId: s.number({ integer: true }) })
// An acknowledgement is small and Chrome answers it at once; this only keeps an unanswered one from waiting forever.
const acknowledgeTimeoutMs = 5000
const keptProblems = 8

type State = 'idle' | 'starting' | 'running' | 'stopping' | 'ended' | 'stopped'

/**
 * Chrome's screencast of one page, as a frame source for the media process: `Page.startScreencast` on the page's own
 * session, so it captures that page and nothing else. Chrome sends frames when it chooses to, as the page paints, and
 * holds back the next until the last is acknowledged, so not every paint arrives as a frame; every frame is
 * acknowledged as it arrives while capture is permitted. Withholding stops the stream and discards arrivals without
 * acknowledging them. No frame between two times does not mean nothing appeared on the page between them. Frames
 * are kept as Chrome encoded them, JPEG or PNG, out of the protocol's base64 and never decoded; each is stamped with the
 * run's clock when it reaches Retest. At most one frame is handed over each `1/fps` of a second: one that comes sooner
 * waits for its turn, and a newer frame that comes before then takes its place and the older one is counted as
 * superseded. Frames that come while capture stops are still counted, and the one waiting is handed over before the stop
 * resolves. Sends no input.
 *
 * The screencast was chosen over a `Page.captureScreenshot` loop because it is Chrome's own frame stream, which sends
 * nothing while the page stands still, where a loop asks for a capture on every tick and the page's changes between two
 * captures are lost all the same. When Chrome refuses a frame's acknowledgement, as a session held by a JavaScript
 * dialog refuses every command, the stream may stop until the page can answer again; each refusal is named among the
 * problems.
 *
 * @example const source = new ChromiumFrameSource(session, identity, { format: 'jpeg' })
 */
export class ChromiumFrameSource implements FrameSource {
  readonly name: CaptureSourceName = 'chromium'
  readonly identity: RecordIdentity
  readonly #session: CaptureSession
  readonly #options: ChromiumCaptureOptions
  // Why this source may not capture whatever the page's state, as an identity the page did not recognise.
  readonly #refused: string | undefined
  readonly #listeners: (() => void)[] = []
  readonly #problems: string[] = []
  #state: State = 'idle'
  #capture: StartCapture | undefined
  #intervalUs = 0
  #delivered = 0
  #superseded = 0
  #dropped = 0
  #startedAtUs: number | undefined
  #stoppedAtUs: number | undefined
  #firstUs: number | undefined
  #lastUs: number | undefined
  // When on the run's clock the last frame was handed over, which the next turn is counted from.
  #acknowledgedUs: number | undefined
  #handedOverUs: number | undefined
  #waiting: CapturedFrame | undefined
  #timer: NodeJS.Timeout | undefined
  #endedEarly: string | undefined
  #stopping: Promise<CaptureStats> | undefined
  #uncertainStop: Promise<Answer> | undefined
  #paused = false
  #remoteRunning = false
  #pauseStop: Promise<Answer> | undefined
  #resuming: Promise<void> | undefined
  #withheldFromUs: number | undefined
  #resumedAtUs: number | undefined

  /** `refused` names why the source must not capture at all; its availability says so. */
  constructor(session: CaptureSession, identity: RecordIdentity, options: ChromiumCaptureOptions = {}, refused?: string) {
    this.#session = session
    this.identity = identity
    this.#options = options
    this.#refused = refused
  }

  availability(): CaptureAvailability {
    const reason = this.#unavailable()
    return reason === undefined ? { available: true, mode: 'screencast' } : { available: false, reason }
  }

  async start(capture: StartCapture): Promise<CaptureStart> {
    if (this.#state !== 'idle') return { ok: false, reason: 'This capture has started before; a source captures once.' }
    const unavailable = this.#unavailable()
    if (unavailable !== undefined) return { ok: false, reason: unavailable }
    if (!Number.isFinite(capture.fps) || capture.fps <= 0) return { ok: false, reason: `A capture needs a cadence above 0 frames a second, not ${capture.fps}.` }
    this.#state = 'starting'
    this.#capture = capture
    this.#intervalUs = Math.round(1_000_000 / capture.fps)
    this.#startedAtUs = capture.clock()
    this.#listeners.push(
      this.#session.on('Page.screencastFrame', (params) => this.#frame(params)),
      this.#session.onDetach((reason) => this.#end(reason)),
    )
    if (capture.onWithholdingChange !== undefined) this.#listeners.push(capture.onWithholdingChange((held) => this.#withholding(held)))
    if (capture.withheld?.() === true) {
      this.#paused = true
      this.#withheldFromUs = this.#startedAtUs
      this.#state = 'running'
      return { ok: true, mode: 'screencast' }
    }
    this.#remoteRunning = true
    try {
      await request(this.#session, 'Page.startScreencast', this.#parameters(), s.object({}), { timeoutMs: capture.timeoutMs })
    } catch (error) {
      if (this.#state === 'starting') {
        if (this.#waiting !== undefined) this.#dropped += 1
        this.#waiting = undefined
        this.#stoppedAtUs = capture.clock()
        this.#release('stopped')
      }
      // A start whose answer did not come in time may still have begun the screencast, which nobody would acknowledge.
      if (this.#session.detachReason === undefined && this.#stopping === undefined) this.#uncertainStop = answeredWithin(Promise.resolve().then(() => this.#session.send('Page.stopScreencast', undefined, { timeoutMs: Math.max(1, capture.timeoutMs) })), capture.timeoutMs)
      return { ok: false, reason: `Chrome did not start its screencast of the page: ${errorMessage(error)}` }
    }
    // A stop asked for while Chrome started has already sent the end of the screencast after its start.
    if (this.#state !== 'starting') return { ok: false, reason: this.#endedEarly ?? 'The capture was stopped before it started.' }
    this.#state = 'running'
    if (this.#paused && capture.withheld?.() !== true) this.#withholding(false)
    return { ok: true, mode: 'screencast' }
  }

  stop(timeoutMs: number): Promise<CaptureStats> {
    this.#stopping ??= this.#stop(timeoutMs)
    return this.#stopping
  }

  async #stop(timeoutMs: number): Promise<CaptureStats> {
    if (this.#state !== 'starting' && this.#state !== 'running') {
      if (this.#state === 'idle') this.#state = 'stopped'
      if (this.#uncertainStop !== undefined) {
        const answer = await uncertainStopWithin(this.#uncertainStop, timeoutMs)
        this.#uncertainStop = undefined
        if (answer.status === 'failed') this.#problem(`Ending Chrome's uncertain screencast start failed: ${answer.problem}`)
        if (answer.status === 'late') this.#problem(`Chrome did not confirm the end of its uncertain screencast start within ${timeoutMs} ms.`)
      }
      return this.#stats()
    }
    // Frames that come while Chrome ends its screencast are still offered and counted; the stop waits for its answer
    // only as long as it was given, since a page that stopped answering would hold it forever.
    this.#state = 'stopping'
    const stoppingAt = performance.now()
    const remaining = (): number => Math.max(1, Math.floor(timeoutMs - (performance.now() - stoppingAt)))
    if (this.#resuming !== undefined) {
      const resumed = await answeredWithin(this.#resuming, remaining())
      if (resumed.status !== 'answered') this.#problem("Chrome did not confirm its screencast restart before the stop budget ended; remote capture is unknown.")
    }
    if (this.#pauseStop !== undefined) {
      const paused = await uncertainStopWithin(this.#pauseStop, remaining())
      if (paused.status === 'late') this.#problem("Chrome did not confirm its screencast pause before the stop budget ended; remote capture is unknown.")
    }
    if (this.#session.detachReason === undefined && this.#remoteRunning) {
      this.#remoteRunning = false
      const answered = await answeredWithin(this.#session.send('Page.stopScreencast', undefined, { timeoutMs: remaining() }), remaining())
      if (answered.status === 'failed') this.#problem(`Chrome did not answer the end of its screencast: ${answered.problem}`)
      if (answered.status === 'late') this.#problem(`Chrome did not answer the end of its screencast within ${timeoutMs} ms.`)
    }
    if (this.#state === 'stopping') {
      this.#handOverWaiting()
      this.#closeWithheldGap()
      this.#stoppedAtUs = this.#capture?.clock()
      this.#release('stopped')
    }
    return this.#stats()
  }

  #unavailable(): string | undefined {
    if (this.#refused !== undefined) return this.#refused
    const { detachReason, blockReason } = this.#session
    if (detachReason !== undefined) return `The page is gone, so Chrome cannot capture it: ${detachReason}.`
    if (blockReason !== undefined) return `Chrome cannot capture the page while ${blockReason}.`
    return undefined
  }

  #parameters(): Record<string, string | number> {
    const { format = 'jpeg', quality, maxWidth, maxHeight } = this.#options
    return {
      format,
      ...(quality === undefined ? {} : { quality }),
      ...(maxWidth === undefined ? {} : { maxWidth }),
      ...(maxHeight === undefined ? {} : { maxHeight }),
    }
  }

  #frame(params: unknown): void {
    let frame: { data: string; sessionId: number }
    try {
      frame = readProtocol(frameSchema, params, { method: 'Page.screencastFrame', sessionId: this.#session.id })
    } catch (error) {
      this.#dropped += 1
      this.#problem(`Chrome sent a frame Retest could not read: ${errorMessage(error)}`)
      return
    }
    const capture = this.#capture
    if (capture?.withheld?.() === true) this.#withholding(true)
    if (this.#paused) {
      this.#dropped += 1
      this.#withheldGap(this.#acknowledgedUs ?? this.#startedAtUs ?? capture?.clock() ?? 0, capture?.clock() ?? 0)
      return
    }
    const earliestUs = Math.max(this.#acknowledgedUs ?? this.#startedAtUs ?? 0, this.#resumedAtUs ?? 0)
    this.#acknowledgedUs = this.#capture?.clock()
    this.#session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }, { timeoutMs: acknowledgeTimeoutMs }).catch((error: unknown) => {
      this.#problem(`Chrome did not take a frame's acknowledgement: ${errorMessage(error)}`)
    })
    if (capture === undefined || (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping')) return
    const bytes = Buffer.from(frame.data, 'base64')
    if (bytes.byteLength === 0) {
      this.#dropped += 1
      this.#problem('Chrome sent a frame with no image in it.')
      return
    }
    const timestampUs = capture.clock()
    // Acknowledgement lets the next read begin before cadence delivery. Keep the bound from before this frame’s ack.
    this.#offer({ identity: this.identity, timestampUs, earliestUs: earliestUs ?? timestampUs, format: this.#options.format ?? 'jpeg', bytes })
  }

  // Stop the remote stream at the policy boundary. No acknowledgement may permit another read while held.
  #withholding(held: boolean): void {
    const capture = this.#capture
    if (capture === undefined || (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping')) return
    if (!held) {
      if (this.#state !== 'running') return
      this.#resuming ??= this.#resumeCapture().finally(() => { this.#resuming = undefined })
      return
    }
    if (this.#paused) return
    this.#paused = true
    this.#withheldFromUs = capture.clock()
    this.#clearTimer()
    if (this.#waiting !== undefined) {
      this.#withheldGap(this.#waiting.earliestUs ?? this.#waiting.timestampUs, capture.clock())
      this.#dropped += 1
      this.#waiting = undefined
    }
    if (this.#remoteRunning && this.#state !== 'stopping') {
      this.#remoteRunning = false
      this.#pauseStop = answeredWithin(this.#session.send('Page.stopScreencast', undefined, { timeoutMs: Math.max(1, capture.timeoutMs) }), capture.timeoutMs).then((answer) => {
        if (answer.status !== 'answered') {
          const reason = answer.status === 'failed' ? answer.problem : 'the stop reply did not arrive within its budget'
          this.#problem("Chrome could not confirm its screencast paused: " + reason)
          this.#end("withholding could not confirm stopped pixel capture; remote capture is unknown: " + reason, false)
        }
        return answer
      })
    }
  }

  async #resumeCapture(): Promise<void> {
    const capture = this.#capture
    if (!this.#paused || capture === undefined) return
    const stopped = await this.#pauseStop
    if (stopped !== undefined && stopped.status !== 'answered') return
    if (this.#state !== 'running' || capture.withheld?.() === true) return
    this.#closeWithheldGap()
    this.#resumedAtUs = capture.clock()
    this.#acknowledgedUs = undefined
    this.#paused = false
    this.#pauseStop = undefined
    this.#remoteRunning = true
    try {
      await request(this.#session, 'Page.startScreencast', this.#parameters(), s.object({}), { timeoutMs: capture.timeoutMs })
    } catch (error) {
      this.#problem("Chrome could not restart its screencast after withholding: " + errorMessage(error))
      this.#uncertainStop = answeredWithin(Promise.resolve().then(() => this.#session.send('Page.stopScreencast', undefined, { timeoutMs: Math.max(1, capture.timeoutMs) })), capture.timeoutMs)
      this.#end('capture could not resume after withholding; the restart outcome is unknown', false)
    }
  }

  #withheldGap(fromUs: number, toUs: number): void {
    try { this.#capture?.gap?.({ fromUs, toUs, reason: 'pixels_withheld' }) }
    catch (error) { this.#problem('Reporting withheld pixels failed: ' + errorMessage(error)) }
  }

  #closeWithheldGap(): void {
    if (this.#withheldFromUs === undefined) return
    this.#withheldGap(this.#withheldFromUs, this.#capture?.clock() ?? this.#withheldFromUs)
    this.#withheldFromUs = undefined
  }

  // Hand over a due frame, or retain the newest arrival until its cadence turn.
  #offer(frame: CapturedFrame): void {
    const due = this.#handedOverUs === undefined ? frame.timestampUs : this.#handedOverUs + this.#intervalUs
    if (frame.timestampUs >= due) {
      this.#dropWaiting()
      this.#handOver(frame, frame.timestampUs)
      return
    }
    if (this.#waiting !== undefined) this.#superseded += 1
    this.#waiting = frame
    if (this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#handOverWaiting()
    }, Math.max(1, Math.ceil((due - frame.timestampUs) / 1000)))
    // Capture never keeps the process alive on its own.
    this.#timer.unref()
  }

  #handOverWaiting(): void {
    if (this.#paused) {
      this.#clearTimer()
      return
    }
    const waiting = this.#waiting
    const capture = this.#capture
    this.#clearTimer()
    this.#waiting = undefined
    if (waiting === undefined || capture === undefined) return
    this.#handOver(waiting, Math.max(waiting.timestampUs, capture.clock()))
  }

  // A frame waiting for its turn that a newer frame replaces before it is handed over.
  #dropWaiting(): void {
    this.#clearTimer()
    if (this.#waiting !== undefined) this.#superseded += 1
    this.#waiting = undefined
  }

  #handOver(frame: CapturedFrame, atUs: number): void {
    this.#handedOverUs = atUs
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

  // The page closed or the browser went: what was waiting is handed over, since it arrived, and capture ends.
  #end(reason: string, targetLost = true): void {
    if (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping') return
    this.#handOverWaiting()
    this.#stoppedAtUs = this.#capture?.clock()
    this.#closeWithheldGap()
    this.#endedEarly = targetLost ? `The page's session ended: ${reason}.` : `The capture ended: ${reason}.`
    const fromUs = this.#lastUs ?? this.#startedAtUs
    if (fromUs !== undefined && this.#stoppedAtUs !== undefined) {
      try { this.#capture?.gap?.({ fromUs, toUs: this.#stoppedAtUs, reason: targetLost ? 'target_lost' : 'capture_failed' }) }
      catch (error) { this.#problem(`Reporting the lost target failed: ${errorMessage(error)}`) }
    }
    this.#release('ended')
    this.#capture?.ended(this.#endedEarly)
  }

  #release(state: 'ended' | 'stopped'): void {
    this.#state = state
    this.#clearTimer()
    for (const stop of this.#listeners.splice(0)) stop()
  }

  #clearTimer(): void {
    clearTimeout(this.#timer)
    this.#timer = undefined
  }

  #problem(problem: string): void {
    if (this.#problems.length < keptProblems) this.#problems.push(problem)
  }

  #stats(): CaptureStats {
    const started = this.#startedAtUs
    const stopped = this.#stoppedAtUs
    const span = started === undefined || stopped === undefined ? 0 : stopped - started
    const achievedFps = span > 0 ? Math.round((this.#delivered / (span / 1_000_000)) * 100) / 100 : undefined
    return {
      mode: 'screencast',
      requestedFps: this.#capture?.fps ?? 0,
      clockMapping: { timestamp: 'run-arrival', targetClock: 'not-used', imageRead: 'previous-acknowledgement-to-arrival' },
      delivered: this.#delivered,
      superseded: this.#superseded,
      dropped: this.#dropped,
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

type Answer = { status: 'answered' } | { status: 'failed'; problem: string } | { status: 'late' }

async function uncertainStopWithin(stopping: Promise<Answer>, timeoutMs: number): Promise<Answer> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([stopping, new Promise<Answer>((resolve) => {
      timer = setTimeout(resolve, Math.max(1, timeoutMs), { status: 'late' })
    })])
  } finally { clearTimeout(timer) }
}

// Whether a command answered, failed, or had not answered when its time was up. Chrome's session times its commands out
// itself; this bounds the stop whatever session it is given.
async function answeredWithin(sent: Promise<unknown>, timeoutMs: number): Promise<Answer> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<Answer>((resolve) => {
    timer = setTimeout(resolve, Math.max(1, timeoutMs), { status: 'late' })
  })
  const settled = sent.then(
    (): Answer => ({ status: 'answered' }),
    (error: unknown): Answer => ({ status: 'failed', problem: errorMessage(error) }),
  )
  try {
    return await Promise.race([settled, late])
  } finally {
    clearTimeout(timer)
  }
}
