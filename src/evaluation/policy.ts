import type { EvaluationMode, EvaluationRecord, EvaluationVerdict } from '../protocol/evaluation.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'

/** What a finished check means for its test: a failure for a required check, or a warning for an advisory one. */
export type CheckEffect = { failure?: Failure; warning?: string }

/** A check as the policy reads it. */
export type JudgedCheck = Pick<EvaluationRecord, 'checkId' | 'mode' | 'verdict' | 'criteria' | 'justification' | 'reason'> & { location?: SourceLocation | undefined }

// How much of the judge's justification a failure message quotes. The record keeps the rest.
const quotedLength = 300

/**
 * The policy table. A required check that passes satisfies itself and nothing more. One that fails fails the test with
 * `evaluation_failed`; one the judge could not decide keeps it from passing with `evaluation_inconclusive`; one that
 * could not be judged makes it an error with `evaluation_error`, and so does one that was stopped before its answer
 * came, which never hides the stop the test already has. The attempt gives a check the run's interruption stopped that
 * interruption instead. An advisory check never changes the test: one that
 * does not pass leaves a warning, and one stopped or not run leaves nothing. A host check that did not run because its
 * test had already failed adds nothing to that failure.
 *
 * @example checkEffect({ checkId: 'evaluation-1', mode: 'required', verdict: 'fail', criteria, justification: 'The banner says Error.' }).failure?.class // 'evaluation_failed'
 */
export function checkEffect(check: JudgedCheck): CheckEffect {
  if (check.verdict === 'pass' || check.verdict === 'not_run') return {}
  if (check.mode === 'advisory') return check.verdict === 'cancelled' ? {} : { warning: warningText(check) }
  const failure: Failure = { class: failureClass(check.verdict), message: failureText(check) }
  return check.location === undefined ? { failure } : { failure: { ...failure, location: check.location } }
}

/** Whether a check counts as an assertion: a required check whose judge gave a valid pass or fail. */
export function countsAsAssertion(mode: EvaluationMode, verdict: EvaluationVerdict): boolean {
  return mode === 'required' && (verdict === 'pass' || verdict === 'fail')
}

function failureClass(verdict: Exclude<EvaluationVerdict, 'pass' | 'not_run'>): Failure['class'] {
  if (verdict === 'fail') return 'evaluation_failed'
  return verdict === 'inconclusive' ? 'evaluation_inconclusive' : 'evaluation_error'
}

// One line: a test's `failure.details.also` lists later failures one per line.
function failureText(check: JudgedCheck): string {
  const subject = `The AI check ${check.checkId}`
  switch (check.verdict) {
    case 'fail':
      return `${subject} failed: the judge found ${listed(criteriaWith(check, 'fail'))} not met.${saying(check.justification)}`
    case 'inconclusive':
      return `${subject} could not be decided: ${undecided(check)}`
    case 'cancelled':
      return `${subject} did not finish: ${oneLine(check.reason ?? 'it was stopped before its answer came.')}`
    default:
      return `${subject} could not run: ${oneLine(check.reason ?? 'the judge gave no answer.')}`
  }
}

function warningText(check: JudgedCheck): string {
  const subject = `The advisory AI check ${check.checkId}`
  switch (check.verdict) {
    case 'fail':
      return `${subject} failed: the judge found ${listed(criteriaWith(check, 'fail'))} not met.${saying(check.justification)}`
    case 'inconclusive':
      return `${subject} could not be decided: ${undecided(check)}`
    default:
      return `${subject} could not run: ${oneLine(check.reason ?? 'the judge gave no answer.')}`
  }
}

function undecided(check: JudgedCheck): string {
  if (check.reason !== undefined) return oneLine(check.reason)
  return `the judge found the evidence not enough to decide ${listed(criteriaWith(check, 'inconclusive'))}.${saying(check.justification)}`
}

function criteriaWith(check: JudgedCheck, verdict: 'fail' | 'inconclusive'): string[] {
  return check.criteria.filter((criterion) => criterion.verdict === verdict).map((criterion) => criterion.id)
}

function listed(ids: readonly string[]): string {
  return ids.length === 0 ? 'a criterion' : ids.map((id) => JSON.stringify(id)).join(', ')
}

// The judge's words are quoted as data, escaped and cut, so they never pass for Retest's own.
function saying(justification: string | undefined): string {
  if (justification === undefined) return ''
  const cut = justification.length > quotedLength ? `${justification.slice(0, quotedLength)}…` : justification
  return ` It said: ${JSON.stringify(cut)}`
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ')
}
