import type { CaptureAvailability, CaptureStart, CaptureStats, CapturedFrame, CaptureSuspension, FrameSource, StartCapture } from '../media/capture.ts'
import type { PixelDecision, PixelRequest } from '../media/policy.ts'
import type { CaptureSourceName, RecordIdentity } from '../protocol/identity.ts'
import { bounded } from './bounded.ts'
import { errorMessage } from '../protocol/failures.ts'

/** What a policed source asks of the pixel capture policy: a decision on one frame. `PixelCapturePolicy` is one. */
export type FrameJudge = { decide(request: PixelRequest): PixelDecision }

/**
 * How a policed source is made. `open` gives a new source of the session each time it is called, since a source
 * captures once; `judge`, when the run has a pixel policy, decides on each frame; `suspension` is the recording's, which
 * withholds every frame while a stretch lasts; `clock` is the run's clock in whole microseconds, the one frames are
 * stamped with; `stopTimeoutMs` bounds stopping a source it replaces.
 */
export type PolicedSourceOptions = {
  readonly open: () => FrameSource
  readonly judge?: FrameJudge | undefined
  readonly suspension: CaptureSuspension
  readonly clock: () => number
  readonly stopTimeoutMs: number
  readonly runSignal?: AbortSignal | undefined
}

/**
 * A session's frame source as a recording run uses it: the target's own source, with each frame put to the pixel
 * capture policy before it is handed on, and started again after a withheld stretch.
 *
 * A screenshot uses its own request-to-arrival span. A frame without a request stamp may have been painted any time
 * since the source last started. Once its own stretch begins, the source withholds every frame, however late it comes. `withhold`
 * suspends the recording and stops its source as a stretch begins; `resume` reconciles that stop, lets frames
 * through again and starts a new capture from the same session, so frames painted after the stretch are kept. Frames the
 * policy withholds are counted in `withheld` and never handed on; `began` settles once the first capture has started, or
 * failed to.
 */
export class PolicedSource implements FrameSource {
  readonly name: CaptureSourceName
  readonly identity: RecordIdentity
  readonly #options: PolicedSourceOptions
  readonly #began = Promise.withResolvers<CaptureStart>()
  readonly #stats: CaptureStats[] = []
  readonly #problems: string[] = []
  #current: FrameSource
  #capture: StartCapture | undefined
  #startedUs = 0
  #mode: CaptureStats['mode'] | undefined
  #withheld = 0
  #stopped = false
  #restarting: Promise<boolean> | undefined
  #withholdingStop: Promise<CaptureStats | undefined> | undefined
  #cancellationStop: Promise<CaptureStats | undefined> | undefined

  constructor(options: PolicedSourceOptions) {
    this.#options = options
    this.#current = options.open()
    this.name = this.#current.name
    this.identity = this.#current.identity
  }

  /** Frames the policy withheld before they were handed on. */
  get withheld(): number {
    return this.#withheld
  }

  /** Settles once the first capture has answered its start. */
  get began(): Promise<CaptureStart> {
    return this.#began.promise
  }

  availability(): CaptureAvailability {
    const availability = this.#current.availability()
    if (availability.available) this.#mode = availability.mode
    return availability
  }

  async start(capture: StartCapture): Promise<CaptureStart> {
    this.#capture = capture
    this.#options.runSignal?.addEventListener('abort', this.#cancel, { once: true })
    if (this.#options.runSignal?.aborted === true) this.#cancel()
    const started = await this.#startCurrent(capture)
    this.#began.resolve(started)
    return started
  }

  /** Withholds frames and stops the source from now, as a stretch begins. */
  withhold(): void {
    this.#options.suspension.suspend()
    // Stop dispatch now; resume must reconcile this stop before opening a fresh source.
    this.#withholdingStop ??= this.#stopCurrent(this.#options.stopTimeoutMs)
  }

  /**
   * Ends the running capture, lets frames through again and starts a new capture from the same session, once a withheld
   * stretch has ended. Frames are let through only after the old capture has stopped, so none it painted during the
   * stretch is kept, and before the new one starts, so the first frame it sends is kept. Resolves true when the new
   * capture runs; false when it could not start, and then capture ends with the reason, since the session would
   * otherwise go on unrecorded with nothing said.
   */
  resume(): Promise<boolean> {
    this.#restarting ??= this.#restart().finally(() => {
      this.#restarting = undefined
    })
    return this.#restarting
  }

  async stop(timeoutMs: number): Promise<CaptureStats> {
    this.#stopped = true
    this.#options.runSignal?.removeEventListener('abort', this.#cancel)
    if (this.#restarting !== undefined) await bounded(this.#restarting, timeoutMs)
    const last = await (this.#cancellationStop ?? this.#stopCurrent(timeoutMs))
    return this.#combined(last)
  }

  // Stop all sources synchronously at the signal boundary; each reconciles its own dispatched grab.
  readonly #cancel = (): void => {
    this.#stopped = true
    this.#cancellationStop ??= this.#withholdingStop ?? this.#stopCurrent(this.#options.stopTimeoutMs)
  }

  async #restart(): Promise<boolean> {
    const capture = this.#capture
    if (capture === undefined || this.#stopped) return false
    const last = await (this.#withholdingStop ?? this.#stopCurrent(this.#options.stopTimeoutMs))
    this.#withholdingStop = undefined
    if (last === undefined || last.problems.length > 0) {
      capture.ended('The old capture could not be confirmed stopped after a withheld stretch.')
      return false
    }
    this.#stats.push(last)
    if (this.#stopped) return false
    this.#options.suspension.resume()
    let next: FrameSource
    try {
      next = this.#options.open()
    } catch (error) {
      capture.ended(`The capture could not start again after a withheld stretch: ${errorMessage(error)}`)
      return false
    }
    this.#current = next
    const started = await this.#startCurrent(capture)
    if (started.ok) return true
    capture.ended(`The capture could not start again after a withheld stretch: ${started.reason}`)
    return false
  }

  async #startCurrent(capture: StartCapture): Promise<CaptureStart> {
    if (this.#options.runSignal?.aborted === true) return { ok: false, reason: 'The run stopped before UI capture could start.' }
    const source = this.#current
    // A screencast frame may have been painted any time since its screencast was asked to start.
    this.#startedUs = this.#options.clock()
    const startedUs = this.#startedUs
    const deliver = (frame: CapturedFrame): void => {
      if (source !== this.#current || this.#options.runSignal?.aborted === true) return
      const judge = this.#options.judge
      const decision = judge?.decide({ identity: this.identity, use: 'recording', source: this.name, span: { earliestUs: frame.earliestUs ?? startedUs, arrivedUs: frame.timestampUs } })
      if (decision !== undefined && !decision.capture) {
        this.#withheld += 1
        // Another session's stretch can open and close while this Mac window capture is already in flight.
        try { capture.gap?.({ fromUs: frame.earliestUs ?? startedUs, toUs: frame.timestampUs, reason: 'pixels_withheld' }) }
        catch (error) { if (this.#problems.length < 8) this.#problems.push(`Reporting withheld capture failed: ${errorMessage(error)}`) }
        return
      }
      capture.deliver(frame)
    }
    const ended = (reason: string): void => {
      if (source === this.#current && !this.#stopped) capture.ended(reason)
    }
    try {
      const result = await bounded(source.start({ ...capture, deliver, ended,
        // The policy also withholds a Mac window capture while another session exposes pixels.
        withheld: () => capture.withheld?.() === true || this.#options.suspension.suspended || this.#options.judge?.decide({ identity: this.identity, use: 'recording', source: this.name }).capture === false,
      }), capture.timeoutMs)
      if (result.status === 'done') {
        if (result.value.ok) this.#mode = result.value.mode
        return result.value
      }
      return { ok: false, reason: result.status === 'failed' ? errorMessage(result.error) : 'The capture did not answer its start within its budget.' }
    } catch (error) {
      return { ok: false, reason: errorMessage(error) }
    }
  }

  async #stopCurrent(timeoutMs: number): Promise<CaptureStats | undefined> {
    try {
      const result = await bounded(this.#current.stop(timeoutMs), timeoutMs)
      if (result.status === 'done') return result.value
      this.#problems.push(result.status === 'failed' ? `Stopping the ${this.name} capture failed: ${errorMessage(result.error)}` : `The ${this.name} capture did not stop within ${timeoutMs} ms.`)
      return undefined
    } catch (error) {
      this.#problems.push(`Stopping the ${this.name} capture failed: ${errorMessage(error)}`)
      return undefined
    }
  }

  // The stats of every capture this source ran, added up: the first one's mode and start, the last one's stop.
  #combined(last: CaptureStats | undefined): CaptureStats {
    const all = last === undefined ? this.#stats : [...this.#stats, last]
    const [first] = all
    const final = all.at(-1)
    if (first === undefined || final === undefined) {
      if (this.#mode === undefined) throw new Error('The source returned no capture stats and its capture mode is unknown.')
      return { mode: this.#mode, requestedFps: this.#capture?.fps ?? 0, delivered: 0, superseded: 0, dropped: 0, problems: [...this.#problems] }
    }
    const sum = (pick: (stats: CaptureStats) => number | undefined): number => all.reduce((total, stats) => total + (pick(stats) ?? 0), 0)
    const latencies = all.flatMap(stats => stats.captureMs !== undefined && stats.captureMs.count > 0 ? [stats.captureMs] : [])
    const count = latencies.reduce((total, latency) => total + latency.count, 0)
    const captureMs = count === 0 ? undefined : {
      count,
      minMs: Math.min(...latencies.map(latency => latency.minMs)),
      meanMs: Math.round(latencies.reduce((total, latency) => total + latency.count * latency.meanMs, 0) / count * 10) / 10,
      maxMs: Math.max(...latencies.map(latency => latency.maxMs)),
    }
    const durationUs = first.startedAtUs === undefined || final.stoppedAtUs === undefined ? 0 : final.stoppedAtUs - first.startedAtUs
    const mapping = all.find(stats => stats.clockMapping !== undefined)?.clockMapping
    const mappingChanged = all.some(stats => stats.clockMapping !== undefined && JSON.stringify(stats.clockMapping) !== JSON.stringify(mapping))
    return {
      mode: first.mode,
      requestedFps: first.requestedFps,
      ...(mapping === undefined ? {} : { clockMapping: { ...mapping } }),
      ...(durationUs <= 0 ? {} : { achievedFps: Math.round(sum(stats => stats.delivered) / (durationUs / 1_000_000) * 100) / 100 }),
      ...(captureMs === undefined ? {} : { captureMs }),
      delivered: sum((stats) => stats.delivered),
      superseded: sum((stats) => stats.superseded),
      dropped: sum((stats) => stats.dropped),
      ...(first.skippedTicks === undefined ? {} : { skippedTicks: sum((stats) => stats.skippedTicks) }),
      ...(first.withheldTicks === undefined ? {} : { withheldTicks: sum((stats) => stats.withheldTicks) }),
      ...(first.startedAtUs === undefined ? {} : { startedAtUs: first.startedAtUs }),
      ...(final.stoppedAtUs === undefined ? {} : { stoppedAtUs: final.stoppedAtUs }),
      ...(first.firstTimestampUs === undefined ? {} : { firstTimestampUs: first.firstTimestampUs }),
      ...(final.lastTimestampUs === undefined ? {} : { lastTimestampUs: final.lastTimestampUs }),
      ...(final.endedEarly === undefined ? {} : { endedEarly: final.endedEarly }),
      problems: [...all.flatMap((stats) => stats.problems), ...this.#problems, ...(mappingChanged ? ['Capture clock mapping changed after restart; the retained mapping describes the first capture and later read-window provenance is unknown.'] : [])],
    }
  }
}
