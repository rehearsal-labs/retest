import type { NativeLook } from '../native/assertions.ts'
import { unsupportedCheck } from '../native/assertions.ts'
import { describeElement } from '../native/locators.ts'
import { isPageCheck, locatorCheck } from '../protocol/locator-checks.ts'
import { NativePageAdapter } from './native-pool.ts'
import type { OwnedPage, PageNavigation } from '../browser/contract.ts'
import type { EvaluationRequests } from '../evaluation/attempt.ts'
import type { ActionKind, CommandResult, FillValue, PageCommand } from '../protocol/commands.ts'
import type { ChildEvent, EventBody, EventOrigin } from '../protocol/events.ts'
import type { Failure, FailureClass, SourceLocation } from '../protocol/failures.ts'
import type { CheckRecord } from '../protocol/locator-checks.ts'
import type { LocatorRecipe, TextMatch } from '../protocol/locator.ts'
import type { ChildMessage } from '../protocol/messages.ts'
import type { Timeouts } from '../protocol/timeouts.ts'
import type { Variant } from '../protocol/variant.ts'
import type { ProcessExit } from '../shared/process-exit.ts'
import type { PageFields } from './observations.ts'
import type { NavigationStamp, NotedNavigation, PageDocument } from './page-navigations.ts'
import type { Redactor } from './redactor.ts'
import type { FillResolution, SecretFill } from './secrets.ts'
import type { ProcessEvent, TestFileMessage, TestFileProcess } from './test-file-process.ts'
import { refusedAnswer } from '../evaluation/attempt.ts'
import { describeCommand, isNavigationKind } from '../protocol/commands.ts'
import { Deadline, elapsedMs, monotonicClock, smallestBudget } from '../protocol/deadline.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage, failure, withAlso, withLocation } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { formatLine } from '../protocol/location.ts'
import { locatorProblem, locatorSteps } from '../protocol/locator.ts'
import { observedRecord } from '../protocol/observation-record.ts'
import { selectCommandProblem } from '../protocol/option-choices.ts'
import { scrollProblem } from '../protocol/scroll-delta.ts'
import { describeExit } from '../shared/process-exit.ts'
import { bounded } from './bounded.ts'
import { cleanedLook, pageFields, ServedObservations } from './observations.ts'
import { isOurs } from './outcome.ts'
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
  /** Hides secret values in everything sent to the child, and refuses a locator that holds one. */
  redactor?: Redactor
  /** The apps whose page emulates a touch screen, where a click is sent, and recorded, as a tap. */
  touch?: ReadonlySet<string>
  /** Runs the test's AI checks in this process. Without it, every check is refused. */
  evaluations?: EvaluationRequests
  /**
   * Told just before a secret's keys go to an app's page, with the secret's name, and given how far the keys got once
   * the fill has answered; the pixel capture policy withholds captures of that session in between. Absent in a run with
   * no capture policy.
   */
  secretEntry?: (app: string, secret: string) => SecretEntryEnd
}

/** Ends a secret's entry once its fill has answered: whether its keys were sent, not sent, or may have been. */
export type SecretEntryEnd = (input: 'not_sent' | 'sent' | 'unknown') => void

/**
 * Where a secret fill is going: the app whose page takes it, the page's address as it stands now and a way to read it
 * again, or for a native app the bundle id its installed app names, the fill's own time, and a signal aborted when the
 * fill is stopped, as when its test is.
 */
export type SecretFillContext = { app: string; pageUrl: string | undefined; currentUrl?: () => string | undefined; bundleId?: string; timeoutMs: number; signal: AbortSignal }

/** What the parent knows once the test body is over. */
export type BodyReport = {
  failure?: Failure
  assertionCount: number
  /** How the file's process had ended before the body was due. The body never started. */
  endedBeforeStart?: ProcessExit
  /** How the file's process ended during the test; later tests in the file cannot run. */
  processEnded?: ProcessExit
  /**
   * Retest killed the file's process during the test, so later tests in the file cannot run, though the process may
   * have answered the stop with its own verdict before the kill landed.
   */
  processKilled?: true
  /** The file's process ended on its own during the test, with nobody asking it to stop. */
  crashed?: true
  /** The test ran out of its own time. Its process is being ended, so later tests in the file cannot run. */
  timedOut: boolean
  /** The path of every project module the file's process had loaded when the test finished, as it said with its verdict. */
  modules?: string[]
  /**
   * The failures the parent saw for itself during the body, in order: a page command's failed answer, an assertion
   * failure on a look it served, an AI check it refused because the run has no judges, its own stop of the test and
   * the process ending. A failure the test file's process reports is its claim unless it is one of these, and these
   * fail the test whatever the process claims. Absent when there were none.
   */
  observed?: readonly Failure[]
}

type CommandMessage = Extract<ChildMessage, { type: 'command' }>
type AssertionRecord = Extract<EventBody, { type: 'assertion.passed' | 'assertion.failed' }>
/** A look the browser was lost during, or while its check waited for the next: its app and the loss it fails with. */
type LostLook = { app: string; failure: Failure }
/** Work running on an app that another command may not overlap: as the test writes it, and where. */
type Busy = { label: string; location: SourceLocation | undefined }
/** An AI check the parent is running, and the apps whose pages it captures. */
type Evaluating = { apps: readonly string[]; location: SourceLocation | undefined }
type EvaluateMessage = Extract<ChildMessage, { type: 'evaluate' }>
type TestScope = { testId: string; attemptId: string }
type InFlight = {
  message: CommandMessage
  /** The page of the app the command names. */
  page: OwnedPage
  /** The token the page is given with the command, which a navigation the command starts carries back. */
  commandToken: number
  /** The document the parent last saw that page commit when the command arrived. */
  document: PageDocument | undefined
  /** Settles once every navigation of that page told before the command arrived is written; absent when none waits. */
  navigations: Promise<void> | undefined
  startedAt: number
  /** The time the parent gave the command: the smallest of the action's budget, the call's own and the test's time left. */
  timeoutMs: number
  /** Settles once the page has answered. It exists before the page is called, which may lose its browser at once. */
  done: PromiseWithResolvers<void>
  /** Stops the page's work on the command when the test is revoked, with the revocation as its reason. */
  stop: AbortController
  /** The page's answer, kept while the command waits for the navigations before it to be written. */
  pageAnswer: CommandResult | undefined
  answered: boolean
  reported: boolean
}

// Commands that open a document, which the navigation budget times rather than the action budget.
const navigationKinds: ReadonlySet<string> = new Set(['goto', 'reload', 'goBack', 'goForward'])

// The classes a poller gives a check whose time ran out on a look that fails it.
const checkClasses: ReadonlySet<FailureClass> = new Set<FailureClass>(['not_found', 'ambiguous', 'check_failed'])

// Failures that say the browser went away, from the page that saw it go.
const lossClasses: ReadonlySet<FailureClass> = new Set<FailureClass>(['session_lost', 'outcome_unknown'])

/** A command the parent sent a page: its app, and its step and place, which a navigation it started names. */
type SentCommand = { app: string; stamp: NavigationStamp }

/**
 * The parent's side of one test body. It forwards the child's page commands to the browser, reports
 * each action, writes down each look it serves, judges each assertion against the look it names, and
 * enforces the test's deadline. An assertion it cannot accept ends the test as a protocol violation. It keeps the
 * test file's process's lanes too: an action goes to an app only while no command and no AI check that captures that
 * app runs there, and a look or such an AI check only while no action does, so what the process's own lanes would have
 * refused is refused here, with a failure the parent records.
 * Stopping a test revokes it: later commands are refused,
 * commands in flight are answered and stopped in the page, the child is asked to abort, and a child that
 * does not answer within the grace period is killed. A test that runs out of time also ends its process,
 * whether it answered or not, because code from it may still be running there.
 */
export class RunningTest {
  readonly #options: RunningTestOptions
  readonly #inFlight = new Map<number, InFlight>()
  /** The AI checks running, by the id the test process gave each. */
  readonly #evaluating = new Map<number, Evaluating>()
  readonly #finished = Promise.withResolvers<BodyReport>()
  #deadline: Deadline | undefined
  #testTimer: NodeJS.Timeout | undefined
  #killTimer: NodeJS.Timeout | undefined
  /** The document each app's page last committed, as far as the parent knows. */
  readonly #documents = new Map<string, PageDocument>()
  readonly #navigations = new PageNavigations((navigation) => this.#writeNavigation(navigation))
  readonly #nativeLooks = new Map<string, { page: NativePageAdapter; look: NativeLook }>()
  readonly #observations: ServedObservations
  /** Every command sent to a page in this attempt, by the token the page was given with it. */
  readonly #sent = new Map<number, SentCommand>()
  #stepId: string | undefined
  #revocation: Failure | undefined
  /** Whether the test file's process has been asked to abort the test. */
  #abortSent = false
  /** Whether Retest has killed the test file's process. */
  #killSent = false
  /** The page's latest answer saying that it or the browser was gone. */
  #lossAnswer: Failure | undefined
  /** The latest look a check sent that no assertion has reported on since: the check that may still be looking. */
  #looking: CommandMessage | undefined
  /** Where in the test the last command the parent accepted was sent from. */
  #lastLocation: SourceLocation | undefined
  /** The look the browser was lost during, or between whose looks it was lost, until its check is recorded. */
  #lostLook: LostLook | undefined
  /** Settles once the check that was looking when the browser was lost has reported, or the test is over. */
  #checkReported: PromiseWithResolvers<void> | undefined
  readonly #observed: Failure[] = []
  #report: BodyReport | undefined
  #assertionsSeen = 0
  #graceExpired = false
  #timedOut = false
  #stopNavigation: (() => void)[] = []

  constructor(options: RunningTestOptions) {
    this.#options = options
    this.#observations = new ServedObservations(options.redactor)
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
    this.#armTestTimer()
    return this.#finished.promise
  }

  /** Stops the test. The first reason wins; `graceMs` of 0 kills the child at once. */
  revoke(reason: Failure, graceMs: number): void {
    if (this.#abortSent || this.#report !== undefined) return
    this.#refuse(reason)
    this.#abort(this.#revocation ?? reason, graceMs)
  }

  // Refuses every later command with the reason, and answers and stops the commands in flight, without yet asking the
  // process to abort. The first reason wins.
  #refuse(reason: Failure): void {
    if (this.#revocation !== undefined) return
    this.#revocation = reason
    this.#observed.push(reason)
    clearTimeout(this.#testTimer)
    this.#options.evaluations?.cancel(reason)
    for (const page of this.#options.pages.values()) if (page instanceof NativePageAdapter) page.cancel(reason)
    this.#completeAnswered()
    for (const entry of this.#inFlight.values()) {
      this.#answer(entry, { ok: false, failure: withLocation(reason, entry.message.location) })
      entry.stop.abort(reason)
    }
  }

  #abort(reason: Failure, graceMs: number): void {
    this.#abortSent = true
    const { process, redactor } = this.#options
    process.send({ type: 'abort', reason: redactor?.redact(reason.message) ?? reason.message })
    if (graceMs === 0) {
      this.#killSent = true
      void process.kill()
      return
    }
    this.#killTimer = setTimeout(() => {
      this.#graceExpired = true
      this.#killSent = true
      void process.kill()
    }, graceMs)
    void process.closed.then(() => clearTimeout(this.#killTimer))
  }

  /**
   * The browser went away. Only the page knows whether a command in flight had sent its input, and it
   * answers as soon as the connection is gone, so the test stops with that answer. An action that gives
   * none within the grace period may have taken effect. A check that was looking is answered with the loss and
   * reports it as its own failure, with its matcher and its place, which a process asked to abort would never send,
   * so the process is asked to abort once that check has reported, or once the grace period is over.
   */
  browserLost(reason: string): void {
    const answers = [...this.#inFlight.values()].map((entry) => entry.done.promise)
    void bounded(Promise.all(answers), abortGraceMs).then(async () => {
      if (this.#report !== undefined) return
      this.#navigations.writeWaiting()
      this.#completeAnswered()
      const loss = this.#lossFailure(reason)
      const looking = this.#looking
      if (looking === undefined || loss.class !== 'session_lost' || this.#revocation !== undefined) return this.revoke(loss, abortGraceMs)
      this.#lostLook ??= { app: looking.app, failure: loss }
      const reported = Promise.withResolvers<void>()
      this.#checkReported = reported
      this.#refuse(loss)
      await bounded(reported.promise, abortGraceMs)
      this.revoke(loss, abortGraceMs)
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
      case 'evaluate':
        return this.#evaluate(message)
      case 'test-finished':
        return this.#childFinished(message)
      default:
        return this.#violation(`sent ${message.type} while a test was running`)
    }
  }

  #command(message: CommandMessage): void {
    if (!this.#isOwn(message)) return this.#violation('sent a command for an inactive test attempt')
    if (this.#deadline?.reached === true) this.#runOutOfTime()
    const refusal = this.#report === undefined ? this.#revocation : failure('usage', 'No test is running, so Retest sent nothing to the page.')
    if (refusal !== undefined) return this.#send(message.id, { ok: false, failure: withLocation(refusal, message.location) })
    const page = this.#options.pages.get(message.app)
    if (page === undefined) return this.#violation(`sent a command for the app ${JSON.stringify(message.app)}, which this test does not use`)
    if (this.#inFlight.has(message.id) || this.#evaluating.has(message.id)) return this.#violation(`sent command ${message.id} again while the first was still running`)
    const running = this.#busyWith(message.app, isLook(message.command))
    if (running !== undefined) return this.#refuseConcurrent(message, running)
    // Only a check's look waits for its assertion after a loss: a plain read reports nothing, so nothing is waited for.
    if (isLook(message.command)) {
      if (message.command.check === true) this.#looking = message
    } else if (this.#looking?.app === message.app) this.#looking = undefined
    if (message.location !== undefined) this.#lastLocation = message.location
    const deadline = this.#deadline
    // A command's time is the parent's to keep, whatever the test process claims: the run's budget for its kind, cut
    // by the call's own timeout and by what the test has left, never lengthened by either.
    const own = message.callTimeoutMs === undefined ? [] : [message.callTimeoutMs]
    const asked = smallestBudget(message.timeoutMs, this.#budgetOf(message.command), ...own)
    const timeoutMs = deadline === undefined ? asked : smallestBudget(asked, deadline.remainingMs)
    this.#stepId = message.stepId
    const commandToken = this.#sent.size + 1
    this.#sent.set(commandToken, { app: message.app, stamp: stampOf(message.stepId, message.location) })
    const entry: InFlight = {
      message,
      page,
      commandToken,
      document: this.#documents.get(message.app),
      navigations: this.#navigations.waiting(message.app),
      startedAt: monotonicClock(),
      timeoutMs,
      done: Promise.withResolvers(),
      stop: new AbortController(),
      pageAnswer: undefined,
      answered: false,
      reported: false,
    }
    this.#inFlight.set(message.id, entry)
    void this.#execute(entry, timeoutMs).finally(() => entry.done.resolve())
  }

  // What runs on the app that new work there may not overlap, as the test file's own lanes decide: an action needs its
  // app to itself, and a look, like an AI check that captures the app, needs no action running there, though looks and
  // such checks may overlap each other.
  #busyWith(app: string, looking: boolean): Busy | undefined {
    for (const entry of this.#inFlight.values()) {
      if (entry.message.app !== app) continue
      if (!looking || !isLook(entry.message.command)) return { label: describeCommand(entry.message.command), location: entry.message.location }
    }
    if (looking) return undefined
    for (const evaluating of this.#evaluating.values()) {
      if (evaluating.apps.includes(app)) return { label: 'test.evaluate()', location: evaluating.location }
    }
    return undefined
  }

  // The test file's own lanes never send such a command, so one that arrives came from a process that skipped them. It
  // goes nowhere near the page, and its refusal is the parent's own failure, which fails the test whatever the process
  // claims; an action's refusal is its failed event. What already runs goes on.
  #refuseConcurrent(message: CommandMessage, running: Busy): void {
    const { app, command, location } = message
    const refused = concurrentFailure(`sent ${describeCommand(command)} to ${app}`, running, location, 'Retest did not send it')
    this.#observed.push(refused)
    if (!isLook(command)) this.#writeAction(message, { ok: false, failure: refused }, this.#documentFields(app), { durationMs: 0 })
    this.#send(message.id, { ok: false, failure: refused })
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
    const earlier = result.ok && !isNavigationKind(result.kind) ? entry.navigations : this.#navigations.waiting(app)
    if (earlier !== undefined) await earlier
    this.#complete(entry)
  }

  // A command the page answered is recorded, then answered, once.
  #complete(entry: InFlight): void {
    const answer = entry.pageAnswer
    const { id, app } = entry.message
    if (answer === undefined || !this.#inFlight.delete(id)) return
    if (answer.ok && isNavigationKind(answer.kind) && 'url' in answer) this.#documents.set(app, openedDocument(answer))
    if (!answer.ok && lossClasses.has(answer.failure.class)) {
      this.#lossAnswer = answer.failure
      if (isLook(entry.message.command)) this.#lostLook ??= { app, failure: answer.failure }
    }
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

  // A secret is read, within the command's own time, only once the page's current address, or the native app's
  // bundle id, may take it. What the test process's own checks refuse is refused again here, since it may send what
  // those checks never saw. A locator that holds a secret's value never reaches the page, which matches it against
  // its own unredacted text.
  async #run({ message, page, stop, commandToken }: InFlight, timeoutMs: number): Promise<CommandResult> {
    const { command } = message
    const problem = commandProblem(command) ?? secretLocatorProblem(command, this.#options.redactor) ?? (page instanceof NativePageAdapter ? undefined : namedRowProblem(command))
    if (problem !== undefined) {
      // A look the parent refuses is refused every time, so no check on it can pass: the refusal is the parent's own
      // failure, as an action's is through its event.
      if (isLook(command) && this.#revocation === undefined) this.#observed.push(withLocation(problem, message.location))
      return { ok: false, failure: problem }
    }
    if (command.kind === 'swipe' || command.kind === 'nativeKeyboard' || command.kind === 'nativeAlert') return page instanceof NativePageAdapter ? page.execute(command, timeoutMs, stop.signal) : { ok: false, failure: failure('unsupported', `${command.kind} needs a native app session.`) }
    if (command.kind !== 'fill') return page.execute(command, timeoutMs, stop.signal, commandToken)
    const { locator, value } = command
    if (typeof value === 'string') return page.execute({ kind: 'fill', locator, value }, timeoutMs, stop.signal, commandToken)
    const deadline = new Deadline(timeoutMs)
    const { fillSecret } = this.#options
    // A native app has no address: the bundle id read from its installed app is where the secret would go. A page can be
    // read again, so a fill that finds it on no address yet can wait for its first.
    const destination = page instanceof NativePageAdapter ? { pageUrl: undefined, bundleId: page.bundleId } : { pageUrl: page.url, currentUrl: () => page.url }
    const context: SecretFillContext = { app: message.app, ...destination, timeoutMs, signal: stop.signal }
    const resolved = fillSecret === undefined ? noSecrets(value.secret) : await fillSecret({ kind: 'fill', locator, value }, context)
    if (!resolved.ok) return { ok: false, failure: resolved.failure }
    const ended = this.#options.secretEntry?.(message.app, value.secret)
    const result = await page.execute(resolved.command, deadline.commandTimeoutMs, stop.signal, commandToken)
    ended?.(result.ok ? 'sent' : result.failure.details?.['inputSent'] === false ? 'not_sent' : 'unknown')
    return result
  }

  // An action is reported once: by the page's answer, or as unknown when the page gave none in time.
  #reportAction(entry: InFlight, result: CommandResult, page: PageFields): void {
    const { command, callTimeoutMs } = entry.message
    if (isLook(command) || entry.reported) return
    entry.reported = true
    // A command answered after the parent stopped the test failed because of that stop, which is already observed.
    if (!result.ok && this.#revocation === undefined) this.#observed.push(result.failure)
    const timing = callTimeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs, callTimeoutMs }
    this.#writeAction(entry.message, result, page, { durationMs: elapsedMs(entry.startedAt), ...timing })
  }

  #writeAction(message: CommandMessage, result: CommandResult, page: PageFields, timing: { durationMs: number; timeoutMs?: number; callTimeoutMs?: number }): void {
    const { command, location, stepId, app } = message
    if (isLook(command)) return
    const touch = this.#options.touch?.has(app) === true
    const fields = {
      testId: this.#options.testId,
      attemptId: this.#options.attemptId,
      ...(stepId === undefined ? {} : { stepId }),
      session: app,
      sessionId: formatSessionId(this.#options.attemptId, app),
      command: recordedKind(command.kind, result, touch),
      ...('locator' in command && command.locator !== undefined ? { locator: command.locator } : {}),
      ...page,
      durationMs: timing.durationMs,
      ...(location === undefined ? {} : { location }),
      ...actionDetails(command, result, touch),
      ...(timing.timeoutMs === undefined || timing.callTimeoutMs === undefined ? {} : { timeoutMs: timing.timeoutMs, callTimeoutMs: timing.callTimeoutMs }),
    }
    this.#options.emit(result.ok ? { type: 'action.completed', ...fields } : { type: 'action.failed', ...fields, failure: result.failure })
  }

  // The budget the run gives a command of this kind; a look's is the test process's to choose, within the test's time.
  #budgetOf(command: PageCommand): number {
    const { timeouts } = this.#options
    if (command.kind.startsWith('observe')) return timeouts.test
    return navigationKinds.has(command.kind) ? timeouts.navigation : timeouts.action
  }

  #answer(entry: InFlight, result: CommandResult): void {
    if (entry.answered || this.#report !== undefined) return
    entry.answered = true
    this.#options.process.send({ type: 'command-result', id: entry.message.id, result: this.#serve(entry, this.#redacted(result), entry.page instanceof NativePageAdapter && result.ok && result.kind === 'observe' ? entry.page.lookFor(result.observation) : undefined) })
  }

  #send(id: number, result: CommandResult): void {
    this.#options.process.send({ type: 'command-result', id, result: this.#redacted(result) })
  }

  // Page text, a URL or a failure may quote a secret value the page showed, so the child gets it redacted.
  #redacted(result: CommandResult): CommandResult {
    return this.#options.redactor?.redactCommandResult(result) ?? result
  }

  // A look the page answered is written down, as the test process receives it, before the answer goes; the
  // id and the session it carries are how an assertion names it.
  #serve(entry: InFlight, result: CommandResult, nativeLook?: NativeLook): CommandResult {
    const { command, app, stepId } = entry.message
    if (result.ok && result.kind === 'observePage' && command.kind === 'observePage') return this.#servePage(app, result)
    if (!result.ok || result.kind !== 'observe' || command.kind !== 'observe') return result
    const { locator } = command
    const { observation } = result
    const page = commandPage(entry, result, this.#documents.get(app))
    const { testId, attemptId } = this.#options
    const sessionId = formatSessionId(attemptId, app)
    const observationId = this.#observations.serve({ app, sessionId, locator, observation, ...page })
    if (nativeLook !== undefined && entry.page instanceof NativePageAdapter) this.#nativeLooks.set(observationId, { page: entry.page, look: nativeLook })
    const native = nativeLook === undefined ? {} : { native: { generation: nativeLook.reference.generation, selected: nativeLook.observation.selected, ...(nativeLook.matches.length === 1 && nativeLook.matches[0] !== undefined ? { element: describeElement(nativeLook.matches[0], nativeLook.tree.platform) } : {}) } }
    const step = stepId === undefined ? {} : { stepId }
    const waited = result.waitedMs === undefined ? {} : { waitedMs: result.waitedMs }
    this.#options.emit({ type: 'observation', testId, attemptId, ...step, session: app, observationId, sessionId, locator, ...page, observed: observedRecord(observation), ...native, durationMs: elapsedMs(entry.startedAt), ...waited })
    return { ...result, observationId, sessionId }
  }

  // A look at the page itself is kept for the assertion that names it, which records its address and title. Its looks
  // have no event of their own, since an observation event is a look at a locator's elements. It is kept redacted, as
  // the test process receives it, so the parent judges what the test process saw.
  #servePage(app: string, result: Extract<CommandResult, { kind: 'observePage' }>): CommandResult {
    const sessionId = formatSessionId(this.#options.attemptId, app)
    const { baseUrl } = result
    const observation = this.#options.redactor?.redactPageLook(result.observation) ?? cleanedLook(result.observation)
    const observationId = this.#observations.serve({ app, sessionId, page: baseUrl === undefined ? observation : { ...observation, baseUrl } })
    return { ...result, observation, observationId, sessionId }
  }

  // The page's own answer when it gave one. An action it never answered may have taken effect.
  #lossFailure(reason: string): Failure {
    const unanswered = [...this.#inFlight.values()].find((entry) => !entry.message.command.kind.startsWith('observe'))
    if (unanswered !== undefined) {
      const { command, location } = unanswered.message
      const message = `The browser was lost during ${describeCommand(command)}, which had not answered ${abortGraceMs} ms later, so whether it took effect is unknown. ${reason}`
      const unknown = failure('outcome_unknown', message, location)
      this.#reportAction(unanswered, { ok: false, failure: unknown }, this.#documentFields(unanswered.message.app))
      return unknown
    }
    // A look the page never answered is where the test was when the browser went; with nothing in flight, the check that
    // was between its looks, or else the last command the test sent.
    const looking = [...this.#inFlight.values()].find((entry) => isLook(entry.message.command))
    const where = looking?.message.location ?? this.#looking?.location ?? this.#lastLocation
    return this.#lossAnswer ?? failure('session_lost', `The browser was lost: ${reason}`, where)
  }

  // An assertion is written only as the parent judged it; one the parent cannot accept ends the test.
  #childEvent(event: ChildEvent): void {
    if (!this.#isOwn(event)) return this.#violation(`sent ${event.type} for an inactive test attempt`)
    if (event.type !== 'assertion.passed' && event.type !== 'assertion.failed') return this.#options.emit(event, 'child')
    // An assertion that names no app looks at the test's first one, as milestone 1's single page. One that names an app
    // the test does not have names a session that never existed.
    if (event.session !== undefined && !this.#options.pages.has(event.session)) {
      return this.#violation(`sent ${event.type} for the app ${JSON.stringify(event.session)}, which this test does not use`)
    }
    const [firstApp] = this.#options.pages.keys()
    const app = event.session ?? firstApp
    const looked = app === undefined ? {} : { sessionId: formatSessionId(this.#options.attemptId, app), ...this.#documentFields(app) }
    const native = event.observationId === undefined ? undefined : this.#nativeLooks.get(event.observationId)
    let assertion = event
    // A native look is judged on the tree the parent read, which can also show the reference stale or the check one the
    // platform cannot make; the parent's failure then stands in for any verdict the process sent, a pass included.
    let nativeFailure: Failure | undefined
    if (native !== undefined && event.check !== undefined && !isPageCheck(event.check) && event.locator !== undefined) {
      const rule = locatorCheck(event.check)
      const unsupported = native.page.native.checkReference(native.look.reference) ?? unsupportedCheck(event.check, native.look.matches, event.locator, native.look.tree.platform)
      if (unsupported !== undefined || !rule.passes(native.look.observation)) {
        const element = native.look.matches[0]
        const description = element === undefined ? undefined : describeElement(element, native.look.tree.platform)
        nativeFailure = unsupported ?? failure('check_failed', `${rule.mismatch(native.look.observation, describeCommand({ kind: 'observe', locator: event.locator }))}${description === undefined ? '' : ` Element: ${description}.`}`)
        assertion = event.type === 'assertion.failed' ? event : { ...event, type: 'assertion.failed', failure: nativeFailure }
      }
    }
    const judged = this.#observations.judge(assertion, { app, ...looked })
    if (!judged.ok) return this.#violation(judged.problem)
    const { event: recorded, origin, seen } = this.#parentVerdict(judged.event, { app, check: event.check, nativeFailure })
    // A class the parent did not see, and that would make the test ours rather than the app's, stays the process's claim.
    if (recorded.type === 'assertion.failed' && (seen || !isOurs(recorded.failure))) this.#observed.push(recorded.failure)
    this.#assertionsSeen++
    this.#looking = undefined
    this.#options.emit(recorded, origin)
    this.#checkReported?.resolve()
  }

  // Whose failure leads a failed check, and whether the parent saw it for itself. A loss the parent saw while the check
  // looked leads, since it cut the check short. Otherwise the parent's own rule on the look the check names decides: where
  // it fails, the parent's failure leads and the process's follows in `also`, so a process can never turn a failure the
  // parent saw into a loss, a setup failure, a timeout or any other class. A web check whose process sent one of the classes
  // a poller gives a check its time ran out on keeps the process's words, which say how long it looked: each of them fails
  // the test on the app, with the same status and exit code. A native check's failure is always the parent's,
  // since only the parent's tree read names the element. With no look, or a look the check passes on, the process's
  // failure stands as its claim.
  #parentVerdict(event: AssertionRecord, { app, check, nativeFailure }: { app: string | undefined; check: CheckRecord | undefined; nativeFailure: Failure | undefined }): { event: AssertionRecord; origin: EventOrigin; seen: boolean } {
    const lost = this.#lostCheck(event, app)
    if (lost.origin === 'parent') return { ...lost, seen: true }
    if (event.type !== 'assertion.failed') return { event, origin: 'child', seen: false }
    const own = nativeFailure ?? (event.observationId === undefined || check === undefined ? undefined : this.#observations.lookFailure(event.observationId, check))
    if (own === undefined) return { event, origin: 'child', seen: false }
    if (nativeFailure === undefined && checkClasses.has(event.failure.class)) return { event, origin: 'child', seen: true }
    return { event: { ...event, failure: withAlso(withLocation(own, event.location), [event.failure]) }, origin: 'parent', seen: true }
  }

  // A check that failed because the browser was lost while it looked is the parent's own record, since the parent saw
  // the loss: the loss leads, at the check's place, and anything else the process says of it follows. Its matcher, its
  // expected text and the look it rests on are what the parent judged, as for a check whose look answered.
  #lostCheck(event: AssertionRecord, app: string | undefined): { event: AssertionRecord; origin: EventOrigin } {
    const lost = this.#lostLook
    if (lost === undefined || event.type !== 'assertion.failed' || app !== lost.app || !lossClasses.has(event.failure.class)) return { event, origin: 'child' }
    this.#lostLook = undefined
    return { event: { ...event, failure: withAlso(withLocation(lost.failure, event.location), [event.failure]) }, origin: 'parent' }
  }

  // The parent captures the evidence and asks the judge itself; the test file's process only says what to judge, and
  // its own time bounds the check. An answer that comes once the test is over or stopped goes nowhere.
  #evaluate(message: EvaluateMessage): void {
    if (!this.#isOwn(message)) return this.#violation('sent an evaluation for an inactive test attempt')
    if (this.#evaluating.has(message.id) || this.#inFlight.has(message.id)) return this.#violation(`sent evaluation ${message.id} again while the first request was still running`)
    if (this.#deadline?.reached === true) this.#runOutOfTime()
    const { evaluations, process } = this.#options
    const refusal = this.#report === undefined ? this.#revocation : failure('usage', 'No test is running, so Retest judged nothing.')
    if (refusal !== undefined || evaluations === undefined) {
      const reason = withLocation(refusal ?? failure('evaluation_error', 'This run cannot run AI checks.'), message.location)
      // A check refused because the run has no judges is the parent's own refusal, so the class it gave stands when the
      // test reports it back; a check refused because the test is over is covered by the verdict.
      if (refusal === undefined) this.#observed.push(reason)
      process.send({ type: 'evaluation-result', id: message.id, answer: refusedAnswer(message.call.mode, reason) })
      return
    }
    // A check that captures an app's page holds that app as a look does, as the test file's own lanes hold it, so no
    // action runs there while the screenshot is taken and judged.
    const apps = capturedApps(message.call, [...this.#options.pages.keys()])
    const running = apps.map((app) => this.#busyWith(app, true)).find((busy) => busy !== undefined)
    if (running !== undefined) {
      const refused = concurrentFailure(`asked for test.evaluate() on ${apps.join(' and ')}`, running, message.location, 'Retest did not run it')
      this.#observed.push(refused)
      process.send({ type: 'evaluation-result', id: message.id, answer: refusedAnswer(message.call.mode, refused) })
      return
    }
    this.#evaluating.set(message.id, { apps, location: message.location })
    const remainingMs = this.#deadline?.remainingMs ?? this.#options.timeouts.test
    void evaluations
      .request(message.call, { location: message.location, stepId: message.stepId, remainingMs })
      .then((answer) => {
        // The check lets go of its apps before its answer goes, as a command does, so the test's next action is not refused.
        this.#evaluating.delete(message.id)
        if (this.#report === undefined && this.#revocation === undefined) process.send({ type: 'evaluation-result', id: message.id, answer })
      })
      .finally(() => this.#evaluating.delete(message.id))
  }

  #childFinished(message: Extract<TestFileMessage, { type: 'test-finished' }>): void {
    if (!this.#isOwn(message)) return this.#violation('finished an inactive test attempt')
    const modules = message.modules === undefined ? {} : { modules: message.modules }
    this.#finish({ ...this.#verdict(message), assertionCount: message.assertionCount, ...modules })
  }

  #isOwn(scope: TestScope): boolean {
    return scope.testId === this.#options.testId && scope.attemptId === this.#options.attemptId
  }

  // A test the parent stopped has failed for that reason, unless the child recorded an earlier failure. A child whose
  // first failure is the stop itself, as the answer to a command the stop cut short, only repeats the reason at that
  // command's place; the reason stands as the parent gave it, as it does when the process ends before it answers.
  #verdict(message: Extract<TestFileMessage, { type: 'test-finished' }>): { failure?: Failure } {
    const reason = this.#revocation
    const own = message.failure
    if (reason !== undefined) return { failure: own === undefined || repeats(own, reason) ? reason : withAlso(own, [reason]) }
    if (message.status === 'passed') return {}
    return { failure: own ?? failure('test_error', 'The test process reported a failure without a reason.') }
  }

  #armTestTimer(): void {
    const deadline = this.#deadline
    if (deadline === undefined || this.#report !== undefined || this.#revocation !== undefined) return
    if (deadline.reached) return this.#runOutOfTime()
    this.#testTimer = setTimeout(() => this.#armTestTimer(), deadline.waitToEndMs)
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
    if (problem !== reason) this.#observed.push(problem)
    this.#finish({ failure: problem, assertionCount: this.#assertionsSeen, processEnded: exit, ...(reason === undefined ? { crashed: true as const } : {}) })
  }

  #violation(problem: string): void {
    if (this.#report !== undefined) return
    this.revoke(failure('test_error', `The process for this file ${problem}.`), 0)
  }

  // The address moves at the commit; the event waits for the title. A navigation a command started belongs to that
  // command's step and place, however late it commits, as when Chrome tells of a link's navigation after the next
  // command began. Any other belongs to the step the test was in when it committed.
  #navigated(app: string, navigation: PageNavigation): void {
    const sent = navigation.commandToken === undefined ? undefined : this.#sent.get(navigation.commandToken)
    const stamp = sent !== undefined && sent.app === app ? sent.stamp : stampOf(this.#stepId, undefined)
    this.#documents.set(app, this.#navigations.note(app, navigation, stamp))
  }

  #writeNavigation({ app, document, stamp, cause, opened }: NotedNavigation): void {
    const { testId, attemptId } = this.#options
    const { url, title } = document
    const { stepId, location } = stamp
    const step = stepId === undefined ? {} : { stepId }
    const place = location === undefined ? {} : { location }
    const sessionId = formatSessionId(attemptId, app)
    this.#options.emit({ type: 'navigation', testId, attemptId, ...step, session: app, sessionId, url, ...(title === undefined ? {} : { title }), cause, document: opened, ...place })
  }

  // The document the parent last saw an app's page commit, as an event records its page.
  #documentFields(app: string): PageFields {
    return documentFields(this.#documents.get(app))
  }

  // A timed-out test's process is asked to close; the kill timer from `revoke` ends it if it does not. The body is
  // over, so a navigation told from now on, as during the host checks, belongs to no step.
  #finish(report: Omit<BodyReport, 'timedOut' | 'observed'>): void {
    if (this.#report !== undefined) return
    this.#report = { ...report, timedOut: this.#timedOut, ...(this.#killSent ? { processKilled: true as const } : {}), ...(this.#observed.length === 0 ? {} : { observed: [...this.#observed] }) }
    this.#stepId = undefined
    clearTimeout(this.#testTimer)
    this.#options.evaluations?.cancel(failure('evaluation_error', 'The test ended before the answer came.'))
    if (this.#timedOut) this.#options.process.send({ type: 'close' })
    else clearTimeout(this.#killTimer)
    this.#checkReported?.resolve()
    this.#finished.resolve(this.#report)
  }
}

// What a command's events record of its page: the page it went to as the page read it, or, when the page said
// nothing, a goto's address or the document the command arrived on. A failed command names the document the
// parent last saw commit when the answer came, since the frame may have opened it while the command waited.
function commandPage(entry: InFlight, result: CommandResult, latest: PageDocument | undefined): PageFields {
  if (!result.ok) return documentFields(latest)
  if ('page' in result && result.page !== undefined) return pageFields(result.page.url, result.page.title)
  return 'url' in result ? { pageUrl: result.url } : documentFields(entry.document)
}

function documentFields(document: PageDocument | undefined): PageFields {
  return document === undefined ? {} : pageFields(document.url, document.title)
}

// The same failure, as `withAlso` counts a repeat: its class and its words, wherever it was placed.
function repeats(own: Failure, reason: Failure): boolean {
  return own.class === reason.class && own.message === reason.message
}

function stampOf(stepId: string | undefined, location: SourceLocation | undefined): NavigationStamp {
  return { ...(stepId === undefined ? {} : { stepId }), ...(location === undefined ? {} : { location }) }
}

// The document a goto, a reload or a move through the history opened, as its answer names it.
function openedDocument(result: Extract<CommandResult, { url: string }>): PageDocument {
  const title = result.page?.title
  return title === undefined ? { url: result.url } : { url: result.url, title }
}

// What the test process's own checks refuse, which the parent refuses again before the page sees the command.
function commandProblem(command: PageCommand): Failure | undefined {
  const located = 'locator' in command && command.locator !== undefined ? locatorProblem(command.locator) : undefined
  if (located !== undefined) return located
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

/**
 * A command whose locator, in any of its steps, holds a whole value the run has read in its text, name, pattern or
 * CSS selector, which the parent refuses before the page is asked: the page matches a locator against its own text
 * and attributes, unredacted, so such a locator could find a value the page shows. The refusal never quotes the text.
 * Part of a value is not refused, since refusing it would itself say which texts are part of a secret.
 */
function secretLocatorProblem(command: PageCommand, redactor: Redactor | undefined): Failure | undefined {
  if (redactor === undefined || !('locator' in command) || command.locator === undefined) return undefined
  const held = matchedTexts(command.locator).find((matched) => redactor.holdsValue(matched.text, matched.exact))
  if (held === undefined) return undefined
  const message = `Retest did not send this command to the page: its locator's ${held.named} holds the value of a secret. Find the element by its test id, or by text that holds no secret.`
  return failure('usage', message)
}

/**
 * A web command whose locator finds a table row by its name, in any step, which no browser engine answers truly:
 * Chrome's accessibility tree gives a row no name from its cells, and Retest computes none, so such a lookup finds
 * nothing and a check that the row is hidden, or that none match, would pass beside a row on screen. It is refused for
 * every action and every check before the page is asked. A native app's tree names its rows, so it is not refused there.
 */
function namedRowProblem(command: PageCommand): Failure | undefined {
  if (!('locator' in command) || command.locator === undefined) return undefined
  const named = locatorSteps(command.locator).some((step) => step.by === 'role' && step.role === 'row' && step.name !== undefined)
  if (!named) return undefined
  const message = "getByRole('row', { name }) finds no row on a web page: the browser's accessibility tree gives a table row no name from its cells, so the lookup would match nothing and a check that the row is hidden would pass while it is on screen. Find the row by its test id, or find the cell by its own text, such as getByText('Grace Hopper') or getByRole('cell', { name: 'Grace Hopper' })."
  return failure('unsupported', message)
}

type MatchedText = { text: string; exact: boolean; named: 'text' | 'name' | 'pattern' | 'selector' }

// What each step of a locator matches against the page, and how: a text, label or placeholder's text, a role's name,
// a pattern's source, which may ignore case, and a CSS selector, which matches attributes as written.
function matchedTexts(locator: LocatorRecipe): MatchedText[] {
  return locatorSteps(locator).flatMap((step): MatchedText[] => {
    switch (step.by) {
      case 'testId':
        return []
      case 'css':
        return [{ text: step.selector, exact: true, named: 'selector' }]
      case 'role':
        return step.name === undefined ? [] : [textOf(step.name, step.exact, 'name')]
      default:
        return [textOf(step.text, step.exact, 'text')]
    }
  })
}

function textOf(text: TextMatch, exact: boolean | undefined, named: 'text' | 'name'): MatchedText {
  return typeof text === 'string' ? { text, exact: exact !== false, named } : { text: text.pattern, exact: false, named: 'pattern' }
}

type ActionDetails = Pick<
  Extract<EventBody, { type: 'action.completed' }>,
  'valueLength' | 'secret' | 'key' | 'choices' | 'multiple' | 'changed' | 'scroll' | 'input' | 'via' | 'touch' | 'direction' | 'operation' | 'button'
>

const listed = { multiple: true } as const
const tapped = { touch: true } as const

/**
 * What an action's event says besides its kind, locator and page, each only when it says something: how much a
 * fill typed or which secret, the key a press sent, the options a select chose, and whether the test passed them
 * as a list, the wheel's delta, the way a swipe went, what a native keyboard or alert call did and the alert button it
 * pressed. A select chooses with real keys, so no event says `input: 'script'` any more. A check or uncheck on a touch
 * screen taps. Whether the element changed, and a label clicked in the control's place,
 * come from the page's answer.
 */
function actionDetails(command: PageCommand, result: CommandResult, touch: boolean): ActionDetails {
  switch (command.kind) {
    case 'fill':
      return typedValue(command.value)
    case 'press':
      return { key: command.key }
    case 'select':
      return { choices: command.choices, ...(command.multiple === true ? listed : {}), ...changedOf(result) }
    case 'check':
    case 'uncheck':
      return { ...changedOf(result), ...(result.ok && 'via' in result && result.via !== undefined ? { via: result.via } : {}), ...(touch ? tapped : {}) }
    case 'scroll':
      return { scroll: { x: command.x, y: command.y } }
    case 'swipe':
      return { direction: command.direction }
    case 'nativeKeyboard':
      return { operation: command.operation }
    case 'nativeAlert':
      return { operation: command.operation, ...(command.button === undefined ? {} : { button: command.button }) }
    default:
      return {}
  }
}

function changedOf(result: CommandResult): { changed?: boolean } {
  return result.ok && 'changed' in result ? { changed: result.changed } : {}
}

// The page's answer says what it did; a failed click on a touch screen was a tap too.
function recordedKind(sent: ActionKind, result: CommandResult, touch: boolean): ActionKind {
  if (result.ok && result.kind !== 'observe' && result.kind !== 'observePage') return result.kind
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
  return { ok: false, failure: failure(command.kind.startsWith('observe') ? 'session_lost' : 'outcome_unknown', message) }
}

// The apps whose pages an AI check captures: each screenshot's or recording's app, the test's first app when it names
// none, as the test file's process counts them. An app the test does not have is the check's own refusal.
function capturedApps(call: EvaluateMessage['call'], apps: readonly string[]): string[] {
  const [first] = apps
  const named = call.evidence.flatMap((selector) => (selector.kind === 'text' ? [] : [selector.app ?? first]))
  return [...new Set(named.filter((app): app is string => app !== undefined && apps.includes(app)))]
}

// Work refused because the app was busy: what was asked, what was still running there, and both places in the test.
function concurrentFailure(asked: string, running: Busy, location: SourceLocation | undefined, outcome: string): Failure {
  const text = [
    `The test file's process ${asked} while ${running.label} was still running there, so ${outcome}.`,
    'Retest sends one command at a time to each app, and no action while a check looks at it.',
  ].join(' ')
  return { ...failure('concurrent_commands', text, location), details: { running: lineOrNull(running.location), next: lineOrNull(location) } }
}

// A look reads its app's page and changes nothing there; every other command is an action.
function isLook(command: PageCommand): command is Extract<PageCommand, { kind: 'observe' | 'observePage' }> {
  return command.kind === 'observe' || command.kind === 'observePage'
}

function lineOrNull(location: SourceLocation | undefined): string | null {
  return location === undefined ? null : formatLine(location)
}
