import type { CriterionKind, CriterionRule, CriterionVerdict, EvaluationVerdict } from '../../../src/protocol/evaluation.ts'
import type { CaseCategory, CorpusCase } from './cases.ts'

// The arithmetic of a corpus run, apart from any judge: false passes, false failures, undecided and error rates, repeat
// agreement, latency and usage, and the two gates of the evaluation contract. A known critical failure never passes;
// on unambiguous cases labelled pass or fail, at least 90% of the judgments are correct and conclusive. An
// inconclusive or error judgment never counts as correct there. The gates hold on this corpus only; they make no claim
// about how a judge does on anything else.

/**
 * One judgment of one case in one repeat, as the parent ended the check. `asked` is false when the judge was not asked:
 * the evidence or a judge that could not be set up decided the check. `rule` names the parent's rule
 * that decided or capped it; `judgeCriteria` what the judge itself answered for each criterion it was asked.
 */
export type Judgment = {
  caseId: string
  repeat: number
  verdict: EvaluationVerdict
  asked: boolean
  latencyMs?: number
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  reason?: string
  model?: string
  rule?: 'evidence' | CriterionRule
  judgeCriteria?: Record<string, CriterionVerdict>
  justification?: string
}

export type Counts = {
  judgments: number
  correct: number
  falsePasses: number
  falseFailures: number
  inconclusive: number
  errors: number
}

export type Summary = {
  cases: number
  repeats: number
  overall: Counts & { inconclusiveRate: number; errorRate: number }
  byCategory: Record<CaseCategory, Counts>
  /** Check counts by each declared kind present. A mixed-kind check counts once under each of its kinds. */
  byCriterionKind: Record<CriterionKind, Counts>
  /** Cases whose repeats did not all end the same, and the share of cases whose repeats all agreed. */
  disagreements: { caseId: string; verdicts: EvaluationVerdict[] }[]
  repeatAgreement: number
  falsePassCases: string[]
  falseFailureCases: string[]
  latency: { calls: number; medianMs?: number; p95Ms?: number; maxMs?: number }
  usage: { judgmentsWithUsage: number; inputTokens: number; outputTokens: number; totalTokens: number }
  models: string[]
  gates: Gates
  labelsAwaitingReview: number
}

export type Gates = {
  criticalNeverPasses: { met: boolean; criticalCases: number; passedCases: string[] }
  unambiguousCorrect: { met: boolean; correct: number; total: number; rate: number; threshold: 0.9 }
  /** Both gates met. While any label awaits the founder's review, a met gate is provisional. */
  met: boolean
  provisional: boolean
}

const threshold = 0.9

/**
 * Scores every judgment against its case's label, and applies the gates.
 *
 * @example const summary = summarize(corpus.cases, judgments, 3)
 */
export function summarize(cases: readonly CorpusCase[], judgments: readonly Judgment[], repeats: number): Summary {
  validateJudgments(cases, judgments, repeats)
  const byId = new Map(cases.map((each) => [each.id, each]))
  const overall = emptyCounts()
  const byCategory: Record<CaseCategory, Counts> = { text: emptyCounts(), screenshot: emptyCounts(), frames: emptyCounts() }
  const byCriterionKind: Record<CriterionKind, Counts> = { state: emptyCounts(), seen: emptyCounts(), never: emptyCounts() }
  const falsePassCases = new Set<string>()
  const falseFailureCases = new Set<string>()
  for (const judgment of judgments) {
    const labelled = byId.get(judgment.caseId)
    if (labelled === undefined) throw new Error(`A judgment names the case ${judgment.caseId}, which the corpus does not have.`)
    const kinds = [...new Set(Object.values(labelled.requirement).map((criterion) => criterion.kind))]
    for (const counts of [overall, byCategory[labelled.category], ...kinds.map((kind) => byCriterionKind[kind])]) add(counts, judgment.verdict, labelled.label.verdict)
    if (judgment.verdict === 'pass' && labelled.label.verdict !== 'pass') falsePassCases.add(labelled.id)
    if (judgment.verdict === 'fail' && labelled.label.verdict !== 'fail') falseFailureCases.add(labelled.id)
  }
  const disagreements = cases.flatMap((each) => {
    const verdicts = judgments.filter((judgment) => judgment.caseId === each.id).sort((first, second) => first.repeat - second.repeat).map((judgment) => judgment.verdict)
    return new Set(verdicts).size > 1 ? [{ caseId: each.id, verdicts }] : []
  })
  const latencies = judgments.flatMap((judgment) => (judgment.asked && judgment.latencyMs !== undefined ? [judgment.latencyMs] : [])).sort((first, second) => first - second)
  const withUsage = judgments.filter((judgment) => judgment.usage !== undefined)
  const total = (key: 'inputTokens' | 'outputTokens' | 'totalTokens'): number => withUsage.reduce((sum, judgment) => sum + (judgment.usage?.[key] ?? 0), 0)
  const summary: Omit<Summary, 'gates'> = {
    cases: cases.length,
    repeats,
    overall: { ...overall, inconclusiveRate: rate(overall.inconclusive, overall.judgments), errorRate: rate(overall.errors, overall.judgments) },
    byCategory,
    byCriterionKind,
    disagreements,
    repeatAgreement: rate(cases.length - disagreements.length, cases.length),
    falsePassCases: [...falsePassCases],
    falseFailureCases: [...falseFailureCases],
    latency: { calls: latencies.length, ...(latencies.length === 0 ? {} : { medianMs: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95), maxMs: percentile(latencies, 1) }) },
    usage: { judgmentsWithUsage: withUsage.length, inputTokens: total('inputTokens'), outputTokens: total('outputTokens'), totalTokens: total('totalTokens') },
    models: [...new Set(judgments.flatMap((judgment) => (judgment.model === undefined ? [] : [judgment.model])))],
    labelsAwaitingReview: cases.filter((each) => each.label.review === 'awaiting-founder').length,
  }
  return { ...summary, gates: applyGates(cases, judgments, summary.labelsAwaitingReview, repeats) }
}

/**
 * The evaluation contract's gates on a corpus run.
 *
 * @example applyGates(cases, judgments, 0, 3).met
 */
export function applyGates(cases: readonly CorpusCase[], judgments: readonly Judgment[], awaiting: number, repeats: number): Gates {
  validateJudgments(cases, judgments, repeats)
  const critical = cases.filter((each) => each.label.critical)
  const passedCases = critical.filter((each) => judgments.some((judgment) => judgment.caseId === each.id && judgment.verdict === 'pass')).map((each) => each.id)
  const counted = new Set(cases.filter((each) => each.label.unambiguous && each.label.verdict !== 'inconclusive').map((each) => each.id))
  const scored = judgments.filter((judgment) => counted.has(judgment.caseId))
  const labels = new Map(cases.map((each) => [each.id, each.label.verdict]))
  const correct = scored.filter((judgment) => judgment.verdict === labels.get(judgment.caseId)).length
  const correctRate = rate(correct, scored.length)
  const criticalNeverPasses = { met: passedCases.length === 0, criticalCases: critical.length, passedCases }
  const unambiguousCorrect: Gates['unambiguousCorrect'] = { met: scored.length > 0 && correctRate >= threshold, correct, total: scored.length, rate: correctRate, threshold }
  const met = criticalNeverPasses.met && unambiguousCorrect.met
  return { criticalNeverPasses, unambiguousCorrect, met, provisional: met && awaiting > 0 }
}

function validateJudgments(cases: readonly CorpusCase[], judgments: readonly Judgment[], repeats: number): void {
  if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('The repeat count must be a positive whole number.')
  const ids = new Set<string>()
  for (const each of cases) {
    if (ids.has(each.id)) throw new Error(`The corpus has the case ${each.id} twice.`)
    ids.add(each.id)
  }
  const seen = new Map<string, Set<number>>()
  for (const judgment of judgments) {
    if (!ids.has(judgment.caseId)) throw new Error(`A judgment names the case ${judgment.caseId}, which the corpus does not have.`)
    if (!Number.isSafeInteger(judgment.repeat) || judgment.repeat < 1 || judgment.repeat > repeats) throw new Error(`The judgment for ${judgment.caseId} has an invalid repeat ${judgment.repeat}.`)
    const done = seen.get(judgment.caseId) ?? new Set<number>()
    if (done.has(judgment.repeat)) throw new Error(`The corpus has a judgment for ${judgment.caseId} in repeat ${judgment.repeat} twice.`)
    done.add(judgment.repeat)
    seen.set(judgment.caseId, done)
  }
  for (const each of cases) for (let repeat = 1; repeat <= repeats; repeat++) {
    if (!seen.get(each.id)?.has(repeat)) throw new Error(`The corpus has a missing judgment for ${each.id} in repeat ${repeat}.`)
  }
}

/**
 * A summary as plain lines for a terminal.
 *
 * @example console.log(describeSummary(summary, 'azure').join('\n'))
 */
export function describeSummary(summary: Summary, judge: string): string[] {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`
  const { overall, gates } = summary
  const category = (name: CaseCategory): string => {
    const counts = summary.byCategory[name]
    return `  ${name.padEnd(10)} ${counts.judgments} judgments, ${counts.correct} correct, ${counts.falsePasses} false passes, ${counts.falseFailures} false failures, ${counts.inconclusive} inconclusive, ${counts.errors} errors`
  }
  return [
    `Evaluation corpus: ${summary.cases} cases, ${summary.repeats} repeats, judge ${judge}${summary.models.length === 0 ? '' : ` (${summary.models.join(', ')})`}`,
    `  judgments  ${overall.judgments}, ${overall.correct} correct, ${overall.falsePasses} false passes, ${overall.falseFailures} false failures, inconclusive ${percent(overall.inconclusiveRate)}, errors ${percent(overall.errorRate)}`,
    category('text'),
    category('screenshot'),
    category('frames'),
    `  repeats    ${percent(summary.repeatAgreement)} of cases agreed across every repeat${summary.disagreements.length === 0 ? '' : `; not: ${summary.disagreements.map((each) => each.caseId).join(', ')}`}`,
    `  latency    ${summary.latency.calls} calls${summary.latency.medianMs === undefined ? '' : `, median ${summary.latency.medianMs} ms, p95 ${summary.latency.p95Ms} ms, max ${summary.latency.maxMs} ms`}`,
    `  usage      ${summary.usage.judgmentsWithUsage} judgments counted tokens: ${summary.usage.inputTokens} in, ${summary.usage.outputTokens} out, ${summary.usage.totalTokens} total`,
    `  gate       known critical failures never pass: ${gates.criticalNeverPasses.met ? 'met' : `not met, passed: ${gates.criticalNeverPasses.passedCases.join(', ')}`} (${gates.criticalNeverPasses.criticalCases} critical cases)`,
    `  gate       correct conclusive judgments on unambiguous cases: ${gates.unambiguousCorrect.correct} of ${gates.unambiguousCorrect.total}, ${percent(gates.unambiguousCorrect.rate)}, needs 90%: ${gates.unambiguousCorrect.met ? 'met' : 'not met'}`,
    `  result     ${gates.met ? (gates.provisional ? `gates met, provisional: ${summary.labelsAwaitingReview} labels await the founder's review` : 'gates met') : 'gates not met'}`,
  ]
}

function emptyCounts(): Counts {
  return { judgments: 0, correct: 0, falsePasses: 0, falseFailures: 0, inconclusive: 0, errors: 0 }
}

function add(counts: Counts, verdict: EvaluationVerdict, label: 'pass' | 'fail' | 'inconclusive'): void {
  counts.judgments++
  if (verdict === label) counts.correct++
  if (verdict === 'pass' && label !== 'pass') counts.falsePasses++
  if (verdict === 'fail' && label !== 'fail') counts.falseFailures++
  if (verdict === 'inconclusive') counts.inconclusive++
  if (verdict === 'error' || verdict === 'cancelled' || verdict === 'not_run') counts.errors++
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole
}

// The nearest-rank percentile of sorted values.
function percentile(sorted: readonly number[], share: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1))
  return sorted[index] ?? 0
}
