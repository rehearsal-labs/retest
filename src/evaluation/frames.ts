import type { FrameSequence, FrameSequenceRequest, FrameStretch, SequenceFrame } from '../media/protocol.ts'
import type { EvidenceRecord, EvidenceSelector, EvidenceStatus, FrameNotSentRecord, FrameRecord, FrameStretchRecord } from '../protocol/evaluation.ts'
import type { CaptureSourceName } from '../protocol/identity.ts'
import type { RunStore } from '../store/run-store.ts'
import type { JudgedFrames, JudgedStretch } from './contract.ts'
import type { EvaluationLimits } from './budget.ts'
import { createHash } from 'node:crypto'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage } from '../protocol/failures.ts'
import { slug } from '../protocol/run-folder.ts'
import { bounded } from '../runner/bounded.ts'
import { mediaFramesCap } from './budget.ts'

/**
 * A recording's kept frames, as the media client's `Recording.frames` gives them: the frames whose capture times lie
 * in an interval, fitted and bounded as asked, with the stretches that had no kept frame. A stand-in with the same
 * shape serves fixtures and tests.
 */
export interface FrameStore {
  frames(request: FrameSequenceRequest, timeoutMs: number): Promise<FrameSequence>
}

/**
 * An app's recording in this attempt, as the run knows it: one that keeps frames, with what captured them; one that
 * failed, with why; or one whose frames the pixel capture policy withholds from judges, with why.
 */
export type AttemptRecording =
  | { readonly state: 'recording'; readonly store: FrameStore; readonly source?: CaptureSourceName }
  | { readonly state: 'failed'; readonly reason: string }
  | { readonly state: 'withheld'; readonly reason: string }

/** When a step of the attempt started and ended, on the run's clock in microseconds. A step still running has no end. */
export type StepSpan = { readonly fromUs: number; readonly toUs?: number }

/**
 * What an attempt's frame checks need from the run that records it: each app's recording, and the span of a step by
 * its name, the latest one with that name. A run that records an app gives its recording; for an app it does not
 * record, `recording` gives nothing, and every frame check of that app says so.
 */
export interface AttemptRecordings {
  recording(app: string): AttemptRecording | undefined
  step(name: string): StepSpan | undefined
}

/** Frames evidence the parent holds: what the judge receives, and what the record keeps. */
export type HeldFrames = { frames: JudgedFrames; record: EvidenceRecord }

/**
 * Why frames could not be gathered: `missing` leaves the check inconclusive, `refused` makes it an error. `record`
 * is the unavailable evidence the check's record names.
 */
export type FramesProblem = { kind: 'missing' | 'refused'; reason: string; record: EvidenceRecord }

export type GatheredFrames = { ok: true; value: HeldFrames } | { ok: false; problem: FramesProblem }

export type FramesOptions = {
  id: string
  selector: Extract<EvidenceSelector, { kind: 'recording' }>
  app: string
  recordings: AttemptRecordings | undefined
  store: Pick<RunStore, 'elapsedMs' | 'writeArtifact'>
  redact: (text: string) => string
  testId: string
  attemptId: string
  checkId: string
  limits: EvaluationLimits
  /** Frames the check may still send, after any earlier sequence. */
  framesLeft: number
  /** Input bytes the check may still send. */
  bytesLeft: number
  timeoutMs: number
  stop: Promise<unknown>
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
// The media process sends at most this much for one sequence, whatever is asked.
const mediaBytesCap = 16 * 1024 * 1024

/**
 * Takes the frames of an app's recording over the interval a check names: a step of the attempt, or the `lastMs`
 * before now, on the run's clock. The parent asks the recording's store for them, bounded by the check's frames and
 * bytes left and the image limits, saves each frame in the run folder, hashes it, and states every stretch with no
 * frame, every frame lost there and every kept frame the bounds left out. A run that does not record the app, a step
 * the attempt has not started, or frames the pixel policy withholds are refused; a recording that failed, a store
 * that does not answer or keeps nothing for the interval leaves the check without its evidence.
 *
 * @example const gathered = await gatherFrames({ id: 'e1', selector, app: 'web', ...options })
 */
export async function gatherFrames(options: FramesOptions): Promise<GatheredFrames> {
  const { selector, app, recordings } = options
  const step = 'step' in selector ? selector.step : undefined
  const recording = recordings?.recording(app)
  const unavailable = (kind: FramesProblem['kind'], reason: string, interval?: Interval): GatheredFrames => ({ ok: false, problem: { kind, reason, record: unavailableRecord(options, reason, step, interval) } })
  if (recordings === undefined || recording === undefined) return unavailable('refused', `The run does not record ${app}, so the check has no frames of it. Record ${app} to judge its frames.`)
  if (recording.state === 'failed') return unavailable('missing', `The recording of ${app} failed, so the check has no frames of it: ${options.redact(recording.reason)}`)
  if (recording.state === 'withheld') return unavailable('refused', `The pixel capture policy withholds the frames of ${app} from judges: ${options.redact(recording.reason)}`)
  const interval = intervalOf(selector, recordings, options.store)
  if (typeof interval === 'string') return unavailable('refused', interval)
  const framesAsked = Math.min(options.framesLeft, options.limits.maxFrames, mediaFramesCap)
  if (framesAsked < 1) return unavailable('refused', `The check sends more than evaluation.limits.maxFrames of ${options.limits.maxFrames} frames.`, interval)
  const maxBytes = Math.min(options.bytesLeft, mediaBytesCap)
  if (maxBytes < 1) return unavailable('refused', `The check's input is already at evaluation.limits.maxInputBytes of ${options.limits.maxInputBytes}, so no frame fits.`, interval)
  // The default media threshold can hide a short reported capture gap. Request every nonempty stretch; if the list
  // exceeds the media bound, its omitted stretches keep this check partial instead of allowing a false pass.
  const request: FrameSequenceRequest = { fromUs: interval.fromUs, toUs: interval.toUs, maxFrames: framesAsked, maxWidth: Math.min(options.limits.maxImageWidth, 4096), maxHeight: Math.min(options.limits.maxImageHeight, 4096), maxBytes, minGapUs: 1 }
  let asking: Promise<FrameSequence>
  try {
    asking = recording.store.frames(request, options.timeoutMs)
  } catch (error) {
    asking = Promise.reject(error)
  }
  const answered = await bounded(asking, options.timeoutMs, options.stop)
  if (answered.status === 'stopped') return unavailable('missing', `The check was stopped while Retest took the frames of ${app}.`, interval)
  if (answered.status === 'timed_out') return unavailable('missing', `Taking the frames of ${app} took longer than ${options.timeoutMs} ms.`, interval)
  if (answered.status === 'failed') return unavailable('missing', `Retest could not take the frames of ${app}: ${options.redact(errorMessage(answered.error))}`, interval)
  const sequence = answered.value
  if (sequence.status !== 'ok') return unavailable('missing', `${statusReason(sequence, app)}${sequence.message === undefined ? '' : ` ${options.redact(sequence.message)}`}`, interval)
  if (sequence.frames.length === 0) return unavailable('missing', `The recording of ${app} kept no frame from ${formatMs(interval.fromUs)} to ${formatMs(interval.toUs)} on the run's clock, so the check has nothing to judge.${lossSummary(sequence, interval, options.redact)}`, interval)
  const broken = sequenceProblem(sequence, interval, request)
  if (broken !== undefined) return unavailable('missing', `The frames of ${app} could not be used: ${broken}`, interval)
  return freeze(options, sequence, interval, recording.source, step)
}

/**
 * Whether a check's evidence holds frames of a recording, whose declared kinds use the parent's capture rules.
 *
 * @example holdsFrames([{ kind: 'recording', step: 'save' }]) // true
 */
export function holdsFrames(selectors: readonly EvidenceSelector[]): boolean {
  return selectors.some((selector) => selector.kind === 'recording')
}

/**
 * Where a check's frame of a recording goes in the run folder, beside its screenshots.
 *
 * @example evaluationFrameFile('a.retest.ts > saves', 'k3v9q0x2mb', 'web', 'evaluation-1', 'e2', 0, 'jpeg')
 */
export function evaluationFrameFile(testId: string, attemptId: string, app: string, checkId: string, evidenceId: string, index: number, format: 'png' | 'jpeg'): string {
  return `artifacts/${slug(testId, 40)}-${slug(attemptId, 24)}-${slug(app, 24)}-${slug(checkId, 32)}-${slug(evidenceId, 20)}-frame-${String(index + 1).padStart(3, '0')}.${format === 'png' ? 'png' : 'jpg'}`
}

type Interval = { fromUs: number; toUs: number }

function intervalOf(selector: FramesOptions['selector'], recordings: AttemptRecordings, store: FramesOptions['store']): Interval | string {
  const elapsed = store.elapsedMs()
  if (elapsed === undefined) return 'The run has no clock yet, so Retest cannot tell which frames the check means.'
  const nowUs = Math.max(0, Math.floor(elapsed * 1000))
  if ('lastMs' in selector) return { fromUs: Math.max(0, nowUs - selector.lastMs * 1000), toUs: nowUs }
  const span = recordings.step(selector.step)
  if (span === undefined) return `The check names the step ${JSON.stringify(selector.step)}, which this attempt has not started.`
  const toUs = span.toUs ?? nowUs
  if (!Number.isSafeInteger(span.fromUs) || span.fromUs < 0 || toUs < span.fromUs) return `The step ${JSON.stringify(selector.step)} has no interval Retest can read.`
  return { fromUs: span.fromUs, toUs }
}

function statusReason(sequence: FrameSequence, app: string): string {
  switch (sequence.status) {
    case 'not_kept':
      return `The recording of ${app} keeps no frames, so the check has none to judge.`
    case 'released':
      return `The kept frames of ${app} were already removed, so the check has none to judge.`
    case 'busy':
      return `The media process was too busy to make the frames of ${app}, so the check has none to judge.`
    case 'stopped':
      return `The media process stopped before it made the frames of ${app}, so the check has none to judge.`
    case 'store_failed':
      return `The media process could not read the kept frames of ${app}, so the check has none to judge.`
    case 'ok':
      return ''
  }
}

// The media process never makes up a frame, and Retest checks that it did not: each frame lies in the interval, in
// order, within the bounds asked, with bytes of the format it names.
function sequenceProblem(sequence: FrameSequence, interval: Interval, request: FrameSequenceRequest): string | undefined {
  if (sequence.fromUs !== request.fromUs || sequence.toUs !== request.toUs) return `the answer is for ${formatMs(sequence.fromUs)} to ${formatMs(sequence.toUs)}, not the interval asked.`
  if (sequence.frames.length > request.maxFrames) return `${sequence.frames.length} frames came back where at most ${request.maxFrames} were asked.`
  if (sequence.available > sequence.inInterval || sequence.frames.length > sequence.available) return `the answer counts ${sequence.inInterval} frames in the interval, ${sequence.available} kept and ${sequence.frames.length} sent, which cannot all be true.`
  if (sequence.frames.length + sequence.omitted.byCount + sequence.omitted.byBytes + sequence.omitted.undecodable !== sequence.available) return 'the returned frames and omissions do not account for every kept frame.'
  let last = -1
  let bytes = 0
  const ids = new Set<string>()
  for (const [index, frame] of sequence.frames.entries()) {
    const at = `frame ${index + 1}`
    if (ids.has(frame.frameId)) return 'the answer names a frame id more than once.'
    ids.add(frame.frameId)
    if (!Number.isSafeInteger(frame.captureUs) || frame.captureUs < interval.fromUs || frame.captureUs > interval.toUs) return `${at} was captured outside the interval.`
    if (frame.captureUs < last) return `${at} is out of order.`
    last = frame.captureUs
    if (frame.bytes.byteLength === 0 || frame.bytes.byteLength !== frame.byteLength) return `${at} has no bytes, or not as many as it says.`
    if (!formatMatches(frame)) return `${at} is not the ${frame.format} image it says it is.`
    if (frame.width < 1 || frame.height < 1 || frame.width > request.maxWidth || frame.height > request.maxHeight) return `${at} is ${frame.width} by ${frame.height}, outside ${request.maxWidth} by ${request.maxHeight}.`
    bytes += frame.byteLength
  }
  if (request.maxBytes !== undefined && bytes > request.maxBytes) return `the frames hold ${bytes} bytes where at most ${request.maxBytes} were asked.`
  return undefined
}

function formatMatches(frame: SequenceFrame): boolean {
  const data = frame.bytes
  if (frame.format === 'png') return data.length >= 8 && pngSignature.every((byte, index) => data[index] === byte)
  return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
}

function freeze(options: FramesOptions, sequence: FrameSequence, interval: Interval, source: CaptureSourceName | undefined, step: string | undefined): GatheredFrames {
  const { id, app, store, testId, attemptId, checkId } = options
  // A frame the recording has not placed is no evidence yet: a pending one may still end unwritten, and an unprocessed
  // one is in no video. Neither reaches the judge; each is named, and its time is a stretch the judge has no picture of.
  const placed = sequence.frames.filter((frame) => frame.fate === 'shown' || frame.fate === 'superseded')
  const notSent: FrameNotSentRecord[] = sequence.frames.flatMap((frame) => (frame.fate === 'pending' || frame.fate === 'unprocessed' ? [{ frameId: frame.frameId, captureUs: frame.captureUs, fate: frame.fate }] : []))
  if (placed.length === 0) {
    const reason = `The recording of ${app} has placed none of the ${sequence.frames.length} ${sequence.frames.length === 1 ? 'frame' : 'frames'} it kept from ${formatMs(interval.fromUs)} to ${formatMs(interval.toUs)} on the run's clock (${notSentWords(notSent)}), so the check has nothing to judge.`
    return { ok: false, problem: { kind: 'missing', reason, record: { ...unavailableRecord(options, reason, step, interval), framesNotSent: notSent } } }
  }
  const frames: FrameRecord[] = []
  const judged: JudgedFrames['frames'][number][] = []
  for (const [index, frame] of placed.entries()) {
    const path = evaluationFrameFile(testId, attemptId, app, checkId, id, index, frame.format)
    const data = Uint8Array.from(frame.bytes)
    try {
      store.writeArtifact(path, data)
    } catch (error) {
      const reason = `Retest could not save frame ${index + 1} of ${app}, so it sent none of them: ${options.redact(errorMessage(error))}`
      return { ok: false, problem: { kind: 'refused', reason, record: unavailableRecord(options, reason, step, interval) } }
    }
    const frameId = `${id}-f${index + 1}`
    const sha256 = createHash('sha256').update(data).digest('hex')
    frames.push({
      id: frameId,
      frameId: frame.frameId,
      ...(frame.actionId === undefined ? {} : { actionId: frame.actionId }),
      ...(frame.observationId === undefined ? {} : { observationId: frame.observationId }),
      captureUs: frame.captureUs,
      fate: frame.fate === 'superseded' ? 'superseded' : 'shown',
      format: frame.format,
      path,
      sha256,
      bytes: data.byteLength,
      width: frame.width,
      height: frame.height,
      sourceWidth: frame.sourceWidth,
      sourceHeight: frame.sourceHeight,
    })
    judged.push(Object.freeze({ id: frameId, mediaType: frame.format === 'png' ? 'image/png' : 'image/jpeg', data, width: frame.width, height: frame.height, atMs: Math.round((frame.captureUs - interval.fromUs) / 1000) }))
  }
  const stretches = sequence.stretches.map(stretchRecord)
  const stored = sequence.storedThroughUs !== undefined && sequence.storedThroughUs < interval.toUs ? sequence.storedThroughUs : undefined
  const omitted = { ...sequence.omitted }
  const leftOut = omitted.byCount + omitted.byBytes + omitted.undecodable
  const missing = missingParts({ sequence, stored, interval, notSent, redact: options.redact })
  const complete = missing.length === 0
  const reason = complete ? undefined : `Frames are missing from the interval: ${missing.join(', ')}.`
  const status: EvidenceStatus = complete ? 'complete' : 'partial'
  const judgedStretches: JudgedStretch[] = [
    ...sequence.stretches.map((stretch) => ({ fromMs: relativeMs(stretch.fromUs, interval), toMs: relativeMs(stretch.toUs, interval), why: stretchWords(stretch) })),
    ...notSentStretches(notSent, sequence.frames, interval),
    ...(stored === undefined ? [] : [{ fromMs: relativeMs(stored, interval), toMs: relativeMs(interval.toUs, interval), why: 'the recording had not stored these frames yet when the check took them' }]),
  ].sort((first, second) => first.fromMs - second.fromMs)
  const bytes = frames.reduce((sum, frame) => sum + frame.bytes, 0)
  const manifest = { fromUs: interval.fromUs, toUs: interval.toUs, frames: frames.map(({ id: frameId, captureUs, sha256 }) => ({ id: frameId, captureUs, sha256 })), stretches, stretchesFound: sequence.stretchesFound, omitted, framesNotSent: notSent }
  const capturedElapsedMs = store.elapsedMs()
  const record: EvidenceRecord = {
    id,
    kind: 'frames',
    testId,
    attemptId,
    app,
    sessionId: formatSessionId(attemptId, app),
    capturedAt: new Date().toISOString(),
    ...(capturedElapsedMs === undefined ? {} : { capturedElapsedMs }),
    ...(source === undefined ? {} : { source }),
    sha256: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'),
    bytes,
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(step === undefined ? {} : { step }),
    fromUs: interval.fromUs,
    toUs: interval.toUs,
    frames,
    stretches,
    stretchesFound: sequence.stretchesFound,
    inInterval: sequence.inInterval,
    available: sequence.available,
    omitted,
    ...(notSent.length === 0 ? {} : { framesNotSent: notSent }),
  }
  const held: JudgedFrames = Object.freeze({
    id,
    app,
    durationMs: relativeMs(interval.toUs, interval),
    ...(step === undefined ? {} : { step }),
    frames: Object.freeze(judged),
    stretches: Object.freeze(judgedStretches),
    omitted: leftOut + notSent.length,
    unlistedStretches: Math.max(0, sequence.stretchesFound - sequence.stretches.length),
    complete,
  })
  return { ok: true, value: { frames: held, record } }
}

/** What `missingParts` reads: the sequence, the end of what was stored when short of the interval, and the frames not sent. */
export type MissingFacts = { sequence: FrameSequence; stored: number | undefined; interval: Interval; notSent: readonly FrameNotSentRecord[]; redact: (text: string) => string }

/**
 * What is missing from a frame sequence, in Retest's words, or nothing when it is complete. Frames that reached the
 * media process and were not kept, a stretch with a loss or a gap the capture reported, stretches the process counted
 * but did not list, kept frames the bounds or a failed read left out, frames the recording had not placed, frames not
 * stored yet and a process that says frames may be missing all count. A stretch in which no frame arrived is not a
 * loss: the capture sent nothing there, and the judge is told so.
 *
 * @example missingParts({ sequence, stored: undefined, interval, notSent: [], redact }) // ['1 frame that reached the media process not kept']
 */
export function missingParts(facts: MissingFacts): string[] {
  const { sequence, stored, interval, notSent } = facts
  const parts: string[] = []
  const lost = sequence.inInterval - sequence.available
  if (lost > 0) parts.push(`${lost} ${lost === 1 ? 'frame' : 'frames'} that reached the media process not kept`)
  const losses = sequence.stretches.filter((stretch) => Object.values(stretch.lost).some((count) => count > 0)).length
  if (lost === 0 && losses > 0) parts.push(`${losses} ${losses === 1 ? 'stretch' : 'stretches'} with frames lost or queued`)
  if ((sequence.captureGapsOmitted ?? 0) > 0) parts.push(`${sequence.captureGapsOmitted} capture ${sequence.captureGapsOmitted === 1 ? 'gap' : 'gaps'} omitted from the recording's retained list; this interval may overlap them`)
  const gapped = sequence.stretches.filter((stretch) => stretch.captureGaps.length > 0).length
  if (gapped > 0) parts.push(`${gapped} ${gapped === 1 ? 'stretch' : 'stretches'} with a gap the capture reported`)
  const unlisted = sequence.stretchesFound - sequence.stretches.length
  if (unlisted > 0) parts.push(`${unlisted} more ${unlisted === 1 ? 'stretch' : 'stretches'} with no kept frame that the media process did not list`)
  const { byCount, byBytes, undecodable } = sequence.omitted
  if (byCount > 0) parts.push(`${byCount} kept ${byCount === 1 ? 'frame' : 'frames'} left out by the frame bound (evaluation.limits.maxFrames, or the media process's 64)`)
  if (byBytes > 0) parts.push(`${byBytes} kept ${byBytes === 1 ? 'frame' : 'frames'} left out by the byte bound`)
  if (undecodable > 0) parts.push(`${undecodable} kept ${undecodable === 1 ? 'frame' : 'frames'} that could not be read or decoded`)
  if (notSent.length > 0) parts.push(notSentWords(notSent))
  if (stored !== undefined) parts.push(`frames after ${formatMs(stored)} not stored yet of an interval to ${formatMs(interval.toUs)}`)
  if (sequence.message !== undefined) parts.push(`the media process says: ${facts.redact(sequence.message)}`)
  return parts
}

function notSentWords(notSent: readonly FrameNotSentRecord[]): string {
  const pending = notSent.filter((frame) => frame.fate === 'pending').length
  const unprocessed = notSent.length - pending
  return [
    ...(pending === 0 ? [] : [`${pending} ${pending === 1 ? 'frame' : 'frames'} the running recording had not placed yet`]),
    ...(unprocessed === 0 ? [] : [`${unprocessed} ${unprocessed === 1 ? 'frame' : 'frames'} the recording ended without writing`]),
  ].join(', ')
}

// From each frame not sent until the next frame the process returned, or the interval's end, the screen showed what
// that frame holds, which the judge does not see. Frames not sent one after another make one stretch.
function notSentStretches(notSent: readonly FrameNotSentRecord[], returned: readonly SequenceFrame[], interval: Interval): JudgedStretch[] {
  const stretches: JudgedStretch[] = []
  for (const frame of notSent) {
    const next = returned.find((each) => each.captureUs > frame.captureUs && (each.fate === 'shown' || each.fate === 'superseded'))
    const toUs = next?.captureUs ?? interval.toUs
    const why = frame.fate === 'pending' ? 'a frame captured here was not placed in the running recording yet, so it is not shown' : 'a frame captured here was never written to the recording, so it is not shown'
    const last = stretches.at(-1)
    if (last !== undefined && last.toMs >= relativeMs(frame.captureUs, interval) && last.why === why) stretches[stretches.length - 1] = { ...last, toMs: relativeMs(toUs, interval) }
    else stretches.push({ fromMs: relativeMs(frame.captureUs, interval), toMs: relativeMs(toUs, interval), why })
  }
  return stretches
}

function stretchRecord(stretch: FrameStretch): FrameStretchRecord {
  return { fromUs: stretch.fromUs, toUs: stretch.toUs, lost: { ...stretch.lost }, captureGaps: [...stretch.captureGaps] }
}

const lossWords: readonly [keyof FrameStretch['lost'], string][] = [
  ['dropped', 'dropped by a full queue'],
  ['undecodable', 'that could not be decoded'],
  ['outOfOrder', 'out of order'],
  ['outOfRange', 'out of range'],
  ['duplicate', 'repeated'],
  ['queued', 'still waiting for the encoder'],
  ['notStored', 'not stored'],
]

// Retest's own words for a stretch: what was lost there and the capture's own codes, or that no frame arrived.
function stretchWords(stretch: FrameStretch): string {
  const lost = lossWords.flatMap(([key, words]) => (stretch.lost[key] === 0 ? [] : [`${stretch.lost[key]} ${stretch.lost[key] === 1 ? 'frame' : 'frames'} ${words}`]))
  const gaps = stretch.captureGaps.map((code) => `the capture reported a gap (${code})`)
  const parts = [...lost, ...gaps]
  return parts.length === 0 ? 'no frame reached Retest' : parts.join('; ')
}

function lossSummary(sequence: FrameSequence, interval: Interval, redact: (text: string) => string): string {
  if (sequence.inInterval === 0 && sequence.stretches.every((stretch) => stretch.captureGaps.length === 0) && sequence.message === undefined) return ''
  const stored = sequence.storedThroughUs !== undefined && sequence.storedThroughUs < interval.toUs ? sequence.storedThroughUs : undefined
  const parts = missingParts({ sequence, stored, interval, notSent: [], redact })
  return parts.length === 0 ? '' : ` Frames are missing from the interval: ${parts.join(', ')}.`
}

function unavailableRecord(options: FramesOptions, reason: string, step: string | undefined, interval: Interval | undefined): EvidenceRecord {
  const { id, app, store, testId, attemptId } = options
  const capturedElapsedMs = store.elapsedMs()
  return {
    id,
    kind: 'frames',
    testId,
    attemptId,
    app,
    sessionId: formatSessionId(attemptId, app),
    capturedAt: new Date().toISOString(),
    ...(capturedElapsedMs === undefined ? {} : { capturedElapsedMs }),
    sha256: createHash('sha256').update('').digest('hex'),
    bytes: 0,
    status: 'unavailable',
    reason,
    ...(step === undefined ? {} : { step }),
    ...(interval === undefined ? {} : { fromUs: interval.fromUs, toUs: interval.toUs }),
    frames: [],
  }
}

function relativeMs(us: number, interval: Interval): number {
  return Math.max(0, Math.round((us - interval.fromUs) / 1000))
}

function formatMs(us: number): string {
  return `${Math.round(us / 1000)} ms`
}
