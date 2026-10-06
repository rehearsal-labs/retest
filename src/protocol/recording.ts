import { captureSourceNameSchema, type CaptureSourceName } from './identity.ts'
import { s, type Schema } from './schema.ts'

/**
 * Why part of a run's evidence is missing or incomplete, as a code a program can switch on. The first group is what the
 * media process said of a recording's own ending; the rest are the runner's.
 *
 * - `frames_dropped` … `encoder_reported_errors`, `no_frames` … `output_failed`: the media process's own reasons, as its
 *   `ended.evidence.reasons` names them.
 * - `no_frame_source`: the app's target has no frame source yet, so nothing could be recorded. Never a failure.
 * - `capture_unavailable`: the target's frame source said it could not capture, or its capture did not start.
 * - `capture_ended_early`: the capture ended before the attempt did, as when the page's browser was lost.
 * - `capture_incomplete`: source frames or gap reports were lost, capture cleanup failed, or the media ending lacked its reason.
 * - `pixels_withheld`: the pixel capture policy withheld frames while a secret may have been on screen.
 * - `not_allowed`: the app's pixel rules do not allow recordings, or screenshots.
 * - `media_unavailable`: the media process could not be started, or speaks another protocol.
 * - `encoder_unavailable` (also the media process's): its ffmpeg cannot record.
 * - `media_process_lost`: the media process ended while the recording ran.
 * - `recording_lost`: no ending came for the recording within its time.
 * - `run_stopped`: the run stopped before the recording was written down; only a result rebuilt from events says it.
 * - `frames_not_sent`, `frames_refused`: frames the runner could not send, or refused before sending.
 * - `screenshot_failed`, `screenshot_withheld`: a failure screenshot that could not be taken, or that the policy withheld.
 */
export const evidenceGapCodes = [
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
  'no_frame_source',
  'capture_unavailable',
  'capture_ended_early',
  'capture_incomplete',
  'pixels_withheld',
  'not_allowed',
  'media_unavailable',
  'media_process_lost',
  'recording_lost',
  'run_stopped',
  'frames_not_sent',
  'frames_refused',
  'screenshot_failed',
  'screenshot_withheld',
] as const

export type EvidenceGapCode = (typeof evidenceGapCodes)[number]

/**
 * One thing the evidence lacks: its code, words a report can show, and the app and session it concerns when it concerns
 * one. The words never quote app text or a secret's value.
 */
export type EvidenceGap = { code: EvidenceGapCode; message: string; app?: string; sessionId?: string }

/**
 * How complete a piece of evidence is, apart from what the test observed. `complete`: every recording asked for holds
 * every frame that reached it. `partial`: something usable exists and `gaps` names what it lacks. `unavailable`: nothing
 * usable exists and `gaps` names why. `not_requested`: nothing was asked to be recorded.
 */
export type EvidenceState = 'complete' | 'partial' | 'unavailable' | 'not_requested'

/** An attempt's evidence: its state and, unless complete or not requested, what it lacks. */
export type EvidenceStatus = { state: EvidenceState; gaps?: EvidenceGap[] }

/**
 * A run's evidence: its state over every attempt that ran, how many attempts ended each way, whether the run required
 * evidence, and what the run itself lacked, such as a media process that would not start. The tests' own gaps stay on
 * the tests.
 */
export type RunEvidenceStatus = EvidenceStatus & {
  required?: true
  attempts: { complete: number; partial: number; unavailable: number; notRequested: number }
}

/**
 * Every frame a recording's source delivered, and what the runner did with it: `sent` to the media process, `dropped`
 * because the pipe was full, `notSent` because the recording was not taking frames, `withheld` by the pixel capture
 * policy, or `refused` before sending for breaking a rule of the media protocol. `delivered` is the sum of the rest.
 */
export type RecordingFrames = { delivered: number; sent: number; dropped: number; notSent: number; withheld: number; refused: number }

/** What became of the frames that reached the media process, as its ending counts them. */
export type MediaFrameCounts = {
  received: number
  shown: number
  superseded: number
  dropped: number
  outOfOrder: number
  outOfRange: number
  undecodable: number
  duplicate: number
  unprocessed: number
}

/**
 * How the run's clock, the capture's timestamps and the video's time line up. Every frame is stamped with the run's clock
 * in whole microseconds, on the same clock and from the same zero as every event's `elapsedMs`. Video time zero is the
 * capture time `videoZeroUs`; an event at `elapsedMs` is at video time `elapsedMs * 1000 - videoZeroUs`, less the
 * `shortenedByUs` of every pause in `shortened` that comes before it, and is inside the video while that is from 0 to
 * `durationUs`. `shortened` lists the first 64 pauses the video shortened and `shortenedCount` counts them all.
 */
export type RecordingClock = {
  capture: 'run_us'
  /** Whether source timestamps measure host arrival or target paint. Absent on older records. */
  timestamp?: 'host-arrival' | 'target-paint'
  videoZeroUs: number
  durationUs: number
  shortened: { captureUs: number; shortenedByUs: number }[]
  shortenedCount: number
}

/** Source timing facts. run-arrival uses the host clock and establishes no target paint timestamp. */
export type RecordingCapture = {
  clockMapping?: { timestamp: 'run-arrival'; targetClock: 'not-used'; imageRead: 'request-to-arrival' | 'since-start' | 'previous-delivery-to-arrival' | 'previous-acknowledgement-to-arrival' }
  achievedFps?: number
  captureMs?: { count: number; minMs: number; meanMs: number; maxMs: number }
}

/** The video a recording left: its encoding and size, its frame rate and length, and how the finished file was put in place. */
export type RecordingVideo = { codec: 'h264' | 'vp8'; container: 'mp4' | 'webm'; width: number; height: number; fps: number; outputFrames: number; durationUs: number; placedBy?: 'link' | 'copy' }

/**
 * One recording of one app session in one attempt, as it ended. Its identity is the run's (the event's `runId`), the
 * attempt's, the test's, the app's and the session's; `sequence` numbers the session's recordings from 1, and
 * `recordingId` is unique in the run. `status` and `gaps` are its evidence. `path` is the video, a reference relative to
 * the run folder, present only when a usable file exists; `partialPath` names a partial file the media process kept
 * instead. `source` and `mode` say what captured the frames, `frames` what the runner did with them and `media` what the
 * media process did with those that reached it. `withheld` counts the stretches the pixel policy withheld and their
 * length in all. `clock` lays the run's events over the video. `stoppedBy` says what ended the capture. `removed` says
 * retention removed the video once its attempt passed, as a config that keeps only failures asks; `path` says where it
 * was, and an `artifact.removed` event confirmed it went. `removalPending` names a request with no completion.
 */
export type RecordingRecord = {
  recordingId: string
  sequence: number
  testId: string
  attemptId: string
  app: string
  sessionId: string
  status: 'complete' | 'partial' | 'unavailable'
  gaps: EvidenceGap[]
  path?: string
  partialPath?: string
  source?: CaptureSourceName
  mode?: 'screencast' | 'screenshot-loop'
  capture?: RecordingCapture
  video?: RecordingVideo
  frames?: RecordingFrames
  media?: MediaFrameCounts
  captureGaps?: number
  withheld?: { stretches: number; durationUs: number }
  clock?: RecordingClock
  stoppedBy?: 'attempt_ended' | 'source' | 'recording'
  finalizeMs?: number
  removed?: 'passed_attempt_recording'
  removalPending?: true
}

const count = s.number({ integer: true, min: 0 })
const microseconds = s.number({ integer: true, min: 0 })

export const evidenceGapSchema: Schema<EvidenceGap> = s.object({
  code: s.enum(evidenceGapCodes),
  message: s.string(),
  app: s.optional(s.string()),
  sessionId: s.optional(s.string()),
})

const evidenceStateSchema: Schema<EvidenceState> = s.enum(['complete', 'partial', 'unavailable', 'not_requested'])

export const evidenceStatusSchema: Schema<EvidenceStatus> = s.object({ state: evidenceStateSchema, gaps: s.optional(s.array(evidenceGapSchema)) })

export const runEvidenceStatusSchema: Schema<RunEvidenceStatus> = s.object({
  state: evidenceStateSchema,
  gaps: s.optional(s.array(evidenceGapSchema)),
  required: s.optional(s.literal(true)),
  attempts: s.object({ complete: count, partial: count, unavailable: count, notRequested: count }),
})

export const recordingRecordSchema: Schema<RecordingRecord> = s.object({
  recordingId: s.string(),
  sequence: s.number({ integer: true, min: 1 }),
  testId: s.string(),
  attemptId: s.string(),
  app: s.string(),
  sessionId: s.string(),
  status: s.enum(['complete', 'partial', 'unavailable']),
  gaps: s.array(evidenceGapSchema),
  path: s.optional(s.string()),
  partialPath: s.optional(s.string()),
  source: s.optional(captureSourceNameSchema),
  mode: s.optional(s.enum(['screencast', 'screenshot-loop'])),
  capture: s.optional(s.object({
    clockMapping: s.optional(s.object({ timestamp: s.literal('run-arrival'), targetClock: s.literal('not-used'), imageRead: s.enum(['request-to-arrival', 'since-start', 'previous-delivery-to-arrival', 'previous-acknowledgement-to-arrival']) })),
    achievedFps: s.optional(s.number({ min: 0 })),
    captureMs: s.optional(s.object({ count, minMs: s.number({ min: 0 }), meanMs: s.number({ min: 0 }), maxMs: s.number({ min: 0 }) })),
  })),
  video: s.optional(
    s.object({
      codec: s.enum(['h264', 'vp8']),
      container: s.enum(['mp4', 'webm']),
      width: count,
      height: count,
      fps: count,
      outputFrames: count,
      durationUs: microseconds,
      placedBy: s.optional(s.enum(['link', 'copy'])),
    }),
  ),
  frames: s.optional(s.object({ delivered: count, sent: count, dropped: count, notSent: count, withheld: count, refused: count })),
  media: s.optional(
    s.object({ received: count, shown: count, superseded: count, dropped: count, outOfOrder: count, outOfRange: count, undecodable: count, duplicate: count, unprocessed: count }),
  ),
  captureGaps: s.optional(count),
  withheld: s.optional(s.object({ stretches: count, durationUs: microseconds })),
  clock: s.optional(
    s.object({
      capture: s.literal('run_us'),
      timestamp: s.optional(s.enum(['host-arrival', 'target-paint'])),
      videoZeroUs: microseconds,
      durationUs: microseconds,
      shortened: s.array(s.object({ captureUs: microseconds, shortenedByUs: microseconds })),
      shortenedCount: count,
    }),
  ),
  stoppedBy: s.optional(s.enum(['attempt_ended', 'source', 'recording'])),
  finalizeMs: s.optional(s.number({ min: 0 })),
  removed: s.optional(s.literal('passed_attempt_recording')),
  removalPending: s.optional(s.literal(true)),
})

/**
 * The media process a run started: its process id, its own version and build, the protocol it speaks, the ffmpeg it
 * runs and what its encoder probe found, and which start of the run's this is (a run starts one more after a crash).
 * `owner` is the Retest process that owns it, by pid and start time, so a later run can tell a run that was killed from
 * one still running.
 */
export type MediaStartedRecord = {
  pid: number
  start: number
  version: string
  protocol: number
  build: { target: string; profile: string; revision?: string; dirty?: boolean }
  ffmpeg: string
  encoder: { state: 'ready' | 'unavailable' | 'failed'; codec?: 'h264' | 'vp8'; container?: 'mp4' | 'webm'; encoder?: string; version?: string; message?: string }
  /** Start version 1 is C-locale UTC0; an absent or unknown version cannot confirm ownership. */
  owner: { startTimeVersion?: number; pid: number; startedAt?: string }
}

export const mediaStartedRecordSchema: Schema<MediaStartedRecord> = s.object({
  pid: s.number({ integer: true, min: 1 }),
  start: s.number({ integer: true, min: 1 }),
  version: s.string(),
  protocol: s.number({ integer: true, min: 1 }),
  build: s.object({ target: s.string(), profile: s.string(), revision: s.optional(s.string()), dirty: s.optional(s.boolean()) }),
  ffmpeg: s.string(),
  encoder: s.object({
    state: s.enum(['ready', 'unavailable', 'failed']),
    codec: s.optional(s.enum(['h264', 'vp8'])),
    container: s.optional(s.enum(['mp4', 'webm'])),
    encoder: s.optional(s.string()),
    version: s.optional(s.string()),
    message: s.optional(s.string()),
  }),
  owner: s.object({ startTimeVersion: s.optional(s.number({ integer: true, min: 1 })), pid: s.number({ integer: true, min: 1 }), startedAt: s.optional(s.string()) }),
})

/** A file a killed run's recording left, which this run's media process listed or removed. */
export type LeftoverRecord = { reference: string; kind: 'video_partial' | 'frame_store' | 'thumbnail_partial'; byteLength: number }

export const leftoverRecordSchema: Schema<LeftoverRecord> = s.object({ reference: s.string(), kind: s.enum(['video_partial', 'frame_store', 'thumbnail_partial']), byteLength: count })
