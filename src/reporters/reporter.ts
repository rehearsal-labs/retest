import type { RetestEvent } from '../protocol/events.ts'
import type { RunResult } from '../protocol/result.ts'

/** Receives every event in sequence order, then the result. A reporter never decides an outcome. */
export interface Reporter {
  /** Recorded in `run.started`, and named in a failure when the reporter throws. */
  readonly name: string
  onEvent(event: RetestEvent): void | Promise<void>
  onRunEnd(result: RunResult, context?: { readonly redactText: (text: string) => string }): void | Promise<void>
}
