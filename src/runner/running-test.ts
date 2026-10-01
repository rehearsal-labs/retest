import type { OwnedPage, PageNavigation } from '../browser/contract.ts'
import type { ActionKind, CommandResult, FillValue, PageCommand } from '../protocol/commands.ts'
import type { ChildEvent, EventBody, EventOrigin } from '../protocol/events.ts'
import type { Failure, FailureClass } from '../protocol/failures.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Variant } from '../protocol/variant.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { PageFields } from './observations.ts'
import type { NotedNavigation, PageDocument } from './page-navigations.ts'
import type { Redactor } from './redactor.ts'
import type { FillResolution, SecretFill } from './secrets.ts'
import type { ProcessEvent, TestFileMessage, TestFileProcess } from './test-file-process.ts'
import { describeCommand } from '../protocol/commands.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { errorMessage, failure, withAlso, withLocation } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { observedRecord } from '../protocol/observation-record.ts'
import { selectCommandProblem } from '../protocol/option-choices.ts'
import { scrollProblem } from '../protocol/scroll-delta.ts'
import { describeExit } from '../shared/process-exit.ts'
import { bounded } from './bounded.ts'
import { pageFields, ServedObservations } from './observations.ts'
import { PageNavigations } from './page-navigations.ts'

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
  fillSecret?: (command: SecretFill, context: SecretFillContext) => Promise<FillResolution>
  /** Hides secret values in everything sent to the child. */
  redactor?: Redactor
  /** The apps whose page emulates a touch screen, where a click is sent, and recorded, as a tap. */
  touch?: ReadonlySet<string>
}

/**
 * Where a secret fill is going: the page's address as it stands now, the fill's own time, and a signal aborted
 * when the fill is stopped, as when its test is.
 */
export type SecretFillContext = { pageUrl: string | undefined; timeoutMs: number; signal: AbortSignal }

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
  /** The document the parent last saw that page commit when the command arrived. */
  document: PageDocument | undefined
  /** Settles once every navigation of that page told before the command arrived is written; absent when none waits. */
  navigations: Promise<void> | undefined
  startedAt: number
  /** Settles once the page has answered. It exists before the page is called, which may lose its browser at once. */
  done: PromiseWithResolvers<void>
  /** Stops the page's work on the command when the test is revoked, with the revocation as its reason. */
  stop: AbortController
  /** The page's answer, kept while the command waits for the navigations before it to be written. */
  pageAnswer: CommandResult | undefined
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
  /** The document each app's page last committed, as far as the parent knows. */
  readonly #documents = new Map<string, PageDocument>()
  readonly #navigations = new PageNavigations((navigation) => this.#writeNavigation(navigation))
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
    this.#stopNavigation = [...pages].map(([app, page]) => page.onNavigation((navigation) => this.#navigated(app, navigation)))
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
    this.#completeAnswered()
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
      if (this.#report !== undefined) return
      this.#navigations.writeWaiting()
      this.#completeAnswered()
      this.revoke(this.#lossFailure(reason), abortGraceMs)
    })
  }

  /**
   * Waits for commands still with the browser, and for the titles of the navigations still to be written, up to
   * `timeoutMs`. Every navigation is written by then, before any action whose outcome is unknown: an action that
   * never answers is reported as one, and every command left is stopped in the page.
   */
  async settle(timeoutMs: number): Promise<void> {
    const deadline = new Deadline(timeoutMs)
    await bounded(Promise.all([...this.#inFlight.values()].map((entry) => entry.done.promise)), timeoutMs)
    await this.#navigations.flush(deadline.remainingMs)
    this.#completeAnswered()
    for (const entry of this.#inFlight.values()) {
      const message = 'The browser had not answered when the test ended, so whether the action took effect is unknown.'
      const unknown = failure('outcome_unknown', message, entry.message.location)
      this.#reportAction(entry, { ok: false, failure: unknown }, this.#documentFields(entry.message.app))
      entry.stop.abort(unknown)
    }
  }

  /**
   * Waits up to `timeoutMs` for the titles of the navigations told since the body ended, as during the host checks,
   * and writes them. Nothing else is waited for: the body's commands were settled already.
   */
  settleNavigations(timeoutMs: number): Promise<void> {
    return this.#navigations.flush(timeoutMs)
  }

  /**
   * Stops listening to the page and the process, and writes any navigation still waiting for its title. A process
   * being ended after a timeout is still killed on time.
   */
  close(): void {
    clearTimeout(this.#testTimer)
    for (const stop of this.#stopNavigation) stop()
    this.#navigations.writeWaiting()
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
      document: this.#documents.get(message.app),
      navigations: this.#navigations.waiting(message.app),
      startedAt: monotonicClock(),
      done: Promise.withResolvers(),
      stop: new AbortController(),
      pageAnswer: undefined,
      answered: false,
      reported: false,
    }
    this.#inFlight.set(message.id, entry)
    void this.#execute(entry, timeoutMs).finally(() => entry.done.resolve())
  }

  // A passed command's answer is written after every navigation that came before the command. A goto's, and a
  // failed command's, are written after the navigations noted before the answer: a goto names the page it opened,
  // and a failure names the page it was looked for on, which the frame may have opened while the command waited.
  async #execute(entry: InFlight, timeoutMs: number): Promise<void> {
    const { command, location, app } = entry.message
    let result: CommandResult
    try {
      result = await this.#run(entry, timeoutMs)
    } catch (error) {
      result = thrownResult(command, error)
    }
    entry.pageAnswer = result.ok ? result : { ok: false, failure: withLocation(result.failure, location) }
    const earlier = result.ok && result.kind !== 'goto' ? entry.navigations : this.#navigations.waiting(app)
    if (earlier !== undefined) await earlier
    this.#complete(entry)
  }

  // A command the page answered is recorded, then answered, once.
  #complete(entry: InFlight): void {
    const answer = entry.pageAnswer
    const { id, app } = entry.message
    if (answer === undefined || !this.#inFlight.delete(id)) return
    if (answer.ok && answer.kind === 'goto') this.#documents.set(app, gotoDocument(answer))
    if (!answer.ok && lossClasses.has(answer.failure.class)) this.#lossAnswer = answer.failure
    this.#reportAction(entry, answer, commandPage(entry, answer, this.#documents.get(app)))
    this.#answer(entry, answer)
  }

  // As the test ends, a command the page answered that still waits for the navigations before it is recorded
  // with that answer, after those navigations, which are written at once.
  #completeAnswered(): void {
    const answered = [...this.#inFlight.values()].filter((entry) => entry.pageAnswer !== undefined)
    if (answered.length === 0) return
    this.#navigations.writeWaiting()
    for (const entry of answered) this.#complete(entry)
  }

  // A secret is read, within the command's own time, only once the page's current address may take it. What the
  // test process's own checks refuse is refused again here, since it may send what those checks never saw.
  async #run({ message, page, stop }: InFlight, timeoutMs: number): Promise<CommandResult> {
    const { command } = message
    const problem = commandProblem(command)
    if (problem !== undefined) return { ok: false, failure: problem }
    if (command.kind !== 'fill') return page.execute(command, timeoutMs, stop.signal)
    const { locator, value } = command
    if (typeof value === 'string') return page.execute({ kind: 'fill', locator, value }, timeoutMs, stop.signal)
    const deadline = new Deadline(timeoutMs)
    const { fillSecret } = this.#options
    const context: SecretFillContext = { pageUrl: page.url, timeoutMs, signal: stop.signal }
    const resolved = fillSecret === undefined ? noSecrets(value.secret) : await fillSecret({ kind: 'fill', locator, value }, context)
    if (!resolved.ok) return { ok: false, failure: resolved.failure }
    return page.execute(resolved.command, deadline.commandTimeoutMs, stop.signal)
  }

  // An action is reported once: by the page's answer, or as unknown when the page gave none in time.
  #reportAction(entry: InFlight, result: CommandResult, page: PageFields): void {
    const { command, location, stepId, app } = entry.message
    if (command.kind === 'observe' || entry.reported) return
    entry.reported = true
    const touch = this.#options.touch?.has(app) === true
    const fields = {
      testId: this.#options.testId,
      attemptId: this.#options.attemptId,
      ...(stepId === undefined ? {} : { stepId }),
      session: app,
      command: recordedKind(command.kind, result, touch),
      ...('locator' in command && command.locator !== undefined ? { locator: command.locator } : {}),
      ...page,
      durationMs: elapsedMs(entry.startedAt),
      ...(location === undefined ? {} : { location }),
      ...actionDetails(command, result, touch),
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
  #serve(entry: InFlight, result: CommandResult): CommandResult {
    const { command, app, stepId } = entry.message
    if (!result.ok || result.kind !== 'observe' || command.kind !== 'observe') return result
    const { locator } = command
    const { observation } = result
    const page = commandPage(entry, result, this.#documents.get(app))
    const observationId = this.#observations.serve({ app, locator, observation, ...page })
    const { testId, attemptId } = this.#options
    const step = stepId === undefined ? {} : { stepId }
    this.#options.emit({ type: 'observation', testId, attemptId, ...step, session: app, observationId, locator, ...page, observed: observedRecord(observation), durationMs: elapsedMs(entry.startedAt) })
    return { ...result, observationId }
  }

  // The page's own answer when it gave one. An action it never answered may have taken effect.
  #lossFailure(reason: string): Failure {
    const unanswered = [...this.#inFlight.values()].find((entry) => entry.message.command.kind !== 'observe')
    if (unanswered !== undefined) {
      const { command, location } = unanswered.message
      const message = `The browser was lost during ${describeCommand(command)}, which had not answered ${abortGraceMs} ms later, so whether it took effect is unknown. ${reason}`
      const unknown = failure('outcome_unknown', message, location)
      this.#reportAction(unanswered, { ok: false, failure: unknown }, this.#documentFields(unanswered.message.app))
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
    const judged = this.#observations.judge(event, { app, ...(app === undefined ? {} : this.#documentFields(app)) })
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

  // The address moves at the commit, and the step is the one the test was in then; the event waits for the title.
  #navigated(app: string, navigation: PageNavigation): void {
    this.#documents.set(app, this.#navigations.note(app, navigation, this.#stepId))
  }

  #writeNavigation({ app, document, stepId, cause }: NotedNavigation): void {
    const { testId, attemptId } = this.#options
    const { url, title } = document
    const step = stepId === undefined ? {} : { stepId }
    this.#options.emit({ type: 'navigation', testId, attemptId, ...step, session: app, url, ...(title === undefined ? {} : { title }), cause })
  }

  // The document the parent last saw an app's page commit, as an event records its page.
  #documentFields(app: string): PageFields {
    return documentFields(this.#documents.get(app))
  }

  // A timed-out test's process is asked to close; the kill timer from `revoke` ends it if it does not. The body is
  // over, so a navigation told from now on, as during the host checks, belongs to no step.
  #finish(report: Omit<BodyReport, 'timedOut'>): void {
    if (this.#report !== undefined) return
    this.#report = { ...report, timedOut: this.#timedOut }
    this.#stepId = undefined
    clearTimeout(this.#testTimer)
    if (this.#timedOut) this.#options.process.send({ type: 'close' })
    else clearTimeout(this.#killTimer)
    this.#finished.resolve(this.#report)
  }
}

// What a command's events record of its page: the page it went to as the page read it, or, when the page said
// nothing, a goto's address or the document the command arrived on. A failed command names the document the
// parent last saw commit when the answer came, since the frame may have opened it while the command waited.
function commandPage(entry: InFlight, result: CommandResult, latest: PageDocument | undefined): PageFields {
  if (result.ok && result.page !== undefined) return pageFields(result.page.url, result.page.title)
  if (result.ok) return result.kind === 'goto' ? { pageUrl: result.url } : documentFields(entry.document)
  return documentFields(latest)
}

function documentFields(document: PageDocument | undefined): PageFields {
  return document === undefined ? {} : pageFields(document.url, document.title)
}

function gotoDocument(result: Extract<CommandResult, { kind: 'goto' }>): PageDocument {
  const title = result.page?.title
  return title === undefined ? { url: result.url } : { url: result.url, title }
}

// What the test process's own checks refuse, which the parent refuses again before the page sees the command.
function commandProblem(command: PageCommand): Failure | undefined {
  switch (command.kind) {
    case 'press': {
      const parsed = parseKey(command.key)
      return parsed.ok ? undefined : parsed.failure
    }
    case 'select':
      return selectCommandProblem(command)
    case 'scroll':
      return scrollProblem(command)
    default:
      return undefined
  }
}

type ActionDetails = Pick<
  Extract<EventBody, { type: 'action.completed' }>,
  'valueLength' | 'secret' | 'key' | 'choices' | 'multiple' | 'changed' | 'scroll' | 'input' | 'via' | 'touch'
>

const listed = { multiple: true } as const
const scripted = { input: 'script' } as const
const tapped = { touch: true } as const

/**
 * What an action's event says besides its kind, locator and page, each only when it says something: how much a
 * fill typed or which secret, the key a press sent, the options a select chose, and whether the test passed them
 * as a list, the wheel's delta, and how the input reached the page. A select that completed set the choice from
 * Retest's world; one that failed set nothing. A check or uncheck on a touch screen taps. Whether the element
 * changed, and a label clicked in the control's place, come from the page's answer.
 */
function actionDetails(command: PageCommand, result: CommandResult, touch: boolean): ActionDetails {
  switch (command.kind) {
    case 'fill':
      return typedValue(command.value)
    case 'press':
      return { key: command.key }
    case 'select':
      return { choices: command.choices, ...(command.multiple === true ? listed : {}), ...changedOf(result), ...(result.ok ? scripted : {}) }
    case 'check':
    case 'uncheck':
      return { ...changedOf(result), ...(result.ok && 'via' in result && result.via !== undefined ? { via: result.via } : {}), ...(touch ? tapped : {}) }
    case 'scroll':
      return { scroll: { x: command.x, y: command.y } }
    default:
      return {}
  }
}

function changedOf(result: CommandResult): { changed?: boolean } {
  return result.ok && 'changed' in result ? { changed: result.changed } : {}
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
