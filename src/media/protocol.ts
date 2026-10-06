import type { Schema } from '../protocol/schema.ts'
import { isPlainObject, parse, s } from '../protocol/schema.ts'

/**
 * The media protocol version this client speaks. The media process names its own in its greeting, and a client
 * refuses a process that speaks another, by name.
 */
export const MEDIA_PROTOCOL_VERSION = 2

/** The longest reply header the client reads, matching what the process allows for requests. */
export const MAX_REPLY_HEADER_BYTES: number = 64 * 1024

/** The largest payload a reply carries: a frame sequence's images, a live frame, or an ending's frame map. */
export const MAX_REPLY_PAYLOAD_BYTES: number = 64 * 1024 * 1024

/**
 * The longest recording id, in characters, and the largest frame, in bytes, the process accepts. A longer id or
 * a larger frame is refused here before it is sent: a frame over the limit, or an id long enough to carry a
 * header past 64 KiB, would be a protocol violation that ends every recording and the process.
 */
export const MAX_ID_CHARACTERS = 200
export const MAX_FRAME_BYTES: number = 64 * 1024 * 1024

/** The longest run, attempt, test, app or session id a recording's identity may hold, in characters. */
export const MAX_IDENTITY_CHARACTERS = 512

/** The longest frame, action, observation or request id, in characters. */
export const MAX_FRAME_ID_CHARACTERS = 128

/**
 * The longest output path the process takes, in UTF-8 bytes. A longer one is refused here before it is sent: past
 * the process's limit it is refused, and long enough to carry a header past 64 KiB it would end every recording.
 */
export const MAX_PATH_BYTES = 4096

/** The most frames one frame sequence returns, and the most bytes its images may take together. */
export const MAX_SEQUENCE_FRAMES = 64
export const MAX_SEQUENCE_BYTES: number = 48 * 1024 * 1024

/** The widest or tallest image a thumbnail, a frame sequence or a live view asks for. */
export const MAX_OUTPUT_SIDE = 4096

const PREFIX_BYTES = 8

export type FrameFormat = 'png' | 'jpeg'

/**
 * Whose recording it is: the run, the attempt and the test that held the session, the app, and the session's id as
 * `formatSessionId` writes it. Ids are Retest's own bounded strings, at most `MAX_IDENTITY_CHARACTERS` each and
 * without control characters; no secret and no app text belongs in one.
 */
export type RecordingIdentity = { runId: string; attemptId: string; testId: string; app: string; sessionId: string }

/**
 * Begins a recording. `output` is the file path without its extension: the process adds `.mp4` or `.webm` for
 * the container it chose and names the file in its replies; a file already there, or a running recording
 * writing there, refuses the start. `deadlineMs` bounds finishing, from the finish message until the container
 * is written. The queue holds `queueFrames` frames and `queueBytes` bytes at most, 60 frames and 64 MiB unless
 * given; a full queue lets its oldest frame go. A pause between frames longer than `maxGapMs` (10 s) is
 * shortened to it in the video; frames more than `maxDurationMs` (30 min) after the first are refused. An
 * encoder that takes longer than `stallMs` (10 s) to accept a frame is stopped.
 *
 * `keepFrames` (on unless `false`) keeps the frames the encoder takes, as they arrived, in a file beside the
 * output (`Started.framesPath`), so a frame sequence can be asked of the recording while it runs and after it
 * ends, until it is released; `frameStoreBytes` bounds that file (512 MiB unless given). `encodedFormat` hands
 * frames of that format at the recording's size to the encoder as they are, undecoded; frames of another format
 * or size are decoded, fitted and encoded in that format first. A frame handed over as it is is still decoded once
 * and its pixels let go, so one that cannot be decoded is counted `undecodable` and never sent. Every number is a
 * whole number.
 */
export type StartRecording = {
  recordingId: string
  identity: RecordingIdentity
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
  keepFrames?: boolean
  frameStoreBytes?: number
  encodedFormat?: FrameFormat
}

/**
 * Announces a frame, whose bytes follow the header. `frameId` names this frame within its recording, and
 * `actionId` or `observationId` the action or look it belongs to, when it belongs to one. `timestampUs` is when it
 * was captured, in whole microseconds on a monotonic clock the client keeps for the recording; the video keeps each
 * frame on screen until the next.
 */
export type FrameHeader = { recordingId: string; frameId: string; actionId?: string; observationId?: string; timestampUs: number; format: FrameFormat }

/** Ends a recording. With `endTimestampUs` the last frame stays on screen until then. */
export type FinishRecording = { recordingId: string; endTimestampUs?: number }

/**
 * Says capture could not deliver frames from `fromUs` to `toUs`, on the recording's clock, and why. `reason` is a
 * code of lower-case letters, digits and underscores, at most 64 characters, never free text.
 */
export type CaptureGap = { fromUs: number; toUs: number; reason: string }

/** Asks for a thumbnail of one image. The process adds `.png` or `.jpg` to `output` and never enlarges. */
export type ThumbnailRequest = { output: string; maxWidth: number; maxHeight: number; format: FrameFormat; quality?: number }

/**
 * Asks for the frames a recording kept whose capture times lie from `fromUs` to `toUs`, at most `maxFrames`, each
 * fitted within `maxWidth` by `maxHeight` in `format` (JPEG unless given, at `quality` 80), all together at most
 * `maxBytes` (16 MiB unless given). With more frames than `maxFrames`, the interval is cut into `maxFrames` equal
 * parts and the frame nearest each part's middle is taken. Stretches without a kept frame longer than `minGapUs`
 * (two frame intervals of the recording unless given) are listed.
 */
export type FrameSequenceRequest = {
  fromUs: number
  toUs: number
  maxFrames: number
  maxWidth: number
  maxHeight: number
  maxBytes?: number
  format?: FrameFormat
  quality?: number
  minGapUs?: number
}

/** How a live view of a recording is sent: the newest frame, fitted within the size, JPEG, at most `maxFps` a second. */
export type WatchOptions = { maxWidth: number; maxHeight: number; maxFps: number; quality?: number }

export type MediaRequest =
  | { type: 'ready' }
  | ({ type: 'start' } & StartRecording)
  | ({ type: 'frame' } & FrameHeader)
  | ({ type: 'captureGap'; recordingId: string } & CaptureGap)
  | ({ type: 'finish' } & FinishRecording)
  | ({ type: 'thumbnail'; requestId: string; sourceFormat: FrameFormat } & ThumbnailRequest)
  | ({ type: 'frames'; requestId: string; recordingId: string } & FrameSequenceRequest)
  | ({ type: 'watch'; recordingId: string } & WatchOptions)
  | { type: 'unwatch'; recordingId: string }
  | { type: 'release'; recordingId: string }
  | { type: 'leftovers'; requestId: string; output: string; remove: boolean }
  | { type: 'shutdown' }

/** How the binary was built: its source revision when the build knew it, the target triple and the profile. */
export type BuildIdentity = { revision?: string; dirty?: boolean; target: string; profile: string }

/**
 * What the encoder can do. `probing`: the process is still asking it. `ready`: recordings will use `codec` in
 * `container` through `encoder`, and `encodedInput` names the image formats it reads undecoded. `unavailable`: it
 * runs but lacks a complete route, named in `missing`. `failed`: it could not be asked, did not answer as ffmpeg,
 * or was not safe to use.
 */
export type EncoderProbe =
  | { state: 'probing' }
  | { state: 'ready'; version: string; codec: 'h264' | 'vp8'; container: 'mp4' | 'webm'; encoder: 'libx264' | 'libvpx'; encodedInput: FrameFormat[]; probeMs: number }
  | { state: 'unavailable'; version: string; missing: string; message: string; probeMs: number }
  | { state: 'failed'; message: string; exit?: EncoderExit; probeMs: number }

/**
 * The process's first message, sent as soon as it runs. Its encoder probe runs in the background, so `encoder` is
 * usually `probing`; a `ready` request is answered when the probe ends, and a start waits for it.
 */
export type Hello = { type: 'hello'; protocol: number; version: string; build: BuildIdentity; ffmpeg: string; encoder: EncoderProbe }

/** The answer to a `ready` request, once the encoder probe has ended. */
export type Ready = { type: 'ready'; encoder: EncoderProbe }

/**
 * A recording began. The video is claimed at `path` only when the recording ends `ok`. Interrupted finalization
 * names the possible partial and any uncertain publication in its message. On a filesystem without hard links the
 * finished video is copied to `path` with `.copying` added and renamed into place, so a process killed during the
 * copy leaves that file, never a partial video at `path`. If exclusive rename is unavailable, publication uses
 * link-then-unlink; a filesystem supporting neither operation is refused with the partial named. `encoderPid` is the encoder's process id.
 * `route` is `encoded` when frames of `encodedFormat` reach the encoder undecoded, `decoded` when every frame is
 * decoded to raw pixels first. `framesPath` is where the kept frames are, when they are kept.
 */
export type Started = {
  type: 'started'
  recordingId: string
  identity: RecordingIdentity
  codec: 'h264' | 'vp8'
  container: 'mp4' | 'webm'
  encoder: string
  encoderVersion: string
  encoderPid: number
  path: string
  route: 'decoded' | 'encoded'
  encodedFormat?: FrameFormat
  framesPath?: string
  frameStoreBytes?: number
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
 * frames were written to the encoder and are in the video when the recording ends `ok`. `outOfRange` frames were
 * captured more than `maxDurationMs` after the first, or fall past the last video frame that duration allows.
 * `duplicate` frames reused a frame id the recording had already seen.
 */
export type FrameCounts = {
  received: number
  shown: number
  superseded: number
  dropped: number
  outOfOrder: number
  outOfRange: number
  undecodable: number
  duplicate: number
  unprocessed: number
  resized: number
}

/** How the encoder process ended, the last lines it printed, and how many lines it printed in all. */
export type EncoderExit = { exitCode: number | null; signal: number | null; stderr: string[]; lines: number }

/** A pause longer than the recording's maximum gap, shortened in the video by `shortenedByUs`. */
export type Gap = { captureUs: number; shortenedByUs: number }

/** The deepest the recording's queue was, and how many frames arrived to a full queue and let an older one go. */
export type QueueStats = { peakFrames: number; peakBytes: number; saturated: number }

/** What a recording's frame became, as `FrameCounts` counts it. */
export type FrameFate = 'shown' | 'superseded' | 'dropped' | 'out_of_order' | 'out_of_range' | 'undecodable' | 'duplicate' | 'unprocessed'

/**
 * Where one frame went. A `shown` frame is in the video from `videoUs` for `outputFrames` frames, when the recording
 * ended `ok`; any other frame is in no video.
 */
export type FrameMapEntry = { frameId: string; captureUs: number; fate: FrameFate; videoUs?: number; outputFrames?: number }

/**
 * Why a recording's evidence is not complete: a count that lost frames, a capture gap, a shortened pause or end, a
 * frame map that could not list every frame, an encoder that printed errors while it wrote the video, or, for an
 * unavailable recording, how it ended.
 */
export type EvidenceReason =
  | 'frames_dropped'
  | 'frames_undecodable'
  | 'frames_out_of_order'
  | 'frames_out_of_range'
  | 'frames_duplicate'
  | 'frames_unprocessed'
  | 'capture_gaps'
  | 'gaps_shortened'
  | 'end_clipped'
  | 'frame_map_truncated'
  | 'encoder_reported_errors'
  | Exclude<EndStatus, 'ok'>

/**
 * The recording's evidence, apart from what the test observed. `complete`: a video holds every frame that reached
 * the process. `partial`: a video exists and `reasons` names what it lacks. `unavailable`: there is no video, and
 * `reasons` names why. Superseded frames are not a loss: the frame rate shows one frame per tick.
 */
export type RecordingEvidence = { status: 'complete' | 'partial' | 'unavailable'; reasons: EvidenceReason[] }

/**
 * The one message every recording ends with. Video time zero is the capture time `firstTimestampUs`; a frame
 * captured at `t` appears at `t - firstTimestampUs`, less every `shortenedByUs` of the gaps up to it, rounded to
 * the nearest frame. `gaps` lists the first 64 shortened gaps and `gapsShortened` counts them all.
 * `framesBeforeFirst` counts frames received before the first that are not in the video. `frameMap` says where
 * every frame went, by its id, in the order frames arrived, at most 200 000 of them and 64 MiB of JSON;
 * `frameMapOmitted` counts the rest. `captureGaps` lists the first 64 capture gaps the client reported;
 * `captureGapsReported` counts them all. `placedBy` says how the finished file was put at `path`: a hard link, or a copy where the filesystem has none.
 */
export type Ended = {
  type: 'ended'
  recordingId: string
  identity: RecordingIdentity
  status: EndStatus
  message: string
  path?: string
  partialPath?: string
  placedBy?: 'link' | 'copy'
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
  queue: QueueStats
  captureGaps: CaptureGap[]
  captureGapsReported: number
  evidence: RecordingEvidence
  frameMapEntries: number
  frameMapOmitted: number
  frameMap: FrameMapEntry[]
  encoder?: EncoderExit
  finalizeMs?: number
}

/** A thumbnail's outcome. Only `ok` wrote a file, at `path`. */
export type ThumbnailStatus = 'ok' | 'undecodable' | 'too_large' | 'output_in_use' | 'output_failed' | 'busy' | 'stopped'

export type Thumbnail = {
  type: 'thumbnail'
  requestId: string
  status: ThumbnailStatus
  message: string
  path?: string
  width?: number
  height?: number
  sourceWidth?: number
  sourceHeight?: number
  byteLength?: number
  placedBy?: 'link' | 'copy'
}

/**
 * A frame of a frame sequence, as kept, fitted to the request; `bytes` are its image in `format`. `fate` is `pending`
 * while a running recording has not yet placed the frame: it is on screen until the next frame says for how long.
 * It is `unprocessed` when the recording ended before the frame was written to the encoder, as when the encoder
 * failed or the process shut down: the frame was captured and kept, and is in no video.
 */
export type SequenceFrame = {
  frameId: string
  actionId?: string
  observationId?: string
  captureUs: number
  fate: 'shown' | 'superseded' | 'pending' | 'unprocessed'
  sourceWidth: number
  sourceHeight: number
  width: number
  height: number
  format: FrameFormat
  byteLength: number
  bytes: Uint8Array
}

/**
 * A stretch of the interval with no kept frame, at least the request's `minGapUs` long, or the whole interval when
 * nothing in it was kept. `lost` counts frames that reached the process inside it but are not kept, by what became
 * of them: `queued` ones never reached the encoder thread, still waiting in a running recording or left waiting
 * when it ended; `notStored` ones were taken but not kept, the kept frames being full or failed. `captureGaps` are
 * the reasons the client gave for capture gaps that overlap it. A stretch with nothing lost and no capture gap
 * means no listed frame reached the process: it never means nothing appeared on the screen. Frames lost between
 * kept frames closer together than `minGapUs` are in no stretch; `inInterval` less `available` counts every frame
 * of the interval that is not kept. A recording lists at most 200 000 frames; later ones are in no count here, and
 * the sequence's `message` says from when.
 */
export type FrameStretch = {
  fromUs: number
  toUs: number
  lost: { dropped: number; undecodable: number; outOfOrder: number; outOfRange: number; duplicate: number; queued: number; notStored: number }
  captureGaps: string[]
}

/**
 * Why a frame sequence came back without frames. `not_kept`: the recording kept no frames. `released`: its kept
 * frames were removed. `busy`: the process had as many images to make as it queues. `stopped`: the process shut
 * down first. `store_failed`: the kept frames could not be read.
 */
export type FrameSequenceStatus = 'ok' | 'not_kept' | 'released' | 'busy' | 'stopped' | 'store_failed'

/**
 * A frame sequence's outcome. `inInterval` counts every listed frame that reached the process with a capture time in
 * the interval, whatever became of it; `available` how many of them are kept. `message`, on an `ok` sequence, says
 * why it may lack frames the interval held: kept frames that could not be read back, kept frames that stopped being
 * stored, or frames past the most a recording lists. `omitted` counts kept frames left out
 * by the frame cap, the byte cap, or because they could not be decoded. Returned frames are never made up, and a
 * frame left out by the caps is no sign of what the screen showed.
 */
export type FrameSequence = {
  type: 'frames'
  requestId: string
  recordingId: string
  status: FrameSequenceStatus
  message?: string
  recording: 'running' | 'ended'
  fromUs: number
  toUs: number
  storedThroughUs?: number
  inInterval: number
  available: number
  frames: SequenceFrame[]
  omitted: { byCount: number; byBytes: number; undecodable: number }
  stretches: FrameStretch[]
  stretchesFound: number
  /** Omitted gap details across the recording, when their bounds may overlap this interval. */
  captureGapsOmitted?: number
}

/** A live view began. */
export type Watching = { type: 'watching'; recordingId: string; maxWidth: number; maxHeight: number; maxFps: number }

/**
 * The newest frame of a watched recording, fitted and encoded as JPEG. `skipped` counts frames that came and were
 * replaced before the view's next turn; `dropped` counts live frames replaced because the client had not read the
 * one before. Neither changes the recording.
 */
export type LiveFrame = {
  type: 'live'
  recordingId: string
  frameId: string
  captureUs: number
  width: number
  height: number
  format: 'jpeg'
  sequence: number
  skipped: number
  dropped: number
  byteLength: number
  bytes: Uint8Array
}

/** A live view ended, and why, with its totals. */
export type WatchEnded = {
  type: 'watchEnded'
  recordingId: string
  reason: 'unwatched' | 'recording_ended' | 'shutdown' | 'failed'
  message?: string
  sent: number
  skipped: number
  dropped: number
  failed: number
}

/**
 * A recording's kept frames were removed: at the client's request, or as `limit` because more ended recordings
 * kept frames than the process allows, oldest first. A shutdown removes them all without this message; its `bye`
 * says so.
 */
export type Released = { type: 'released'; recordingId: string; reason: 'requested' | 'limit'; removed: string[] }

/** A file a lost recording or thumbnail left beside its output: a `.partial`, a `.copying` or kept frames. */
export type LeftoverFile = { path: string; kind: 'video_partial' | 'frame_store' | 'thumbnail_partial'; byteLength: number }

/**
 * What was found beside an output, and whether it was removed. `in_use`: a recording or thumbnail of this process
 * uses that output, so nothing was touched. `skipped` names paths that are not regular files, left alone.
 */
export type Leftovers = {
  type: 'leftovers'
  requestId: string
  status: 'ok' | 'in_use' | 'invalid'
  message?: string
  output: string
  files: LeftoverFile[]
  removed: boolean
  skipped: string[]
}

export type MediaErrorCode =
  | 'invalid_message'
  | 'invalid_start'
  | 'unknown_recording'
  | 'duplicate_recording'
  | 'output_in_use'
  | 'too_many_recordings'
  | 'recording_running'
  | 'already_watched'
  | 'not_watched'
  | 'protocol_violation'
  | 'job_failed'

/** The type of a request, as an error names the request it refuses. */
export type MediaRequestType = MediaRequest['type']

/**
 * A message the process could not act on, naming the request it refuses when the header said which, and its
 * recording or request id when the header named one. After `protocol_violation` it shuts down. `job_failed` answers a
 * thumbnail or frame sequence that failed inside the process; the process goes on.
 */
export type MediaError = { type: 'error'; code: MediaErrorCode; request?: MediaRequestType; recordingId?: string; requestId?: string; message: string }

/** The last message: every recording has ended, every job and live view has answered, every kept frame is removed, and the process exits. */
export type Bye = { type: 'bye'; stopped: number; repliesDropped?: number }

export type MediaReply = Hello | Ready | Started | Ended | Thumbnail | FrameSequence | Watching | LiveFrame | WatchEnded | Released | Leftovers | MediaError | Bye

const count = s.number({ integer: true, min: 0 })
const format = s.enum(['png', 'jpeg'])
const endStatuses = ['ok', 'no_frames', 'encoder_unavailable', 'encoder_failed', 'deadline_exceeded', 'stopped', 'output_failed'] as const

const identitySchema: Schema<RecordingIdentity> = s.object({ runId: s.string(), attemptId: s.string(), testId: s.string(), app: s.string(), sessionId: s.string() })

const encoderExitSchema: Schema<EncoderExit> = s.object({
  exitCode: s.nullable(s.number({ integer: true })),
  signal: s.nullable(s.number({ integer: true })),
  stderr: s.array(s.string()),
  lines: count,
})

const encoderProbeSchema: Schema<EncoderProbe> = s.discriminatedUnion('state', [
  s.object({ state: s.literal('probing') }),
  s.object({
    state: s.literal('ready'),
    version: s.string(),
    codec: s.enum(['h264', 'vp8']),
    container: s.enum(['mp4', 'webm']),
    encoder: s.enum(['libx264', 'libvpx']),
    encodedInput: s.array(format),
    probeMs: count,
  }),
  s.object({ state: s.literal('unavailable'), version: s.string(), missing: s.string(), message: s.string(), probeMs: count }),
  s.object({ state: s.literal('failed'), message: s.string(), exit: s.optional(encoderExitSchema), probeMs: count }),
])

const frameCountsSchema: Schema<FrameCounts> = s.object({
  received: count,
  shown: count,
  superseded: count,
  dropped: count,
  outOfOrder: count,
  outOfRange: count,
  undecodable: count,
  duplicate: count,
  unprocessed: count,
  resized: count,
})

const captureGapSchema: Schema<CaptureGap> = s.object({ fromUs: count, toUs: count, reason: s.string() })

const evidenceSchema: Schema<RecordingEvidence> = s.object({
  status: s.enum(['complete', 'partial', 'unavailable']),
  reasons: s.array(
    s.enum([
      'frames_dropped',
      'frames_undecodable',
      'frames_out_of_order',
      'frames_out_of_range',
      'frames_duplicate',
      'frames_unprocessed',
      'capture_gaps',
      'gaps_shortened',
      'end_clipped',
      'frame_map_truncated',
      'encoder_reported_errors',
      'no_frames',
      'encoder_unavailable',
      'encoder_failed',
      'deadline_exceeded',
      'stopped',
      'output_failed',
    ]),
  ),
})

const frameMapEntrySchema: Schema<FrameMapEntry> = s.object({
  frameId: s.string(),
  captureUs: count,
  fate: s.enum(['shown', 'superseded', 'dropped', 'out_of_order', 'out_of_range', 'undecodable', 'duplicate', 'unprocessed']),
  videoUs: s.optional(count),
  outputFrames: s.optional(count),
})

type EndedHeader = Omit<Ended, 'frameMap'>

const endedHeaderSchema: Schema<EndedHeader> = s.object({
  type: s.literal('ended'),
  recordingId: s.string(),
  identity: identitySchema,
  status: s.enum(endStatuses),
  message: s.string(),
  path: s.optional(s.string()),
  partialPath: s.optional(s.string()),
  placedBy: s.optional(s.enum(['link', 'copy'])),
  frames: frameCountsSchema,
  firstTimestampUs: s.optional(count),
  framesBeforeFirst: count,
  gaps: s.array(s.object({ captureUs: count, shortenedByUs: count })),
  gapsShortened: count,
  endClipped: s.boolean(),
  outputFrames: count,
  durationUs: count,
  bytesReceived: count,
  bytesToEncoder: count,
  queue: s.object({ peakFrames: count, peakBytes: count, saturated: count }),
  captureGaps: s.array(captureGapSchema),
  captureGapsReported: count,
  evidence: evidenceSchema,
  frameMapEntries: count,
  frameMapOmitted: count,
  encoder: s.optional(encoderExitSchema),
  finalizeMs: s.optional(count),
})

type SequenceFrameHeader = Omit<SequenceFrame, 'bytes'>
type FrameSequenceHeader = Omit<FrameSequence, 'frames'> & { frames: SequenceFrameHeader[] }

const sequenceFrameHeaderSchema: Schema<SequenceFrameHeader> = s.object({
  frameId: s.string(),
  actionId: s.optional(s.string()),
  observationId: s.optional(s.string()),
  captureUs: count,
  fate: s.enum(['shown', 'superseded', 'pending', 'unprocessed']),
  sourceWidth: count,
  sourceHeight: count,
  width: count,
  height: count,
  format,
  byteLength: count,
})

const frameSequenceHeaderSchema: Schema<FrameSequenceHeader> = s.object({
  type: s.literal('frames'),
  requestId: s.string(),
  recordingId: s.string(),
  status: s.enum(['ok', 'not_kept', 'released', 'busy', 'stopped', 'store_failed']),
  message: s.optional(s.string()),
  recording: s.enum(['running', 'ended']),
  fromUs: count,
  toUs: count,
  storedThroughUs: s.optional(count),
  inInterval: count,
  available: count,
  frames: s.array(sequenceFrameHeaderSchema),
  omitted: s.object({ byCount: count, byBytes: count, undecodable: count }),
  stretches: s.array(
    s.object({
      fromUs: count,
      toUs: count,
      lost: s.object({ dropped: count, undecodable: count, outOfOrder: count, outOfRange: count, duplicate: count, queued: count, notStored: count }),
      captureGaps: s.array(s.string()),
    }),
  ),
  stretchesFound: count,
  captureGapsOmitted: s.optional(count),
})

type LiveFrameHeader = Omit<LiveFrame, 'bytes'>

const liveFrameHeaderSchema: Schema<LiveFrameHeader> = s.object({
  type: s.literal('live'),
  recordingId: s.string(),
  frameId: s.string(),
  captureUs: count,
  width: count,
  height: count,
  format: s.literal('jpeg'),
  sequence: count,
  skipped: count,
  dropped: count,
  byteLength: count,
})

type PayloadFree = Exclude<MediaReply, Ended | FrameSequence | LiveFrame>

const payloadFreeSchema: Schema<PayloadFree> = s.discriminatedUnion('type', [
  s.object({ type: s.literal('hello'), protocol: count, version: s.string(), build: s.object({ revision: s.optional(s.string()), dirty: s.optional(s.boolean()), target: s.string(), profile: s.string() }), ffmpeg: s.string(), encoder: encoderProbeSchema }),
  s.object({ type: s.literal('ready'), encoder: encoderProbeSchema }),
  s.object({
    type: s.literal('started'),
    recordingId: s.string(),
    identity: identitySchema,
    codec: s.enum(['h264', 'vp8']),
    container: s.enum(['mp4', 'webm']),
    encoder: s.string(),
    encoderVersion: s.string(),
    encoderPid: count,
    path: s.string(),
    route: s.enum(['decoded', 'encoded']),
    encodedFormat: s.optional(format),
    framesPath: s.optional(s.string()),
    frameStoreBytes: s.optional(count),
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
    type: s.literal('thumbnail'),
    requestId: s.string(),
    status: s.enum(['ok', 'undecodable', 'too_large', 'output_in_use', 'output_failed', 'busy', 'stopped']),
    message: s.string(),
    path: s.optional(s.string()),
    width: s.optional(count),
    height: s.optional(count),
    sourceWidth: s.optional(count),
    sourceHeight: s.optional(count),
    byteLength: s.optional(count),
    placedBy: s.optional(s.enum(['link', 'copy'])),
  }),
  s.object({ type: s.literal('watching'), recordingId: s.string(), maxWidth: count, maxHeight: count, maxFps: count }),
  s.object({
    type: s.literal('watchEnded'),
    recordingId: s.string(),
    reason: s.enum(['unwatched', 'recording_ended', 'shutdown', 'failed']),
    message: s.optional(s.string()),
    sent: count,
    skipped: count,
    dropped: count,
    failed: count,
  }),
  s.object({ type: s.literal('released'), recordingId: s.string(), reason: s.enum(['requested', 'limit']), removed: s.array(s.string()) }),
  s.object({
    type: s.literal('leftovers'),
    requestId: s.string(),
    status: s.enum(['ok', 'in_use', 'invalid']),
    message: s.optional(s.string()),
    output: s.string(),
    files: s.array(s.object({ path: s.string(), kind: s.enum(['video_partial', 'frame_store', 'thumbnail_partial']), byteLength: count })),
    removed: s.boolean(),
    skipped: s.array(s.string()),
  }),
  s.object({
    type: s.literal('error'),
    code: s.enum(['invalid_message', 'invalid_start', 'unknown_recording', 'duplicate_recording', 'output_in_use', 'too_many_recordings', 'recording_running', 'already_watched', 'not_watched', 'protocol_violation', 'job_failed']),
    request: s.optional(s.enum(['ready', 'start', 'frame', 'captureGap', 'finish', 'thumbnail', 'frames', 'watch', 'unwatch', 'release', 'leftovers', 'shutdown'])),
    recordingId: s.optional(s.string()),
    requestId: s.optional(s.string()),
    message: s.string(),
  }),
  s.object({ type: s.literal('bye'), stopped: count, repliesDropped: s.optional(count) }),
])

/** Thrown when the process's output is not this protocol. */
export class MediaProtocolError extends Error {
  override readonly name: string = 'MediaProtocolError'
}

/**
 * Thrown for a greeting from a process that speaks another protocol version, with the version and binary it named.
 * Only the greeting's version fields are read; nothing else of an older or newer greeting is trusted.
 */
export class MediaVersionMismatch extends MediaProtocolError {
  override readonly name: string = 'MediaVersionMismatch'
  readonly protocol: number
  readonly binaryVersion: string | undefined

  constructor(protocol: number, binaryVersion: string | undefined) {
    super(`the media process speaks media protocol ${protocol}; this client speaks ${MEDIA_PROTOCOL_VERSION}`)
    this.protocol = protocol
    this.binaryVersion = binaryVersion
  }
}

/**
 * The prefix and header of a request: the header's length and the payload's length as big-endian 32-bit
 * numbers, then the header as JSON. The payload, an image's bytes, is written after it as it is, never copied
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
 * Only an ending, a frame sequence and a live frame carry a payload, and each is joined to its header: the ending's
 * frame map, the sequence's images, the live frame's image. Anything that is not a valid reply throws
 * `MediaProtocolError`, and a greeting of another protocol version throws `MediaVersionMismatch`.
 */
export class ReplyReader {
  // The chunks of replies not yet whole, kept apart until a reply is. Joining on every chunk would copy a reply
  // once per chunk: a 48 MiB frame sequence arriving in 64 KiB chunks would cost gigabytes of copying on the
  // thread that also captures frames.
  readonly #chunks: Buffer[] = []
  #pendingBytes = 0
  #failure: Error | undefined
  #ended = false

  push(chunk: Buffer): MediaReply[] {
    if (this.#failure !== undefined) throw this.#failure
    if (this.#ended) throw new MediaProtocolError('reply bytes arrived after end of stream')
    try {
      return this.#read(chunk)
    } catch (error) {
      this.#chunks.length = 0
      this.#pendingBytes = 0
      this.#failure = error instanceof Error ? error : new MediaProtocolError(String(error))
      throw this.#failure
    }
  }

  #read(chunk: Buffer): MediaReply[] {
    if (chunk.byteLength > 0) this.#chunks.push(chunk)
    this.#pendingBytes += chunk.byteLength
    const replies: MediaReply[] = []
    for (;;) {
      if (this.#pendingBytes < PREFIX_BYTES) return replies
      const prefix = this.#peek(PREFIX_BYTES)
      const headerBytes = prefix.readUInt32BE(0)
      const payloadBytes = prefix.readUInt32BE(4)
      if (headerBytes > MAX_REPLY_HEADER_BYTES) throw new MediaProtocolError(`a reply header of ${headerBytes} bytes is longer than ${MAX_REPLY_HEADER_BYTES}`)
      if (payloadBytes > MAX_REPLY_PAYLOAD_BYTES) throw new MediaProtocolError(`a reply payload of ${payloadBytes} bytes is larger than ${MAX_REPLY_PAYLOAD_BYTES}`)
      const headerEnd = PREFIX_BYTES + headerBytes
      const end = headerEnd + payloadBytes
      if (this.#pendingBytes < end) return replies
      // One copy per reply, into a buffer of its own, so a reply holds no view into the chunks it came in.
      const message = this.#take(end)
      replies.push(readReply(message.subarray(PREFIX_BYTES, headerEnd), message.subarray(headerEnd)))
    }
  }

  /** Marks stdout EOF; an incomplete prefix, header or payload is a terminal protocol failure. */
  end(): void {
    if (this.#failure !== undefined) throw this.#failure
    this.#ended = true
    if (this.#pendingBytes === 0) return
    const bytes = this.#pendingBytes
    this.#chunks.length = 0
    this.#pendingBytes = 0
    this.#failure = new MediaProtocolError(`the media reply stream ended with ${bytes} bytes of a truncated reply`)
    throw this.#failure
  }

  /** Bytes of a reply that has not fully arrived. */
  get pendingBytes(): number {
    return this.#pendingBytes
  }

  // The first `length` bytes, without taking them; copies only when they span chunks.
  #peek(length: number): Buffer {
    const first = this.#chunks[0]
    if (first !== undefined && first.byteLength >= length) return first.subarray(0, length)
    return Buffer.concat(this.#chunks, length)
  }

  // Takes the first `length` bytes, which have all arrived, joined into one new buffer.
  #take(length: number): Buffer {
    const parts: Buffer[] = []
    let needed = length
    while (needed > 0) {
      const first = this.#chunks[0]
      if (first === undefined) throw new MediaProtocolError(`the reply reader lost track of ${needed} bytes`)
      if (first.byteLength <= needed) {
        parts.push(first)
        this.#chunks.shift()
        needed -= first.byteLength
      } else {
        parts.push(first.subarray(0, needed))
        this.#chunks[0] = first.subarray(needed)
        needed = 0
      }
    }
    this.#pendingBytes -= length
    return Buffer.concat(parts, length)
  }
}

function readReply(header: Buffer, payload: Buffer): MediaReply {
  let value: unknown
  try {
    value = JSON.parse(header.toString('utf8'))
  } catch (error) {
    throw new MediaProtocolError('a reply header is not JSON', { cause: error })
  }
  if (isPlainObject(value) && value['type'] === 'hello' && typeof value['protocol'] === 'number' && value['protocol'] !== MEDIA_PROTOCOL_VERSION) {
    const version = value['version']
    throw new MediaVersionMismatch(value['protocol'], typeof version === 'string' ? version.slice(0, 64) : undefined)
  }
  const type = isPlainObject(value) ? value['type'] : undefined
  if (type === 'ended') return assembleEnded(checked(endedHeaderSchema, value), payload)
  if (type === 'frames') return assembleSequence(checked(frameSequenceHeaderSchema, value), payload)
  if (type === 'live') return assembleLive(checked(liveFrameHeaderSchema, value), payload)
  if (payload.byteLength !== 0) throw new MediaProtocolError(`a ${String(type)} reply carried ${payload.byteLength} payload bytes; it carries none`)
  return checked(payloadFreeSchema, value)
}

function checked<T>(schema: Schema<T>, value: unknown): T {
  const parsed = parse(schema, value)
  if (parsed.ok) return parsed.value
  const issues = parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')
  throw new MediaProtocolError(`a reply does not match protocol ${MEDIA_PROTOCOL_VERSION}: ${issues}`)
}

function assembleEnded(header: EndedHeader, payload: Buffer): Ended {
  let value: unknown
  try {
    value = payload.byteLength === 0 ? [] : JSON.parse(payload.toString('utf8'))
  } catch (error) {
    throw new MediaProtocolError(`the frame map of ${header.recordingId} is not JSON`, { cause: error })
  }
  const frameMap = checked(s.array(frameMapEntrySchema), value)
  if (frameMap.length !== header.frameMapEntries) throw new MediaProtocolError(`the frame map of ${header.recordingId} lists ${frameMap.length} frames; its header says ${header.frameMapEntries}`)
  return { ...header, frameMap }
}

function assembleSequence(header: FrameSequenceHeader, payload: Buffer): FrameSequence {
  let offset = 0
  const frames = header.frames.map((frame): SequenceFrame => {
    const bytes = payload.subarray(offset, offset + frame.byteLength)
    offset += frame.byteLength
    return { ...frame, bytes }
  })
  if (offset !== payload.byteLength) throw new MediaProtocolError(`the frame sequence ${header.requestId} names ${offset} image bytes; ${payload.byteLength} came`)
  return { ...header, frames }
}

function assembleLive(header: LiveFrameHeader, payload: Buffer): LiveFrame {
  if (header.byteLength !== payload.byteLength) throw new MediaProtocolError(`a live frame of ${header.recordingId} names ${header.byteLength} bytes; ${payload.byteLength} came`)
  return { ...header, bytes: payload }
}
