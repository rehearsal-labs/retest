import type { BrowserCommand, DispatchedCommand, InputDispatch, OwnedBrowser, OwnedPage, SessionIdentity, WebEngine, WebRuntimeIdentity, WebSession } from '../browser/contract.ts'
import type { FrameSource } from '../media/capture.ts'
import type { CommandResult, Observation, PageCommand } from '../protocol/commands.ts'
import type { Failure } from '../protocol/failures.ts'
import type { HostCheck, HostCheckRecord } from '../protocol/host-check.ts'
import type { RecordIdentity } from '../protocol/identity.ts'
import type { LocatorRecipe, LocatorStep, TextMatch } from '../protocol/locator.ts'
import type { OptionChoiceRecord } from '../protocol/option-choices.ts'
import type { PageFacts } from '../protocol/page-facts.ts'
import type { SecretRef } from '../protocol/secret.ts'
import type { StorageState } from '../protocol/storage-state.ts'
import type { Requirement } from '../runner/fingerprint.ts'
import type { Redactor } from '../runner/redactor.ts'
import type { ResourceLease } from '../runner/resources.ts'
import type { SecretFiller } from '../runner/secrets.ts'
import type { SessionLease } from '../runner/sessions.ts'
import type { CheckIdentity, CheckOutcome } from './checks.ts'
import type { ElementIdentity, KeyedRead } from './identity.ts'
import type { ElementRef, ServedLook } from './looks.ts'
import { Deadline, smallestBudget } from '../protocol/deadline.ts'
import { describeCommand, pageCommandSchema } from '../protocol/commands.ts'
import { errorMessage, failure, failureSchema } from '../protocol/failures.ts'
import { parseKey } from '../protocol/keys.ts'
import { describeLocator, locatorProblem, locatorSteps } from '../protocol/locator.ts'
import { selectCommandProblem } from '../protocol/option-choices.ts'
import { isPlainObject, parse } from '../protocol/schema.ts'
import { scrollProblem } from '../protocol/scroll-delta.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { originOf } from '../protocol/url.ts'
import { bounded } from '../runner/bounded.ts'
import { timerMs } from '../runner/timer.ts'
import { checkIdentity, recordedCheck, runPageCheck } from './checks.ts'
import { hasElementIdentity, keepsPlace } from './identity.ts'
import { changedMatches, describeElementRef, elementRecipe, isElementRef, sameMatches, SessionLooks } from './looks.ts'
import { durableRecipeProblem, keyedRecipeProblem, oneReadRecipeProblem } from './recipes.ts'

// One agent session: an isolated browser context and its page, held for one owner on one named target and engine, with
// a lease through the same resources table and session budget a test attempt draws on. It takes the commands a test's
// page takes, through the same driver call, one action at a time; it reads looks as a test's parent serves them, each
// with the session's id; it saves and restores sign-in state, gives frames of its page and runs a host's required checks.
// Every text it hands back is redacted with every secret value the host has read. Its caller holds it through a lease
// that every call renews: a caller that goes silent for the whole lease loses the session, as a worker that died would.

/** Where an action goes: a durable recipe, or an element a current look listed. */
export type Locating = { readonly locator: LocatorRecipe; readonly ref?: undefined } | { readonly ref: ElementRef; readonly locator?: undefined }

/** Where an action that may go to the page's keyboard or viewport goes, when it names an element. */
export type Placing = Locating | { readonly locator?: undefined; readonly ref?: undefined }

/**
 * An action an agent sends: the commands a test's page takes, each with a durable `locator` or a look's `ref` where it
 * acts on an element. `fill` types text, or a secret the host holds, by name. Looks are `observe` and `observePage`.
 */
export type AgentCommand =
  | { readonly kind: 'goto'; readonly url: string }
  | { readonly kind: 'reload' | 'goBack' | 'goForward' }
  | ({ readonly kind: 'click' | 'hover' | 'check' | 'uncheck' } & Locating)
  | ({ readonly kind: 'fill'; readonly value: string | SecretRef } & Locating)
  | ({ readonly kind: 'select'; readonly choices: readonly OptionChoiceRecord[]; readonly multiple?: true } & Locating)
  | ({ readonly kind: 'press'; readonly key: string } & Placing)
  | ({ readonly kind: 'scroll'; readonly x: number; readonly y: number } & Placing)

/**
 * How an action went: the page's answer, redacted; how far its input got, as the driver counted it (`not_sent` for an
 * action refused before the page was asked); and the recipe it went to, when it acted on an element.
 */
export type AgentAction = { readonly result: CommandResult; readonly input: InputDispatch; readonly locator?: LocatorRecipe }

/** An element a look listed: its reference, and its text and visibility as the look saw them, redacted. */
export type LookedElement = { readonly ref: ElementRef; readonly text: string; readonly visible: boolean }

/**
 * A look at a locator's matches: its id and session, the locator, the observation as the page answered it, redacted,
 * one reference for each element it lists, and the page it read.
 */
export type AgentLook = {
  readonly sessionId: string
  readonly observationId: string
  readonly locator: LocatorRecipe
  readonly observation: Observation
  readonly elements: readonly LookedElement[]
  readonly page?: PageFacts
}

/** A look's answer: the look, or why there is none. */
export type AgentObserved = { readonly ok: true; readonly look: AgentLook } | { readonly ok: false; readonly failure: Failure }

/** A look at the page itself: its id and session, and the page's address and title, redacted. It lists no element. */
export type AgentPageLook = { readonly sessionId: string; readonly observationId: string; readonly url: string | null; readonly title: string | null }

export type AgentObservedPage = { readonly ok: true; readonly page: AgentPageLook } | { readonly ok: false; readonly failure: Failure }

/** A durable recipe made from a reference, or why a read could not prove it finds the referenced element. */
export type AgentRecipe = { readonly ok: true; readonly locator: LocatorRecipe; readonly described: string } | { readonly ok: false; readonly failure: Failure }

/** A required check as a session ran it: its identity, the session that ran it, the check as recorded, and what it saw. */
export type AgentCheck = CheckOutcome & { readonly identity: CheckIdentity; readonly sessionId: string; readonly app: string; readonly check: HostCheckRecord }

export type AgentChecked = { readonly ok: true; readonly check: AgentCheck } | { readonly ok: false; readonly failure: Failure }

/**
 * Sign-in state a session saved: the context's cookies and `localStorage`, the session it came from and when, and the
 * owner and app of that session, the only ones a host restores it for. It holds session cookies, so it is the host's to
 * keep, and no record of Retest's holds it.
 */
export type AgentState = { readonly storage: StorageState; readonly savedFrom: string; readonly savedAt: string; readonly owner: string; readonly app: string }

export type AgentSavedState = { readonly ok: true; readonly state: AgentState } | { readonly ok: false; readonly failure: Failure }

/** One frame of the page, as the driver encoded it, never decoded: a PNG, the session, and when it was taken. */
export type AgentFrame = { readonly bytes: Uint8Array; readonly format: 'png'; readonly sessionId: string; readonly capturedAt: string }

export type AgentFramed = { readonly ok: true; readonly frame: AgentFrame } | { readonly ok: false; readonly failure: Failure }

export type AgentFrameSource = { readonly ok: true; readonly source: FrameSource } | { readonly ok: false; readonly failure: Failure }

/**
 * Why a session ended: its holder ended it, it held its browser for its whole hold, its caller went silent for its whole
 * lease, its host stopped, or its browser was lost. `sessions` says when its budget's session came back: at once, or
 * only once its browser closed, as for a context that would not close.
 */
export type AgentEnding = {
  readonly kind: 'ended' | 'held_too_long' | 'caller_silent' | 'stopped' | 'lost'
  readonly reason?: Failure
  readonly sessions: 'returned' | 'held_until_browser_closed'
}

export type AgentEnded = { readonly ok: true; readonly ending: AgentEnding } | { readonly ok: false; readonly ending: AgentEnding; readonly failure: Failure }

/** A renewed lease: how long the session now waits to hear from its caller again. */
export type AgentRenewed = { readonly ok: true; readonly leaseMs: number } | { readonly ok: false; readonly failure: Failure }

/** Per-call options: a time shorter than the session's budget for the call. */
export type CallOptions = { readonly timeoutMs?: number }

/**
 * The budgets a session's calls take, in milliseconds. `hold` is the longest a session may stay open, and the most an
 * open request may ask for; `lease` is how long a session waits to hear from its caller before it ends.
 */
export type AgentTimeouts = {
  readonly setup: number
  readonly action: number
  readonly navigation: number
  readonly assertion: number
  readonly cleanup: number
  readonly hold: number
  readonly lease: number
}

/** What a session needs of the host that opened it. */
export type SessionHost = {
  readonly redactor: Redactor
  readonly secrets: SecretFiller | undefined
  readonly timeouts: AgentTimeouts
  readonly stopped: Promise<void>
  stopReason(): Failure | undefined
  /** Settles once the browser has gone, closed or lost. */
  browserGone(browser: OwnedBrowser): Promise<void>
  forget(session: AgentSession): void
}

/** What a session is opened with. */
export type SessionParts = {
  readonly host: SessionHost
  readonly identity: SessionIdentity
  readonly runtime: WebRuntimeIdentity
  readonly owner: string
  readonly target: string
  readonly engine: WebEngine
  readonly baseUrl: string | undefined
  readonly restoredFrom: string | undefined
  readonly holdMs: number
  readonly leaseMs: number
  /** The host's secrets this session may type, by name; undefined for every one the host holds. */
  readonly secrets: ReadonlySet<string> | undefined
  readonly browser: OwnedBrowser
  readonly page: OwnedPage
  readonly lease: ResourceLease
}

type Lane = 'act' | 'look'
type Running = { readonly lane: Lane; readonly stop: AbortController; readonly done: PromiseWithResolvers<void> }

// How long a command stopped by the session's end has to answer before the session closes its context anyway.
const answerGraceMs = 1000

// The commands an agent acts with; the two looks have calls of their own.
const actionKinds: ReadonlySet<string> = new Set(['goto', 'reload', 'goBack', 'goForward', 'fill', 'click', 'hover', 'press', 'select', 'check', 'uncheck', 'scroll'])
const navigationKinds: ReadonlySet<string> = new Set(['goto', 'reload', 'goBack', 'goForward'])
// The actions that may name an element, and so may take a reference in place of a locator.
const elementKinds: ReadonlySet<string> = new Set(['fill', 'click', 'hover', 'press', 'select', 'check', 'uncheck', 'scroll'])

// Stands in for a reference while the rest of a command is read against the page command schema.
const placeholderLocator: LocatorRecipe = { by: 'testId', value: 'reference' }

/**
 * An agent session, open from the moment its host hands it over until it ends. Every call is bounded by its budget,
 * by the call's own time and by what is left of the session's hold, and never throws for a page or application
 * problem: the answer carries the failure. An action needs the session to itself; looks, checks and saving state may
 * run beside each other but not beside an action, and a call that would overlap is refused before the page is asked.
 * Frames are taken beside anything, since they send no input. Every call, and `renew`, renews the caller's lease; a
 * session that hears nothing for its whole lease, with no call running, ends. Ending stops whatever runs (input not
 * yet sent is never sent, and input already sent is not taken back), closes the context within the cleanup budget and
 * gives the lease back; a context that would not close keeps its session from the budget until its browser closes.
 */
export class AgentSession {
  readonly identity: SessionIdentity
  /** The browser the session runs on, as its driver read it: its engine, product, version, executable and processes. */
  readonly runtime: WebRuntimeIdentity
  readonly owner: string
  readonly target: string
  readonly engine: WebEngine
  /** The session whose saved state this one started from, when it started from one. */
  readonly restoredFrom: string | undefined
  readonly #host: SessionHost
  readonly #browser: OwnedBrowser
  readonly #page: OwnedPage
  readonly #lease: ResourceLease
  readonly #baseUrl: string | undefined
  readonly #looks: SessionLooks
  readonly #identity: ElementIdentity | undefined
  readonly #secrets: ReadonlySet<string> | undefined
  readonly #leaseMs: number
  readonly #hold: Deadline
  readonly #running = new Set<Running>()
  readonly #sources = new Set<FrameSource>()
  readonly #listeners: (() => void)[] = []
  readonly #ended = Promise.withResolvers<AgentEnded>()
  #holdTimer: NodeJS.Timeout | undefined
  #leaseTimer: NodeJS.Timeout | undefined
  #ending: { kind: AgentEnding['kind']; reason?: Failure } | undefined
  #state: 'open' | 'ending' | 'ended' = 'open'
  #tokens = 0

  constructor(parts: SessionParts) {
    this.identity = parts.identity
    this.runtime = parts.runtime
    this.owner = parts.owner
    this.target = parts.target
    this.engine = parts.engine
    this.restoredFrom = parts.restoredFrom
    this.#host = parts.host
    this.#browser = parts.browser
    this.#page = parts.page
    this.#lease = parts.lease
    this.#baseUrl = parts.baseUrl
    this.#looks = new SessionLooks(parts.identity.sessionId)
    this.#identity = hasElementIdentity(parts.page) ? parts.page : undefined
    this.#secrets = parts.secrets === undefined ? undefined : new Set(parts.secrets)
    this.#leaseMs = parts.leaseMs
    this.#hold = new Deadline(Math.min(parts.holdMs, maxTimeout))
    this.#listeners.push(
      parts.page.onNavigation((navigation) => {
        if (navigation.document === 'new') this.#looks.nextDocument()
      }),
      parts.browser.onDisconnect((reason) => void this.#finish({ kind: 'lost', reason: failure('session_lost', `The browser of session ${parts.identity.sessionId} was lost: ${reason}`) })),
    )
    this.#holdTimer = setTimeout(() => {
      const reason = failure('timeout', `Session ${parts.identity.sessionId} held its browser for its whole ${parts.holdMs} ms hold, so Retest ended it.`)
      void this.#finish({ kind: 'held_too_long', reason: { ...reason, details: { holdMs: parts.holdMs } } })
    }, timerMs(parts.holdMs))
    this.#renewLease()
  }

  /** The session's id, which every look, reference and frame it serves carries. */
  get sessionId(): string {
    return this.identity.sessionId
  }

  /** The app the session plays, as its host named it. */
  get app(): string {
    return this.identity.owner.app
  }

  /** What the session is for, as its host named it, such as discovery or reproduction. */
  get purpose(): string {
    return this.identity.owner.testId
  }

  get state(): 'open' | 'ending' | 'ended' {
    return this.#state
  }

  /** Why the session ended, once it is ending. */
  get ending(): { readonly kind: AgentEnding['kind']; readonly reason?: Failure } | undefined {
    return this.#ending
  }

  /** Settles once the session has ended, however it ended. */
  get ended(): Promise<AgentEnded> {
    return this.#ended.promise
  }

  /**
   * Whether the session's driver holds one element from a look to an action and compares two elements. Without it, a
   * reference acts only when its look listed that one element, through the look's own locator, and a recipe is the
   * look's own locator. Chromium's driver does; Firefox's and WebKit's do not yet.
   */
  get pinsElements(): boolean {
    return this.#identity !== undefined
  }

  /** How long the session waits to hear from its caller before it ends. */
  get leaseMs(): number {
    return this.#leaseMs
  }

  /** Tells the session its caller is still there, as every call does, and sends nothing to the page. */
  renew(): AgentRenewed {
    const refusal = this.#refusal()
    if (refusal !== undefined) return { ok: false, failure: this.#host.redactor.redactFailure(refusal) }
    this.#renewLease()
    return { ok: true, leaseMs: this.#leaseMs }
  }

  /** Reads a locator's matches once, and hands out a reference for each element listed. */
  observe(locator: LocatorRecipe, options: CallOptions = {}): Promise<AgentObserved> {
    return this.#inLane<AgentObserved>('look', (problem) => ({ ok: false, failure: problem }), async (signal) => {
      const problem = this.#locatorProblem(locator)
      if (problem !== undefined) return { ok: false, failure: problem }
      const timeoutMs = this.#budget(this.#host.timeouts.action, options)
      const startedOn = this.#looks.generation
      const read = await this.#readOne(locator, timeoutMs, signal)
      if (!read.ok) return read
      // The look keeps a copy of the locator, so a caller that changes its own object later cannot move a reference.
      const look = this.#looks.serve(structuredClone(locator), read.observation, startedOn, read.keys)
      const observation = this.#host.redactor.redactObservation(look.observation)
      const elements = observation.items.map((item, element) => ({ ref: { sessionId: this.sessionId, observationId: look.observationId, element }, text: item.text, visible: item.visible }))
      const page = read.page === undefined ? {} : { page: this.#redactedPage(read.page) }
      return { ok: true, look: { sessionId: this.sessionId, observationId: look.observationId, locator: structuredClone(look.locator), observation, elements, ...page } }
    })
  }

  /** Reads the page's address and title once. */
  observePage(options: CallOptions = {}): Promise<AgentObservedPage> {
    return this.#inLane<AgentObservedPage>('look', (problem) => ({ ok: false, failure: problem }), async (signal) => {
      const answer = await this.#call({ kind: 'observePage' }, this.#budget(this.#host.timeouts.action, options), signal)
      if (!answer.result.ok) return { ok: false, failure: this.#host.redactor.redactFailure(answer.result.failure) }
      if (answer.result.kind !== 'observePage') return { ok: false, failure: failure('test_error', 'The page answered a look at the page with another kind of answer.') }
      const { url, title } = this.#host.redactor.redactPageLook(answer.result.observation)
      return { ok: true, page: { sessionId: this.sessionId, observationId: this.#looks.servePage(), url, title } }
    })
  }

  /**
   * Sends one action. An element is a durable `locator`, or a `ref` from a current look of this session, which is first
   * read again: a reference of another session, of a look this session no longer keeps, from an earlier document, or
   * whose look no longer matches the page is refused, and nothing is sent. On a driver that pins elements the action
   * goes only to the node the look listed; on one that cannot, a reference acts only when its look listed that one
   * element, through the look's own locator, and one of several elements or a place is refused by name.
   */
  act(command: AgentCommand, options: CallOptions = {}): Promise<AgentAction> {
    return this.#inLane<AgentAction>('act', (problem) => ({ result: { ok: false, failure: problem }, input: 'not_sent' }), async (signal) => {
      const read = readCommand(command)
      if (!read.ok) return notSent(read.failure)
      const budget = navigationKinds.has(read.command.kind) ? this.#host.timeouts.navigation : this.#host.timeouts.action
      const deadline = new Deadline(this.#budget(budget, options))
      let pageCommand = read.command
      let pin: string | undefined
      if (read.ref !== undefined) {
        const target = await this.#target(read.ref, deadline, signal)
        if (!target.ok) return notSent(target.failure)
        pageCommand = withLocator(read.command, target.locator)
        pin = target.key
      }
      const problem = commandProblem(pageCommand) ?? ('locator' in pageCommand && pageCommand.locator !== undefined ? this.#secretLocatorProblem(pageCommand.locator) : undefined)
      if (problem !== undefined) return notSent(problem)
      const located = 'locator' in pageCommand && pageCommand.locator !== undefined ? { locator: pageCommand.locator } : {}
      const browserCommand = await this.#browserCommand(pageCommand, deadline, signal)
      if (!browserCommand.ok) return { ...notSent(browserCommand.failure), ...located }
      const answer = pin === undefined ? await this.#call(browserCommand.command, deadline.commandTimeoutMs, signal) : await this.#callPinned(browserCommand.command, pin, deadline.commandTimeoutMs, signal)
      return { result: this.#host.redactor.redactCommandResult(answer.result), input: answer.input, ...located }
    })
  }

  /**
   * Turns a reference into a durable recipe only when a read proves the recipe finds the referenced element itself,
   * never because it finds an element showing the same text. The recipe keeps no match by its place. On a driver that
   * keys elements, one read resolves the look's element at its place and the recipe, and the two must be one node. On a
   * driver that cannot, the recipe must be the look's own locator and that read must find exactly one element; any
   * other recipe is refused by name. The reference must be current, as for an action. Sends no input.
   */
  recipe(ref: ElementRef, locator: LocatorRecipe, options: CallOptions = {}): Promise<AgentRecipe> {
    return this.#inLane<AgentRecipe>('look', (problem) => ({ ok: false, failure: problem }), async (signal) => {
      const problem = durableRecipeProblem(locator) ?? this.#secretLocatorProblem(locator)
      if (problem !== undefined) return { ok: false, failure: problem }
      const deadline = new Deadline(this.#budget(this.#host.timeouts.action, options))
      const resolved = this.#looks.resolve(ref)
      if (!resolved.ok) return resolved
      const { look, element } = resolved
      // The reference as it was resolved, so a caller that changes its own object meanwhile changes nothing here.
      const named: ElementRef = { sessionId: this.sessionId, observationId: look.observationId, element }
      const proven = look.keys === undefined ? await this.#oneReadRecipe(named, look, element, locator, deadline, signal) : await this.#keyedRecipe(named, look, element, locator, deadline, signal)
      if (proven !== undefined) return { ok: false, failure: this.#host.redactor.redactFailure(proven) }
      return { ok: true, locator: structuredClone(locator), described: describeLocator(locator) }
    })
  }

  /**
   * Runs one of the host's required checks against this session's page with the runner's own host check, looking again
   * until it passes or its time, the assertion budget by default, runs out. Its identity is the one the runner gives the
   * same check in a test held to `requirement`, the same in every session and attempt. A check that fails is a result,
   * not a refusal, in the runner's words.
   */
  check(check: HostCheck, requirement: Requirement, options: CallOptions = {}): Promise<AgentChecked> {
    return this.#inLane<AgentChecked>('look', (problem) => ({ ok: false, failure: problem }), async (signal) => {
      const identified = checkIdentity(check, requirement, this.app, this.#host.redactor)
      if (!identified.ok) return { ok: false, failure: this.#host.redactor.redactFailure(identified.failure) }
      const timeoutMs = this.#budget(check.timeoutMs ?? this.#host.timeouts.assertion, options)
      const stopped = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      const redact = (text: string): string => this.#host.redactor.redact(text)
      const browser = this.#browser
      const outcome = await runPageCheck(this.#page, check, { app: this.app, timeoutMs, redact, connected: () => browser.connected, stopped, stopReason: () => (signal.aborted ? abortReason(signal) : undefined) })
      const failed = outcome.failure === undefined ? {} : { failure: this.#host.redactor.redactFailure(outcome.failure) }
      return { ok: true, check: { ...outcome, ...failed, identity: identified.identity, sessionId: this.sessionId, app: this.app, check: recordedCheck(check, redact) } }
    })
  }

  /** Saves the context's cookies and `localStorage`, for the host to restore into another session it opens. */
  saveState(options: CallOptions = {}): Promise<AgentSavedState> {
    return this.#inLane<AgentSavedState>('look', (problem) => ({ ok: false, failure: problem }), async (signal) => {
      const timeoutMs = this.#budget(this.#host.timeouts.setup, options)
      const stopped = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
      const captured = await bounded(this.#page.captureState(timeoutMs), timerMs(timeoutMs + answerGraceMs), stopped)
      if (captured.status === 'done') return { ok: true, state: { storage: captured.value, savedFrom: this.sessionId, savedAt: new Date().toISOString(), owner: this.owner, app: this.app } }
      if (captured.status === 'stopped') return { ok: false, failure: abortReason(signal) }
      if (captured.status === 'timed_out') return { ok: false, failure: failure('timeout', `Session ${this.sessionId} did not hand over its sign-in state within ${timeoutMs} ms.`) }
      return { ok: false, failure: this.#host.redactor.redactFailure(thrownFailure(captured.error, `Session ${this.sessionId} could not read its sign-in state`)) }
    })
  }

  /** One frame of the page, a PNG exactly as the driver encoded it, taken beside any other call. Sends no input. */
  async frame(options: CallOptions = {}): Promise<AgentFramed> {
    const refusal = this.#refusal()
    if (refusal !== undefined) return { ok: false, failure: refusal }
    this.#renewLease()
    const timeoutMs = this.#budget(this.#host.timeouts.action, options)
    const shot = await bounded(this.#page.screenshot(timeoutMs), timerMs(timeoutMs + answerGraceMs))
    this.#renewLease()
    if (shot.status === 'done') return { ok: true, frame: { bytes: shot.value, format: 'png', sessionId: this.sessionId, capturedAt: new Date().toISOString() } }
    if (shot.status === 'failed') return { ok: false, failure: this.#host.redactor.redactFailure(thrownFailure(shot.error, `Session ${this.sessionId} could not capture its page`)) }
    return { ok: false, failure: failure('timeout', `Session ${this.sessionId} did not capture its page within ${timeoutMs} ms.`) }
  }

  /**
   * The driver's own live frame source of this page, for the media process: frames as the driver encoded them, each
   * with this session's identity. Refused by name on a driver that gives none. The session stops it as it ends.
   */
  frameSource(): AgentFrameSource {
    const refusal = this.#refusal()
    if (refusal !== undefined) return { ok: false, failure: refusal }
    this.#renewLease()
    const page = this.#page
    if (!hasFrameSource(page)) {
      return { ok: false, failure: { ...failure('unsupported', `The ${this.engine} driver gives no live frame source of a page. Take frames one at a time with frame().`), details: { engine: this.engine } } }
    }
    const { owner, sessionId } = this.identity
    const identity: RecordIdentity = { testId: owner.testId, attemptId: owner.attemptId, app: owner.app, sessionId }
    const source = page.frameSource(identity)
    const availability = source.availability()
    if (!availability.available) return { ok: false, failure: { ...failure('unsupported', availability.reason), details: { engine: this.engine } } }
    this.#sources.add(source)
    return { ok: true, source }
  }

  /** Ends the session: stops what runs, closes the context and gives the lease back. A second call waits for the first. */
  end(): Promise<AgentEnded> {
    return this.#finish({ kind: 'ended' })
  }

  /** Ends the session because its host stopped, with the host's reason. */
  stop(reason: Failure): Promise<AgentEnded> {
    return this.#finish({ kind: 'stopped', reason })
  }

  // Runs a call in its lane: refused when the session is not open, or when it would overlap what its lane may not.
  async #inLane<Answer>(lane: Lane, refuse: (problem: Failure) => Answer, work: (signal: AbortSignal) => Promise<Answer>): Promise<Answer> {
    const refusal = this.#refusal() ?? this.#overlap(lane)
    if (refusal !== undefined) return refuse(this.#host.redactor.redactFailure(refusal))
    const running: Running = { lane, stop: new AbortController(), done: Promise.withResolvers() }
    this.#running.add(running)
    this.#renewLease()
    try {
      return await work(running.stop.signal)
    } finally {
      this.#running.delete(running)
      running.done.resolve()
      // The caller is silent from the answer on, not from the moment it asked.
      this.#renewLease()
    }
  }

  #renewLease(): void {
    if (this.#state !== 'open') return
    clearTimeout(this.#leaseTimer)
    this.#leaseTimer = setTimeout(() => this.#leaseRanOut(), timerMs(this.#leaseMs))
  }

  // A call still running is a caller waiting for its answer, so the lease runs on from that answer.
  #leaseRanOut(): void {
    if (this.#running.size > 0) {
      this.#renewLease()
      return
    }
    const reason = failure('timeout', `Session ${this.sessionId} heard nothing from its caller for its whole ${this.#leaseMs} ms lease, so Retest ended it.`)
    void this.#finish({ kind: 'caller_silent', reason: { ...reason, details: { leaseMs: this.#leaseMs } } })
  }

  #refusal(): Failure | undefined {
    if (this.#state === 'open') return undefined
    const reason = this.#ending?.reason
    const said = reason === undefined ? '' : ` ${reason.message}`
    const kind = this.#ending?.kind
    const failureClass = kind === 'lost' ? 'session_lost' : kind === 'held_too_long' || kind === 'caller_silent' ? 'timeout' : kind === 'stopped' ? (reason?.class ?? 'interrupted') : 'usage'
    return { ...failure(failureClass, `Session ${this.sessionId} has ended, so Retest sent nothing to its page.${said}`), details: { sessionId: this.sessionId, ended: kind ?? 'ended' } }
  }

  // An action needs the session to itself; a look needs no action running.
  #overlap(lane: Lane): Failure | undefined {
    const busy = [...this.#running].find((running) => lane === 'act' || running.lane === 'act')
    if (busy === undefined) return undefined
    const asked = lane === 'act' ? 'an action' : 'a look'
    const running = busy.lane === 'act' ? 'an action' : 'a look'
    return failure('concurrent_commands', `Session ${this.sessionId} was asked for ${asked} while ${running} was still running there, so Retest sent nothing. A session takes one action at a time, and no look while an action runs.`)
  }

  #budget(budget: number, options: CallOptions): number {
    const own = options.timeoutMs !== undefined && Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? [options.timeoutMs] : []
    return Math.max(1, smallestBudget(budget, ...own, this.#hold.remainingMs))
  }

  // Where a reference's action goes. The reference is resolved against its look, then the look's locator is read again
  // on the same document. On a driver that keys elements, the node the look listed must still be at its place, and the
  // action is pinned to it. On one that cannot, the page must still list what the look saw, and the look must have
  // listed that one element through a locator that keeps no place, so the driver's strict match refuses rather than
  // acts on another element should the page change before the input goes.
  async #target(asked: ElementRef, deadline: Deadline, signal: AbortSignal): Promise<{ ok: true; locator: LocatorRecipe; key?: string } | { ok: false; failure: Failure }> {
    const resolved = this.#looks.resolve(asked)
    if (!resolved.ok) return resolved
    const { look, element } = resolved
    // The reference as it was resolved, so a caller that changes its own object meanwhile changes nothing here.
    const ref: ElementRef = { sessionId: this.sessionId, observationId: look.observationId, element }
    const key = look.keys?.[element]
    if (key !== undefined) {
      const read = await this.#readKeyed([look.locator], deadline.commandTimeoutMs, signal)
      if (!read.ok) return read
      if (this.#looks.generation !== look.generation) return { ok: false, failure: newDocument(ref) }
      const [fresh] = read.reads
      if (fresh === undefined) return { ok: false, failure: failure('test_error', 'The page answered a read of a locator with no read.') }
      if (fresh.keys[element] === key) return { ok: true, locator: elementRecipe(look.locator, element), key }
      // A list that changed says how; one that shows the same in another order can only say the element moved.
      return { ok: false, failure: sameMatches(look.observation, fresh.observation) ? this.#moved(ref, look, element) : this.#changed(ref, look, fresh.observation) }
    }
    const fresh = await this.#freshLook(ref, look, deadline, signal)
    if (!fresh.ok) return fresh
    if (look.observation.count !== 1 || keepsPlace(look.locator)) return { ok: false, failure: this.#unpinned(ref, look) }
    return { ok: true, locator: look.locator }
  }

  // Reads a look's locator again on a driver without keys: the page must be on the look's document and still list the
  // same matches, with the same text and visibility, in the same order. Returns what it read.
  async #freshLook(ref: ElementRef, look: ServedLook, deadline: Deadline, signal: AbortSignal): Promise<{ ok: true; observation: Observation } | { ok: false; failure: Failure }> {
    const answer = await this.#call({ kind: 'observe', locator: look.locator }, deadline.commandTimeoutMs, signal)
    if (!answer.result.ok) return { ok: false, failure: this.#host.redactor.redactFailure(answer.result.failure) }
    if (answer.result.kind !== 'observe') return { ok: false, failure: failure('test_error', 'The page answered a look with another kind of answer.') }
    if (this.#looks.generation !== look.generation) return { ok: false, failure: newDocument(ref) }
    if (!sameMatches(look.observation, answer.result.observation)) return { ok: false, failure: this.#changed(ref, look, answer.result.observation) }
    return { ok: true, observation: answer.result.observation }
  }

  #changed(ref: ElementRef, look: ServedLook, now: Observation): Failure {
    const message = `${describeElementRef(ref)} is stale: what ${look.observationId} saw of ${describeLocator(look.locator)} has changed (${changedMatches(look.observation, now)}). Look again.`
    return { ...failure('usage', this.#host.redactor.redact(message)), details: { refused: 'changed', ref: `${ref.observationId}.e${ref.element}`, sessionId: ref.sessionId } }
  }

  // A recipe on a driver without keys: the look is read again, as for an action, and that one read must prove it.
  async #oneReadRecipe(ref: ElementRef, look: ServedLook, element: number, locator: LocatorRecipe, deadline: Deadline, signal: AbortSignal): Promise<Failure | undefined> {
    const fresh = await this.#freshLook(ref, look, deadline, signal)
    if (!fresh.ok) return fresh.failure
    return oneReadRecipeProblem({ look, element, fresh: fresh.observation, locator, engine: this.engine })
  }

  // A recipe on a driver that keys elements: the look's locator and the recipe are read at once, and both must name the
  // node the look listed at the reference's place.
  async #keyedRecipe(ref: ElementRef, look: ServedLook, element: number, locator: LocatorRecipe, deadline: Deadline, signal: AbortSignal): Promise<Failure | undefined> {
    const read = await this.#readKeyed([look.locator, locator], deadline.commandTimeoutMs, signal)
    if (!read.ok) return read.failure
    if (this.#looks.generation !== look.generation) return newDocument(ref)
    const [lookRead, recipeRead] = read.reads
    if (lookRead === undefined || recipeRead === undefined) return failure('test_error', 'The page answered a read of two locators with fewer reads.')
    return keyedRecipeProblem({ look, element, lookRead, recipeRead, locator })
  }

  #moved(ref: ElementRef, look: ServedLook, element: number): Failure {
    const message = `${describeElementRef(ref)} is stale: the element ${look.observationId} listed at place ${element} of ${describeLocator(look.locator)} is no longer there. Look again.`
    return { ...failure('usage', this.#host.redactor.redact(message)), details: { refused: 'changed', ref: `${ref.observationId}.e${ref.element}`, sessionId: ref.sessionId } }
  }

  #unpinned(ref: ElementRef, look: ServedLook): Failure {
    const named = describeElementRef(ref)
    const locator = describeLocator(look.locator)
    const why = keepsPlace(look.locator)
      ? `${look.observationId} keeps a match of ${locator} by its place, and the ${this.engine} driver cannot hold one element from a look to an action, so another element could take that place before the input goes`
      : `${named} is one of ${look.observation.count} elements ${look.observationId} lists of ${locator}, and the ${this.engine} driver cannot hold one element from a look to an action, so the page could put another of them in its place before the input goes`
    const message = `${why}. Retest sent nothing. Look with a locator that finds only that element, with no first(), last() or nth(), or act with a durable locator.`
    return { ...failure('usage', this.#host.redactor.redact(message)), details: { refused: 'unpinned', ref: `${ref.observationId}.e${ref.element}`, sessionId: ref.sessionId, engine: this.engine } }
  }

  // One locator read: through the driver's keyed read where it has one, so the look keeps its elements' keys.
  async #readOne(locator: LocatorRecipe, timeoutMs: number, signal: AbortSignal): Promise<{ ok: true; observation: Observation; keys?: readonly string[]; page?: PageFacts } | { ok: false; failure: Failure }> {
    if (this.#identity !== undefined) {
      const read = await this.#readKeyed([locator], timeoutMs, signal)
      if (!read.ok) return read
      const [only] = read.reads
      if (only === undefined) return { ok: false, failure: failure('test_error', 'The page answered a read of a locator with no read.') }
      return { ok: true, observation: only.observation, keys: only.keys, ...(read.page === undefined ? {} : { page: read.page }) }
    }
    const answer = await this.#call({ kind: 'observe', locator }, timeoutMs, signal)
    if (!answer.result.ok) return { ok: false, failure: this.#host.redactor.redactFailure(answer.result.failure) }
    if (answer.result.kind !== 'observe') return { ok: false, failure: failure('test_error', 'The page answered a look with another kind of answer.') }
    return { ok: true, observation: answer.result.observation, ...(answer.result.page === undefined ? {} : { page: answer.result.page }) }
  }

  // The driver's keyed read, with a throw read as a lost page and an answer that does not key every element it lists
  // refused, since a key missing is an element no one could tell from another.
  async #readKeyed(locators: readonly LocatorRecipe[], timeoutMs: number, signal: AbortSignal): Promise<{ ok: true; reads: readonly KeyedRead[]; page?: PageFacts } | { ok: false; failure: Failure }> {
    const identity = this.#identity
    if (identity === undefined) return { ok: false, failure: failure('unsupported', `The ${this.engine} driver gives no keys for elements.`) }
    try {
      const reading = await identity.readElements(locators, timeoutMs, signal)
      if (!reading.ok) return { ok: false, failure: this.#host.redactor.redactFailure(reading.failure) }
      const whole = reading.reads.length === locators.length && reading.reads.every((read) => read.keys.length === read.observation.items.length)
      if (!whole) return { ok: false, failure: failure('test_error', 'The page answered a keyed read without a key for every element it listed.') }
      return { ok: true, reads: reading.reads, ...(reading.page === undefined ? {} : { page: reading.page }) }
    } catch (error) {
      return { ok: false, failure: failure('session_lost', `The browser call for a keyed read failed: ${errorMessage(error)}`) }
    }
  }

  // A fill of a secret is checked against the page's origin and read only then, through the host's secrets.
  async #browserCommand(command: PageCommand, deadline: Deadline, signal: AbortSignal): Promise<{ ok: true; command: BrowserCommand } | { ok: false; failure: Failure }> {
    if (command.kind === 'swipe' || command.kind === 'nativeKeyboard' || command.kind === 'nativeAlert' || command.kind === 'tap' || command.kind === 'observe' || command.kind === 'observePage') {
      return { ok: false, failure: failure('unsupported', `An agent session does not send ${describeCommand(command)}.`) }
    }
    if (command.kind !== 'fill') return { ok: true, command }
    const { locator, value } = command
    if (typeof value === 'string') return { ok: true, command: { kind: 'fill', locator, value } }
    const secrets = this.#host.secrets
    if (secrets === undefined) return { ok: false, failure: failure('usage', `secret(${JSON.stringify(value.secret)}) needs a host that holds secrets. This agent host holds none.`) }
    const allowed = this.#secrets
    if (allowed !== undefined && !allowed.has(value.secret)) {
      const named = allowed.size === 0 ? 'no secret' : `only ${[...allowed].map((name) => JSON.stringify(name)).join(', ')}`
      return { ok: false, failure: { ...failure('usage', `Session ${this.sessionId} may type ${named}, so Retest did not type secret(${JSON.stringify(value.secret)}) and read nothing.`), details: { refused: 'secret-not-allowed' } } }
    }
    const appOrigins = this.#baseUrl === undefined ? [] : [originOf(this.#baseUrl)].filter((origin): origin is string => origin !== undefined)
    const resolved = await secrets.resolve({ kind: 'fill', locator, value: { secret: value.secret } }, { pageUrl: this.#page.url, appOrigins, timeoutMs: deadline.commandTimeoutMs, signal })
    return resolved.ok ? { ok: true, command: resolved.command } : { ok: false, failure: this.#host.redactor.redactFailure(resolved.failure) }
  }

  // The driver's call, with how far its input got where the driver says, and a throw read as the page's answer.
  async #call(command: BrowserCommand, timeoutMs: number, signal: AbortSignal): Promise<DispatchedCommand> {
    const page = this.#page
    this.#tokens += 1
    const token = this.#tokens
    try {
      if (hasDispatch(page)) return await page.dispatch(command, timeoutMs, signal, token)
      const result = await page.execute(command, timeoutMs, signal, token)
      return { result, input: inputOf(command, result) }
    } catch (error) {
      const looking = command.kind === 'observe' || command.kind === 'observePage'
      const message = `The browser call for ${describeCommand(command)} failed: ${errorMessage(error)}`
      return { result: { ok: false, failure: failure(looking ? 'session_lost' : 'outcome_unknown', message) }, input: looking ? 'not_sent' : 'unknown' }
    }
  }

  // The driver's pinned call, with a throw read as the page's answer as for any other call.
  async #callPinned(command: BrowserCommand, key: string, timeoutMs: number, signal: AbortSignal): Promise<DispatchedCommand> {
    const identity = this.#identity
    if (identity === undefined) return { result: { ok: false, failure: failure('unsupported', `The ${this.engine} driver cannot pin an element.`) }, input: 'not_sent' }
    this.#tokens += 1
    try {
      return await identity.dispatchTo(command, key, timeoutMs, signal, this.#tokens)
    } catch (error) {
      return { result: { ok: false, failure: failure('outcome_unknown', `The browser call for ${describeCommand(command)} failed: ${errorMessage(error)}`) }, input: 'unknown' }
    }
  }

  #locatorProblem(locator: LocatorRecipe): Failure | undefined {
    return locatorProblem(locator) ?? this.#secretLocatorProblem(locator)
  }

  // A locator holding a whole value the host has read could find where a page shows it, so it never reaches the page.
  #secretLocatorProblem(locator: LocatorRecipe): Failure | undefined {
    const held = matchedTexts(locator).find((matched) => this.#host.redactor.holdsValue(matched.text, matched.exact))
    if (held === undefined) return undefined
    return failure('usage', `Retest did not send this to the page: the locator's ${held.named} holds the value of a secret. Find the element by its test id, or by text that holds no secret.`)
  }

  #redactedPage(page: PageFacts): PageFacts {
    const url = this.#host.redactor.redact(page.url)
    const title = page.title === undefined ? undefined : this.#host.redactor.redactTitle(page.title)
    return title === undefined ? { url } : { url, title }
  }

  async #finish(ending: { kind: AgentEnding['kind']; reason?: Failure }): Promise<AgentEnded> {
    if (this.#ending !== undefined) return this.#ended.promise
    this.#ending = ending
    this.#state = 'ending'
    clearTimeout(this.#holdTimer)
    clearTimeout(this.#leaseTimer)
    const reason = ending.reason ?? failure('interrupted', `Session ${this.sessionId} ended.`)
    for (const running of this.#running) running.stop.abort(reason)
    const { cleanup } = this.#host.timeouts
    const problems: string[] = []
    const stats = await bounded(Promise.all([...this.#sources].map((source) => source.stop(answerGraceMs))), timerMs(answerGraceMs * 2))
    if (stats.status !== 'done') problems.push(`A frame source of session ${this.sessionId} did not stop within ${answerGraceMs} ms.`)
    await bounded(Promise.all([...this.#running].map((running) => running.done.promise)), answerGraceMs)
    for (const stop of this.#listeners) stop()
    const lost = ending.kind === 'lost' || !this.#browser.connected
    const disposed = lost ? undefined : await bounded(this.#page.dispose(cleanup), timerMs(cleanup + answerGraceMs))
    const closed = lost || disposed?.status === 'done'
    if (!closed) {
      const why = disposed?.status === 'failed' ? `failed: ${errorMessage(disposed.error)}` : `did not finish within the ${cleanup} ms cleanup budget`
      problems.push(`Closing the browser context of session ${this.sessionId} ${why}, so its session stays counted until its browser closes.`)
    }
    let returned = true
    await this.#lease.release({
      whenFree: () => undefined,
      giveBackSessions: (sessions: SessionLease) => {
        if (closed) {
          sessions.release()
          return true
        }
        returned = false
        void this.#host.browserGone(this.#browser).then(() => sessions.release())
        return false
      },
      ending: false,
    })
    this.#state = 'ended'
    this.#host.forget(this)
    const record: AgentEnding = { kind: ending.kind, ...(ending.reason === undefined ? {} : { reason: this.#host.redactor.redactFailure(ending.reason) }), sessions: returned ? 'returned' : 'held_until_browser_closed' }
    const answer: AgentEnded = problems.length === 0 ? { ok: true, ending: record } : { ok: false, ending: record, failure: failure('cleanup_failed', this.#host.redactor.redact(problems.join(' '))) }
    this.#ended.resolve(answer)
    return answer
  }
}

/**
 * Reads an action as an agent sent it, from JSON as much as from code: one of the commands a test's page takes, with a
 * durable `locator` or a look's `ref` where it acts on an element, never both. The rest is read against the page
 * command schema, so an action an agent sends is a command a test could send.
 *
 * @example readCommand({ kind: 'click', ref: { sessionId: 'a:b', observationId: 'o1', element: 0 } }).ok // true
 */
export function readCommand(value: unknown): { ok: true; command: PageCommand; ref?: ElementRef } | { ok: false; failure: Failure } {
  if (!isPlainObject(value)) return { ok: false, failure: failure('usage', 'An action is an object with a kind, such as { kind: "click", locator }.') }
  const { ref, ...rest } = value
  const kind = rest['kind']
  if (typeof kind !== 'string' || !actionKinds.has(kind)) {
    return { ok: false, failure: failure('usage', `An agent acts with ${[...actionKinds].join(', ')}, and looks with observe() and observePage(), received kind ${JSON.stringify(kind)}.`) }
  }
  if (ref !== undefined && !elementKinds.has(kind)) return { ok: false, failure: failure('usage', `${kind} acts on no element, so it takes no reference.`) }
  if (ref !== undefined && rest['locator'] !== undefined) return { ok: false, failure: failure('usage', 'An action names its element by a locator or by a reference, not both.') }
  if (ref !== undefined && !isElementRef(ref)) return { ok: false, failure: failure('usage', 'An element reference is { sessionId, observationId, element }, as a look hands it out.') }
  const parsed = parse(pageCommandSchema, ref === undefined ? rest : { ...rest, locator: placeholderLocator })
  if (!parsed.ok) return { ok: false, failure: failure('usage', `The action is not one Retest can send: ${parsed.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}.`) }
  return ref === undefined ? { ok: true, command: parsed.value } : { ok: true, command: parsed.value, ref }
}

/**
 * The same command sent to another element: the recipe a reference resolved to, in place of the stand-in it was read
 * with. A command that acts on no element is left as it is.
 *
 * @example withLocator({ kind: 'click', locator: stand-in }, { by: 'role', role: 'button', pick: 1 }).kind // 'click'
 */
export function withLocator(command: PageCommand, locator: LocatorRecipe): PageCommand {
  switch (command.kind) {
    case 'fill':
    case 'click':
    case 'tap':
    case 'hover':
    case 'select':
    case 'check':
    case 'uncheck':
    case 'press':
    case 'scroll':
    case 'swipe':
    case 'observe':
      return { ...command, locator }
    default:
      return command
  }
}

// What the test process's own checks refuse, which a session refuses before the page sees the command.
function commandProblem(command: PageCommand): Failure | undefined {
  const located = 'locator' in command && command.locator !== undefined ? locatorProblem(command.locator) : undefined
  if (located !== undefined) return located
  if (command.kind === 'press') {
    const parsed = parseKey(command.key)
    return parsed.ok ? undefined : parsed.failure
  }
  if (command.kind === 'select') return selectCommandProblem(command)
  if (command.kind === 'scroll') return scrollProblem(command)
  return undefined
}

type MatchedText = { text: string; exact: boolean; named: 'text' | 'name' | 'pattern' | 'selector' }

// What each step of a locator matches against the page, as the runner reads it for the same guard.
function matchedTexts(locator: LocatorRecipe): MatchedText[] {
  return locatorSteps(locator).flatMap((step: LocatorStep): MatchedText[] => {
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

function notSent(problem: Failure): AgentAction {
  return { result: { ok: false, failure: problem }, input: 'not_sent' }
}

function newDocument(ref: unknown): Failure {
  const named = isElementRef(ref) ? describeElementRef(ref) : 'The reference'
  return { ...failure('usage', `${named} is stale: the page opened another document while Retest read it. Look again.`), details: { refused: 'new-document' } }
}

function abortReason(signal: AbortSignal): Failure {
  const parsed = parse(failureSchema, signal.reason)
  return parsed.ok ? parsed.value : failure('interrupted', 'The session stopped the call.')
}

function thrownFailure(error: unknown, what: string): Failure {
  const reported = error instanceof Error && 'failure' in error ? parse(failureSchema, error.failure) : undefined
  return reported?.ok === true ? reported.value : failure('session_lost', `${what}: ${errorMessage(error)}`)
}

// A driver that says how far each command's input got; Retest's Chromium, Firefox and WebKit pages all do.
function hasDispatch(page: OwnedPage): page is WebSession {
  return 'dispatch' in page && typeof page.dispatch === 'function'
}

function hasFrameSource(page: OwnedPage): page is WebSession & { frameSource(identity: RecordIdentity): FrameSource } {
  return 'frameSource' in page && typeof page.frameSource === 'function'
}

// How far a command's input got on a page that does not say: what its answer shows, and unknown where it shows nothing.
function inputOf(command: BrowserCommand, result: CommandResult): InputDispatch {
  if (command.kind === 'observe' || command.kind === 'observePage') return 'not_sent'
  if (result.ok) return 'sent'
  const sent = result.failure.details?.['inputSent']
  if (typeof sent === 'boolean') return sent ? 'sent' : 'not_sent'
  if (['not_found', 'ambiguous', 'usage', 'unsupported', 'not_actionable', 'session_lost'].includes(result.failure.class)) return 'not_sent'
  return 'unknown'
}
