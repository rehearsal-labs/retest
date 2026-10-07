import type { CriterionKind } from '../../../src/protocol/evaluation.ts'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse, s, type Schema } from '../../../src/protocol/schema.ts'

// The corpus's case list and labels, as files independent of any model's answer: cases.json names each case's
// requirement, its evidence by file and its label, written from what the captured evidence shows and the rubric in
// README.md, before any judge saw it.

/** What a case is meant to probe. A case may probe more than one thing. */
export type CaseKind = 'clear-pass' | 'clear-failure' | 'incomplete-evidence' | 'clipped-content' | 'plausible-wrong-text' | 'missing-transient-event' | 'prompt-injection'

/** The three categories the corpus needs ten cases of each. */
export type CaseCategory = 'text' | 'screenshot' | 'frames'

/**
 * A case's label: the verdict a judge that reads the evidence correctly gives the whole check. `unambiguous` cases are
 * the ones the 90% gate counts. `critical` marks a case on which a pass is never acceptable: a known failure, or
 * evidence that cannot show what the requirement asks. `review` says whether a person other than its author has
 * checked it; every label waits for the founder's review until he gives it. `why` says what in the evidence decides it.
 */
export type CaseLabel = { verdict: 'pass' | 'fail' | 'inconclusive'; unambiguous: boolean; critical: boolean; review: 'awaiting-founder' | 'reviewed'; why: string }

/**
 * Evidence as a case names it. `text` is a captured text file, optionally cut after `cut` characters with an ellipsis,
 * as a capture that keeps only the start would. `screenshot` is a captured PNG of an app. `frames` is a captured frame
 * sequence of a scene over an interval in milliseconds from its click, with the frames that show `omit.showing` left
 * out of what the recording holds, silently or as frames the queue dropped. `diagnostics` is a captured diagnostics
 * artifact, of which the case selects parts.
 */
export type CaseEvidence =
  | { kind: 'text'; file: string; label?: string; cut?: number }
  | { kind: 'screenshot'; file: string; app: string }
  | { kind: 'frames'; scene: string; app: string; fromMs: number; toMs: number; omit?: { showing: string; as: 'silent' | 'dropped' } }
  | { kind: 'diagnostics'; file: string; app: string; include: ('console' | 'network')[] }

/** Every corpus requirement declares its question independently of its wording. */
export type CaseRequirement = { kind: CriterionKind; requirement: string }

/**
 * One case. `source` names the app, browser and capture its evidence came from; `limits` narrows the run's limits for
 * this case only, as a check's config could, such as a frame bound smaller than the frames the interval kept.
 */
export type CorpusCase = {
  id: string
  category: CaseCategory
  kinds: CaseKind[]
  source: string
  requirement: Record<string, CaseRequirement>
  context?: string
  evidence: CaseEvidence[]
  limits?: { maxFrames?: number }
  label: CaseLabel
}

/** A case that waits for a target this machine cannot run now, named so it is never mistaken for one that ran. */
export type WaitingCase = { id: string; category: CaseCategory; source: string; waitingFor: string }

export type Corpus = { version: string; rubric: string; cases: CorpusCase[]; waiting: WaitingCase[] }

const kindSchema = s.enum(['clear-pass', 'clear-failure', 'incomplete-evidence', 'clipped-content', 'plausible-wrong-text', 'missing-transient-event', 'prompt-injection'])
const categorySchema = s.enum(['text', 'screenshot', 'frames'])
const evidenceSchema: Schema<CaseEvidence> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('text'), file: s.string(), label: s.optional(s.string()), cut: s.optional(s.number({ integer: true, min: 1 })) }),
  s.object({ kind: s.literal('screenshot'), file: s.string(), app: s.string() }),
  s.object({ kind: s.literal('frames'), scene: s.string(), app: s.string(), fromMs: s.number({ integer: true }), toMs: s.number({ integer: true }), omit: s.optional(s.object({ showing: s.string(), as: s.enum(['silent', 'dropped']) })) }),
  s.object({ kind: s.literal('diagnostics'), file: s.string(), app: s.string(), include: s.array(s.enum(['console', 'network'])) }),
])
const requirementSchema: Schema<CaseRequirement> = s.object({ kind: s.enum(['state', 'seen', 'never']), requirement: s.string() })
const caseSchema: Schema<CorpusCase> = s.object({
  id: s.string(),
  category: categorySchema,
  kinds: s.array(kindSchema),
  source: s.string(),
  requirement: s.record(requirementSchema),
  context: s.optional(s.string()),
  evidence: s.array(evidenceSchema),
  limits: s.optional(s.object({ maxFrames: s.optional(s.number({ integer: true, min: 1 })) })),
  label: s.object({ verdict: s.enum(['pass', 'fail', 'inconclusive']), unambiguous: s.boolean(), critical: s.boolean(), review: s.enum(['awaiting-founder', 'reviewed']), why: s.string() }),
})
const corpusSchema: Schema<Corpus> = s.object({
  version: s.string(),
  rubric: s.string(),
  cases: s.array(caseSchema),
  waiting: s.array(s.object({ id: s.string(), category: categorySchema, source: s.string(), waitingFor: s.string() })),
})

/** The corpus folder in this repository. */
export const corpusFolder: string = resolve(import.meta.dirname, '..')

/**
 * Reads and checks a case list: its shape, unique ids, at least one criterion and one piece of evidence a case, and
 * evidence whose kind fits its category. Throws naming the first problem.
 *
 * @example const corpus = readCorpus()
 */
export function readCorpus(file: string = join(corpusFolder, 'cases.json')): Corpus {
  const parsed = parse(corpusSchema, JSON.parse(readFileSync(file, 'utf8')))
  if (!parsed.ok) throw new Error(`${file} is not a case list: ${parsed.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  const corpus = parsed.value
  const seen = new Set<string>()
  for (const each of corpus.cases) {
    if (seen.has(each.id)) throw new Error(`${file} has the case ${each.id} twice.`)
    seen.add(each.id)
    if (Object.keys(each.requirement).length === 0) throw new Error(`The case ${each.id} has no criterion.`)
    for (const criterion of Object.values(each.requirement)) if (criterion.requirement.trim() === '') throw new Error(`The case ${each.id} has an empty requirement.`)
    if (each.evidence.length === 0) throw new Error(`The case ${each.id} has no evidence.`)
    const fits = each.evidence.some((evidence) => (each.category === 'frames' ? evidence.kind === 'frames' : each.category === 'screenshot' ? evidence.kind === 'screenshot' : evidence.kind === 'text' || evidence.kind === 'diagnostics'))
    if (!fits) throw new Error(`The case ${each.id} is a ${each.category} case with no ${each.category} evidence.`)
  }
  return corpus
}
