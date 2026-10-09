import type { NewPageOptions, SessionIdentity } from '../../src/browser/contract.ts'
import type { CaptureAvailability, CaptureStart, CaptureStats, FrameSource, StartCapture } from '../../src/media/capture.ts'
import type { FrameOutcome } from '../../src/media/client.ts'
import type { CaptureGap, Ended, EncoderProbe, FrameHeader, FrameSequence, FrameSequenceRequest, Hello, Leftovers, Released, StartRecording, Started } from '../../src/media/protocol.ts'
import type { RetestEvent } from '../../src/protocol/events.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import type { RunResult } from '../../src/protocol/result.ts'
import type { LaunchBrowser } from '../../src/runner/browser-pool.ts'
import type { ChildOutput, RunOptions } from '../../src/runner/contract.ts'
import type { RunMediaProcess, StartMedia } from '../../src/runner/run-media.ts'
import type { ProcessExit } from '../../src/shared/process-exit.ts'
import type { FakeOptions } from '../support/fake-browser.ts'
import type { RunRecord } from '../support/run-harness.ts'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mediaTarget } from '../../src/cli/install/media-pins.ts'
import { configFileName, loadConfig } from '../../src/config/load.ts'
import { RunSession } from '../../src/runner/run-session.ts'
import { resolveSecrets } from '../../src/runner/secrets.ts'
import { RunStore } from '../../src/store/run-store.ts'
import { FakeBrowser, FakePage } from '../support/fake-browser.ts'
import { fakeExecutable } from '../support/project.ts'
import { newRunFolder, quickTimeouts, readEvents, readResult } from '../support/run-harness.ts'

/** A frame as the stand-in media process received it. */
export type ReceivedFrame = Omit<FrameHeader, 'recordingId'> & { bytes: number }

/** How the stand-in media process behaves. */
export type FakeMediaOptions = {
  /** What its encoder probe answers; ready with h264 in mp4 unless given. */
  encoder?: EncoderProbe
  /** A finish that never answers, as a wedged process's. */
  finishHangs?: boolean
  /** A close that never answers, as a wedged process's. */
  closeHangs?: boolean
  /** What `leftovers` answers for an output. */
  leftovers?: (output: string, remove: boolean) => Leftovers
}

const readyEncoder: EncoderProbe = { state: 'ready', version: '9.0.2', codec: 'h264', container: 'mp4', encoder: 'libx264', encodedInput: ['png', 'jpeg'], probeMs: 20 }

/**
 * One recording as the stand-in process keeps it: what started it, every frame and capture gap it received, and its
 * ending. Its finish writes a small file where the video goes, so the run finds one there.
 */
export class FakeRecording {
  readonly started: Started
  readonly start: StartRecording
  readonly frames: ReceivedFrame[] = []
  readonly gaps: CaptureGap[] = []
  readonly #ended = Promise.withResolvers<Ended>()
  readonly #media: FakeMedia
  #finished = false
  lost = false

  constructor(media: FakeMedia, start: StartRecording, pid: number) {
    this.#media = media
    this.start = start
    this.started = {
      type: 'started', recordingId: start.recordingId, identity: start.identity, codec: 'h264', container: 'mp4', encoder: 'libx264', encoderVersion: '9.0.2', encoderPid: pid,
      path: `${start.output}.mp4`, route: 'decoded', width: start.width, height: start.height, fps: start.fps, queueFrames: 60, queueBytes: 64 * 1024 * 1024,
      maxGapMs: start.maxGapMs ?? 10_000, maxDurationMs: start.maxDurationMs ?? 1_800_000, stallMs: 10_000, ...(start.keepFrames === false ? {} : { framesPath: `${start.output}.frames` }),
    }
    this.#ended.promise.catch(() => undefined)
  }

  get ended(): Promise<Ended> {
    return this.#ended.promise
  }

  frame(frame: { frameId: string; observationId?: string; timestampUs: number; format: 'png' | 'jpeg'; bytes: Uint8Array }): FrameOutcome {
    if (this.lost) return 'not_sent'
    if (this.#finished) return 'closed'
    this.frames.push({ frameId: frame.frameId, timestampUs: frame.timestampUs, format: frame.format, bytes: frame.bytes.byteLength, ...(frame.observationId === undefined ? {} : { observationId: frame.observationId }) })
    return 'sent'
  }

  captureGap(gap: CaptureGap): boolean {
    if (this.lost || this.#finished) return false
    this.gaps.push({ ...gap })
    return true
  }

  finish(timeoutMs: number, endTimestampUs?: number): Promise<Ended> {
    if (this.lost) return Promise.reject(new Error('the media process ended before the recording did'))
    this.#finished = true
    if (this.#media.options.finishHangs === true) {
      return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`the media process did not finish the recording within ${timeoutMs} ms`)), timeoutMs))
    }
    const [first] = this.frames
    const end = endTimestampUs ?? this.frames.at(-1)?.timestampUs ?? 0
    const shown = this.frames.length
    const ok = shown > 0
    if (ok) writeFileSync(this.started.path, 'video')
    const ended: Ended = {
      type: 'ended', recordingId: this.start.recordingId, identity: this.start.identity, status: ok ? 'ok' : 'no_frames', message: ok ? 'Wrote the video.' : 'No frame came.',
      ...(ok ? { path: this.started.path, placedBy: 'link' as const } : {}),
      frames: { received: shown, shown, superseded: 0, dropped: 0, outOfOrder: 0, outOfRange: 0, undecodable: 0, duplicate: 0, unprocessed: 0, resized: 0 },
      ...(first === undefined ? {} : { firstTimestampUs: first.timestampUs }), framesBeforeFirst: 0, gaps: [], gapsShortened: 0, endClipped: false,
      outputFrames: shown, durationUs: first === undefined ? 0 : Math.max(0, end - first.timestampUs), bytesReceived: 0, bytesToEncoder: 0,
      queue: { peakFrames: 1, peakBytes: 4, saturated: 0 }, captureGaps: this.gaps.slice(0, 64), captureGapsReported: this.gaps.length,
      evidence: ok ? { status: this.gaps.length === 0 ? 'complete' : 'partial', reasons: this.gaps.length === 0 ? [] : ['capture_gaps'] } : { status: 'unavailable', reasons: ['no_frames'] },
      frameMapEntries: shown, frameMapOmitted: 0, frameMap: this.frames.map((frame) => ({ frameId: frame.frameId, captureUs: frame.timestampUs, fate: 'shown' as const })),
    }
    this.#ended.resolve(ended)
    return Promise.resolve(ended)
  }

  lose(): void {
    this.lost = true
    this.#ended.reject(new Error('the media process ended before the recording did'))
  }
}

/**
 * A stand-in for `retest-media`: it greets, says its encoder is ready, keeps every recording it starts, and can be made
 * to crash, wedge, or answer `leftovers`. No process runs.
 */
export class FakeMedia implements RunMediaProcess {
  static #nextPid = 900_001
  // The runner accepts only a greeting for this machine's pinned target; a machine with none records nothing at all.
  readonly hello: Hello = { type: 'hello', protocol: 2, version: '0.1.0', build: { target: mediaTarget() ?? 'aarch64-apple-darwin', profile: 'release' }, ffmpeg: '/fake/ffmpeg', encoder: { state: 'probing' } }
  readonly pid: number = FakeMedia.#nextPid++
  readonly options: FakeMediaOptions
  readonly recordings: FakeRecording[] = []
  readonly leftoverRequests: { output: string; remove: boolean }[] = []
  readonly released: string[] = []
  readonly #exited = Promise.withResolvers<ProcessExit>()
  closes = 0
  crashed = false

  constructor(options: FakeMediaOptions = {}) {
    this.options = options
  }

  get exited(): Promise<ProcessExit> {
    return this.#exited.promise
  }

  ready(): Promise<EncoderProbe> {
    return Promise.resolve(this.options.encoder ?? readyEncoder)
  }

  async record(start: StartRecording): Promise<{ kind: 'started'; recording: FakeRecording }> {
    if (this.crashed) throw new Error('the media process has ended')
    const recording = new FakeRecording(this, start, this.pid + 1000)
    this.recordings.push(recording)
    return { kind: 'started', recording }
  }

  frames(recordingId: string, request: FrameSequenceRequest): Promise<FrameSequence> {
    const recording = this.recordings.find((each) => each.start.recordingId === recordingId)
    const inside = (recording?.frames ?? []).filter((frame) => frame.timestampUs >= request.fromUs && frame.timestampUs <= request.toUs)
    const sequence: FrameSequence = { type: 'frames', requestId: 'r', recordingId, status: 'ok', recording: 'running', fromUs: request.fromUs, toUs: request.toUs, inInterval: inside.length, available: inside.length, frames: [], omitted: { byCount: 0, byBytes: 0, undecodable: 0 }, stretches: [], stretchesFound: 0 }
    return Promise.resolve(sequence)
  }

  release(recordingId: string): Promise<Released> {
    this.released.push(recordingId)
    return Promise.resolve({ type: 'released', recordingId, reason: 'requested', removed: [] })
  }

  leftovers(output: string, options: { remove: boolean }): Promise<Leftovers> {
    this.leftoverRequests.push({ output, remove: options.remove })
    return Promise.resolve(this.options.leftovers?.(output, options.remove) ?? { type: 'leftovers', requestId: 'l', status: 'ok', output, files: [], removed: false, skipped: [] })
  }

  close(): Promise<{ code: number | null; signal: NodeJS.Signals | null; forced: boolean; bye: undefined }> {
    this.closes += 1
    if (this.options.closeHangs === true) return new Promise(() => undefined)
    if (!this.crashed) this.#exited.resolve({ code: 0, signal: null })
    return Promise.resolve({ code: this.crashed ? null : 0, signal: this.crashed ? 'SIGKILL' : null, forced: false, bye: undefined })
  }

  /** Ends the process as a crash would: every running recording is lost. */
  crash(): void {
    this.crashed = true
    for (const recording of this.recordings) recording.lose()
    this.#exited.resolve({ code: null, signal: 'SIGKILL' })
  }
}

/** Starts stand-in media processes and keeps each, or refuses to start, as a missing binary would. */
export function fakeMediaStarter(options: FakeMediaOptions & { refuse?: string } = {}): { start: StartMedia; started: FakeMedia[] } {
  const started: FakeMedia[] = []
  const start: StartMedia = async () => {
    if (options.refuse !== undefined) throw new Error(options.refuse)
    const media = new FakeMedia(options)
    started.push(media)
    return media
  }
  return { start, started }
}

/**
 * A stand-in screencast: once started it hands over a small JPEG every `everyMs`, stamped with the recording's clock,
 * until stopped, and `end` ends it as a page that went away would.
 */
export class FakeFrameSource implements FrameSource {
  readonly name = 'chromium'
  readonly identity: RecordIdentity
  readonly #everyMs: number
  #capture: StartCapture | undefined
  #timer: NodeJS.Timeout | undefined
  delivered = 0
  stopped = false

  constructor(identity: RecordIdentity, everyMs: number) {
    this.identity = identity
    this.#everyMs = everyMs
  }

  availability(): CaptureAvailability {
    return { available: true, mode: 'screencast' }
  }

  start(capture: StartCapture): Promise<CaptureStart> {
    this.#capture = capture
    const send = (): void => {
      this.delivered += 1
      capture.deliver({ identity: this.identity, timestampUs: capture.clock(), format: 'jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]) })
    }
    send()
    this.#timer = setInterval(send, this.#everyMs)
    return Promise.resolve({ ok: true, mode: 'screencast' })
  }

  stop(): Promise<CaptureStats> {
    this.stopped = true
    clearInterval(this.#timer)
    return Promise.resolve({ mode: 'screencast', requestedFps: 10, delivered: this.delivered, superseded: 0, dropped: 0, problems: [] })
  }

  end(reason: string): void {
    clearInterval(this.#timer)
    this.#capture?.ended(reason)
  }
}

/** A fake page that also offers a frame source, as a Chromium page does, and keeps every source it handed out. */
export class FramedPage extends FakePage {
  readonly sources: FakeFrameSource[] = []
  named: SessionIdentity | undefined

  identify(session: SessionIdentity): void {
    this.named = session
  }

  frameSource(identity: RecordIdentity): FrameSource {
    const source = new FakeFrameSource(identity, 20)
    this.sources.push(source)
    return source
  }
}

/** A fake browser whose pages offer frames. */
export class FramedBrowser extends FakeBrowser {
  readonly framed: FramedPage[] = []

  override async newPage(options: NewPageOptions, timeoutMs: number): Promise<FakePage> {
    this.pageBudgets.push(timeoutMs)
    if (!this.connected) throw new Error('The browser is not connected.')
    const page = new FramedPage(this, options)
    this.pages.push(page)
    this.framed.push(page)
    return page
  }
}

/** A launcher of fake browsers whose pages offer frames. */
export function framedLauncher(options: FakeOptions = {}): { launch: LaunchBrowser; browsers: FramedBrowser[] } {
  const browsers: FramedBrowser[] = []
  const launch: LaunchBrowser = async (launchOptions) => {
    const browser = new FramedBrowser(options, launchOptions, 700_000 - browsers.length)
    browsers.push(browser)
    return browser
  }
  return { launch, browsers }
}

export type RecordedRun = Omit<RunRecord, 'browsers'> & { root: string; browsers: FramedBrowser[] }

export type RecordedRunOptions = {
  files: readonly string[]
  onEvent?: (event: RetestEvent) => void
  env?: Readonly<Record<string, string | undefined>>
  startMedia?: StartMedia
  discoverMedia?: import('../../src/runner/run-media.ts').DiscoverMedia
  fake?: FakeOptions
  signal?: AbortSignal
  folder?: string
  timeouts?: Partial<RunOptions['timeouts']>
} & Pick<RunOptions, 'recording' | 'media'>

/** Loads the project's config and runs its files on fake browsers whose pages offer frames, with the media process given. */
export async function recordProject(root: string, options: RecordedRunOptions): Promise<RecordedRun> {
  const loaded = await loadConfig(join(root, configFileName))
  assert.ok(loaded.ok, `the config loads: ${loaded.ok ? '' : loaded.failure.message}`)
  const secrets = resolveSecrets(loaded.config, options.env ?? {})
  assert.ok(secrets.ok, `the secrets resolve: ${secrets.ok ? '' : secrets.failure.message}`)
  const folder = options.folder ?? newRunFolder()
  const { launch, browsers } = framedLauncher(options.fake)
  const output: ChildOutput[] = []
  const store = RunStore.create(folder)
  let result: RunResult
  try {
    const runOptions: RunOptions = {
      files: [...options.files],
      rootDir: root,
      apps: { kind: 'config', config: loaded.config, secrets: secrets.secrets },
      timeouts: { ...quickTimeouts, ...options.timeouts },
      outputDir: folder,
      headless: true,
      workers: 1,
      signal: options.signal ?? new AbortController().signal,
      onOutput: (chunk) => void output.push(chunk),
      lastRunFile: false,
      ...(options.recording === undefined ? {} : { recording: options.recording }),
      // A stand-in media process needs no binary, so a run given one names a place for it unless the test names its own.
      ...(options.media !== undefined ? { media: options.media } : options.startMedia === undefined ? {} : { media: { executable: '/fake/retest-media' } }),
    }
    result = await new RunSession({ options: runOptions, reporters: options.onEvent === undefined ? [] : [{ name: 'recording-test', onEvent: options.onEvent, onRunEnd: () => undefined }], launch, findExecutable: fakeExecutable, store, ...(options.startMedia === undefined ? {} : { startMedia: options.startMedia }), ...(options.discoverMedia === undefined ? {} : { discoverMedia: options.discoverMedia }) }).run()
  } finally {
    store.close()
  }
  const { events, lines } = readEvents(folder)
  return { result, events, lines, folder, browsers, output, written: readResult(folder), root }
}
