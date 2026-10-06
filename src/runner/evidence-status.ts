import type { Frozen, SourceRecording } from '../media/capture.ts'
import type { Ended, EvidenceReason } from '../media/protocol.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { EvidenceGap, EvidenceGapCode, EvidenceStatus, RecordingFrames, RecordingRecord, RunEvidenceStatus } from '../protocol/recording.ts'
import type { TestResult } from '../protocol/result.ts'
import { failure } from '../protocol/failures.ts'

/** Who a recording belongs to and where it is: its identity, its number in the session, its id in the run. */
export type RecordingPlace = { identity: RecordIdentity; sequence: number; recordingId: string }

/**
 * What the run knows of a recording besides `recordSource`'s report: the video and the partial file as references in
 * the run folder, the frames the pixel policy withheld before the source handed them over, and whether the media
 * process that held it was lost.
 */
export type RecordingFacts = {
  path?: string | undefined
  partialPath?: string | undefined
  withheldBeforeSending: number
  mediaLost: boolean
}

/**
 * A recording that never began, with the one reason it did not: no frame source for the target, no media process, an
 * encoder that cannot record, or a capture that could not start.
 *
 * @example unstartedRecording(place, 'no_frame_source', 'Retest has no frame source for WebKit pages yet.').status // 'unavailable'
 */
export function unstartedRecording(place: RecordingPlace, code: EvidenceGapCode, message: string): RecordingRecord {
  const { identity } = place
  return { ...head(place), status: 'unavailable', gaps: [gap(code, message, identity)] }
}

/**
 * A recording as it ended, from `recordSource`'s report and what the run knows of it. A video that the media process
 * finished is `complete` or `partial`, by its own evidence and by what the runner lost or withheld on the way; anything
 * else is `unavailable`, with why. Superseded frames are no loss: the video shows one frame per tick. A recording whose
 * capture ended before the attempt did is partial even when its video is whole, since the session went on unseen.
 *
 * @example endedRecording(place, report, { withheldBeforeSending: 0, mediaLost: false }).status // 'complete'
 */
export function endedRecording(place: RecordingPlace, report: SourceRecording, facts: RecordingFacts): RecordingRecord {
  const { identity } = place
  const frames = framesOf(report, facts.withheldBeforeSending)
  const described = {
    ...head(place),
    source: report.source,
    ...(report.capture === undefined ? {} : { mode: report.capture.mode, capture: {
      ...(report.capture.clockMapping === undefined ? {} : { clockMapping: { ...report.capture.clockMapping } }),
      ...(report.capture.achievedFps === undefined ? {} : { achievedFps: report.capture.achievedFps }),
      ...(report.capture.captureMs === undefined ? {} : { captureMs: { ...report.capture.captureMs } }),
    } }),
    frames,
    ...(report.gaps.withheldStretches === 0 ? {} : { withheld: { stretches: report.gaps.withheldStretches, durationUs: report.gaps.withheldUs } }),
    ...(report.stoppedBy === undefined ? {} : { stoppedBy: report.stoppedBy === 'signal' ? 'attempt_ended' as const : report.stoppedBy }),
  }
  const { ended } = report
  if (report.status !== 'ended' || ended === undefined || ended.status !== 'ok' || facts.path === undefined) {
    const gaps = unavailableGaps(report, facts, identity)
    const partial = facts.partialPath === undefined ? {} : { partialPath: facts.partialPath }
    return { ...described, ...partial, status: 'unavailable', gaps, ...(ended === undefined ? {} : mediaFacts(ended, report)) }
  }
  const gaps = videoGaps(report, ended, frames, identity)
  return { ...described, path: facts.path, status: gaps.length === 0 ? 'complete' : 'partial', gaps, ...mediaFacts(ended, report), ...videoFacts(report, ended) }
}

/**
 * An attempt's evidence from its recordings and the gaps of its failure screenshots. An attempt with no recording asked
 * for, as one whose apps the run does not record, or one that never opened its pages, is `not_requested`, whatever its
 * screenshots did.
 *
 * @example attemptEvidence([complete], []) // { state: 'complete' }
 */
export function attemptEvidence(recordings: readonly RecordingRecord[], screenshotGaps: readonly EvidenceGap[]): EvidenceStatus {
  if (recordings.length === 0) return { state: 'not_requested' }
  const gaps = [...recordings.flatMap((recording) => recording.gaps), ...screenshotGaps]
  for (const recording of recordings) {
    if (recording.status !== 'complete' && recording.gaps.length === 0) {
      gaps.push({ code: 'capture_incomplete', message: `The recording reported ${recording.status} evidence without a specific reason; Retest cannot claim it is complete.`, app: recording.app, sessionId: recording.sessionId })
    }
  }
  if (gaps.length === 0) return { state: 'complete' }
  const usable = recordings.some((recording) => recording.status !== 'unavailable')
  return { state: usable ? 'partial' : 'unavailable', gaps }
}

/**
 * The run's evidence over its attempts, and what the run itself lacked. An attempt with no evidence status counts as not
 * requested. Every attempt that asked for evidence and got all of it makes `complete`; none that got any makes
 * `unavailable`; anything between is `partial`.
 *
 * @example runEvidence(tests, [], false).state
 */
export function runEvidence(tests: readonly TestResult[], runGaps: readonly EvidenceGap[], required: boolean): RunEvidenceStatus {
  const attempts = { complete: 0, partial: 0, unavailable: 0, notRequested: 0 }
  for (const test of tests) {
    const state = test.evidenceStatus?.state ?? 'not_requested'
    if (state === 'not_requested') attempts.notRequested += 1
    else attempts[state] += 1
  }
  const asked = attempts.complete + attempts.partial + attempts.unavailable
  const state = asked === 0 ? 'not_requested' : attempts.complete === asked && runGaps.length === 0 ? 'complete' : attempts.complete + attempts.partial === 0 ? 'unavailable' : 'partial'
  return { state, ...(runGaps.length === 0 ? {} : { gaps: [...runGaps] }), ...(required ? { required: true as const } : {}), attempts }
}

/**
 * The run's own failure when it required evidence and some is missing or incomplete; never a test's. Every test keeps
 * the outcome it observed.
 *
 * @example evidenceFailure({ state: 'partial', required: true, attempts }) // { class: 'evidence_incomplete', ... }
 */
export function evidenceFailure(status: RunEvidenceStatus): Failure | undefined {
  if (status.required !== true || status.state === 'complete') return undefined
  const { partial, unavailable } = status.attempts
  const lacking = partial + unavailable
  const which = lacking === 0 ? 'the run itself lacks some of it' : `${lacking} ${lacking === 1 ? 'attempt lacks' : 'attempts lack'} some of it (${partial} partial, ${unavailable} unavailable)`
  const message = status.state === 'not_requested' ? 'The run requires evidence, and no attempt recorded any.' : `The run requires evidence, and ${which}. Every test keeps the outcome it observed.`
  return failure('evidence_incomplete', message)
}

function head({ identity, sequence, recordingId }: RecordingPlace): Pick<RecordingRecord, 'recordingId' | 'sequence' | 'testId' | 'attemptId' | 'app' | 'sessionId'> {
  const { testId, attemptId, app, sessionId } = identity
  return { recordingId, sequence, testId, attemptId, app, sessionId }
}

function gap(code: EvidenceGapCode, message: string, identity: RecordIdentity): EvidenceGap {
  return { code, message, app: identity.app, sessionId: identity.sessionId }
}

function framesOf(report: SourceRecording, withheldBeforeSending: number): RecordingFrames {
  const { frames } = report
  const refused = Object.values(frames.refused).reduce((sum, value) => sum + value, 0)
  return { delivered: frames.delivered + withheldBeforeSending, sent: frames.sent, dropped: frames.dropped, notSent: frames.notSent, withheld: frames.withheld + withheldBeforeSending, refused }
}

// A recording with no finished video: why, from the most specific fact the run has.
function unavailableGaps(report: SourceRecording, facts: RecordingFacts, identity: RecordIdentity): EvidenceGap[] {
  const reason = report.reason ?? report.ended?.message ?? 'The recording left no video.'
  if (report.status === 'unavailable') return [gap('capture_unavailable', reason, identity)]
  if (report.status === 'lost') {
    const kept = facts.partialPath === undefined ? '' : ` A partial file is kept at ${facts.partialPath}; whether it plays was not checked.`
    if (facts.mediaLost) return [gap('media_process_lost', `The media process ended while this recording ran: ${reason}${kept}`, identity)]
    return [gap('recording_lost', `No ending came for this recording: ${reason}${kept}`, identity)]
  }
  const { ended } = report
  if (ended === undefined) return [gap(report.stoppedBy === 'signal' ? 'capture_unavailable' : 'media_unavailable', reason, identity)]
  const reasons = ended.evidence.reasons.length === 0 ? [ended.status === 'ok' ? 'output_failed' as const : ended.status] : ended.evidence.reasons
  return reasons.map((code) => gap(code, mediaMessage(code, ended), identity))
}

// What a finished video lacks: the media process's own reasons, and what the runner lost or withheld before sending.
function videoGaps(report: SourceRecording, ended: Frozen<Ended>, frames: RecordingFrames, identity: RecordIdentity): EvidenceGap[] {
  const gaps: EvidenceGap[] = []
  const captureProblems = [...(report.capture?.problems ?? []), ...report.problems]
  if ((report.capture?.dropped ?? 0) > 0 || report.gaps.notSent > 0 || report.gaps.refused > 0 || captureProblems.length > 0) {
    gaps.push(gap('capture_incomplete', `Capture lost ${report.capture?.dropped ?? 0} frames; ${report.gaps.notSent} capture gaps were not sent and ${report.gaps.refused} were refused.${captureProblems.length === 0 ? '' : ` ${captureProblems.join(' ')}`}`, identity))
  }
  const withheldStretches = report.gaps.withheldStretches
  const otherGaps = Math.max(0, Math.max(report.gaps.sent, ended.captureGapsReported) - withheldStretches)
  for (const reason of ended.evidence.reasons) {
    if (reason !== 'capture_gaps') gaps.push(gap(reason, mediaMessage(reason, ended), identity))
    else if (otherGaps > 0 || withheldStretches === 0) gaps.push(gap('capture_gaps', `The capture reported ${otherGaps} ${otherGaps === 1 ? 'stretch' : 'stretches'} in which it could hand over no frame.`, identity))
  }
  if (withheldStretches > 0 || frames.withheld > 0) {
    gaps.push(gap('pixels_withheld', `The pixel capture policy withheld ${frames.withheld} ${frames.withheld === 1 ? 'frame' : 'frames'} over ${withheldStretches} ${withheldStretches === 1 ? 'stretch' : 'stretches'} while a secret may have been on screen; the video holds the frame before each stretch until the next one kept.`, identity))
  }
  if (frames.dropped > 0 && !gaps.some((each) => each.code === 'frames_dropped')) gaps.push(gap('frames_dropped', `${frames.dropped} ${frames.dropped === 1 ? 'frame was' : 'frames were'} dropped because the pipe to the media process was full.`, identity))
  if (frames.notSent > 0) gaps.push(gap('frames_not_sent', `${frames.notSent} ${frames.notSent === 1 ? 'frame was' : 'frames were'} not sent, because the recording was not taking frames when ${frames.notSent === 1 ? 'it' : 'they'} came.`, identity))
  if (frames.refused > 0) gaps.push(gap('frames_refused', `${frames.refused} ${frames.refused === 1 ? 'frame was' : 'frames were'} refused before sending, for breaking a rule of the media protocol.`, identity))
  // The first of the attempt's end, the source's and the recording's stopped the capture, so `source` is a capture that
  // ended while the attempt still ran.
  if (report.stoppedBy === 'source') {
    const why = report.capture?.endedEarly ?? 'the capture ended on its own'
    gaps.push(gap('capture_ended_early', `The capture ended before the attempt did: ${why}`, identity))
  }
  if (gaps.length === 0 && ended.evidence.status !== 'complete') {
    gaps.push(gap('capture_incomplete', `The media process reported ${ended.evidence.status} evidence without a specific reason; Retest cannot claim it is complete.`, identity))
  }
  return gaps
}

function mediaMessage(reason: EvidenceReason, ended: Frozen<Ended>): string {
  const { frames } = ended
  switch (reason) {
    case 'frames_dropped':
      return `The media process dropped ${frames.dropped} ${frames.dropped === 1 ? 'frame' : 'frames'} from a full queue.`
    case 'frames_undecodable':
      return `${frames.undecodable} ${frames.undecodable === 1 ? 'frame' : 'frames'} could not be decoded.`
    case 'frames_out_of_order':
      return `${frames.outOfOrder} ${frames.outOfOrder === 1 ? 'frame' : 'frames'} came out of order.`
    case 'frames_out_of_range':
      return `${frames.outOfRange} ${frames.outOfRange === 1 ? 'frame' : 'frames'} fell past the longest the video may be.`
    case 'frames_duplicate':
      return `${frames.duplicate} ${frames.duplicate === 1 ? 'frame' : 'frames'} reused a frame id.`
    case 'frames_unprocessed':
      return `${frames.unprocessed} ${frames.unprocessed === 1 ? 'frame' : 'frames'} reached the media process after the video was finished.`
    case 'capture_gaps':
      return `The capture reported ${ended.captureGapsReported} ${ended.captureGapsReported === 1 ? 'stretch' : 'stretches'} without frames.`
    case 'gaps_shortened':
      return `${ended.gapsShortened} long ${ended.gapsShortened === 1 ? 'pause was' : 'pauses were'} shortened in the video.`
    case 'end_clipped':
      return 'The end of the video was clipped at the longest it may be.'
    case 'frame_map_truncated':
      return `The frame map lists ${ended.frameMapEntries} frames and leaves out ${ended.frameMapOmitted}.`
    case 'encoder_reported_errors':
      return 'The encoder printed errors while it wrote the video.'
    default:
      return ended.message
  }
}

function mediaFacts(ended: Frozen<Ended>, report: SourceRecording): Pick<RecordingRecord, 'media' | 'captureGaps' | 'clock' | 'finalizeMs'> {
  const { frames } = ended
  const media = { received: frames.received, shown: frames.shown, superseded: frames.superseded, dropped: frames.dropped, outOfOrder: frames.outOfOrder, outOfRange: frames.outOfRange, undecodable: frames.undecodable, duplicate: frames.duplicate, unprocessed: frames.unprocessed }
  const clock = ended.firstTimestampUs === undefined ? {} : {
    clock: { capture: 'run_us' as const, ...(report.capture?.clockMapping?.timestamp === 'run-arrival' ? { timestamp: 'host-arrival' as const } : {}), videoZeroUs: ended.firstTimestampUs, durationUs: ended.durationUs, shortened: ended.gaps.map(({ captureUs, shortenedByUs }) => ({ captureUs, shortenedByUs })), shortenedCount: ended.gapsShortened },
  }
  return { media, captureGaps: ended.captureGapsReported, ...clock, ...(ended.finalizeMs === undefined ? {} : { finalizeMs: ended.finalizeMs }) }
}

function videoFacts(report: SourceRecording, ended: Frozen<Ended>): Pick<RecordingRecord, 'video'> {
  const { started } = report
  if (started === undefined) return {}
  return { video: { codec: started.codec, container: started.container, width: started.width, height: started.height, fps: started.fps, outputFrames: ended.outputFrames, durationUs: ended.durationUs, ...(ended.placedBy === undefined ? {} : { placedBy: ended.placedBy }) } }
}
