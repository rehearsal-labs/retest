import type { EvaluationLimits } from '../../../src/evaluation/budget.ts'
import type { Judges } from '../../../src/evaluation/judges.ts'
import type { Criterion, CriterionVerdict, EvaluationVerdict } from '../../../src/protocol/evaluation.ts'
import type { Redactor } from '../../../src/runner/redactor.ts'
import type { Corpus, CorpusCase } from './cases.ts'
import type { Judgment } from './score.ts'
import { join } from 'node:path'
import { readAnswer } from '../../../src/evaluation/answer.ts'
import { evidenceKindOf, judgeAccepts } from '../../../src/evaluation/judges.ts'
import { buildRequest, citable, settle } from '../../../src/evaluation/judging.ts'
import { elapsedMs, monotonicClock } from '../../../src/protocol/deadline.ts'
import { errorMessage } from '../../../src/protocol/failures.ts'
import { bounded } from '../../../src/runner/bounded.ts'
import { caseEvidence, selectorsOf } from './evidence.ts'

// Runs the corpus against one named judge, as a run's parent would ask it: the same evidence freezing for frames and
// diagnostics, the same request with the same instructions, the same answer reader and the same parent rules (the
// declared criterion kinds and the strict missing-frame rule). One case is one request; cases run one after
// another, so each call's latency is its own. The call budget and the concurrency bound of a run are not applied: the
// corpus is a fixed list, and every case is asked once per repeat.

export type CorpusRunOptions = {
  corpus: Corpus
  judges: Judges
  judge: string
  repeats: number
  limits: EvaluationLimits
  timeoutMs: number
  redactor: Redactor
  /** Where each repeat's frozen evidence is written, one folder a repeat, as a run folder keeps it. */
  folder: string
  /** Told of each judgment as it ends, as the command prints progress. */
  onJudgment?: (judgment: Judgment, corpusCase: CorpusCase) => void
  signal?: AbortSignal
}

/**
 * Runs every case `repeats` times against the judge and returns one judgment a case a repeat, in order. A judge that
 * cannot be found or set up gives every case an error, as every check of a run would end; nothing is retried.
 *
 * @example const judgments = await runCorpus({ corpus, judges, judge: 'visual', repeats: 3, limits, timeoutMs: 30000, redactor, folder })
 */
export async function runCorpus(options: CorpusRunOptions): Promise<Judgment[]> {
  const judgments: Judgment[] = []
  for (let repeat = 1; repeat <= options.repeats; repeat++) {
    for (const corpusCase of options.corpus.cases) {
      const judgment = await judgeCase(corpusCase, repeat, options)
      judgments.push(judgment)
      options.onJudgment?.(judgment, corpusCase)
    }
  }
  return judgments
}

/**
 * A case's criteria as a check's, preserving each declared kind.
 *
 * @example caseCriteria({ shown: { kind: 'seen', requirement: 'A notification appears.' } })
 */
export function caseCriteria(requirement: CorpusCase['requirement']): Criterion[] {
  return Object.entries(requirement).map(([id, given]) => ({ id, requirement: given.requirement, kind: given.kind }))
}

/**
 * The request id the corpus sends for a case in a repeat. A judge reads nothing from it but what a run's own id says,
 * an attempt and a check; the corpus's fake judges read the case and the repeat from it.
 *
 * @example corpusRequestId(2, 'frames-toast-pass') // 'corpus-r2:frames-toast-pass'
 */
export function corpusRequestId(repeat: number, caseId: string): string {
  return `corpus-r${repeat}:${caseId}`
}

async function judgeCase(corpusCase: CorpusCase, repeat: number, options: CorpusRunOptions): Promise<Judgment> {
  const { judges, redactor } = options
  const redact = (text: string): string => redactor.redact(text)
  const base = { caseId: corpusCase.id, repeat }
  const ended = (verdict: EvaluationVerdict, reason: string, extra: Partial<Judgment> = {}): Judgment => ({ ...base, verdict, asked: false, reason: redact(reason), ...extra })
  if (options.signal?.aborted) return ended('cancelled', 'The corpus run was stopped before dispatch.')
  const found = judges.find(options.judge)
  if (!found.ok) return ended('error', found.problem)
  const { judge } = found
  const selectors = selectorsOf(corpusCase)
  const refused = selectors.map(evidenceKindOf).find((kind) => !judgeAccepts(judge, kind))
  if (refused !== undefined) return ended('error', `The judge ${JSON.stringify(judge.name)} does not accept ${refused}: its accepts lists ${judge.accepts.join(', ')}.`)
  const prepared = await judges.prepare(judge)
  if (!prepared.ok) return ended('error', prepared.problem)
  const criteria = caseCriteria(corpusCase.requirement)
  const limits = { ...options.limits, ...corpusCase.limits }
  const gathered = await caseEvidence(corpusCase, { limits, folder: join(options.folder, `r${repeat}`), redact, criteria, context: corpusCase.context })
  if (!gathered.ok) return ended(gathered.verdict, gathered.reason, { rule: 'evidence' })
  const asked = criteria
  const calling = new AbortController()
  const stop = (): void => calling.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', stop, { once: true })
  if (options.signal?.aborted) {
    options.signal.removeEventListener('abort', stop)
    return ended('cancelled', 'The corpus run was stopped before dispatch.')
  }
  const request = buildRequest({
    requestId: corpusRequestId(repeat, corpusCase.id),
    judge: judge.name,
    asked,
    context: corpusCase.context,
    evidence: gathered.evidence,
    redact,
    maxOutputTokens: limits.maxOutputTokens,
    timeoutMs: options.timeoutMs,
    signal: calling.signal,
  })
  const started = monotonicClock()
  const stopped = new Promise<void>((resolve) => calling.signal.addEventListener('abort', () => resolve(), { once: true }))
  const answered = await bounded(prepared.call(request), options.timeoutMs, stopped)
  options.signal?.removeEventListener('abort', stop)
  const latencyMs = elapsedMs(started)
  const model = redact(prepared.identity.model)
  const call = { asked: true, latencyMs, model }
  if (answered.status === 'stopped') return { ...base, ...call, verdict: 'cancelled', reason: 'The corpus run was stopped before the judge answered.' }
  if (answered.status === 'timed_out') {
    calling.abort(new DOMException(`The judge did not answer within ${options.timeoutMs} ms.`, 'TimeoutError'))
    return { ...base, ...call, verdict: 'error', reason: `The judge did not answer within ${options.timeoutMs} ms.` }
  }
  if (answered.status === 'failed') return { ...base, ...call, verdict: 'error', reason: redact(`The judge failed: ${errorMessage(answered.error)}`) }
  const reading = readAnswer(answered.value, { criteria: asked.map((criterion) => criterion.id), evidence: citable(request) })
  if (!reading.ok) return { ...base, ...call, verdict: 'error', reason: redact(reading.problem) }
  const settled = settle(reading.answer, criteria, gathered.evidence)
  const { answer } = reading
  const judgeCriteria = Object.fromEntries(answer.criteria.map((criterion): [string, CriterionVerdict] => [criterion.id, criterion.verdict]))
  return {
    ...base,
    ...call,
    verdict: settled.verdict,
    ...(answer.modelRevision === undefined ? {} : { model: redact(answer.modelRevision) }),
    ...(answer.usage === undefined ? {} : { usage: { ...answer.usage } }),
    judgeCriteria,
    ...(settled.rules.size === 0 ? {} : { rule: [...settled.rules.values()].find((rule) => rule === 'frames_incomplete') ?? [...settled.rules.values()][0] }),
    ...(settled.reason === undefined ? {} : { reason: redact(settled.reason) }),
    justification: redact(answer.justification),
  }
}
