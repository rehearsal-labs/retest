import type { ObserveAfter, CommandResult, PageCommand } from '../protocol/commands.ts'
import type { EvaluationAnswer, EvaluationCall } from '../protocol/evaluation.ts'
import type { ChildEvent } from '../protocol/events.ts'
import type { Failure, SourceLocation } from '../protocol/failures.ts'
import type { DialogAnswer, DialogRecord, DialogType } from '../protocol/dialogs.ts'
import type { FilesAnswer, FilesRequest } from '../protocol/files.ts'
import type { RouteReply, RouteRequest } from '../protocol/routes.ts'
import type { InboxAnswer, InboxRequest, ReceivedMessageRecord } from '../protocol/inbox.ts'
import type { LayoutRequest } from '../protocol/layout-checks.ts'
import type { LocatorRecipe } from '../protocol/locator.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { ScreenshotRequest } from '../protocol/screenshot.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { PopupAnswer, PopupRecord } from '../protocol/popups.ts'
import type { Work } from './command-lanes.ts'
import type { RunTime } from './run-time.ts'
import type { Hook, RunnableTest, RuntimeContext } from './test-body.ts'
import { dirname, join } from 'node:path'
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

/**
 * A read of an inbox as the test asked for it: the call as the test wrote it, what it asks for, where the test sent it
 * from, and the time it gave itself with `{ timeout }`, when it gave one.
 */
export type InboxReading = { readonly label: string; readonly request: InboxRequest; readonly location: SourceLocation | undefined; readonly timeoutMs?: number }

/**
 * A wait the parent makes about files, as the test asked for it: the call as the test wrote it, what it waits for, where
 * the test sent it from, and its time in milliseconds, before the test's own time left cuts it.
 */
export type FilesWaiting = { readonly label: string; readonly request: FilesRequest; readonly location: SourceLocation | undefined; readonly timeoutMs: number }

/**
 * A wait for what an action opens on an app's page, as the test asked for it: the app, the call as the test wrote it,
 * where the test sent it from, the time it gave itself with `{ timeout }`, when it gave one, and the action, which the
 * wait runs once the page is armed.
 */
export type OpeningWait = {
  readonly app: string
  readonly label: string
  readonly location: SourceLocation | undefined
  readonly timeoutMs?: number | undefined
  readonly action: () => Promise<unknown>
}

/**
 * An answer to a dialog the test was given: the app whose page shows it, its id, whether to accept it and the text a
 * prompt takes, the call as the test wrote it and where, and the action that opened it, which the answer waits for.
 */
export type DialogAnswering = {
  readonly app: string
  readonly dialog: string
  readonly accept: boolean
  readonly promptText?: string | undefined
  readonly label: string
  readonly location: SourceLocation | undefined
  readonly acted: Promise<void>
}

/** A change to an app's routes, as the test asked for it: the app, the call as the test wrote it, and where it was sent from. */
export type RouteChange = { readonly app: string; readonly label: string; readonly request: RouteRequest; readonly location: SourceLocation | undefined }

/** Where a wait for a dialog or a popup goes, and where the test sent it from. */
type WaitSending = { readonly app: string; readonly location: SourceLocation | undefined; readonly stepId: string | undefined }

/** How a test ended, as the child reports it. */
export type Verdict = { status: 'passed' | 'failed'; failure?: Failure; assertionCount: number; durationMs: number }

type ActionCommand = Exclude<PageCommand, { kind: 'observe' | 'observePage' | 'observeLayout' | 'observeScreenshot' }>
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
  readonly #inboxReads = new Map<number, (answer: InboxAnswer) => void>()
  // Waits for dialogs and popups and answers to dialogs, by id; a wait is answered more than once, armed then opened.
  readonly #pageWaits = new Map<number, (answer: DialogAnswer | PopupAnswer) => void>()
  // The dialogs the test was given and has not answered yet, by id, with where it asked for each.
  readonly #dialogsOpen = new Map<string, { readonly type: DialogType; readonly location: SourceLocation | undefined }>()
  readonly #filesRequests = new Map<number, (answer: FilesAnswer) => void>()
  readonly #routeChanges = new Map<number, (answer: RouteReply) => void>()
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

  /**
   * Asks the parent to read an inbox. The parent reads the mailbox, looks again until a message arrives or the read's
   * time runs out, and answers with the message, its codes and links hidden; `wrap` turns that answer into what the
   * test receives. The read touches no page, so it holds no app, and it starts at once. Its time is its own `timeoutMs`,
   * or the assertion budget, cut to what the test has left. It changes what the next read gives, so it may not run
   * inside the function `expect.poll` calls.
   */
  readInbox<T>({ label, request, location, timeoutMs }: InboxReading, wrap: (message: ReceivedMessageRecord) => T): Operation<T> {
    const work = { label, location }
    const operation = this.#track<T>('read', work)
    const refusal = this.#refusal() ?? this.#whileReading(work)
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    const id = this.#options.nextCommandId()
    const stepId = currentScope()?.stepId
    this.#inboxReads.set(id, (answer) => {
      if (answer.ok) operation.resolve(wrap(answer.message))
      else operation.reject(this.fail(withLocation(answer.failure, location)))
    })
    const budget = this.assertionBudget(timeoutMs ?? this.timeouts.assertion)
    this.#options.send({ type: 'inbox', testId: this.testId, attemptId: this.attemptId, id, request, timeoutMs: budget, ...(location === undefined ? {} : { location }), ...(stepId === undefined ? {} : { stepId }) })
    return operation
  }

  resolveInbox(id: number, answer: InboxAnswer): void {
    const resolve = this.#inboxReads.get(id)
    if (resolve === undefined) return
    this.#inboxReads.delete(id)
    resolve(answer)
  }

  /**
   * Asks the parent to arm an app's page for the next JavaScript dialog, runs the action once the page is armed, and
   * resolves with what `wrap` makes of the dialog as soon as it opens. The action is still waiting then, since a page
   * holds the input that opened a dialog until the dialog is answered; `wrap` is given the action's own promise, which
   * settles once the action does. An action that fails before any dialog opened fails the wait with its own failure,
   * and the parent stops waiting. A wait that sees no dialog in its time fails, unless its action failed meanwhile,
   * whose failure it gives instead. The wait acts on a page, so it may not run inside the function `expect.poll` calls.
   */
  waitForDialog<T>(wait: OpeningWait, wrap: (dialog: DialogRecord, acted: Promise<void>) => T): Operation<T> {
    return this.#waitForOpening('dialog', wait, (answer, acted) => {
      if (!('dialog' in answer)) throw new Error('Retest answered a wait for a dialog with a page')
      this.#dialogsOpen.set(answer.dialog.id, { type: answer.dialog.type, location: wait.location })
      return wrap(answer.dialog, acted)
    })
  }

  /**
   * As `waitForDialog`, for the next page the action opens: the parent hands it over as an app of its own, and the wait
   * resolves with what `wrap` makes of it once the action is over too, so the next command to the page that opened it
   * never meets the action still running. An action that fails fails the wait with its own failure.
   */
  waitForPopup<T>(wait: OpeningWait, wrap: (popup: PopupRecord) => T): Operation<T> {
    return this.#waitForOpening('popup', wait, async (answer, acted) => {
      if (!('popup' in answer)) throw new Error('Retest answered a wait for a page with a dialog')
      await acted
      return wrap(answer.popup)
    })
  }

  /**
   * Asks the parent to answer a dialog the test was given, then waits for the action that opened it, so the answer's
   * step ends once its action has. An answer the parent could not give fails, and an action that failed fails it too,
   * with its own failure. It acts on a page, so it may not run inside the function `expect.poll` calls.
   */
  answerDialog({ app, dialog, accept, promptText, label, location, acted }: DialogAnswering): Operation<void> {
    const work = { label, location }
    const operation = this.#track<void>('read', work)
    const refusal = this.#refusal() ?? this.#whileReading(work)
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    this.#dialogsOpen.delete(dialog)
    const id = this.#options.nextCommandId()
    const stepId = currentScope()?.stepId
    this.#pageWaits.set(id, (answer) => {
      this.#pageWaits.delete(id)
      if (answer.kind === 'answered') acted.then(() => operation.resolve(), (error: unknown) => operation.reject(error))
      else if (answer.kind === 'failed') operation.reject(this.fail(withLocation(answer.failure, location)))
    })
    const request = { kind: 'answer' as const, dialog, accept, ...(promptText === undefined ? {} : { promptText }) }
    const timeoutMs = this.assertionBudget(this.timeouts.action)
    this.#options.send({ type: 'dialog', testId: this.testId, attemptId: this.attemptId, id, app, request, timeoutMs, ...(location === undefined ? {} : { location }), ...(stepId === undefined ? {} : { stepId }) })
    return operation
  }

  resolveDialog(id: number, answer: DialogAnswer): void {
    this.#pageWaits.get(id)?.(answer)
  }

  resolvePopup(id: number, answer: PopupAnswer): void {
    this.#pageWaits.get(id)?.(answer)
  }

  // The wait is armed before the action runs, so the parent hands over what the action's first command opens. The
  // answer to the request comes on another turn, so the action runs in the scope the test called from, as its step.
  #waitForOpening<T>(kind: 'dialog' | 'popup', { app, label, location, timeoutMs, action }: OpeningWait, take: (answer: Extract<DialogAnswer | PopupAnswer, { kind: 'opened' }>, acted: Promise<void>) => T | Promise<T>): Operation<T> {
    const work = { label, location }
    const operation = this.#track<T>('read', work)
    const refusal = this.#refusal() ?? this.#whileReading(work)
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    const scope: Scope = currentScope() ?? { run: this }
    const id = this.#options.nextCommandId()
    const sending = { app, location, stepId: scope.stepId }
    let acted: Promise<void> | undefined
    let opened = false
    const fail = (problem: Failure): void => operation.reject(this.fail(withLocation(problem, location)))
    this.#pageWaits.set(id, (answer) => {
      if (answer.kind === 'armed') {
        const running = callInScope(scope, action).then(() => undefined)
        acted = running
        running.then(undefined, (error: unknown) => {
          if (opened) return
          this.#pageWaits.delete(id)
          this.#sendWait(kind, this.#options.nextCommandId(), { kind: 'stop', wait: id }, 1, sending)
          operation.reject(error)
        })
        return
      }
      this.#pageWaits.delete(id)
      if (answer.kind === 'opened') {
        opened = true
        // The action may still be running: `take` is given its promise, so its own end is never lost.
        const settled = acted ?? Promise.resolve()
        Promise.resolve()
          .then(() => take(answer, settled))
          .then((value) => operation.resolve(value), (error: unknown) => operation.reject(error))
        return
      }
      if (answer.kind !== 'failed') return
      // The action's own failure says more than a wait that saw nothing while the action ran.
      if (acted === undefined) fail(answer.failure)
      else acted.then(() => fail(answer.failure), (error: unknown) => operation.reject(error))
    })
    this.#sendWait(kind, id, { kind: 'wait' }, this.assertionBudget(timeoutMs ?? this.timeouts.action), sending)
    return operation
  }

  #sendWait(kind: 'dialog' | 'popup', id: number, request: { kind: 'wait' } | { kind: 'stop'; wait: number }, timeoutMs: number, { app, location, stepId }: WaitSending): void {
    const scope = { testId: this.testId, attemptId: this.attemptId, id, app, timeoutMs, ...(location === undefined ? {} : { location }), ...(stepId === undefined ? {} : { stepId }) }
    this.#options.send(kind === 'dialog' ? { type: 'dialog', ...scope, request } : { type: 'popup', ...scope, request })
  }

  /**
   * Asks the parent to wait for what `request` names, runs `action` meanwhile when one is given, and resolves with what
   * `wrap` makes of the parent's answer once the action is over and the parent has answered. The wait holds no app, so
   * the action's own commands go as they would without it; the request goes first, so the parent is waiting before
   * the action's first command arrives. An action that fails fails the wait with its own failure, and the parent lets go
   * of what it armed. A wait with an action acts on a page, so it may not run inside the function `expect.poll` calls.
   */
  awaitFiles<T>({ label, request, location, timeoutMs }: FilesWaiting, wrap: (answer: Extract<FilesAnswer, { ok: true }>) => T | Promise<T>, action?: () => unknown): Operation<T> {
    const work = { label, location }
    const operation = this.#track<T>('read', work)
    const refusal = this.#refusal() ?? (action === undefined ? undefined : this.#whileReading(work))
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    const id = this.#sendFiles(request, smallestBudget(timeoutMs, this.#deadline.commandTimeoutMs), location)
    const answered = new Promise<FilesAnswer>((resolve) => this.#filesRequests.set(id, resolve))
    started(action).then(
      async () => {
        const answer = await answered
        if (!answer.ok) return operation.reject(this.fail(withLocation(answer.failure, location)))
        try {
          operation.resolve(await wrap(answer))
        } catch (error) {
          operation.reject(error)
        }
      },
      (error: unknown) => {
        this.#filesRequests.delete(id)
        this.#sendFiles({ kind: 'release', request: id }, 1, location)
        operation.reject(error)
      },
    )
    return operation
  }

  resolveFiles(id: number, answer: FilesAnswer): void {
    const resolve = this.#filesRequests.get(id)
    if (resolve === undefined) return
    this.#filesRequests.delete(id)
    resolve(answer)
  }

  /**
   * Asks the parent to change an app's routes, and resolves once the page holds the change, so the test's next command
   * to the page meets it. It needs the app to itself, as an action does: a request already on its way when the routes
   * change could meet either. Its time is the action budget, cut to what the test has left. It changes what the page's
   * requests get, so it may not run inside the function `expect.poll` calls.
   */
  changeRoutes({ app, label, request, location }: RouteChange): Operation<void> {
    const work = { label, location }
    const operation = this.#track<void>('read', work)
    const refusal = this.#refusal() ?? this.#whileReading(work) ?? this.#clash(app, work, 'action')
    if (refusal !== undefined) {
      operation.reject(refusal)
      return operation
    }
    this.#lanes.startAction(app, work)
    const id = this.#options.nextCommandId()
    const stepId = currentScope()?.stepId
    this.#routeChanges.set(id, (answer) => {
      this.#lanes.endAction(app, work)
      if (answer.ok) operation.resolve()
      else operation.reject(this.fail(withLocation(answer.failure, location)))
    })
    const timeoutMs = this.assertionBudget(this.timeouts.action)
    this.#options.send({ type: 'route', testId: this.testId, attemptId: this.attemptId, id, app, request, timeoutMs, ...(location === undefined ? {} : { location }), ...(stepId === undefined ? {} : { stepId }) })
    return operation
  }

  resolveRoute(id: number, answer: RouteReply): void {
    const resolve = this.#routeChanges.get(id)
    if (resolve === undefined) return
    this.#routeChanges.delete(id)
    resolve(answer)
  }

  /**
   * The folder a path a test wrote is read against, as an import's is: that of the file the call came from, or the
   * test's own file when the call's place is unknown.
   */
  callerFolder(location: SourceLocation | undefined): string {
    return dirname(join(this.#options.rootDir, location?.file ?? this.#options.file))
  }

  #sendFiles(request: FilesRequest, timeoutMs: number, location: SourceLocation | undefined): number {
    const id = this.#options.nextCommandId()
    const stepId = currentScope()?.stepId
    this.#options.send({ type: 'files', testId: this.testId, attemptId: this.attemptId, id, request, timeoutMs, ...(location === undefined ? {} : { location }), ...(stepId === undefined ? {} : { stepId }) })
    return id
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
   * Measures an app's page once for a layout assertion: the elements `request` names, and their words when it asks. With
   * `after`, the page first waits for its next change. The look is marked as a check's, as `observe` marks its own.
   */
  observeLayout(app: string, request: LayoutRequest, timeoutMs: number, location: SourceLocation | undefined, after?: ObserveAfter): Promise<CommandResult> {
    const refusal = this.#refusal()
    if (refusal !== undefined) return Promise.resolve({ ok: false, failure: refusal.failure })
    return this.#send(app, { kind: 'observeLayout', ...request, ...(after === undefined ? {} : { after }), check: true }, { timeoutMs, location })
  }

  /**
   * Takes a picture of an app's page, or of one element, for a screenshot assertion, and learns its size and how it
   * stands against its baseline; the pixels stay with the parent. `previous` names the look before it in the same check,
   * whose picture this one must match to have settled. The look is marked as a check's, as `observe` marks its own.
   */
  observeScreenshot(app: string, request: ScreenshotRequest, previous: string | undefined, timeoutMs: number, location: SourceLocation | undefined): Promise<CommandResult> {
    const refusal = this.#refusal()
    if (refusal !== undefined) return Promise.resolve({ ok: false, failure: refusal.failure })
    return this.#send(app, { kind: 'observeScreenshot', ...request, ...(previous === undefined ? {} : { previous }), check: true }, { timeoutMs, location })
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
    for (const problem of this.#dialogsLeftOpen(what)) this.record(problem)
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

  // A dialog the test was given and never answered holds its page, and the action that opened it cannot finish.
  #dialogsLeftOpen(what: string): Failure[] {
    const open = [...this.#dialogsOpen.values()]
    this.#dialogsOpen.clear()
    return open.map(({ type, location }) => {
      const message = `The ${type} dialog page.dialog() gave on ${this.describeLine(location)} was still open when ${what} returned. Answer it with dialog.accept() or dialog.dismiss().`
      return failure('not_awaited', message, location)
    })
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
    case 'setChooserFiles':
      return 'setFiles'
    default:
      return command.kind
  }
}

// A function the test passed, started at once; what it throws as it starts is its failure, as what it rejects with is.
function started(action: (() => unknown) | undefined): Promise<unknown> {
  if (action === undefined) return Promise.resolve()
  try {
    return Promise.resolve(action())
  } catch (error) {
    return Promise.reject(error)
  }
}

function lineOrNull(location: SourceLocation | undefined): string | null {
  return location === undefined ? null : formatLine(location)
}
