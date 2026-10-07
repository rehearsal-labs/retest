import type { JudgedEvidence, JudgedFrames } from './contract.ts'
import type { EvaluationLimits } from './budget.ts'
import type { AttemptDiagnosticsView } from './diagnostics-evidence.ts'
import type { AttemptRecordings } from './frames.ts'
import type { EvidenceRecord, EvidenceSelector } from '../protocol/evaluation.ts'
import type { AppPage, PagesContext } from '../runner/test-pages.ts'
import type { NativeCapture } from '../native/session.ts'
import type { CaptureSourceName, RecordIdentity } from '../protocol/identity.ts'
import type { CaptureSpan } from '../media/policy.ts'
import { createHash } from 'node:crypto'
import { NativePageAdapter } from '../runner/native-pool.ts'
import { decodePng } from '../native/png.ts'
import { defaultEvaluationLimits } from './budget.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage } from '../protocol/failures.ts'
import { slug } from '../protocol/run-folder.ts'
import { bounded } from '../runner/bounded.ts'
import { screenshotSource } from '../runner/test-pages.ts'
import { gatherDiagnostics } from './diagnostics-evidence.ts'
import { gatherFrames } from './frames.ts'

/**
 * Evidence the parent holds for one check: what the judge receives, as a piece of evidence or as a frame sequence,
 * and what the record keeps of it; or, for evidence that could not be gathered, only what the record keeps.
 */
export type HeldEvidence = HeldPiece | { frames: JudgedFrames; record: EvidenceRecord } | { record: EvidenceRecord }

/** A piece of evidence the judge receives as text or as an image, with what the record keeps of it. */
export type HeldPiece = { judged: JudgedEvidence; record: EvidenceRecord }

/**
 * Why evidence could not be gathered. `missing` is a capture that did not happen or cannot be read, which leaves the
 * check inconclusive; `refused` is evidence Retest will not send, which makes the check an error.
 */
export type EvidenceProblem = { kind: 'missing' | 'refused'; reason: string }

export type Gathered = { ok: true; evidence: HeldEvidence[] } | { ok: false; problem: EvidenceProblem; evidence: HeldEvidence[] }

export type GatherOptions = {
  context: PagesContext
  pages: readonly AppPage[]
  checkId: string
  limits: EvaluationLimits
  /** How long the captures may take together. */
  timeoutMs: number
  /** Settles when the check is stopped. */
  stop: Promise<unknown>
  /** Bytes the criteria and context take, which count towards `maxInputBytes`. */
  textBytes: number
  /** The attempt's recordings, which frame evidence is taken from; absent in a run that records nothing. */
  recordings?: AttemptRecordings | undefined
  /** What the attempt's diagnostics have kept so far; absent in a run that gives the checks none. */
  diagnostics?: AttemptDiagnosticsView | undefined
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Gathers a check's evidence in the order named, each with an id the judge cites, `e1`, `e2` and so on. A screenshot
 * is taken now, by the parent, from the app's page in this attempt, saved in the run folder, and must be a PNG within
 * the limits; text is redacted before the judge sees it; a recording's frames come from the app's recording over the
 * interval named, saved and hashed, with the stretches that had no frame; diagnostics records are those the check
 * selected, redacted again and bounded. Nothing here can act on a page. The first problem stops the gathering, and what
 * was gathered before it is returned with it, with the unavailable evidence that stopped it, so the record still names
 * it.
 *
 * @example const gathered = await gatherEvidence(selectors, options)
 */
export async function gatherEvidence(selectors: readonly EvidenceSelector[], options: GatherOptions): Promise<Gathered> {
  const evidence: HeldEvidence[] = []
  const started = performance.now()
  let bytes = options.textBytes
  let images = 0
  let frames = 0
  for (const [index, selector] of selectors.entries()) {
    const id = `e${index + 1}`
    const remainingMs = Math.max(1, Math.floor(options.timeoutMs - (performance.now() - started)))
    const held = await gatherOne(id, selector, { ...options, timeoutMs: remainingMs }, { bytesLeft: options.limits.maxInputBytes - bytes, framesLeft: options.limits.maxFrames - frames })
    if (!held.ok) return { ok: false, problem: held.problem, evidence: held.record === undefined ? evidence : [...evidence, { record: held.record }] }
    bytes += held.value.record.bytes
    if (held.value.record.kind === 'screenshot') images++
    frames += held.value.record.frames?.length ?? 0
    const limit = limitProblem({ bytes, images, held: held.value.record }, options.limits)
    if (limit !== undefined) return { ok: false, problem: { kind: 'refused', reason: limit }, evidence: [...evidence, held.value] }
    evidence.push(held.value)
  }
  return { ok: true, evidence }
}

type GatheredOne = { ok: true; value: HeldEvidence } | { ok: false; problem: EvidenceProblem; record?: EvidenceRecord }

async function gatherOne(id: string, selector: EvidenceSelector, options: GatherOptions, room: { bytesLeft: number; framesLeft: number }): Promise<GatheredOne> {
  const { context, pages } = options
  if (selector.kind === 'text') return textEvidence(id, selector, context)
  if (selector.kind === 'screenshot') return screenshotEvidence(id, selector, options)
  const app = selector.app ?? pages[0]?.app
  if (app === undefined || !pages.some((page) => page.app === app)) return refused(`The check names the app ${JSON.stringify(app ?? '')}, which this test does not use.`)
  const shared = { id, app, store: context.store, redact: context.redact, testId: context.testId, attemptId: context.attemptId, checkId: options.checkId }
  if (selector.kind === 'diagnostics') {
    const gathered = gatherDiagnostics({ ...shared, selector, view: options.diagnostics, maxRecords: options.limits.maxDiagnosticRecords })
    return gathered.ok ? { ok: true, value: gathered.value } : { ok: false, problem: { kind: gathered.problem.kind, reason: gathered.problem.reason }, record: gathered.problem.record }
  }
  const gathered = await gatherFrames({ ...shared, selector, recordings: options.recordings, limits: options.limits, framesLeft: room.framesLeft, bytesLeft: room.bytesLeft, timeoutMs: options.timeoutMs, stop: options.stop })
  return gathered.ok ? { ok: true, value: gathered.value } : { ok: false, problem: { kind: gathered.problem.kind, reason: gathered.problem.reason }, record: gathered.problem.record }
}

/**
 * The SHA-256 of bytes or of text as UTF-8, in hex.
 *
 * @example sha256('Saved') // '...'
 */
export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * A PNG's width and height from its header, or undefined when the bytes are not a PNG whose header can be read.
 *
 * @example pngSize(screenshot) // { width: 1280, height: 720 }
 */
export function pngSize(data: Uint8Array): { width: number; height: number } | undefined {
  if (data.length < 24 || !pngSignature.every((byte, index) => data[index] === byte)) return undefined
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (String.fromCharCode(...data.subarray(12, 16)) !== 'IHDR') return undefined
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  return width > 0 && height > 0 ? { width, height } : undefined
}

/**
 * Where a check's screenshot of an app goes in the run folder.
 *
 * @example evaluationScreenshotFile('a.retest.ts > saves', 'k3v9q0x2mb', 'web', 'evaluation-1') // 'artifacts/a-retest-ts-saves-<hash>-k3v9q0x2mb-web-<hash>-evaluation-1-<hash>.png'
 */
export function evaluationScreenshotFile(testId: string, attemptId: string, app: string, checkId: string): string {
  return `artifacts/${slug(testId, 40)}-${slug(attemptId, 24)}-${slug(app, 24)}-${slug(checkId, 32)}.png`
}

type Held = { ok: true; value: HeldPiece } | { ok: false; problem: EvidenceProblem }

function textEvidence(id: string, selector: Extract<EvidenceSelector, { kind: 'text' }>, context: PagesContext): Held {
  const text = context.redact(selector.text)
  const capturedAt = new Date().toISOString()
  const label = selector.label === undefined ? undefined : context.redact(selector.label)
  const judged: JudgedEvidence = { id, kind: 'text', text, ...(label === undefined ? {} : { label }) }
  const clock = capturedClock(context)
  const record: EvidenceRecord = { id, kind: 'text', testId: context.testId, attemptId: context.attemptId, capturedAt, ...clock, ...(label === undefined ? {} : { label }), sha256: sha256(text), bytes: Buffer.byteLength(text) }
  return { ok: true, value: { judged, record } }
}

// The page is only read. A page that is gone or does not answer leaves the check without its evidence, which says
// nothing about the app.
async function screenshotEvidence(id: string, selector: Extract<EvidenceSelector, { kind: 'screenshot' }>, options: GatherOptions): Promise<Held> {
  const { context, pages, checkId, timeoutMs, stop } = options
  const [first] = pages
  const app = selector.app ?? first?.app
  const page = pages.find((each) => each.app === app)
  if (app === undefined || page === undefined) return refused(`The check names the app ${JSON.stringify(app ?? '')}, which this test does not use.`)
  if (!context.connected(page.browser)) return missing(`The browser of ${app} was gone, so Retest captured no screenshot.`)
  const identity = { testId: context.testId, attemptId: context.attemptId, app, sessionId: page.session.sessionId }
  const source = screenshotSource(page.session.runtime)
  const askedUs = context.pixels?.clock()
  const before = pixelRefusal(context, identity, source)
  if (before !== undefined) return refused(before)
  const afterCapture = (capturedSource: CaptureSourceName | undefined): string | undefined => {
    if (askedUs === undefined) return undefined
    return pixelRefusal(context, identity, capturedSource, { earliestUs: askedUs, arrivedUs: context.pixels?.clock() ?? askedUs })
  }
  if (page.page instanceof NativePageAdapter) {
    if (page.session.owner.testId !== context.testId || page.session.owner.attemptId !== context.attemptId || page.session.owner.app !== app) return refused('The native page belongs to another test, attempt or app.')
    const capture = await bounded(page.page.capture(timeoutMs), timeoutMs, stop)
    if (capture.status === 'stopped') return missing('The check was stopped while Retest took its native screenshot.')
    if (capture.status === 'timed_out') return missing(`Taking the native screenshot of ${app} took longer than ${timeoutMs} ms.`)
    if (capture.status === 'failed') return missing(`Retest could not take a native screenshot of ${app}: ${context.redact(errorMessage(capture.error))}`)
    if (!capture.value.ok) return missing(context.redact(capture.value.failure.message))
    const after = afterCapture(capture.value.capture.source)
    if (after !== undefined) return refused(after)
    const held = freezeNativeScreenshot(id, capture.value.capture, identity, context, checkId, options.limits)
    return held
  }
  const shot = await bounded(page.page.screenshot(timeoutMs), timeoutMs, stop)
  if (shot.status === 'stopped') return missing('The check was stopped while Retest took its screenshot.')
  if (shot.status === 'timed_out') return missing(`Taking the screenshot of ${app} took longer than ${timeoutMs} ms.`)
  if (shot.status === 'failed') return missing(`Retest could not take a screenshot of ${app}: ${context.redact(errorMessage(shot.error))}`)
  const after = afterCapture(source)
  if (after !== undefined) return refused(after)
  const capturedAt = new Date().toISOString()
  const clock = capturedClock(context)
  const data = Uint8Array.from(shot.value)
  const size = pngSize(data)
  if (size === undefined) return missing(`The screenshot of ${app} is not a PNG Retest can read, so Retest did not send it.`)
  const path = evaluationScreenshotFile(context.testId, context.attemptId, app, checkId)
  try {
    context.store.writeArtifact(path, data)
  } catch (error) {
    return refused(`Retest could not save the screenshot of ${app}, so it did not send it: ${errorMessage(error)}`)
  }
  const judged: JudgedEvidence = { id, kind: 'image', mediaType: 'image/png', data, width: size.width, height: size.height, app, capturedAt }
  const captured = { capturedAt, ...clock, ...(source === undefined ? {} : { source }) }
  const record: EvidenceRecord = { id, kind: 'screenshot', ...identity, ...captured, path, sha256: sha256(data), bytes: data.byteLength, ...size }
  return { ok: true, value: { judged, record } }
}

// Text redaction cannot make pixels safe. A capture can overlap a withheld stretch even when it was allowed before
// the request, so the policy sees both the request and the whole capture span before any bytes are saved or sent.
function pixelRefusal(context: PagesContext, identity: RecordIdentity, source: CaptureSourceName | undefined, span?: CaptureSpan): string | undefined {
  const { pixels } = context
  if (pixels === undefined) return undefined
  if (source === undefined) return `Retest does not know what takes a screenshot of ${identity.app}, so its capture policy withheld it.`
  const decision = pixels.decide({ identity, use: 'evaluation', source, ...(span === undefined ? {} : { span }) })
  return decision.capture ? undefined : context.redact(decision.message)
}

/** Freeze a parent-owned native capture as pixels. Text redaction does not alter PNGs. */
export function freezeNativeScreenshot(id: string, capture: NativeCapture, identity: RecordIdentity, context: Pick<PagesContext, 'store' | 'testId' | 'attemptId' | 'redact'>, checkId: string, limits: EvaluationLimits = defaultEvaluationLimits): Held {
  if (identity.testId !== context.testId || identity.attemptId !== context.attemptId || capture.reference.sessionId !== identity.sessionId || identity.sessionId !== formatSessionId(identity.attemptId, identity.app)) return refused('The native capture belongs to another test, attempt, app or session.')
  const capturedElapsedMs = context.store.elapsedMs()
  const data = Uint8Array.from(capture.png)
  const size = pngSize(data)
  if (size === undefined || size.width !== capture.width || size.height !== capture.height) return missing('The native screenshot has no matching PNG dimensions.')
  if (size.width > limits.maxImageWidth || size.height > limits.maxImageHeight || data.byteLength > limits.maxInputBytes) return refused('The native screenshot exceeds the evaluation image or input limits.')
  try { decodePng(data) } catch { return missing('The native screenshot has no readable PNG pixels.') }
  if (!Number.isFinite(Date.parse(capture.capturedAt))) return missing('The native capture has no valid capture time.')
  const path = evaluationScreenshotFile(identity.testId, identity.attemptId, identity.app, checkId)
  if (capturedElapsedMs === undefined) return refused('The native capture has no run clock.')
  try { context.store.writeArtifact(path, data) } catch (error) { return refused(`Retest could not save the native screenshot: ${context.redact(errorMessage(error))}`) }
  const judged: JudgedEvidence = Object.freeze({ id, kind: 'image', mediaType: 'image/png', data, ...size, app: identity.app, capturedAt: capture.capturedAt })
  const { instance, generation, observationId } = capture.reference
  const captureReference = Object.freeze({ instance, generation, observationId })
  const record: EvidenceRecord = Object.freeze({ id, kind: 'screenshot', testId: identity.testId, attemptId: identity.attemptId, app: identity.app, sessionId: identity.sessionId, capturedAt: capture.capturedAt, capturedElapsedMs, source: capture.source, captureReference, path, sha256: sha256(data), bytes: data.byteLength, ...size })
  return { ok: true, value: Object.freeze({ judged, record }) }
}

// When evidence was taken on the run's clock, when the run has written an event to set it by.
function capturedClock(context: PagesContext): { capturedElapsedMs?: number } {
  const capturedElapsedMs = context.store.elapsedMs()
  return capturedElapsedMs === undefined ? {} : { capturedElapsedMs }
}

function limitProblem({ bytes, images, held }: { bytes: number; images: number; held: EvidenceRecord }, limits: EvaluationLimits): string | undefined {
  if (held.kind === 'screenshot' && images > limits.maxImages) return `The check sends ${images} screenshots, over evaluation.limits.maxImages of ${limits.maxImages}.`
  if (held.width !== undefined && held.width > limits.maxImageWidth) return `The screenshot of ${held.app ?? ''} is ${held.width} pixels wide, over evaluation.limits.maxImageWidth of ${limits.maxImageWidth}.`
  if (held.height !== undefined && held.height > limits.maxImageHeight) return `The screenshot of ${held.app ?? ''} is ${held.height} pixels tall, over evaluation.limits.maxImageHeight of ${limits.maxImageHeight}.`
  if (bytes > limits.maxInputBytes) return `The check's input is ${bytes} bytes, over evaluation.limits.maxInputBytes of ${limits.maxInputBytes}.`
  return undefined
}

function missing(reason: string): Held {
  return { ok: false, problem: { kind: 'missing', reason } }
}

function refused(reason: string): Held {
  return { ok: false, problem: { kind: 'refused', reason } }
}
