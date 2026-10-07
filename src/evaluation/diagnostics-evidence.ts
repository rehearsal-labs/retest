import type { DiagnosticRecord } from '../protocol/diagnostics.ts'
import type { DiagnosticsPart, DiagnosticsPartRecord, EvidenceRecord, EvidenceSelector, EvidenceStatus } from '../protocol/evaluation.ts'
import type { RunStore } from '../store/run-store.ts'
import type { JudgedEvidence } from './contract.ts'
import { createHash } from 'node:crypto'
import { mapRecordText } from '../diagnostics/artifact.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage } from '../protocol/failures.ts'
import { slug } from '../protocol/run-folder.ts'

/**
 * What an attempt's capture of one app has kept so far: its session, each part's capture state with why when it is
 * not complete, and the records, already cleaned and redacted as the capture keeps them.
 */
export type DiagnosticsSnapshot = {
  readonly sessionId: string
  readonly console: DiagnosticsPartRecord
  readonly network: DiagnosticsPartRecord
  readonly records: readonly DiagnosticRecord[]
}

/**
 * What an attempt's diagnostics checks need from the run: a snapshot of what each app's capture has kept so far. A run
 * that gives none leaves every selected part unavailable, and the check says so.
 */
export interface AttemptDiagnosticsView {
  snapshot(app: string): DiagnosticsSnapshot | undefined
}

/** Diagnostics evidence the parent holds: the text the judge receives, and what the record keeps. */
export type HeldDiagnostics = { judged: Extract<JudgedEvidence, { kind: 'text' }>; record: EvidenceRecord }

export type DiagnosticsProblem = { kind: 'missing' | 'refused'; reason: string; record: EvidenceRecord }

export type GatheredDiagnostics = { ok: true; value: HeldDiagnostics } | { ok: false; problem: DiagnosticsProblem }

export type DiagnosticsOptions = {
  id: string
  selector: Extract<EvidenceSelector, { kind: 'diagnostics' }>
  app: string
  view: AttemptDiagnosticsView | undefined
  store: Pick<RunStore, 'elapsedMs' | 'writeArtifact'>
  redact: (text: string) => string
  testId: string
  attemptId: string
  checkId: string
  maxRecords: number
}

const noView = 'the run gave this check no diagnostics of the app'

/**
 * Takes the console or network records of an app that a check selected, never any it did not: the newest
 * `maxRecords` of the selected parts, each passed through the run's redactor again, as the redactor may have learned a
 * value since the capture kept it, with the identity fields every record repeats left out. The judge receives them as
 * one text, JSON with each part's capture state; the record names the parts, their states, the ids sent and how many
 * the bound left out, and keeps the exact text in the run folder. A check whose selected parts are all unavailable or
 * off has nothing to judge and is left without its evidence.
 *
 * @example const gathered = gatherDiagnostics({ id: 'e2', selector, app: 'web', ...options })
 */
export function gatherDiagnostics(options: DiagnosticsOptions): GatheredDiagnostics {
  const { id, selector, app, view } = options
  const snapshot = view?.snapshot(app)
  if (snapshot !== undefined && (snapshot.sessionId !== formatSessionId(options.attemptId, app) || snapshot.records.some((each) => each.testId !== options.testId || each.attemptId !== options.attemptId || each.app !== app || each.sessionId !== snapshot.sessionId))) {
    const reason = 'The diagnostics belong to another test, attempt, app or session, so Retest did not save or send them.'
    return { ok: false, problem: { kind: 'refused', reason, record: record(options, { states: {}, label: `${selector.include.join(' and ')} records of ${app}`, status: 'unavailable', reason, sent: [], omitted: 0, sha256: hash(''), bytes: 0, path: undefined }) } }
  }
  const states: PartStates = {}
  for (const part of selector.include) states[part] = partState(snapshot, part, options.redact)
  const label = `${selector.include.join(' and ')} records of ${app}`
  const usable = selector.include.filter((part) => isUsable(states[part]))
  if (usable.length === 0) {
    const reason = `The ${label} are not available, so the check has none to judge: ${selector.include.map((part) => `${part} ${describeState(states[part])}`).join('; ')}.`
    return { ok: false, problem: { kind: 'missing', reason, record: record(options, { states, label, status: 'unavailable', reason, sent: [], omitted: 0, sha256: hash(''), bytes: 0, path: undefined }) } }
  }
  const chosen = (snapshot?.records ?? []).filter((each) => usable.includes(partOf(each)))
  const kept = chosen.slice(Math.max(0, chosen.length - options.maxRecords))
  const omitted = chosen.length - kept.length
  const records = kept.map((each) => withoutIdentity(mapRecordText(each, options.redact)))
  const parts: Partial<Record<DiagnosticsPart, DiagnosticsPartRecord & { records: SentRecord[] }>> = {}
  for (const part of selector.include) {
    const state = states[part]
    if (state !== undefined) parts[part] = { ...state, records: records.filter((each) => partOf(each) === part) }
  }
  const text = JSON.stringify({ app, ...parts, ...(omitted === 0 ? {} : { olderRecordsLeftOut: omitted }) })
  const complete = selector.include.every((part) => states[part]?.state === 'complete') && omitted === 0
  const reason = complete ? undefined : partialReason(selector.include, states, omitted)
  const path = evaluationDiagnosticsFile(options.testId, options.attemptId, app, options.checkId, id)
  try {
    options.store.writeArtifact(path, Buffer.from(text))
  } catch (error) {
    const refusal = `Retest could not save the ${label}, so it did not send them: ${options.redact(errorMessage(error))}`
    return { ok: false, problem: { kind: 'refused', reason: refusal, record: record(options, { states, label, status: 'unavailable', reason: refusal, sent: [], omitted, sha256: hash(''), bytes: 0, path: undefined }) } }
  }
  const sent = kept.map((each) => ('id' in each ? each.id : each.requestId))
  const status: EvidenceStatus = complete ? 'complete' : 'partial'
  const held: HeldDiagnostics = {
    judged: Object.freeze({ id, kind: 'text', text, label }),
    record: record(options, { states, label, status, reason, sent: [...new Set(sent)], omitted, sha256: hash(text), bytes: Buffer.byteLength(text), path }),
  }
  return { ok: true, value: held }
}

/**
 * Where the exact diagnostics text a check sent goes in the run folder.
 *
 * @example evaluationDiagnosticsFile('a.retest.ts > saves', 'k3v9q0x2mb', 'web', 'evaluation-1', 'e2')
 */
export function evaluationDiagnosticsFile(testId: string, attemptId: string, app: string, checkId: string, evidenceId: string): string {
  return `artifacts/${slug(testId, 40)}-${slug(attemptId, 24)}-${slug(app, 24)}-${slug(checkId, 32)}-${slug(evidenceId, 20)}-diagnostics.json`
}

type PartStates = Partial<Record<DiagnosticsPart, DiagnosticsPartRecord>>

type IdentityKey = 'testId' | 'attemptId' | 'app' | 'sessionId' | 'target'

/** A record as the judge receives it: without the identity every record of the attempt repeats. */
type SentRecord<Record = DiagnosticRecord> = Record extends DiagnosticRecord ? Omit<Record, IdentityKey> : never

type Built = { states: PartStates; label: string; status: EvidenceStatus; reason: string | undefined; sent: string[]; omitted: number; sha256: string; bytes: number; path: string | undefined }

function record(options: DiagnosticsOptions, built: Built): EvidenceRecord {
  const { id, app, store, testId, attemptId, selector } = options
  const capturedElapsedMs = store.elapsedMs()
  const { console: consoleState, network } = built.states
  return {
    id,
    kind: 'diagnostics',
    testId,
    attemptId,
    app,
    sessionId: formatSessionId(attemptId, app),
    capturedAt: new Date().toISOString(),
    ...(capturedElapsedMs === undefined ? {} : { capturedElapsedMs }),
    ...(built.path === undefined ? {} : { path: built.path }),
    label: built.label,
    sha256: built.sha256,
    bytes: built.bytes,
    status: built.status,
    ...(built.reason === undefined ? {} : { reason: built.reason }),
    include: [...selector.include],
    ...(consoleState === undefined ? {} : { console: consoleState }),
    ...(network === undefined ? {} : { network }),
    records: built.sent,
    recordsOmitted: built.omitted,
  }
}

function partState(snapshot: DiagnosticsSnapshot | undefined, part: DiagnosticsPart, redact: (text: string) => string): DiagnosticsPartRecord {
  if (snapshot === undefined) return { state: 'unavailable', reason: noView }
  const state = part === 'console' ? snapshot.console : snapshot.network
  return state.reason === undefined ? { state: state.state } : { state: state.state, reason: redact(state.reason) }
}

function isUsable(state: DiagnosticsPartRecord | undefined): boolean {
  return state?.state === 'complete' || state?.state === 'partial'
}

function describeState(state: DiagnosticsPartRecord | undefined): string {
  if (state === undefined) return 'not selected'
  return state.reason === undefined ? state.state : `${state.state}, ${state.reason}`
}

function partialReason(include: readonly DiagnosticsPart[], states: Built['states'], omitted: number): string {
  const parts = include.flatMap((part) => (states[part]?.state === 'complete' ? [] : [`${part} ${describeState(states[part])}`]))
  if (omitted > 0) parts.push(`${omitted} older ${omitted === 1 ? 'record' : 'records'} left out by evaluation.limits.maxDiagnosticRecords`)
  return `The selected records are not whole: ${parts.join('; ')}.`
}

function partOf(record: DiagnosticRecord | SentRecord): DiagnosticsPart {
  return record.type === 'console' || record.type === 'runtime_error' ? 'console' : 'network'
}

// Every record repeats the attempt's identity, which the evidence record names once; the judge does not need it.
function withoutIdentity(record: DiagnosticRecord): SentRecord {
  const { testId, attemptId, app, sessionId, target, ...rest } = record
  return rest
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}
