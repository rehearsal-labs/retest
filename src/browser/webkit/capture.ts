import type { CaptureAvailability, CaptureStart, CaptureStats, CapturedFrame, FrameSource, StartCapture } from '../../media/capture.ts'
import type { CaptureSourceName, RecordIdentity } from '../../protocol/identity.ts'
import type { PageProxyEvent } from './connection.ts'
import type { WebKitScreen } from './screen.ts'
import { errorMessage } from '../../protocol/failures.ts'
import { s } from '../../protocol/schema.ts'
import { readProtocol } from '../cdp-results.ts'

/** What a WebKit page's capture needs of it: its page proxy's events and commands, its screen, and why it is gone, if it is. */
export interface CapturedPage {
  onPageProxyEvent(listener: (event: PageProxyEvent) => void): () => void
  onLost(listener: (loss: { reason: string }) => void): () => void
  readonly screen: WebKitScreen
  readonly lostReason: string | undefined
  /** Sends a command to the page proxy, failing at once while the page is held or gone. */
  proxy(method: string, params: object | undefined, options: { timeoutMs: number }): Promise<unknown>
}

/** The name a WebKit capture records itself under, one of the run's capture source names. */
export type WebKitSourceName = Extract<CaptureSourceName, 'webkit'>

const frameSchema = s.object({ data: s.string() })
const startedSchema = s.object({ generation: s.number({ integer: true }) })
// An acknowledgement is small and the build answers it at once; this only keeps an unanswered one from waiting forever.
const acknowledgeTimeoutMs = 5000
const keptProblems = 8
const jpegQuality = 80

type State = 'idle' | 'starting' | 'running' | 'stopping' | 'ended' | 'stopped'

/**
 * The WebKit build's screencast of one page, as a frame source for the media process: `Screencast.startScreencast` on the
 * page's own page proxy, so it captures that page and nothing else, at the page's viewport size. The build sends a JPEG
 * frame when the build chooses to send it, and each permitted frame is acknowledged as it arrives; no frame between two times
 * does not mean nothing appeared between them. Frames are kept as the build encoded them, never decoded, and stamped
 * with the run's clock when they reach Retest. At most one frame is handed over each `1/fps` of a second: one that comes
 * sooner waits for its turn, and a newer one that comes before then takes its place, counted as superseded. Sends no
 * input. It is a `FrameSource` under the name `webkit`.
 *
 * @example const source = new WebKitFrameSource(page, identity)
 */
export class WebKitFrameSource implements FrameSource {
  readonly name: WebKitSourceName = 'webkit'
  readonly identity: RecordIdentity
  readonly #page: CapturedPage
  readonly #refused: string | undefined
  readonly #listeners: (() => void)[] = []
  readonly #problems: string[] = []
  #state: State = 'idle'
  #capture: StartCapture | undefined
  #generation: number | undefined
  #pendingAcknowledgements = 0
  #lossPoll: NodeJS.Timeout | undefined
  #intervalUs = 0
  #delivered = 0
  #superseded = 0
  #dropped = 0
  #startedAtUs: number | undefined
  #stoppedAtUs: number | undefined
  #firstUs: number | undefined
  #lastUs: number | undefined
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
  constructor(page: CapturedPage, identity: RecordIdentity, refused?: string) {
    this.#page = page
    this.identity = identity
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
    this.#lossPoll = setInterval(() => {
      const reason = this.#page.lostReason
      if (reason !== undefined) this.#end(reason)
    }, 50)
    this.#lossPoll.unref()
    this.#listeners.push(
      this.#page.onPageProxyEvent((event) => {
        if (event.method === 'Screencast.screencastFrame') this.#frame(event.params)
      }),
      this.#page.onLost(({ reason }) => this.#end(reason)),
    )
    const { width, height } = this.#page.screen.viewport
    if (capture.onWithholdingChange !== undefined) this.#listeners.push(capture.onWithholdingChange((held) => this.#withholding(held)))
    if (capture.withheld?.() === true) {
      this.#paused = true
      this.#withheldFromUs = this.#startedAtUs
      this.#state = 'running'
      return { ok: true, mode: 'screencast' }
    }
    this.#remoteRunning = true
    try {
      const answer = await replyWithin(this.#page.proxy('Screencast.startScreencast', { width, height, toolbarHeight: 0, quality: jpegQuality }, { timeoutMs: Math.max(1, capture.timeoutMs) }), capture.timeoutMs)
      this.#generation = readProtocol(startedSchema, answer, { method: 'Screencast.startScreencast' }).generation
      while (this.#pendingAcknowledgements > 0 && !this.#paused) {
        this.#pendingAcknowledgements -= 1
        this.#acknowledge(this.#generation)
      }
    } catch (error) {
      if (this.#state === 'starting') {
        if (this.#waiting !== undefined) this.#dropped += 1
        this.#waiting = undefined
        this.#stoppedAtUs = capture.clock()
        this.#release('stopped')
      }
      // A start whose answer did not come in time may still have begun the screencast, which nobody would acknowledge.
      if (this.#page.lostReason === undefined && this.#stopping === undefined) this.#uncertainStop = answeredWithin(Promise.resolve().then(() => this.#page.proxy('Screencast.stopScreencast', undefined, { timeoutMs: Math.max(1, capture.timeoutMs) })), capture.timeoutMs)
      return { ok: false, reason: `WebKit did not start its screencast of the page: ${errorMessage(error)}` }
    }
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
        if (answer.status === 'failed') this.#problem(`Ending WebKit's uncertain screencast start failed: ${answer.problem}`)
        if (answer.status === 'late') this.#problem(`WebKit did not confirm the end of its uncertain screencast start within ${timeoutMs} ms.`)
      }
      return this.#stats()
    }
    this.#state = 'stopping'
    const stoppingAt = performance.now()
    const remaining = (): number => Math.max(1, Math.floor(timeoutMs - (performance.now() - stoppingAt)))
    if (this.#resuming !== undefined) {
      const resumed = await answeredWithin(this.#resuming, remaining())
      if (resumed.status !== 'answered') this.#problem("WebKit did not confirm its screencast restart before the stop budget ended; remote capture is unknown.")
    }
    if (this.#pauseStop !== undefined) {
      const paused = await uncertainStopWithin(this.#pauseStop, remaining())
      if (paused.status === 'late') this.#problem("WebKit did not confirm its screencast pause before the stop budget ended; remote capture is unknown.")
    }
    if (this.#page.lostReason === undefined && this.#remoteRunning) {
      this.#remoteRunning = false
      const answered = await answeredWithin(this.#page.proxy('Screencast.stopScreencast', undefined, { timeoutMs: remaining() }), remaining())
      if (answered.status === 'failed') this.#problem(`WebKit did not answer the end of its screencast: ${answered.problem}`)
      if (answered.status === 'late') this.#problem(`WebKit did not answer the end of its screencast within ${timeoutMs} ms.`)
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
    const lost = this.#page.lostReason
    return lost === undefined ? undefined : `The page is gone, so WebKit cannot capture it: ${lost}.`
  }

  #frame(params: unknown): void {
    let data: string
    try {
      data = readProtocol(frameSchema, params, { method: 'Screencast.screencastFrame' }).data
    } catch (error) {
      this.#dropped += 1
      this.#problem(`WebKit sent a frame Retest could not read: ${errorMessage(error)}`)
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
    const generation = this.#generation
    // A final pushed frame may arrive after stop was sent. The stream is already ending and no longer takes acks.
    if (this.#state === 'starting' || this.#state === 'running') {
      if (generation !== undefined) this.#acknowledge(generation)
      else this.#pendingAcknowledgements += 1
    }
    if (capture === undefined || (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping')) return
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength === 0) {
      this.#dropped += 1
      this.#problem('WebKit sent a frame with no image in it.')
      return
    }
    const timestampUs = capture.clock()
    // Acknowledgement lets the next read begin before cadence delivery. Keep the bound from before this frame’s ack.
    this.#offer({ identity: this.identity, timestampUs, earliestUs: earliestUs ?? timestampUs, format: 'jpeg', bytes })
  }

  #acknowledge(generation: number): void {
    this.#acknowledgedUs = this.#capture?.clock()
    void this.#page.proxy('Screencast.screencastFrameAck', { generation }, { timeoutMs: acknowledgeTimeoutMs }).catch((error: unknown) => {
      this.#problem(`WebKit did not take a frame's acknowledgement: ${errorMessage(error)}`)
    })
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
    this.#pendingAcknowledgements = 0
    if (this.#remoteRunning && this.#state !== 'stopping') {
      this.#remoteRunning = false
      this.#pauseStop = answeredWithin(this.#page.proxy('Screencast.stopScreencast', undefined, { timeoutMs: Math.max(1, capture.timeoutMs) }), capture.timeoutMs).then((answer) => {
        if (answer.status !== 'answered') {
          const reason = answer.status === 'failed' ? answer.problem : 'the stop reply did not arrive within its budget'
          this.#problem("WebKit could not confirm its screencast paused: " + reason)
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
    this.#generation = undefined
    try {
      const { width, height } = this.#page.screen.viewport
      const reply = await replyWithin(this.#page.proxy('Screencast.startScreencast', { width, height, toolbarHeight: 0, quality: jpegQuality }, { timeoutMs: Math.max(1, capture.timeoutMs) }), capture.timeoutMs)
      this.#generation = readProtocol(startedSchema, reply, { method: 'Screencast.startScreencast' }).generation
      while (this.#pendingAcknowledgements > 0 && !this.#paused) {
        this.#pendingAcknowledgements -= 1
        this.#acknowledge(this.#generation)
      }
    } catch (error) {
      this.#problem("WebKit could not restart its screencast after withholding: " + errorMessage(error))
      this.#uncertainStop = answeredWithin(Promise.resolve().then(() => this.#page.proxy('Screencast.stopScreencast', undefined, { timeoutMs: Math.max(1, capture.timeoutMs) })), capture.timeoutMs)
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

  #end(reason: string, targetLost = true): void {
    if (this.#state !== 'starting' && this.#state !== 'running' && this.#state !== 'stopping') return
    this.#handOverWaiting()
    this.#stoppedAtUs = this.#capture?.clock()
    this.#closeWithheldGap()
    this.#endedEarly = targetLost ? `The page ended: ${reason}.` : `The capture ended: ${reason}.`
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
    clearInterval(this.#lossPoll)
    this.#lossPoll = undefined
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

async function replyWithin(sent: Promise<unknown>, timeoutMs: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([sent, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`WebKit's screencast start did not answer within ${timeoutMs} ms.`)), Math.max(1, timeoutMs))
    })])
  } finally { clearTimeout(timer) }
}

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
