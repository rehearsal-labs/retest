import type { EventBody, EventOrigin, RetestEvent } from '../protocol/events.ts'
import type { Failure } from '../protocol/failures.ts'
import type { RunResult } from '../protocol/result.ts'
import type { Reporter } from '../reporters/reporter.ts'
import type { RunStore } from '../store/run-store.ts'
import { errorMessage, failure } from '../protocol/failures.ts'

export type EventLogOptions = {
  runId: string
  store: RunStore
  reporters: readonly Reporter[]
  /** Monotonic milliseconds since the run started. */
  elapsedMs: () => number
  /** Called on each new reporter or write failure. */
  onFailure: (failure: Failure) => void
  /** Rewrites each event before anything sees it, as the run's redactor does. */
  redact?: (event: RetestEvent) => RetestEvent
  redactText?: (text: string) => string
}

type Delivery = { reporter: Reporter; broken: boolean }

/**
 * The run's only writer of events. It stamps each event with the next sequence number and the time,
 * writes it to `events.jsonl` at once, then hands it to each reporter in order. A reporter that throws
 * is not called again, and the run is told. Each reporter receives its own snapshot, so it cannot change parent
 * facts or another reporter's input. Every failure to keep the output is kept, each once.
 */
export class EventLog {
  readonly #options: EventLogOptions
  readonly #deliveries: Delivery[]
  #sequence = 0
  #queue: Promise<void> = Promise.resolve()
  #writable = true
  readonly #persisted = new WeakSet<RetestEvent>()
  readonly #failures: Failure[] = []

  constructor(options: EventLogOptions) {
    this.#options = options
    this.#deliveries = options.reporters.map((reporter) => ({ reporter, broken: false }))
  }

  /** Every reporter or write failure, in the order they happened. */
  get failures(): readonly Failure[] {
    return this.#failures
  }

  /** Stamps and writes an event. `origin` is `child` for one the test file's process reported. */
  emit(body: EventBody, origin: EventOrigin = 'parent'): RetestEvent {
    const event = this.#record(body, origin)
    this.#queue = this.#queue.then(() => this.#deliver(event))
    return event
  }

  /** Emits an event and reports whether its synchronous store append succeeded. */
  emitPersisted(body: EventBody, origin: EventOrigin = 'parent'): boolean {
    return this.#persisted.has(this.emit(body, origin))
  }

  /** Persists the settled outcome after all reporters have ended, without calling closed reporters again. */
  recordOutcome(result: RunResult): void {
    const { status, exitCode, complete, failure } = result
    this.#record({ type: 'run.outcome', status, exitCode, complete, ...(failure === undefined ? {} : { failure }) }, 'parent')
  }

  #record(body: EventBody, origin: EventOrigin): RetestEvent {
    const stamped: RetestEvent = {
      schemaVersion: 1,
      runId: this.#options.runId,
      sequence: this.#sequence++,
      time: new Date().toISOString(),
      elapsedMs: this.#options.elapsedMs(),
      origin,
      ...body,
    }
    const event = this.#options.redact?.(stamped) ?? stamped
    if (this.#write(event)) this.#persisted.add(event)
    return event
  }

  /** Resolves once every reporter has received every event emitted so far. */
  flush(): Promise<void> {
    return this.#queue
  }

  /** Records a failure to keep the run's output. */
  reportFailure(problem: Failure): void {
    this.#fail(problem)
  }

  /** Gives the finished result to each reporter still working. */
  async end(result: RunResult): Promise<void> {
    await this.flush()
    for (const delivery of this.#deliveries) {
      if (delivery.broken) continue
      try {
        await delivery.reporter.onRunEnd(structuredClone(result), this.#options.redactText === undefined ? undefined : { redactText: this.#options.redactText })
      } catch (error) {
        this.#brokeOn(delivery, 'the end of the run', error)
      }
    }
  }

  #write(event: RetestEvent): boolean {
    if (!this.#writable) return false
    try {
      this.#options.store.appendEvent(event)
      return true
    } catch (error) {
      this.#writable = false
      this.#fail(failure('reporting_failed', `Retest could not write events.jsonl: ${errorMessage(error)}`))
      return false
    }
  }

  async #deliver(event: RetestEvent): Promise<void> {
    for (const delivery of this.#deliveries) {
      if (delivery.broken) continue
      try {
        await delivery.reporter.onEvent(structuredClone(event))
      } catch (error) {
        this.#brokeOn(delivery, event.type, error)
      }
    }
  }

  #brokeOn(delivery: Delivery, moment: string, error: unknown): void {
    delivery.broken = true
    const { name } = delivery.reporter
    this.#fail(failure('reporting_failed', `The ${name} reporter failed on ${moment}: ${errorMessage(error)}`))
  }

  #fail(problem: Failure): void {
    if (this.#failures.some((known) => known.class === problem.class && known.message === problem.message)) return
    this.#failures.push(problem)
    this.#options.onFailure(problem)
  }
}
