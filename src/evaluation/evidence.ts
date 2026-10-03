import type { JudgedEvidence } from './contract.ts'
import type { EvaluationLimits } from './budget.ts'
import type { EvidenceRecord, EvidenceSelector } from '../protocol/evaluation.ts'
import type { AppPage, PagesContext } from '../runner/test-pages.ts'
import { createHash } from 'node:crypto'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage } from '../protocol/failures.ts'
import { slug } from '../protocol/run-folder.ts'
import { bounded } from '../runner/bounded.ts'

/** Evidence the parent holds for one check: what the judge receives, and what the record keeps of it. */
export type HeldEvidence = { judged: JudgedEvidence; record: EvidenceRecord }

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
}

const pngSignature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Gathers a check's evidence in the order named, each with an id the judge cites, `e1`, `e2` and so on. A screenshot
 * is taken now, by the parent, from the app's page in this attempt, saved in the run folder, and must be a PNG within
 * the limits; text is redacted before the judge sees it. Nothing here can act on a page. The first problem stops the
 * gathering, and what was gathered before it is returned with it, so the record still names it.
 *
 * @example const gathered = await gatherEvidence(selectors, options)
 */
export async function gatherEvidence(selectors: readonly EvidenceSelector[], options: GatherOptions): Promise<Gathered> {
  const evidence: HeldEvidence[] = []
  const started = performance.now()
  let bytes = options.textBytes
  let images = 0
  for (const [index, selector] of selectors.entries()) {
    const id = `e${index + 1}`
    const remainingMs = Math.max(1, Math.floor(options.timeoutMs - (performance.now() - started)))
    const held = selector.kind === 'text' ? textEvidence(id, selector, options.context) : await screenshotEvidence(id, selector, { ...options, timeoutMs: remainingMs })
    if (!held.ok) return { ok: false, problem: held.problem, evidence }
    bytes += held.value.record.bytes
    if (held.value.record.kind === 'screenshot') images++
    const limit = limitProblem({ bytes, images, held: held.value.record }, options.limits)
    if (limit !== undefined) return { ok: false, problem: { kind: 'refused', reason: limit }, evidence: [...evidence, held.value] }
    evidence.push(held.value)
  }
  return { ok: true, evidence }
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

type Held = { ok: true; value: HeldEvidence } | { ok: false; problem: EvidenceProblem }

function textEvidence(id: string, selector: Extract<EvidenceSelector, { kind: 'text' }>, context: PagesContext): Held {
  const text = context.redact(selector.text)
  const capturedAt = new Date().toISOString()
  const label = selector.label === undefined ? undefined : context.redact(selector.label)
  const judged: JudgedEvidence = { id, kind: 'text', text, ...(label === undefined ? {} : { label }) }
  const record: EvidenceRecord = { id, kind: 'text', attemptId: context.attemptId, capturedAt, ...(label === undefined ? {} : { label }), sha256: sha256(text), bytes: Buffer.byteLength(text) }
  return { ok: true, value: { judged, record } }
}

// The page is only read. A page that is gone or does not answer leaves the check without its evidence, which says
// nothing about the app.
async function screenshotEvidence(id: string, selector: Extract<EvidenceSelector, { kind: 'screenshot' | 'recording' }>, options: GatherOptions): Promise<Held> {
  const { context, pages, checkId, timeoutMs, stop } = options
  const [first] = pages
  const app = selector.app ?? first?.app
  if (selector.kind === 'recording') return refused(`Evidence from a recorded step needs recordings, which Retest does not make yet. Use { capture: 'screenshot' } or text.`)
  const page = pages.find((each) => each.app === app)
  if (app === undefined || page === undefined) return refused(`The check names the app ${JSON.stringify(app ?? '')}, which this test does not use.`)
  if (!context.connected(page.browser)) return missing(`The browser of ${app} was gone, so Retest captured no screenshot.`)
  const shot = await bounded(page.page.screenshot(timeoutMs), timeoutMs, stop)
  if (shot.status === 'stopped') return missing('The check was stopped while Retest took its screenshot.')
  if (shot.status === 'timed_out') return missing(`Taking the screenshot of ${app} took longer than ${timeoutMs} ms.`)
  if (shot.status === 'failed') return missing(`Retest could not take a screenshot of ${app}: ${context.redact(errorMessage(shot.error))}`)
  const capturedAt = new Date().toISOString()
  const data = shot.value
  const size = pngSize(data)
  if (size === undefined) return missing(`The screenshot of ${app} is not a PNG Retest can read, so Retest did not send it.`)
  const path = evaluationScreenshotFile(context.testId, context.attemptId, app, checkId)
  try {
    context.store.writeArtifact(path, data)
  } catch (error) {
    return refused(`Retest could not save the screenshot of ${app}, so it did not send it: ${errorMessage(error)}`)
  }
  const sessionId = formatSessionId(context.attemptId, app)
  const judged: JudgedEvidence = { id, kind: 'image', mediaType: 'image/png', data, width: size.width, height: size.height, app, capturedAt }
  const record: EvidenceRecord = { id, kind: 'screenshot', app, sessionId, attemptId: context.attemptId, capturedAt, path, sha256: sha256(data), bytes: data.byteLength, ...size }
  return { ok: true, value: { judged, record } }
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
