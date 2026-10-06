import type { Failure, SourceLocation } from './failures.ts'
import type { CaptureSourceName } from './identity.ts'
import type { CaptureReference } from './evidence.ts'
import type { Path } from './schema.ts'
import { failureSchema, sourceLocationSchema } from './failures.ts'
import { captureSourceNameSchema } from './identity.ts'
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

/** Over frames: the last state held, an appearance witnessed, or an appearance forbidden throughout the interval. */
export type CriterionKind = 'state' | 'seen' | 'never'

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

/**
 * One criterion of a check: its id, requirement and optional declared kind. Over frames, `state` judges the last
 * frame held, `seen` needs a witnessed appearance and never fails, and `never` forbids an appearance and passes only
 * on complete capture. Partial capture sets aside every pass and every state failure. The older `absence` marker
 * keeps its conservative sample rule. Older criteria without either mark use the state question.
 */
export type Criterion = { id: string; requirement: string } & (
  | { kind: CriterionKind; absence?: never }
  | { kind?: never; absence?: true }
)

/** Copy a criterion with cleaned requirement text, preserving exactly one declared marker. */
export function withCriterionRequirement(criterion: Criterion, requirement: string): Criterion {
  return criterion.kind === undefined
    ? { id: criterion.id, requirement, ...(criterion.absence === true ? { absence: true } : {}) }
    : { id: criterion.id, requirement, kind: criterion.kind }
}

/** The parts of an app's diagnostics a check may select as evidence: its console, or its network records. */
export type DiagnosticsPart = 'console' | 'network'

/**
 * Evidence as a check names it. The parent captures a `screenshot` of the app's page itself, at the moment it takes
 * the check; `app` defaults to the test's first app. `text` is text the check supplies. `recording` is the frames the
 * app's recording kept, from a named `step` of the attempt or over the `lastMs` milliseconds before the check.
 * `diagnostics` is the app's console or network records as the attempt kept them so far, sanitized and redacted.
 */
export type EvidenceSelector =
  | { kind: 'screenshot'; app?: string }
  | { kind: 'text'; text: string; label?: string }
  | { kind: 'recording'; app?: string; step: string }
  | { kind: 'recording'; app?: string; lastMs: number }
  | { kind: 'diagnostics'; app?: string; include: DiagnosticsPart[] }

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
 * One frame of a frame sequence as a record keeps it. `id` is how the judge cites it, `frameId` the id the capture
 * gave it, with the action or look it belongs to when the capture named one. `captureUs` is when it reached Retest,
 * on the run's clock in microseconds. `fate` is what the recording made of it: `shown` in the video, or `superseded`
 * by a later frame of the same tick, which is no loss; absent in records written before fates were kept. `path`,
 * `sha256` and `bytes` are of the image the judge received, as saved in the run folder; `width` and `height` its size
 * there, `sourceWidth` and `sourceHeight` the size it was captured at.
 */
export type FrameRecord = {
  id: string
  frameId: string
  actionId?: string
  observationId?: string
  captureUs: number
  fate?: 'shown' | 'superseded'
  format: 'png' | 'jpeg'
  path: string
  sha256: string
  bytes: number
  width: number
  height: number
  sourceWidth?: number
  sourceHeight?: number
}

/**
 * A stretch of a frame sequence's interval with no kept frame, on the run's clock in microseconds: how many frames
 * that reached the media process inside it were lost, by what became of them, and the codes the capture gave for its
 * own gaps there. A stretch with nothing lost and no code means no frame arrived; it never means nothing appeared.
 */
export type FrameStretchRecord = {
  fromUs: number
  toUs: number
  lost: { dropped: number; undecodable: number; outOfOrder: number; outOfRange: number; duplicate: number; queued: number; notStored: number }
  captureGaps: string[]
}

/**
 * A frame the media process returned that the judge did not receive, because the recording had not placed it: `pending`
 * in a recording still running, `unprocessed` when the recording ended before writing it. Its capture time is kept so
 * a reader sees where the judge had no picture.
 */
export type FrameNotSentRecord = { frameId: string; captureUs: number; fate: 'pending' | 'unprocessed' }

/**
 * Whether a piece of evidence is whole: `complete`, `partial` with what it lacks in `reason`, or `unavailable` with
 * why there is none. A frame sequence is complete only when the media process kept every frame that reached it in the
 * interval, sent all of them, placed every one it sent and found no capture gap or loss in it; a stretch in which no
 * frame arrived leaves it complete and is still listed. Even then its frames are samples of the screen.
 */
export type EvidenceStatus = 'complete' | 'partial' | 'unavailable'

/** What one diagnostics part held when a check took it: its capture state, and why when it was not complete. */
export type DiagnosticsPartRecord = { state: 'complete' | 'partial' | 'unavailable' | 'disabled'; reason?: string }

/**
 * One piece of evidence as a record keeps it: what identifies it, never its bytes or its text. `id` is how the judge
 * cites it. A screenshot names the app, the session and attempt that captured it, when it came back, and its file in
 * the run folder; with `testId`, `attemptId`, `app` and `sessionId` it carries the record identity every session's
 * record shares. `capturedElapsedMs` is when it came back on the run's clock, and `source` what took it, each present
 * only when the writer knew it. `sha256` and `bytes` are of what the judge received: a screenshot's PNG, or the text as
 * UTF-8 after redaction. `testId` is absent in runs recorded before records named it.
 *
 * A `frames` record names the recording's interval (`fromUs` and `toUs` on the run's clock, and the `step` it came
 * from when it came from one), each frame sent, the stretches with no kept frame and how many of the stretches there
 * were in all (`stretchesFound`), how many frames reached the media process inside the interval (`inInterval`), how many
 * it kept (`available`) and how many kept ones were left out (`omitted`), the frames it returned that the recording
 * had not placed (`framesNotSent`), and its `status` with the `reason`. Its `sha256` and `bytes` are of the manifest of
 * frames and stretches, and the frames' own bytes added up.
 *
 * A `diagnostics` record names the parts it selected (`include`), each part's state, the ids of the records the judge
 * received and how many more the bounds left out, its `status` with the `reason`, and the file holding the exact text
 * the judge received.
 */
export type EvidenceRecord = {
  id: string
  kind: 'screenshot' | 'text' | 'frames' | 'diagnostics'
  testId?: string
  app?: string
  sessionId?: string
  attemptId: string
  capturedAt: string
  capturedElapsedMs?: number
  source?: CaptureSourceName
  /** Native launch and capture reference, separate from a parent's observation id. */
  captureReference?: CaptureReference
  path?: string
  label?: string
  sha256: string
  bytes: number
  width?: number
  height?: number
  status?: EvidenceStatus
  reason?: string
  step?: string
  fromUs?: number
  toUs?: number
  frames?: FrameRecord[]
  stretches?: FrameStretchRecord[]
  stretchesFound?: number
  inInterval?: number
  available?: number
  omitted?: { byCount: number; byBytes: number; undecodable: number }
  framesNotSent?: FrameNotSentRecord[]
  include?: DiagnosticsPart[]
  console?: DiagnosticsPartRecord
  network?: DiagnosticsPartRecord
  records?: string[]
  recordsOmitted?: number
}

/**
 * A rule by which the parent decided a criterion over what the judge could say. `absence_over_frames`: the criterion
 * requires that something does not appear and its evidence includes frames of a recording, which are samples, so the
 * parent set aside a pass or a failure without a seen frame citation. `frames_incomplete` sets aside a pass or state
 * failure over partial capture. `seen_over_frames` leaves an unwitnessed appearance or a seen failure inconclusive.
 * `never_over_frames` leaves a never failure without a seen-frame citation inconclusive.
 */
export type CriterionRule = 'absence_over_frames' | 'frames_incomplete' | 'seen_over_frames' | 'never_over_frames'

/**
 * A criterion as a record keeps it, with the verdict that counts and the evidence the judge cited, when the judge gave
 * them. `kind` or the older `absence` is the criterion's own mark; `rule` names the parent's rule when it decided it, and
 * `judgeVerdict` what the judge answered when the parent's rule set it aside.
 */
export type CriterionRecord = Criterion & { verdict?: CriterionVerdict; citations?: string[]; rule?: CriterionRule; judgeVerdict?: CriterionVerdict }

/** A sampling setting a call may carry, as an evaluator record names it. */
export type SamplingSetting = 'temperature' | 'topP' | 'seed' | 'maxOutputTokens'

/** A sampling setting a call did not send as the evaluator was given it, with the reason its provider gave. */
export type UnsentSetting = { setting: SamplingSetting; reason: string }

/**
 * Who judged, as far as the evaluator says: the provider and model it named when it was set up, the model revision
 * the provider reported for this call, the evaluator's own version and the version of Retest's instructions, the
 * sampling settings the call sent, how long the call took and the tokens the provider counted, when it counted them.
 * A setting the evaluator was given that the call did not send as given is left out of `sampling` and named in
 * `samplingNotSent`, with the reason.
 */
export type EvaluatorRecord = {
  provider: string
  model: string
  modelRevision?: string
  evaluatorVersion: string
  promptVersion: string
  sampling?: { temperature?: number; topP?: number; seed?: number; maxOutputTokens?: number }
  samplingNotSent?: UnsentSetting[]
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

/**
 * Evidence a host names for one of its checks: a screenshot the parent captures after the body, text it supplies, the
 * frames an app's recording kept of a named step or of the `lastMs` milliseconds before the check, or the app's console
 * or network records as the attempt kept them.
 */
export type HostEvidence =
  | { readonly app?: string; readonly capture: 'screenshot' }
  | { readonly text: string; readonly label?: string }
  | { readonly app?: string; readonly recording: { readonly step: string } | { readonly lastMs: number } }
  | { readonly app?: string; readonly diagnostics: DiagnosticsPart | readonly DiagnosticsPart[] }

/** A host's absence requirement: a seen violation can fail it; samples cannot prove it. */
export type HostAbsence = { readonly requirement: string; readonly absence: true; readonly kind?: never }

/** A host criterion's explicit question over a recorded interval. */
export type HostCriterion = { readonly requirement: string; readonly kind: CriterionKind; readonly absence?: never }

/**
 * A required check a host declares for a test, which the parent runs itself after the test's body, on that attempt's
 * pages. `id` is the check's own name and never changes; `criteria` maps each criterion's id to its requirement, or to
 * `{ requirement, kind }` for its explicit question, or the older `{ requirement, absence: true }`. `judge` names one of the config's
 * judges, or the default judge when absent. Test code cannot skip, weaken or answer such a check.
 */
export type HostEvaluation = {
  readonly id: string
  readonly criteria: Readonly<Record<string, string | HostAbsence | HostCriterion>>
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
const criterionKindSchema = s.enum(['state', 'seen', 'never'])
// No present value is valid for the other marker. This keeps the exclusive schema and type identical.
const forbiddenMarkerSchema: Schema<never> = { kind: 'enum', values: [] }
const criterionSchema: Schema<Criterion> = s.union([
  s.object({ id: s.string(), requirement: s.string(), kind: s.optional(forbiddenMarkerSchema), absence: s.optional(s.literal(true)) }),
  s.object({ id: s.string(), requirement: s.string(), kind: criterionKindSchema, absence: s.optional(forbiddenMarkerSchema) }),
])
const diagnosticsPartSchema = s.enum(['console', 'network'])

// Two recording options share a kind, so the selector is a plain union: a recording names a step or a length, never both.
export const evidenceSelectorSchema: Schema<EvidenceSelector> = s.union([
  s.object({ kind: s.literal('screenshot'), app: s.optional(s.string()) }),
  s.object({ kind: s.literal('text'), text: s.string(), label: s.optional(s.string()) }),
  s.object({ kind: s.literal('recording'), app: s.optional(s.string()), step: s.string() }),
  s.object({ kind: s.literal('recording'), app: s.optional(s.string()), lastMs: s.number({ integer: true, min: 1 }) }),
  s.object({ kind: s.literal('diagnostics'), app: s.optional(s.string()), include: s.array(diagnosticsPartSchema) }),
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

const frameRecordSchema: Schema<FrameRecord> = s.object({
  id: s.string(),
  frameId: s.string(),
  actionId: s.optional(s.string()),
  observationId: s.optional(s.string()),
  captureUs: count,
  fate: s.optional(s.enum(['shown', 'superseded'])),
  format: s.enum(['png', 'jpeg']),
  path: s.string(),
  sha256: s.string(),
  bytes: count,
  width: count,
  height: count,
  sourceWidth: s.optional(count),
  sourceHeight: s.optional(count),
})

const frameStretchRecordSchema: Schema<FrameStretchRecord> = s.object({
  fromUs: count,
  toUs: count,
  lost: s.object({ dropped: count, undecodable: count, outOfOrder: count, outOfRange: count, duplicate: count, queued: count, notStored: count }),
  captureGaps: s.array(s.string()),
})

const frameNotSentRecordSchema: Schema<FrameNotSentRecord> = s.object({ frameId: s.string(), captureUs: count, fate: s.enum(['pending', 'unprocessed']) })

const diagnosticsPartRecordSchema: Schema<DiagnosticsPartRecord> = s.object({
  state: s.enum(['complete', 'partial', 'unavailable', 'disabled']),
  reason: s.optional(s.string()),
})

const evidenceRecordSchema: Schema<EvidenceRecord> = s.object({
  id: s.string(),
  kind: s.enum(['screenshot', 'text', 'frames', 'diagnostics']),
  testId: s.optional(s.string()),
  app: s.optional(s.string()),
  sessionId: s.optional(s.string()),
  attemptId: s.string(),
  capturedAt: s.string(),
  capturedElapsedMs: s.optional(count),
  source: s.optional(captureSourceNameSchema),
  captureReference: s.optional(s.object({ instance: s.string(), generation: count, observationId: s.string() })),
  path: s.optional(s.string()),
  label: s.optional(s.string()),
  sha256: s.string(),
  bytes: count,
  width: s.optional(count),
  height: s.optional(count),
  status: s.optional(s.enum(['complete', 'partial', 'unavailable'])),
  reason: s.optional(s.string()),
  step: s.optional(s.string()),
  fromUs: s.optional(count),
  toUs: s.optional(count),
  frames: s.optional(s.array(frameRecordSchema)),
  stretches: s.optional(s.array(frameStretchRecordSchema)),
  stretchesFound: s.optional(count),
  inInterval: s.optional(count),
  available: s.optional(count),
  omitted: s.optional(s.object({ byCount: count, byBytes: count, undecodable: count })),
  framesNotSent: s.optional(s.array(frameNotSentRecordSchema)),
  include: s.optional(s.array(diagnosticsPartSchema)),
  console: s.optional(diagnosticsPartRecordSchema),
  network: s.optional(diagnosticsPartRecordSchema),
  records: s.optional(s.array(s.string())),
  recordsOmitted: s.optional(count),
})

const criterionRecordFields = {
  id: s.string(),
  requirement: s.string(),
  verdict: s.optional(criterionVerdictSchema),
  citations: s.optional(s.array(s.string())),
  rule: s.optional(s.enum(['absence_over_frames', 'frames_incomplete', 'seen_over_frames', 'never_over_frames'])),
  judgeVerdict: s.optional(criterionVerdictSchema),
}
const criterionRecordSchema: Schema<CriterionRecord> = s.union([
  s.object({ ...criterionRecordFields, kind: s.optional(forbiddenMarkerSchema), absence: s.optional(s.literal(true)) }),
  s.object({ ...criterionRecordFields, kind: criterionKindSchema, absence: s.optional(forbiddenMarkerSchema) }),
])

// The sampling settings a record can name.
const samplingSettings = ['temperature', 'topP', 'seed', 'maxOutputTokens'] as const satisfies readonly SamplingSetting[]

export const unsentSettingSchema: Schema<UnsentSetting> = s.object({ setting: s.enum(samplingSettings), reason: s.string() })

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
  samplingNotSent: s.optional(s.array(unsentSettingSchema)),
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
    parse(hostEvaluationRecordSchema, record).ok ||
    parse(diagnosticsPartRecordSchema, record).ok
  )
}

/**
 * The evidence a host check names, as a list of selectors.
 *
 * @example hostEvidence({ capture: 'screenshot', app: 'web' }) // [{ kind: 'screenshot', app: 'web' }]
 */
export function hostEvidence(evidence: HostEvaluation['evidence']): EvidenceSelector[] {
  const list: readonly HostEvidence[] = isEvidenceList(evidence) ? evidence : [evidence]
  return list.map((item): EvidenceSelector => {
    const app = 'app' in item && item.app !== undefined ? { app: item.app } : {}
    if ('capture' in item) return { kind: 'screenshot', ...app }
    if ('recording' in item) return 'step' in item.recording ? { kind: 'recording', ...app, step: item.recording.step } : { kind: 'recording', ...app, lastMs: item.recording.lastMs }
    if ('diagnostics' in item) return { kind: 'diagnostics', ...app, include: diagnosticsParts(item.diagnostics) }
    return { kind: 'text', text: item.text, ...(item.label === undefined ? {} : { label: item.label }) }
  })
}

/**
 * A host check's criteria, in the order given, preserving the explicit kind or older absence marker.
 *
 * @example hostCriteria({ saved: 'Shown.', calm: { requirement: 'No error appears.', absence: true } })
 */
export function hostCriteria(criteria: HostEvaluation['criteria']): Criterion[] {
  return Object.entries(criteria).map(([id, given]) => (typeof given === 'string' ? { id, requirement: given } : given.kind !== undefined ? { id, requirement: given.requirement, kind: given.kind } : { id, requirement: given.requirement, absence: true }))
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
    criteria: hostCriteria(check.criteria),
    ...(check.context === undefined ? {} : { context: check.context }),
    evidence: hostEvidence(check.evidence),
    ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs }),
  }
}

// One part or several, each once, in the order console then network.
function diagnosticsParts(given: DiagnosticsPart | readonly DiagnosticsPart[]): DiagnosticsPart[] {
  const list: readonly DiagnosticsPart[] = typeof given === 'string' ? [given] : given
  return (['console', 'network'] as const).filter((part) => list.includes(part))
}

const hostEvaluationKeys = new Set(['id', 'criteria', 'evidence', 'judge', 'context', 'timeoutMs'])
const screenshotKeys = new Set(['app', 'capture'])
const textKeys = new Set(['text', 'label'])
const recordingKeys = new Set(['app', 'recording'])
const diagnosticsKeys = new Set(['app', 'diagnostics'])

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
    if (isPlainObject(requirement)) {
      if (!isAbsence(requirement) && !isKindRequirement(requirement)) add([...path, id], `expected the requirement as text, or { requirement, absence: true }, or { requirement, kind: 'state', 'seen' or 'never' }, received ${describeValue(requirement)}`)
    } else if (typeof requirement !== 'string' || requirement.trim() === '') add([...path, id], `expected the requirement as text, received ${describeValue(requirement)}`)
  }
}

function isAbsence(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const entry = defined(value)
  const keys = Object.keys(entry)
  return keys.length === 2 && entry['absence'] === true && typeof entry['requirement'] === 'string' && entry['requirement'].trim() !== ''
}

function isKindRequirement(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const entry = defined(value)
  return Object.keys(entry).length === 2 && (entry['kind'] === 'state' || entry['kind'] === 'seen' || entry['kind'] === 'never') && typeof entry['requirement'] === 'string' && entry['requirement'].trim() !== ''
}

const evidenceExpected = "expected { capture: 'screenshot' }, { text }, { recording: { step } or { lastMs } } or { diagnostics }"

function evidenceProblems(evidence: unknown, path: Path, add: AddProblem): void {
  if (evidence === undefined) return add(path, 'missing required key')
  const list = isArray(evidence) ? evidence : [evidence]
  if (list.length === 0) return add(path, 'expected at least one piece of evidence')
  for (const [index, item] of list.entries()) {
    const at = isArray(evidence) ? [...path, index] : path
    if (!isPlainObject(item)) {
      add(at, `${evidenceExpected}, received ${describeValue(item)}`)
      continue
    }
    const entry = defined(item)
    const keys = 'capture' in entry ? screenshotKeys : 'recording' in entry ? recordingKeys : 'diagnostics' in entry ? diagnosticsKeys : textKeys
    for (const key of Object.keys(entry)) if (!keys.has(key)) add([...at, key], 'unknown key')
    if ('app' in entry && typeof entry['app'] !== 'string') add([...at, 'app'], `expected string, received ${describeValue(entry['app'])}`)
    if ('capture' in entry) {
      if (entry['capture'] !== 'screenshot') add([...at, 'capture'], `expected "screenshot", received ${describeValue(entry['capture'])}`)
    } else if ('recording' in entry) {
      recordingProblem(entry['recording'], [...at, 'recording'], add)
    } else if ('diagnostics' in entry) {
      diagnosticsProblem(entry['diagnostics'], [...at, 'diagnostics'], add)
    } else {
      if (typeof entry['text'] !== 'string' || entry['text'] === '') add([...at, 'text'], `expected the text to judge, received ${describeValue(entry['text'])}`)
      if ('label' in entry && typeof entry['label'] !== 'string') add([...at, 'label'], `expected string, received ${describeValue(entry['label'])}`)
    }
  }
}

function recordingProblem(recording: unknown, path: Path, add: AddProblem): void {
  const entry = isPlainObject(recording) ? defined(recording) : undefined
  const keys = entry === undefined ? [] : Object.keys(entry)
  if (entry !== undefined && keys.length === 1 && typeof entry['step'] === 'string' && entry['step'] !== '') return
  if (entry !== undefined && keys.length === 1 && isBudget(entry['lastMs'])) return
  add(path, `expected { step } naming a step, or { lastMs } as a whole number of milliseconds from 1 to ${maxTimeout}, received ${describeValue(recording)}`)
}

function diagnosticsProblem(diagnostics: unknown, path: Path, add: AddProblem): void {
  const list = isArray(diagnostics) ? diagnostics : [diagnostics]
  const parts = new Set(list)
  if (list.length > 0 && parts.size === list.length && list.every((part) => part === 'console' || part === 'network')) return
  add(path, `expected "console", "network" or both in a list, each once, received ${describeValue(diagnostics)}`)
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
