import type { EvaluationRecord, EvaluationVerdict } from '../protocol/evaluation.ts'
import type { TestResult } from '../protocol/result.ts'
import { join } from 'node:path'

/** One line a report shows about an AI check: a label and what it says. */
export type EvaluationLine = { label: string; value: string }

// How much of a judge's words a terminal line shows. `inspect --json` and the record keep all of them.
const shownJustification = 300

const verdictWords: Record<EvaluationVerdict, string> = {
  pass: 'passed',
  fail: 'failed',
  inconclusive: 'undecided',
  error: 'could not run',
  cancelled: 'did not finish',
  not_run: 'not run',
}

/**
 * A check as a heading names it: its id, where it came from, its mode, and the judge and model that answered.
 *
 * @example describeEvaluation(record) // 'evaluation-1 failed, required, judge visual (anthropic claude-sonnet-5)'
 */
export function describeEvaluation(record: EvaluationRecord): string {
  const source = record.source === 'host' ? 'host check ' : ''
  const judge = record.judge === undefined ? '' : `, judge ${record.judge}`
  const model = record.evaluator === undefined ? '' : ` (${record.evaluator.provider} ${record.evaluator.modelRevision ?? record.evaluator.model})`
  return `${source}${record.checkId} ${verdictWords[record.verdict]}, ${record.mode}${judge}${model}`
}

/**
 * The lines a failure card shows for a test's AI checks: each check that did not pass in full, with its criteria, what
 * the judge said, why it has no verdict and its evidence, then one line for each that passed or was not run. Evidence
 * paths are joined to the run folder as it was given.
 *
 * @example evaluationCardLines(test.evaluations ?? [], '.retest/runs/latest')
 */
export function evaluationCardLines(records: readonly EvaluationRecord[], runFolder: string): EvaluationLine[] {
  const lines: EvaluationLine[] = []
  for (const record of records.filter((each) => each.verdict !== 'pass' && each.verdict !== 'not_run')) {
    lines.push({ label: 'AI check', value: describeEvaluation(record) }, ...evaluationDetails(record, runFolder))
  }
  for (const record of records.filter((each) => each.verdict === 'pass' || each.verdict === 'not_run')) {
    lines.push({ label: 'AI check', value: describeEvaluation(record) })
  }
  return lines
}

/**
 * What one check found, under its heading: each criterion's verdict, the parent's rule when one set the judge aside,
 * and its citations, what the judge said, why the check has no verdict, and each piece of evidence: a screenshot by its
 * path joined to the run folder as it was given, frames by their count with what is missing, diagnostics by the parts
 * sent.
 *
 * @example evaluationDetails(record, '.retest/runs/latest')[0] // { label: 'Criterion', value: 'saved: fail, cites e1' }
 */
export function evaluationDetails(record: EvaluationRecord, runFolder: string): EvaluationLine[] {
  const lines: EvaluationLine[] = []
  for (const criterion of record.criteria) {
    const verdict = criterion.verdict === undefined ? 'no verdict' : criterion.verdict
    const cites = criterion.citations === undefined || criterion.citations.length === 0 ? '' : `, cites ${criterion.citations.join(' ')}`
    lines.push({ label: 'Criterion', value: `${criterion.id}: ${verdict}${criterion.kind === undefined ? '' : `, kind ${criterion.kind}`}${ruleWords(criterion)}${cites}` })
  }
  if (record.justification !== undefined) lines.push({ label: 'Judge said', value: quoted(record.justification) })
  if (record.reason !== undefined) lines.push({ label: 'Reason', value: record.reason })
  for (const evidence of record.evidence) lines.push({ label: 'Evidence', value: describeEvidence(evidence, runFolder) })
  return lines
}

/**
 * The warnings of a test's advisory checks, in the order the checks ended. A report shows them whatever the test's
 * status.
 *
 * @example evaluationWarnings(test) // ['The advisory AI check evaluation-2 failed: ...']
 */
export function evaluationWarnings(test: Pick<TestResult, 'evaluations'>): string[] {
  return (test.evaluations ?? []).flatMap((record) => (record.warning === undefined ? [] : [record.warning]))
}

/**
 * The AI checks of every test, counted by verdict, worst first, and the warnings among them. Empty when no test had any.
 *
 * @example countEvaluations(tests) // ['1 failed', '3 passed', '1 warning']
 */
export function countEvaluations(tests: readonly Pick<TestResult, 'evaluations'>[]): string[] {
  const records = tests.flatMap((test) => test.evaluations ?? [])
  const order: EvaluationVerdict[] = ['fail', 'inconclusive', 'error', 'cancelled', 'pass', 'not_run']
  const parts = order.flatMap((verdict) => {
    const count = records.filter((record) => record.verdict === verdict && record.mode === 'required').length
    return count === 0 ? [] : [`${count} ${verdictWords[verdict]}`]
  })
  const warnings = records.filter((record) => record.warning !== undefined).length
  const advisoryPasses = records.filter((record) => record.mode === 'advisory' && record.verdict === 'pass').length
  return [...parts, ...(advisoryPasses === 0 ? [] : [`${advisoryPasses} advisory passed`]), ...(warnings === 0 ? [] : [`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`])]
}

// Retest's own words for a rule that set the judge aside, after the verdict that counts.
function ruleWords(criterion: EvaluationRecord['criteria'][number]): string {
  if (criterion.rule === 'absence_over_frames') return ` (the judge said ${criterion.judgeVerdict ?? 'inconclusive'}, but sampled frames cannot prove absence without a seen contradiction)`
  if (criterion.rule === 'seen_over_frames') return ` (the judge said ${criterion.judgeVerdict ?? 'inconclusive'}, but a seen criterion needs a witnessed appearance and never fails)`
  if (criterion.rule === 'never_over_frames') return ` (the judge said ${criterion.judgeVerdict ?? 'inconclusive'}, but a never failure needs a seen frame showing the violation)`
  if (criterion.rule === 'frames_incomplete') return ` (the judge said ${criterion.judgeVerdict ?? 'pass'}, but frames are missing)`
  return ''
}

function describeEvidence(evidence: EvaluationRecord['evidence'][number], runFolder: string): string {
  if (evidence.kind === 'text') return `${evidence.id} text${evidence.label === undefined ? '' : ` ${quoted(evidence.label)}`}, ${evidence.bytes} bytes`
  const status = evidence.status === undefined || evidence.status === 'complete' ? '' : `, ${evidence.status}${evidence.reason === undefined ? '' : `: ${evidence.reason}`}`
  if (evidence.kind === 'frames') {
    const step = evidence.step === undefined ? '' : ` of the step ${quoted(evidence.step)}`
    const count = evidence.frames?.length ?? 0
    return `${evidence.id} ${count} ${count === 1 ? 'frame' : 'frames'} of ${evidence.app ?? 'the page'}${step}${status}`
  }
  if (evidence.kind === 'diagnostics') {
    const sent = evidence.records?.length ?? 0
    const path = evidence.path === undefined ? '' : ` ${join(runFolder, evidence.path)}`
    return `${evidence.id} ${(evidence.include ?? []).join(' and ')} records of ${evidence.app ?? 'the page'}, ${sent} sent${status}${path}`
  }
  const path = evidence.path === undefined ? 'not saved' : join(runFolder, evidence.path)
  const size = evidence.width === undefined || evidence.height === undefined ? '' : ` ${evidence.width}x${evidence.height}`
  return `${evidence.id} screenshot of ${evidence.app ?? 'the page'}${size} ${path}`
}

// The judge's words are data: quoted, escaped and cut, so they never pass for Retest's own.
function quoted(text: string): string {
  const cut = text.length > shownJustification ? `${text.slice(0, shownJustification)}…` : text
  return JSON.stringify(cut).replace(/[\u007f-\u009f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
}
