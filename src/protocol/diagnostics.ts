import type { RecordIdentity } from './identity.ts'
import { truncatedTextSchema, type TruncatedText } from './failures.ts'
import { s, type Schema } from './schema.ts'

// Console messages, runtime errors and network metadata a page produced during one attempt, as the parent kept them.
// Each session of an attempt has one artifact, `diagnostics/<test>-<attempt>.jsonl`: a `capture.started` line, the
// records in the order they arrived, and a `capture.finished` line. Every text in it was cleaned of URL credentials,
// queries, fragments and token-bearing path segments, passed through the run's redactor, and only then cut to its
// limit. No request or response header and no body is ever recorded.

/**
 * How much of a kind of record a session's capture holds. `complete`: everything the declared scope produced from
 * the start marker to the end marker, so zero records means the page produced none. `partial`: some was lost, and
 * `reason` says what. `unavailable`: nothing was captured, and `reason` says why. `disabled`: the run turned capture
 * off.
 */
export type CaptureState = 'complete' | 'partial' | 'unavailable' | 'disabled'

/** The two kinds of record a session's capture holds, each with a state of its own. */
export type DiagnosticKind = 'console' | 'network'

/**
 * Where records can come from. `same_process_frames` are embedded frames the browser renders in the page's own
 * process, same-origin frames among them; `out_of_process_frames` are frames of another site, which run in a process
 * of their own. `main_process` and `other_windows` are an Electron app's main process and the windows other than the
 * test's page.
 */
export type ScopeArea =
  | 'top_level_document'
  | 'same_process_frames'
  | 'out_of_process_frames'
  | 'dedicated_workers'
  | 'shared_workers'
  | 'service_workers'
  | 'main_process'
  | 'other_windows'
  | 'owned_process'
  | 'app_network_source'

/** The areas one kind of record covers, and the areas it does not. */
export type KindScope = { covered: ScopeArea[]; notCovered: ScopeArea[] }

/**
 * What a session's capture covers: the engine, the source of its records, the test's own page target, and for each
 * kind, which areas it covers. Capture starts before the page's first navigation and ends once the body and the
 * parent's checks are over, before a failure screenshot and before the page closes. `reason` says why areas particular
 * to the target are out of reach, as an Electron app's main process and other windows are.
 */
export type DiagnosticScope = { engine: string; source: 'page_target' | 'owned_app'; console: KindScope; network: KindScope; reason?: string }

/**
 * The bounds of one attempt's capture, shared by its sessions. `consoleEntries` counts console messages and runtime
 * errors, `requests` counts request hops, and each `Bytes` limit counts the records as written. A record over a
 * limit is dropped and counted. `textLength` cuts each message, and `stackFrames` each stack.
 */
export type DiagnosticLimits = {
  consoleEntries: number
  consoleBytes: number
  requests: number
  networkBytes: number
  textLength: number
  stackFrames: number
}

/** The bounds a run uses unless it sets its own. */
export const defaultDiagnosticLimits: Readonly<DiagnosticLimits> = Object.freeze({
  consoleEntries: 1000,
  consoleBytes: 1024 * 1024,
  requests: 1000,
  networkBytes: 2 * 1024 * 1024,
  textLength: 4096,
  stackFrames: 20,
})

/** A message's severity: `debug` is the browser's verbose level. */
export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error'

/**
 * Who wrote a console message: the page's own code, in its document or a frame; a dedicated worker, whose messages
 * the browser forwards to the page with their level only; or the browser itself, such as a failed resource or a
 * security warning.
 */
export type ConsoleOrigin = 'page' | 'worker' | 'browser' | 'native'

/** The frame a record came from: the page's main frame, or an embedded one. */
export type FrameRole = 'main' | 'child'

/**
 * Whose a record is: the record identity every session's record shares, the test, attempt, app and session, and the
 * target the app ran on in a run with variants. A diagnostics record rests on no look, so it names none.
 */
export type DiagnosticIdentity = Omit<RecordIdentity, 'observationId'> & { target?: string }

/**
 * A console message. `consoleType` is the type as the browser gave it, such as `log`, `table` or `assert`, or a
 * browser entry's level; `level` is its severity. `text` is its arguments as text, joined by a space: strings as
 * written, other values as the browser described them, and an object's properties one level deep as the browser
 * previewed them, never read from the page. Format directives such as `%s` are left as written. `url`, `line` and
 * `column` are where the browser says it came from, lines and columns from 1. `requestId` names the request a
 * browser entry is about, when Retest recorded it.
 */
export type ConsoleRecord = DiagnosticIdentity & {
  type: 'console'
  id: string
  consoleType: string
  level: ConsoleLevel
  origin: ConsoleOrigin
  source?: string
  /** The owned native process whose stdout or stderr this line came from. */
  processId?: number
  text: TruncatedText
  time: string
  url?: string
  line?: number
  column?: number
  frame?: FrameRole
  requestId?: string
}

/** One frame of a stack, as the browser gave it, lines and columns from 1. */
export type StackFrame = { function?: string; url?: string; line: number; column: number }

/**
 * An error the page threw and did not catch, or a promise it rejected with nobody handling it. `message` is the
 * browser's own line, such as `Uncaught Error: boom`. `stack` keeps the first frames the browser gave, and
 * `framesDropped` says how many more there were. `handledLater` marks a rejection the page handled after the
 * browser reported it.
 */
export type RuntimeErrorRecord = DiagnosticIdentity & {
  type: 'runtime_error'
  id: string
  kind: 'uncaught' | 'unhandled_rejection'
  message: TruncatedText
  time: string
  url?: string
  line?: number
  column?: number
  frame?: FrameRole
  stack: StackFrame[]
  framesDropped?: number
  handledLater?: true
}

/**
 * A request hop as the page sent it. Each hop of a redirect is a request of its own, with its own `requestId`;
 * `redirectedFrom` names the hop before it. `url` is cleaned, and `urlTruncated` marks one cut to the text limit.
 */
export type NativeNetworkProvenance = { source?: 'app-network-file'; client?: 'ios' | 'macos' }

export type NetworkRequestRecord = DiagnosticIdentity & NativeNetworkProvenance & {
  type: 'network.request'
  requestId: string
  method: string
  url: string
  urlTruncated?: true
  resourceType?: string
  frame?: FrameRole
  time: string
  redirectedFrom?: string
}

/**
 * Where a response came from, as the browser said: its disk cache, its memory cache, its prefetch cache, or `none`
 * when the browser said it used none of them. Absent when the browser said nothing either way.
 */
export type CacheSource = 'disk' | 'memory' | 'prefetch' | 'none'

/**
 * The response to a hop: its HTTP status, a 404 or a 500 among them, and the content type the browser read, without
 * parameters. `redirectedTo` names the hop a redirect led to. `serviceWorker` says whether a service worker answered,
 * when the browser said.
 */
export type NetworkResponseRecord = DiagnosticIdentity & NativeNetworkProvenance & {
  type: 'network.response'
  requestId: string
  status: number
  statusText?: string
  contentType?: string
  time: string
  cache?: CacheSource
  serviceWorker?: boolean
  protocol?: string
  redirectedTo?: string
}

/**
 * A hop that finished: for a redirect, when its response arrived. `durationMs` is the browser's own measure from the
 * request to the end; `transferredBytes` what the browser counted on the wire. Each is absent when the browser gave
 * nothing to measure it from, and never written as zero in its place.
 */
export type NetworkFinishedRecord = DiagnosticIdentity & NativeNetworkProvenance & {
  type: 'network.finished'
  requestId: string
  time: string
  durationMs?: number
  transferredBytes?: number
}

/**
 * A hop that failed before an HTTP response finished: a refused connection, a name that did not resolve, a request
 * the page or a navigation cancelled (`canceled`), or one the browser blocked (`blocked` names why). An HTTP error
 * status is a response, never a failure; Chrome ends an error answer with no body with a failure after its response,
 * which counts once, as the HTTP error.
 */
export type NetworkFailedRecord = DiagnosticIdentity & NativeNetworkProvenance & {
  type: 'network.failed'
  requestId: string
  time: string
  durationMs?: number
  reason: string
  canceled?: true
  blocked?: string
}

/**
 * Why a hop's end is not recorded: it was still open when the attempt ended, the run was interrupted, the page crashed
 * or the connection to the page was lost; or the browser handed it to a frame of another site or to a worker, outside
 * the declared scope (`out_of_scope`), so its end is reported where Retest does not listen.
 */
export type PendingReason = 'attempt_ended' | 'run_interrupted' | 'page_crashed' | 'connection_lost' | 'out_of_scope'

/** A hop whose end is not recorded, how far it had got (sent, answered, or receiving its body) and why. */
export type NetworkPendingRecord = DiagnosticIdentity & {
  type: 'network.pending'
  requestId: string
  time: string
  lastState: 'requested' | 'responded' | 'receiving'
  reason: PendingReason
}

export type NetworkRecord = NetworkRequestRecord | NetworkResponseRecord | NetworkFinishedRecord | NetworkFailedRecord | NetworkPendingRecord

export type DiagnosticRecord = ConsoleRecord | RuntimeErrorRecord | NetworkRecord

/**
 * What a console capture counted: the records it kept, and those it dropped or cut. `errors` and `warnings` count what
 * the page's own code and its workers wrote; the browser's own entries, such as a resource that failed to load, count
 * only in `entries`. `runtimeErrors` counts errors the page never handled, and `handledLater` the rejections it
 * handled after Chrome reported them.
 */
export type ConsoleCounts = {
  entries: number
  errors: number
  warnings: number
  runtimeErrors: number
  handledLater: number
  dropped: number
  truncated: number
  bytes: number
}

/**
 * What a network capture counted: the hops it kept, how they ended, and those it dropped or cut. `pending` counts hops
 * still open when capture ended, and `outOfScope` those the browser handed outside the scope.
 */
export type NetworkCounts = {
  requests: number
  httpErrors: number
  transportFailures: number
  canceled: number
  pending: number
  outOfScope: number
  dropped: number
  truncated: number
  bytes: number
}

/** A kind's state, with its counts only when something was captured. */
export type CaptureOf<Counts> =
  | ({ state: 'complete' } & Counts)
  | ({ state: 'partial'; reason: string } & Counts)
  | { state: 'unavailable'; reason: string }
  | { state: 'disabled' }

export type ConsoleCapture = CaptureOf<ConsoleCounts>
export type NetworkCapture = CaptureOf<NetworkCounts>

/**
 * One session's diagnostics in a test's result. `path` is its artifact, relative to the run folder, absent when none
 * was written. `app` is present in a run with a config, as for screenshots. `startedAt` and `endedAt` are the start
 * and end markers.
 */
export type DiagnosticsSummary = {
  app?: string
  sessionId: string
  path?: string
  scope?: DiagnosticScope
  startedAt?: string
  endedAt?: string
  console: ConsoleCapture
  network: NetworkCapture
}

/** The policy a run judged its attempts' diagnostics by, as `diagnostics.started` records it. */
export type DiagnosticsPolicyRecord = {
  strict?: { runtimeErrors?: true; consoleErrors?: true; transportFailures?: true; httpErrors?: true; allow?: string[] }
  requireComplete?: true
}

/** The first line of an artifact: whose it is, what it covers, its bounds and when it started. */
export type CaptureStartedLine = DiagnosticIdentity & {
  type: 'capture.started'
  schemaVersion: 1
  scope: DiagnosticScope
  limits: DiagnosticLimits
  startedAt: string
}

/** The last line of an artifact: when capture ended and each kind's state. */
export type CaptureFinishedLine = DiagnosticIdentity & { type: 'capture.finished'; endedAt: string; console: ConsoleCapture; network: NetworkCapture }

/** One line of a diagnostics artifact. */
export type DiagnosticLine = CaptureStartedLine | DiagnosticRecord | CaptureFinishedLine

const count = s.number({ integer: true, min: 0 })
const position = s.number({ integer: true, min: 1 })
const areas = s.array(
  s.enum(['top_level_document', 'same_process_frames', 'out_of_process_frames', 'dedicated_workers', 'shared_workers', 'service_workers', 'main_process', 'other_windows', 'owned_process', 'app_network_source']),
)
const kindScopeSchema: Schema<KindScope> = s.object({ covered: areas, notCovered: areas })

export const diagnosticScopeSchema: Schema<DiagnosticScope> = s.object({
  engine: s.string(),
  source: s.enum(['page_target', 'owned_app']),
  console: kindScopeSchema,
  network: kindScopeSchema,
  reason: s.optional(s.string()),
})

export const diagnosticLimitsSchema: Schema<DiagnosticLimits> = s.object({
  consoleEntries: count,
  consoleBytes: count,
  requests: count,
  networkBytes: count,
  textLength: position,
  stackFrames: count,
})

const consoleCounts = {
  entries: count,
  errors: count,
  warnings: count,
  runtimeErrors: count,
  handledLater: count,
  dropped: count,
  truncated: count,
  bytes: count,
}
const networkCounts = {
  requests: count,
  httpErrors: count,
  transportFailures: count,
  canceled: count,
  pending: count,
  outOfScope: count,
  dropped: count,
  truncated: count,
  bytes: count,
}

export const consoleCaptureSchema: Schema<ConsoleCapture> = s.discriminatedUnion('state', [
  s.object({ state: s.literal('complete'), ...consoleCounts }),
  s.object({ state: s.literal('partial'), reason: s.string(), ...consoleCounts }),
  s.object({ state: s.literal('unavailable'), reason: s.string() }),
  s.object({ state: s.literal('disabled') }),
])

export const networkCaptureSchema: Schema<NetworkCapture> = s.discriminatedUnion('state', [
  s.object({ state: s.literal('complete'), ...networkCounts }),
  s.object({ state: s.literal('partial'), reason: s.string(), ...networkCounts }),
  s.object({ state: s.literal('unavailable'), reason: s.string() }),
  s.object({ state: s.literal('disabled') }),
])

export const diagnosticsSummarySchema: Schema<DiagnosticsSummary> = s.object({
  app: s.optional(s.string()),
  sessionId: s.string(),
  path: s.optional(s.string()),
  scope: s.optional(diagnosticScopeSchema),
  startedAt: s.optional(s.string()),
  endedAt: s.optional(s.string()),
  console: consoleCaptureSchema,
  network: networkCaptureSchema,
})

export const diagnosticsPolicyRecordSchema: Schema<DiagnosticsPolicyRecord> = s.object({
  strict: s.optional(
    s.object({
      runtimeErrors: s.optional(s.literal(true)),
      consoleErrors: s.optional(s.literal(true)),
      transportFailures: s.optional(s.literal(true)),
      httpErrors: s.optional(s.literal(true)),
      allow: s.optional(s.array(s.string())),
    }),
  ),
  requireComplete: s.optional(s.literal(true)),
})

const identity = {
  testId: s.string(),
  attemptId: s.string(),
  app: s.string(),
  sessionId: s.string(),
  target: s.optional(s.string()),
}
const frame = s.optional(s.enum(['main', 'child']))
const stackFrameSchema: Schema<StackFrame> = s.object({ function: s.optional(s.string()), url: s.optional(s.string()), line: position, column: position })

const consoleRecordShape = {
  ...identity,
  type: s.literal('console'),
  id: s.string(),
  consoleType: s.string(),
  level: s.enum(['debug', 'info', 'warning', 'error']),
  origin: s.enum(['page', 'worker', 'browser', 'native']),
  source: s.optional(s.string()),
  processId: s.optional(position),
  text: truncatedTextSchema,
  time: s.string(),
  url: s.optional(s.string()),
  line: s.optional(position),
  column: s.optional(position),
  frame,
  requestId: s.optional(s.string()),
}
const runtimeErrorShape = {
  ...identity,
  type: s.literal('runtime_error'),
  id: s.string(),
  kind: s.enum(['uncaught', 'unhandled_rejection']),
  message: truncatedTextSchema,
  time: s.string(),
  url: s.optional(s.string()),
  line: s.optional(position),
  column: s.optional(position),
  frame,
  stack: s.array(stackFrameSchema),
  framesDropped: s.optional(position),
  handledLater: s.optional(s.literal(true)),
}
const nativeNetworkProvenance = { source: s.optional(s.literal('app-network-file')), client: s.optional(s.enum(['ios', 'macos'])) }
const requestShape = {
  ...nativeNetworkProvenance,
  ...identity,
  type: s.literal('network.request'),
  requestId: s.string(),
  method: s.string(),
  url: s.string(),
  urlTruncated: s.optional(s.literal(true)),
  resourceType: s.optional(s.string()),
  frame,
  time: s.string(),
  redirectedFrom: s.optional(s.string()),
}
const responseShape = {
  ...nativeNetworkProvenance,
  ...identity,
  type: s.literal('network.response'),
  requestId: s.string(),
  status: count,
  statusText: s.optional(s.string()),
  contentType: s.optional(s.string()),
  time: s.string(),
  cache: s.optional(s.enum(['disk', 'memory', 'prefetch', 'none'])),
  serviceWorker: s.optional(s.boolean()),
  protocol: s.optional(s.string()),
  redirectedTo: s.optional(s.string()),
}
const finishedShape = {
  ...nativeNetworkProvenance,
  ...identity,
  type: s.literal('network.finished'),
  requestId: s.string(),
  time: s.string(),
  durationMs: s.optional(s.number({ min: 0 })),
  transferredBytes: s.optional(count),
}
const failedShape = {
  ...nativeNetworkProvenance,
  ...identity,
  type: s.literal('network.failed'),
  requestId: s.string(),
  time: s.string(),
  durationMs: s.optional(s.number({ min: 0 })),
  reason: s.string(),
  canceled: s.optional(s.literal(true)),
  blocked: s.optional(s.string()),
}
const pendingShape = {
  ...identity,
  type: s.literal('network.pending'),
  requestId: s.string(),
  time: s.string(),
  lastState: s.enum(['requested', 'responded', 'receiving']),
  reason: s.enum(['attempt_ended', 'run_interrupted', 'page_crashed', 'connection_lost', 'out_of_scope']),
}

export const diagnosticRecordSchema: Schema<DiagnosticRecord> = s.discriminatedUnion('type', [
  s.object(consoleRecordShape),
  s.object(runtimeErrorShape),
  s.object(requestShape),
  s.object(responseShape),
  s.object(finishedShape),
  s.object(failedShape),
  s.object(pendingShape),
])

export const diagnosticLineSchema: Schema<DiagnosticLine> = s.discriminatedUnion('type', [
  s.object({ ...identity, type: s.literal('capture.started'), schemaVersion: s.literal(1), scope: diagnosticScopeSchema, limits: diagnosticLimitsSchema, startedAt: s.string() }),
  s.object(consoleRecordShape),
  s.object(runtimeErrorShape),
  s.object(requestShape),
  s.object(responseShape),
  s.object(finishedShape),
  s.object(failedShape),
  s.object(pendingShape),
  s.object({ ...identity, type: s.literal('capture.finished'), endedAt: s.string(), console: consoleCaptureSchema, network: networkCaptureSchema }),
])

/**
 * Whether a kind captured anything, complete or partial, so its counts can be read.
 *
 * @example capturedCounts({ state: 'disabled' }) // undefined
 */
export function capturedCounts<Counts extends object>(capture: CaptureOf<Counts>): (Counts & { state: 'complete' | 'partial' }) | undefined {
  return capture.state === 'complete' || capture.state === 'partial' ? capture : undefined
}
