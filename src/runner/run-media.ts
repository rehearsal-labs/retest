import type { OwnedPage, WebSession } from '../browser/contract.ts'
import type { RecordingSettings } from '../config/read-recording.ts'
import type { AttemptRecording, AttemptRecordings, StepSpan } from '../evaluation/frames.ts'
import type { FrameSource, MediaRecorder, SourceRecording } from '../media/capture.ts'
import type { MediaExit } from '../media/client.ts'
import type { EncoderProbe, FrameSequence, FrameSequenceRequest, Hello, Leftovers, Released, Started } from '../media/protocol.ts'
import type { EventBody } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { EvidenceGapCode, LeftoverRecord, RecordingRecord } from '../protocol/recording.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { ArtifactSequences } from '../store/artifacts.ts'
import type { MediaLocation } from './contract.ts'
import type { FrameJudge } from './policed-source.ts'
import type { AppPage } from './test-pages.ts'
import { join } from 'node:path'
import { CaptureSuspension, recordSource } from '../media/capture.ts'
import { mediaGreetingProblem } from '../media/build-identity.ts'
import { locateMedia } from '../media/locate.ts'
import { MediaProcess, mediaArguments } from '../media/client.ts'
import { Deadline } from '../protocol/deadline.ts'
import { errorMessage, failure } from '../protocol/failures.ts'
import { eventsFile } from '../protocol/run-folder.ts'
import { checkArtifact, createArtifactFolder, portableReference, recordingOutput } from '../store/artifacts.ts'
import { bounded } from './bounded.ts'
import { endedRecording, unstartedRecording } from './evidence-status.ts'
import { outputPath, ownStartTime, processRuns, unfinishedRuns } from './media-leftovers.ts'
import { PolicedSource } from './policed-source.ts'

/** What a run needs of its media process. `MediaProcess` is one; tests pass a stand-in. */
export type RunMediaProcess = MediaRecorder & {
  readonly hello: Hello
  readonly pid: number
  readonly exited: Promise<ProcessExit>
  ready(timeoutMs: number): Promise<EncoderProbe>
  frames(recordingId: string, request: FrameSequenceRequest, timeoutMs: number): Promise<FrameSequence>
  release(recordingId: string, timeoutMs: number): Promise<Released>
  leftovers(output: string, options: { remove: boolean }, timeoutMs: number): Promise<Leftovers>
  close(timeoutMs: number): Promise<MediaExit>
}

/** Starts the media process from where it is, within `timeoutMs`; throws when it cannot. */
export type StartMedia = (location: MediaLocation, timeoutMs: number, env?: Readonly<Record<string, string | undefined>>, signal?: AbortSignal) => Promise<RunMediaProcess>

/** Retest's own start of `retest-media`, as `MediaProcess` does it. */
export const startMediaProcess: StartMedia = (location, timeoutMs, env, signal) =>
  MediaProcess.start({ executable: location.executable, args: mediaArguments(location.ffmpeg === undefined ? {} : { ffmpeg: location.ffmpeg }), startTimeoutMs: timeoutMs, installHint: 'npx retest install media', ...(env === undefined ? {} : { env }), ...(signal === undefined ? {} : { signal }) })

/** Resolves recording tools without starting a second media process. */
export type DiscoverMedia = (given: MediaLocation | undefined, env: Readonly<Record<string, string | undefined>>, timeoutMs: number, signal?: AbortSignal) => Promise<MediaLocation | string>

export const discoverMediaLocation: DiscoverMedia = async (given, env, timeoutMs, signal) => {
  const found = await locateMedia({ ...given, env, timeoutMs, mode: 'discover', ...(signal === undefined ? {} : { signal }) })
  return found.ok ? { executable: found.executable, ffmpeg: found.ffmpeg } : found.message
}

/** The media process for a recording, which of the run's starts it is, or why the run has none. */
export type AcquiredMedia = { ok: true; process: RunMediaProcess; start: number } | { ok: false; code: EvidenceGapCode; message: string }

/** The budgets of the media process: starting it and waiting for its encoder, closing it, and each leftovers request. */
export type RunMediaTimeouts = { readonly start: number; readonly close: number; readonly leftovers: number }

export type RunMediaOptions = {
  readonly location: MediaLocation | string | ((signal: AbortSignal) => Promise<MediaLocation | string>)
  readonly start: StartMedia
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly signal?: AbortSignal
  readonly emit: (body: EventBody) => void
  readonly timeouts: RunMediaTimeouts
  /** The run's folder, whose siblings the first start looks through for what killed runs left. */
  readonly runFolder: string
}

type Live = { process: RunMediaProcess; start: number; lost: boolean; closing: boolean; closeProblem?: string | undefined; closingWork?: Promise<string | undefined>; recordings: Set<string> }

// A run starts its media process once, and once more after a crash.
const maxStarts = 2

/**
 * The one media process of a run that records, started the first time a recording needs it, never before. Its greeting
 * and encoder probe are waited for; an encoder that cannot record ends it, and every recording after says so. When it
 * ends while the run needs it, `media.lost` names how many recordings it took with it, and the next recording starts it
 * once more; after a second loss nothing more is started. Its first start also looks for what killed runs beside this
 * one left, and has it removed. `close` ends every process the run started, confirmed gone through the ownership layer,
 * within its budget, and says what could not be confirmed.
 */
export class RunMedia {
  readonly #options: RunMediaOptions
  readonly #processes: Live[] = []
  #starts = 0
  #starting: Promise<AcquiredMedia> | undefined
  #refusal: { code: EvidenceGapCode; message: string } | undefined
  #sweeping: Promise<void> | undefined
  #closed = false
  readonly #discovery = new AbortController()
  readonly #shutdown = Promise.withResolvers<void>()

  constructor(options: RunMediaOptions) {
    this.#options = options
  }

  /** Whether the media process was ever started. */
  get started(): boolean {
    return this.#starts > 0
  }

  /** The media process a recording uses: the running one, a new one when none runs and the run may start one, or why not. */
  acquire(): Promise<AcquiredMedia> {
    if (this.#closed) return Promise.resolve({ ok: false, code: 'media_unavailable', message: 'The run had closed its media process.' })
    if (this.#starting !== undefined) return this.#starting
    const live = this.#processes.at(-1)
    if (live !== undefined && !live.lost && !live.closing) return Promise.resolve({ ok: true, process: live.process, start: live.start })
    if (this.#refusal !== undefined) return Promise.resolve({ ok: false, ...this.#refusal })
    this.#starting ??= this.#start().finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  /** Whether the process of start `start` ended while the run needed it. */
  wasLost(start: number): boolean {
    return this.#processes.find((live) => live.start === start)?.lost === true
  }

  /** Counts a recording on its process, so a loss can say how many it took. */
  track(start: number, recordingId: string): void {
    this.#processes.find((live) => live.start === start)?.recordings.add(recordingId)
  }

  untrack(start: number, recordingId: string): void {
    this.#processes.find((live) => live.start === start)?.recordings.delete(recordingId)
  }

  /**
   * Ends every media process the run started, the lost ones included, so their encoders are confirmed gone too, each
   * within the close budget. Returns the run's cleanup failure when a process or one of its encoders could not be
   * confirmed gone.
   */
  async close(): Promise<Failure | undefined> {
    this.#closed = true
    this.#discovery.abort()
    this.#shutdown.resolve()
    const deadline = new Deadline(this.#options.timeouts.close)
    const problems: string[] = []
    if (this.#starting !== undefined) {
      const started = await bounded(this.#starting, deadline.remainingMs)
      if (started.status !== 'done') problems.push('Media startup did not settle within the cleanup budget; its dispatched work is unknown.')
    }
    if (this.#sweeping !== undefined) {
      const swept = await bounded(this.#sweeping, deadline.remainingMs)
      if (swept.status !== 'done') problems.push('The leftover sweep did not finish within its shutdown budget.')
    }
    for (const live of this.#processes) {
      live.closing = true
      const closed = await bounded(this.#closeOne(live, deadline.remainingMs), deadline.remainingMs)
      if (closed.status === 'done') { if (closed.value !== undefined) problems.push(closed.value) }
      else problems.push('Media cleanup did not settle within the remaining cleanup budget; dispatched cleanup is unknown.')
    }
    return problems.length === 0 ? undefined : failure('cleanup_failed', `Retest could not confirm the run's media process gone: ${problems.join(' ')}`)
  }

  async #start(): Promise<AcquiredMedia> {
    this.#starts += 1
    const start = this.#starts
    const deadline = new Deadline(this.#options.timeouts.start)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, this.#discovery.signal, ...(this.#options.signal === undefined ? [] : [this.#options.signal])])
    const stopped = Promise.withResolvers<void>()
    const stop = (): void => stopped.resolve()
    signal.addEventListener('abort', stop, { once: true })
    try {
      if (signal.aborted) return this.#refuse(start, 'media_unavailable', 'Media setup was stopped before launch.')
      const work = this.#startWithin(start, deadline, signal)
      const answer = await bounded(work, deadline.remainingMs, stopped.promise)
      if (answer.status === 'done') return answer.value
      controller.abort()
      // A timeout during readiness or owner inspection must also close an already returned process.
      for (const live of this.#processes.filter(live => live.start === start)) void this.#closeOne(live)
      return this.#refuse(start, 'media_unavailable', answer.status === 'failed' ? `Media setup failed: ${errorMessage(answer.error)}` : answer.status === 'stopped' ? 'Media setup was stopped; dispatched startup work is being reconciled.' : 'Media setup exceeded its budget; discovery or startup work was abandoned.')
    } finally { signal.removeEventListener('abort', stop) }
  }

  async #startWithin(start: number, deadline: Deadline, signal: AbortSignal): Promise<AcquiredMedia> {
    const { location, timeouts, emit } = this.#options
    let started: RunMediaProcess
    let executable: string
    try {
      const resolved = typeof location === 'function' ? await this.#locate(location, deadline, signal) : location
      if (typeof resolved === 'string') return this.#refuse(start, 'media_unavailable', resolved)
      if (this.#closed || signal.aborted || deadline.reached) return { ok: false, code: 'media_unavailable', message: 'The run stopped before media discovery finished.' }
      executable = resolved.executable
      started = await this.#options.start(resolved, deadline.remainingMs, this.#options.env, signal)
    } catch (error) {
      return this.#refuse(start, 'media_unavailable', `The media process could not be started: ${errorMessage(error)}`)
    }
    const live: Live = { process: started, start, lost: false, closing: false, recordings: new Set() }
    this.#processes.push(live)
    // An abandoned starter may still return a launched process. Register it and close it before exposing it.
    if (this.#closed || signal.aborted || deadline.reached) {
      live.closing = true
      live.closeProblem = await this.#closeOne(live)
      return { ok: false, code: 'media_unavailable', message: 'Media startup finished after setup stopped; its process was closed.' }
    }
    const identityProblem = mediaGreetingProblem(executable, started.hello)
    if (identityProblem !== undefined) {
      live.closing = true
      const refused = this.#refuse(start, 'media_unavailable', identityProblem)
      const closeProblem = await this.#closeOne(live)
      if (closeProblem !== undefined) live.closeProblem = closeProblem
      return refused
    }
    let probe: EncoderProbe
    try {
      const checked = await bounded(started.ready(deadline.remainingMs), deadline.remainingMs)
      probe = checked.status === 'done' ? checked.value : {
        state: 'failed', message: checked.status === 'failed' ? errorMessage(checked.error) : 'The encoder probe did not answer within its budget.', probeMs: timeouts.start,
      }
    } catch (error) {
      probe = { state: 'failed', message: errorMessage(error), probeMs: 0 }
    }
    if (probe.state !== 'ready') {
      // An encoder that cannot record will not on the next start either; the process is ended, and nothing more starts.
      live.closing = true
      const message = probe.state === 'probing' ? 'The media process did not say whether its encoder can record.' : probe.message
      const refused = this.#refuse(start, 'encoder_unavailable', `The media process's ffmpeg cannot record: ${message}`)
      const closeProblem = await this.#closeOne(live)
      if (closeProblem !== undefined) live.closeProblem = closeProblem
      return refused
    }
    const ownerStartedAt = await ownStartTime()
    if (this.#closed || signal.aborted || deadline.reached) {
      await this.#closeOne(live)
      return { ok: false, code: 'media_unavailable', message: 'Media setup stopped before its process could be used.' }
    }
    const { build } = started.hello
    emit({
      type: 'media.started',
      media: {
        pid: started.pid,
        start,
        version: started.hello.version,
        protocol: started.hello.protocol,
        build: { target: build.target, profile: build.profile, ...(build.revision === undefined ? {} : { revision: build.revision }), ...(build.dirty === undefined ? {} : { dirty: build.dirty }) },
        ffmpeg: started.hello.ffmpeg,
        encoder: { state: 'ready', codec: probe.codec, container: probe.container, encoder: probe.encoder, version: probe.version },
        owner: { startTimeVersion: 1, pid: process.pid, ...(ownerStartedAt === undefined ? {} : { startedAt: ownerStartedAt }) },
      },
    })
    void started.exited.then((exit) => {
      if (live.closing) return
      live.lost = true
      const restart = this.#starts < maxStarts
      if (!restart) this.#refusal = { code: 'media_process_lost', message: `The media process ended ${maxStarts} times in this run, so Retest started it no more.` }
      emit({ type: 'media.lost', pid: started.pid, start, exit: { code: exit.code, signal: exit.signal }, recordings: live.recordings.size, restart })
    })
    if (start === 1) this.#sweeping = this.#sweep(started)
    return { ok: true, process: started, start }
  }

  async #locate(location: (signal: AbortSignal) => Promise<MediaLocation | string>, deadline: Deadline, signal: AbortSignal): Promise<MediaLocation | string> {
    const answer = await bounded(Promise.resolve().then(() => location(signal)), deadline.remainingMs)
    if (answer.status === 'done') return answer.value
    return answer.status === 'failed' ? `Media discovery failed: ${errorMessage(answer.error)}` : 'Media discovery exceeded its setup budget.'
  }

  #refuse(start: number, code: 'media_unavailable' | 'encoder_unavailable', message: string): AcquiredMedia {
    this.#refusal = { code, message }
    this.#options.emit({ type: 'media.failed', start, code, message })
    return { ok: false, code, message }
  }

  #closeOne(live: Live, budget: number = this.#options.timeouts.close): Promise<string | undefined> {
    live.closing = true
    live.closingWork ??= this.#closeProcess(live, budget).then(problem => { live.closeProblem = problem; return problem })
    return live.closingWork
  }

  async #closeProcess(live: Live, budget: number): Promise<string | undefined> {
    const { emit } = this.#options
    const { process: media, start } = live
    // The client bounds its own close; the wait here only keeps a broken stand-in from holding the run.
    const stopped = Promise.withResolvers<void>()
    const stop = (): void => stopped.resolve()
    const signal = this.#options.signal
    signal?.addEventListener('abort', stop, { once: true })
    let work: Promise<MediaExit>
    try { work = media.close(budget) } catch (error) { work = Promise.reject(error) }
    // A past run abort begins reconciliation; it must not immediately abandon this cleanup.
    // A new abort while this close is waiting still cancels the wait.
    const closed = await bounded(work, budget, stopped.promise).finally(() => signal?.removeEventListener('abort', stop))
    if (closed.status === 'done') {
      emit({ type: 'media.closed', pid: media.pid, start, forced: closed.value.forced, exit: { code: closed.value.code, signal: closed.value.signal } })
      return undefined
    }
    const problem = closed.status === 'failed' ? errorMessage(closed.error) : closed.status === 'stopped' ? 'The run cancelled the media cleanup wait; dispatched cleanup remains unknown.' : 'It did not close within its cleanup budget.'
    emit({ type: 'media.closed', pid: media.pid, start, forced: true, problems: [problem] })
    return problem
  }

  // What killed runs beside this one left: each run that recorded, never finished, and whose Retest process is gone has
  // its recordings' leftovers removed by this media process, which removes only what a lost recording leaves, never a
  // finished video. A run whose process may still be running, or could not be read, is left alone.
  async #sweep(media: RunMediaProcess): Promise<void> {
    const { emit, timeouts, runFolder } = this.#options
    for (const run of unfinishedRuns(runFolder)) {
      if (this.#closed) return
      const running = await processRuns(run.owner)
      if (running === undefined) {
        const reason = run.owner.startTimeVersion !== 1
          ? 'Retest cannot confirm the recorded start time zone; the run folder and process were left alone.'
          : 'Retest cannot confirm whether the recorded owner still runs; the run folder and process were left alone.'
        const file = join(run.folder, eventsFile)
        const problem = `${reason} The ownership record is in ${file}. Remove ${file} once no runner is running.`
        for (const reference of run.outputs) emit({ type: 'media.leftovers', previousRunId: run.runId, folder: run.folder, reference, status: 'unconfirmed', removed: [], skipped: 0, problem })
        continue
      }
      if (running) continue
      for (const reference of run.outputs) {
        if (this.#closed) return
        const output = outputPath(run.folder, reference)
        if (output === undefined) continue
        let found: Leftovers
        try {
          const settled = await bounded(media.leftovers(output, { remove: true }, timeouts.leftovers), timeouts.leftovers, this.#shutdown.promise)
          if (settled.status !== 'done') continue
          found = settled.value
        } catch {
          continue
        }
        if (found.files.length === 0 && found.status === 'ok') continue
        const removed: LeftoverRecord[] = found.files.flatMap((file) => {
          const named = portableReference(run.folder, file.path)
          return named.ok ? [{ reference: named.reference, kind: file.kind, byteLength: file.byteLength }] : []
        })
        emit({ type: 'media.leftovers', previousRunId: run.runId, folder: run.folder, reference, status: found.status, removed: found.removed ? removed : [], skipped: found.skipped.length })
      }
    }
  }
}

/** The budgets of one attempt's recordings. `deadline` is the media process's own time to finish a video. */
export type RecorderTimeouts = { readonly start: number; readonly stop: number; readonly deadline: number; readonly finish: number; readonly release: number }

export type AttemptRecorderOptions = {
  readonly media: RunMedia
  readonly runId: string
  readonly runFolder: string
  readonly testId: string
  readonly attemptId: string
  readonly settings: RecordingSettings
  /** Whether the run records the app. */
  readonly records: (app: string) => boolean
  /** Why the app's frames are kept from AI checks, when its pixel rules forbid recordings. */
  readonly withheldFrom: (app: string) => string | undefined
  readonly judge?: FrameJudge | undefined
  /** Stops every running source after run cancellation; a dispatched grab is reconciled and its image discarded. */
  readonly runSignal?: AbortSignal | undefined
  /** The run's clock in whole microseconds, the clock every event's `elapsedMs` counts. */
  readonly clock: () => number
  readonly sequences: ArtifactSequences
  readonly timeouts: RecorderTimeouts
  /** Whether recordings keep their frames for AI checks of intervals. */
  readonly keepFrames: boolean
  readonly emit: (body: EventBody) => void
}

type Active = {
  identity: RecordIdentity
  sequence: number
  recordingId: string
  output: string
  source: PolicedSource
  controller: AbortController
  report: Promise<SourceRecording>
  start: number
  process: RunMediaProcess
  started?: Started
}

/**
 * One attempt's recordings: one for each app session the run records, started before the session's first action and
 * finished once its last check is over. A session the target cannot capture, or a run without a media process, gets a
 * recording that never began, with why. Each recording's end is written as `recording.finished` before the attempt's
 * end, with its evidence apart from the test's outcome. It also gives AI checks the recordings' kept frames, and the
 * spans of the attempt's steps on the run's clock.
 */
export class AttemptRecorder implements AttemptRecordings {
  readonly #options: AttemptRecorderOptions
  readonly #active = new Map<string, Active>()
  readonly #unstarted = new Map<string, RecordingRecord>()
  readonly #order: string[] = []
  readonly #steps = new Map<string, { name: string; fromUs: number; toUs?: number }>()
  readonly #latest = new Map<string, string>()
  #finishing: Promise<RecordingRecord[]> | undefined

  constructor(options: AttemptRecorderOptions) {
    this.#options = options
  }

  /**
   * Starts a recording for each page whose app the run records, and waits until each one's capture runs or has failed
   * to start, within the start budget, so no action comes before its recording began.
   */
  async start(pages: readonly AppPage[]): Promise<void> {
    await Promise.all(pages.map((page, index) => this.#startOne(page, index)))
  }

  /** The session's recording for AI checks of its frames. */
  recording(app: string): AttemptRecording | undefined {
    const withheld = this.#options.withheldFrom(app)
    if (withheld !== undefined) return { state: 'withheld', reason: withheld }
    const unstarted = this.#unstarted.get(app)
    if (unstarted !== undefined) return { state: 'failed', reason: unstarted.gaps.map((gap) => gap.message).join(' ') }
    const active = this.#active.get(app)
    if (active === undefined) return undefined
    if (active.started === undefined) return { state: 'failed', reason: 'The recording had not begun.' }
    if (!this.#options.keepFrames) return { state: 'failed', reason: 'This run keeps no frames of its recordings: it has no judge to give them to.' }
    const { process: media, recordingId } = active
    return { state: 'recording', store: { frames: (request, timeoutMs) => media.frames(recordingId, request, timeoutMs) }, source: active.source.name }
  }

  step(name: string): StepSpan | undefined {
    const id = this.#latest.get(name)
    const span = id === undefined ? undefined : this.#steps.get(id)
    if (span === undefined) return undefined
    return span.toUs === undefined ? { fromUs: span.fromUs } : { fromUs: span.fromUs, toUs: span.toUs }
  }

  /** Notes the attempt's step events, so AI checks can ask for a step's span. */
  noteEvent(body: EventBody): void {
    if (body.type === 'step.started') {
      this.#steps.set(body.stepId, { name: body.name, fromUs: this.#options.clock() })
      this.#latest.set(body.name, body.stepId)
    } else if (body.type === 'step.finished') {
      const span = this.#steps.get(body.stepId)
      if (span !== undefined) span.toUs = this.#options.clock()
    }
  }

  /** Withholds the session's frames, as a stretch of the pixel policy begins. */
  withhold(sessionId: string): void {
    for (const active of this.#active.values()) if (active.identity.sessionId === sessionId) active.source.withhold()
  }

  /** Lets the session's frames through again and starts its capture afresh, once its stretch has ended. */
  resume(sessionId: string): Promise<unknown> {
    return Promise.all([...this.#active.values()].filter((active) => active.identity.sessionId === sessionId).map((active) => active.source.resume()))
  }

  /**
   * Stops every capture, finishes every recording and waits for each one's end within its budget, writes
   * `recording.finished` for each, and lets their kept frames go. Calling it again gives the same records.
   */
  finish(): Promise<RecordingRecord[]> {
    this.#finishing ??= this.#finish()
    return this.#finishing
  }

  async #startOne(page: AppPage, index: number): Promise<void> {
    const { app, session } = page
    const { testId, attemptId, records, sequences, media } = this.#options
    if (!records(app)) return
    const identity: RecordIdentity = { testId, attemptId, app, sessionId: session.sessionId }
    const sequence = sequences.next(identity, 'recording')
    const recordingId = `${attemptId}-${index + 1}-${sequence}`
    const place = { identity, sequence, recordingId }
    this.#order.push(app)
    const cancelled = (): boolean => {
      if (this.#options.runSignal?.aborted !== true) return false
      this.#unstarted.set(app, unstartedRecording(place, 'capture_unavailable', 'The run stopped before this recording could begin.'))
      return true
    }
    if (cancelled()) return
    const open = frameSourceOf(page.page)
    if (open === undefined) {
      this.#unstarted.set(app, unstartedRecording(place, 'no_frame_source', `Retest has no frame source for ${targetName(page)} yet, so this session was not recorded.`))
      return
    }
    const acquired = await media.acquire()
    if (cancelled()) return
    if (!acquired.ok) {
      this.#unstarted.set(app, unstartedRecording(place, acquired.code, acquired.message))
      return
    }
    const output = recordingOutput(identity, sequence)
    const folder = createArtifactFolder(this.#options.runFolder, output)
    if (!folder.ok) {
      this.#unstarted.set(app, unstartedRecording(place, 'output_failed', `Retest could not make the recording's folder: ${folder.message}`))
      return
    }
    try {
      this.#begin({ page, place, open: () => open(identity), output, absolute: folder.path, acquired })
      await this.#began(app)
    } catch (error) {
      this.#unstarted.set(app, unstartedRecording(place, 'capture_unavailable', `The capture could not be opened: ${errorMessage(error)}`))
    }
  }

  #begin(input: { page: AppPage; place: { identity: RecordIdentity; sequence: number; recordingId: string }; open: () => FrameSource; output: string; absolute: string; acquired: Extract<AcquiredMedia, { ok: true }> }): void {
    const { place, acquired, output } = input
    const { settings, timeouts, clock, judge, runId, keepFrames, media } = this.#options
    const suspension = new CaptureSuspension()
    const source = new PolicedSource({ open: input.open, judge, suspension, clock, stopTimeoutMs: timeouts.stop, runSignal: this.#options.runSignal })
    const controller = new AbortController()
    const active: Omit<Active, 'report'> = { ...place, output, source, controller, start: acquired.start, process: acquired.process }
    const recorder: MediaRecorder = {
      record: async (start, timeoutMs) => {
        const begun = await acquired.process.record(start, timeoutMs)
        if (begun.kind === 'started') {
          active.started = begun.recording.started
          media.track(acquired.start, place.recordingId)
        }
        return begun
      },
    }
    const report = recordSource(source, recorder, {
      recordingId: place.recordingId,
      runId,
      output: input.absolute,
      width: settings.size.width,
      height: settings.size.height,
      fps: settings.fps,
      deadlineMs: timeouts.deadline,
      limits: { keepFrames },
      clock,
      startTimeoutMs: timeouts.start,
      stopTimeoutMs: timeouts.stop,
      finishTimeoutMs: timeouts.finish,
      signal: this.#options.runSignal === undefined ? controller.signal : AbortSignal.any([controller.signal, this.#options.runSignal]),
      suspension,
    })
    this.#active.set(input.page.app, Object.assign(active, { report }))
  }

  // Waits until the capture runs, or its report came first because it could not begin; then says it began.
  async #began(app: string): Promise<void> {
    const active = this.#active.get(app)
    if (active === undefined) return
    const { timeouts, clock, emit } = this.#options
    const first = Promise.race([active.source.began, active.report.then(() => undefined)])
    const waited = await bounded(first, timeouts.start * 2 + 1000)
    const { started } = active
    if (waited.status !== 'done' || waited.value?.ok !== true || started === undefined) return
    const { identity } = active
    emit({
      type: 'recording.started',
      testId: identity.testId,
      attemptId: identity.attemptId,
      session: identity.app,
      sessionId: identity.sessionId,
      recordingId: active.recordingId,
      number: active.sequence,
      source: active.source.name,
      mode: waited.value.mode,
      path: `${active.output}.${started.container}`,
      fps: started.fps,
      width: started.width,
      height: started.height,
      codec: started.codec,
      container: started.container,
      route: started.route,
      keepFrames: started.framesPath !== undefined,
      startedUs: clock(),
    })
  }

  async #finish(): Promise<RecordingRecord[]> {
    const { emit } = this.#options
    for (const active of this.#active.values()) active.controller.abort()
    const ended = new Map<string, RecordingRecord>()
    await Promise.all([...this.#active].map(async ([app, active]) => ended.set(app, await this.#ended(active))))
    // Kept frames are let go once no check can ask for them; the process removes them at its close anyway.
    await Promise.all([...this.#active.values()].map((active) => this.#release(active)))
    const records: RecordingRecord[] = []
    for (const app of this.#order) {
      const record = ended.get(app) ?? this.#unstarted.get(app)
      if (record === undefined) continue
      records.push(record)
      emit({ type: 'recording.finished', testId: record.testId, attemptId: record.attemptId, session: record.app, sessionId: record.sessionId, recording: record })
    }
    return records
  }

  async #ended(active: Active): Promise<RecordingRecord> {
    const { timeouts, media, runFolder } = this.#options
    const place = { identity: active.identity, sequence: active.sequence, recordingId: active.recordingId }
    const limit = timeouts.stop + timeouts.finish + timeouts.start + 2000
    const settled = await bounded(active.report, limit)
    media.untrack(active.start, active.recordingId)
    if (settled.status !== 'done') return unstartedRecording(place, 'recording_lost', `No report came for this recording within ${limit} ms.`)
    const report = settled.value
    const finished = report.ended
    const video = finished?.status === 'ok' && finished.path !== undefined ? portableReference(runFolder, finished.path) : undefined
    const container = active.started?.container
    const partial = finished?.partialPath === undefined ? partialLeft(runFolder, active.output, container) : referenceOf(runFolder, finished.partialPath)
    const checked = video?.ok === true ? checkArtifact(runFolder, video.reference, { maxBytes: Number.MAX_SAFE_INTEGER }) : undefined
    return endedRecording(place, report, {
      path: video?.ok === true && checked?.ok === true && checked.artifact.size > 0 ? video.reference : undefined,
      partialPath: partial,
      withheldBeforeSending: active.source.withheld,
      mediaLost: media.wasLost(active.start),
    })
  }

  async #release(active: Active): Promise<void> {
    const { media, timeouts } = this.#options
    if (active.started?.framesPath === undefined || media.wasLost(active.start)) return
    try {
      await bounded(active.process.release(active.recordingId, timeouts.release), timeouts.release)
    } catch {
      // A release that fails leaves the kept frames to the process's close, which removes them.
    }
  }
}

// A page offers frames when its driver gives it a frame source; one that does not has none yet.
function frameSourceOf(page: OwnedPage): ((identity: RecordIdentity) => FrameSource) | undefined {
  if (!hasFrameSource(page)) return undefined
  return (identity) => page.frameSource(identity)
}

function hasFrameSource(page: OwnedPage): page is WebSession & { frameSource(identity: RecordIdentity): FrameSource } {
  return 'frameSource' in page && typeof page.frameSource === 'function'
}

function targetName({ session }: AppPage): string {
  const { runtime } = session
  if (runtime.kind === 'web') return runtime.engine === 'firefox' ? 'Firefox pages' : runtime.engine === 'webkit' ? 'WebKit pages' : 'this page'
  return runtime.kind === 'macos' ? 'macOS apps' : 'iOS simulator apps'
}


// The partial file a lost recording's encoder left, as a reference, when one is there.
function partialLeft(runFolder: string, output: string, container: 'mp4' | 'webm' | undefined): string | undefined {
  if (container === undefined) return undefined
  const reference = `${output}.${container}.partial`
  const checked = checkArtifact(runFolder, reference, { maxBytes: Number.MAX_SAFE_INTEGER })
  return checked.ok ? reference : undefined
}

function referenceOf(runFolder: string, path: string): string | undefined {
  const named = portableReference(runFolder, path)
  return named.ok ? named.reference : undefined
}
