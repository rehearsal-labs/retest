import type { Failure, SourceLocation } from './failures.ts'
import type { Path } from './schema.ts'
import { failureSchema, sourceLocationSchema } from './failures.ts'
import { isName } from './names.ts'
import { describeValue, formatPath, isArray, isPlainObject, parse, s, type Schema } from './schema.ts'
import { maxTimeout } from './timeouts.ts'

/**
 * How a check's verdict counts. A `required` check keeps its test from passing unless it passes; an `advisory` one
 * records a warning and never changes the test's status.
 */
export type EvaluationMode = 'required' | 'advisory'

/** What a judge decided about one criterion. */
export type CriterionVerdict = 'pass' | 'fail' | 'inconclusive'

/**
 * How a check ended. `pass`, `fail` and `inconclusive` are a judge's valid answer over every criterion: a check passes
 * only when every criterion passed, fails when any failed, and is inconclusive otherwise. `error` is a check that could
 * not be judged: a judge that could not be set up or did not answer in time, an answer that broke the contract, or a
 * limit reached. `cancelled` is a check the run or the test stopped before its answer came. `not_run` is a host check
 * whose test failed or stopped before the parent's checks.
 */
export type EvaluationVerdict = 'pass' | 'fail' | 'inconclusive' | 'error' | 'cancelled' | 'not_run'

/** The kinds of evidence a judge can take: text, screenshots, and the frames of a recording. */
export type EvidenceKind = 'text' | 'images' | 'frames'

/** Where a check came from: the test's own `test.evaluate`, or `RunOptions.hostEvaluations`. */
export type EvaluationSource = 'test' | 'host'

/** One criterion of a check: its id, a name, and the requirement the judge reads. */
export type Criterion = { id: string; requirement: string }

/**
 * Evidence as a check names it. The parent captures a `screenshot` of the app's page itself, at the moment it takes
 * the check; `app` defaults to the test's first app. `text` is text the check supplies. `recording` names a recorded
 * step, which no run records yet, so the parent refuses it by name.
 */
export type EvidenceSelector =
  | { kind: 'screenshot'; app?: string }
  | { kind: 'text'; text: string; label?: string }
  | { kind: 'recording'; app?: string; step: string }

/**
 * A check as the test file's process asks for it. `judge` names one of the config's judges, or the default judge when
 * absent. `timeoutMs` may shorten the check's time, never lengthen what the test has left.
 */
export type EvaluationCall = {
  judge?: string
  criteria: Criterion[]
  context?: string
  evidence: EvidenceSelector[]
  mode: EvaluationMode
  timeoutMs?: number
}

/**
 * The parent's answer to the test file's process. `failure` is present for a required check that did not pass, and
 * `warning` for an advisory one, each as the record holds it, so a failure may quote the judge's redacted words. The
 * answer carries no evidence and no justification of its own.
 */
export type EvaluationAnswer = {
  checkId: string
  mode: EvaluationMode
  verdict: EvaluationVerdict
  criteria: { id: string; verdict?: CriterionVerdict }[]
  failure?: Failure
  warning?: string
}

/**
 * One piece of evidence as a record keeps it: what identifies it, never its bytes or its text. `id` is how the judge
 * cites it. A screenshot names the app, the session and attempt that captured it, when it came back, and its file in
 * the run folder. `sha256` and `bytes` are of what the judge received: a screenshot's PNG, or the text as UTF-8 after
 * redaction.
 */
export type EvidenceRecord = {
  id: string
  kind: 'screenshot' | 'text'
  app?: string
  sessionId?: string
  attemptId: string
  capturedAt: string
  path?: string
  label?: string
  sha256: string
  bytes: number
  width?: number
  height?: number
}

/** A criterion as a record keeps it, with the judge's verdict and the evidence it cited, when the judge gave them. */
export type CriterionRecord = { id: string; requirement: string; verdict?: CriterionVerdict; citations?: string[] }

/**
 * Who judged, as far as the evaluator says: the provider and model it named when it was set up, the model revision
 * the provider reported for this call, the evaluator's own version and the version of Retest's instructions, the
 * sampling settings it used, how long the call took and the tokens the provider counted, when it counted them.
 */
export type EvaluatorRecord = {
  provider: string
  model: string
  modelRevision?: string
  evaluatorVersion: string
  promptVersion: string
  sampling?: { temperature?: number; topP?: number; seed?: number; maxOutputTokens?: number }
  latencyMs?: number
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number }
}

/**
 * One check, as events and results record it. `criteriaSha256` is the SHA-256 of the criteria and the context, as the
 * judge received them. `justification` is the judge's short account, redacted; `reason` says why the check has no
 * judged verdict, or what the evidence lacked. `failure` is present on a required check that did not pass, and
 * `warning` on an advisory one. Each optional field is present only when it says something.
 */
export type EvaluationRecord = {
  checkId: string
  source: EvaluationSource
  mode: EvaluationMode
  judge?: string
  verdict: EvaluationVerdict
  criteria: CriterionRecord[]
  context?: string
  criteriaSha256: string
  evidence: EvidenceRecord[]
  justification?: string
  reason?: string
  evaluator?: EvaluatorRecord
  failure?: Failure
  warning?: string
  durationMs: number
  location?: SourceLocation
}

/** Evidence a host names for one of its checks: a screenshot the parent captures after the body, or text it supplies. */
export type HostEvidence = { readonly app?: string; readonly capture: 'screenshot' } | { readonly text: string; readonly label?: string }

/**
 * A required check a host declares for a test, which the parent runs itself after the test's body, on that attempt's
 * pages. `id` is the check's own name and never changes; `criteria` maps each criterion's id to its requirement.
 * `judge` names one of the config's judges, or the default judge when absent. Test code cannot skip, weaken or answer
 * such a check.
 */
export type HostEvaluation = {
  readonly id: string
  readonly criteria: Readonly<Record<string, string>>
  readonly evidence: HostEvidence | readonly HostEvidence[]
  readonly judge?: string
  readonly context?: string
  readonly timeoutMs?: number
}

/** A host's check as `run.started` records it. */
export type HostEvaluationRecord = {
  id: string
  judge?: string
  criteria: Criterion[]
  context?: string
  evidence: EvidenceSelector[]
  timeoutMs?: number
}

const count = s.number({ integer: true, min: 0 })
const modeSchema = s.enum(['required', 'advisory'])
const criterionVerdictSchema = s.enum(['pass', 'fail', 'inconclusive'])
const criterionSchema: Schema<Criterion> = s.object({ id: s.string(), requirement: s.string() })

export const evidenceSelectorSchema: Schema<EvidenceSelector> = s.discriminatedUnion('kind', [
  s.object({ kind: s.literal('screenshot'), app: s.optional(s.string()) }),
  s.object({ kind: s.literal('text'), text: s.string(), label: s.optional(s.string()) }),
  s.object({ kind: s.literal('recording'), app: s.optional(s.string()), step: s.string() }),
])

export const evaluationCallSchema: Schema<EvaluationCall> = s.object({
  judge: s.optional(s.string()),
  criteria: s.array(criterionSchema),
  context: s.optional(s.string()),
  evidence: s.array(evidenceSelectorSchema),
  mode: modeSchema,
  timeoutMs: s.optional(s.number({ integer: true, min: 1 })),
})

export const evaluationVerdictSchema: Schema<EvaluationVerdict> = s.enum(['pass', 'fail', 'inconclusive', 'error', 'cancelled', 'not_run'])

export const evaluationAnswerSchema: Schema<EvaluationAnswer> = s.object({
  checkId: s.string(),
  mode: modeSchema,
  verdict: evaluationVerdictSchema,
  criteria: s.array(s.object({ id: s.string(), verdict: s.optional(criterionVerdictSchema) })),
  failure: s.optional(failureSchema),
  warning: s.optional(s.string()),
})

const evidenceRecordSchema: Schema<EvidenceRecord> = s.object({
  id: s.string(),
  kind: s.enum(['screenshot', 'text']),
  app: s.optional(s.string()),
  sessionId: s.optional(s.string()),
  attemptId: s.string(),
  capturedAt: s.string(),
  path: s.optional(s.string()),
  label: s.optional(s.string()),
  sha256: s.string(),
  bytes: count,
  width: s.optional(count),
  height: s.optional(count),
})

const criterionRecordSchema: Schema<CriterionRecord> = s.object({
  id: s.string(),
  requirement: s.string(),
  verdict: s.optional(criterionVerdictSchema),
  citations: s.optional(s.array(s.string())),
})

const evaluatorRecordSchema: Schema<EvaluatorRecord> = s.object({
  provider: s.string(),
  model: s.string(),
  modelRevision: s.optional(s.string()),
  evaluatorVersion: s.string(),
  promptVersion: s.string(),
  sampling: s.optional(
    s.object({
      temperature: s.optional(s.number()),
      topP: s.optional(s.number()),
      seed: s.optional(s.number({ integer: true })),
      maxOutputTokens: s.optional(count),
    }),
  ),
  latencyMs: s.optional(s.number({ min: 0 })),
  usage: s.optional(s.object({ inputTokens: s.optional(count), outputTokens: s.optional(count), totalTokens: s.optional(count) })),
})

export const evaluationRecordSchema: Schema<EvaluationRecord> = s.object({
  checkId: s.string(),
  source: s.enum(['test', 'host']),
  mode: modeSchema,
  judge: s.optional(s.string()),
  verdict: evaluationVerdictSchema,
  criteria: s.array(criterionRecordSchema),
  context: s.optional(s.string()),
  criteriaSha256: s.string(),
  evidence: s.array(evidenceRecordSchema),
  justification: s.optional(s.string()),
  reason: s.optional(s.string()),
  evaluator: s.optional(evaluatorRecordSchema),
  failure: s.optional(failureSchema),
  warning: s.optional(s.string()),
  durationMs: s.number({ min: 0 }),
  location: s.optional(sourceLocationSchema),
})

export const hostEvaluationRecordSchema: Schema<HostEvaluationRecord> = s.object({
  id: s.string(),
  judge: s.optional(s.string()),
  criteria: s.array(criterionSchema),
  context: s.optional(s.string()),
  evidence: s.array(evidenceSelectorSchema),
  timeoutMs: s.optional(s.number({ integer: true, min: 1 })),
})

/**
 * The keys of an AI check's parts that hold text a person, a page or a provider wrote: a criterion's requirement, the
 * context, evidence text and labels, the judge's justification, a reason, a warning, and what the evaluator says of the
 * model. A host writes criteria with the run's secrets at hand, and a provider may echo a key into any string it
 * returns, so each is free text wherever a check is recorded.
 */
export const evaluationTextKeys: ReadonlySet<string> = new Set(['requirement', 'context', 'text', 'label', 'justification', 'reason', 'warning', 'provider', 'model', 'modelRevision'])

/**
 * Whether an object is one of an AI check's parts, as an event, a result or `run.started` records it.
 *
 * @example isEvaluationPart({ id: 'saved', requirement: 'The task shows as saved.' }) // true
 */
export function isEvaluationPart(record: Record<string, unknown>): boolean {
  return (
    parse(criterionRecordSchema, record).ok ||
    parse(evidenceSelectorSchema, record).ok ||
    parse(evidenceRecordSchema, record).ok ||
    parse(evaluatorRecordSchema, record).ok ||
    parse(evaluationRecordSchema, record).ok ||
    parse(hostEvaluationRecordSchema, record).ok
  )
}

/**
 * The evidence a host check names, as a list of selectors.
 *
 * @example hostEvidence({ capture: 'screenshot', app: 'web' }) // [{ kind: 'screenshot', app: 'web' }]
 */
export function hostEvidence(evidence: HostEvaluation['evidence']): EvidenceSelector[] {
  const list: readonly HostEvidence[] = isEvidenceList(evidence) ? evidence : [evidence]
  return list.map((item) => {
    if ('capture' in item) return { kind: 'screenshot', ...(item.app === undefined ? {} : { app: item.app }) }
    return { kind: 'text', text: item.text, ...(item.label === undefined ? {} : { label: item.label }) }
  })
}

/**
 * A host check as `run.started` records it: its criteria in the order given.
 *
 * @example hostEvaluationRecord({ id: 'saved', criteria: { saved: 'The task shows as saved.' }, evidence: { capture: 'screenshot' } })
 */
export function hostEvaluationRecord(check: HostEvaluation): HostEvaluationRecord {
  return {
    id: check.id,
    ...(check.judge === undefined ? {} : { judge: check.judge }),
    criteria: Object.entries(check.criteria).map(([id, requirement]) => ({ id, requirement })),
    ...(check.context === undefined ? {} : { context: check.context }),
    evidence: hostEvidence(check.evidence),
    ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
  }
}

const hostEvaluationKeys = new Set(['id', 'criteria', 'evidence', 'judge', 'context', 'timeoutMs'])
const screenshotKeys = new Set(['app', 'capture'])
const textKeys = new Set(['text', 'label'])

type AddProblem = (path: Path, message: string) => void

/**
 * Everything wrong with a `hostEvaluations` option that can be told without the tests, each naming its key, such as
 * `hostEvaluations["a.retest.ts"][0].criteria`. A key set to undefined counts as absent, and any key a check does not
 * have is refused, so a misspelt one never drops a criterion. Which tests, apps and judges the checks name is for the
 * caller to check once it knows them.
 *
 * @example hostEvaluationProblems({ 'a.retest.ts': [{ id: 'saved', criteria: {}, evidence: { capture: 'screenshot' } }] })
 */
export function hostEvaluationProblems(hostEvaluations: unknown): string[] {
  const problems: string[] = []
  const add: AddProblem = (path, message) => problems.push(`${formatPath(path).slice(2)}: ${message}`)
  if (!isPlainObject(hostEvaluations)) {
    add(['hostEvaluations'], `expected lists of checks by test id or file, received ${describeValue(hostEvaluations)}`)
    return problems
  }
  for (const [key, list] of Object.entries(hostEvaluations)) {
    const path = ['hostEvaluations', key]
    if (!isArray(list)) {
      add(path, `expected a list of checks, received ${describeValue(list)}`)
      continue
    }
    const seen = new Set<string>()
    for (const [index, check] of list.entries()) {
      const id = checkProblems(check, [...path, index], add)
      if (id !== undefined && seen.has(id)) add([...path, index, 'id'], `repeats the id ${JSON.stringify(id)}`)
      if (id !== undefined) seen.add(id)
    }
  }
  return problems
}

// Returns the check's id when it is a name, so repeats can be told apart.
function checkProblems(value: unknown, path: Path, add: AddProblem): string | undefined {
  if (!isPlainObject(value)) {
    add(path, `expected a check, received ${describeValue(value)}`)
    return undefined
  }
  const check = defined(value)
  for (const key of Object.keys(check)) if (!hostEvaluationKeys.has(key)) add([...path, key], 'unknown key')
  const { id, criteria, evidence, timeoutMs } = check
  for (const key of ['judge', 'context']) if (key in check && typeof check[key] !== 'string') add([...path, key], `expected string, received ${describeValue(check[key])}`)
  if (timeoutMs !== undefined && !isBudget(timeoutMs)) add([...path, 'timeoutMs'], `expected a whole number of milliseconds from 1 to ${maxTimeout}, received ${describeValue(timeoutMs)}`)
  criteriaProblems(criteria, [...path, 'criteria'], add)
  evidenceProblems(evidence, [...path, 'evidence'], add)
  if (id === undefined) add([...path, 'id'], 'missing required key')
  else if (typeof id !== 'string' || !isName(id)) add([...path, 'id'], `expected a name of letters, digits, "_" and "-" that starts with a letter, received ${describeValue(id)}`)
  else return id
  return undefined
}

function criteriaProblems(criteria: unknown, path: Path, add: AddProblem): void {
  if (criteria === undefined) return add(path, 'missing required key')
  if (!isPlainObject(criteria) || Object.keys(criteria).length === 0) return add(path, `expected criteria by id, such as { saved: 'The task shows as saved.' }, received ${describeValue(criteria)}`)
  for (const [id, requirement] of Object.entries(criteria)) {
    if (!isName(id)) add([...path, id], 'expected a criterion id of letters, digits, "_" and "-" that starts with a letter')
    if (typeof requirement !== 'string' || requirement.trim() === '') add([...path, id], `expected the requirement as text, received ${describeValue(requirement)}`)
  }
}

function evidenceProblems(evidence: unknown, path: Path, add: AddProblem): void {
  if (evidence === undefined) return add(path, 'missing required key')
  const list = isArray(evidence) ? evidence : [evidence]
  if (list.length === 0) return add(path, 'expected at least one piece of evidence')
  for (const [index, item] of list.entries()) {
    const at = isArray(evidence) ? [...path, index] : path
    if (!isPlainObject(item)) {
      add(at, `expected { capture: 'screenshot' } or { text }, received ${describeValue(item)}`)
      continue
    }
    const entry = defined(item)
    const keys = 'capture' in entry ? screenshotKeys : textKeys
    for (const key of Object.keys(entry)) if (!keys.has(key)) add([...at, key], 'unknown key')
    if ('capture' in entry && entry['capture'] !== 'screenshot') add([...at, 'capture'], `expected "screenshot", received ${describeValue(entry['capture'])}`)
    if ('capture' in entry && 'app' in entry && typeof entry['app'] !== 'string') add([...at, 'app'], `expected string, received ${describeValue(entry['app'])}`)
    if (!('capture' in entry) && (typeof entry['text'] !== 'string' || entry['text'] === '')) add([...at, 'text'], `expected the text to judge, received ${describeValue(entry['text'])}`)
    if (!('capture' in entry) && 'label' in entry && typeof entry['label'] !== 'string') add([...at, 'label'], `expected string, received ${describeValue(entry['label'])}`)
  }
}

function defined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
}

function isBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxTimeout
}

function isEvidenceList(evidence: HostEvaluation['evidence']): evidence is readonly HostEvidence[] {
  return Array.isArray(evidence)
}
