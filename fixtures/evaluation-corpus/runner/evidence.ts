import type { HeldEvidence } from '../../../src/evaluation/evidence.ts'
import type { EvaluationLimits } from '../../../src/evaluation/budget.ts'
import type { DiagnosticsSnapshot } from '../../../src/evaluation/diagnostics-evidence.ts'
import type { DiagnosticRecord } from '../../../src/protocol/diagnostics.ts'
import type { Criterion, EvidenceSelector } from '../../../src/protocol/evaluation.ts'
import type { CaseEvidence, CorpusCase } from './cases.ts'
import type { HeldFrame, LostFrame } from './frame-store.ts'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parseArtifact } from '../../../src/diagnostics/artifact.ts'
import { gatherDiagnostics } from '../../../src/evaluation/diagnostics-evidence.ts'
import { pngSize } from '../../../src/evaluation/evidence.ts'
import { gatherFrames } from '../../../src/evaluation/frames.ts'
import { formatSessionId } from '../../../src/protocol/evidence.ts'
import { parse, s } from '../../../src/protocol/schema.ts'
import { corpusFolder } from './cases.ts'
import { frameStore } from './frame-store.ts'

// A case's evidence as a run's parent would hold it. Frames go through the parent's own `gatherFrames` against a
// stand-in of the media process's frame store, and diagnostics through its own `gatherDiagnostics`, so their stretches,
// bounds, statuses and the absence rule are the run's own; text and screenshots are frozen as `gatherEvidence` freezes
// them. Every file a judge receives is written under `folder`, as a run folder keeps them.

/** A captured frame sequence's manifest, as capture-browsers.ts writes it. */
export type FramesManifest = {
  scene: string
  source: string
  clickUs: number
  endUs: number
  frameIntervalUs: number
  frames: { file: string; frameId: string; captureUs: number; format: 'png' | 'jpeg'; width: number; height: number; shows: string[] }[]
}

const manifestSchema = s.object({
  scene: s.string(),
  source: s.string(),
  fps: s.number(),
  viewport: s.object({ width: s.number(), height: s.number() }),
  clickUs: s.number({ integer: true, min: 0 }),
  endUs: s.number({ integer: true, min: 0 }),
  frameIntervalUs: s.number({ integer: true, min: 1 }),
  delivered: s.number({ integer: true, min: 0 }),
  superseded: s.number({ integer: true, min: 0 }),
  dropped: s.number({ integer: true, min: 0 }),
  frames: s.array(s.object({ file: s.string(), frameId: s.string(), captureUs: s.number({ integer: true, min: 0 }), format: s.enum(['png', 'jpeg']), width: s.number({ integer: true, min: 1 }), height: s.number({ integer: true, min: 1 }), shows: s.array(s.string()) })),
})

/**
 * Reads a scene's frame manifest.
 *
 * @example readManifest('toast').frames.length
 */
export function readManifest(scene: string): FramesManifest {
  const file = join(corpusFolder, 'captures', 'frames', scene, 'manifest.json')
  const parsed = parse(manifestSchema, JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.ok) throw new Error(`${file} is not a frame manifest: ${parsed.issues.slice(0, 2).map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  return parsed.value
}

/** What a case's evidence came to: the held evidence, or the problem that stopped it, as a run would record it. */
export type CaseEvidenceResult = { ok: true; evidence: HeldEvidence[] } | { ok: false; verdict: 'inconclusive' | 'error'; reason: string; evidence: HeldEvidence[] }

export type CaseEvidenceOptions = { limits: EvaluationLimits; folder: string; redact: (text: string) => string; criteria: readonly Criterion[]; context: string | undefined }

const attemptId = 'corpus1'
const testId = 'evaluation corpus'

/**
 * Gathers a case's evidence in order, `e1`, `e2` and so on, as `gatherEvidence` numbers it, keeping the input bounds of
 * `limits`. The first problem stops it, as a run's check stops.
 *
 * @example const gathered = await caseEvidence(corpusCase, { limits, folder, redact, criteria, context })
 */
export async function caseEvidence(corpusCase: CorpusCase, options: CaseEvidenceOptions): Promise<CaseEvidenceResult> {
  const held: HeldEvidence[] = []
  let bytes = Buffer.byteLength(JSON.stringify(options.criteria)) + Buffer.byteLength(options.context ?? '')
  let frames = 0
  let images = 0
  for (const [index, evidence] of corpusCase.evidence.entries()) {
    const id = `e${index + 1}`
    const checkId = corpusCase.id
    const one = await gatherOne(id, checkId, evidence, options, { bytesLeft: options.limits.maxInputBytes - bytes, framesLeft: options.limits.maxFrames - frames })
    if (!one.ok) return { ok: false, verdict: one.kind === 'missing' ? 'inconclusive' : 'error', reason: one.reason, evidence: one.record === undefined ? held : [...held, { record: one.record }] }
    bytes += one.held.record.bytes
    frames += one.held.record.frames?.length ?? 0
    if (one.held.record.kind === 'screenshot') images++
    if (images > options.limits.maxImages) return { ok: false, verdict: 'error', reason: `The case sends ${images} screenshots, over maxImages of ${options.limits.maxImages}.`, evidence: [...held, one.held] }
    if (bytes > options.limits.maxInputBytes) return { ok: false, verdict: 'error', reason: `The case's input is ${bytes} bytes, over maxInputBytes of ${options.limits.maxInputBytes}.`, evidence: [...held, one.held] }
    held.push(one.held)
  }
  return { ok: true, evidence: held }
}

/**
 * The selectors a case's evidence stands for in a run, so the parent's rules that read selectors, the absence rule
 * among them, read the same thing.
 *
 * @example selectorsOf(corpusCase) // [{ kind: 'recording', app: 'web', step: 'toast' }]
 */
export function selectorsOf(corpusCase: CorpusCase): EvidenceSelector[] {
  return corpusCase.evidence.map((evidence): EvidenceSelector => {
    if (evidence.kind === 'text') return { kind: 'text', text: evidence.file }
    if (evidence.kind === 'screenshot') return { kind: 'screenshot', app: evidence.app }
    if (evidence.kind === 'diagnostics') return { kind: 'diagnostics', app: evidence.app, include: evidence.include }
    return { kind: 'recording', app: evidence.app, step: evidence.scene }
  })
}

/**
 * The frames a case's recording holds, and the ones it lost: a scene's capture, with the frames that show what `omit`
 * names taken out, silently or as frames the queue dropped.
 *
 * @example heldFramesOf({ kind: 'frames', scene: 'toast', app: 'web', fromMs: -200, toMs: 2400, omit: { showing: 'toast', as: 'silent' } })
 */
export function heldFramesOf(evidence: Extract<CaseEvidence, { kind: 'frames' }>): { frames: HeldFrame[]; lost: LostFrame[]; manifest: FramesManifest } {
  const manifest = readManifest(evidence.scene)
  const folder = join(corpusFolder, 'captures', 'frames', evidence.scene)
  const omitted = (shows: readonly string[]): boolean => evidence.omit !== undefined && shows.includes(evidence.omit.showing)
  const frames = manifest.frames.filter((frame) => !omitted(frame.shows)).map((frame) => ({ frameId: frame.frameId, captureUs: frame.captureUs, format: frame.format, bytes: new Uint8Array(readFileSync(join(folder, frame.file))), width: frame.width, height: frame.height }))
  const lost = evidence.omit?.as === 'dropped' ? manifest.frames.filter((frame) => omitted(frame.shows)).map((frame): LostFrame => ({ captureUs: frame.captureUs, fate: 'dropped' })) : []
  return { frames, lost, manifest }
}

type One = { ok: true; held: HeldEvidence } | { ok: false; kind: 'missing' | 'refused'; reason: string; record?: HeldEvidence['record'] }

async function gatherOne(id: string, checkId: string, evidence: CaseEvidence, options: CaseEvidenceOptions, room: { bytesLeft: number; framesLeft: number }): Promise<One> {
  const capturedAt = new Date().toISOString()
  const write = (path: string, bytes: Uint8Array): void => {
    mkdirSync(dirname(join(options.folder, path)), { recursive: true })
    writeFileSync(join(options.folder, path), bytes, { flag: 'wx' })
  }
  if (evidence.kind === 'text') {
    const read = readFileSync(join(corpusFolder, evidence.file), 'utf8')
    const text = options.redact(evidence.cut === undefined || read.length <= evidence.cut ? read : `${read.slice(0, evidence.cut)}…`)
    const label = evidence.label === undefined ? undefined : options.redact(evidence.label)
    const record = { id, kind: 'text' as const, testId, attemptId, capturedAt, ...(label === undefined ? {} : { label }), sha256: hash(text), bytes: Buffer.byteLength(text) }
    return { ok: true, held: { judged: { id, kind: 'text', text, ...(label === undefined ? {} : { label }) }, record } }
  }
  if (evidence.kind === 'screenshot') {
    const data = new Uint8Array(readFileSync(join(corpusFolder, evidence.file)))
    const size = pngSize(data)
    if (size === undefined) return { ok: false, kind: 'missing', reason: `${evidence.file} is not a PNG Retest can read.` }
    if (size.width > options.limits.maxImageWidth || size.height > options.limits.maxImageHeight) return { ok: false, kind: 'refused', reason: `${evidence.file} is ${size.width} by ${size.height}, over the image limits.` }
    const path = `artifacts/${checkId}-${id}.png`
    write(path, data)
    const record = { id, kind: 'screenshot' as const, testId, attemptId, app: evidence.app, sessionId: formatSessionId(attemptId, evidence.app), capturedAt, path, sha256: hash(data), bytes: data.byteLength, ...size }
    return { ok: true, held: { judged: { id, kind: 'image', mediaType: 'image/png', data, ...size, app: evidence.app, capturedAt }, record } }
  }
  const store = { elapsedMs: (): number | undefined => undefined, writeArtifact: write }
  const shared = { id, app: evidence.app, redact: options.redact, testId, attemptId, checkId }
  if (evidence.kind === 'diagnostics') {
    const captured = snapshotOf(evidence.file)
    // Stand-ins carry the corpus attempt's identity; capture provenance stays in cases.json and the source artifact.
    const sessionId = formatSessionId(attemptId, evidence.app)
    const snapshot = { ...captured, sessionId, records: captured.records.map((record) => ({ ...record, testId, attemptId, app: evidence.app, sessionId })) }
    const gathered = gatherDiagnostics({ ...shared, store, selector: { kind: 'diagnostics', app: evidence.app, include: evidence.include }, view: { snapshot: () => snapshot }, maxRecords: options.limits.maxDiagnosticRecords })
    return gathered.ok ? { ok: true, held: gathered.value } : { ok: false, kind: gathered.problem.kind, reason: gathered.problem.reason, record: gathered.problem.record }
  }
  const { frames, lost, manifest } = heldFramesOf(evidence)
  const fromUs = Math.max(0, manifest.clickUs + evidence.fromMs * 1000)
  const toUs = manifest.clickUs + evidence.toMs * 1000
  const recording = frameStore({ frames, lost, frameIntervalUs: manifest.frameIntervalUs })
  const clocked = { ...store, elapsedMs: (): number => Math.round(toUs / 1000) }
  const gathered = await gatherFrames({
    ...shared,
    store: clocked,
    selector: { kind: 'recording', app: evidence.app, step: evidence.scene },
    recordings: { recording: () => ({ state: 'recording', store: recording, source: 'chromium' }), step: () => ({ fromUs, toUs }) },
    limits: options.limits,
    framesLeft: room.framesLeft,
    bytesLeft: room.bytesLeft,
    timeoutMs: 10_000,
    stop: new Promise(() => undefined),
  })
  return gathered.ok ? { ok: true, held: gathered.value } : { ok: false, kind: gathered.problem.kind, reason: gathered.problem.reason, record: gathered.problem.record }
}

// What a captured artifact says of each part, and its records, as the attempt's capture would hold them at its end.
function snapshotOf(file: string): DiagnosticsSnapshot {
  const reading = parseArtifact(readFileSync(join(corpusFolder, file), 'utf8'), file)
  if (!reading.ok) throw new Error(reading.problem)
  const records: DiagnosticRecord[] = []
  let ending: { console: DiagnosticsSnapshot['console']; network: DiagnosticsSnapshot['network']; sessionId: string } | undefined
  for (const line of reading.lines) {
    if (line.type === 'capture.started') continue
    if (line.type === 'capture.finished') {
      ending = { console: partOf(line.console), network: partOf(line.network), sessionId: line.sessionId }
      continue
    }
    records.push(line)
  }
  if (ending === undefined) throw new Error(`${file} has no capture.finished line.`)
  return { sessionId: ending.sessionId, console: ending.console, network: ending.network, records }
}

function partOf(capture: { state: 'complete' | 'partial' | 'unavailable' | 'disabled'; reason?: string }): DiagnosticsSnapshot['console'] {
  return capture.reason === undefined ? { state: capture.state } : { state: capture.state, reason: capture.reason }
}

function hash(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}
