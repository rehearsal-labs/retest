import type { RetestEvent } from '../protocol/events.ts'
import type { SourceLocation } from '../protocol/failures.ts'

export type EventOfType<T extends RetestEvent['type']> = Extract<RetestEvent, { type: T }>

/** An event that belongs to one test. */
export type TestEvent = Extract<RetestEvent, { testId: string }>

export type TestRecord = {
  testId: string
  name: string
  file: string
  location: SourceLocation
  /** Every event of the test, in sequence order. */
  events: TestEvent[]
  started?: EventOfType<'test.started'>
  finished?: EventOfType<'test.finished'>
}

export type FileRecord = {
  file: string
  collection?: EventOfType<'collection.completed'> | EventOfType<'collection.failed'>
  /** The file's process failed outside its tests. */
  failed?: EventOfType<'file.failed'>
  tests: TestRecord[]
}

/** What a run's events say so far. Reporters and `inspect` read it; it never decides an outcome. */
export class RunRecord {
  started: EventOfType<'run.started'> | undefined
  browser: EventOfType<'browser.started'> | undefined
  finished: EventOfType<'run.finished'> | undefined
  last: RetestEvent | undefined
  readonly files: Map<string, FileRecord> = new Map()
  readonly tests: Map<string, TestRecord> = new Map()
  /** Events naming a test that no collection or start described. */
  readonly strays: TestEvent[] = []

  add(event: RetestEvent): void {
    this.last = event
    switch (event.type) {
      case 'run.started':
        this.started = event
        for (const file of event.files) this.#file(file)
        return
      case 'browser.started':
        this.browser = event
        return
      case 'run.finished':
        this.finished = event
        return
      case 'collection.completed': {
        const file = this.#file(event.file)
        file.collection = event
        for (const test of event.tests) this.#test({ ...test, file: event.file })
        return
      }
      case 'collection.failed':
        this.#file(event.file).collection = event
        return
      case 'file.failed':
        this.#file(event.file).failed = event
        return
      case 'test.started': {
        const test = this.#test(event)
        test.started = event
        test.events.push(event)
        return
      }
      default: {
        const test = this.tests.get(event.testId)
        if (test === undefined) {
          this.strays.push(event)
          return
        }
        test.events.push(event)
        if (event.type === 'test.finished') test.finished = event
      }
    }
  }

  #file(name: string): FileRecord {
    const existing = this.files.get(name)
    if (existing !== undefined) return existing
    const file: FileRecord = { file: name, tests: [] }
    this.files.set(name, file)
    return file
  }

  #test(described: { testId: string; name: string; file: string; location: SourceLocation }): TestRecord {
    const existing = this.tests.get(described.testId)
    if (existing !== undefined) return existing
    const { testId, name, file, location } = described
    const test: TestRecord = { testId, name, file, location, events: [] }
    this.tests.set(testId, test)
    this.#file(file).tests.push(test)
    return test
  }
}

/**
 * A record of every event given.
 *
 * @example recordEvents(events).tests.get('examples/task.retest.ts > saves a task')
 */
export function recordEvents(events: Iterable<RetestEvent>): RunRecord {
  const record = new RunRecord()
  for (const event of events) record.add(event)
  return record
}
