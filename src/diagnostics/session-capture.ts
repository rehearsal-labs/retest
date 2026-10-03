import type { TruncatedText } from '../protocol/failures.ts'
import type {
  ConsoleCapture,
  ConsoleCounts,
  ConsoleRecord,
  DiagnosticLimits,
  DiagnosticRecord,
  NetworkCapture,
  NetworkCounts,
  NetworkPendingRecord,
  NetworkResponseRecord,
  PendingReason,
  RecordIdentity,
  RuntimeErrorRecord,
  StackFrame,
} from '../protocol/diagnostics.ts'
import type {
  CollectorLoss,
  ConsoleObservation,
  DiagnosticSink,
  FailedObservation,
  FinishedObservation,
  Observation,
  ObservedFrame,
  RequestObservation,
  ResponseObservation,
  RuntimeErrorObservation,
} from './observations.ts'
import { truncateText } from '../protocol/failures.ts'
import { sanitizeText, sanitizeUrl } from './sanitize.ts'

/** What hides the run's secrets in text: `scan` with `holding` keeps back a tail that may begin a secret. */
export type TextRedactor = { redact(text: string): string; scan(text: string, holding: boolean): { text: string; held: string } }

/**
 * What every session of one attempt draws from, so the attempt's limits hold however many apps it has. `reserved` is
 * the bytes set aside for the records still to come of the hops already kept.
 */
export class AttemptBudget {
  readonly limits: DiagnosticLimits
  consoleEntries = 0
  consoleBytes = 0
  requests = 0
  networkBytes = 0
  reservedBytes = 0

  constructor(limits: DiagnosticLimits) {
    this.limits = limits
  }
}

export type SessionCaptureOptions = {
  identity: RecordIdentity
  budget: AttemptBudget
  redactor: TextRedactor
  /** When capture started, on the parent's clock. */
  startedAt: number
}

/** How a session's capture ended: the attempt ended, or the run was interrupted. */
export type CaptureEnding = 'attempt_ended' | 'run_interrupted'

/** Everything one session's capture kept, and what it says of each kind. */
export type FinishedCapture = {
  records: DiagnosticRecord[]
  console: ConsoleCapture
  network: NetworkCapture
  startedAt: string
  endedAt: string
}

type HopState = 'requested' | 'responded' | 'receiving'
/**
 * A kept hop still open: its public id, how far it got, the status it was answered with, and the bytes still set aside
 * for its last records.
 */
type OpenHop = { id: string; state: HopState; status: number | undefined; reserve: number }

// Fields of a hop's later records are cut to these, so the bytes set aside for them always suffice.
const statusTextLength = 128
const contentTypeLength = 128
const protocolLength = 32
const reasonLength = 256
const blockedLength = 64
const methodLength = 32
const resourceTypeLength = 32
// The most a hop's later records add beyond their identity: a response, then a failure, a finish or a pending mark. A
// character JSON writes as an escape takes up to six bytes, and each record's keys and fixed fields fit in 300.
const lifecycleBytes = 6 * (statusTextLength + contentTypeLength + protocolLength + reasonLength + blockedLength) + 2 * 300
// A message longer than this many times its limit is cut before it is redacted, so a huge argument costs little.
const preCutFactor = 4

/**
 * One session's capture: it takes what its collector heard, cleans every address, redacts every text and only then
 * cuts it, numbers what it keeps, and holds the attempt's limits. Console messages and runtime errors are numbered
 * `c1`, `e1` and on; each request hop `n1` and on, its response, finish, failure or pending mark carrying the same id.
 * What arrives past a limit is dropped and counted, and the kind becomes partial. Once a hop is kept, its later records
 * are always kept, so a response never goes missing from the middle of a hop.
 */
export class SessionCapture implements DiagnosticSink {
  readonly #identity: RecordIdentity
  readonly #identityBytes: number
  readonly #budget: AttemptBudget
  readonly #redactor: TextRedactor
  readonly #startedAt: number
  readonly #records: DiagnosticRecord[] = []
  readonly #hops = new Map<string, OpenHop>()
  // Public ids by hop key, given when a hop is kept or when a redirect first names it.
  readonly #ids = new Map<string, string>()
  readonly #kept = new Set<string>()
  readonly #errors = new Map<string, RuntimeErrorRecord>()
  readonly #console: ConsoleCounts = { entries: 0, errors: 0, warnings: 0, runtimeErrors: 0, handledLater: 0, dropped: 0, truncated: 0, bytes: 0 }
  readonly #network: NetworkCounts = { requests: 0, httpErrors: 0, transportFailures: 0, canceled: 0, pending: 0, outOfScope: 0, dropped: 0, truncated: 0, bytes: 0 }
  readonly #unreadable = { console: 0, network: 0 }
  #nextConsole = 1
  #nextError = 1
  #nextRequest = 1
  #loss: CollectorLoss | undefined
  #finished: FinishedCapture | undefined

  constructor({ identity, budget, redactor, startedAt }: SessionCaptureOptions) {
    this.#identity = identity
    this.#identityBytes = Buffer.byteLength(JSON.stringify(identity))
    this.#budget = budget
    this.#redactor = redactor
    this.#startedAt = startedAt
  }

  observe(observation: Observation): void {
    if (this.#finished !== undefined || this.#loss !== undefined) return
    switch (observation.kind) {
      case 'console':
        return this.#keepConsole(this.#consoleRecord(observation))
      case 'runtime_error':
        return this.#keepError(observation)
      case 'revoked':
        return this.#revoke(observation.key)
      case 'request':
        return this.#request(observation)
      case 'response':
        return this.#response(observation)
      case 'data': {
        const hop = this.#hops.get(observation.key)
        if (hop !== undefined && hop.state === 'responded') hop.state = 'receiving'
        return
      }
      case 'finished':
        return this.#close(observation, this.#finishedRecord(observation))
      case 'failed':
        return this.#close(observation, this.#failedRecord(observation))
      case 'left':
        return this.#leave(observation.key, observation.time)
    }
  }

  unreadable(method: string): void {
    if (this.#finished !== undefined) return
    if (method.startsWith('Network.')) this.#unreadable.network += 1
    else this.#unreadable.console += 1
  }

  // The page or the connection ended: every hop still open stays open for good, marked with why, at that time.
  lost(loss: CollectorLoss): void {
    if (this.#finished !== undefined || this.#loss !== undefined) return
    this.#loss = loss
    this.#markPending(loss.kind, loss.time)
  }

  /**
   * Ends the capture: each hop still open is marked pending with why, and each kind gets its state. Safe to repeat;
   * the first ending stands.
   */
  finish(ending: CaptureEnding, time: number = Date.now()): FinishedCapture {
    if (this.#finished !== undefined) return this.#finished
    this.#markPending(ending, time)
    // A redirect that named a hop the limits then dropped names nothing.
    for (const record of this.#records) {
      if (record.type === 'network.response' && record.redirectedTo !== undefined && !this.#kept.has(record.redirectedTo)) delete record.redirectedTo
    }
    this.#finished = {
      records: this.#records,
      console: this.#consoleCapture(),
      network: this.#networkCapture(),
      startedAt: new Date(this.#startedAt).toISOString(),
      endedAt: new Date(this.#loss?.time ?? time).toISOString(),
    }
    return this.#finished
  }

  #consoleRecord(observation: ConsoleObservation): ConsoleRecord {
    const requestId = observation.requestKey === undefined ? undefined : this.#ids.get(observation.requestKey)
    return {
      type: 'console',
      ...this.#identity,
      id: '',
      consoleType: this.#short(observation.consoleType, resourceTypeLength),
      level: observation.level,
      origin: observation.origin,
      ...(observation.source === undefined ? {} : { source: this.#short(observation.source, resourceTypeLength) }),
      text: this.#text(observation.text),
      time: isoTime(observation.time),
      ...this.#place(observation),
      ...(observation.frame === undefined ? {} : { frame: observation.frame }),
      ...(requestId === undefined ? {} : { requestId }),
    }
  }

  #keepConsole(record: ConsoleRecord): void {
    const id = `c${this.#nextConsole}`
    if (!this.#admitConsole({ ...record, id })) return
    this.#nextConsole += 1
    this.#console.entries += 1
    // The browser's own entries, such as a resource that failed to load, repeat what the network records say.
    if (record.origin === 'browser') return
    if (record.level === 'error') this.#console.errors += 1
    if (record.level === 'warning') this.#console.warnings += 1
  }

  #keepError(observation: RuntimeErrorObservation): void {
    const limit = this.#budget.limits.stackFrames
    const stack = observation.stack.slice(0, limit).map((frame) => this.#stackFrame(frame))
    const dropped = observation.stack.length - stack.length
    const record: RuntimeErrorRecord = {
      type: 'runtime_error',
      ...this.#identity,
      id: `e${this.#nextError}`,
      kind: observation.errorKind,
      message: this.#text(observation.message),
      time: isoTime(observation.time),
      ...this.#place(observation),
      ...(observation.frame === undefined ? {} : { frame: observation.frame }),
      stack,
      ...(dropped > 0 ? { framesDropped: dropped } : {}),
    }
    if (!this.#admitConsole(record)) return
    this.#nextError += 1
    this.#console.runtimeErrors += 1
    this.#errors.set(observation.key, record)
  }

  // The flag adds a few bytes to a record already kept; they are counted, and nothing is dropped for them.
  #revoke(key: string): void {
    const record = this.#errors.get(key)
    if (record === undefined || record.handledLater === true) return
    record.handledLater = true
    this.#console.runtimeErrors -= 1
    this.#console.handledLater += 1
    const added = Buffer.byteLength(',"handledLater":true')
    this.#budget.consoleBytes += added
    this.#console.bytes += added
  }

  #admitConsole(record: ConsoleRecord | RuntimeErrorRecord): boolean {
    const bytes = recordBytes(record)
    const { limits } = this.#budget
    if (this.#budget.consoleEntries >= limits.consoleEntries || this.#budget.consoleBytes + bytes > limits.consoleBytes) {
      this.#console.dropped += 1
      return false
    }
    this.#budget.consoleEntries += 1
    this.#budget.consoleBytes += bytes
    this.#console.bytes += bytes
    if (record.type === 'console' ? record.text.truncated : record.message.truncated || record.framesDropped !== undefined) this.#console.truncated += 1
    this.#records.push(record)
    return true
  }

  // A hop is kept only while the attempt can also hold its later records, so those are never dropped.
  #request(observation: RequestObservation): void {
    const url = this.#url(observation.url)
    const id = this.#ids.get(observation.key) ?? `n${this.#nextRequest}`
    const redirectedFrom = observation.redirectedFrom === undefined ? undefined : this.#ids.get(observation.redirectedFrom)
    const record = {
      type: 'network.request' as const,
      ...this.#identity,
      requestId: id,
      method: this.#short(observation.method, methodLength),
      url: url.text,
      ...(url.truncated ? { urlTruncated: true as const } : {}),
      ...(observation.resourceType === undefined ? {} : { resourceType: this.#short(observation.resourceType, resourceTypeLength) }),
      ...(observation.frame === undefined ? {} : { frame: observation.frame }),
      time: isoTime(observation.time),
      ...(redirectedFrom === undefined || !this.#kept.has(redirectedFrom) ? {} : { redirectedFrom }),
    }
    const bytes = recordBytes(record)
    const reserve = 2 * this.#identityBytes + lifecycleBytes
    const { limits } = this.#budget
    const room = limits.networkBytes - this.#budget.networkBytes - this.#budget.reservedBytes
    if (this.#budget.requests >= limits.requests || bytes + reserve > room) {
      this.#network.dropped += 1
      return
    }
    if (!this.#ids.has(observation.key)) this.#nextRequest += 1
    this.#ids.set(observation.key, id)
    this.#kept.add(id)
    this.#budget.requests += 1
    this.#budget.reservedBytes += reserve
    this.#hops.set(observation.key, { id, state: 'requested', status: undefined, reserve })
    this.#network.requests += 1
    if (url.truncated) this.#network.truncated += 1
    this.#addNetwork(record)
  }

  // A redirect names the next hop's id before that hop arrives, so the id is given now.
  #response(observation: ResponseObservation): void {
    const hop = this.#hops.get(observation.key)
    if (hop === undefined) return
    let redirectedTo: string | undefined
    if (observation.redirectedTo !== undefined) {
      redirectedTo = this.#ids.get(observation.redirectedTo) ?? `n${this.#nextRequest}`
      if (!this.#ids.has(observation.redirectedTo)) {
        this.#ids.set(observation.redirectedTo, redirectedTo)
        this.#nextRequest += 1
      }
    }
    const record: NetworkResponseRecord = {
      type: 'network.response',
      ...this.#identity,
      requestId: hop.id,
      status: observation.status,
      ...(observation.statusText === undefined ? {} : { statusText: this.#short(observation.statusText, statusTextLength) }),
      ...(observation.contentType === undefined ? {} : { contentType: this.#short(observation.contentType, contentTypeLength) }),
      time: isoTime(observation.time),
      ...(observation.cache === undefined ? {} : { cache: observation.cache }),
      ...(observation.serviceWorker === undefined ? {} : { serviceWorker: observation.serviceWorker }),
      ...(observation.protocol === undefined ? {} : { protocol: this.#short(observation.protocol, protocolLength) }),
      ...(redirectedTo === undefined ? {} : { redirectedTo }),
    }
    hop.state = 'responded'
    hop.status = observation.status
    if (observation.status >= 400) this.#network.httpErrors += 1
    this.#addLifecycle(hop, record)
  }

  #finishedRecord(observation: FinishedObservation): DiagnosticRecord | undefined {
    const hop = this.#hops.get(observation.key)
    if (hop === undefined) return undefined
    return {
      type: 'network.finished',
      ...this.#identity,
      requestId: hop.id,
      time: isoTime(observation.time),
      ...(observation.durationMs === undefined ? {} : { durationMs: observation.durationMs }),
      ...(observation.transferredBytes === undefined ? {} : { transferredBytes: observation.transferredBytes }),
    }
  }

  #failedRecord(observation: FailedObservation): DiagnosticRecord | undefined {
    const hop = this.#hops.get(observation.key)
    if (hop === undefined) return undefined
    // Chrome ends an error answer with no body with a failure; the status counted it already.
    if (observation.canceled === true) this.#network.canceled += 1
    else if ((hop.status ?? 0) < 400) this.#network.transportFailures += 1
    return {
      type: 'network.failed',
      ...this.#identity,
      requestId: hop.id,
      time: isoTime(observation.time),
      ...(observation.durationMs === undefined ? {} : { durationMs: observation.durationMs }),
      reason: this.#short(observation.reason, reasonLength),
      ...(observation.canceled === true ? { canceled: true as const } : {}),
      ...(observation.blocked === undefined ? {} : { blocked: this.#short(observation.blocked, blockedLength) }),
    }
  }

  #close(observation: FinishedObservation | FailedObservation, record: DiagnosticRecord | undefined): void {
    const hop = this.#hops.get(observation.key)
    if (hop === undefined || record === undefined) return
    this.#addLifecycle(hop, record)
    this.#hops.delete(observation.key)
    this.#budget.reservedBytes -= hop.reserve
    hop.reserve = 0
  }

  #leave(key: string, time: number): void {
    const hop = this.#hops.get(key)
    if (hop === undefined) return
    this.#addLifecycle(hop, { type: 'network.pending', ...this.#identity, requestId: hop.id, time: isoTime(time), lastState: hop.state, reason: 'out_of_scope' })
    this.#network.outOfScope += 1
    this.#hops.delete(key)
    this.#budget.reservedBytes -= hop.reserve
    hop.reserve = 0
  }

  #markPending(reason: PendingReason, time: number): void {
    for (const [key, hop] of this.#hops) {
      const record: NetworkPendingRecord = { type: 'network.pending', ...this.#identity, requestId: hop.id, time: isoTime(time), lastState: hop.state, reason }
      this.#addLifecycle(hop, record)
      this.#network.pending += 1
      this.#budget.reservedBytes -= hop.reserve
      hop.reserve = 0
      this.#hops.delete(key)
    }
  }

  #addLifecycle(hop: OpenHop, record: DiagnosticRecord): void {
    const bytes = recordBytes(record)
    const fromReserve = Math.min(bytes, hop.reserve)
    hop.reserve -= fromReserve
    this.#budget.reservedBytes -= fromReserve
    this.#addNetwork(record, bytes)
  }

  #addNetwork(record: DiagnosticRecord, bytes: number = recordBytes(record)): void {
    this.#budget.networkBytes += bytes
    this.#network.bytes += bytes
    this.#records.push(record)
  }

  // Free text is redacted whole first, so a secret is found before anything changes it, then its addresses are cleaned,
  // and only then is it cut. Text far over its limit is cut first, keeping back any tail that may begin a secret, so no
  // half of a value is left behind.
  #text(raw: string): TruncatedText {
    const limit = this.#budget.limits.textLength
    if (raw.length <= limit * preCutFactor) return truncateText(sanitizeText(this.#redactor.redact(raw)), limit)
    const cut = truncateText(raw, limit * preCutFactor).text
    const bounded = truncateText(sanitizeText(this.#redactor.scan(cut, true).text), limit)
    return { text: bounded.text, truncated: true, length: raw.length }
  }

  // An address is redacted whole, in every form a URL gives a secret, before it is cleaned and cut.
  #url(address: string): TruncatedText {
    return truncateText(sanitizeUrl(this.#redactor.redact(address)), this.#budget.limits.textLength)
  }

  #short(text: string, limit: number): string {
    return truncateText(this.#redactor.redact(text), limit).text
  }

  #place(observation: { url?: string; line?: number; column?: number }): { url?: string; line?: number; column?: number } {
    return {
      ...(observation.url === undefined ? {} : { url: this.#url(observation.url).text }),
      ...(observation.line === undefined || observation.line < 1 ? {} : { line: observation.line }),
      ...(observation.column === undefined || observation.column < 1 ? {} : { column: observation.column }),
    }
  }

  #stackFrame(frame: ObservedFrame): StackFrame {
    return {
      ...(frame.function === undefined ? {} : { function: this.#short(frame.function, reasonLength) }),
      ...(frame.url === undefined ? {} : { url: this.#url(frame.url).text }),
      line: Math.max(1, frame.line),
      column: Math.max(1, frame.column),
    }
  }

  #consoleCapture(): ConsoleCapture {
    const reasons = [...this.#lossReason(), ...dropReason(this.#console.dropped, 'console message or runtime error', 'messages'), ...unreadReason(this.#unreadable.console, 'console')]
    return reasons.length === 0 ? { state: 'complete', ...this.#console } : { state: 'partial', reason: reasons.join('; '), ...this.#console }
  }

  #networkCapture(): NetworkCapture {
    const reasons = [...this.#lossReason(), ...dropReason(this.#network.dropped, 'request', 'requests'), ...unreadReason(this.#unreadable.network, 'network')]
    return reasons.length === 0 ? { state: 'complete', ...this.#network } : { state: 'partial', reason: reasons.join('; '), ...this.#network }
  }

  #lossReason(): string[] {
    const loss = this.#loss
    if (loss === undefined) return []
    const at = new Date(loss.time).toISOString()
    return [loss.kind === 'page_crashed' ? `the page crashed at ${at}, and nothing after it was captured` : `the connection to the page ended at ${at} (${loss.reason}), and nothing after it was captured`]
  }
}

function dropReason(dropped: number, one: string, many: string): string[] {
  if (dropped === 0) return []
  return [`${dropped} ${dropped === 1 ? one : many} over the attempt's limits ${dropped === 1 ? 'was' : 'were'} dropped`]
}

function unreadReason(unread: number, kind: string): string[] {
  if (unread === 0) return []
  return [`${unread} ${kind} ${unread === 1 ? 'event' : 'events'} from the browser could not be read`]
}

function recordBytes(record: DiagnosticRecord): number {
  return Buffer.byteLength(JSON.stringify(record)) + 1
}

function isoTime(milliseconds: number): string {
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}
