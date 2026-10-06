import type { ObserveAfter, CommandResult, PageCommand } from '../protocol/commands.ts'
import type { EvaluationAnswer, EvaluationCall } from '../protocol/evaluation.ts'
import type { ChildEvent } from '../protocol/events.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Work } from './command-lanes.ts'
import type { RunTime } from './run-time.ts'
import type { Hook, RunnableTest, RuntimeContext } from './test-body.ts'
import { describeCommand } from '../protocol/commands.ts'
import { Deadline, elapsedMs, smallestBudget } from '../protocol/deadline.ts'
import { failure, withAlso, withLocation } from '../protocol/failures.ts'
import { formatLine } from '../protocol/location.ts'
import { readCallOptions } from './call-options.ts'
import { CommandLanes } from './command-lanes.ts'
import { callInScope, currentScope, type Scope } from './context.ts'
import { failureFrom, fromEarlierTest, RetestError } from './failure.ts'
import { Operation } from './operation.ts'
import { hostTime } from './run-time.ts'
import { callerLocation, describeLine } from './source-location.ts'
import { testContext } from './test-context.ts'

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
  /** The apps the parent opened for the test, from the `run` message: its declared apps, or its default app. */
  apps: readonly string[]
  send: (message: ChildMessage) => void
  /** Command ids are unique in the process, so an answer meant for an earlier test never reaches a later one. */
  nextCommandId: () => number
  /** The clock the test's budgets and durations count on, and the waits assertions poll with. The host's by default. */
  time?: RunTime
}

/** How a test ended, as the child reports it. */
export type Verdict = { status: 'passed' | 'failed'; failure?: Failure; assertionCount: number; durationMs: number }

type ActionCommand = Exclude<PageCommand, { kind: 'observe' | 'observePage' }>
type Progress = { readonly observed: boolean; readonly settled: boolean }
type Tracked = Work & { kind: 'action' | 'assertion' | 'read' | 'step'; operation: Progress }
type Ending = { kind: 'returned' } | { kind: 'threw'; error: unknown } | { kind: 'aborted' }
type HookKind = 'beforeEach' | 'afterEach'
/** A command's budget, where the test sent it from, and the time the call gave itself, when it gave one. */
type Sending = { readonly timeoutMs: number; readonly location: SourceLocation | undefined; readonly callTimeoutMs?: number }

// Commands that open a document, which the navigation budget times; the parent applies the same rule.
const navigationKinds: ReadonlySet<string> = new Set(['goto', 'reload', 'goBack', 'goForward'])

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/**
 * One test running in the child. It runs the test's hooks and function, sends each app's commands one at a
 * time, tracks every action, assertion and step the test creates, records each failure as it happens, and
 * decides the verdict.
 */
export class TestRun {
  readonly testId: string
  readonly attemptId: string
  readonly name: string
  readonly timeouts: Timeouts
  readonly time: RunTime
  readonly #options: TestRunOptions
  readonly #startedAt: number
  readonly #deadline: Deadline
  readonly #failures: Failure[] = []
  readonly #answers = new Map<number, (result: CommandResult) => void>()
  readonly #evaluations = new Map<number, (answer: EvaluationAnswer) => void>()
  readonly #lanes = new CommandLanes()
  readonly #aborted = Promise.withResolvers<void>()
  // Work created since the last function the test ran returned; each function answers for its own.
  #tracked: Tracked[] = []
  #assertionCount = 0
  #stepCount = 0
  #state: 'running' | 'aborted' | 'finished' = 'running'

  constructor(options: TestRunOptions) {
    this.#options = options
    this.testId = options.testId
    this.attemptId = options.attemptId
    this.name = options.name
    this.timeouts = options.timeouts
    this.time = options.time ?? hostTime
    this.#startedAt = this.time.now()
    this.#deadline = new Deadline(options.timeouts.test, { startedAt: this.#startedAt, clock: this.time.now })
  }

  /** The apps the parent opened for the test, in order: its declared apps, or its default app. */
  get apps(): readonly string[] {
    return this.#options.apps
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

  /**
   * Runs the test: its `beforeEach` hooks until one throws, its function if none did, then every `afterEach`
   * hook, and decides the verdict. It stops waiting at once when the parent aborts.
   */
  async execute(test: RunnableTest): Promise<Verdict> {
    const built = testContext(this, test.apps, this.#options.apps)
    if ('failure' in built) {
      this.record(built.failure)
      return this.#finish(false)
    }
    const { context } = built
    let ending = await this.#hooks('beforeEach', test.hooks.beforeEach, context)
    if (ending.kind === 'returned') ending = await this.#phase('the test', () => test.body(context))
    if (ending.kind === 'aborted') return this.#finish(true)
    const after = await this.#hooks('afterEach', test.hooks.afterEach, context)
    return this.#finish(after.kind === 'aborted')
  }

  /** The parent stopped the test: refuse new commands and stop waiting for its code. */
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

  /**
   * Asks the parent to run an AI check. The parent captures the evidence, calls the judge and records the verdict
   * itself; the answer only tells the test how it went. Ids share the command counter, so an answer meant for an
   * earlier test never reaches a later one.
   */
  requestEvaluation(call: EvaluationCall, location: SourceLocation | undefined): Promise<EvaluationAnswer> {
    const id = this.#options.nextCommandId()
    const stepId = currentScope()?.stepId
    const { promise, resolve } = Promise.withResolvers<EvaluationAnswer>()
    this.#evaluations.set(id, resolve)
    this.#options.send({ type: 'evaluate', testId: this.testId, attemptId: this.attemptId, id, call, ...(location === undefined ? {} : { location }), ...(stepId === undefined ? {} : { stepId }) })
    return promise
  }

  resolveEvaluation(id: number, answer: EvaluationAnswer): void {
    const resolve = this.#evaluations.get(id)
    if (resolve === undefined) return
    this.#evaluations.delete(id)
    resolve(answer)
  }

  emit(event: ChildEvent): void {
    if (this.#state !== 'finished') this.#options.send({ type: 'event', event })
  }

  countAssertion(): void {
    if (this.#state === 'running') this.#assertionCount++
  }

  /** How long an assertion may keep looking: its own budget, or `ownMs`, cut to what the test has left. */
  assertionBudget(ownMs: number = this.timeouts.assertion): number {
    return smallestBudget(ownMs, this.#deadline.commandTimeoutMs)
  }

  /**
   * Starts an action on an app at once. It fails straight away if anything else is running on that app. `options`
   * are what the test passed the action, such as `{ timeout: 2000 }`, which may shorten its budget and never
   * lengthen it.
   */
  action(app: string, command: ActionCommand, location: SourceLocation | undefined, options?: unknown): Operation<void> {
    const work = { label: describeCommand(command), location }
    const operation = this.#track<void>('action', work)
    const read = readCallOptions(calledMethod(command), options)
    if (!read.ok) {
      operation.reject(this.#refusal() ?? this.fail(failure('usage', read.problem, location)))
      return operation
    }
    const refusal = this.#refusal() ?? this.#whileReading(work) ?? this.#clash(app, work, 'action')
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    this.#lanes.startAction(app, work)
    const budget = navigationKinds.has(command.kind) ? this.timeouts.navigation : this.timeouts.action
    const own = read.timeoutMs === undefined ? {} : { callTimeoutMs: read.timeoutMs }
    const timeoutMs = read.timeoutMs === undefined ? budget : smallestBudget(read.timeoutMs, budget)
    void this.#send(app, command, { timeoutMs, location, ...own }).then((result) => {
      this.#lanes.endAction(app, work)
      if (result.ok) operation.resolve()
      else operation.reject(this.fail(withLocation(result.failure, location)))
    })
    return operation
  }

  /**
   * An assertion that starts only when test code awaits it. One that looks at an app's page waits for no
   * action there; one that reads a value (`app` undefined) touches no page.
   */
  assertion(label: string, location: SourceLocation | undefined, check: () => Promise<void>, app?: string | readonly string[]): Operation<void> {
    const work = { label, location }
    const operation: Operation<void> = this.#track('assertion', work, () => this.#startAssertion(operation, work, check, app))
    return operation
  }

  /**
   * Reads an app's page once for an assertion. With `after`, the page first waits for its next change, or `after.waitMs`.
   * The look is marked as a check's, so the parent knows an assertion will report on it.
   */
  observe(app: string, locator: LocatorRecipe, timeoutMs: number, location: SourceLocation | undefined, after?: ObserveAfter): Promise<CommandResult> {
    const refusal = this.#refusal()
    if (refusal !== undefined) return Promise.resolve({ ok: false, failure: refusal.failure })
    return this.#send(app, { kind: 'observe', locator, ...(after === undefined ? {} : { after }), check: true }, { timeoutMs, location })
  }

  /**
   * Reads an app's page once for an assertion: its address and title. With `after`, the page first waits for its next
   * change. The look is marked as a check's, as `observe` marks its own.
   */
  observePage(app: string, timeoutMs: number, location: SourceLocation | undefined, after?: ObserveAfter): Promise<CommandResult> {
    const refusal = this.#refusal()
    if (refusal !== undefined) return Promise.resolve({ ok: false, failure: refusal.failure })
    return this.#send(app, { kind: 'observePage', ...(after === undefined ? {} : { after }), check: true }, { timeoutMs, location })
  }

  /**
   * Reads an app's page once outside any check, its address and title, as `page.url()` and `page.title()` do inside
   * `read`. No assertion follows such a look, so it is not marked as a check's.
   */
  readPage(app: string, timeoutMs: number, location: SourceLocation | undefined): Promise<CommandResult> {
    const refusal = this.#refusal()
    if (refusal !== undefined) return Promise.resolve({ ok: false, failure: refusal.failure })
    return this.#send(app, { kind: 'observePage' }, { timeoutMs, location })
  }

  /**
   * Reads an app's page outside an assertion, as `page.url()` does: it starts at once, waits for no action, and fails
   * straight away if an action is running on that app. It only reads, so it may run inside the function
   * `expect.poll` calls.
   */
  read<T>(app: string, label: string, location: SourceLocation | undefined, read: () => Promise<T>): Operation<T> {
    const work = { label, location }
    const operation = this.#track<T>('read', work)
    const refusal = this.#refusal() ?? this.#clash(app, work, 'look')
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    this.#lanes.startLook(app, work)
    read().then(
      (value) => {
        this.#lanes.endLook(app, work)
        operation.resolve(value)
      },
      (error: unknown) => {
        this.#lanes.endLook(app, work)
        operation.reject(error)
      },
    )
    return operation
  }

  /** Runs a named step inside the test and resolves with its value. */
  step<T>(name: string, body: () => T | Promise<T>, location: SourceLocation | undefined, parentStepId?: string): Operation<T> {
    const operation = this.#track<T>('step', { label: `test.step(${JSON.stringify(name)})`, location })
    const refusal = this.#refusal()
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    const stepId = this.#startStep(name, location, { parentStepId })
    const startedAt = this.time.now()
    // A step inside the function `expect.poll` calls may only read, like the function around it.
    const scope: Scope = currentScope()?.reading === true ? { run: this, stepId, reading: true } : { run: this, stepId }
    callInScope(scope, body).then(
      (value) => {
        this.#finishStep(stepId, startedAt, undefined)
        operation.resolve(value)
      },
      (error: unknown) => {
        this.#finishStep(stepId, startedAt, failureFrom(error, this.#options.rootDir))
        operation.reject(error)
      },
    )
    return operation
  }

  /** Describes a location for a message: `line 7` in the test's own file, `file:line` elsewhere. */
  describeLine(location: SourceLocation | undefined): string {
    return describeLine(location, this.#options.file)
  }

  // Each hook runs as a step marked with its kind. `beforeEach` hooks stop at the first that throws; every
  // `afterEach` hook runs, so its failures sit beside the test's own.
  async #hooks(kind: HookKind, hooks: readonly Hook[], context: RuntimeContext): Promise<Ending> {
    for (const hook of hooks) {
      const ending = await this.#hook(kind, hook, context)
      if (ending.kind === 'aborted' || (ending.kind === 'threw' && kind === 'beforeEach')) return ending
    }
    return { kind: 'returned' }
  }

  async #hook(kind: HookKind, hook: Hook, context: RuntimeContext): Promise<Ending> {
    const stepId = this.#startStep(kind, hook.location, { hook: kind })
    const startedAt = this.time.now()
    const recordedBefore = this.#failures.length
    const ending = await this.#phase(`its ${kind} hook`, () => hook.body(context), stepId)
    if (ending.kind !== 'aborted') this.#finishStep(stepId, startedAt, this.#failures[recordedBefore])
    return ending
  }

  // Runs one function of the test. When it ends, what it threw and any work it left behind are recorded.
  async #phase(what: string, body: () => unknown, stepId?: string): Promise<Ending> {
    const scope: Scope = stepId === undefined ? { run: this } : { run: this, stepId }
    const ending = await Promise.race<Ending>([
      callInScope(scope, body).then(
        (): Ending => ({ kind: 'returned' }),
        (error: unknown): Ending => ({ kind: 'threw', error }),
      ),
      this.#aborted.promise.then((): Ending => ({ kind: 'aborted' })),
    ])
    if (ending.kind === 'aborted') return ending
    // Rejections nobody handled are reported after the current microtasks; let them arrive first.
    await yieldToEventLoop()
    if (ending.kind === 'threw') this.recordThrown(ending.error)
    for (const problem of this.#unfinishedWork(what)) this.record(problem)
    return ending
  }

  #startStep(name: string, location: SourceLocation | undefined, marks: { parentStepId?: string | undefined; hook?: HookKind }): string {
    this.#stepCount++
    const stepId = `step-${this.#stepCount}`
    this.emit({
      type: 'step.started',
      testId: this.testId,
      attemptId: this.attemptId,
      stepId,
      name,
      ...(marks.parentStepId === undefined ? {} : { parentStepId: marks.parentStepId }),
      ...(location === undefined ? {} : { location }),
      ...(marks.hook === undefined ? {} : { hook: marks.hook }),
    })
    return stepId
  }

  #finishStep(stepId: string, startedAt: number, problem: Failure | undefined): void {
    const scope = { testId: this.testId, attemptId: this.attemptId, stepId, durationMs: elapsedMs(startedAt, this.time.now) }
    if (problem === undefined) this.emit({ type: 'step.finished', ...scope, status: 'passed' })
    else this.emit({ type: 'step.finished', ...scope, status: 'failed', failure: problem })
  }

  // A check that looks at several apps, as an AI check over screenshots of each does, holds the look lane of every one.
  #startAssertion(operation: Operation<void>, work: Work, check: () => Promise<void>, app: string | readonly string[] | undefined): void {
    const apps = app === undefined ? [] : typeof app === 'string' ? [app] : app
    const refusal = this.#refusal() ?? apps.map((each) => this.#clash(each, work, 'look')).find((clash) => clash !== undefined)
    if (refusal !== undefined) return operation.reject(refusal)
    for (const each of apps) this.#lanes.startLook(each, work)
    check().then(
      () => {
        for (const each of apps) this.#lanes.endLook(each, work)
        operation.resolve()
      },
      (error: unknown) => {
        for (const each of apps) this.#lanes.endLook(each, work)
        operation.reject(error)
      },
    )
  }

  #send(app: string, command: PageCommand, sending: Sending): Promise<CommandResult> {
    const id = this.#options.nextCommandId()
    const stepId = currentScope()?.stepId
    const { promise, resolve } = Promise.withResolvers<CommandResult>()
    const { timeoutMs, location, callTimeoutMs } = sending
    this.#answers.set(id, resolve)
    this.#options.send({
      type: 'command',
      testId: this.testId,
      attemptId: this.attemptId,
      id,
      app,
      command,
      timeoutMs,
      ...(location === undefined ? {} : { location }),
      ...(stepId === undefined ? {} : { stepId }),
      ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
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

  #whileReading(work: Work): RetestError | undefined {
    if (currentScope()?.reading !== true) return undefined
    const message = `expect.poll() calls its function again on every look, so the function may only read. ${work.label} on ${this.describeLine(work.location)} would run again each time.`
    return this.fail(failure('usage', message, work.location))
  }

  // An action needs the app to itself; an assertion's look only needs no action running there.
  #clash(app: string, next: Work, kind: 'action' | 'look'): RetestError | undefined {
    const running = this.#lanes.blocking(app, kind)
    if (running === undefined) return undefined
    const runningLine = this.describeLine(running.location)
    const message = [
      `${capitalize(runningLine)} (${running.label}) was still running when ${this.describeLine(next.location)} (${next.label}) sent the next command to ${app}.`,
      `Retest sends one command at a time to each app. Add await on ${runningLine}.`,
    ].join(' ')
    const details = { running: lineOrNull(running.location), next: lineOrNull(next.location) }
    return this.fail({ ...failure('concurrent_commands', message, next.location), details })
  }

  #finish(aborted: boolean): Verdict {
    const durationMs = elapsedMs(this.#startedAt, this.time.now)
    const assertionCount = this.#assertionCount
    const problems = [...this.#failures]
    if (!aborted && problems.length === 0 && assertionCount === 0) {
      problems.push(failure('no_assertions', 'The test made no assertions. Check the outcome with expect().', this.#options.location))
    }
    this.#state = 'finished'
    const [first, ...rest] = problems
    if (first !== undefined) return { status: 'failed', failure: withAlso(first, rest), assertionCount, durationMs }
    return { status: aborted ? 'failed' : 'passed', assertionCount, durationMs }
  }

  #isRecorded(error: unknown): boolean {
    return error instanceof RetestError && this.#failures.includes(error.failure)
  }

  // Judges the work created since the last function returned, then forgets it.
  #unfinishedWork(what: string): Failure[] {
    const tracked = this.#tracked
    this.#tracked = []
    return tracked.flatMap((work) => {
      const where = this.describeLine(work.location)
      if (work.kind !== 'step' && !work.operation.observed) {
        const message =
          work.kind === 'assertion'
            ? `${work.label} on ${where} never ran because nothing awaited it. Add await before expect().`
            : `${work.label} on ${where} was never awaited. Add await before it.`
        return [failure('not_awaited', message, work.location)]
      }
      if (work.operation.settled) return []
      return [failure('not_awaited', `${work.label} on ${where} was still running when ${what} returned. Add await before it.`, work.location)]
    })
  }
}

function capitalize(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`
}

// An action's options are refused under the method the test called. A press with no element came from the keyboard,
// and the keyboard's own controls and an alert's answers are commands whose kind no test writes.
function calledMethod(command: ActionCommand): string {
  switch (command.kind) {
    case 'press':
      return command.locator === undefined ? 'keyboard.press' : 'press'
    case 'nativeKeyboard':
      return `keyboard.${command.operation}`
    case 'nativeAlert':
      return `alert.${command.operation}`
    default:
      return command.kind
  }
}

function lineOrNull(location: SourceLocation | undefined): string | null {
  return location === undefined ? null : formatLine(location)
}
