import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { Bye, Ended, FrameFormat, Hello, MediaError, MediaReply, StartRecording, Started } from './protocol.ts'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { describeExit } from '../shared/process-exit.ts'
import { encodeRequestHead, MAX_FRAME_BYTES, MAX_ID_CHARACTERS, MEDIA_PROTOCOL_VERSION, MediaProtocolError, ReplyReader } from './protocol.ts'

export type { Bye, Ended, EndStatus, FrameCounts, FrameFormat, Gap, Hello, MediaError, Started, StartRecording } from './protocol.ts'
export { MAX_FRAME_BYTES, MAX_ID_CHARACTERS } from './protocol.ts'

/** The most frame bytes left waiting in the pipe before a new frame is dropped here, unless told otherwise. */
const defaultMaxPendingBytes = 32 * 1024 * 1024
/** How long `close` waits for a killed process group to go. */
const killGraceMs = 1000
/**
 * How long an encoder whose media process died gets to finish its file on its own: its input has closed, which
 * is how ffmpeg is told to write the container. After that its process group is killed.
 */
const orphanGraceMs = 1000
// The process's stderr is for its own failures; this much of its end is enough to explain one.
const stderrTailBytes = 8 * 1024
// How many errors that belonged to no waiting request are kept; older ones go, so a process that keeps refusing
// frames for an id nobody waits on cannot grow this side without bound.
const keptErrors = 64

export type MediaProcessOptions = {
  /** The `retest-media` binary, or a program that runs it, such as `/usr/bin/time`. */
  executable: string
  /** Arguments for `executable`. `mediaArguments` builds the binary's own. */
  args?: readonly string[]
  /** How long the process may take to greet before it is stopped. */
  startTimeoutMs: number
  /**
   * The most bytes allowed to wait in the pipe to the process. A frame sent while more are waiting is dropped
   * here and counted, so a process that cannot keep up never makes this one hold every frame in memory.
   */
  maxPendingBytes?: number
}

/**
 * The media binary's own arguments. Without `ffmpeg` the process runs the `ffmpeg` it finds on `PATH`.
 *
 * @example mediaArguments({ ffmpeg: '/opt/homebrew/bin/ffmpeg' }) // ['--ffmpeg', '/opt/homebrew/bin/ffmpeg']
 */
export function mediaArguments(options: { ffmpeg?: string }): string[] {
  return options.ffmpeg === undefined ? [] : ['--ffmpeg', options.ffmpeg]
}

/** How the media process ended. `forced` is true when `close` had to kill its process group. */
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
 * A frame as the capture produced it. `timestampUs` is a whole number of microseconds. `bytes` is written as it
 * is and must not change until it is sent, and holds at most `MAX_FRAME_BYTES`.
 */
export type Frame = { timestampUs: number; format: FrameFormat; bytes: Uint8Array }

/** What this client wrote, for measuring the cost of the pipe. */
export type MediaTraffic = { framesSent: number; framesDropped: number; frameBytes: number; headerBytes: number }

/** Thrown when the media process cannot start, will not greet, ends, or does not answer in time. */
export class MediaProcessError extends Error {
  override readonly name: string = 'MediaProcessError'
}

/**
 * The media process ended before this recording did. Its encoder was given a moment to finish its file and then
 * its process group was killed; `partialPath` names the unfinished or unnamed file it left, when there is one.
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

type Running = { recording: Recording; ended: Deferred<Ended> }

/**
 * Retest's media process, `retest-media`, run as a child in a process group of its own; each encoder it starts
 * leads a group of its own too. Frames go to it over a pipe with their bytes untouched; each recording ends with
 * exactly one `Ended` from the process. The client never invents an outcome: if the process ends before a
 * recording does, the client stops that recording's encoder group and the recording's promise rejects with how
 * the process ended and any file the encoder left.
 *
 * The process holds this one open only while a recording runs or a start is unanswered. A `close` forgotten on
 * an idle process does not keep Node alive: when this process exits, however it exits, the media process reads
 * the end of its input and shuts down on its own, ending every recording `stopped` and stopping every encoder.
 * A signal that ends this process does the same, since the media process is not in its group.
 *
 * @example
 * const media = await MediaProcess.start({ executable: 'media/target/release/retest-media', startTimeoutMs: 5000 })
 * const start = await media.record({ recordingId: 'test-1', width: 800, height: 600, fps: 30, output: '/tmp/test-1', deadlineMs: 10_000 }, 5000)
 * if (start.kind === 'started') start.recording.frame({ timestampUs, format: 'png', bytes })
 */
export class MediaProcess {
  readonly hello: Hello
  readonly pid: number
  /** Settles when the process has exited and its output is read. */
  readonly exited: Promise<ProcessExit>
  readonly #child: ChildProcessWithoutNullStreams
  readonly #maxPendingBytes: number
  readonly #starts = new Map<string, Deferred<RecordingStart>>()
  readonly #recordings = new Map<string, Running>()
  // Starts that timed out here and have not been answered. A late `started` for one becomes a recording the
  // client finishes at once, so its encoder is known and stopped like any other if the process dies.
  readonly #abandoned = new Set<string>()
  readonly #errors: MediaError[] = []
  readonly #traffic: MediaTraffic = { framesSent: 0, framesDropped: 0, frameBytes: 0, headerBytes: 0 }
  // The encoders of recordings the process left running when it ended, being stopped. `close` waits for them.
  readonly #reclaims: Promise<void>[] = []
  #bye: Bye | undefined
  #exit: ProcessExit | undefined
  #failure: Error | undefined
  #pipeBroken: Error | undefined
  #stderr = ''
  #closing: Promise<MediaExit> | undefined

  private constructor(child: ChildProcessWithoutNullStreams, hello: Hello, exited: Promise<ProcessExit>, maxPendingBytes: number) {
    this.#child = child
    this.hello = hello
    this.pid = child.pid ?? 0
    this.exited = exited
    this.#maxPendingBytes = maxPendingBytes
  }

  /** Starts the process and waits for its greeting. Throws `MediaProcessError` when either fails. */
  static async start(options: MediaProcessOptions): Promise<MediaProcess> {
    const child = spawn(options.executable, options.args ?? [], { stdio: 'pipe', detached: true })
    const reader = new ReplyReader()
    const greeting = deferred<Hello>()
    const exited = deferred<ProcessExit>()
    let stderr = ''
    let pipeBroken: Error | undefined
    let closed = false
    let instance: MediaProcess | undefined
    // Replies that arrive with the greeting, before the instance exists, wait here.
    const early: MediaReply[] = []
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-stderrTailBytes)
      if (instance !== undefined) instance.#stderr = stderr
    })
    child.stdout.on('data', (chunk: Buffer) => {
      let replies: MediaReply[]
      try {
        replies = reader.push(chunk)
      } catch (error) {
        const failure = error instanceof Error ? error : new MediaProtocolError(String(error))
        greeting.reject(failure)
        if (instance !== undefined) instance.#fail(failure)
        signalGroup(child.pid, 'SIGKILL')
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
      const exit = { code, signal }
      greeting.reject(new MediaProcessError(`${options.executable} ended with ${describeExit(exit)} before it greeted${stderrNote(stderr)}`))
      if (instance !== undefined) instance.#ended(exit)
      exited.resolve(exit)
    })
    const timer = setTimeout(() => {
      greeting.reject(new MediaProcessError(`${options.executable} did not greet within ${options.startTimeoutMs} ms`))
    }, options.startTimeoutMs)
    let hello: Hello
    try {
      hello = await greeting.promise
    } catch (error) {
      // A process that is already gone has nothing to kill, and its reaped pid may already name another group.
      if (!closed) signalGroup(child.pid, 'SIGKILL')
      throw error
    } finally {
      clearTimeout(timer)
    }
    if (hello.protocol !== MEDIA_PROTOCOL_VERSION) {
      signalGroup(child.pid, 'SIGKILL')
      throw new MediaProcessError(`${options.executable} speaks media protocol ${hello.protocol}; this client speaks ${MEDIA_PROTOCOL_VERSION}`)
    }
    instance = new MediaProcess(child, hello, exited.promise, options.maxPendingBytes ?? defaultMaxPendingBytes)
    instance.#stderr = stderr
    instance.#pipeBroken = pipeBroken
    instance.#attend()
    for (const reply of early) instance.#dispatch(reply)
    return instance
  }

  /**
   * Starts a recording. Resolves once the process answers: with the running recording, or with the `Ended` that
   * says why it could not begin. Rejects with `RangeError` before sending when a number is not a whole number in
   * range or the id is empty or longer than `MAX_ID_CHARACTERS`, with `MediaRequestError` when the process
   * refuses the request, and with `MediaProcessError` when the process has ended, is closing, or does not answer
   * within `timeoutMs`. A start that timed out here and is answered later is finished at once.
   */
  record(start: StartRecording, timeoutMs: number): Promise<RecordingStart> {
    const invalid = invalidStart(start)
    if (invalid !== undefined) return Promise.reject(new RangeError(invalid))
    const unavailable = this.#unavailable()
    if (unavailable !== undefined) return Promise.reject(unavailable)
    if (this.#starts.has(start.recordingId) || this.#recordings.has(start.recordingId) || this.#abandoned.has(start.recordingId)) {
      return Promise.reject(new MediaProcessError(`recording ${start.recordingId} already started`))
    }
    const answer = deferred<RecordingStart>()
    this.#starts.set(start.recordingId, answer)
    this.#attend()
    this.#write(encodeRequestHead({ type: 'start', ...start }))
    const timer = setTimeout(() => {
      if (this.#starts.get(start.recordingId) !== answer) return
      this.#starts.delete(start.recordingId)
      this.#abandoned.add(start.recordingId)
      this.#attend()
      answer.reject(new MediaProcessError(`the media process did not answer the start of ${start.recordingId} within ${timeoutMs} ms`))
    }, timeoutMs)
    void answer.promise.finally(() => clearTimeout(timer)).catch(() => {})
    return answer.promise
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
   * deadline, then the process says bye and exits. A process that has not exited within `timeoutMs` has its
   * group killed, and the encoder of every recording it left running is stopped before this resolves, so
   * nothing of the process outlives the call. A second call waits for the first. Frames sent once it begins are
   * `not_sent`.
   */
  close(timeoutMs: number): Promise<MediaExit> {
    if (this.#closing === undefined) {
      if (this.#unavailable() === undefined) {
        this.#write(encodeRequestHead({ type: 'shutdown' }))
        this.#child.stdin.end()
      }
      this.#closing = this.#close(timeoutMs)
    }
    return this.#closing
  }

  async #close(timeoutMs: number): Promise<MediaExit> {
    let exit = await settleWithin(this.exited, timeoutMs)
    let forced = false
    if (exit === undefined) {
      signalGroup(this.pid, 'SIGKILL')
      exit = await settleWithin(this.exited, killGraceMs)
      if (exit === undefined) throw new MediaProcessError(`process group ${this.pid} did not end within ${killGraceMs} ms of being killed`)
      forced = true
    }
    // The exit handler has begun stopping the encoders of recordings the process left running.
    await Promise.all(this.#reclaims)
    return { ...exit, forced, bye: this.#bye }
  }

  /**
   * Sends one frame of a recording, or says why it was not sent. `Recording.frame` is the usual way in. Throws
   * `RangeError` for a timestamp that is not a whole number of microseconds from 0, or a frame larger than
   * `MAX_FRAME_BYTES`.
   */
  sendFrame(recordingId: string, frame: Frame): FrameOutcome {
    checkFrame(frame)
    if (this.#unavailable() !== undefined) return 'not_sent'
    if (this.#child.stdin.writableLength > this.#maxPendingBytes) {
      this.#traffic.framesDropped += 1
      return 'dropped'
    }
    const head = encodeRequestHead({ type: 'frame', recordingId, timestampUs: frame.timestampUs, format: frame.format }, frame.bytes.byteLength)
    this.#child.stdin.cork()
    this.#write(head)
    this.#child.stdin.write(frame.bytes)
    this.#child.stdin.uncork()
    this.#traffic.framesSent += 1
    this.#traffic.frameBytes += frame.bytes.byteLength
    return 'sent'
  }

  /** Asks the process to finish a recording, and says whether the request was written. */
  sendFinish(recordingId: string, endTimestampUs: number | undefined): boolean {
    if (this.#unavailable() !== undefined) return false
    this.#write(encodeRequestHead({ type: 'finish', recordingId, ...(endTimestampUs === undefined ? {} : { endTimestampUs }) }))
    return true
  }

  // Why nothing more can be asked of the process, or undefined while it can be.
  #unavailable(): Error | undefined {
    if (this.#failure !== undefined) return this.#failure
    if (this.#exit !== undefined) return new MediaProcessError(`the media process has ended with ${describeExit(this.#exit)}`)
    if (this.#pipeBroken !== undefined || this.#child.stdin.destroyed) return this.#pipeBroken ?? new MediaProcessError('the pipe to the media process is closed')
    if (this.#closing !== undefined || this.#child.stdin.writableEnded) return new MediaProcessError('the media process is closing')
    return undefined
  }

  // Writes a request head. Callers check `#unavailable` first, so nothing is written once closing begins.
  #write(head: Buffer): void {
    if (this.#unavailable() !== undefined) return
    this.#traffic.headerBytes += head.byteLength
    this.#child.stdin.write(head)
  }

  // Lets the process hold Node open only while something of ours is with it: a running recording or an
  // unanswered start. The child and each of its three pipes count on their own; the pipes are typed as plain
  // streams but are the sockets Node opens for `stdio: 'pipe'`, and only a socket can be let go of.
  #attend(): void {
    const busy = this.#recordings.size > 0 || this.#starts.size > 0
    const pipes = [this.#child.stdin, this.#child.stdout, this.#child.stderr].filter((pipe) => pipe instanceof Socket)
    for (const handle of [this.#child, ...pipes]) {
      if (busy) handle.ref()
      else handle.unref()
    }
  }

  #dispatch(reply: MediaReply): void {
    switch (reply.type) {
      case 'hello':
        return this.#fail(new MediaProtocolError('the media process greeted twice'))
      case 'started':
        return this.#started(reply)
      case 'ended':
        return this.#endedRecording(reply)
      case 'error':
        return this.#refused(reply)
      case 'bye':
        this.#bye = reply
        return
    }
  }

  #started(reply: Started): void {
    const abandoned = this.#abandoned.delete(reply.recordingId)
    const answer = this.#starts.get(reply.recordingId)
    if (!abandoned && answer === undefined) return this.#fail(new MediaProtocolError(`the media process started ${reply.recordingId}, which was never asked for`))
    this.#starts.delete(reply.recordingId)
    const ended = deferred<Ended>()
    const recording = new Recording(this, reply, ended.promise)
    this.#recordings.set(reply.recordingId, { recording, ended })
    this.#attend()
    // Nobody waits for a start that timed out, but its encoder is now running: it is finished at once and kept
    // until its `Ended`, so a process that dies first still has this encoder stopped.
    if (abandoned) this.sendFinish(reply.recordingId, undefined)
    else answer?.resolve({ kind: 'started', recording })
  }

  #endedRecording(reply: Ended): void {
    if (this.#abandoned.delete(reply.recordingId)) return
    const answer = this.#starts.get(reply.recordingId)
    if (answer !== undefined) {
      this.#starts.delete(reply.recordingId)
      this.#attend()
      return answer.resolve({ kind: 'ended', ended: reply })
    }
    const running = this.#recordings.get(reply.recordingId)
    if (running === undefined) return this.#fail(new MediaProtocolError(`the media process ended ${reply.recordingId}, which never started`))
    this.#recordings.delete(reply.recordingId)
    this.#attend()
    running.ended.resolve(reply)
  }

  #refused(reply: MediaError): void {
    const id = reply.recordingId
    if (id !== undefined && this.#abandoned.delete(id)) return
    const answer = id === undefined ? undefined : this.#starts.get(id)
    if (answer !== undefined && id !== undefined) {
      this.#starts.delete(id)
      this.#attend()
      return answer.reject(new MediaRequestError(reply))
    }
    this.#errors.push(reply)
    if (this.#errors.length > keptErrors) this.#errors.shift()
  }

  #fail(error: Error): void {
    this.#failure ??= error
    signalGroup(this.pid, 'SIGKILL')
  }

  // The process is gone and reaped, so its own group needs no signal and its pid is not ours to name again.
  // Waiting starts learn how it ended; running recordings have their encoders stopped and learn it too, with any
  // file left behind. Nothing waiting is given an invented result.
  #ended(exit: ProcessExit): void {
    this.#exit = exit
    const cause = this.#failure === undefined ? '' : ` after ${this.#failure.message}`
    const reason = `the media process ended with ${describeExit(exit)}${cause}${stderrNote(this.#stderr)}`
    for (const answer of this.#starts.values()) answer.reject(new MediaProcessError(reason))
    this.#starts.clear()
    this.#abandoned.clear()
    for (const running of this.#recordings.values()) this.#reclaims.push(reclaim(running, reason))
    this.#recordings.clear()
  }
}

// Stops the encoder of a recording whose media process died, after giving it `orphanGraceMs` to finish its file,
// and rejects the recording with what it left. The group is killed whenever anything is left in it, so a wrapper
// whose leader exits on its own cannot leave the real encoder behind. A group that is already empty is not
// signalled: its id could name a process that is not ours.
async function reclaim({ recording, ended }: Running, reason: string): Promise<void> {
  const { encoderPid, path, recordingId } = recording.started
  const exitedAlone = await processGoneWithin(encoderPid, orphanGraceMs)
  let encoder = 'its encoder exited on its own'
  if (groupExists(encoderPid)) {
    signalGroup(encoderPid, 'SIGKILL')
    const gone = await groupGoneWithin(encoderPid, killGraceMs)
    const killed = `its encoder's process group ${encoderPid} was killed${gone ? '' : ` but has not gone within ${killGraceMs} ms`}`
    encoder = exitedAlone ? `its encoder exited on its own, and ${killed}` : killed
  }
  const partial = `${path}.partial`
  const partialPath = existsSync(partial) ? partial : undefined
  const left = partialPath === undefined ? 'no file was left' : `it left ${partialPath}`
  ended.reject(new MediaRecordingLostError(`${reason}; recording ${recordingId} did not end: ${encoder}, and ${left}`, recordingId, partialPath))
}

/** One running recording. Its `ended` settles with the process's `Ended`, whether the client finished it or not. */
export class Recording {
  readonly started: Started
  readonly #media: MediaProcess
  readonly #ended: Promise<Ended>
  #finishing = false
  #over = false

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

  /** The recording's one `Ended`. It can come before `finish`, when the encoder fails or the process shuts down. */
  get ended(): Promise<Ended> {
    return this.#ended
  }

  /**
   * Sends a frame. Timestamps must not go backwards; the process counts and skips one that does. Throws
   * `RangeError` for a timestamp that is not a whole number of microseconds from 0, or a frame larger than
   * `MAX_FRAME_BYTES`.
   */
  frame(frame: Frame): FrameOutcome {
    checkFrame(frame)
    if (this.#finishing || this.#over) return 'closed'
    return this.#media.sendFrame(this.id, frame)
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
      this.#media.sendFinish(this.id, endTimestampUs)
    }
    return settleWithin(this.#ended, timeoutMs).then((ended) => {
      if (ended === undefined) throw new MediaProcessError(`recording ${this.id} did not end within ${timeoutMs} ms of its finish`)
      return ended
    })
  }
}

// Why a start cannot be sent: an id the process would refuse, or a number that is not a whole number in range.
// The process checks these too; this catches what JSON would carry but the process could not read, such as a
// fractional frame rate, and what would break the stream's framing, such as an id that outgrows a header.
function invalidStart(start: StartRecording): string | undefined {
  const idLength = [...start.recordingId].length
  if (idLength === 0) return 'the recording id is empty'
  if (idLength > MAX_ID_CHARACTERS) return `the recording id has ${idLength} characters; the most is ${MAX_ID_CHARACTERS}`
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
  ]
  for (const [name, value] of [...required, ...optional]) {
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < 1) return `${name} must be a whole number from 1; it is ${value}`
  }
  return undefined
}

// A frame the process can read: a timestamp it can parse and bytes within its payload limit. A larger payload
// would be a protocol violation, which ends every recording and the process, not just this frame.
function checkFrame(frame: Frame): void {
  checkTimestamp('timestampUs', frame.timestampUs)
  if (frame.bytes.byteLength > MAX_FRAME_BYTES) throw new RangeError(`a frame of ${frame.bytes.byteLength} bytes is larger than the ${MAX_FRAME_BYTES} the media process accepts`)
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

// Whether a process this one did not start has gone within `timeoutMs`. Only its existence can be asked.
async function processGoneWithin(pid: number, timeoutMs: number): Promise<boolean> {
  return pollUntil(() => !processExists(pid), timeoutMs)
}

async function groupGoneWithin(pgid: number, timeoutMs: number): Promise<boolean> {
  return pollUntil(() => !groupExists(pgid), timeoutMs)
}

async function pollUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs
  while (!condition()) {
    if (performance.now() >= end) return false
    await delay(20)
  }
  return true
}

function processExists(pid: number): boolean {
  return canSignal(pid)
}

// Whether any process is left in the group `pgid` leads. The id stays reserved while any member lives.
function groupExists(pgid: number): boolean {
  return pgid > 1 && canSignal(-pgid)
}

function canSignal(target: number): boolean {
  try {
    process.kill(target, 0)
    return true
  } catch (error) {
    // EPERM means it exists but is not ours to signal.
    return error instanceof Error && 'code' in error && error.code === 'EPERM'
  }
}

// Signals every process of the group `pid` leads. A group that is already gone needs no signal.
function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined || pid <= 1) return
  try {
    process.kill(-pid, signal)
  } catch {
    // Nothing is left in the group.
  }
}
