import type { OwnedPage } from '../browser/contract.ts'
import type { CommandResult, PageCommand } from '../protocol/commands.ts'
import type { ChildEvent, EventBody } from '../protocol/events.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { ProcessEvent, TestFileMessage, TestFileProcess } from './test-file-process.ts'
import { describeCommand } from '../protocol/commands.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { errorMessage, failure, withAlso, withLocation } from '../protocol/failures.ts'
import { describeExit } from '../shared/process-exit.ts'
import { bounded } from './bounded.ts'

/** How long a stopped test's process has to answer, and a page that lost its browser has to say so. */
export const abortGraceMs = 1000

export type RunningTestOptions = {
  process: TestFileProcess
  page: OwnedPage
  testId: string
  attemptId: string
  /** `test` is this test's own budget. */
  timeouts: Timeouts
  emit: (body: EventBody) => void
}

/** What the parent knows once the test body is over. */
export type BodyReport = {
  failure?: Failure
  assertionCount: number
  /** How the file's process had ended before the body was due. The body never started. */
  endedBeforeStart?: ProcessExit
  /** How the file's process ended during the test; later tests in the file cannot run. */
  processEnded?: ProcessExit
  /** The test ran out of its own time. Its process is being ended, so later tests in the file cannot run. */
  timedOut: boolean
}

type CommandMessage = Extract<ChildMessage, { type: 'command' }>
type TestScope = { testId: string; attemptId: string }
type InFlight = {
  message: CommandMessage
  startedAt: number
  /** Settles once the page has answered. It exists before the page is called, which may lose its browser at once. */
  done: PromiseWithResolvers<void>
  /** Stops the page's work on the command when the test is revoked, with the revocation as its reason. */
  stop: AbortController
  answered: boolean
  reported: boolean
}

// Failures that say the browser went away, from the page that saw it go.
const lossClasses: ReadonlySet<FailureClass> = new Set<FailureClass>(['session_lost', 'outcome_unknown'])

/**
 * The parent's side of one test body. It forwards the child's page commands to the browser, reports
 * each action, and enforces the test's deadline. Stopping a test revokes it: later commands are refused,
 * commands in flight are answered and stopped in the page, the child is asked to abort, and a child that
 * does not answer within the grace period is killed. A test that runs out of time also ends its process,
 * whether it answered or not, because code from it may still be running there.
 */
export class RunningTest {
  readonly #options: RunningTestOptions
  readonly #inFlight = new Map<number, InFlight>()
  readonly #finished = Promise.withResolvers<BodyReport>()
  #deadline: Deadline | undefined
  #testTimer: NodeJS.Timeout | undefined
  #killTimer: NodeJS.Timeout | undefined
  #pageUrl: string | undefined
  #stepId: string | undefined
  #revocation: Failure | undefined
  /** The page's latest answer saying that it or the browser was gone. */
  #lossAnswer: Failure | undefined
  #report: BodyReport | undefined
  #assertionsSeen = 0
  #graceExpired = false
  #timedOut = false
  #stopNavigation: (() => void) | undefined

  constructor(options: RunningTestOptions) {
    this.#options = options
  }

  /** Starts the body in the child and resolves when it is over, however it ends. A process that has ended gets no body. */
  run(): Promise<BodyReport> {
    const { process, page, testId, attemptId, timeouts } = this.#options
    if (process.exit !== undefined) {
      this.#finish({ assertionCount: 0, endedBeforeStart: process.exit })
      return this.#finished.promise
    }
    this.#stopNavigation = page.onNavigation((url) => this.#navigated(url))
    process.listen((event) => this.#receive(event))
    process.send({ type: 'run', testId, attemptId, timeouts })
    this.#deadline = new Deadline(timeouts.test)
    this.#testTimer = setTimeout(() => this.#runOutOfTime(), timeouts.test)
    return this.#finished.promise
  }

  /** Stops the test. The first reason wins; `graceMs` of 0 kills the child at once. */
  revoke(reason: Failure, graceMs: number): void {
    if (this.#revocation !== undefined || this.#report !== undefined) return
    this.#revocation = reason
    clearTimeout(this.#testTimer)
    for (const entry of this.#inFlight.values()) {
      this.#answer(entry, { ok: false, failure: withLocation(reason, entry.message.location) })
      entry.stop.abort(reason)
    }
    const { process } = this.#options
    process.send({ type: 'abort', reason: reason.message })
    if (graceMs === 0) {
      void process.kill()
      return
    }
    this.#killTimer = setTimeout(() => {
      this.#graceExpired = true
      void process.kill()
    }, graceMs)
    void process.closed.then(() => clearTimeout(this.#killTimer))
  }

  /**
   * The browser went away. Only the page knows whether a command in flight had sent its input, and it
   * answers as soon as the connection is gone, so the test stops with that answer. An action that gives
   * none within the grace period may have taken effect.
   */
  browserLost(reason: string): void {
    const answers = [...this.#inFlight.values()].map((entry) => entry.done.promise)
    void bounded(Promise.all(answers), abortGraceMs).then(() => {
      if (this.#report === undefined) this.revoke(this.#lossFailure(reason), abortGraceMs)
    })
  }

  /**
   * Waits for commands still with the browser, up to `timeoutMs`. An action that never answers is
   * reported as one whose outcome is unknown, and every command left is stopped in the page.
   */
  async settle(timeoutMs: number): Promise<void> {
    await bounded(Promise.all([...this.#inFlight.values()].map((entry) => entry.done.promise)), timeoutMs)
    for (const entry of this.#inFlight.values()) {
      const message = 'The browser had not answered when the test ended, so whether the action took effect is unknown.'
      const unknown = failure('outcome_unknown', message, entry.message.location)
      this.#reportAction(entry, { ok: false, failure: unknown })
      entry.stop.abort(unknown)
    }
  }

  /** Stops listening to the page and the process. A process being ended after a timeout is still killed on time. */
  close(): void {
    clearTimeout(this.#testTimer)
    this.#stopNavigation?.()
    this.#options.process.listen(undefined)
  }

  #receive(event: ProcessEvent): void {
    if (event.kind === 'exit') return this.#processEnded(event.exit)
    if (event.kind === 'invalid') return this.#violation(`sent a message Retest could not read: ${event.problem}`)
    const { message } = event
    switch (message.type) {
      case 'command':
        return this.#command(message)
      case 'event':
        return this.#childEvent(message.event)
      case 'test-finished':
        return this.#childFinished(message)
      default:
        return this.#violation(`sent ${message.type} while a test was running`)
    }
  }

  #command(message: CommandMessage): void {
    if (this.#deadline?.expired === true) this.#runOutOfTime()
    const refusal = this.#report === undefined ? this.#revocation : failure('usage', 'No test is running, so Retest sent nothing to the page.')
    if (refusal !== undefined) {
      this.#options.process.send({ type: 'command-result', id: message.id, result: { ok: false, failure: withLocation(refusal, message.location) } })
      return
    }
    const deadline = this.#deadline
    const timeoutMs = deadline === undefined ? message.timeoutMs : smallestBudget(message.timeoutMs, deadline.remainingMs)
    this.#stepId = message.stepId
    const entry: InFlight = {
      message,
      startedAt: monotonicClock(),
      done: Promise.withResolvers(),
      stop: new AbortController(),
      answered: false,
      reported: false,
    }
    this.#inFlight.set(message.id, entry)
    void this.#execute(entry, timeoutMs).finally(() => entry.done.resolve())
  }

  async #execute(entry: InFlight, timeoutMs: number): Promise<void> {
    const { command, location } = entry.message
    const pageUrl = this.#pageUrl
    let result: CommandResult
    try {
      result = await this.#options.page.execute(command, timeoutMs, entry.stop.signal)
    } catch (error) {
      result = thrownResult(command, error)
    }
    this.#inFlight.delete(entry.message.id)
    if (result.ok && result.kind === 'goto') this.#pageUrl = result.url
    const reported: CommandResult = result.ok ? result : { ok: false, failure: withLocation(result.failure, location) }
    if (!reported.ok && lossClasses.has(reported.failure.class)) this.#lossAnswer = reported.failure
    this.#reportAction(entry, reported, result.ok && result.kind === 'goto' ? result.url : pageUrl)
    this.#answer(entry, reported)
  }

  // An action is reported once: by the page's answer, or as unknown when the page gave none in time.
  #reportAction(entry: InFlight, result: CommandResult, pageUrl = this.#pageUrl): void {
    const { command, location, stepId } = entry.message
    if (command.kind === 'observe' || entry.reported) return
    entry.reported = true
    const fields = {
      testId: this.#options.testId,
      attemptId: this.#options.attemptId,
      ...(stepId === undefined ? {} : { stepId }),
      session: 'page',
      command: command.kind,
      ...(command.kind === 'goto' ? {} : { locator: command.locator }),
      ...(pageUrl === undefined ? {} : { pageUrl }),
      durationMs: elapsedMs(entry.startedAt),
      ...(location === undefined ? {} : { location }),
      ...(command.kind === 'fill' ? { valueLength: command.value.length } : {}),
    }
    this.#options.emit(result.ok ? { type: 'action.completed', ...fields } : { type: 'action.failed', ...fields, failure: result.failure })
  }

  #answer(entry: InFlight, result: CommandResult): void {
    if (entry.answered || this.#report !== undefined) return
    entry.answered = true
    this.#options.process.send({ type: 'command-result', id: entry.message.id, result })
  }

  // The page's own answer when it gave one. An action it never answered may have taken effect.
  #lossFailure(reason: string): Failure {
    const unanswered = [...this.#inFlight.values()].find((entry) => entry.message.command.kind !== 'observe')
    if (unanswered !== undefined) {
      const { command, location } = unanswered.message
      const message = `The browser was lost during ${describeCommand(command)}, which had not answered ${abortGraceMs} ms later, so whether it took effect is unknown. ${reason}`
      const unknown = failure('outcome_unknown', message, location)
      this.#reportAction(unanswered, { ok: false, failure: unknown })
      return unknown
    }
    return this.#lossAnswer ?? failure('session_lost', `The browser was lost: ${reason}`)
  }

  #childEvent(event: ChildEvent): void {
    if (!this.#isOwn(event)) return this.#violation(`sent ${event.type} for ${describeScope(event)} while ${describeScope(this.#options)} was running`)
    if (event.type !== 'assertion.passed' && event.type !== 'assertion.failed') return this.#options.emit(event)
    this.#assertionsSeen++
    const pageUrl = this.#pageUrl
    if (event.locator === undefined || event.pageUrl !== undefined || pageUrl === undefined) return this.#options.emit(event)
    this.#options.emit({ ...event, pageUrl })
  }

  #childFinished(message: Extract<TestFileMessage, { type: 'test-finished' }>): void {
    if (!this.#isOwn(message)) return this.#violation(`finished ${describeScope(message)} while ${describeScope(this.#options)} was running`)
    this.#finish({ ...this.#verdict(message), assertionCount: message.assertionCount })
  }

  #isOwn(scope: TestScope): boolean {
    return scope.testId === this.#options.testId && scope.attemptId === this.#options.attemptId
  }

  // A test the parent stopped has failed for that reason, unless the child recorded an earlier failure.
  #verdict(message: Extract<TestFileMessage, { type: 'test-finished' }>): { failure?: Failure } {
    const reason = this.#revocation
    const own = message.failure
    if (reason !== undefined) return { failure: own === undefined ? reason : withAlso(own, [reason]) }
    if (message.status === 'passed') return {}
    return { failure: own ?? failure('test_error', 'The test process reported a failure without a reason.') }
  }

  #runOutOfTime(): void {
    if (this.#revocation !== undefined || this.#report !== undefined) return
    const budget = this.#options.timeouts.test
    const waiting = this.#inFlight.values().next().value
    const detail = waiting === undefined ? '' : ` It was waiting for ${describeCommand(waiting.message.command)}.`
    const reason = failure('timeout', `The test ran longer than its ${budget} ms budget.${detail}`, waiting?.message.location)
    this.#timedOut = true
    this.revoke({ ...reason, details: { timeoutMs: budget } }, abortGraceMs)
  }

  #processEnded(exit: ProcessExit): void {
    const reason = this.#revocation
    const problem =
      reason === undefined
        ? failure('test_error', `The process for this file ended during the test (${describeExit(exit)}).`)
        : this.#graceExpired
          ? { ...reason, message: `${reason.message} Its process did not stop within ${abortGraceMs} ms of being asked, so Retest ended it.` }
          : reason
    this.#finish({ failure: problem, assertionCount: this.#assertionsSeen, processEnded: exit })
  }

  #violation(problem: string): void {
    if (this.#report !== undefined) return
    this.revoke(failure('test_error', `The process for this file ${problem}.`), 0)
  }

  #navigated(url: string): void {
    this.#pageUrl = url
    const { testId, attemptId } = this.#options
    const stepId = this.#stepId
    this.#options.emit({ type: 'navigation', testId, attemptId, ...(stepId === undefined ? {} : { stepId }), session: 'page', url })
  }

  // A timed-out test's process is asked to close; the kill timer from `revoke` ends it if it does not.
  #finish(report: Omit<BodyReport, 'timedOut'>): void {
    if (this.#report !== undefined) return
    this.#report = { ...report, timedOut: this.#timedOut }
    clearTimeout(this.#testTimer)
    if (this.#timedOut) this.#options.process.send({ type: 'close' })
    else clearTimeout(this.#killTimer)
    this.#finished.resolve(this.#report)
  }
}

function thrownResult(command: PageCommand, error: unknown): CommandResult {
  const message = `The browser call for ${describeCommand(command)} failed: ${errorMessage(error)}`
  return { ok: false, failure: failure(command.kind === 'observe' ? 'session_lost' : 'outcome_unknown', message) }
}

function describeScope({ testId, attemptId }: TestScope): string {
  return `${JSON.stringify(testId)} (attempt ${attemptId})`
}
