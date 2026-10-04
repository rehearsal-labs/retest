import type { CriterionVerdict, UnsentSetting } from '../protocol/evaluation.ts'
import { unsentSettingSchema } from '../protocol/evaluation.ts'
import { parse, s, type Schema } from '../protocol/schema.ts'

/** The longest justification an answer may give, in UTF-16 code units. A longer one breaks the contract. */
export const maxJustificationLength = 2000

/** The longest model revision an answer may name. */
const maxRevisionLength = 200

/** The longest reason an answer may give for a sampling setting it did not send. */
const maxUnsentReasonLength = 500

/** An answer that passed every check, in the request's criterion order. */
export type CheckedAnswer = {
  criteria: { id: string; verdict: CriterionVerdict; citations: string[] }[]
  justification: string
  modelRevision?: string
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
  samplingNotSent?: UnsentSetting[]
}

const count = s.number({ integer: true, min: 0 })

// Objects refuse unknown keys, so a self-reported confidence or any other field the contract lacks is an error, not
// something a reader might take as a guarantee.
const judgeAnswerSchema: Schema<CheckedAnswer> = s.object({
  criteria: s.array(s.object({ id: s.string(), verdict: s.enum(['pass', 'fail', 'inconclusive']), citations: s.array(s.string()) })),
  justification: s.string(),
  modelRevision: s.optional(s.string()),
  usage: s.optional(s.object({ inputTokens: s.optional(count), outputTokens: s.optional(count), totalTokens: s.optional(count) })),
  samplingNotSent: s.optional(s.array(unsentSettingSchema)),
})

/** What the request offered the judge: its criterion ids, in order, and the evidence ids it may cite. */
export type Offered = { readonly criteria: readonly string[]; readonly evidence: readonly string[] }

export type AnswerReading = { ok: true; answer: CheckedAnswer } | { ok: false; problem: string }

/**
 * Checks a judge's answer against the request it answers. Every criterion must appear exactly once, with a verdict
 * the contract knows; every cited id must be evidence the request supplied, and a pass or a fail must cite some; the
 * justification must be text within `maxJustificationLength`. The first problem found is the reading's, said without
 * quoting what the judge wrote.
 *
 * @example readAnswer(raw, { criteria: ['saved'], evidence: ['e1'] }).ok
 */
export function readAnswer(value: unknown, offered: Offered): AnswerReading {
  const parsed = parse(judgeAnswerSchema, value)
  if (!parsed.ok) {
    const [first] = parsed.issues
    return refused(`it does not have the shape of an answer: ${first === undefined ? 'nothing was returned' : `${first.path} ${shapeProblem(first.message)}`}`)
  }
  const answer = parsed.value
  const problem = criteriaProblem(answer.criteria, offered) ?? justificationProblem(answer.justification) ?? revisionProblem(answer.modelRevision) ?? unsentProblem(answer.samplingNotSent)
  if (problem !== undefined) return refused(problem)
  const order = new Map(offered.criteria.map((id, index) => [id, index]))
  const criteria = [...answer.criteria].sort((first, second) => (order.get(first.id) ?? 0) - (order.get(second.id) ?? 0))
  return { ok: true, answer: { ...answer, criteria } }
}

/**
 * A check's verdict from its criteria: fail when any failed, inconclusive when none failed and any could not be
 * judged, pass only when every one passed. Nothing turns an inconclusive criterion into a pass.
 *
 * @example aggregateVerdict(['pass', 'inconclusive']) // 'inconclusive'
 */
export function aggregateVerdict(verdicts: readonly CriterionVerdict[]): CriterionVerdict {
  if (verdicts.includes('fail')) return 'fail'
  if (verdicts.length === 0 || verdicts.includes('inconclusive')) return 'inconclusive'
  return 'pass'
}

function criteriaProblem(criteria: CheckedAnswer['criteria'], offered: Offered): string | undefined {
  const asked = new Set(offered.criteria)
  const supplied = new Set(offered.evidence)
  const seen = new Set<string>()
  for (const { id, verdict, citations } of criteria) {
    if (!asked.has(id)) return `it judges a criterion the check does not have (${criteria.length} given, ${asked.size} asked)`
    if (seen.has(id)) return `it judges the criterion ${id} more than once`
    seen.add(id)
    if (citations.some((citation) => !supplied.has(citation))) return `it cites evidence the check never supplied for ${id}`
    if (verdict !== 'inconclusive' && citations.length === 0) return `its ${verdict} for ${id} cites no evidence`
  }
  const missing = offered.criteria.filter((id) => !seen.has(id))
  return missing.length === 0 ? undefined : `it leaves out the criterion ${missing.join(', ')}`
}

function justificationProblem(justification: string): string | undefined {
  if (justification.trim() === '') return 'its justification is empty'
  if (justification.length > maxJustificationLength) return `its justification is ${justification.length} characters, over the limit of ${maxJustificationLength}`
  return undefined
}

function revisionProblem(revision: string | undefined): string | undefined {
  if (revision === undefined || (revision !== '' && revision.length <= maxRevisionLength)) return undefined
  return 'its model revision is empty or too long'
}

function unsentProblem(unsent: UnsentSetting[] | undefined): string | undefined {
  if (unsent === undefined) return undefined
  const settings = unsent.map((each) => each.setting)
  if (new Set(settings).size !== settings.length) return 'it names a sampling setting it did not send more than once'
  if (unsent.some(({ reason }) => reason.trim() === '' || reason.length > maxUnsentReasonLength)) return 'its reason for a sampling setting it did not send is empty or too long'
  return undefined
}

// A schema issue quotes short strings the judge wrote; only the expectation is kept.
function shapeProblem(message: string): string {
  const cut = message.indexOf(', received ')
  return cut === -1 ? message : message.slice(0, cut)
}

function refused(problem: string): AnswerReading {
  return { ok: false, problem: `The judge's answer breaks the contract: ${problem}.` }
}
