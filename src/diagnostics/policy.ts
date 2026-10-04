import type { DiagnosticsConfig } from '../config/types.ts'
import type { DiagnosticLimits, DiagnosticRecord, DiagnosticsPolicyRecord, DiagnosticsSummary } from '../protocol/diagnostics.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Path } from '../protocol/schema.ts'
import { Problems } from '../config/problems.ts'
import { defaultDiagnosticLimits } from '../protocol/diagnostics.ts'
import { failure, withAlso } from '../protocol/failures.ts'
import { describeValue, isPlainObject, s } from '../protocol/schema.ts'

/** What a declared strict policy fails a test for. `allow` lists text that, found in a record, leaves it uncounted. */
export type StrictRules = {
  readonly runtimeErrors: boolean
  readonly consoleErrors: boolean
  readonly transportFailures: boolean
  readonly httpErrors: boolean
  readonly allow: readonly string[]
}

/** How a run captures and judges diagnostics, with every default filled in. */
export type DiagnosticsPolicy = {
  readonly capture: boolean
  readonly strict: StrictRules | undefined
  readonly requireComplete: boolean
  readonly limits: DiagnosticLimits
}

/** Capture on, nothing strict, nothing required, the default limits. */
export const defaultDiagnosticsPolicy: DiagnosticsPolicy = Object.freeze({ capture: true, strict: undefined, requireComplete: false, limits: defaultDiagnosticLimits })

const diagnosticsKeys = new Set(['capture', 'strict', 'requireComplete', 'limits'])
const strictKeys = new Set(['runtimeErrors', 'consoleErrors', 'transportFailures', 'httpErrors', 'allow'])
const limitNames = Object.keys(defaultDiagnosticLimits)
// How many matching records a strict failure names by id; the count says how many there were.
const namedMatches = 20

/**
 * Reads a `diagnostics` block, from a config or from `RunOptions`, into a policy. Returns undefined when the block is
 * absent or wrong; the caller checks `problems`. A strict or required policy with capture turned off is refused, since
 * it could never be met.
 *
 * @example readDiagnostics({ strict: { runtimeErrors: true } }, problems)?.strict?.runtimeErrors // true
 */
export function readDiagnostics(value: unknown, problems: Problems, path: Path = ['diagnostics']): DiagnosticsPolicy | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    problems.add(path, `expected object, received ${describeValue(value)}`)
    return undefined
  }
  const before = problems.issues.length
  for (const key of Object.keys(value)) if (!diagnosticsKeys.has(key)) problems.add([...path, key], 'unknown key')
  const capture = value['capture'] === undefined ? true : problems.check(s.boolean(), value['capture'], [...path, 'capture'])
  const requireComplete = value['requireComplete'] === undefined ? false : problems.check(s.boolean(), value['requireComplete'], [...path, 'requireComplete'])
  const strict = readStrict(value['strict'], problems, [...path, 'strict'])
  const limits = readLimits(value['limits'], problems, [...path, 'limits'])
  if (capture === false && requireComplete === true) problems.add([...path, 'requireComplete'], 'cannot be true while capture is false')
  if (capture === false && strict !== undefined) problems.add([...path, 'strict'], 'cannot be set while capture is false')
  if (problems.issues.length > before || capture === undefined || requireComplete === undefined) return undefined
  return { capture, strict, requireComplete, limits }
}

/**
 * The policy a run follows: the host's `RunOptions.diagnostics` when given, whole, or else the config's, or else the
 * default. A host block that cannot be read is a usage failure that names every key at fault.
 *
 * @example resolveDiagnostics(undefined, undefined) // { ok: true, policy: defaultDiagnosticsPolicy }
 */
export function resolveDiagnostics(options: DiagnosticsConfig | undefined, configured: DiagnosticsPolicy | undefined): { ok: true; policy: DiagnosticsPolicy } | { ok: false; failure: Failure } {
  if (options === undefined) return { ok: true, policy: configured ?? defaultDiagnosticsPolicy }
  const problems = new Problems()
  const policy = readDiagnostics(withoutUndefined(options), problems)
  if (policy !== undefined && problems.issues.length === 0) return { ok: true, policy }
  const lines = problems.issues.map(({ key, message }) => `${key}: ${message}`)
  const counted = lines.length === 1 ? 'has a problem' : `has ${lines.length} problems`
  return { ok: false, failure: { class: 'usage', message: `RunOptions.diagnostics ${counted}: ${lines.join('; ')}`, details: { key: problems.issues[0]?.key ?? 'diagnostics' } } }
}

/**
 * The policy as `diagnostics.started` records it, or undefined when nothing is strict or required.
 *
 * @example recordedPolicy({ ...defaultDiagnosticsPolicy, requireComplete: true }) // { requireComplete: true }
 */
export function recordedPolicy(policy: DiagnosticsPolicy): DiagnosticsPolicyRecord | undefined {
  const { strict } = policy
  const rules = strict === undefined ? undefined : {
    ...(strict.runtimeErrors ? { runtimeErrors: true as const } : {}),
    ...(strict.consoleErrors ? { consoleErrors: true as const } : {}),
    ...(strict.transportFailures ? { transportFailures: true as const } : {}),
    ...(strict.httpErrors ? { httpErrors: true as const } : {}),
    ...(strict.allow.length === 0 ? {} : { allow: [...strict.allow] }),
  }
  const recorded = { ...(rules === undefined ? {} : { strict: rules }), ...(policy.requireComplete ? { requireComplete: true as const } : {}) }
  return Object.keys(recorded).length === 0 ? undefined : recorded
}

/**
 * A record a strict policy counted: the rule it broke, the text an `allow` entry is looked for in (its message, or its
 * request's address), and the record's id. The failure names the id; the text stays in the artifact.
 */
export type StrictMatch = { record: DiagnosticRecord; rule: keyof Omit<StrictRules, 'allow'>; text: string; id: string }

/**
 * The records a strict policy fails a test for, in the order they arrived: uncaught errors and unhandled rejections the
 * page did not handle later, console errors written by the page's own code or its workers, hops that failed in
 * transport (a cancelled request is not one, nor a failure that ends an answer with an error status, which the status
 * already counts), and responses with a status of 400 or more. A record whose text
 * or address holds an `allow` entry is not counted. Records that were dropped at a limit were never read, so a strict
 * policy says nothing of them: `requireComplete` is what refuses a capture that dropped any.
 *
 * @example strictMatches(records, rules).length
 */
export function strictMatches(records: readonly DiagnosticRecord[], rules: StrictRules): StrictMatch[] {
  const hops = new Map<string, Hop>()
  const matches: StrictMatch[] = []
  const allowed = (text: string): boolean => rules.allow.some((entry) => entry !== '' && text.includes(entry))
  for (const record of records) {
    const key = 'requestId' in record && record.type !== 'console' ? `${record.sessionId} ${record.requestId}` : undefined
    if (record.type === 'network.request' && key !== undefined) hops.set(key, { url: record.url, status: undefined })
    const hop = key === undefined ? undefined : hops.get(key)
    const match = strictMatch(record, rules, hop)
    if (record.type === 'network.response' && hop !== undefined) hop.status = record.status
    if (match !== undefined && !allowed(match.text)) matches.push(match)
  }
  return matches
}

/** What strict reads of a request when it judges its later records: its address, and the status it was answered with. */
type Hop = { url: string; status: number | undefined }

/**
 * The failure a declared policy gives an attempt, from its records and each session's summary, or undefined when the
 * policy is met. A strict policy that matched fails the test as `host_check_failed`: the check is the run's, and test
 * code cannot answer it. A strict rule whose capture is not complete in every session cannot be judged, and keeps the
 * test from passing as `reporting_failed`; so does a required capture that is not complete, since what the run had to
 * record was not all recorded.
 *
 * @example policyFailure(policy, records, summaries)?.class // 'host_check_failed'
 */
export function policyFailure(policy: DiagnosticsPolicy, records: readonly DiagnosticRecord[], summaries: readonly DiagnosticsSummary[]): Failure | undefined {
  const { strict } = policy
  const found = strict === undefined ? undefined : strictFailure(strictMatches(records, strict), summaries)
  // A rule never passes on capture that was not all there: no record found is not a record that was never written.
  const unjudged = strict === undefined ? undefined : unjudgedFailure(strict, summaries)
  const incomplete = policy.requireComplete ? incompleteFailure(summaries) : undefined
  const [first, ...rest] = [found, unjudged, incomplete].filter((each): each is Failure => each !== undefined)
  return first === undefined ? undefined : withAlso(first, rest)
}

/**
 * The attempt's failure once its diagnostics are judged. A failure the test already had stays first, whatever the
 * diagnostics say; the policy's failure follows it in `details.also`.
 *
 * @example withDiagnosticsFailure(checkFailed, undefined) // checkFailed
 */
export function withDiagnosticsFailure(verdict: Failure | undefined, diagnostics: Failure | undefined): Failure | undefined {
  if (diagnostics === undefined) return verdict
  return verdict === undefined ? diagnostics : withAlso(verdict, [diagnostics])
}

// A failure after an HTTP error status on the same request is how Chrome ends an error answer with no body; the status
// already counts it, so it is not a transport failure too.
function strictMatch(record: DiagnosticRecord, rules: StrictRules, hop: Hop | undefined): StrictMatch | undefined {
  switch (record.type) {
    case 'runtime_error':
      if (!rules.runtimeErrors || record.handledLater === true) return undefined
      return { record, rule: 'runtimeErrors', text: record.message.text, id: record.id }
    case 'console':
      if (!rules.consoleErrors || record.level !== 'error' || record.origin === 'browser') return undefined
      return { record, rule: 'consoleErrors', text: record.text.text, id: record.id }
    case 'network.failed':
      if (!rules.transportFailures || record.canceled === true || (hop?.status ?? 0) >= 400) return undefined
      return { record, rule: 'transportFailures', text: hop?.url ?? '', id: record.requestId }
    case 'network.response':
      if (!rules.httpErrors || record.status < 400) return undefined
      return { record, rule: 'httpErrors', text: hop?.url ?? '', id: record.requestId }
    default:
      return undefined
  }
}

const ruleOrder: readonly StrictMatch['rule'][] = ['runtimeErrors', 'consoleErrors', 'transportFailures', 'httpErrors']
const ruleWords: Record<StrictMatch['rule'], [string, string]> = {
  runtimeErrors: ['runtime error', 'runtime errors'],
  consoleErrors: ['console error', 'console errors'],
  transportFailures: ['failed request', 'failed requests'],
  httpErrors: ['HTTP error response', 'HTTP error responses'],
}

// The failure names each record by its session and id, and where its artifact is. Page text never enters a failure,
// so a page cannot write a line into a report.
function strictFailure(matches: readonly StrictMatch[], summaries: readonly DiagnosticsSummary[]): Failure | undefined {
  if (matches.length === 0) return undefined
  const counted = ruleOrder.flatMap((rule) => {
    const found = matches.filter((match) => match.rule === rule).length
    const [one, many] = ruleWords[rule]
    return found === 0 ? [] : [`${found} ${found === 1 ? one : many}`]
  })
  const named = new Map<string, string[]>()
  for (const match of matches.slice(0, namedMatches)) named.set(match.record.sessionId, [...(named.get(match.record.sessionId) ?? []), match.id])
  const sessions = [...named].map(([sessionId, ids]) => {
    const path = summaries.find((summary) => summary.sessionId === sessionId)?.path
    return `${sessionId} ${ids.join(', ')}${path === undefined ? '' : ` in ${path}`}`
  })
  const more = matches.length > namedMatches ? `, and ${matches.length - namedMatches} more` : ''
  const message = `The diagnostics policy failed the test: its pages had ${listed(counted)}, and the policy allows none. Records: ${sessions.join('; ')}${more}.`
  return { ...failure('host_check_failed', message), details: { policy: 'diagnostics.strict', matches: matches.length } }
}

const ruleKinds: Record<StrictMatch['rule'], 'console' | 'network'> = { runtimeErrors: 'console', consoleErrors: 'console', transportFailures: 'network', httpErrors: 'network' }

// Each kind a declared rule reads must be complete in every session, or the rule cannot be judged.
function unjudgedFailure(rules: StrictRules, summaries: readonly DiagnosticsSummary[]): Failure | undefined {
  const kinds = new Set(ruleOrder.filter((rule) => rules[rule]).map((rule) => ruleKinds[rule]))
  const gaps = summaries.flatMap((summary) => [...kinds].flatMap((kind) => (summary[kind].state === 'complete' ? [] : [`${summary.sessionId} ${kind} ${describeGap(summary[kind])}`])))
  for (const summary of summaries) {
    if (summary.scope?.source === 'owned_app' && (rules.runtimeErrors || rules.consoleErrors)) gaps.push(`${summary.sessionId} app stdout supplies no runtime-error or console-error classification`)
  }
  if (gaps.length === 0) return undefined
  const message = `The diagnostics policy could not judge the test: its strict rules read capture that was not complete, so a record they would count may be missing: ${gaps.join('; ')}.`
  return { ...failure('reporting_failed', message), details: { policy: 'diagnostics.strict' } }
}

function incompleteFailure(summaries: readonly DiagnosticsSummary[]): Failure | undefined {
  const gaps = summaries.flatMap((summary) => [
    ...(summary.console.state === 'complete' ? [] : [`${summary.sessionId} console ${describeGap(summary.console)}`]),
    ...(summary.network.state === 'complete' ? [] : [`${summary.sessionId} network ${describeGap(summary.network)}`]),
  ])
  if (gaps.length === 0) return undefined
  const message = `The diagnostics policy requires complete capture, and it was not complete: ${gaps.join('; ')}.`
  return { ...failure('reporting_failed', message), details: { policy: 'diagnostics.requireComplete' } }
}

function describeGap(capture: DiagnosticsSummary['console'] | DiagnosticsSummary['network']): string {
  if (capture.state === 'complete') return 'was complete'
  return capture.state === 'disabled' ? 'was disabled' : `was ${capture.state}: ${capture.reason}`
}

function listed(parts: readonly string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1) ?? ''}`
}

function readStrict(value: unknown, problems: Problems, path: Path): StrictRules | undefined {
  if (value === undefined) return undefined
  if (!isPlainObject(value)) {
    problems.add(path, `expected object, received ${describeValue(value)}`)
    return undefined
  }
  for (const key of Object.keys(value)) if (!strictKeys.has(key)) problems.add([...path, key], 'unknown key')
  const flag = (key: string): boolean => (value[key] === undefined ? false : (problems.check(s.boolean(), value[key], [...path, key]) ?? false))
  const allow = value['allow'] === undefined ? [] : (problems.check(s.array(s.string()), value['allow'], [...path, 'allow']) ?? [])
  for (const [index, entry] of allow.entries()) if (entry === '') problems.add([...path, 'allow', index], 'expected text to look for, received an empty string')
  const rules = { runtimeErrors: flag('runtimeErrors'), consoleErrors: flag('consoleErrors'), transportFailures: flag('transportFailures'), httpErrors: flag('httpErrors'), allow }
  if (!rules.runtimeErrors && !rules.consoleErrors && !rules.transportFailures && !rules.httpErrors) problems.add(path, 'expected at least one of runtimeErrors, consoleErrors, transportFailures and httpErrors set to true')
  return rules
}

function readLimits(value: unknown, problems: Problems, path: Path): DiagnosticLimits {
  if (value === undefined) return defaultDiagnosticLimits
  if (!isPlainObject(value)) {
    problems.add(path, `expected object, received ${describeValue(value)}`)
    return defaultDiagnosticLimits
  }
  const limits: Record<string, number> = { ...defaultDiagnosticLimits }
  for (const [key, entry] of Object.entries(value)) {
    if (!limitNames.includes(key)) {
      problems.add([...path, key], 'unknown key')
      continue
    }
    if (entry === undefined) continue
    const minimum = key === 'textLength' ? 1 : 0
    const read = problems.check(s.number({ integer: true, min: minimum }), entry, [...path, key])
    if (read !== undefined) limits[key] = read
  }
  return {
    consoleEntries: limits['consoleEntries'] ?? defaultDiagnosticLimits.consoleEntries,
    consoleBytes: limits['consoleBytes'] ?? defaultDiagnosticLimits.consoleBytes,
    requests: limits['requests'] ?? defaultDiagnosticLimits.requests,
    networkBytes: limits['networkBytes'] ?? defaultDiagnosticLimits.networkBytes,
    textLength: limits['textLength'] ?? defaultDiagnosticLimits.textLength,
    stackFrames: limits['stackFrames'] ?? defaultDiagnosticLimits.stackFrames,
  }
}

// A key set to undefined counts as absent, as it does in a config.
function withoutUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item: unknown) => withoutUndefined(item))
  if (!isPlainObject(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key, entry]) => [key, withoutUndefined(entry)]))
}
