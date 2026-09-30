import type { CommandResult, PageCommand } from '../protocol/commands.ts'
import type { ChildEvent } from '../protocol/events.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { TestBody } from './test-body.ts'
import { describeCommand } from '../protocol/commands.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { failure, withAlso, withLocation } from '../protocol/failures.ts'
import { currentScope, runInScope } from './context.ts'
import { failureFrom, fromEarlierTest, RetestError } from './failure.ts'
import { Operation } from './operation.ts'
import { Page } from './page.ts'
import { callerLocation, describeLine } from './source-location.ts'

export type TestRunOptions = {
  testId: string
  attemptId: string
  /** The test's name as declared. */
  name: string
  /** The test's file, POSIX and relative to `rootDir`. */
  file: string
  rootDir: string
  location: SourceLocation
  timeouts: Timeouts
  send: (message: ChildMessage) => void
  /** Command ids are unique in the process, so an answer meant for an earlier test never reaches a later one. */
  nextCommandId: () => number
}

/** How a test ended, as the child reports it. */
export type Verdict = { status: 'passed' | 'failed'; failure?: Failure; assertionCount: number; durationMs: number }

type ActionCommand = Exclude<PageCommand, { kind: 'observe' }>
type Work = { label: string; location: SourceLocation | undefined }
type Progress = { readonly observed: boolean; readonly settled: boolean }
type Tracked = Work & { kind: 'action' | 'assertion' | 'step'; operation: Progress }
type Ending = { kind: 'returned' } | { kind: 'threw'; error: unknown } | { kind: 'aborted' }

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * One test running in the child. It sends page commands one at a time, tracks every action, assertion
 * and step the test creates, records each failure as it happens, and decides the verdict.
 */
export class TestRun {
  readonly testId: string
  readonly attemptId: string
  readonly name: string
  readonly timeouts: Timeouts
  readonly #options: TestRunOptions
  readonly #startedAt = monotonicClock()
  readonly #deadline: Deadline
  readonly #failures: Failure[] = []
  readonly #tracked: Tracked[] = []
  readonly #answers = new Map<number, (result: CommandResult) => void>()
  readonly #assertionsRunning = new Set<Work>()
  readonly #aborted = Promise.withResolvers<void>()
  #action: Work | undefined
  #assertionCount = 0
  #stepCount = 0
  #state: 'running' | 'aborted' | 'finished' = 'running'

  constructor(options: TestRunOptions) {
    this.#options = options
    this.testId = options.testId
    this.attemptId = options.attemptId
    this.name = options.name
    this.timeouts = options.timeouts
    this.#deadline = new Deadline(options.timeouts.test, { startedAt: this.#startedAt })
  }

  /** Where the test code that called into Retest sits. */
  location(): SourceLocation | undefined {
    return callerLocation(this.#options.rootDir)
  }

  /** Records a failure against the test and returns the error to throw into test code. */
  fail(problem: Failure): RetestError {
    this.record(problem)
    return new RetestError(problem)
  }

  /** Records a failure. Once the test has been stopped or has ended, nothing more counts against it. */
  record(problem: Failure): void {
    if (this.#state === 'running') this.#failures.push(problem)
  }

  /**
   * Records something thrown that nobody handled. A Retest error the test recorded where it happened is
   * not recorded again; one thrown outside any test, such as `expect()` called from a stray callback, is.
   * `origin` is the test whose code threw it, when that code ran inside a test; an earlier test is named.
   */
  recordThrown(error: unknown, origin?: TestRun): void {
    if (this.#isRecorded(error)) return
    const problem = failureFrom(error, this.#options.rootDir)
    this.record(origin === undefined || origin === this ? problem : fromEarlierTest(problem, origin.name))
  }

  /** Runs the test body and decides the verdict, or stops waiting for it when the parent aborts. */
  async execute(body: TestBody): Promise<Verdict> {
    const page = new Page(this)
    const ending = await Promise.race<Ending>([
      runInScope({ run: this }, () => invoke(() => body({ page }))).then(
        (): Ending => ({ kind: 'returned' }),
        (error: unknown): Ending => ({ kind: 'threw', error }),
      ),
      this.#aborted.promise.then((): Ending => ({ kind: 'aborted' })),
    ])
    // Rejections nobody handled are reported after the current microtasks; let them arrive first.
    if (ending.kind !== 'aborted') await yieldToEventLoop()
    const verdict = this.#verdict(ending)
    this.#state = 'finished'
    return verdict
  }

  /** The parent stopped the test: refuse new commands and stop waiting for the body. */
  abort(): void {
    if (this.#state !== 'running') return
    this.#state = 'aborted'
    this.#aborted.resolve()
  }

  resolveCommand(id: number, result: CommandResult): void {
    const answer = this.#answers.get(id)
    if (answer === undefined) return
    this.#answers.delete(id)
    answer(result)
  }

  emit(event: ChildEvent): void {
    if (this.#state !== 'finished') this.#options.send({ type: 'event', event })
  }

  countAssertion(): void {
    if (this.#state === 'running') this.#assertionCount++
  }

  /** How long an assertion may keep looking: its own budget, cut to what the test has left. */
  assertionBudget(): number {
    return smallestBudget(this.timeouts.assertion, this.#deadline.commandTimeoutMs)
  }

  /** Starts an action at once. It fails straight away if anything else is running on the page. */
  action(command: ActionCommand, location: SourceLocation | undefined): Operation<void> {
    const work = { label: describeCommand(command), location }
    const operation = this.#track<void>('action', work)
    const refusal = this.#refusal() ?? this.#clash(work, 'action')
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    this.#action = work
    const budget = command.kind === 'goto' ? this.timeouts.navigation : this.timeouts.action
    void this.#send(command, budget, location).then((result) => {
      if (this.#action === work) this.#action = undefined
      if (result.ok) operation.resolve()
      else operation.reject(this.fail(withLocation(result.failure, location)))
    })
    return operation
  }

  /** An assertion that starts only when test code awaits it. */
  assertion(label: string, location: SourceLocation | undefined, check: () => Promise<void>): Operation<void> {
    const work = { label, location }
    const operation: Operation<void> = this.#track('assertion', work, () => this.#startAssertion(operation, work, check))
    return operation
  }

  /** Reads the page once for an assertion. */
  observe(locator: LocatorRecipe, timeoutMs: number, location: SourceLocation | undefined): Promise<CommandResult> {
    const refusal = this.#refusal()
    if (refusal !== undefined) return Promise.resolve({ ok: false, failure: refusal.failure })
    return this.#send({ kind: 'observe', locator }, timeoutMs, location)
  }

  /** Runs a named step inside the test and resolves with its value. */
  step<T>(name: string, body: () => T | Promise<T>, location: SourceLocation | undefined, parentStepId?: string): Operation<T> {
    const operation = this.#track<T>('step', { label: `test.step(${JSON.stringify(name)})`, location })
    const refusal = this.#refusal()
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    this.#stepCount++
    const stepId = `step-${this.#stepCount}`
    const scope = { testId: this.testId, attemptId: this.attemptId, stepId }
    const startedAt = monotonicClock()
    this.emit({
      type: 'step.started',
      ...scope,
      name,
      ...(parentStepId === undefined ? {} : { parentStepId }),
      ...(location === undefined ? {} : { location }),
    })
    runInScope({ run: this, stepId }, () => invoke(body)).then(
      (value) => {
        this.emit({ type: 'step.finished', ...scope, status: 'passed', durationMs: elapsedMs(startedAt) })
        operation.resolve(value)
      },
      (error: unknown) => {
        const problem = failureFrom(error, this.#options.rootDir)
        this.emit({ type: 'step.finished', ...scope, status: 'failed', durationMs: elapsedMs(startedAt), failure: problem })
        operation.reject(error)
      },
    )
    return operation
  }

  /** Describes a location for a message: `line 7` in the test's own file, `file:line` elsewhere. */
  describeLine(location: SourceLocation | undefined): string {
    return describeLine(location, this.#options.file)
  }

  #startAssertion(operation: Operation<void>, work: Work, check: () => Promise<void>): void {
    const refusal = this.#refusal() ?? this.#clash(work, 'assertion')
    if (refusal !== undefined) return operation.reject(refusal)
    this.#assertionsRunning.add(work)
    check().then(
      () => {
        this.#assertionsRunning.delete(work)
        operation.resolve()
      },
      (error: unknown) => {
        this.#assertionsRunning.delete(work)
        operation.reject(error)
      },
    )
  }

  #send(command: PageCommand, timeoutMs: number, location: SourceLocation | undefined): Promise<CommandResult> {
    const id = this.#options.nextCommandId()
    const stepId = currentScope()?.stepId
    const { promise, resolve } = Promise.withResolvers<CommandResult>()
    this.#answers.set(id, resolve)
    this.#options.send({
      type: 'command',
      id,
      command,
      timeoutMs,
      ...(location === undefined ? {} : { location }),
      ...(stepId === undefined ? {} : { stepId }),
    })
    return promise
  }

  #track<T>(kind: Tracked['kind'], work: Work, start?: () => void): Operation<T> {
    const operation = new Operation<T>(start)
    this.#tracked.push({ ...work, kind, operation })
    return operation
  }

  #refusal(): RetestError | undefined {
    if (this.#state === 'running') return undefined
    return new RetestError(failure('interrupted', 'This test has already ended, so Retest sent nothing to the page.'))
  }

  // An action needs the page to itself; an assertion only needs no action running.
  #clash(next: Work, kind: 'action' | 'assertion'): RetestError | undefined {
    const running = this.#action ?? (kind === 'action' ? this.#assertionsRunning.values().next().value : undefined)
    if (running === undefined) return undefined
    const runningLine = this.describeLine(running.location)
    const message = [
      `${capitalize(runningLine)} (${running.label}) was still running when ${this.describeLine(next.location)} (${next.label}) sent the next command to page.`,
      `Retest sends one command at a time to each page. Add await on ${runningLine}.`,
    ].join(' ')
    const details = { running: formatLocation(running.location), next: formatLocation(next.location) }
    return this.fail({ ...failure('concurrent_commands', message, next.location), details })
  }

  #verdict(ending: Ending): Verdict {
    const durationMs = elapsedMs(this.#startedAt)
    const assertionCount = this.#assertionCount
    const problems = [...this.#failures]
    if (ending.kind === 'threw' && !this.#isRecorded(ending.error)) {
      problems.push(failureFrom(ending.error, this.#options.rootDir))
    }
    if (ending.kind !== 'aborted') problems.push(...this.#unfinishedWork())
    if (ending.kind !== 'aborted' && problems.length === 0 && assertionCount === 0) {
      problems.push(failure('no_assertions', 'The test made no assertions. Check the outcome with expect().', this.#options.location))
    }
    const [first, ...rest] = problems
    if (first !== undefined) return { status: 'failed', failure: withAlso(first, rest), assertionCount, durationMs }
    return { status: ending.kind === 'aborted' ? 'failed' : 'passed', assertionCount, durationMs }
  }

  #isRecorded(error: unknown): boolean {
    return error instanceof RetestError && this.#failures.includes(error.failure)
  }

  #unfinishedWork(): Failure[] {
    return this.#tracked.flatMap((work) => {
      const where = this.describeLine(work.location)
      if (work.kind !== 'step' && !work.operation.observed) {
        const message =
          work.kind === 'assertion'
            ? `${work.label} on ${where} never ran because nothing awaited it. Add await before expect().`
            : `${work.label} on ${where} was never awaited. Add await before it.`
        return [failure('not_awaited', message, work.location)]
      }
      if (work.operation.settled) return []
      return [failure('not_awaited', `${work.label} on ${where} was still running when the test returned. Add await before it.`, work.location)]
    })
  }
}

function invoke<T>(body: () => T | Promise<T>): Promise<T> {
  return (async () => body())()
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

function formatLocation(location: SourceLocation | undefined): string | null {
  return location === undefined ? null : `${location.file}:${location.line}`
}
