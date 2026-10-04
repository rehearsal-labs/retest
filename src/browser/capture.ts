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
 * acknowledged as it arrives. No frame between two times does not mean nothing appeared on the page between them. Frames
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
  #handedOverUs: number | undefined
  #waiting: CapturedFrame | undefined
  #timer: NodeJS.Timeout | undefined
  #endedEarly: string | undefined
  #stopping: Promise<CaptureStats> | undefined

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
      if (this.#session.detachReason === undefined) this.#session.send('Page.stopScreencast', undefined, { timeoutMs: Math.max(1, capture.timeoutMs) }).catch(() => undefined)
      return { ok: false, reason: `Chrome did not start its screencast of the page: ${errorMessage(error)}` }
    }
    // A stop asked for while Chrome started has already sent the end of the screencast after its start.
    if (this.#state !== 'starting') return { ok: false, reason: this.#endedEarly ?? 'The capture was stopped before it started.' }
    this.#state = 'running'
    return { ok: true, mode: 'screencast' }
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
    // Frames that come while Chrome ends its screencast are still offered and counted; the stop waits for its answer
    // only as long as it was given, since a page that stopped answering would hold it forever.
    this.#state = 'stopping'
    if (this.#session.detachReason === undefined) {
      const answered = await answeredWithin(this.#session.send('Page.stopScreencast', undefined, { timeoutMs: Math.max(1, timeoutMs) }), timeoutMs)
      if (answered.status === 'failed') this.#problem(`Chrome did not answer the end of its screencast: ${answered.problem}`)
      if (answered.status === 'late') this.#problem(`Chrome did not answer the end of its screencast within ${timeoutMs} ms.`)
    }
    if (this.#state === 'stopping') {
      this.#handOverWaiting()
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
    this.#session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }, { timeoutMs: acknowledgeTimeoutMs }).catch((error: unknown) => {
      this.#problem(`Chrome did not take a frame's acknowledgement: ${errorMessage(error)}`)
    })
    const capture = this.#capture
    if (capture === undefined || (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping')) return
    const bytes = Buffer.from(frame.data, 'base64')
    if (bytes.byteLength === 0) {
      this.#dropped += 1
      this.#problem('Chrome sent a frame with no image in it.')
      return
    }
    this.#offer({ identity: this.identity, timestampUs: capture.clock(), format: this.#options.format ?? 'jpeg', bytes })
  }

  // Hands a frame over when its turn has come, or keeps it for the next turn in place of any frame already waiting.
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
  #end(reason: string): void {
    if (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping') return
    this.#handOverWaiting()
    this.#stoppedAtUs = this.#capture?.clock()
    this.#endedEarly = `The page's session ended: ${reason}.`
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
