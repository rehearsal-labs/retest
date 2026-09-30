import type { OwnedPage } from '../browser/contract.ts'
import type { ActionKind, CommandResult, FillValue, PageCommand } from '../protocol/commands.ts'
import type { ChildEvent, EventBody, EventOrigin } from '../protocol/events.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Variant } from '../protocol/variant.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { Redactor } from './redactor.ts'
import type { FillResolution, SecretFill } from './secrets.ts'
import type { ProcessEvent, TestFileMessage, TestFileProcess } from './test-file-process.ts'
import { describeCommand } from '../protocol/commands.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { errorMessage, failure, withAlso, withLocation } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { observedRecord } from '../protocol/observation-record.ts'
import { describeExit } from '../shared/process-exit.ts'
import { bounded } from './bounded.ts'
import { ServedObservations } from './observations.ts'

/** How long a stopped test's process has to answer, and a page that lost its browser has to say so. */
export const abortGraceMs = 1000

/** What a running test needs of its file's process. */
export type TestProcess = Pick<TestFileProcess, 'exit' | 'closed' | 'listen' | 'send' | 'kill'>

export type RunningTestOptions = {
  process: TestProcess
  /** Each app's page, in the order the test declared its apps. Commands name the app whose page takes them. */
  pages: ReadonlyMap<string, OwnedPage>
  testId: string
  attemptId: string
  /** The target of each app, which the child is told in a run from a config. */
  variant?: Variant
  /** `test` is this test's own budget. */
  timeouts: Timeouts
  emit: (body: EventBody, origin?: EventOrigin) => void
  /** Turns a secret fill into the text to type, or says why it may not be typed. Without it, a secret fill fails. */
  fillSecret?: (command: SecretFill, pageUrl: string | undefined, timeoutMs: number) => Promise<FillResolution>
  /** Hides secret values in everything sent to the child. */
  redactor?: Redactor
  /** The apps whose page emulates a touch screen, where a click is sent, and recorded, as a tap. */
  touch?: ReadonlySet<string>
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
  /** The page of the app the command names. */
  page: OwnedPage
  /** The address the parent last saw that page commit when the command arrived. */
  pageUrl: string | undefined
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
 * each action, writes down each look it serves, judges each assertion against the look it names, and
 * enforces the test's deadline. An assertion it cannot accept ends the test as a protocol violation.
 * Stopping a test revokes it: later commands are refused,
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
  readonly #pageUrls = new Map<string, string>()
  readonly #observations = new ServedObservations()
  #stepId: string | undefined
  #revocation: Failure | undefined
  /** The page's latest answer saying that it or the browser was gone. */
  #lossAnswer: Failure | undefined
  #report: BodyReport | undefined
  #assertionsSeen = 0
  #graceExpired = false
  #timedOut = false
  #stopNavigation: (() => void)[] = []

  constructor(options: RunningTestOptions) {
    this.#options = options
  }

  /** Starts the body in the child and resolves when it is over, however it ends. A process that has ended gets no body. */
  run(): Promise<BodyReport> {
    const { process, pages, testId, attemptId, variant, timeouts } = this.#options
    if (process.exit !== undefined) {
      this.#finish({ assertionCount: 0, endedBeforeStart: process.exit })
      return this.#finished.promise
    }
    this.#stopNavigation = [...pages].map(([app, page]) => page.onNavigation((url) => this.#navigated(app, url)))
    process.listen((event) => this.#receive(event))
    process.send({ type: 'run', testId, attemptId, timeouts, apps: [...pages.keys()], ...(variant === undefined ? {} : { variant }) })
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
    const { process, redactor } = this.#options
    process.send({ type: 'abort', reason: redactor?.redact(reason.message) ?? reason.message })
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
    for (const stop of this.#stopNavigation) stop()
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
    if (refusal !== undefined) return this.#send(message.id, { ok: false, failure: withLocation(refusal, message.location) })
    const page = this.#options.pages.get(message.app)
    if (page === undefined) return this.#violation(`sent a command for the app ${JSON.stringify(message.app)}, which this test does not use`)
    const deadline = this.#deadline
    const timeoutMs = deadline === undefined ? message.timeoutMs : smallestBudget(message.timeoutMs, deadline.remainingMs)
    this.#stepId = message.stepId
    const entry: InFlight = {
      message,
      page,
      pageUrl: this.#pageUrls.get(message.app),
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
    const { command, location, app } = entry.message
    let result: CommandResult
    try {
      result = await this.#run(entry, timeoutMs)
    } catch (error) {
      result = thrownResult(command, error)
    }
    this.#inFlight.delete(entry.message.id)
    if (result.ok && result.kind === 'goto') this.#pageUrls.set(app, result.url)
    const reported: CommandResult = result.ok ? result : { ok: false, failure: withLocation(result.failure, location) }
    if (!reported.ok && lossClasses.has(reported.failure.class)) this.#lossAnswer = reported.failure
    this.#reportAction(entry, reported, result.ok && result.kind === 'goto' ? result.url : entry.pageUrl)
    this.#answer(entry, reported)
  }

  // A secret is read, within the command's own time, only once its page's origin may take it. A key is read
  // again here, since the test process may send one its own check never saw.
  async #run({ message, page, stop }: InFlight, timeoutMs: number): Promise<CommandResult> {
    const { command, app } = message
    if (command.kind === 'press') {
      const parsed = parseKey(command.key)
      if (!parsed.ok) return { ok: false, failure: parsed.failure }
    }
    if (command.kind !== 'fill') return page.execute(command, timeoutMs, stop.signal)
    const { locator, value } = command
    if (typeof value === 'string') return page.execute({ kind: 'fill', locator, value }, timeoutMs, stop.signal)
    const deadline = new Deadline(timeoutMs)
    const { fillSecret } = this.#options
    const resolved = fillSecret === undefined ? noSecrets(value.secret) : await fillSecret({ kind: 'fill', locator, value }, this.#pageUrls.get(app), timeoutMs)
    if (!resolved.ok) return { ok: false, failure: resolved.failure }
    return page.execute(resolved.command, deadline.commandTimeoutMs, stop.signal)
  }

  // An action is reported once: by the page's answer, or as unknown when the page gave none in time.
  #reportAction(entry: InFlight, result: CommandResult, pageUrl = this.#pageUrls.get(entry.message.app)): void {
    const { command, location, stepId, app } = entry.message
    if (command.kind === 'observe' || entry.reported) return
    entry.reported = true
    const fields = {
      testId: this.#options.testId,
      attemptId: this.#options.attemptId,
      ...(stepId === undefined ? {} : { stepId }),
      session: app,
      command: recordedKind(command.kind, result, this.#options.touch?.has(app) === true),
      ...('locator' in command && command.locator !== undefined ? { locator: command.locator } : {}),
      ...(command.kind === 'press' ? { key: command.key } : {}),
      ...(pageUrl === undefined ? {} : { pageUrl }),
      durationMs: elapsedMs(entry.startedAt),
      ...(location === undefined ? {} : { location }),
      ...(command.kind === 'fill' ? typedValue(command.value) : {}),
    }
    this.#options.emit(result.ok ? { type: 'action.completed', ...fields } : { type: 'action.failed', ...fields, failure: result.failure })
  }

  #answer(entry: InFlight, result: CommandResult): void {
    if (entry.answered || this.#report !== undefined) return
    entry.answered = true
    this.#options.process.send({ type: 'command-result', id: entry.message.id, result: this.#serve(entry, this.#redacted(result)) })
  }

  #send(id: number, result: CommandResult): void {
    this.#options.process.send({ type: 'command-result', id, result: this.#redacted(result) })
  }

  // Page text, a URL or a failure may quote a secret value the page showed, so the child gets it redacted.
  #redacted(result: CommandResult): CommandResult {
    return this.#options.redactor?.redactCommandResult(result) ?? result
  }

  // A look the page answered is written down, as the test process receives it, before the answer goes; the
  // id it carries is how an assertion names it.
  #serve({ message, pageUrl, startedAt }: InFlight, result: CommandResult): CommandResult {
    const { command, app, stepId } = message
    if (!result.ok || result.kind !== 'observe' || command.kind !== 'observe') return result
    const { locator } = command
    const { observation } = result
    const page = pageUrl === undefined ? {} : { pageUrl }
    const observationId = this.#observations.serve({ app, locator, observation, ...page })
    const { testId, attemptId } = this.#options
    const step = stepId === undefined ? {} : { stepId }
    this.#options.emit({ type: 'observation', testId, attemptId, ...step, session: app, observationId, locator, ...page, observed: observedRecord(observation), durationMs: elapsedMs(startedAt) })
    return { ...result, observationId }
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

  // An assertion is written only as the parent judged it; one the parent cannot accept ends the test.
  #childEvent(event: ChildEvent): void {
    if (!this.#isOwn(event)) return this.#violation(`sent ${event.type} for ${describeScope(event)} while ${describeScope(this.#options)} was running`)
    if (event.type !== 'assertion.passed' && event.type !== 'assertion.failed') return this.#options.emit(event, 'child')
    // An assertion that names no app looks at the test's first one, as milestone 1's single page.
    const [firstApp] = this.#options.pages.keys()
    const app = event.session ?? firstApp
    const judged = this.#observations.judge(event, { app, pageUrl: app === undefined ? undefined : this.#pageUrls.get(app) })
    if (!judged.ok) return this.#violation(judged.problem)
    this.#assertionsSeen++
    this.#options.emit(judged.event, 'child')
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

  #navigated(app: string, url: string): void {
    this.#pageUrls.set(app, url)
    const { testId, attemptId } = this.#options
    const stepId = this.#stepId
    this.#options.emit({ type: 'navigation', testId, attemptId, ...(stepId === undefined ? {} : { stepId }), session: app, url })
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

// The page's answer says what it did; a failed click on a touch screen was a tap too.
function recordedKind(sent: ActionKind, result: CommandResult, touch: boolean): ActionKind {
  if (result.ok && result.kind !== 'observe') return result.kind
  return sent === 'click' && touch ? 'tap' : sent
}

function noSecrets(name: string): FillResolution {
  return { ok: false, failure: failure('usage', `secret(${JSON.stringify(name)}) needs a config that declares it. This run has no secrets.`) }
}

// A fill records how much it typed, or which secret, and never the text itself.
function typedValue(value: FillValue): { valueLength: number } | { secret: string } {
  return typeof value === 'string' ? { valueLength: value.length } : { secret: value.secret }
}

function thrownResult(command: PageCommand, error: unknown): CommandResult {
  const message = `The browser call for ${describeCommand(command)} failed: ${errorMessage(error)}`
  return { ok: false, failure: failure(command.kind === 'observe' ? 'session_lost' : 'outcome_unknown', message) }
}

function describeScope({ testId, attemptId }: TestScope): string {
  return `${JSON.stringify(testId)} (attempt ${attemptId})`
}
