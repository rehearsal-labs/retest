import type { ConsoleLevel, ConsoleOrigin, DiagnosticScope, FrameRole } from '../protocol/diagnostics.ts'

// What a driver's collector hands the parent: what the engine reported, read but not yet cleaned, redacted, cut or
// numbered. Times are milliseconds since the epoch on the engine's clock. A request is named by a key the collector
// gives each hop, unique within its session; the parent numbers what it keeps.

export type ConsoleObservation = {
  kind: 'console'
  consoleType: string
  level: ConsoleLevel
  origin: ConsoleOrigin
  source?: string
  text: string
  time: number
  url?: string
  /** From 1. */
  line?: number
  column?: number
  frame?: FrameRole
  /** The key of the request a browser entry is about. */
  requestKey?: string
}

/** A stack frame as the engine gave it, lines and columns from 1. */
export type ObservedFrame = { function?: string; url?: string; line: number; column: number }

export type RuntimeErrorObservation = {
  kind: 'runtime_error'
  /** The engine's id for the error, which a later revocation names. */
  key: string
  errorKind: 'uncaught' | 'unhandled_rejection'
  message: string
  time: number
  url?: string
  line?: number
  column?: number
  frame?: FrameRole
  stack: ObservedFrame[]
}

export type RequestObservation = {
  kind: 'request'
  key: string
  method: string
  url: string
  resourceType?: string
  frame?: FrameRole
  time: number
  redirectedFrom?: string
}

export type ResponseObservation = {
  kind: 'response'
  key: string
  status: number
  statusText?: string
  contentType?: string
  time: number
  cache?: 'disk' | 'memory' | 'prefetch' | 'none'
  serviceWorker?: boolean
  protocol?: string
  redirectedTo?: string
}

/** The body of a response began to arrive. */
export type DataObservation = { kind: 'data'; key: string }

export type FinishedObservation = { kind: 'finished'; key: string; time: number; durationMs?: number; transferredBytes?: number }

export type FailedObservation = { kind: 'failed'; key: string; time: number; durationMs?: number; reason: string; canceled?: true; blocked?: string }

/** A rejection the page handled after the engine reported it. */
export type RevokedObservation = { kind: 'revoked'; key: string }

/** The engine handed a hop to a frame of another site or to a worker, outside the scope, so its end is never heard. */
export type LeftObservation = { kind: 'left'; key: string; time: number }

export type NetworkObservation = RequestObservation | ResponseObservation | DataObservation | FinishedObservation | FailedObservation | LeftObservation

export type Observation = ConsoleObservation | RuntimeErrorObservation | NetworkObservation | RevokedObservation

/** Why a collector stopped hearing its page before the parent stopped it. */
export type CollectorLoss = { kind: 'page_crashed' | 'connection_lost'; reason: string; time: number }

/**
 * Where a collector sends what it hears. `observe` takes each observation in the order the engine sent it;
 * `unreadable` an event the collector could not read, named by its method; `lost` the end of the page or of the
 * connection to it, after which nothing more arrives.
 */
export interface DiagnosticSink {
  observe(observation: Observation): void
  unreadable(method: string): void
  lost(loss: CollectorLoss): void
}

/** A collector that runs: what it covers, and `stop`, which removes its listeners at once and is safe to repeat. */
export type DiagnosticCollection = { readonly scope: DiagnosticScope; stop(): void }
