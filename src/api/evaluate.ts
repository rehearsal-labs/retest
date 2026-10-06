import type { AppName, DefaultJudgeName, IsRegistered, JudgeAccepts, JudgeName, RetestTypeError } from '../config/register.ts'
import type { CriterionKind, DiagnosticsPart, EvaluationCall, EvaluationMode, EvidenceSelector } from '../protocol/evaluation.ts'
import { countsAsAssertion } from '../evaluation/policy.ts'
import { isName } from '../protocol/names.ts'
import { isArray, isPlainObject } from '../protocol/schema.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { requireScope } from './context.ts'
import { formatValue } from './format-value.ts'
import { misuse } from './misuse.ts'

type EvidenceApp = IsRegistered extends true ? AppName : string

/** A screenshot Retest's own process takes of an app's page as the check runs: `app` names it, the test's first app by default. */
export type ScreenshotEvidence = { readonly app?: EvidenceApp | undefined; readonly capture: 'screenshot' }

/** Text the check supplies, such as an answer the test read from the page. `label` says what it is. */
export type TextEvidence = { readonly text: string; readonly label?: string | undefined }

/**
 * The frames an app's recording kept, from a step of this attempt by its name, the latest step with that name, or over
 * the `lastMs` milliseconds before the check. A run that does not record the app refuses it by name. Frames are
 * samples. The declared criterion kind names the question; partial capture cannot support a pass, and a seen frame
 * may show a forbidden appearance.
 */
export type RecordingEvidence = { readonly app?: EvidenceApp | undefined; readonly recording: { readonly step: string } | { readonly lastMs: number } }

/**
 * The console or network records of an app as this attempt kept them so far, cleaned and redacted, which the judge
 * reads as text with each part's capture state. Nothing of an app's diagnostics is sent unless a check names it here.
 */
export type TextRecordsEvidence = { readonly app?: EvidenceApp | undefined; readonly diagnostics: DiagnosticsPart | readonly [DiagnosticsPart, ...DiagnosticsPart[]] }

/** The evidence a judge that takes `Kind` can receive: screenshots for `images`, text for `text`, frames for `frames`. */
export type EvidenceFor<Kind> =
  | ('images' extends Kind ? ScreenshotEvidence : never)
  | ('text' extends Kind ? TextEvidence : never)
  | ('frames' extends Kind ? RecordingEvidence : never)

/** Diagnostics records, which a judge that takes `text` reads as text. */
export type DiagnosticsFor<Kind> = 'text' extends Kind ? TextRecordsEvidence : never

/** One piece of evidence a check of the judge `Judge` may name. */
export type EvidenceItem<Judge extends JudgeName> = EvidenceFor<JudgeAccepts<Judge>> | DiagnosticsFor<JudgeAccepts<Judge>>

/** A requirement that something does not appear. A seen frame may violate it, but sampled frames cannot prove it. */
export type AbsenceRequirement = { readonly requirement: string; readonly absence: true; readonly kind?: never }

/** Over frames, `state` checks the last frame held, `seen` asks for an appearance, and `never` forbids one. */
export type CriterionRequirement = { readonly requirement: string; readonly kind: CriterionKind; readonly absence?: never }

type JudgeChoice<Judge> = [DefaultJudgeName] extends [never] ? { readonly judge: Judge } : { readonly judge?: Judge | undefined }

/**
 * One AI check. `requirement` is what the evidence must show, decided before the judge sees anything: a sentence, or
 * criteria by id, each of which must pass. A criterion given as `{ requirement, kind }` names an end `state`, a
 * required appearance `seen`, or a forbidden appearance `never`. The older `{ requirement, absence: true }` keeps
 * its conservative sample rule. `evidence` is what the judge looks at, one item or several. `judge` names one
 * of the config's judges, the default judge when left out. `context` is reference text the judge may read, such as a
 * policy an answer must follow. `mode` is `required` by default; an `advisory` check only records a warning.
 * `timeoutMs` may shorten the check's time, never lengthen what the test has left.
 */
export type EvaluateOptions<Judge extends JudgeName = DefaultJudgeName & JudgeName> = JudgeChoice<Judge> & {
  readonly requirement: string | Readonly<Record<string, string | AbsenceRequirement | CriterionRequirement>>
  // Written out rather than as one alias, so a type error names each kind of evidence the judge takes.
  readonly evidence: EvidenceFor<JudgeAccepts<Judge>> | DiagnosticsFor<JudgeAccepts<Judge>> | readonly [EvidenceItem<Judge>, ...EvidenceItem<Judge>[]]
  readonly context?: string | undefined
  readonly mode?: EvaluationMode | undefined
  readonly timeoutMs?: number | undefined
}

/** `test.evaluate`'s argument: the check, once the config declares a judge. */
export type EvaluateCheck<Judge extends JudgeName = DefaultJudgeName & JudgeName> = [JudgeName] extends [never]
  ? RetestTypeError<'Declare a judge under evaluation.judges in retest.config.ts before a test uses test.evaluate.'>
  : EvaluateOptions<Judge>

const checkKeys = new Set(['judge', 'requirement', 'evidence', 'context', 'mode', 'timeoutMs'])
const modes: readonly EvaluationMode[] = ['required', 'advisory']

/**
 * Asks Retest's own process to judge evidence against a requirement. That process captures the evidence, calls the
 * judge, checks its answer and records the verdict; this process only names what to judge. A required check that does
 * not pass fails the test whatever the test does with the promise, and counts as an assertion only when its judge gave a
 * valid pass or fail. Every argument is checked, because JavaScript callers have no types.
 *
 * @example await test.evaluate({ requirement: 'The message says the task was saved.', evidence: { capture: 'screenshot' } })
 */
export function evaluate(check: unknown): Promise<void> {
  const { run } = requireScope('test.evaluate()')
  const location = run.location()
  const read = readCheck(check)
  if (typeof read === 'string') throw misuse(`test.evaluate() ${read}`, run)
  const { call } = read
  // The check holds the look lane of every app whose page it screenshots, the test's first app when it names none, so
  // no action runs there while the screenshot is taken. Frames and diagnostics are read from what the run kept, not
  // from the page, so they hold no lane.
  const [firstApp] = run.apps
  const apps = [...new Set(call.evidence.flatMap((selector) => (selector.kind === 'screenshot' ? [selector.app ?? firstApp ?? ''] : [])))]
  return run.assertion('test.evaluate()', location, async () => {
    const answer = await run.requestEvaluation(call, location)
    if (countsAsAssertion(answer.mode, answer.verdict)) run.countAssertion()
    if (answer.mode === 'required' && answer.verdict !== 'pass') {
      throw run.fail(answer.failure ?? { class: 'evaluation_error', message: `The AI check ${answer.checkId} did not pass.`, ...(location === undefined ? {} : { location }) })
    }
  }, apps)
}

type ReadCheck = { call: EvaluationCall }

function readCheck(value: unknown): ReadCheck | string {
  if (!isPlainObject(value)) return `takes a check: { requirement, evidence }, received ${formatValue(value)}.`
  const given = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
  const unknown = Object.keys(given).find((key) => !checkKeys.has(key))
  if (unknown !== undefined) return `has no option ${JSON.stringify(unknown)}. It takes judge, requirement, evidence, context, mode and timeoutMs.`
  const { judge, requirement, evidence, context, mode, timeoutMs } = given
  if (judge !== undefined && typeof judge !== 'string') return `takes judge as the name of one of the config's judges, received ${formatValue(judge)}.`
  if (context !== undefined && typeof context !== 'string') return `takes context as text, received ${formatValue(context)}.`
  const chosen = mode === undefined ? 'required' : modes.find((each) => each === mode)
  if (chosen === undefined) return `takes mode as "required" or "advisory", received ${formatValue(mode)}.`
  if (timeoutMs !== undefined && !isBudget(timeoutMs)) return `takes timeoutMs as a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(timeoutMs)}.`
  const criteria = readCriteria(requirement)
  if (typeof criteria === 'string') return criteria
  const selectors = readEvidence(evidence)
  if (typeof selectors === 'string') return selectors
  const call: EvaluationCall = {
    ...(judge === undefined ? {} : { judge }),
    criteria,
    ...(context === undefined ? {} : { context }),
    evidence: selectors,
    mode: chosen,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  }
  return { call }
}

function readCriteria(requirement: unknown): EvaluationCall['criteria'] | string {
  if (typeof requirement === 'string') {
    return requirement.trim() === '' ? 'takes a requirement to judge, received an empty string.' : [{ id: 'requirement', requirement }]
  }
  if (!isPlainObject(requirement) || Object.keys(requirement).length === 0) {
    return `takes requirement as a sentence, or criteria by id such as { saved: 'The task shows as saved.' }, received ${formatValue(requirement)}.`
  }
  const criteria: EvaluationCall['criteria'] = []
  for (const [id, given] of Object.entries(requirement)) {
    if (!isName(id)) return `takes criterion ids of letters, digits, "_" and "-" that start with a letter, received ${JSON.stringify(id)}.`
    if (isPlainObject(given) && 'kind' in given) {
      const { kind, requirement: text } = given
      if ((kind !== 'state' && kind !== 'seen' && kind !== 'never') || typeof text !== 'string' || text.trim() === '' || !onlyKeys(given, ['kind', 'requirement'])) return `takes the requirement of ${id} as { requirement, kind: 'state', 'seen' or 'never' }, received ${formatValue(given)}.`
      criteria.push({ id, requirement: text, kind })
      continue
    }
    const absence = readAbsence(given)
    if (absence !== undefined) {
      criteria.push({ id, requirement: absence, absence: true })
      continue
    }
    if (typeof given !== 'string' || given.trim() === '') return `takes the requirement of ${id} as text, or as { requirement, absence: true }, received ${formatValue(given)}.`
    criteria.push({ id, requirement: given })
  }
  return criteria
}

// A criterion that says something must not appear: exactly its requirement and the mark.
function readAbsence(given: unknown): string | undefined {
  if (!isPlainObject(given)) return undefined
  const requirement = given['requirement']
  const keys = Object.keys(given).filter((key) => given[key] !== undefined)
  if (given['absence'] !== true || typeof requirement !== 'string' || requirement.trim() === '' || keys.length !== 2) return undefined
  return requirement
}

function readEvidence(evidence: unknown): EvidenceSelector[] | string {
  const list = isArray(evidence) ? evidence : [evidence]
  if (list.length === 0) return 'takes at least one piece of evidence.'
  const selectors: EvidenceSelector[] = []
  for (const item of list) {
    const selector = readSelector(item)
    if (typeof selector === 'string') return selector
    selectors.push(selector)
  }
  return selectors
}

function readSelector(item: unknown): EvidenceSelector | string {
  const expected = "takes evidence as { capture: 'screenshot', app? }, { text, label? }, { recording: { step } or { lastMs }, app? } or { diagnostics: 'console', 'network' or both, app? }"
  if (!isPlainObject(item)) return `${expected}, received ${formatValue(item)}.`
  const entry = Object.fromEntries(Object.entries(item).filter(([, value]) => value !== undefined))
  const app = entry['app']
  if (app !== undefined && typeof app !== 'string') return `takes evidence's app as the name of an app, received ${formatValue(app)}.`
  const named = typeof app === 'string' ? { app } : {}
  if ('capture' in entry) {
    if (entry['capture'] !== 'screenshot' || !onlyKeys(entry, ['capture', 'app'])) return `${expected}, received ${formatValue(item)}.`
    return { kind: 'screenshot', ...named }
  }
  if ('text' in entry) {
    const { text, label } = entry
    if (typeof text !== 'string' || text === '' || (label !== undefined && typeof label !== 'string') || !onlyKeys(entry, ['text', 'label'])) return `${expected}, received ${formatValue(item)}.`
    return { kind: 'text', text, ...(typeof label === 'string' ? { label } : {}) }
  }
  if ('diagnostics' in entry) {
    const include = readParts(entry['diagnostics'])
    if (include === undefined || !onlyKeys(entry, ['diagnostics', 'app'])) return `${expected}, received ${formatValue(item)}.`
    return { kind: 'diagnostics', ...named, include }
  }
  const recording = entry['recording']
  if (!isPlainObject(recording) || !onlyKeys(entry, ['recording', 'app'])) return `${expected}, received ${formatValue(item)}.`
  const keys = Object.keys(recording).filter((key) => recording[key] !== undefined)
  const step = recording['step']
  const lastMs = recording['lastMs']
  if (keys.length === 1 && typeof step === 'string' && step !== '') return { kind: 'recording', ...named, step }
  if (keys.length === 1 && isBudget(lastMs) && typeof lastMs === 'number') return { kind: 'recording', ...named, lastMs }
  return `takes a recording as { step } naming a step of the test, or { lastMs } as a whole number of milliseconds from 1 to ${maxTimeout}, received ${formatValue(recording)}.`
}

// One part or several, each once, kept in the order console then network.
function readParts(given: unknown): DiagnosticsPart[] | undefined {
  const list: readonly unknown[] = isArray(given) ? given : [given]
  if (list.length === 0 || new Set(list).size !== list.length || !list.every((part) => part === 'console' || part === 'network')) return undefined
  return (['console', 'network'] as const).filter((part) => list.includes(part))
}

function onlyKeys(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(entry).every((key) => keys.includes(key))
}

function isBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxTimeout
}
