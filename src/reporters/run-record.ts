import type { RetestEvent } from '../protocol/events.ts'
import type { SourceLocation } from '../protocol/failures.ts'
import { variantKey, type Variant } from '../protocol/variant.ts'

export type EventOfType<T extends RetestEvent['type']> = Extract<RetestEvent, { type: T }>

/** An event that belongs to one test. */
export type TestEvent = Extract<RetestEvent, { testId: string }> | (EventOfType<'artifact.removal_requested' | 'artifact.removed' | 'artifact.removal_failed'> & { testId: string; attemptId: string })

/** A test as collection or its start described it, one per variant when it runs on several targets. */
export type TestDescription = {
  testId: string
  name: string
  file: string
  location: SourceLocation
  /** A `test.for` row's number in its list, from 1. */
  row?: number | undefined
  /** Declared with `test.skip`, or inside `test.describe.skip`. */
  skip?: true | undefined
  describePath?: string[] | undefined
  variant?: Variant | undefined
  variantKey?: string | undefined
  setup?: true | undefined
  /** For a setup taken from a file the run was not given, the files whose tests start from its state. */
  setupFor?: string[] | undefined
}

export type TestRecord = TestDescription & {
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

/**
 * What identifies one result: the test, and its variant when it has one.
 *
 * @example resultKey('a.retest.ts > saves', 'web=beta') // 'a.retest.ts > saves [web=beta]'
 */
function resultKey(testId: string, variant?: string): string {
  return variant === undefined ? testId : `${testId} [${variant}]`
}

/** What a run's events say so far. Reporters and `inspect` read it; it never decides an outcome. */
export class RunRecord {
  started: EventOfType<'run.started'> | undefined
  /**
   * The first target the run started browsers for, as its first line names it: the browser that says how many the
   * target has. A target's browsers start together, so a further one, which carries only its number, may come first.
   */
  browser: EventOfType<'browser.started'> | undefined
  /** Every browser the run started, in order. */
  readonly browsers: EventOfType<'browser.started'>[] = []
  readonly natives: EventOfType<'native.started'>[] = []
  /** The run's media process and what it did outside any test: its starts, failures, loss, close and leftovers found. */
  readonly media: EventOfType<'media.started' | 'media.failed' | 'media.lost' | 'media.closed' | 'media.leftovers'>[] = []
  /** Retention requests and their removal or failure completions. */
  readonly removals: EventOfType<'artifact.removal_requested' | 'artifact.removed' | 'artifact.removal_failed'>[] = []
  finished: EventOfType<'run.finished'> | undefined
  outcome: EventOfType<'run.outcome'> | undefined
  /** How `test.only` narrowed the run, when it did. */
  narrowed: EventOfType<'run.narrowed'> | undefined
  last: RetestEvent | undefined
  readonly files: Map<string, FileRecord> = new Map()
  /** Keyed by `resultKey`. */
  readonly tests: Map<string, TestRecord> = new Map()
  /** Events naming a test that no collection or start described. */
  readonly strays: TestEvent[] = []

  add(event: RetestEvent): void {
    this.last = event
    if (event.type === 'native.started') this.natives.push(event)
    switch (event.type) {
      case 'run.started':
        this.started = event
        for (const file of event.files) this.#file(file)
        return
      case 'browser.started':
        if (event.instance === undefined) this.browser ??= event
        this.browsers.push(event)
        return
      case 'run.finished':
        this.finished = event
        return
      case 'run.outcome':
        this.outcome = event
        return
      case 'run.narrowed':
        this.narrowed = event
        return
      case 'app.started':
      case 'app.reused':
      case 'app.failed':
        return
      case 'media.started':
      case 'media.failed':
      case 'media.lost':
      case 'media.closed':
      case 'media.leftovers':
        this.media.push(event)
        return
      case 'artifact.removal_requested':
      case 'artifact.removed':
      case 'artifact.removal_failed':
        this.removals.push(event)
        if (event.testId !== undefined && event.attemptId !== undefined) {
          const scoped = { ...event, testId: event.testId, attemptId: event.attemptId }
          const test = this.test(scoped.testId, scoped.variantKey) ?? [...this.tests.values()].find((record) => record.testId === scoped.testId && record.started?.attemptId === scoped.attemptId)
          if (test === undefined) this.strays.push(scoped)
          else test.events.push(scoped)
        }
        return
      case 'collection.completed': {
        const file = this.#file(event.file)
        file.collection = event
        for (const test of event.tests) {
          const variants = test.variants ?? []
          if (variants.length === 0) this.#test({ ...test, file: event.file })
          for (const variant of variants) this.#test({ ...test, file: event.file, variant, variantKey: variantKey(variant) })
        }
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
        const test = this.test(event.testId, event.variantKey)
        if (test === undefined) {
          this.strays.push(event)
          return
        }
        test.events.push(event)
        if (event.type === 'test.finished') test.finished = event
      }
    }
  }

  /** The record of one test, or of one of its variants. */
  test(testId: string, variant?: string): TestRecord | undefined {
    return this.tests.get(resultKey(testId, variant))
  }

  #file(name: string): FileRecord {
    const existing = this.files.get(name)
    if (existing !== undefined) return existing
    const file: FileRecord = { file: name, tests: [] }
    this.files.set(name, file)
    return file
  }

  #test(described: TestDescription): TestRecord {
    const key = resultKey(described.testId, described.variantKey)
    const existing = this.tests.get(key)
    if (existing !== undefined) return existing
    const test: TestRecord = {
      testId: described.testId,
      name: described.name,
      file: described.file,
      location: described.location,
      row: described.row,
      describePath: described.describePath,
      variant: described.variant,
      variantKey: described.variantKey,
      setup: described.setup,
      setupFor: described.setupFor,
      skip: described.skip,
      events: [],
    }
    this.tests.set(key, test)
    this.#file(described.file).tests.push(test)
    return test
  }
}

/**
 * A record of every event given.
 *
 * @example recordEvents(events).test('examples/task.retest.ts > saves a task')
 */
export function recordEvents(events: Iterable<RetestEvent>): RunRecord {
  const record = new RunRecord()
  for (const event of events) record.add(event)
  return record
}
