import type { Schema } from '../protocol/schema.ts'
import { parse, s } from '../protocol/schema.ts'

/**
 * The media protocol version this client speaks. The media process names its own in its greeting, and a client
 * refuses a process that speaks another.
 */
export const MEDIA_PROTOCOL_VERSION = 1

/** The longest reply header the client reads, matching what the process allows for requests. */
export const MAX_REPLY_HEADER_BYTES: number = 64 * 1024

/**
 * The longest recording id, in characters, and the largest frame, in bytes, the process accepts. A longer id or
 * a larger frame is refused here before it is sent: a frame over the limit, or an id long enough to carry a
 * header past 64 KiB, would be a protocol violation that ends every recording and the process.
 */
export const MAX_ID_CHARACTERS = 200
export const MAX_FRAME_BYTES: number = 64 * 1024 * 1024

const PREFIX_BYTES = 8

export type FrameFormat = 'png' | 'jpeg'

/**
 * Begins a recording. `output` is the file path without its extension: the process adds `.mp4` or `.webm` for
 * the container it chose and names the file in its replies; a file already there, or a running recording
 * writing there, refuses the start. `deadlineMs` bounds finishing, from the finish message until the container
 * is written. The queue holds `queueFrames` frames and `queueBytes` bytes at most, 60 frames and 64 MiB unless
 * given; a full queue lets its oldest frame go. A pause between frames longer than `maxGapMs` (10 s) is
 * shortened to it in the video; frames more than `maxDurationMs` (30 min) after the first are refused. An
 * encoder that takes longer than `stallMs` (10 s) to accept a frame is stopped. Every number is a whole number.
 */
export type StartRecording = {
  recordingId: string
  width: number
  height: number
  fps: number
  output: string
  deadlineMs: number
  queueFrames?: number
  queueBytes?: number
  maxGapMs?: number
  maxDurationMs?: number
  stallMs?: number
}

/**
 * Announces a frame, whose bytes follow the header. `timestampUs` is when it was captured, in whole microseconds
 * on a monotonic clock the client keeps for the recording; the video keeps each frame on screen until the next.
 */
export type FrameHeader = { recordingId: string; timestampUs: number; format: FrameFormat }

/** Ends a recording. With `endTimestampUs` the last frame stays on screen until then. */
export type FinishRecording = { recordingId: string; endTimestampUs?: number }

export type MediaRequest =
  | ({ type: 'start' } & StartRecording)
  | ({ type: 'frame' } & FrameHeader)
  | ({ type: 'finish' } & FinishRecording)
  | { type: 'shutdown' }

/** The process's first message. `target` is the system it was built for, such as `macos-aarch64`. */
export type Hello = { type: 'hello'; protocol: number; version: string; target: string; ffmpeg: string }

/**
 * A recording began. Nothing is at `path` until the recording ends `ok`. `encoderPid` is also the encoder's
 * process group, which every stop signals.
 */
export type Started = {
  type: 'started'
  recordingId: string
  codec: 'h264' | 'vp8'
  container: 'mp4' | 'webm'
  encoder: string
  encoderVersion: string
  encoderPid: number
  path: string
  width: number
  height: number
  fps: number
  queueFrames: number
  queueBytes: number
  maxGapMs: number
  maxDurationMs: number
  stallMs: number
}

/**
 * How a recording ended. Only `ok` leaves a video. `no_frames`: no frame could be shown. `encoder_unavailable`:
 * ffmpeg has neither libx264 nor libvpx. `encoder_failed`: the encoder could not start, did not answer as ffmpeg
 * or exited without writing the video, or stalled. `deadline_exceeded`: finishing outlasted the deadline and the
 * encoder was stopped. `stopped`: the process shut down before the recording was finished. `output_failed`: the
 * encoder succeeded but its file could not be put at the path; it is kept at `partialPath`.
 */
export type EndStatus = 'ok' | 'no_frames' | 'encoder_unavailable' | 'encoder_failed' | 'deadline_exceeded' | 'stopped' | 'output_failed'

/**
 * What happened to a recording's frames. `received` is the sum of every other count except `resized`. `shown`
 * frames were written to the encoder and are in the video when the recording ends `ok`.
 */
export type FrameCounts = {
  received: number
  shown: number
  superseded: number
  dropped: number
  outOfOrder: number
  outOfRange: number
  undecodable: number
  unprocessed: number
  resized: number
}

/** How the encoder process ended, and the last lines it printed. */
export type EncoderExit = { exitCode: number | null; signal: number | null; stderr: string[] }

/** A pause longer than the recording's maximum gap, shortened in the video by `shortenedByUs`. */
export type Gap = { captureUs: number; shortenedByUs: number }

/**
 * The one message every recording ends with. Video time zero is the capture time `firstTimestampUs`; a frame
 * captured at `t` appears at `t - firstTimestampUs`, less every `shortenedByUs` of the gaps up to it, rounded to
 * the nearest frame. `gaps` lists the first 64 shortened gaps and `gapsShortened` counts them all.
 * `framesBeforeFirst` counts frames received before the first that are not in the video.
 */
export type Ended = {
  type: 'ended'
  recordingId: string
  status: EndStatus
  message: string
  path?: string
  partialPath?: string
  frames: FrameCounts
  firstTimestampUs?: number
  framesBeforeFirst: number
  gaps: Gap[]
  gapsShortened: number
  endClipped: boolean
  outputFrames: number
  durationUs: number
  bytesReceived: number
  bytesToEncoder: number
  encoder?: EncoderExit
  finalizeMs?: number
}

export type MediaErrorCode =
  | 'invalid_message'
  | 'invalid_start'
  | 'unknown_recording'
  | 'duplicate_recording'
  | 'output_in_use'
  | 'too_many_recordings'
  | 'protocol_violation'

/** A message the process could not act on. After `protocol_violation` it shuts down. */
export type MediaError = { type: 'error'; code: MediaErrorCode; recordingId?: string; message: string }

/** The last message: every recording has ended and the process exits. */
export type Bye = { type: 'bye'; stopped: number }

export type MediaReply = Hello | Started | Ended | MediaError | Bye

const count = s.number({ integer: true, min: 0 })

const frameCountsSchema: Schema<FrameCounts> = s.object({
  received: count,
  shown: count,
  superseded: count,
  dropped: count,
  outOfOrder: count,
  outOfRange: count,
  undecodable: count,
  unprocessed: count,
  resized: count,
})

const gapSchema: Schema<Gap> = s.object({ captureUs: count, shortenedByUs: count })

const encoderExitSchema: Schema<EncoderExit> = s.object({
  exitCode: s.nullable(s.number({ integer: true })),
  signal: s.nullable(s.number({ integer: true })),
  stderr: s.array(s.string()),
})

export const mediaReplySchema: Schema<MediaReply> = s.discriminatedUnion('type', [
  s.object({ type: s.literal('hello'), protocol: count, version: s.string(), target: s.string(), ffmpeg: s.string() }),
  s.object({
    type: s.literal('started'),
    recordingId: s.string(),
    codec: s.enum(['h264', 'vp8']),
    container: s.enum(['mp4', 'webm']),
    encoder: s.string(),
    encoderVersion: s.string(),
    encoderPid: count,
    path: s.string(),
    width: count,
    height: count,
    fps: count,
    queueFrames: count,
    queueBytes: count,
    maxGapMs: count,
    maxDurationMs: count,
    stallMs: count,
  }),
  s.object({
    type: s.literal('ended'),
    recordingId: s.string(),
    status: s.enum(['ok', 'no_frames', 'encoder_unavailable', 'encoder_failed', 'deadline_exceeded', 'stopped', 'output_failed']),
    message: s.string(),
    path: s.optional(s.string()),
    partialPath: s.optional(s.string()),
    frames: frameCountsSchema,
    firstTimestampUs: s.optional(count),
    framesBeforeFirst: count,
    gaps: s.array(gapSchema),
    gapsShortened: count,
    endClipped: s.boolean(),
    outputFrames: count,
    durationUs: count,
    bytesReceived: count,
    bytesToEncoder: count,
    encoder: s.optional(encoderExitSchema),
    finalizeMs: s.optional(count),
  }),
  s.object({
    type: s.literal('error'),
    code: s.enum(['invalid_message', 'invalid_start', 'unknown_recording', 'duplicate_recording', 'output_in_use', 'too_many_recordings', 'protocol_violation']),
    recordingId: s.optional(s.string()),
    message: s.string(),
  }),
  s.object({ type: s.literal('bye'), stopped: count }),
])

/** Thrown when the process's output is not this protocol. */
export class MediaProtocolError extends Error {
  override readonly name = 'MediaProtocolError'
}

/**
 * The prefix and header of a request: the header's length and the payload's length as big-endian 32-bit
 * numbers, then the header as JSON. The payload, a frame's bytes, is written after it as it is, never copied
 * or turned into text.
 *
 * @example stdin.write(encodeRequestHead({ type: 'shutdown' }))
 */
export function encodeRequestHead(request: MediaRequest, payloadBytes = 0): Buffer {
  const header = Buffer.from(JSON.stringify(request), 'utf8')
  const head = Buffer.allocUnsafe(PREFIX_BYTES + header.byteLength)
  head.writeUInt32BE(header.byteLength, 0)
  head.writeUInt32BE(payloadBytes, 4)
  header.copy(head, PREFIX_BYTES)
  return head
}

/**
 * Reads replies out of the process's output as its chunks arrive. A reply split across chunks waits for the rest.
 * Anything that is not a valid reply throws `MediaProtocolError`.
 */
export class ReplyReader {
  #pending: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): MediaReply[] {
    this.#pending = this.#pending.byteLength === 0 ? chunk : Buffer.concat([this.#pending, chunk])
    const replies: MediaReply[] = []
    for (;;) {
      if (this.#pending.byteLength < PREFIX_BYTES) return replies
      const headerBytes = this.#pending.readUInt32BE(0)
      const payloadBytes = this.#pending.readUInt32BE(4)
      if (headerBytes > MAX_REPLY_HEADER_BYTES) throw new MediaProtocolError(`a reply header of ${headerBytes} bytes is longer than ${MAX_REPLY_HEADER_BYTES}`)
      if (payloadBytes !== 0) throw new MediaProtocolError(`a reply carried ${payloadBytes} payload bytes; replies carry none`)
      const end = PREFIX_BYTES + headerBytes
      if (this.#pending.byteLength < end) return replies
      replies.push(readReply(this.#pending.subarray(PREFIX_BYTES, end)))
      this.#pending = this.#pending.subarray(end)
    }
  }

  /** Bytes of a reply that has not fully arrived. */
  get pendingBytes(): number {
    return this.#pending.byteLength
  }
}

function readReply(header: Buffer): MediaReply {
  let value: unknown
  try {
    value = JSON.parse(header.toString('utf8'))
  } catch (error) {
    throw new MediaProtocolError('a reply header is not JSON', { cause: error })
  }
  const parsed = parse(mediaReplySchema, value)
  if (parsed.ok) return parsed.value
  const issues = parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
  throw new MediaProtocolError(`a reply does not match protocol ${MEDIA_PROTOCOL_VERSION}: ${issues}`)
}
