import type { OwnedPage, SessionIdentity } from '../browser/contract.ts'
import type { DiagnosticIdentity, DiagnosticKind, DiagnosticRecord, DiagnosticScope, DiagnosticsSummary } from '../protocol/diagnostics.ts'
import type { EventBody } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { Variant } from '../protocol/variant.ts'
import type { DiagnosticCollection } from './observations.ts'
import type { DiagnosticsPolicy } from './policy.ts'
import type { CaptureEnding, TextRedactor } from './session-capture.ts'
import type { CaptureSnapshot, FinishedCapture } from './session-capture.ts'
import type { NativeNetworkDeclaration } from './native-network.ts'
import { NativeLogSource } from '../native/logs.ts'
import { NativeNetworkSource } from './native-network.ts'
import { errorMessage } from '../protocol/failures.ts'
import { diagnosticsFile } from '../protocol/run-folder.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { bounded } from '../runner/bounded.ts'
import { artifactText, mapRecordText } from './artifact.ts'
import { policyFailure, recordedPolicy } from './policy.ts'
import { AttemptBudget, SessionCapture } from './session-capture.ts'

/** A page of the attempt: its app, the page's diagnostics capability, when its driver has one, and the session it is. */
export type DiagnosedPage = { readonly app: string; readonly page: Pick<OwnedPage, 'collectDiagnostics'>; readonly session: SessionIdentity }

export type AttemptDiagnosticsOptions = {
  policy: DiagnosticsPolicy
  redactor: TextRedactor
  /** Writes an artifact, never over another. */
  writeArtifact: (path: string, bytes: Uint8Array) => void
  emit: (body: EventBody) => void
  testId: string
  attemptId: string
  /** The target each app ran on, in a run with variants. */
  variant: Variant | undefined
  /** Whether results name their app, as in a run from a config. */
  named: boolean
  /** Milliseconds since the epoch. */
  clock?: () => number
}

/** What an attempt's diagnostics end with: each session's summary, and the policy's failure, when it has one. */
export type DiagnosedAttempt = { summaries: DiagnosticsSummary[]; failure: Failure | undefined }

type SessionEntry = {
  app: string
  identity: DiagnosticIdentity
  /** Set once capture started. */
  running?: { capture: SessionCapture; collection: DiagnosticCollection; scope: DiagnosticScope }
  /** Why nothing was captured; absent when capture started or was disabled. */
  unavailable?: string
  native?: { logs: NativeLogSource; network: NativeNetworkSource; scope: DiagnosticScope; startedAt: number; finished?: FinishedCapture }
}

const noDriver = "the page's driver does not collect diagnostics"
const interrupted = 'the run was interrupted before capture started'
// How long past its own budget a collector's start is waited for, as a page that lost its browser takes to say so.
const answerGraceMs = 1000

/**
 * One attempt's diagnostics, held by the parent: it starts each page's collector before the body runs, ends them once
 * the body and the parent's checks are over, writes each session's artifact and events, and judges the policy. A
 * collector never decides a verdict on its own and never acts on a page: the policy's failure is returned to the
 * caller, which keeps any failure the test already had first.
 */
export class AttemptDiagnostics {
  readonly #options: AttemptDiagnosticsOptions
  readonly #budget: AttemptBudget
  readonly #clock: () => number
  readonly #sessions: SessionEntry[] = []
  #finished: DiagnosedAttempt | undefined
  #stoppedEarly = false

  constructor(options: AttemptDiagnosticsOptions) {
    this.#options = options
    this.#budget = new AttemptBudget(options.policy.limits)
    this.#clock = options.clock ?? Date.now
  }

  /**
   * Opens the declared file before app launch. The launch owner binds stdout to the returned log source; `logs: false`
   * says it will not, as for a target that keeps no log, and the scope then covers no console.
   */
  async startNative(app: string, session: SessionIdentity, networkSource?: NativeNetworkDeclaration, sources: { logs?: boolean } = {}): Promise<{ logs: NativeLogSource; network: NativeNetworkSource }> {
    if (this.#finished !== undefined || this.#sessions.some((entry) => entry.app === app)) throw new Error('The diagnostics attempt or app already has a capture.')
    if (session.owner.testId !== this.#options.testId || session.owner.attemptId !== this.#options.attemptId || session.owner.app !== app || session.sessionId !== formatSessionId(this.#options.attemptId, app)) throw new Error('Native diagnostics belong to a different test, attempt, app or session.')
    const target = this.#options.variant?.[app]
    const identity: DiagnosticIdentity = { testId: this.#options.testId, attemptId: this.#options.attemptId, app, sessionId: session.sessionId, ...(target === undefined ? {} : { target }) }
    const startedAt = this.#clock()
    const options = { identity, budget: this.#budget, redactor: this.#options.redactor, enabled: this.#options.policy.capture }
    const logs = new NativeLogSource({ ...options, clock: this.#clock })
    const network = new NativeNetworkSource({ ...options, ...(networkSource === undefined ? {} : { source: networkSource }) })
    const consoleScope: DiagnosticScope['console'] = sources.logs === false ? { covered: [], notCovered: ['owned_process'] } : { covered: ['owned_process'], notCovered: [] }
    const scope: DiagnosticScope = { engine: session.runtime.kind, source: 'owned_app', console: consoleScope, network: { covered: networkSource === undefined ? [] : ['app_network_source'], notCovered: [] }, reason: 'Owned app stdout and declared app-supplied metadata only; no machine-wide logs or transparent network capture.' }
    const entry: SessionEntry = { app, identity, native: { logs, network, scope, startedAt } }
    this.#sessions.push(entry)
    await network.start()
    if (this.#options.policy.capture) this.#emitStarted(entry, scope, startedAt)
    return { logs, network }
  }

  /** Freeze native sources before the ordinary synchronous artifact and policy path. Call after dispatched work settles. */
  async finishNative(ending: CaptureEnding): Promise<DiagnosedAttempt> {
    for (const entry of this.#sessions) {
      const native = entry.native
      if (native === undefined || native.finished !== undefined) continue
      const logs = native.logs.finish()
      const network = await native.network.finish()
      native.finished = { records: [...logs.records, ...network.records].sort((left, right) => left.time.localeCompare(right.time)), console: logs.capture, network: network.capture, startedAt: new Date(native.startedAt).toISOString(), endedAt: new Date(this.#clock()).toISOString() }
    }
    return this.finish(ending)
  }

  /**
   * Starts capture on each page within `timeoutMs`, before any of them navigates. A page whose driver collects nothing,
   * or whose capture does not start, is recorded as unavailable with the reason, and the attempt goes on. Once `stopped`
   * settles nothing more is waited for: a page still starting is recorded as unavailable, and its collector is stopped
   * whenever it answers.
   */
  async start(pages: readonly DiagnosedPage[], timeoutMs: number, stopped?: Promise<unknown>): Promise<void> {
    for (const { app, page, session } of pages) {
      const target = this.#options.variant?.[app]
      const identity: DiagnosticIdentity = { testId: this.#options.testId, attemptId: this.#options.attemptId, app, sessionId: session.sessionId, ...(target === undefined ? {} : { target }) }
      const entry: SessionEntry = { app, identity }
      this.#sessions.push(entry)
      if (!this.#options.policy.capture) continue
      if (page.collectDiagnostics === undefined) {
        entry.unavailable = noDriver
        continue
      }
      if (this.#stoppedEarly) {
        entry.unavailable = interrupted
        continue
      }
      const startedAt = this.#clock()
      const capture = new SessionCapture({ identity, budget: this.#budget, redactor: this.#options.redactor, startedAt })
      const starting = page.collectDiagnostics(capture, timeoutMs)
      const started = await bounded(starting, timeoutMs + answerGraceMs, stopped)
      if (started.status === 'done') {
        if (started.value.startedLate !== undefined) capture.beganLate(started.value.startedLate)
        entry.running = { capture, collection: started.value, scope: started.value.scope }
        this.#emitStarted(entry, started.value.scope, startedAt)
        continue
      }
      // A collector that answers after Retest stopped waiting is stopped at once, so no listener stays behind.
      starting.then((late) => late.stop(), () => undefined)
      if (started.status === 'failed') entry.unavailable = `Retest could not start capture: ${errorMessage(started.error)}`
      else if (started.status === 'timed_out') entry.unavailable = `Retest could not start capture: the page did not answer within ${timeoutMs} ms.`
      else {
        entry.unavailable = interrupted
        this.#stoppedEarly = true
      }
    }
  }

  /** A read-only, identity-preserving view for an evaluation; collection continues after the view is taken. */
  snapshot(app: string): (CaptureSnapshot & DiagnosticIdentity) | undefined {
    const entry = this.#sessions.find((session) => session.app === app)
    if (entry === undefined) return undefined
    const captured = entry.running?.capture.snapshot()
    if (captured !== undefined) {
      const unavailable = entry.running?.collection.unavailable
      const console = unavailable?.console === undefined ? captured.console : Object.freeze({ state: 'unavailable' as const, reason: this.#options.redactor.redact(unavailable.console) })
      const network = unavailable?.network === undefined ? captured.network : Object.freeze({ state: 'unavailable' as const, reason: this.#options.redactor.redact(unavailable.network) })
      return Object.freeze({ ...entry.identity, records: captured.records, console, network })
    }
    if (!this.#options.policy.capture) return Object.freeze({ ...entry.identity, records: Object.freeze([]), console: Object.freeze({ state: 'disabled' as const }), network: Object.freeze({ state: 'disabled' as const }) })
    const reason = this.#options.redactor.redact(entry.unavailable ?? (entry.native === undefined ? 'capture has not started' : 'live native diagnostics do not provide an evaluation snapshot'))
    return Object.freeze({ ...entry.identity, records: Object.freeze([]), console: Object.freeze({ state: 'unavailable' as const, reason }), network: Object.freeze({ state: 'unavailable' as const, reason }) })
  }

  /**
   * Ends every capture, writes each session's artifact and `diagnostics.finished`, and judges the policy over every
   * record the attempt kept. Safe to repeat; the first ending stands.
   */
  finish(ending: CaptureEnding): DiagnosedAttempt {
    if (this.#finished !== undefined) return this.#finished
    if (this.#sessions.some((entry) => entry.native !== undefined && entry.native.finished === undefined)) throw new Error('Await finishNative before judging native diagnostics.')
    const time = this.#clock()
    const records: DiagnosticRecord[] = []
    const summaries = this.#sessions.map((entry) => {
      const summary = this.#finishSession(entry, ending, time, records)
      this.#options.emit({ type: 'diagnostics.finished', testId: this.#options.testId, attemptId: this.#options.attemptId, session: entry.app, sessionId: entry.identity.sessionId, diagnostics: summary })
      return summary
    })
    this.#finished = { summaries, failure: policyFailure(this.#options.policy, records, summaries) }
    return this.#finished
  }

  #emitStarted(entry: SessionEntry, scope: DiagnosticScope, startedAt: number): void {
    const policy = recordedPolicy(this.#options.policy)
    this.#options.emit({
      type: 'diagnostics.started',
      testId: this.#options.testId,
      attemptId: this.#options.attemptId,
      session: entry.app,
      sessionId: entry.identity.sessionId,
      scope,
      limits: { ...this.#options.policy.limits },
      startedAt: new Date(startedAt).toISOString(),
      ...(policy === undefined ? {} : { policy }),
    })
  }

  // The redactor may have learned a value since a record was kept, so every record is redacted again as it is written.
  #finishSession(entry: SessionEntry, ending: CaptureEnding, time: number, kept: DiagnosticRecord[]): DiagnosticsSummary {
    const head = { ...(this.#options.named ? { app: entry.app } : {}), sessionId: entry.identity.sessionId }
    if (entry.running === undefined && entry.native === undefined) {
      if (entry.unavailable === undefined) return { ...head, console: { state: 'disabled' }, network: { state: 'disabled' } }
      return { ...head, console: { state: 'unavailable', reason: entry.unavailable }, network: { state: 'unavailable', reason: entry.unavailable } }
    }
    const scope = entry.native?.scope ?? entry.running?.scope
    if (scope === undefined) throw new Error('The diagnostics capture has no scope.')
    entry.running?.collection.stop()
    const captured = entry.native?.finished ?? entry.running?.capture.finish(ending, time)
    if (captured === undefined) throw new Error('The diagnostics capture did not finish.')
    const finished = withoutSource(captured, entry.running?.collection.unavailable)
    if (finished.console.state === 'disabled' && finished.network.state === 'disabled') return { ...head, console: finished.console, network: finished.network }
    const redact = (text: string): string => this.#options.redactor.redact(text)
    const records = finished.records.map((record) => mapRecordText(record, redact))
    const path = diagnosticsFile(this.#options.testId, this.#options.attemptId, this.#options.named ? entry.app : undefined)
    const markers = { startedAt: finished.startedAt, endedAt: finished.endedAt }
    // The policy judges what the page did, which an artifact that could not be saved does not change.
    kept.push(...records)
    try {
      const started = { type: 'capture.started' as const, schemaVersion: 1 as const, ...entry.identity, scope, limits: { ...this.#options.policy.limits }, startedAt: finished.startedAt }
      const ended = { type: 'capture.finished' as const, ...entry.identity, endedAt: finished.endedAt, console: finished.console, network: finished.network }
      this.#options.writeArtifact(path, Buffer.from(artifactText(started, records, ended)))
    } catch (error) {
      const reason = `Retest could not save the diagnostics artifact: ${errorMessage(error)}`
      return { ...head, scope, ...markers, console: { state: 'unavailable', reason }, network: { state: 'unavailable', reason } }
    }
    return { ...head, path, scope, ...markers, console: finished.console, network: finished.network }
  }
}

// A kind the collector has no source for is unavailable with its reason, never complete because nothing arrived.
function withoutSource(finished: FinishedCapture, unavailable: Partial<Record<DiagnosticKind, string>> | undefined): FinishedCapture {
  if (unavailable === undefined) return finished
  const console = unavailable.console === undefined ? finished.console : { state: 'unavailable' as const, reason: unavailable.console }
  const network = unavailable.network === undefined ? finished.network : { state: 'unavailable' as const, reason: unavailable.network }
  return { ...finished, console, network }
}
