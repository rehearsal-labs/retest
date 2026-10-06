import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { OwnedProcessIdentity, ProcessOwnershipSystem } from '../shared/process-ownership.ts'
import type {
  Bye,
  CaptureGap,
  EncoderProbe,
  Ended,
  FrameFormat,
  FrameSequence,
  FrameSequenceRequest,
  Hello,
  Leftovers,
  LiveFrame,
  MediaError,
  MediaReply,
  MediaRequest,
  Ready,
  RecordingIdentity,
  Released,
  StartRecording,
  Started,
  Thumbnail,
  ThumbnailRequest,
  WatchEnded,
  Watching,
  WatchOptions,
} from './protocol.ts'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, unlinkSync } from 'node:fs'
import { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { errorMessage } from '../protocol/failures.ts'
import { Deadline } from '../protocol/deadline.ts'
import { describeExit } from '../shared/process-exit.ts'
import { readMetadataProcess, readMetadataProcessAsync } from '../shared/metadata-process.ts'
import { OwnedProcessGroup } from '../shared/process-ownership.ts'
import {
  encodeRequestHead,
  MAX_FRAME_BYTES,
  MAX_FRAME_ID_CHARACTERS,
  MAX_ID_CHARACTERS,
  MAX_IDENTITY_CHARACTERS,
  MAX_OUTPUT_SIDE,
  MAX_PATH_BYTES,
  MAX_SEQUENCE_BYTES,
  MAX_SEQUENCE_FRAMES,
  MEDIA_PROTOCOL_VERSION,
  MediaProtocolError,
  MediaVersionMismatch,
  ReplyReader,
} from './protocol.ts'

export type {
  BuildIdentity,
  Bye,
  CaptureGap,
  EncoderExit,
  EncoderProbe,
  Ended,
  EndStatus,
  EvidenceReason,
  FrameCounts,
  FrameFate,
  FrameFormat,
  FrameMapEntry,
  FrameSequence,
  FrameSequenceRequest,
  FrameSequenceStatus,
  FrameStretch,
  Gap,
  Hello,
  LeftoverFile,
  Leftovers,
  LiveFrame,
  MediaError,
  QueueStats,
  RecordingEvidence,
  RecordingIdentity,
  Released,
  SequenceFrame,
  Started,
  StartRecording,
  Thumbnail,
  ThumbnailRequest,
  ThumbnailStatus,
  WatchEnded,
  WatchOptions,
} from './protocol.ts'
export { MAX_FRAME_BYTES, MAX_FRAME_ID_CHARACTERS, MAX_ID_CHARACTERS, MAX_IDENTITY_CHARACTERS, MAX_OUTPUT_SIDE, MAX_PATH_BYTES, MAX_SEQUENCE_BYTES, MAX_SEQUENCE_FRAMES, MEDIA_PROTOCOL_VERSION } from './protocol.ts'

/** The most request bytes retained across the write queue and pipe. */
const defaultMaxPendingBytes = 32 * 1024 * 1024
const defaultMaxPendingRequests = 128
/** How long `close` waits for recorded processes to go after signaling them. */
const killGraceMs = 1000
/**
 * How long an encoder whose media process died gets to finish its file on its own: its input has closed, which
 * is how ffmpeg is told to write the container. After that only its recorded, freshly verified processes are killed.
 */
const orphanGraceMs = 1000
// The process's stderr is for its own failures; this much of its end is enough to explain one.
const stderrTailBytes = 8 * 1024
// How many errors that belonged to no waiting request are kept; older ones go, so a process that keeps refusing
// frames for an id nobody waits on cannot grow this side without bound.
const keptErrors = 64
// Request ids of jobs this side stopped waiting for, so their late answers are recognised and let go. The oldest are
// forgotten past this many; an answer for one of those is then a protocol error, as for any id never asked.
const rememberedAbandoned = 1024
// A capture gap's reason is a code, never free text, so no app text can travel in one.
const reasonPattern = /^[a-z0-9_]{1,64}$/
// The build command named when the binary speaks another protocol, unless the caller names how to install it.
const defaultInstallHint = 'build the matching binary from this Retest with: cargo build --release --manifest-path media/Cargo.toml'

// Discovery needs only process links. Full arguments are read only for the media launch, its observed descendants
// and relevant groups. Selection grants no signal authority: OwnedProcessGroup still records verified ancestry
// and rechecks each recorded pid's full identity immediately before its signal.
export function mediaOwnershipSystem(root: number, metadata: { read: typeof readMetadataProcess; readAsync: typeof readMetadataProcessAsync } = { read: readMetadataProcess, readAsync: readMetadataProcessAsync }): ProcessOwnershipSystem {
  const tracked = new Set([root])
  const groups = new Set([root])
  const columns = 'pid=,ppid=,pgid=,stat=,lstart=,args='
  const environment = { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC0' }
  const query = (args: string[], deadline?: Deadline) => ({ deadline, command: '/bin/ps', args, environment })
  const selectedArguments = (links: string): string[] => {
    const table = links.split('\n').filter((line) => line.trim() !== '').map((line) => {
      const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line)
      if (fields === null) throw new Error('The host returned unreadable media process links.')
      const pid = Number(fields[1])
      const parent = Number(fields[2])
      const group = Number(fields[3])
      if (![pid, parent, group].every(Number.isSafeInteger) || pid < 1) throw new Error('The host returned invalid media process links.')
      return { pid, parent, group }
    })
    if (table.length === 0) throw new Error('The host returned no media process links.')
    const presentPids = new Set(table.map((entry) => entry.pid))
    const presentGroups = new Set(table.map((entry) => entry.group))
    for (const pid of tracked) if (pid !== root && !presentPids.has(pid)) tracked.delete(pid)
    for (const group of groups) if (group !== root && !presentGroups.has(group)) groups.delete(group)
    const selected = new Set(tracked)
    for (const entry of table) if (groups.has(entry.group)) selected.add(entry.pid)
    for (;;) {
      const before = selected.size
      for (const entry of table) if (selected.has(entry.parent)) selected.add(entry.pid)
      if (before === selected.size) break
    }
    // This caller is included only as a sentinel, so an absent selected pid still has a successful ps query.
    // It is removed before the ownership layer sees the snapshot.
    const pids = [...table.filter((entry) => selected.has(entry.pid)).map((entry) => entry.pid), process.pid]
    return ['-ww', '-o', columns, '-p', pids.join(',')]
  }
  const identities = (text: string): OwnedProcessIdentity[] => {
    const records = text.split('\n').filter((line) => line.trim() !== '').map((line) => {
      const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line)
      if (fields === null) throw new Error('The host returned an unreadable media process identity.')
      const [, pid, parent, group, state, startedAt, command] = fields
      if (pid === undefined || parent === undefined || group === undefined || state === undefined || startedAt === undefined || command === undefined) throw new Error('The host returned an incomplete media process identity.')
      return { pid: Number(pid), parentPid: Number(parent), groupId: Number(group), state, startedAt, command }
    })
    if (records.length === 0) throw new Error('The host returned no media process identities.')
    return records
  }
  const remember = (text: string): OwnedProcessIdentity[] => {
    const records = identities(text).filter((entry) => entry.pid !== process.pid)
    for (const record of records) {
      tracked.add(record.pid)
      groups.add(record.groupId)
    }
    return records
  }
  return {
    read(deadline) {
      const links = metadata.read(query(['-axo', 'pid=,ppid=,pgid='], deadline))
      return remember(metadata.read(query(selectedArguments(links), deadline)))
    },
    async readAsync(deadline) {
      const links = await metadata.readAsync(query(['-axo', 'pid=,ppid=,pgid='], deadline))
      return remember(await metadata.readAsync(query(selectedArguments(links), deadline)))
    },
    readProcess(pid, deadline) {
      if (!Number.isSafeInteger(pid) || pid < 2) throw new RangeError('A media process reading needs a valid pid.')
      return identities(metadata.read(query(['-ww', '-o', columns, '-p', `${pid},${process.pid}`], deadline))).find((entry) => entry.pid === pid)
    },
    async readProcessAsync(pid, deadline) {
      if (!Number.isSafeInteger(pid) || pid < 2) throw new RangeError('A media process reading needs a valid pid.')
      return identities(await metadata.readAsync(query(['-ww', '-o', columns, '-p', `${pid},${process.pid}`], deadline))).find((entry) => entry.pid === pid)
    },
    signal(pid, signal) { process.kill(pid, signal) },
  }
}

export type MediaProcessOptions = {
  /** The `retest-media` binary, or a program that runs it, such as `/usr/bin/time`. */
  executable: string
  /** Arguments for `executable`. `mediaArguments` builds the binary's own. */
  args?: readonly string[]
  /** The complete environment supplied by the host. Without one only encoder paths and locale are inherited. */
  env?: Readonly<Record<string, string | undefined>>
  /** How long the process may take to greet before it is stopped. It greets as soon as it runs. */
  startTimeoutMs: number
  /**
   * The most complete request bytes retained in the client queue and pipe. Frames are dropped at pressure;
   * control requests wait for drain within this byte bound and maxPendingRequests, or are refused by name.
   */
  maxPendingBytes?: number
  /** Pending requests, including starts awaiting a late reply, across all request kinds. */
  maxPendingRequests?: number
  /** What to tell the caller to install when the binary speaks another protocol version. */
  installHint?: string
  /** Cancels startup and its greeting wait; launched processes still undergo owned cleanup. */
  signal?: AbortSignal
}

/** Paths needed by the media encoder, with a fixed locale and no application or judge credentials. */
export function mediaEnvironment(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = { LC_ALL: 'C' }
  for (const name of ['PATH', 'TMPDIR']) {
    const value = env[name]
    if (value !== undefined) result[name] = value
  }
  return result
}

/**
 * The media binary's own arguments. Without `ffmpeg` the process runs the `ffmpeg` it finds on `PATH`.
 *
 * @example mediaArguments({ ffmpeg: '/opt/homebrew/bin/ffmpeg' }) // ['--ffmpeg', '/opt/homebrew/bin/ffmpeg']
 */
export function mediaArguments(options: { ffmpeg?: string }): string[] {
  return options.ffmpeg === undefined ? [] : ['--ffmpeg', options.ffmpeg]
}

/** How the media process ended. `forced` is true when `close` had to signal recorded processes. */
export type MediaExit = ProcessExit & { forced: boolean; bye: Bye | undefined }

/** A recording began, or ended before it could: its encoder was missing, failed or lacked a codec. */
export type RecordingStart = { kind: 'started'; recording: Recording } | { kind: 'ended'; ended: Ended }

/**
 * What became of a frame. `sent`: written to the pipe to the process. `dropped`: the pipe was full, so it was
 * dropped here. `closed`: the recording is finishing or over. `not_sent`: the process is closing, has ended, or
 * its pipe has broken. A frame still in the pipe when the process ends is lost; the process's own `received`
 * count is the record of what reached it.
 */
export type FrameOutcome = 'sent' | 'dropped' | 'closed' | 'not_sent'

/**
 * A frame as the capture produced it. `frameId` names it within its recording, at most `MAX_FRAME_ID_CHARACTERS`
 * without control characters, and so may `actionId` or `observationId`, the action or look it belongs to.
 * `timestampUs` is a whole number of microseconds. `bytes` is written as it is, must not change until it is sent,
 * and holds at most `MAX_FRAME_BYTES`.
 */
export type Frame = { frameId: string; actionId?: string; observationId?: string; timestampUs: number; format: FrameFormat; bytes: Uint8Array }

/** One image for a thumbnail, as it was captured. */
export type StillImage = { format: FrameFormat; bytes: Uint8Array }

/** What this client wrote, for measuring the cost of the pipe. */
export type MediaTraffic = { framesSent: number; framesDropped: number; frameBytes: number; headerBytes: number; imageBytes: number }

/** Thrown when the media process cannot start, will not greet, ends, or does not answer in time. */
export class MediaProcessError extends Error {
  override readonly name: string = 'MediaProcessError'
}

/** Thrown when the binary speaks another media protocol version: names both, and what to install. */
export class MediaVersionError extends MediaProcessError {
  override readonly name: string = 'MediaVersionError'
  readonly binaryProtocol: number
  readonly binaryVersion: string | undefined

  constructor(executable: string, mismatch: MediaVersionMismatch, installHint: string) {
    const binary = mismatch.binaryVersion === undefined ? 'a retest-media of unknown version' : `retest-media ${mismatch.binaryVersion}`
    super(`${executable} is ${binary}, which speaks media protocol ${mismatch.protocol}; this Retest needs one that speaks media protocol ${MEDIA_PROTOCOL_VERSION}: ${installHint}`)
    this.binaryProtocol = mismatch.protocol
    this.binaryVersion = mismatch.binaryVersion
  }
}

/**
 * The media process ended before this recording did. Its encoder was given a moment to finish its file and then
 * its recorded processes were stopped where ownership could be verified; `partialPath` names any unfinished file.
 * Nothing says that file is a complete video.
 */
export class MediaRecordingLostError extends MediaProcessError {
  override readonly name: string = 'MediaRecordingLostError'
  readonly recordingId: string
  readonly partialPath: string | undefined

  constructor(message: string, recordingId: string, partialPath: string | undefined) {
    super(message)
    this.recordingId = recordingId
    this.partialPath = partialPath
  }
}

/** Thrown when the process refuses a request with an `error` reply. */
export class MediaRequestError extends Error {
  override readonly name = 'MediaRequestError'
  readonly reply: MediaError

  constructor(reply: MediaError) {
    super(`the media process refused the request (${reply.code}): ${reply.message}`)
    this.reply = reply
  }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }

function deferred<T>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  // Whoever awaits it sees the rejection; nobody awaiting it is not a crash.
  promise.catch(() => {})
  return { promise, resolve, reject }
}

type RequestedRecording = { identity: RecordingIdentity; output: string }
type PendingStart = { requested: RequestedRecording; answer: Deferred<RecordingStart> }
type Running = { recording: Recording; ended: Deferred<Ended>; ownership: EncoderOwnership; requested: RequestedRecording }

type PendingWrite = { head: Buffer; payload: Uint8Array }

type Job = { kind: 'thumbnail'; answer: Deferred<Thumbnail> } | { kind: 'frames'; recordingId: string; fromUs: number; toUs: number; answer: Deferred<FrameSequence> } | { kind: 'leftovers'; answer: Deferred<Leftovers> }

type Watch = { recordingId: string; onFrame: (frame: LiveFrame) => void; begun: Deferred<LiveWatch>; ended: Deferred<WatchEnded>; stopping: boolean }

/** The encoder ownership recorded when a verified media worker reports its start. */
export type EncoderOwnership = { owner: OwnedProcessGroup | undefined; problems: string[] }

/**
 * A reply's pid alone grants no ownership, even when a process with that pid or group exists. `groupFor` reads the host
 * afresh for the worker and again for the encoder's group, and refuses on any problem in either reading; a reading
 * before it or after it would read the same table again, each costing a process listing. Only a refusal reads again,
 * to say why.
 */
export function captureEncoderOwnership(worker: OwnedProcessGroup, encoderPid: number): EncoderOwnership {
  const owner = worker.groupFor(encoderPid)
  if (owner !== undefined && worker.verifiedIdentity() !== undefined) return { owner, problems: [] }
  const problems = worker.capture()
  if (worker.verifiedIdentity() === undefined) {
    problems.push('The media worker could not be verified when its encoder start arrived; encoder ownership and cleanup are unknown.')
    return { owner: undefined, problems }
  }
  problems.push(`Encoder ${encoderPid} was not recorded under the launched media worker; it was left alone and its completion is unknown.`)
  return { owner: undefined, problems }
}

/**
 * Retest's media process, `retest-media`, run as a child in a process group of its own; each encoder it starts
 * leads a group of its own too. Frames go to it over a pipe with their bytes untouched; each recording ends with
 * exactly one `Ended` from the process. The client never invents an outcome: if the process ends before a
 * recording does, the client stops only the encoder processes whose launch ownership it recorded, and the promise
 * rejects with how the process ended and any file left. Unreadable or changed ownership is a cleanup failure.
 *
 * Besides recordings it makes thumbnails, returns a recording's kept frames for an interval, sends a live view of
 * a recording's newest frame, and lists or removes what a lost recording left beside its output. Each of those is
 * answered once, or rejected when the process ends or does not answer in time.
 *
 * The process holds this one open only while a recording runs or a request is unanswered. A `close` forgotten on
 * an idle process does not keep Node alive: when this process exits, however it exits, the media process reads
 * the end of its input and shuts down on its own, ending every recording `stopped` and stopping every encoder.
 * A signal that ends this process does the same, since the media process is not in its group.
 *
 * @example
 * const media = await MediaProcess.start({ executable: 'media/target/release/retest-media', startTimeoutMs: 5000 })
 * const start = await media.record({ recordingId: 'test-1', identity, width: 800, height: 600, fps: 30, output: '/tmp/test-1', deadlineMs: 10_000 }, 5000)
 * if (start.kind === 'started') start.recording.frame({ frameId: 'f1', timestampUs, format: 'png', bytes })
 */
export class MediaProcess {
  readonly hello: Hello
  readonly pid: number
  /** Settles when the process has exited and its output is read. */
  readonly exited: Promise<ProcessExit>
  readonly #child: ChildProcessWithoutNullStreams
  readonly #maxPendingBytes: number
  readonly #maxPendingRequests: number
  #waitingDrain = false
  readonly #writes: PendingWrite[] = []
  #queuedBytes = 0
  #endInput = false
  readonly #ownership: OwnedProcessGroup
  readonly #ownershipProblems: string[] = []
  readonly #starts = new Map<string, PendingStart>()
  readonly #recordings = new Map<string, Running>()
  // Recordings that have ended and whose kept frames the process may still hold, until released.
  readonly #endedRecordings = new Map<string, Recording>()
  // Starts that timed out here and have not been answered. A late `started` for one becomes a recording the
  // client finishes at once, so its encoder is known and stopped like any other if the process dies.
  readonly #abandoned = new Map<string, RequestedRecording>()
  readonly #readies: Deferred<EncoderProbe>[] = []
  readonly #jobs = new Map<string, Job>()
  readonly #abandonedJobs = new Set<string>()
  readonly #watches = new Map<string, Watch>()
  readonly #releases = new Map<string, Deferred<Released>>()
  readonly #errors: MediaError[] = []
  readonly #traffic: MediaTraffic = { framesSent: 0, framesDropped: 0, frameBytes: 0, headerBytes: 0, imageBytes: 0 }
  // The encoders of recordings the process left running when it ended, being stopped. `close` waits for them.
  readonly #reclaims: Promise<string[]>[] = []
  #nextRequest = 0
  #encoder: EncoderProbe
  #bye: Bye | undefined
  #exit: ProcessExit | undefined
  #failure: Error | undefined
  #pipeBroken: Error | undefined
  #stderr = ''
  #closing: Promise<MediaExit> | undefined
  readonly #forcedStops: Promise<void>[] = []
  #forcedCleanup = false
  #released = false

  private constructor(child: ChildProcessWithoutNullStreams, hello: Hello, exited: Promise<ProcessExit>, maxPendingBytes: number, maxPendingRequests: number, ownership: OwnedProcessGroup) {
    this.#ownership = ownership
    this.#child = child
    this.hello = hello
    this.#encoder = hello.encoder
    this.pid = child.pid ?? 0
    this.exited = exited
    this.#maxPendingBytes = maxPendingBytes
    this.#maxPendingRequests = maxPendingRequests
    child.stdin.on('drain', () => { this.#waitingDrain = false; this.#flushWrites() })
  }

  /**
   * Starts the process and waits for its greeting. Throws `MediaVersionError` when the binary speaks another
   * protocol version, naming it and what to install, and `MediaProcessError` when the process fails otherwise.
   */
  static async start(options: MediaProcessOptions): Promise<MediaProcess> {
    const startupCancelled = (): boolean => options.signal?.aborted === true
    if (startupCancelled()) throw new MediaProcessError('Media startup was cancelled before launch.')
    for (const value of [options.maxPendingBytes, options.maxPendingRequests]) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new RangeError('media admission limits must be positive whole numbers')
    }
    const child = spawn(options.executable, options.args ?? [], { stdio: 'pipe', detached: true, env: options.env ?? mediaEnvironment(process.env) })
    const ownership = child.pid === undefined ? undefined : new OwnedProcessGroup(child.pid, process.pid, mediaOwnershipSystem(child.pid))
    const ownershipProblems = ownership?.capture() ?? []
    const reader = new ReplyReader()
    const greeting = deferred<Hello>()
    const exited = deferred<ProcessExit>()
    let stderr = ''
    let pipeBroken: Error | undefined
    let closed = false
    let protocolFailed = false
    let instance: MediaProcess | undefined
    // Replies that arrive with the greeting, before the instance exists, wait here.
    const early: MediaReply[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-stderrTailBytes)
      if (instance !== undefined) instance.#stderr = stderr
    })
    child.stdout.on('data', (chunk: Buffer) => {
      if (protocolFailed || (instance !== undefined && instance.#failure !== undefined)) return
      let replies: MediaReply[]
      try {
        replies = reader.push(chunk)
      } catch (error) {
        const failure = error instanceof MediaVersionMismatch ? new MediaVersionError(options.executable, error, options.installHint ?? defaultInstallHint) : error instanceof Error ? error : new MediaProtocolError(String(error))
        protocolFailed = true
        greeting.reject(failure)
        if (instance !== undefined) instance.#fail(failure)
        return
      }
      for (const reply of replies) {
        if (instance !== undefined) instance.#dispatch(reply)
        else if (reply.type === 'hello') greeting.resolve(reply)
        else early.push(reply)
      }
    })
    // An unwritable pipe means the process is gone or has stopped reading; nothing more is sent on it, and the
    // exit, when it comes, says why.
    child.stdin.on('error', (error: Error) => {
      pipeBroken ??= new MediaProcessError(`the pipe to the media process broke: ${error.message}`, { cause: error })
      if (instance !== undefined) instance.#pipeBroken ??= pipeBroken
    })
    child.on('error', (error) => {
      greeting.reject(new MediaProcessError(`${options.executable} could not be started: ${error.message}`, { cause: error }))
    })
    child.on('close', (code, signal) => {
      closed = true
      try { reader.end() } catch (error) {
        const failure = error instanceof Error ? error : new MediaProtocolError(String(error))
        greeting.reject(failure)
        if (instance !== undefined) instance.#failure ??= failure
      }
      const exit = { code, signal }
      greeting.reject(new MediaProcessError(`${options.executable} ended with ${describeExit(exit)} before it greeted${stderrNote(stderr)}`))
      if (instance !== undefined) instance.#ended(exit)
      exited.resolve(exit)
    })
    const aborted = (): void => greeting.reject(new MediaProcessError('Media startup was cancelled.'))
    options.signal?.addEventListener('abort', aborted, { once: true })
    if (startupCancelled()) aborted()
    const timer = setTimeout(() => {
      greeting.reject(new MediaProcessError(`${options.executable} did not greet within ${options.startTimeoutMs} ms`))
    }, options.startTimeoutMs)
    let hello: Hello
    try {
      hello = await greeting.promise
      if (ownership === undefined || ownershipProblems.length > 0) throw new MediaProcessError(`${options.executable} started without verified process ownership: ${ownershipProblems.join(' ')}`)
    } catch (error) {
      // A reaped or reused pid is never signaled by its number alone.
      const deadline = new Deadline(2 * killGraceMs)
      if (!closed && ownership !== undefined) {
        const report = await ownership.signalReportAsync('SIGKILL', deadline)
        ownershipProblems.push(...report.problems, ...report.identityRefusals)
      }
      if (ownership !== undefined && !(await groupGoneWithin(ownership, killGraceMs, deadline))) ownershipProblems.push('The media process could not be confirmed stopped; cleanup is unknown.')
      ownershipProblems.push(...(ownership?.readProblems ?? []))
      releaseReferences(child)
      if (ownershipProblems.length > 0) throw new MediaProcessError(`${errorMessage(error)}; media cleanup failed: ${[...new Set(ownershipProblems)].join(' ')}`, { cause: error })
      throw error
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', aborted)
    }
    if (ownership === undefined) throw new MediaProcessError('The media process has no recorded launch ownership.')
    instance = new MediaProcess(child, hello, exited.promise, options.maxPendingBytes ?? defaultMaxPendingBytes, options.maxPendingRequests ?? defaultMaxPendingRequests, ownership)
    instance.#stderr = stderr
    instance.#pipeBroken = pipeBroken
    instance.#attend()
    for (const reply of early) instance.#dispatch(reply)
    return instance
  }

  /** What the encoder can do, as last heard: the greeting's answer, or a later `ready`. */
  get encoder(): EncoderProbe {
    return this.#encoder
  }

  /**
   * Waits for the encoder probe to end and says what it found. Answers at once when the greeting already had the
   * answer; otherwise asks the process, which answers once its probe has ended. Rejects with `MediaProcessError`
   * when the process ends or does not answer within `timeoutMs`.
   */
  ready(timeoutMs: number): Promise<EncoderProbe> {
    if (this.#encoder.state !== 'probing') return Promise.resolve(this.#encoder)
    const unavailable = this.#unavailable() ?? this.#pendingLimit('readiness')
    if (unavailable !== undefined) return Promise.reject(unavailable)
    const answer = deferred<EncoderProbe>()
    this.#readies.push(answer)
    this.#attend()
    if (!this.#write(encodeRequestHead({ type: 'ready' }))) {
      this.#readies.splice(this.#readies.indexOf(answer), 1)
      this.#attend()
      return Promise.reject(this.#writeRefusal('readiness'))
    }
    return withTimeout(answer, timeoutMs, `the media process did not say whether its encoder is ready within ${timeoutMs} ms`, () => {
      const index = this.#readies.indexOf(answer)
      if (index >= 0) this.#readies.splice(index, 1)
      this.#attend()
    })
  }

  /**
   * Starts a recording. Resolves once the process answers: with the running recording, or with the `Ended` that
   * says why it could not begin. Rejects with `RangeError` before sending when a number is not a whole number in
   * range, an id is empty, too long or holds a control character, or the output is longer than `MAX_PATH_BYTES`;
   * with `MediaRequestError` when the process refuses the request; and with `MediaProcessError` when the process has
   * ended, is closing, or does not answer within `timeoutMs`. A start sent while the encoder is still being probed is answered once the probe ends. A
   * start that timed out here and is answered later is finished at once.
   */
  record(start: StartRecording, timeoutMs: number): Promise<RecordingStart> {
    const invalid = invalidStart(start)
    if (invalid !== undefined) return Promise.reject(new RangeError(invalid))
    const unavailable = this.#unavailable() ?? this.#pendingLimit('start')
    if (unavailable !== undefined) return Promise.reject(unavailable)
    if (this.#starts.has(start.recordingId) || this.#recordings.has(start.recordingId) || this.#abandoned.has(start.recordingId) || this.#endedRecordings.has(start.recordingId)) {
      return Promise.reject(new MediaProcessError(`recording ${start.recordingId} already started`))
    }
    const answer = deferred<RecordingStart>()
    const requested = { identity: { ...start.identity }, output: start.output }
    const pending = { requested, answer }
    this.#starts.set(start.recordingId, pending)
    this.#attend()
    if (!this.#write(encodeRequestHead({ type: 'start', ...start }))) {
      this.#starts.delete(start.recordingId)
      this.#attend()
      return Promise.reject(this.#writeRefusal('start'))
    }
    const timer = setTimeout(() => {
      if (this.#starts.get(start.recordingId) !== pending) return
      this.#starts.delete(start.recordingId)
      this.#abandoned.set(start.recordingId, requested)
      this.#attend()
      answer.reject(new MediaProcessError(`the media process did not answer the start of ${start.recordingId} within ${timeoutMs} ms`))
    }, timeoutMs)
    void answer.promise.finally(() => clearTimeout(timer)).catch(() => {})
    return answer.promise
  }

  /**
   * Makes a thumbnail of one image: fitted within the request's size, never enlarged, written in its format beside
   * `output` with `.png` or `.jpg` added. Resolves with the process's answer, whose `status` names a failure; rejects
   * with `RangeError` before sending a request the process could not read, such as an output longer than
   * `MAX_PATH_BYTES`, and with `MediaProcessError` when the process ends or does not answer within `timeoutMs`.
   */
  thumbnail(request: ThumbnailRequest, image: StillImage, timeoutMs: number): Promise<Thumbnail> {
    const invalid = invalidThumbnail(request, image)
    if (invalid !== undefined) return Promise.reject(new RangeError(invalid))
    const unavailable = this.#unavailable() ?? this.#pendingLimit('thumbnail')
    if (unavailable !== undefined) return Promise.reject(unavailable)
    const requestId = this.#requestId()
    const answer = deferred<Thumbnail>()
    this.#jobs.set(requestId, { kind: 'thumbnail', answer })
    this.#attend()
    if (!this.#writeWithPayload(encodeRequestHead({ type: 'thumbnail', requestId, sourceFormat: image.format, ...request }, image.bytes.byteLength), image.bytes)) {
      this.#jobs.delete(requestId)
      this.#attend()
      return Promise.reject(this.#writeRefusal('thumbnail'))
    }
    this.#traffic.imageBytes += image.bytes.byteLength
    return this.#awaitJob(requestId, answer, timeoutMs, 'the thumbnail')
  }

  /**
   * Asks the process for the kept frames of a recording, running or ended, inside an interval. `Recording.frames` is
   * the usual way in. Resolves with the process's answer, whose `status` names why no frames came; rejects with
   * `MediaRequestError` for a recording the process does not know, and as `thumbnail` does otherwise.
   */
  frames(recordingId: string, request: FrameSequenceRequest, timeoutMs: number): Promise<FrameSequence> {
    const invalid = invalidSequence(request)
    if (invalid !== undefined) return Promise.reject(new RangeError(invalid))
    const unavailable = this.#unavailable() ?? this.#pendingLimit('frames')
    if (unavailable !== undefined) return Promise.reject(unavailable)
    const requestId = this.#requestId()
    const answer = deferred<FrameSequence>()
    this.#jobs.set(requestId, { kind: 'frames', recordingId, fromUs: request.fromUs, toUs: request.toUs, answer })
    this.#attend()
    if (!this.#write(encodeRequestHead({ type: 'frames', requestId, recordingId, ...request }))) {
      this.#jobs.delete(requestId)
      this.#attend()
      return Promise.reject(this.#writeRefusal('frames'))
    }
    return this.#awaitJob(requestId, answer, timeoutMs, `the frames of ${recordingId}`)
  }

  /**
   * Lists the files a lost recording or thumbnail of `output` left beside it (`.mp4.partial`, `.webm.partial`, a
   * `.copying` file from a copy into place, the kept frames, a thumbnail's `.partial`), and removes them when `remove` is true, so a later start at that output is
   * not refused. Nothing is touched while this process uses that output, and only regular files are removed.
   * Rejects with `RangeError` before sending an output longer than `MAX_PATH_BYTES`.
   */
  leftovers(output: string, options: { remove: boolean }, timeoutMs: number): Promise<Leftovers> {
    const invalid = invalidOutput(output)
    if (invalid !== undefined) return Promise.reject(new RangeError(invalid))
    const unavailable = this.#unavailable() ?? this.#pendingLimit('leftovers')
    if (unavailable !== undefined) return Promise.reject(unavailable)
    const requestId = this.#requestId()
    const answer = deferred<Leftovers>()
    this.#jobs.set(requestId, { kind: 'leftovers', answer })
    this.#attend()
    if (!this.#write(encodeRequestHead({ type: 'leftovers', requestId, output, remove: options.remove }))) {
      this.#jobs.delete(requestId)
      this.#attend()
      return Promise.reject(this.#writeRefusal('leftovers'))
    }
    return this.#awaitJob(requestId, answer, timeoutMs, `the leftovers of ${output}`)
  }

  /** Errors the process sent that belonged to no waiting request, newest last; at most the last 64 are kept. */
  get errors(): readonly MediaError[] {
    return this.#errors
  }

  get traffic(): MediaTraffic {
    return { ...this.#traffic }
  }

  /**
   * Shuts the process down: every unfinished recording ends `stopped`, every finishing one completes within its
   * deadline, every live view and waiting job is answered, kept frames are removed, then the process says bye and
   * exits. A process that has not exited within `timeoutMs` has its recorded processes stopped, and each owned
   * encoder is reclaimed before this resolves. Unknown ownership or a process still running rejects the close; no
   * unrecorded process is signaled. A second call waits for the first. Frames sent once it begins are `not_sent`.
   */
  close(timeoutMs: number): Promise<MediaExit> {
    if (this.#closing === undefined) {
      if (this.#unavailable() === undefined) {
        this.#write(encodeRequestHead({ type: 'shutdown' }))
        this.#endInput = true
        if (this.#writes.length === 0) this.#child.stdin.end()
      }
      this.#closing = this.#close(timeoutMs)
    }
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<MediaExit> {
    const deadline = new Deadline(timeoutMs + 2 * killGraceMs)
    this.#ownershipProblems.push(...(await this.#ownership.captureAsync(deadline)))
    let exit = await settleWithin(this.exited, Math.min(timeoutMs, deadline.remainingMs))
    let forced = false
    if (exit === undefined) {
      this.#forcedCleanup = true
      const report = await this.#ownership.signalReportAsync('SIGKILL', deadline)
      this.#ownershipProblems.push(...report.problems, ...report.identityRefusals)
      exit = await settleWithin(this.exited, Math.min(killGraceMs, deadline.remainingMs))
      forced = true
      if (exit === undefined) this.#loseEverything('The media process did not end after cleanup; its outcome is unknown.')
    }
    // The exit handler has begun stopping only encoder processes recorded before the worker ended.
    await Promise.all(this.#forcedStops)
    const problems = [...this.#ownershipProblems, ...(await Promise.all(this.#reclaims)).flat()]
    if (await this.#ownership.remainsAsync(deadline)) {
      const report = await this.#ownership.signalReportAsync('SIGKILL', deadline)
      problems.push(...report.problems, ...report.identityRefusals)
      forced = true
      if (!(await groupGoneWithin(this.#ownership, killGraceMs, deadline))) problems.push('Recorded media processes or processes with unknown ownership are still running after cleanup.')
    }
    problems.push(...this.#ownership.readProblems)
    if (exit === undefined || problems.length > 0) {
      this.#released = true
      releaseReferences(this.#child)
      const reason = exit === undefined ? `The media process did not end within ${killGraceMs} ms of cleanup; its outcome is unknown.` : 'Media cleanup failed.'
      throw new MediaProcessError(`${reason}${problems.length === 0 ? '' : ` ${[...new Set(problems)].join(' ')}`}`)
    }
    if (this.#failure !== undefined) throw new MediaProcessError(`Media protocol failed: ${this.#failure.message}`, { cause: this.#failure })
    return { ...exit, forced, bye: this.#bye }
  }

  /**
   * Sends one frame of a recording, or says why it was not sent. `Recording.frame` is the usual way in. Throws
   * `RangeError` for an id the process would refuse, a timestamp that is not a whole number of microseconds from 0,
   * or a frame larger than `MAX_FRAME_BYTES`.
   */
  sendFrame(recordingId: string, frame: Frame): FrameOutcome {
    checkFrame(frame)
    if (this.#unavailable() !== undefined) return 'not_sent'
    const header: MediaRequest = {
      type: 'frame',
      recordingId,
      frameId: frame.frameId,
      ...(frame.actionId === undefined ? {} : { actionId: frame.actionId }),
      ...(frame.observationId === undefined ? {} : { observationId: frame.observationId }),
      timestampUs: frame.timestampUs,
      format: frame.format,
    }
    if (!this.#writeWithPayload(encodeRequestHead(header, frame.bytes.byteLength), frame.bytes, false)) {
      this.#traffic.framesDropped += 1
      return 'dropped'
    }
    this.#traffic.framesSent += 1
    this.#traffic.frameBytes += frame.bytes.byteLength
    return 'sent'
  }

  /** Asks the process to finish a recording, and says whether the request was written. */
  sendFinish(recordingId: string, endTimestampUs: number | undefined): boolean {
    if (this.#unavailable() !== undefined) return false
    return this.#write(encodeRequestHead({ type: 'finish', recordingId, ...(endTimestampUs === undefined ? {} : { endTimestampUs }) }))
  }

  /** Tells the process capture could not deliver frames for a while, and says whether it was written. */
  sendCaptureGap(recordingId: string, gap: CaptureGap): boolean {
    checkCaptureGap(gap)
    if (this.#unavailable() !== undefined) return false
    return this.#write(encodeRequestHead({ type: 'captureGap', recordingId, fromUs: gap.fromUs, toUs: gap.toUs, reason: gap.reason }))
  }

  /** Starts a live view of a running recording; `Recording.watch` is the usual way in. */
  watch(recordingId: string, options: WatchOptions, onFrame: (frame: LiveFrame) => void, timeoutMs: number): Promise<LiveWatch> {
    const invalid = invalidWatch(options)
    if (invalid !== undefined) return Promise.reject(new RangeError(invalid))
    const unavailable = this.#unavailable() ?? this.#pendingLimit('watch')
    if (unavailable !== undefined) return Promise.reject(unavailable)
    if (this.#watches.has(recordingId)) return Promise.reject(new MediaProcessError(`recording ${recordingId} already has a live view`))
    const watch: Watch = { recordingId, onFrame, begun: deferred<LiveWatch>(), ended: deferred<WatchEnded>(), stopping: false }
    this.#watches.set(recordingId, watch)
    this.#attend()
    if (!this.#write(encodeRequestHead({ type: 'watch', recordingId, ...options }))) {
      this.#watches.delete(recordingId)
      this.#attend()
      return Promise.reject(this.#writeRefusal('watch'))
    }
    return withTimeout(watch.begun, timeoutMs, `the media process did not begin the live view of ${recordingId} within ${timeoutMs} ms`, () => {
      // The view may still begin; it is stopped, so it is not left running for nobody.
      watch.stopping = true
      if (!this.#write(encodeRequestHead({ type: 'unwatch', recordingId }))) this.#fail(this.#writeRefusal('unwatch'))
    })
  }

  /** Asks the process to remove an ended recording's kept frames; `Recording.release` is the usual way in. */
  release(recordingId: string, timeoutMs: number): Promise<Released> {
    const unavailable = this.#unavailable() ?? this.#pendingLimit('release')
    if (unavailable !== undefined) return Promise.reject(unavailable)
    const pending = this.#releases.get(recordingId)
    if (pending !== undefined) return pending.promise
    const answer = deferred<Released>()
    this.#releases.set(recordingId, answer)
    this.#attend()
    if (!this.#write(encodeRequestHead({ type: 'release', recordingId }))) {
      this.#releases.delete(recordingId)
      this.#attend()
      return Promise.reject(this.#writeRefusal('release'))
    }
    return withTimeout(answer, timeoutMs, `the media process did not release ${recordingId} within ${timeoutMs} ms`, () => {
      if (this.#releases.get(recordingId) === answer) this.#releases.delete(recordingId)
      this.#attend()
    })
  }

  #stopWatch(watch: Watch, timeoutMs: number): Promise<WatchEnded> {
    if (!watch.stopping) {
      watch.stopping = true
      if (!this.#write(encodeRequestHead({ type: 'unwatch', recordingId: watch.recordingId }))) this.#fail(this.#writeRefusal('unwatch'))
    }
    return settleWithin(watch.ended.promise, timeoutMs).then((ended) => {
      if (ended === undefined) throw new MediaProcessError(`the live view of ${watch.recordingId} did not end within ${timeoutMs} ms`)
      return ended
    })
  }

  #requestId(): string {
    this.#nextRequest += 1
    return `q${this.#nextRequest}`
  }

  #awaitJob<T>(requestId: string, answer: Deferred<T>, timeoutMs: number, what: string): Promise<T> {
    return withTimeout(answer, timeoutMs, `the media process did not answer ${what} within ${timeoutMs} ms`, () => {
      if (!this.#jobs.delete(requestId)) return
      this.#abandonedJobs.add(requestId)
      if (this.#abandonedJobs.size > rememberedAbandoned) {
        const oldest = this.#abandonedJobs.values().next()
        if (oldest.done !== true) this.#abandonedJobs.delete(oldest.value)
      }
      this.#attend()
    })
  }

  // Why nothing more can be asked of the process, or undefined while it can be.
  #unavailable(): Error | undefined {
    if (this.#failure !== undefined) return this.#failure
    if (this.#exit !== undefined) return new MediaProcessError(`the media process has ended with ${describeExit(this.#exit)}`)
    if (this.#pipeBroken !== undefined || this.#child.stdin.destroyed) return this.#pipeBroken ?? new MediaProcessError('the pipe to the media process is closed')
    if (this.#closing !== undefined || this.#child.stdin.writableEnded) return new MediaProcessError('the media process is closing')
    return undefined
  }

  #pendingLimit(what: string): Error | undefined {
    const pending = this.#starts.size + this.#abandoned.size + this.#readies.length + this.#jobs.size + this.#releases.size + this.#watches.size
    return pending >= this.#maxPendingRequests ? new MediaProcessError(`the ${what} request exceeds the media pending request limit of ${this.#maxPendingRequests}`) : undefined
  }

  #writeRefusal(what: string): MediaProcessError {
    return new MediaProcessError(`the ${what} request was not sent: the media pipe reached its byte limit of ${this.#maxPendingBytes} or is awaiting drain`)
  }

  // Admit the entire message before either part reaches the pipe. No partial header is ever queued.
  #write(head: Buffer): boolean {
    return this.#writeWithPayload(head, new Uint8Array())
  }

  #writeWithPayload(head: Buffer, payload: Uint8Array, mayWait = true): boolean {
    if (this.#unavailable() !== undefined || this.#child.stdin.writableLength + this.#queuedBytes + head.byteLength + payload.byteLength > this.#maxPendingBytes) return false
    if (this.#waitingDrain || this.#writes.length > 0) {
      if (!mayWait || this.#writes.length >= this.#maxPendingRequests) return false
      this.#writes.push({ head, payload })
      this.#queuedBytes += head.byteLength + payload.byteLength
    } else this.#send(head, payload)
    return true
  }

  #send(head: Buffer, payload: Uint8Array): void {
    this.#child.stdin.cork()
    const headAccepted = this.#child.stdin.write(head)
    const payloadAccepted = payload.byteLength === 0 || this.#child.stdin.write(payload)
    this.#child.stdin.uncork()
    this.#waitingDrain = !headAccepted || !payloadAccepted || this.#child.stdin.writableNeedDrain
    this.#traffic.headerBytes += head.byteLength
  }

  #flushWrites(): void {
    if (this.#failure !== undefined || this.#pipeBroken !== undefined || this.#exit !== undefined) return
    while (!this.#waitingDrain) {
      const write = this.#writes.shift()
      if (write === undefined) break
      this.#queuedBytes -= write.head.byteLength + write.payload.byteLength
      this.#send(write.head, write.payload)
    }
    if (this.#endInput && this.#writes.length === 0 && !this.#child.stdin.writableEnded) this.#child.stdin.end()
  }

  // Lets the process hold Node open only while something of ours is with it: a running recording or an
  // unanswered request. The child and each of its three pipes count on their own; the pipes are typed as plain
  // streams but are the sockets Node opens for `stdio: 'pipe'`, and only a socket can be let go of.
  #attend(): void {
    const waiting = this.#starts.size + this.#readies.length + this.#jobs.size + this.#releases.size
    const busy = !this.#released && (this.#recordings.size > 0 || waiting > 0)
    const pipes = [this.#child.stdin, this.#child.stdout, this.#child.stderr].filter((pipe) => pipe instanceof Socket)
    for (const handle of [this.#child, ...pipes]) {
      if (busy) handle.ref()
      else handle.unref()
    }
  }

  #dispatch(reply: MediaReply): void {
    if (this.#failure !== undefined) return
    switch (reply.type) {
      case 'hello':
        return this.#fail(new MediaProtocolError('the media process greeted twice'))
      case 'ready':
        return this.#ready(reply)
      case 'started':
        return this.#started(reply)
      case 'ended':
        return this.#endedRecording(reply)
      case 'thumbnail':
      case 'frames':
      case 'leftovers':
        return this.#answered(reply)
      case 'watching':
        return this.#watching(reply)
      case 'live':
        return this.#live(reply)
      case 'watchEnded':
        return this.#watchEnded(reply)
      case 'released':
        return this.#releasedRecording(reply)
      case 'error':
        return this.#refused(reply)
      case 'bye':
        this.#bye = reply
        return
    }
  }

  #ready(reply: Ready): void {
    this.#encoder = reply.encoder
    const answer = this.#readies.shift()
    this.#attend()
    // An answer nobody waits for any more, after a timeout, still updates what the encoder is known to do.
    answer?.resolve(reply.encoder)
  }

  #started(reply: Started): void {
    const abandoned = this.#abandoned.get(reply.recordingId)
    const pending = this.#starts.get(reply.recordingId)
    if (abandoned === undefined && pending === undefined) return this.#fail(new MediaProtocolError(`the media process started ${reply.recordingId}, which was never asked for`))
    const requested = pending?.requested ?? abandoned
    if (requested === undefined) return
    const problem = recordingReplyProblem(reply, requested)
    if (problem !== undefined) return this.#fail(new MediaProtocolError(problem))
    this.#abandoned.delete(reply.recordingId)
    this.#starts.delete(reply.recordingId)
    const ended = deferred<Ended>()
    const recording = new Recording(this, reply, ended.promise)
    const ownership = captureEncoderOwnership(this.#ownership, reply.encoderPid)
    this.#ownershipProblems.push(...ownership.problems)
    this.#recordings.set(reply.recordingId, { recording, ended, ownership, requested })
    this.#attend()
    // Nobody waits for a start that timed out, but its encoder is now running: it is finished at once and kept
    // until its `Ended`, so a process that dies first still has this encoder stopped.
    if (abandoned !== undefined) {
      if (!this.sendFinish(reply.recordingId, undefined)) this.#fail(this.#writeRefusal('abandoned start finish'))
    }
    else pending?.answer.resolve({ kind: 'started', recording })
  }

  #endedRecording(reply: Ended): void {
    const pending = this.#starts.get(reply.recordingId)
    const running = this.#recordings.get(reply.recordingId)
    const abandoned = this.#abandoned.get(reply.recordingId)
    const requested = pending?.requested ?? running?.requested ?? abandoned
    if (requested === undefined) return this.#fail(new MediaProtocolError(`the media process ended ${reply.recordingId}, which was never asked for`))
    const problem = recordingReplyProblem(reply, requested, running?.recording.started.path)
    if (problem !== undefined) return this.#fail(new MediaProtocolError(problem))
    if (this.#abandoned.delete(reply.recordingId)) return
    if (pending !== undefined) {
      this.#starts.delete(reply.recordingId)
      this.#attend()
      return pending.answer.resolve({ kind: 'ended', ended: reply })
    }
    if (running === undefined) return this.#fail(new MediaProtocolError(`the media process ended ${reply.recordingId}, which never started`))
    this.#recordings.delete(reply.recordingId)
    if (running.recording.started.framesPath !== undefined) this.#endedRecordings.set(reply.recordingId, running.recording)
    this.#attend()
    if (running.ownership.problems.length > 0) {
      running.ended.reject(new MediaRecordingLostError(`Recording ${reply.recordingId} has unknown process cleanup: ${running.ownership.problems.join(' ')}`, reply.recordingId, reply.partialPath))
    } else running.ended.resolve(reply)
  }

  #answered(reply: Thumbnail | FrameSequence | Leftovers): void {
    const job = this.#jobs.get(reply.requestId)
    if (job === undefined) {
      if (this.#abandonedJobs.delete(reply.requestId)) return
      return this.#fail(new MediaProtocolError(`the media process answered request ${reply.requestId}, which was never asked`))
    }
    if (job.kind !== reply.type) return this.#fail(new MediaProtocolError(`the media process answered the ${job.kind} request ${reply.requestId} with ${reply.type}`))
    if (job.kind === 'frames' && reply.type === 'frames' && (reply.recordingId !== job.recordingId || reply.fromUs !== job.fromUs || reply.toUs !== job.toUs)) {
      return this.#fail(new MediaProtocolError(`the frames reply ${reply.requestId} differs from the requested recording ${job.recordingId} or interval`))
    }
    this.#jobs.delete(reply.requestId)
    this.#attend()
    if (job.kind === 'thumbnail' && reply.type === 'thumbnail') job.answer.resolve(reply)
    else if (job.kind === 'frames' && reply.type === 'frames') job.answer.resolve(reply)
    else if (job.kind === 'leftovers' && reply.type === 'leftovers') job.answer.resolve(reply)
  }

  #watching(reply: Watching): void {
    const watch = this.#watches.get(reply.recordingId)
    if (watch === undefined) return this.#fail(new MediaProtocolError(`the media process began a live view of ${reply.recordingId}, which was never asked for`))
    watch.begun.resolve({ recordingId: reply.recordingId, options: reply, ended: watch.ended.promise, stop: (timeoutMs) => this.#stopWatch(watch, timeoutMs) })
  }

  #live(reply: LiveFrame): void {
    const watch = this.#watches.get(reply.recordingId)
    // Frames still on their way after an unwatch, or for a view this side stopped, are let go.
    if (watch === undefined || watch.stopping) return
    try {
      watch.onFrame(reply)
    } catch {
      // A watcher that cannot take frames is gone; the view stops and the recording is untouched.
      void this.#stopWatch(watch, killGraceMs).catch(() => {})
    }
  }

  #watchEnded(reply: WatchEnded): void {
    const watch = this.#watches.get(reply.recordingId)
    if (watch === undefined) return
    this.#watches.delete(reply.recordingId)
    watch.begun.reject(new MediaProcessError(`the live view of ${reply.recordingId} ended before it began: ${reply.reason}`))
    watch.ended.resolve(reply)
  }

  #releasedRecording(reply: Released): void {
    this.#endedRecordings.get(reply.recordingId)?.noteReleased()
    this.#endedRecordings.delete(reply.recordingId)
    const answer = this.#releases.get(reply.recordingId)
    this.#releases.delete(reply.recordingId)
    this.#attend()
    answer?.resolve(reply)
  }

  #refused(reply: MediaError): void {
    const { recordingId: id, requestId, request } = reply
    if (requestId !== undefined) {
      if (this.#abandonedJobs.delete(requestId)) return
      const job = this.#jobs.get(requestId)
      if (job !== undefined) {
        this.#jobs.delete(requestId)
        this.#attend()
        return job.answer.reject(new MediaRequestError(reply))
      }
    }
    if (id !== undefined && request === 'start') {
      if (this.#abandoned.delete(id)) return
      const answer = this.#starts.get(id)
      if (answer !== undefined) {
        this.#starts.delete(id)
        this.#attend()
        return answer.answer.reject(new MediaRequestError(reply))
      }
    }
    if (id !== undefined && request === 'watch') {
      const watch = this.#watches.get(id)
      if (watch !== undefined) {
        this.#watches.delete(id)
        watch.begun.reject(new MediaRequestError(reply))
        watch.ended.reject(new MediaRequestError(reply))
        return
      }
    }
    if (id !== undefined && request === 'release') {
      const answer = this.#releases.get(id)
      if (answer !== undefined) {
        this.#releases.delete(id)
        this.#attend()
        return answer.reject(new MediaRequestError(reply))
      }
    }
    this.#errors.push(reply)
    if (this.#errors.length > keptErrors) this.#errors.shift()
  }

  #fail(error: Error): void {
    if (this.#failure !== undefined) return
    this.#failure = error
    this.#writes.length = 0
    this.#queuedBytes = 0
    this.#forcedCleanup = true
    this.#forcedStops.push(this.#ownership.signalReportAsync('SIGKILL', new Deadline(killGraceMs)).then((report) => {
      this.#ownershipProblems.push(...report.problems, ...report.identityRefusals)
    }))
  }

  // The process is gone and reaped, so its own group needs no signal and its pid is not ours to name again.
  // Waiting requests learn how it ended; running recordings have their encoders stopped and learn it too, with any
  // file left behind. Nothing waiting is given an invented result.
  #ended(exit: ProcessExit): void {
    this.#exit = exit
    const cause = this.#failure === undefined ? '' : ` after ${this.#failure.message}`
    const reason = `the media process ended with ${describeExit(exit)}${cause}${stderrNote(this.#stderr)}`
    this.#loseEverything(reason)
  }

  #loseEverything(reason: string): void {
    this.#writes.length = 0
    this.#queuedBytes = 0
    for (const pending of this.#starts.values()) pending.answer.reject(new MediaProcessError(reason))
    this.#starts.clear()
    this.#abandoned.clear()
    for (const answer of this.#readies.splice(0)) answer.reject(new MediaProcessError(reason))
    for (const job of this.#jobs.values()) job.answer.reject(new MediaProcessError(reason))
    this.#jobs.clear()
    for (const answer of this.#releases.values()) answer.reject(new MediaProcessError(reason))
    this.#releases.clear()
    for (const watch of this.#watches.values()) {
      watch.begun.reject(new MediaProcessError(reason))
      watch.ended.reject(new MediaProcessError(reason))
    }
    this.#watches.clear()
    for (const running of this.#recordings.values()) this.#reclaims.push(reclaim(running, reason, this.#forcedCleanup))
    this.#recordings.clear()
    // Kept frames are the process's own working file and worth nothing without it.
    for (const recording of this.#endedRecordings.values()) removeKeptFrames(recording.started)
    this.#endedRecordings.clear()
    this.#attend()
  }
}

// Ownership was captured at started, while the worker was verified. Reclaim never claims a pid from a dead worker.
async function reclaim({ recording, ended, ownership }: Running, reason: string, forcedCleanup: boolean): Promise<string[]> {
  const { path, recordingId } = recording.started
  const problems = [...ownership.problems]
  let encoder = 'its encoder ownership and completion are unknown; unrecorded processes were left alone'
  if (ownership.owner !== undefined) {
    const deadline = new Deadline(orphanGraceMs + 2 * killGraceMs)
    const goneAlone = await groupGoneWithin(ownership.owner, orphanGraceMs, deadline)
    encoder = forcedCleanup ? 'its recorded encoder processes were stopped or exited during forced cleanup' : 'its recorded encoder processes exited on their own'
    if (!goneAlone) {
      const report = await ownership.owner.signalReportAsync('SIGKILL', deadline)
      problems.push(...report.problems, ...report.identityRefusals)
      const gone = await groupGoneWithin(ownership.owner, killGraceMs, deadline)
      encoder = gone ? 'its recorded encoder processes were stopped' : 'its encoder could not be confirmed stopped'
      if (!gone) problems.push('Recorded encoder processes or processes with unknown ownership are still running after cleanup.')
    }
    problems.push(...ownership.owner.readProblems)
  }
  const partial = `${path}.partial`
  const partialPath = existsSync(partial) ? partial : undefined
  const left = partialPath === undefined ? 'no file was left' : `it left ${partialPath}`
  const frames = removeKeptFrames(recording.started)
  const cleanup = problems.length === 0 ? '' : `; cleanup failed: ${[...new Set(problems)].join(' ')}`
  ended.reject(new MediaRecordingLostError(`${reason}; recording ${recordingId} did not end: ${encoder}, and ${left}${frames}${cleanup}`, recordingId, partialPath))
  return problems
}

// Removes the kept frames a dead process left, when they are a regular file where the process said they would be,
// and says what happened in words a rejection can carry.
function removeKeptFrames(started: Started): string {
  const path = started.framesPath
  if (path === undefined) return ''
  try {
    if (!lstatSync(path).isFile()) return `; its kept frames at ${path} are not a regular file and were left alone`
    unlinkSync(path)
    return '; its kept frames were removed'
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''
    return `; its kept frames at ${path} could not be removed: ${errorMessage(error)}`
  }
}

/** A live view that has begun. `ended` settles once with its totals; `stop` ends it and waits for that. */
export type LiveWatch = { recordingId: string; options: Watching; ended: Promise<WatchEnded>; stop(timeoutMs: number): Promise<WatchEnded> }

/**
 * One running recording. Its `ended` settles with the process's `Ended`, whether the client finished it or not.
 * Its kept frames can be asked for while it runs and after it ends, until it is released.
 */
export class Recording {
  readonly started: Started
  readonly #media: MediaProcess
  readonly #ended: Promise<Ended>
  #finishing = false
  #over = false
  #released = false

  /** Made by `MediaProcess.record`; `ended` settles with the process's answer for this recording. */
  constructor(media: MediaProcess, started: Started, ended: Promise<Ended>) {
    this.#media = media
    this.started = started
    this.#ended = ended
    const over = () => {
      this.#over = true
    }
    ended.then(over, over)
  }

  get id(): string {
    return this.started.recordingId
  }

  get identity(): RecordingIdentity {
    return this.started.identity
  }

  /** The recording's one `Ended`. It can come before `finish`, when the encoder fails or the process shuts down. */
  get ended(): Promise<Ended> {
    return this.#ended
  }

  /** Whether the process has removed the recording's kept frames. */
  get released(): boolean {
    return this.#released
  }

  /**
   * Sends a frame. Timestamps must not go backwards; the process counts and skips one that does, and one that reuses
   * a frame id. Throws `RangeError` for an id the process would refuse, a timestamp that is not a whole number of
   * microseconds from 0, or a frame larger than `MAX_FRAME_BYTES`.
   */
  frame(frame: Frame): FrameOutcome {
    checkFrame(frame)
    if (this.#finishing || this.#over) return 'closed'
    return this.#media.sendFrame(this.id, frame)
  }

  /**
   * Tells the process capture could not deliver frames from `fromUs` to `toUs`, so the ending and frame sequences name
   * the gap with its reason. Says whether it was written; `false` once the recording is finishing or over. Throws
   * `RangeError` for numbers that are not whole microseconds in order, or a reason that is not a code.
   */
  captureGap(gap: CaptureGap): boolean {
    checkCaptureGap(gap)
    if (this.#finishing || this.#over) return false
    return this.#media.sendCaptureGap(this.id, gap)
  }

  /**
   * Finishes the recording and waits up to `timeoutMs` for its `Ended`; give it more than the recording's
   * deadline. With `endTimestampUs` the last frame stays until then. Rejects with `MediaProcessError` when no
   * `Ended` comes in time; the recording's `ended` can still settle later.
   */
  finish(timeoutMs: number, endTimestampUs?: number): Promise<Ended> {
    try {
      if (endTimestampUs !== undefined) checkTimestamp('endTimestampUs', endTimestampUs)
    } catch (error) {
      return Promise.reject(error)
    }
    if (!this.#finishing && !this.#over) {
      this.#finishing = true
      if (!this.#media.sendFinish(this.id, endTimestampUs)) return Promise.reject(new MediaProcessError(`the finish request for ${this.id} was not sent: the media pipe is unavailable, at its byte limit or awaiting drain`))
    }
    return settleWithin(this.#ended, timeoutMs).then((ended) => {
      if (ended === undefined) throw new MediaProcessError(`recording ${this.id} did not end within ${timeoutMs} ms of its finish`)
      return ended
    })
  }

  /**
   * The kept frames whose capture times lie in an interval, as `FrameSequenceRequest` describes, with the stretches
   * that had no kept frame. Works while the recording runs and after it ends, until it is released.
   */
  frames(request: FrameSequenceRequest, timeoutMs: number): Promise<FrameSequence> {
    return this.#media.frames(this.id, request, timeoutMs)
  }

  /**
   * Starts a live view: the newest frame, fitted within the size, as JPEG, at most `maxFps` a second, handed to
   * `onFrame` as it comes. One view per recording; a slow or absent watcher never changes the recording. A watcher
   * that throws stops the view. Resolves once the process has begun the view.
   */
  watch(options: WatchOptions, onFrame: (frame: LiveFrame) => void, timeoutMs: number): Promise<LiveWatch> {
    if (this.#finishing || this.#over) return Promise.reject(new MediaProcessError(`recording ${this.id} is finishing or over; it has nothing more to show`))
    return this.#media.watch(this.id, options, onFrame, timeoutMs)
  }

  /** Removes the recording's kept frames once it has ended. Rejects with `MediaRequestError` while it runs. */
  release(timeoutMs: number): Promise<Released> {
    return this.#media.release(this.id, timeoutMs)
  }

  /** Marks the kept frames as removed, when the process says so. */
  noteReleased(): void {
    this.#released = true
  }
}

// Why a start cannot be sent: an id the process would refuse, or a number that is not a whole number in range.
// The process checks these too; this catches what JSON would carry but the process could not read, such as a
// fractional frame rate, and what would break the stream's framing, such as an id that outgrows a header.
function invalidStart(start: StartRecording): string | undefined {
  const id = invalidId('the recording id', start.recordingId, MAX_ID_CHARACTERS) ?? invalidOutput(start.output)
  if (id !== undefined) return id
  for (const name of ['runId', 'attemptId', 'testId', 'app', 'sessionId'] as const) {
    const problem = invalidId(`the identity's ${name}`, start.identity[name], MAX_IDENTITY_CHARACTERS)
    if (problem !== undefined) return problem
  }
  const required: [string, number][] = [
    ['width', start.width],
    ['height', start.height],
    ['fps', start.fps],
    ['deadlineMs', start.deadlineMs],
  ]
  const optional: [string, number | undefined][] = [
    ['queueFrames', start.queueFrames],
    ['queueBytes', start.queueBytes],
    ['maxGapMs', start.maxGapMs],
    ['maxDurationMs', start.maxDurationMs],
    ['stallMs', start.stallMs],
    ['frameStoreBytes', start.frameStoreBytes],
  ]
  return wholeNumbers([...required, ...optional])
}

function invalidThumbnail(request: ThumbnailRequest, image: StillImage): string | undefined {
  const output = invalidOutput(request.output)
  if (output !== undefined) return output
  if (image.bytes.byteLength === 0) return 'the image has no bytes'
  if (image.bytes.byteLength > MAX_FRAME_BYTES) return `an image of ${image.bytes.byteLength} bytes is larger than the ${MAX_FRAME_BYTES} the media process accepts`
  return wholeNumbers([['maxWidth', request.maxWidth], ['maxHeight', request.maxHeight], ['quality', request.quality]]) ?? sideLimit(request.maxWidth, request.maxHeight) ?? qualityLimit(request.quality)
}

function invalidSequence(request: FrameSequenceRequest): string | undefined {
  const numbers = wholeNumbers([['maxFrames', request.maxFrames], ['maxWidth', request.maxWidth], ['maxHeight', request.maxHeight], ['maxBytes', request.maxBytes], ['quality', request.quality], ['minGapUs', request.minGapUs]])
  if (numbers !== undefined) return numbers
  if (!Number.isSafeInteger(request.fromUs) || request.fromUs < 0 || !Number.isSafeInteger(request.toUs) || request.toUs < request.fromUs) return `the interval must be whole microseconds from 0, its end not before its start; it is ${request.fromUs} to ${request.toUs}`
  if (request.maxFrames > MAX_SEQUENCE_FRAMES) return `maxFrames may be at most ${MAX_SEQUENCE_FRAMES}; it is ${request.maxFrames}`
  if (request.maxBytes !== undefined && request.maxBytes > MAX_SEQUENCE_BYTES) return `maxBytes may be at most ${MAX_SEQUENCE_BYTES}; it is ${request.maxBytes}`
  return sideLimit(request.maxWidth, request.maxHeight) ?? qualityLimit(request.quality)
}

function invalidWatch(options: WatchOptions): string | undefined {
  const numbers = wholeNumbers([['maxWidth', options.maxWidth], ['maxHeight', options.maxHeight], ['maxFps', options.maxFps], ['quality', options.quality]])
  if (numbers !== undefined) return numbers
  if (options.maxFps > 30) return `maxFps may be at most 30; it is ${options.maxFps}`
  return sideLimit(options.maxWidth, options.maxHeight) ?? qualityLimit(options.quality)
}

function wholeNumbers(values: readonly [string, number | undefined][]): string | undefined {
  for (const [name, value] of values) {
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1) return `${name} must be a whole number from 1; it is ${value}`
  }
  return undefined
}

function sideLimit(width: number, height: number): string | undefined {
  return width > MAX_OUTPUT_SIDE || height > MAX_OUTPUT_SIDE ? `the size may be at most ${MAX_OUTPUT_SIDE} on each side; it is ${width} by ${height}` : undefined
}

function qualityLimit(quality: number | undefined): string | undefined {
  return quality !== undefined && quality > 100 ? `quality may be at most 100; it is ${quality}` : undefined
}

// An id the process takes: one to `limit` characters, none of them a control character.
function invalidId(name: string, value: string, limit: number): string | undefined {
  const length = [...value].length
  if (length === 0) return `${name} is empty`
  if (length > limit) return `${name} has ${length} characters; the most is ${limit}`
  // Control characters, C0, DEL and C1, as Rust's `char::is_control` names them, which the process refuses.
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return `${name} holds a control character`
  return undefined
}

// An output the process can read. It checks the rest of the path itself and refuses with an answer; only the
// length matters here, since a path long enough to carry the header past its limit would end every recording.
function invalidOutput(output: string): string | undefined {
  const bytes = Buffer.byteLength(output, 'utf8')
  return bytes > MAX_PATH_BYTES ? `the output path has ${bytes} bytes; the most is ${MAX_PATH_BYTES}` : undefined
}

// A frame the process can read: ids it takes, a timestamp it can parse and bytes within its payload limit. A larger
// payload would be a protocol violation, which ends every recording and the process, not just this frame.
function checkFrame(frame: Frame): void {
  const id = invalidId('the frame id', frame.frameId, MAX_FRAME_ID_CHARACTERS) ?? (frame.actionId === undefined ? undefined : invalidId('the action id', frame.actionId, MAX_FRAME_ID_CHARACTERS)) ?? (frame.observationId === undefined ? undefined : invalidId('the observation id', frame.observationId, MAX_FRAME_ID_CHARACTERS))
  if (id !== undefined) throw new RangeError(id)
  checkTimestamp('timestampUs', frame.timestampUs)
  if (frame.bytes.byteLength > MAX_FRAME_BYTES) throw new RangeError(`a frame of ${frame.bytes.byteLength} bytes is larger than the ${MAX_FRAME_BYTES} the media process accepts`)
}

function checkCaptureGap(gap: CaptureGap): void {
  checkTimestamp('fromUs', gap.fromUs)
  checkTimestamp('toUs', gap.toUs)
  if (gap.toUs < gap.fromUs) throw new RangeError(`a capture gap ends before it starts: ${gap.fromUs} to ${gap.toUs}`)
  if (!reasonPattern.test(gap.reason)) throw new RangeError('a capture gap reason is a code of lower-case letters, digits and underscores, at most 64 characters')
}

// A timestamp the process can read: a whole number of microseconds from 0. JSON would carry a fraction the
// process then refuses, losing the frame while this side counted it sent.
function checkTimestamp(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a whole number of microseconds from 0; it is ${value}`)
}

function stderrNote(stderr: string): string {
  const lines = stderr.trim().split('\n').slice(-5).join(' | ')
  return lines === '' ? '' : `; its last output: ${lines}`
}

// Waits for an answer up to `timeoutMs`; when it does not come, `gaveUp` runs and the wait rejects with `message`.
function withTimeout<T>(answer: Deferred<T>, timeoutMs: number, message: string, gaveUp: () => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      gaveUp()
      reject(new MediaProcessError(message))
    }, timeoutMs)
  })
  const settled = Promise.race([answer.promise, late])
  void settled.finally(() => clearTimeout(timer)).catch(() => {})
  return settled
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, undefined)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer)
  }
}

async function groupGoneWithin(ownership: OwnedProcessGroup, timeoutMs: number, deadline: Deadline = new Deadline(timeoutMs)): Promise<boolean> {
  const wait = new Deadline(Math.min(timeoutMs, deadline.remainingMs))
  for (;;) {
    if (!(await ownership.remainsAsync(deadline))) return true
    if (wait.reached || deadline.reached) return false
    await delay(Math.min(20, wait.waitToEndMs, deadline.waitToEndMs))
  }
}

// An unowned process may remain, but a failed cleanup must still let its caller report and exit.
function releaseReferences(child: ChildProcessWithoutNullStreams): void {
  const pipes = [child.stdin, child.stdout, child.stderr].filter((pipe) => pipe instanceof Socket)
  for (const handle of [child, ...pipes]) handle.unref()
}

// Framing validates shapes; the request establishes whose evidence these bytes may become.
function recordingReplyProblem(reply: Started | Ended, requested: RequestedRecording, startedPath?: string): string | undefined {
  for (const key of ['runId', 'attemptId', 'testId', 'app', 'sessionId'] as const) {
    if (reply.identity[key] !== requested.identity[key]) return `the ${reply.type} reply for ${reply.recordingId} differs from its requested identity (${key})`
  }
  const paths = startedPath === undefined ? [`${requested.output}.mp4`, `${requested.output}.webm`] : [startedPath]
  if (reply.path !== undefined && !paths.includes(reply.path)) return `the ${reply.type} reply for ${reply.recordingId} has a video path different from its requested output`
  if (reply.type === 'started') {
    if (reply.path !== `${requested.output}.${reply.container}`) return `the started reply for ${reply.recordingId} has a video path different from its requested container`
    if (reply.framesPath !== undefined && reply.framesPath !== `${requested.output}.frames`) return `the started reply for ${reply.recordingId} has a frames path different from its requested output`
  } else if (reply.partialPath !== undefined && !paths.some(path => reply.partialPath === `${path}.partial`)) return `the ended reply for ${reply.recordingId} has a partial video path different from its requested output`
  return undefined
}
