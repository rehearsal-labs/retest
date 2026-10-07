import type { Criterion, CriterionRule, CriterionVerdict } from '../protocol/evaluation.ts'
import { withCriterionRequirement } from '../protocol/evaluation.ts'
import type { CheckedAnswer } from './answer.ts'
import type { EvaluationRequest, EvaluationSignal, JudgedEvidence, JudgedFrames } from './contract.ts'
import type { HeldEvidence } from './evidence.ts'
import { aggregateVerdict } from './answer.ts'
import { instructionsFor } from './instructions.ts'

// What every check sends and how its answer becomes a verdict, shared by a run's checks and the evaluation corpus, so the
// corpus measures a judge on exactly the request a run would send.

export type RequestParts = {
  requestId: string
  judge: string
  asked: readonly Criterion[]
  context: string | undefined
  evidence: readonly HeldEvidence[]
  redact: (text: string) => string
  maxOutputTokens: number
  timeoutMs: number
  signal: EvaluationSignal
}

/**
 * The request a judge receives, frozen: the instructions for what it holds, the asked criteria and the context
 * redacted, copies of the evidence's bytes, and the frame sequences apart from the other evidence.
 *
 * @example buildRequest({ requestId: 'a:evaluation-1', judge: 'visual', asked, context: undefined, evidence, redact, maxOutputTokens: 1000, timeoutMs: 30000, signal })
 */
export function buildRequest(parts: RequestParts): EvaluationRequest {
  const { evidence, redact } = parts
  const pieces = evidence.flatMap((held) => ('judged' in held ? [pieceCopy(held.judged)] : []))
  const sequences = evidence.flatMap((held) => ('frames' in held ? [framesCopy(held.frames)] : []))
  const rules = instructionsFor({ frames: sequences.length > 0, diagnostics: evidence.some((held) => held.record.kind === 'diagnostics') })
  return deepFreeze({
    requestId: parts.requestId,
    judge: parts.judge,
    instructions: rules.instructions,
    promptVersion: rules.promptVersion,
    criteria: parts.asked.map((criterion) => withCriterionRequirement(criterion, redact(criterion.requirement))),
    ...(parts.context === undefined ? {} : { context: redact(parts.context) }),
    evidence: pieces,
    ...(sequences.length === 0 ? {} : { frames: sequences }),
    maxOutputTokens: parts.maxOutputTokens,
    timeoutMs: parts.timeoutMs,
    signal: parts.signal,
  })
}

/**
 * Every id a judge may cite: each piece of evidence, each frame sequence and each of its frames.
 *
 * @example citable(request) // ['e1', 'e2', 'e2-f1', 'e2-f2']
 */
export function citable(request: EvaluationRequest): string[] {
  return [...request.evidence.map((item) => item.id), ...(request.frames ?? []).flatMap((sequence) => [sequence.id, ...sequence.frames.map((frame) => frame.id)])]
}

/** The effective verdict and the parent's rule for each criterion, preserving the judge's original answer separately. */
export type Settled = {
  verdicts: ReadonlyMap<string, CriterionVerdict>
  rules: ReadonlyMap<string, CriterionRule>
  verdict: CriterionVerdict
  reason?: string
}

/**
 * Settle from the declared kind and capture facts, never the judge's justification. Partial frames cannot support a
 * pass. A seen requirement never fails; a never requirement fails only with a frame actually sent as its witness.
 * The older absence marker retains its conservative sample rule, even over complete captures.
 */
export function settle(answer: CheckedAnswer, criteria: readonly Criterion[], evidence: readonly HeldEvidence[]): Settled {
  const sequences = evidence.flatMap((held) => ('frames' in held ? [held] : []))
  const incomplete = sequences.filter((held) => !held.frames.complete || held.record.status !== 'complete')
  const missing = evidence.filter((held) => held.record.kind === 'frames' && !('frames' in held))
  const frameIds = new Set(sequences.flatMap((held) => held.frames.frames.map((frame) => frame.id)))
  const hasFrames = sequences.length > 0 || missing.length > 0
  const partial = incomplete.length > 0 || missing.length > 0
  const declared = new Map(criteria.map((criterion) => [criterion.id, criterion]))
  const verdicts = new Map<string, CriterionVerdict>()
  const rules = new Map<string, CriterionRule>()
  const reasons: string[] = []
  for (const judged of answer.criteria) {
    const criterion = declared.get(judged.id)
    if (criterion === undefined) throw new Error(`No declared criterion for ${judged.id}.`)
    const witness = judged.citations.some((id) => frameIds.has(id))
    let rule: CriterionRule | undefined
    let reason: string | undefined
    if (hasFrames) {
      if (criterion.absence === true) {
        if ((judged.verdict === 'fail' && !witness) || (!partial && judged.verdict !== 'fail')) {
          rule = 'absence_over_frames'
          reason = absenceReason([judged.id])
        } else if (partial && judged.verdict === 'pass') rule = 'frames_incomplete'
      } else if (criterion.kind === 'seen') {
        if (judged.verdict !== 'pass' || !witness) {
          rule = 'seen_over_frames'
          reason = `The seen criterion ${JSON.stringify(judged.id)} needs a seen frame showing the required appearance. Without one it is inconclusive, never fail; a different appearance does not rule it out between frames.`
        } else if (partial) rule = 'frames_incomplete'
      } else if (criterion.kind === 'never') {
        if (judged.verdict === 'fail' && !witness) {
          rule = 'never_over_frames'
          reason = `The never criterion ${JSON.stringify(judged.id)} can fail only with a citation to a seen frame showing the forbidden appearance.`
        } else if (partial && judged.verdict === 'pass') rule = 'frames_incomplete'
      } else if (partial && judged.verdict !== 'inconclusive') rule = 'frames_incomplete'
    }
    // No usable frame is inconclusive regardless of a supplied answer. Production gathering prevents dispatch here.
    if (hasFrames && frameIds.size === 0) rule = 'frames_incomplete'
    if (rule === 'frames_incomplete') reason = judged.verdict === 'pass' && missing.length === 0 ? incompleteReason([judged.id], incomplete) : `Frames are missing for ${JSON.stringify(judged.id)}, so Retest leaves the judgment undecided. ${[...incomplete, ...missing].map((held) => `${held.record.id}: ${held.record.reason ?? 'frames are missing'}`).join(' ')}`
    verdicts.set(judged.id, rule === undefined ? judged.verdict : 'inconclusive')
    if (rule !== undefined) rules.set(judged.id, rule)
    if (reason !== undefined) reasons.push(reason)
  }
  const verdict = aggregateVerdict([...verdicts.values()])
  return { verdicts, rules, verdict, ...(verdict !== 'inconclusive' || reasons.length === 0 ? {} : { reason: reasons.join(' ') }) }
}

/**
 * Why the parent left criteria the judge passed undecided: the sequences with frames missing, and what each lacks.
 *
 * @example incompleteReason(['shown'], evidence)
 */
export function incompleteReason(capped: readonly string[], incomplete: readonly HeldEvidence[]): string {
  const named = capped.map((id) => JSON.stringify(id)).join(', ')
  const sequences = incomplete.map((held) => `${held.record.id}: ${held.record.reason ?? 'frames are missing'}`).join(' ')
  return `The judge passed ${named}, but it did not see every frame of the interval, so Retest leaves ${capped.length === 1 ? 'it' : 'them'} undecided. ${sequences}`
}

/**
 * Why the parent left criteria undecided by the absence rule.
 *
 * @example absenceReason(['calm'])
 */
export function absenceReason(ruled: readonly string[]): string {
  const named = ruled.map((id) => JSON.stringify(id)).join(', ')
  return `Frames of a recording are samples and cannot prove an absence. A failure of an absence criterion must cite a seen frame showing the forbidden content. Retest leaves ${named} undecided. Prove an absence with an assertion or a recorded event instead.`
}

// A typed array cannot be frozen, so the judge gets a copy of each image's bytes: the ones hashed and saved stay as
// they were.
function pieceCopy(judged: JudgedEvidence): JudgedEvidence {
  return judged.kind === 'image' ? { ...judged, data: judged.data.slice() } : judged
}

function framesCopy(sequence: JudgedFrames): JudgedFrames {
  return { ...sequence, frames: sequence.frames.map((frame) => ({ ...frame, data: frame.data.slice() })), stretches: sequence.stretches.map((stretch) => ({ ...stretch })) }
}

// The request is data the judge reads, so nothing in it can be changed on the way: not the criteria, not the evidence
// list.
function deepFreeze<T extends object>(value: T): T {
  for (const item of Object.values(value)) {
    if (typeof item === 'object' && item !== null && !ArrayBuffer.isView(item) && !(item instanceof AbortSignal) && !Object.isFrozen(item)) deepFreeze(item)
  }
  return Object.freeze(value)
}
