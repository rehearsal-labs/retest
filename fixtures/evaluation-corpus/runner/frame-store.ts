import type { FrameStore } from '../../../src/evaluation/frames.ts'
import type { FrameSequence, FrameSequenceRequest, FrameSequenceStatus, FrameStretch, SequenceFrame } from '../../../src/media/protocol.ts'

// A stand-in for the media process's frame store, answering `Recording.frames` from frames held in memory, as protocol
// version 2 documents it: the kept frames in the interval, cut into `maxFrames` equal parts with the frame nearest each
// part's middle taken, bounded by `maxBytes`, and every stretch without a kept frame at least `minGapUs` long or overlapping a known capture gap listed with
// the frames lost inside it and the capture's own gap codes. It never resizes: a frame larger than the request's bounds
// is refused, so a fixture shows at once that it needs the real process. The corpus uses this fixed-fixture stand-in;
// real-process frame checks run separately, and this stand-in proves nothing about the media process itself.

/**
 * A frame the stand-in holds, as the capture gave it, with what the recording made of it: `shown` unless `fate` says
 * otherwise.
 */
export type HeldFrame = { frameId: string; captureUs: number; format: 'png' | 'jpeg'; bytes: Uint8Array; width: number; height: number; actionId?: string; observationId?: string; fate?: SequenceFrame['fate'] }

/** A frame that reached the process and was not kept, with what became of it. */
export type LostFrame = { captureUs: number; fate: keyof FrameStretch['lost'] }

/** A gap the capture itself reported, with its code. */
export type ReportedGap = { fromUs: number; toUs: number; reason: string }

export type FrameStoreOptions = {
  frames: readonly HeldFrame[]
  lost?: readonly LostFrame[]
  captureGaps?: readonly ReportedGap[]
  /** The recording's frame interval; a quiet stretch is listed when it is at least twice this, unless the request says. */
  frameIntervalUs: number
  /** Answer with this status and no frames, as the process does when it cannot answer. */
  status?: Exclude<FrameSequenceStatus, 'ok'>
  recording?: 'running' | 'ended'
  storedThroughUs?: number
  /** Answer only after this many milliseconds. */
  delayMs?: number
  /** Reject with this message instead of answering. */
  failure?: string
  /** The note an `ok` sequence carries when frames of the interval may be missing from it. */
  message?: string
  recordingId?: string
}

const listedStretches = 64
const defaultMaxBytes = 16 * 1024 * 1024

/**
 * Makes a frame store over frames held in memory. Each call is logged in `asked`.
 *
 * @example const store = frameStore({ frames, frameIntervalUs: 100_000 })
 */
export function frameStore(options: FrameStoreOptions): FrameStore & { asked: FrameSequenceRequest[] } {
  const asked: FrameSequenceRequest[] = []
  let requests = 0
  return {
    asked,
    async frames(request) {
      asked.push({ ...request })
      requests++
      if (options.delayMs !== undefined) await new Promise((resolve) => setTimeout(resolve, options.delayMs))
      if (options.failure !== undefined) throw new Error(options.failure)
      return answer(options, request, `request-${requests}`)
    },
  }
}

function answer(options: FrameStoreOptions, request: FrameSequenceRequest, requestId: string): FrameSequence {
  const head = { type: 'frames' as const, requestId, recordingId: options.recordingId ?? 'stand-in', recording: options.recording ?? 'ended', fromUs: request.fromUs, toUs: request.toUs, ...(options.storedThroughUs === undefined ? {} : { storedThroughUs: options.storedThroughUs }) }
  const inside = (us: number): boolean => us >= request.fromUs && us <= request.toUs
  const kept = options.frames.filter((frame) => inside(frame.captureUs) && (options.storedThroughUs === undefined || frame.captureUs <= options.storedThroughUs)).sort((first, second) => first.captureUs - second.captureUs)
  const lost = (options.lost ?? []).filter((each) => inside(each.captureUs))
  const empty = { omitted: { byCount: 0, byBytes: 0, undecodable: 0 }, stretches: [], stretchesFound: 0 }
  if (options.status !== undefined) return { ...head, status: options.status, inInterval: kept.length + lost.length, available: 0, frames: [], ...empty }
  const chosen = sample(kept, request)
  const maxBytes = request.maxBytes ?? defaultMaxBytes
  const frames: SequenceFrame[] = []
  let bytes = 0
  let byBytes = 0
  for (const frame of chosen) {
    if (frame.width > request.maxWidth || frame.height > request.maxHeight) throw new Error(`The frame store stand-in does not resize: frame ${frame.frameId} is ${frame.width} by ${frame.height}, over ${request.maxWidth} by ${request.maxHeight}.`)
    if (bytes + frame.bytes.byteLength > maxBytes) {
      byBytes++
      continue
    }
    bytes += frame.bytes.byteLength
    frames.push({
      frameId: frame.frameId,
      ...(frame.actionId === undefined ? {} : { actionId: frame.actionId }),
      ...(frame.observationId === undefined ? {} : { observationId: frame.observationId }),
      captureUs: frame.captureUs,
      fate: frame.fate ?? 'shown',
      sourceWidth: frame.width,
      sourceHeight: frame.height,
      width: frame.width,
      height: frame.height,
      format: frame.format,
      byteLength: frame.bytes.byteLength,
      bytes: frame.bytes.slice(),
    })
  }
  const stretches = stretchesOf(kept, lost, options.captureGaps ?? [], request, request.minGapUs ?? options.frameIntervalUs * 2)
  return {
    ...head,
    status: 'ok',
    ...(options.message === undefined ? {} : { message: options.message }),
    inInterval: kept.length + lost.length,
    available: kept.length,
    frames,
    omitted: { byCount: kept.length - chosen.length, byBytes, undecodable: 0 },
    stretches: stretches.slice(0, listedStretches),
    stretchesFound: stretches.length,
  }
}

// With more frames than asked, the interval is cut into equal parts and the frame nearest each part's middle is taken.
function sample(kept: readonly HeldFrame[], request: FrameSequenceRequest): HeldFrame[] {
  if (kept.length <= request.maxFrames) return [...kept]
  const part = (request.toUs - request.fromUs) / request.maxFrames
  const taken = new Set<HeldFrame>()
  for (let index = 0; index < request.maxFrames; index++) {
    const middle = request.fromUs + part * (index + 0.5)
    let nearest: HeldFrame | undefined
    for (const frame of kept) if (!taken.has(frame) && (nearest === undefined || Math.abs(frame.captureUs - middle) < Math.abs(nearest.captureUs - middle))) nearest = frame
    if (nearest !== undefined) taken.add(nearest)
  }
  return kept.filter((frame) => taken.has(frame))
}

function stretchesOf(kept: readonly HeldFrame[], lost: readonly LostFrame[], gaps: readonly ReportedGap[], request: FrameSequenceRequest, minGapUs: number): FrameStretch[] {
  const edges = [request.fromUs, ...kept.map((frame) => frame.captureUs), request.toUs]
  const stretches: FrameStretch[] = []
  for (let index = 1; index < edges.length; index++) {
    const fromUs = edges[index - 1] ?? request.fromUs
    const toUs = edges[index] ?? request.toUs
    const codes = gaps.filter((gap) => gap.fromUs <= toUs && gap.toUs >= fromUs).map((gap) => gap.reason)
    if (kept.length > 0 && toUs - fromUs < Math.max(1, minGapUs) && codes.length === 0) continue
    const within = lost.filter((each) => each.captureUs > fromUs && each.captureUs < toUs)
    const counts = { dropped: 0, undecodable: 0, outOfOrder: 0, outOfRange: 0, duplicate: 0, queued: 0, notStored: 0 }
    for (const each of within) counts[each.fate]++
    stretches.push({ fromUs, toUs, lost: counts, captureGaps: [...new Set(codes)] })
  }
  return stretches
}
