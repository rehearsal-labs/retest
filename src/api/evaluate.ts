import type { AppName, DefaultJudgeName, IsRegistered, JudgeAccepts, JudgeName, RetestTypeError } from '../config/register.ts'
import type { EvaluationCall, EvaluationMode, EvidenceSelector } from '../protocol/evaluation.ts'
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

/** The frames of a recorded step. Retest records no steps yet, so a run refuses this evidence by name. */
export type RecordingEvidence = { readonly app?: EvidenceApp | undefined; readonly recording: { readonly step: string } }

/** The evidence a judge that takes `Kind` can receive: screenshots for `images`, text for `text`, frames for `frames`. */
export type EvidenceFor<Kind> =
  | ('images' extends Kind ? ScreenshotEvidence : never)
  | ('text' extends Kind ? TextEvidence : never)
  | ('frames' extends Kind ? RecordingEvidence : never)

type JudgeChoice<Judge> = [DefaultJudgeName] extends [never] ? { readonly judge: Judge } : { readonly judge?: Judge | undefined }

/**
 * One AI check. `requirement` is what the evidence must show, decided before the judge sees anything: a sentence, or
 * criteria by id, each of which must pass. `evidence` is what the judge looks at, one item or several. `judge` names one
 * of the config's judges, the default judge when left out. `context` is reference text the judge may read, such as a
 * policy an answer must follow. `mode` is `required` by default; an `advisory` check only records a warning.
 * `timeoutMs` may shorten the check's time, never lengthen what the test has left.
 */
export type EvaluateOptions<Judge extends JudgeName = DefaultJudgeName & JudgeName> = JudgeChoice<Judge> & {
  readonly requirement: string | Readonly<Record<string, string>>
  readonly evidence: EvidenceFor<JudgeAccepts<Judge>> | readonly [EvidenceFor<JudgeAccepts<Judge>>, ...EvidenceFor<JudgeAccepts<Judge>>[]]
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
  // The check holds the look lane of every app whose page it captures, the test's first app when it names none, so no
  // action runs there while the screenshot is taken.
  const [firstApp] = run.apps
  const apps = [...new Set(call.evidence.flatMap((selector) => (selector.kind === 'text' ? [] : [selector.app ?? firstApp ?? ''])))]
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
  for (const [id, text] of Object.entries(requirement)) {
    if (!isName(id)) return `takes criterion ids of letters, digits, "_" and "-" that start with a letter, received ${JSON.stringify(id)}.`
    if (typeof text !== 'string' || text.trim() === '') return `takes the requirement of ${id} as text, received ${formatValue(text)}.`
    criteria.push({ id, requirement: text })
  }
  return criteria
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
  const expected = "takes evidence as { capture: 'screenshot', app? }, { text, label? } or { recording: { step }, app? }"
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
  const recording = entry['recording']
  const step = isPlainObject(recording) ? recording['step'] : undefined
  if (typeof step !== 'string' || !onlyKeys(entry, ['recording', 'app'])) return `${expected}, received ${formatValue(item)}.`
  return { kind: 'recording', ...named, step }
}

function onlyKeys(entry: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(entry).every((key) => keys.includes(key))
}

function isBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxTimeout
}
