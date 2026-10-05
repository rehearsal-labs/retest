import type { NewPageOptions, OwnedBrowser, OwnedPage, SessionIdentity, WebEngine } from '../browser/contract.ts'
import type { LoadedSecret } from '../config/loaded.ts'
import type { Failure } from '../protocol/failures.ts'
import type { ResolvedSecret } from '../runner/contract.ts'
import type { ResourceLease, ResourceNeed } from '../runner/resources.ts'
import type { SessionLease } from '../runner/sessions.ts'
import type { AgentLaunchers, AgentTarget } from './targets.ts'
import type { AgentState, AgentTimeouts, SessionHost } from './session.ts'
import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { LaunchError } from '../browser/contract.ts'
import { formatSessionId } from '../protocol/evidence.ts'
import { errorMessage, failure, failureSchema } from '../protocol/failures.ts'
import { isName } from '../protocol/names.ts'
import { describeValue, isPlainObject, parse } from '../protocol/schema.ts'
import { storageStateSchema } from '../protocol/storage-state.ts'
import { maxTimeout } from '../protocol/timeouts.ts'
import { isWebUrl, readOrigin } from '../protocol/url.ts'
import { newAttemptId } from '../runner/attempt-id.ts'
import { bounded } from '../runner/bounded.ts'
import { SharedLocks } from '../runner/locks.ts'
import { Redactor } from '../runner/redactor.ts'
import { acquireResources, compareNeeds, hostResources } from '../runner/resources.ts'
import { SecretFiller, secretValuesProblem } from '../runner/secrets.ts'
import { SessionBudget } from '../runner/sessions.ts'
import { timerMs } from '../runner/timer.ts'
import { AgentSession } from './session.ts'
import { driverLaunchers, runtimeIdentity, statedEngine } from './targets.ts'

// An agent host: what an agent's sessions open in, as a run is what a test's attempts open in. It names the targets its
// sessions may run on, launches each target's browser once with that engine's own driver and opens every session in a
// new context of it, draws every session from the host's session budget, the same `SessionBudget` a test run draws
// on, through the same resources table, and holds the secrets its sessions may type. It never runs one engine in
// another's place. Opening never throws and never leaves anything held: whatever goes wrong after a session was granted
// gives the grant back, once. A browser that starts after the host stopped waiting for it is closed as it arrives, and
// a lost browser is closed a moment after its loss, through its own driver's close.

/** Secrets a host holds for its sessions to type: each value or source by name, and the origins beyond a session's base URL where each may go. */
export type AgentSecrets = { readonly values: Readonly<Record<string, ResolvedSecret>>; readonly origins?: Readonly<Record<string, readonly string[]>> }

/**
 * How an agent host is made. `targets` are the browsers its sessions may run on, by name. `budget` is the session budget
 * its sessions count against, shared with any test run given the same one. `logFolder` is the absolute folder each
 * browser's output goes to. `launchers` replace an engine's own driver launcher, as a test of Retest does. Budgets left
 * out take `defaultAgentTimeouts`; `timeouts.hold` is also the most any open request may ask for, and `timeouts.lease`
 * how long a session waits to hear from its caller. `hiddenVariables` are environment variables no browser may see.
 */
export type AgentHostOptions = {
  readonly targets: Readonly<Record<string, AgentTarget>>
  readonly budget: SessionBudget
  readonly logFolder: string
  readonly timeouts?: Partial<AgentTimeouts>
  readonly launchers?: AgentLaunchers
  readonly secrets?: AgentSecrets
  readonly hiddenVariables?: readonly string[]
}

/**
 * What a session is opened with. `owner` is whose sessions the budget counts it against, as the caller vouches for it.
 * `app` is the part it plays and `purpose` what it is for, such as discovery or reproduction; both are names. It runs on
 * the host's `target`, which must run on `engine`. `state` is sign-in state a session of the same owner and app saved,
 * restored before the page loads anything; without it the context starts empty. `baseUrl` resolves relative addresses.
 * `locks` are named locks it holds while it is open. `secrets` names the host's secrets it may type; without it, every
 * one the host holds. `holdMs` is the longest it may stay open, at most the host's hold, and `waitMs` how long it waits
 * for a session from the budget, the setup budget by default.
 */
export type AgentOpenRequest = {
  readonly owner: string
  readonly app: string
  readonly purpose: string
  readonly target: string
  readonly engine: WebEngine
  readonly baseUrl?: string
  readonly viewport?: { readonly width: number; readonly height: number }
  readonly state?: AgentState
  readonly locks?: readonly string[]
  readonly secrets?: readonly string[]
  readonly holdMs?: number
  readonly waitMs?: number
}

export type AgentOpened = { readonly ok: true; readonly session: AgentSession } | { readonly ok: false; readonly failure: Failure }

export type AgentHostClosed = { readonly ok: true } | { readonly ok: false; readonly failure: Failure }

/**
 * The budgets an agent host gives its sessions' calls, the longest a session may stay open, and how long a session
 * waits to hear from its caller.
 */
export const defaultAgentTimeouts: Readonly<AgentTimeouts> = Object.freeze({ setup: 60_000, action: 10_000, navigation: 30_000, assertion: 5_000, cleanup: 10_000, hold: 600_000, lease: 60_000 })

/**
 * How long a host waits after a browser is lost before it closes it: long enough for the processes the browser started
 * to go on their own, so its driver's close reaps only what is left and removes its profile.
 */
export const lostBrowserGraceMs = 2000

/** Thrown when an agent host is made with options it cannot use. `failure` says each problem. */
export class AgentHostError extends Error {
  override readonly name = 'AgentHostError'
  readonly failure: Failure

  constructor(failure: Failure) {
    super(failure.message)
    this.failure = failure
  }
}

type Launched = { readonly ok: true; readonly browser: OwnedBrowser } | { readonly ok: false; readonly failure: Failure }

// An open that was granted its session: what it asked for, the session's names, and the grant to give back.
type Granted = { readonly request: AgentOpenRequest; readonly target: AgentTarget; readonly attemptId: string; readonly sessionId: string; readonly lease: ResourceLease }

// An open that failed after its grant, and when nothing it opened can still be holding the session.
type Unopened = { readonly ok: false; readonly failure: Failure; readonly free?: Promise<void> }

// How long a call stopped by its own bound has to answer before Retest stops waiting for it.
const graceMs = 1000

const openKeys: ReadonlySet<string> = new Set(['owner', 'app', 'purpose', 'target', 'engine', 'baseUrl', 'viewport', 'state', 'locks', 'secrets', 'holdMs', 'waitMs'])
const engines: readonly WebEngine[] = ['chromium', 'firefox', 'webkit']
// An owner is a label a host writes, held to what a report line can show, as a test run's owner is.
const longestOwner = 200

/**
 * An agent host. Sessions open through `open` and end through their own `end`. `stop` ends every session and refuses
 * new ones; `close` stops, then closes every browser the host launched, waiting a bounded time for any still starting.
 * A browser is launched for a target the first time a session asks for it and serves every later session of that
 * target in a context of its own; one that is lost is closed after `lostBrowserGraceMs` and launched afresh for the
 * next session that asks. A refusal for want of a session names only the holders of the asking owner, and counts the
 * rest.
 *
 * @example const host = new AgentHost({ targets: { chrome: { engine: 'chromium', executablePath } }, budget: new SessionBudget({ perOwner: 4, host: 8 }), logFolder })
 */
export class AgentHost {
  /** The host's id, the run its sessions belong to in the resources table. */
  readonly runId: string = randomUUID()
  readonly #targets: ReadonlyMap<string, AgentTarget>
  readonly #budget: SessionBudget
  readonly #logFolder: string
  readonly #timeouts: AgentTimeouts
  readonly #launchers: AgentLaunchers
  readonly #hidden: readonly string[]
  readonly #redactor = new Redactor()
  readonly #secrets: SecretFiller | undefined
  readonly #secretNames: ReadonlySet<string>
  readonly #locks = new SharedLocks()
  readonly #launches = new Map<string, Promise<Launched>>()
  readonly #gone = new Map<OwnedBrowser, Promise<void>>()
  // Every browser the host launched and has not closed, lost ones included until their grace runs out.
  readonly #launched = new Set<OwnedBrowser>()
  readonly #closings = new Set<Promise<string | undefined>>()
  // Browsers that started after the host stopped waiting for them, each closed as it arrives.
  readonly #late = new Set<Promise<string | undefined>>()
  readonly #lostTimers = new Set<NodeJS.Timeout>()
  // Each owner's place in the resources table, so a refusal names only the holders of the owner that asked.
  readonly #scopes = new Map<string, string>()
  readonly #sessions = new Set<AgentSession>()
  readonly #opening = new Set<Promise<unknown>>()
  readonly #stopped = Promise.withResolvers<void>()
  #stopReason: Failure | undefined
  #arrivals = 0
  #logs = 0
  #closing: Promise<AgentHostClosed> | undefined

  /** Throws an `AgentHostError` naming every problem with `options`. */
  constructor(options: AgentHostOptions) {
    const problem = hostOptionsProblem(options)
    if (problem !== undefined) throw new AgentHostError(problem)
    this.#targets = new Map(Object.entries(options.targets))
    this.#budget = options.budget
    this.#logFolder = options.logFolder
    this.#timeouts = { ...defaultAgentTimeouts, ...definedTimeouts(options.timeouts) }
    this.#launchers = options.launchers ?? {}
    this.#hidden = [...(options.hiddenVariables ?? [])]
    this.#secrets = options.secrets === undefined ? undefined : secretFiller(options.secrets, this.#redactor)
    this.#secretNames = new Set(Object.keys(options.secrets?.values ?? {}))
  }

  /** Every session open or ending now, in the order they opened. */
  sessions(): readonly AgentSession[] {
    return [...this.#sessions]
  }

  /**
   * Opens a session: waits for a session from the budget and the locks it asks for, all at once or not at all, then
   * opens a new context of its target's browser, launching it if no session has. Never throws and never rejects: a
   * refusal, a wait that ran out, a browser that would not start, a page that would not open and anything that went
   * wrong in Retest itself are each the answer's failure, and nothing is left held.
   */
  open(request: AgentOpenRequest): Promise<AgentOpened> {
    const opening = this.#open(request).catch((error: unknown): AgentOpened => ({ ok: false, failure: this.#redactor.redactFailure(failure('setup_failed', `Retest could not open the session: ${errorMessage(error)}`)) }))
    this.#opening.add(opening)
    void opening.then(() => this.#opening.delete(opening))
    return opening
  }

  /** Ends every session with `reason` and refuses new ones; waiting opens give up holding nothing. */
  stop(reason: Failure = failure('interrupted', 'The agent host was stopped.')): void {
    if (this.#stopReason !== undefined) return
    this.#stopReason = reason
    this.#stopped.resolve()
    for (const session of this.#sessions) void session.stop(reason)
  }

  /** Stops, waits for every session to end, then closes every browser the host launched, each within the cleanup budget. */
  close(): Promise<AgentHostClosed> {
    this.#closing ??= this.#close()
    return this.#closing
  }

  async #close(): Promise<AgentHostClosed> {
    this.stop(failure('interrupted', 'The agent host closed.'))
    const problems: string[] = []
    await Promise.allSettled([...this.#opening])
    const endings = await Promise.allSettled([...this.#sessions].map((session) => session.ended))
    for (const ended of endings) {
      if (ended.status === 'rejected') problems.push(`A session did not say how it ended: ${errorMessage(ended.reason)}`)
      else if (!ended.value.ok) problems.push(ended.value.failure.message)
    }
    await Promise.allSettled([...this.#launches.values()])
    // A browser still starting is waited for as long as its launch and its close may take, and no longer.
    const lateWithinMs = this.#timeouts.setup + this.#timeouts.cleanup + 2 * graceMs
    const late = await bounded(Promise.all([...this.#late]), timerMs(lateWithinMs))
    if (late.status === 'done') problems.push(...late.value.filter((problem): problem is string => problem !== undefined))
    else problems.push(`A browser was still starting when the host closed and did not arrive within ${lateWithinMs} ms. Retest closes it if it arrives.`)
    for (const browser of [...this.#launched]) this.#closeBrowser(browser)
    for (const timer of this.#lostTimers) clearTimeout(timer)
    this.#lostTimers.clear()
    for (const closed of await Promise.allSettled([...this.#closings])) {
      if (closed.status === 'rejected') problems.push(`Closing a browser failed: ${errorMessage(closed.reason)}`)
      else if (closed.value !== undefined) problems.push(closed.value)
    }
    return problems.length === 0 ? { ok: true } : { ok: false, failure: failure('cleanup_failed', this.#redactor.redact(problems.join(' '))) }
  }

  async #open(request: AgentOpenRequest): Promise<AgentOpened> {
    if (this.#stopReason !== undefined) return { ok: false, failure: this.#stopReason }
    const problem = openProblem(request, this.#targets) ?? this.#hostProblem(request)
    if (problem !== undefined) return { ok: false, failure: problem }
    const target = this.#targets.get(request.target)
    if (target === undefined) return { ok: false, failure: failure('usage', `The agent host has no target ${JSON.stringify(request.target)}.`) }
    const attemptId = newAttemptId()
    const sessionId = formatSessionId(attemptId, request.app)
    const { setup, cleanup } = this.#timeouts
    const counted: ResourceNeed = { kind: 'sessions', name: request.owner, key: request.owner, apps: [request.app], count: 1 }
    const needs = [...(request.locks ?? []).map((lock): ResourceNeed => ({ kind: 'lock', name: lock, key: lock, apps: [] })), counted].sort(compareNeeds)
    const grant = await acquireResources(
      {
        attemptId,
        holder: sessionId,
        scope: this.#scopeOf(request.owner),
        position: this.#arrivals++,
        needs,
        locks: this.#locks,
        resources: hostResources,
        sessions: { budget: this.#budget, owner: request.owner, waitMs: request.waitMs ?? setup },
        pastLeaseMs: setup,
        releaseWithinMs: cleanup,
      },
      this.#stopped.promise,
    )
    if (!grant.ok) return { ok: false, failure: grant.stopped ? (this.#stopReason ?? grant.failure) : this.#redactor.redactFailure(grant.failure) }
    const { lease } = grant
    // Every way past the grant ends here, so the grant goes back exactly once, whatever threw on the way.
    const outcome = await this.#openGranted({ request, target, attemptId, sessionId, lease }).catch(
      (error: unknown): Unopened => ({ ok: false, failure: failure('setup_failed', `Session ${sessionId} could not open: ${errorMessage(error)}`) }),
    )
    if (outcome.ok) return outcome
    await giveBack(lease, outcome.free)
    return { ok: false, failure: this.#redactor.redactFailure(outcome.failure) }
  }

  // Everything an open does once its session was granted. A failure says what, and `free` settles once nothing it
  // opened can still be holding the session; the caller gives the grant back.
  async #openGranted({ request, target, attemptId, sessionId, lease }: Granted): Promise<{ readonly ok: true; readonly session: AgentSession } | Unopened> {
    const { setup } = this.#timeouts
    if (this.#stopReason !== undefined) return { ok: false, failure: this.#stopReason }
    const launched = await this.#browser(request.target, target, setup)
    if (!launched.ok) return launched
    const { browser } = launched
    const runtime = runtimeIdentity(browser, target.engine)
    const identity: SessionIdentity = { sessionId, owner: { runId: this.runId, testId: request.purpose, attemptId, app: request.app }, runtime }
    const opened = await this.#page(browser, request, identity, setup)
    // A page that may still arrive keeps its session until it is closed or its browser goes.
    if (!opened.ok) return { ok: false, failure: opened.failure, ...(opened.late === undefined ? {} : { free: opened.late }) }
    let session: AgentSession
    try {
      session = new AgentSession({
        host: this.#sessionHost(),
        identity,
        runtime,
        owner: request.owner,
        target: request.target,
        engine: target.engine,
        baseUrl: request.baseUrl,
        restoredFrom: request.state?.savedFrom,
        holdMs: request.holdMs ?? this.#timeouts.hold,
        leaseMs: this.#timeouts.lease,
        secrets: request.secrets === undefined ? undefined : new Set(request.secrets),
        browser,
        page: opened.page,
        lease,
      })
    } catch (error) {
      const disposed = await bounded(disposing(opened.page, this.#timeouts.cleanup), timerMs(this.#timeouts.cleanup + graceMs))
      const free = disposed.status === 'done' ? undefined : this.#gone.get(browser)
      return { ok: false, failure: failure('setup_failed', `Session ${sessionId} could not start on its page: ${errorMessage(error)}`), ...(free === undefined ? {} : { free }) }
    }
    this.#sessions.add(session)
    // A host stopped while the page opened ends the session it just made.
    if (this.#stopReason !== undefined) void session.stop(this.#stopReason)
    return { ok: true, session }
  }

  // What the request asks that this host does not allow: a hold past its own, a secret it does not hold, or saved
  // state from a session of another owner or app.
  #hostProblem(request: AgentOpenRequest): Failure | undefined {
    const { hold } = this.#timeouts
    if (request.holdMs !== undefined && request.holdMs > hold) {
      return { ...failure('usage', `The open request: holdMs: this host keeps a session open at most ${hold} ms, its timeouts.hold, and the request asked for ${request.holdMs}.`), details: { refused: 'hold', holdMs: hold } }
    }
    const unknown = (request.secrets ?? []).filter((name) => !this.#secretNames.has(name))
    if (unknown.length > 0) return { ...failure('usage', `The open request: secrets: this host holds no secret ${unknown.map((name) => JSON.stringify(name)).join(', ')}.`), details: { refused: 'unknown-secret' } }
    const { state } = request
    if (state === undefined) return undefined
    const saved = `The state was saved by session ${state.savedFrom}, of ${JSON.stringify(state.owner)} as ${JSON.stringify(state.app)}`
    if (state.owner !== request.owner) return { ...failure('usage', `${saved}, and this session would be ${JSON.stringify(request.owner)}'s. Retest restores a state only into a session of the owner and app that saved it.`), details: { refused: 'other-owner' } }
    if (state.app !== request.app) return { ...failure('usage', `${saved}, and this session would be ${JSON.stringify(request.app)}. Retest restores a state only into a session of the owner and app that saved it.`), details: { refused: 'other-app' } }
    return undefined
  }

  #scopeOf(owner: string): string {
    const known = this.#scopes.get(owner)
    if (known !== undefined) return known
    const scope = `${this.runId}/${randomUUID()}`
    this.#scopes.set(owner, scope)
    return scope
  }

  #sessionHost(): SessionHost {
    return {
      redactor: this.#redactor,
      secrets: this.#secrets,
      timeouts: this.#timeouts,
      stopped: this.#stopped.promise,
      stopReason: () => this.#stopReason,
      browserGone: (browser) => this.#gone.get(browser) ?? Promise.resolve(),
      forget: (session) => this.#sessions.delete(session),
    }
  }

  // The target's browser: the one already launched while it is connected, otherwise a new launch shared by every
  // session that asks meanwhile. A launch that fails is not kept, so the next session's request tries again.
  async #browser(name: string, target: AgentTarget, timeoutMs: number): Promise<Launched> {
    const known = this.#launches.get(name)
    if (known !== undefined) {
      const launched = await known
      if (launched.ok && launched.browser.connected) return launched
      if (this.#launches.get(name) === known) this.#launches.delete(name)
      if (!launched.ok) return launched
      return this.#browser(name, target, timeoutMs)
    }
    const launching = this.#launch(name, target, timeoutMs)
    this.#launches.set(name, launching)
    const launched = await launching
    if (!launched.ok && this.#launches.get(name) === launching) this.#launches.delete(name)
    return launched
  }

  // Never rejects: a launcher that throws, at once or later, is a launch that failed.
  async #launch(name: string, target: AgentTarget, timeoutMs: number): Promise<Launched> {
    const { engine } = target
    const launcher = this.#launchers[engine] ?? driverLaunchers[engine]
    this.#logs += 1
    const logFile = join(this.#logFolder, `agent-${name}-${this.#logs}.log`)
    const options = { executablePath: target.executablePath, logFile, headless: target.headless ?? true, hiddenVariables: this.#hidden, redact: (text: string) => this.#redactor.redact(text), redactStream: () => this.#redactor.stream() }
    let starting: Promise<OwnedBrowser>
    try {
      starting = Promise.resolve(launcher(options, timeoutMs))
    } catch (error) {
      return { ok: false, failure: launchFailure(error, name, engine) }
    }
    const started = await bounded(starting, timerMs(timeoutMs + graceMs), this.#stopped.promise)
    if (started.status !== 'done') {
      if (started.status !== 'failed') this.#closeLate(starting)
      if (started.status === 'failed') return { ok: false, failure: launchFailure(started.error, name, engine) }
      if (started.status === 'stopped') return { ok: false, failure: this.#stopReason ?? failure('interrupted', 'The agent host was stopped.') }
      return { ok: false, failure: failure('setup_failed', `The ${engine} browser of the target ${name} did not start within ${timeoutMs} ms.`) }
    }
    const browser = started.value
    const stated = statedEngine(browser)
    if (stated !== undefined && stated !== engine) {
      const problem = await this.#closeNow(browser)
      const message = `The target ${name} runs on ${engine}, and the browser it started says it is ${stated}. Retest never runs one engine in another's place, so it closed that browser.${problem === undefined ? '' : ` ${problem}`}`
      return { ok: false, failure: { ...failure('setup_failed', message), details: { target: name, engine, stated } } }
    }
    const gone = Promise.withResolvers<void>()
    this.#launched.add(browser)
    this.#gone.set(browser, gone.promise)
    browser.onDisconnect(() => {
      gone.resolve()
      this.#gone.delete(browser)
      // A browser the host is closing is closed already; one that was lost is closed through its own driver once the
      // processes it started have had a moment to go on their own, so its close reaps only what is left of it, checking
      // each is a process it launched, and removes its profile.
      if (!this.#launched.has(browser)) return
      const timer = setTimeout(() => {
        this.#lostTimers.delete(timer)
        this.#closeBrowser(browser)
      }, lostBrowserGraceMs)
      this.#lostTimers.add(timer)
    })
    return { ok: true, browser }
  }

  // A browser that comes up after Retest stopped waiting for it is closed as it arrives, and the host's close waits for
  // that, within a bound. A launch that fails late has nothing to close.
  #closeLate(starting: Promise<OwnedBrowser>): void {
    const closing = starting.then(
      (browser) => this.#closeNow(browser),
      () => undefined,
    )
    this.#late.add(closing)
    void closing.then((problem) => {
      if (problem === undefined) this.#late.delete(closing)
    })
  }

  // Closes a browser once, within the cleanup budget, keeping what went wrong for the host's close to report.
  #closeBrowser(browser: OwnedBrowser): void {
    if (!this.#launched.delete(browser)) return
    const closing = this.#closeNow(browser)
    this.#closings.add(closing)
    void closing.then((problem) => {
      if (problem === undefined) this.#closings.delete(closing)
    })
  }

  // Closes a browser within the cleanup budget and says what went wrong, if anything. Never rejects, even for a close
  // that throws before it returns a promise.
  async #closeNow(browser: OwnedBrowser): Promise<string | undefined> {
    const { cleanup } = this.#timeouts
    const closed = await bounded(closing(browser, cleanup), timerMs(cleanup + graceMs))
    if (closed.status === 'failed') return `Closing a browser failed: ${errorMessage(closed.error)}`
    if (closed.status === 'timed_out') return `A browser did not close within the ${cleanup} ms cleanup budget.`
    return undefined
  }

  // A new context of the browser, with the state, base URL and viewport asked for. A page that arrives after Retest
  // stopped waiting is closed as it arrives, and `late` settles once it is.
  async #page(browser: OwnedBrowser, request: AgentOpenRequest, identity: SessionIdentity, timeoutMs: number): Promise<{ ok: true; page: OwnedPage } | { ok: false; failure: Failure; late?: Promise<void> }> {
    const options: NewPageOptions = {
      ...(request.baseUrl === undefined ? {} : { baseUrl: request.baseUrl }),
      ...(request.state === undefined ? {} : { storageState: request.state.storage }),
      ...(request.viewport === undefined ? {} : { emulation: { viewport: { width: request.viewport.width, height: request.viewport.height }, deviceScaleFactor: 1, touch: false, isMobile: false } }),
    }
    const opening = browser.newPage(options, timeoutMs)
    const opened = await bounded(opening, timerMs(timeoutMs + graceMs), this.#stopped.promise)
    if (opened.status !== 'done') {
      const late = opening.then((page) => disposing(page, this.#timeouts.cleanup)).then(() => undefined, () => undefined)
      const gone = this.#gone.get(browser) ?? Promise.resolve()
      const settled = Promise.race([late, gone])
      if (opened.status === 'failed') return { ok: false, failure: thrown(opened.error, `Session ${identity.sessionId} could not open a page`), late: settled }
      if (opened.status === 'stopped') return { ok: false, failure: this.#stopReason ?? failure('interrupted', 'The agent host was stopped.'), late: settled }
      return { ok: false, failure: failure('setup_failed', `Session ${identity.sessionId} could not open a page within ${timeoutMs} ms.`), late: settled }
    }
    const page = opened.value
    try {
      page.identify?.(identity)
    } catch (error) {
      const disposed = await bounded(disposing(page, this.#timeouts.cleanup), timerMs(this.#timeouts.cleanup + graceMs))
      const late = disposed.status === 'done' ? undefined : this.#gone.get(browser)
      return { ok: false, failure: failure('setup_failed', `Session ${identity.sessionId} could not name its page: ${errorMessage(error)}`), ...(late === undefined ? {} : { late }) }
    }
    return { ok: true, page }
  }
}

/**
 * Everything wrong with an open request, as one usage failure, or undefined. The target must be one the host names,
 * on the engine the request names.
 *
 * @example openProblem({ owner: 'agent-1', app: 'owner', purpose: 'discovery', target: 'chrome', engine: 'firefox' }, targets)?.class // 'setup_failed'
 */
export function openProblem(request: unknown, targets: ReadonlyMap<string, AgentTarget>): Failure | undefined {
  if (!isPlainObject(request)) return failure('usage', `An open request is { owner, app, purpose, target, engine }, received ${describeValue(request)}.`)
  const problems: string[] = []
  for (const key of Object.keys(request)) if (!openKeys.has(key) && request[key] !== undefined) problems.push(`${key}: unknown key`)
  const owner = request['owner']
  if (typeof owner !== 'string' || owner.trim() === '' || owner.length > longestOwner || /[\u0000-\u001f\u007f]/.test(owner)) {
    problems.push(`owner: expected the owner's name, up to ${longestOwner} characters on one line, received ${describeValue(owner)}`)
  }
  for (const key of ['app', 'purpose']) {
    const value = request[key]
    if (typeof value !== 'string' || !isName(value)) problems.push(`${key}: expected a name of letters, digits, "_" and "-" that starts with a letter, received ${describeValue(value)}`)
  }
  const { target, engine, baseUrl, viewport, state, locks, secrets, holdMs, waitMs } = request
  if (typeof engine !== 'string' || !engines.some((each) => each === engine)) problems.push(`engine: expected chromium, firefox or webkit, received ${describeValue(engine)}`)
  if (typeof target !== 'string') problems.push(`target: expected one of the host's targets (${[...targets.keys()].join(', ')}), received ${describeValue(target)}`)
  else if (!targets.has(target)) problems.push(`target: the host has no target ${JSON.stringify(target)}; it has ${[...targets.keys()].join(', ')}`)
  if (baseUrl !== undefined && (typeof baseUrl !== 'string' || !isWebUrl(URL.parse(baseUrl)))) problems.push(`baseUrl: expected an http or https address, received ${describeValue(baseUrl)}`)
  if (viewport !== undefined && !isViewport(viewport)) problems.push(`viewport: expected { width, height } in whole CSS pixels from 1, received ${describeValue(viewport)}`)
  if (state !== undefined) problems.push(...stateProblems(state))
  if (locks !== undefined && (!Array.isArray(locks) || locks.some((lock) => typeof lock !== 'string' || !isName(lock)) || new Set(locks).size !== locks.length)) problems.push(`locks: expected different lock names, received ${describeValue(locks)}`)
  if (secrets !== undefined && (!Array.isArray(secrets) || secrets.some((name) => typeof name !== 'string' || !isName(name)) || new Set(secrets).size !== secrets.length)) problems.push(`secrets: expected different names of the host's secrets, received ${describeValue(secrets)}`)
  for (const [key, value] of [['holdMs', holdMs], ['waitMs', waitMs]] as const) {
    if (value !== undefined && !isBudget(value)) problems.push(`${key}: expected a whole number of milliseconds from 1 to ${maxTimeout}, received ${describeValue(value)}`)
  }
  if (problems.length > 0) return failure('usage', problems.length === 1 ? `The open request: ${problems[0]}.` : `The open request has ${problems.length} problems:\n${problems.map((each) => `  ${each}`).join('\n')}`)
  const named = typeof target === 'string' ? targets.get(target) : undefined
  if (named !== undefined && named.engine !== engine) {
    const message = `The target ${JSON.stringify(target)} runs on ${named.engine}, and the session asked for ${String(engine)}. Retest never runs one engine in another's place.`
    return { ...failure('setup_failed', message), details: { target: String(target), engine: named.engine, asked: String(engine) } }
  }
  return undefined
}

/**
 * Everything wrong with an agent host's options, as one usage failure, or undefined.
 *
 * @example hostOptionsProblem({ targets: {}, budget, logFolder: '/tmp/logs' })?.class // 'usage'
 */
export function hostOptionsProblem(options: unknown): Failure | undefined {
  if (!isPlainObject(options)) return failure('usage', `An agent host takes { targets, budget, logFolder }, received ${describeValue(options)}.`)
  const problems: string[] = []
  for (const key of Object.keys(options)) if (!['targets', 'budget', 'logFolder', 'timeouts', 'launchers', 'secrets', 'hiddenVariables'].includes(key) && options[key] !== undefined) problems.push(`${key}: unknown key`)
  const { targets, budget, logFolder, timeouts, launchers, secrets, hiddenVariables } = options
  if (!isPlainObject(targets) || Object.keys(targets).length === 0) problems.push(`targets: expected at least one target by name, received ${describeValue(targets)}`)
  else for (const [name, target] of Object.entries(targets)) problems.push(...targetProblems(name, target))
  if (!(budget instanceof SessionBudget)) problems.push(`budget: expected a SessionBudget, received ${describeValue(budget)}`)
  if (typeof logFolder !== 'string' || !isAbsolute(logFolder)) problems.push(`logFolder: expected an absolute folder, received ${describeValue(logFolder)}`)
  if (timeouts !== undefined) {
    if (!isPlainObject(timeouts)) problems.push(`timeouts: expected budgets by name, received ${describeValue(timeouts)}`)
    else for (const [name, value] of Object.entries(timeouts)) {
      if (!Object.hasOwn(defaultAgentTimeouts, name)) problems.push(`timeouts.${name}: unknown budget`)
      else if (value !== undefined && !isBudget(value)) problems.push(`timeouts.${name}: expected a whole number of milliseconds from 1 to ${maxTimeout}, received ${describeValue(value)}`)
    }
  }
  if (launchers !== undefined && (!isPlainObject(launchers) || Object.entries(launchers).some(([engine, launch]) => !engines.some((each) => each === engine) || typeof launch !== 'function'))) problems.push('launchers: expected a launcher function for chromium, firefox or webkit')
  if (secrets !== undefined) problems.push(...secretsProblems(secrets))
  if (hiddenVariables !== undefined && (!Array.isArray(hiddenVariables) || hiddenVariables.some((name) => typeof name !== 'string'))) problems.push('hiddenVariables: expected a list of environment variable names')
  if (problems.length === 0) return undefined
  return failure('usage', problems.length === 1 ? `The agent host: ${problems[0]}.` : `The agent host has ${problems.length} problems:\n${problems.map((each) => `  ${each}`).join('\n')}`)
}

function targetProblems(name: string, target: unknown): string[] {
  if (!isName(name)) return [`targets.${name}: a target's name is letters, digits, "_" and "-", starting with a letter`]
  if (!isPlainObject(target)) return [`targets.${name}: expected { engine, executablePath }, received ${describeValue(target)}`]
  const problems: string[] = []
  for (const key of Object.keys(target)) if (!['engine', 'executablePath', 'headless'].includes(key) && target[key] !== undefined) problems.push(`targets.${name}.${key}: unknown key`)
  const { engine, executablePath, headless } = target
  if (typeof engine !== 'string' || !engines.some((each) => each === engine)) problems.push(`targets.${name}.engine: expected chromium, firefox or webkit, received ${describeValue(engine)}`)
  if (typeof executablePath !== 'string' || executablePath === '') problems.push(`targets.${name}.executablePath: expected the path of the browser to start, received ${describeValue(executablePath)}`)
  if (headless !== undefined && typeof headless !== 'boolean') problems.push(`targets.${name}.headless: expected true or false, received ${describeValue(headless)}`)
  return problems
}

function secretsProblems(secrets: unknown): string[] {
  if (!isPlainObject(secrets) || !isPlainObject(secrets['values'])) return ['secrets: expected { values, origins? }']
  const problems: string[] = []
  const values = new Map<string, ResolvedSecret>()
  for (const [name, secret] of Object.entries(secrets['values'])) {
    if (!isName(name)) problems.push(`secrets.values.${name}: a secret's name is letters, digits, "_" and "-", starting with a letter`)
    else if (isPlainObject(secret) && typeof secret['value'] === 'string') values.set(name, { value: secret['value'] })
    else if (!isPlainObject(secret) || typeof secret['read'] !== 'function') problems.push(`secrets.values.${name}: expected { value } or { read }`)
  }
  const short = secretValuesProblem(values)
  if (short !== undefined) problems.push(`secrets: ${short.message}`)
  const origins = secrets['origins']
  if (origins !== undefined) {
    if (!isPlainObject(origins)) problems.push('secrets.origins: expected the origins of each secret by name')
    else for (const [name, list] of Object.entries(origins)) {
      if (!Array.isArray(list) || list.some((origin) => typeof origin !== 'string' || readOrigin(origin) === undefined)) problems.push(`secrets.origins.${name}: expected http or https origins`)
    }
  }
  return problems
}

function stateProblems(state: unknown): string[] {
  if (!isPlainObject(state)) return [`state: expected the state a session saved, received ${describeValue(state)}`]
  const problems: string[] = []
  const storage = parse(storageStateSchema, state['storage'])
  if (!storage.ok) problems.push(`state.storage: ${storage.issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`)
  if (typeof state['savedFrom'] !== 'string' || typeof state['savedAt'] !== 'string' || typeof state['owner'] !== 'string' || typeof state['app'] !== 'string') problems.push('state: expected savedFrom, savedAt, owner and app, as a session saves them')
  return problems
}

function isViewport(value: unknown): boolean {
  if (!isPlainObject(value)) return false
  const { width, height } = value
  return Object.keys(value).every((key) => key === 'width' || key === 'height') && isPixels(width) && isPixels(height)
}

function isPixels(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function isBudget(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= maxTimeout
}

function definedTimeouts(timeouts: Partial<AgentTimeouts> | undefined): Partial<AgentTimeouts> {
  return Object.fromEntries(Object.entries(timeouts ?? {}).filter(([, value]) => value !== undefined))
}

// The host's secrets as the runner's filler takes them: a declared secret's origins are the only part it reads.
function secretFiller(secrets: AgentSecrets, redactor: Redactor): SecretFiller {
  const values = new Map(Object.entries(secrets.values))
  const declared = new Map<string, LoadedSecret>(
    Object.keys(secrets.values).map((name) => [name, { source: { read: () => Promise.reject(new Error('An agent host reads secrets through its own values.')) }, origins: [...(secrets.origins?.[name] ?? [])].map((origin) => readOrigin(origin) ?? origin) }]),
  )
  return new SecretFiller(values, declared, redactor)
}

// Gives a lease back: its session at once when nothing was opened, or once a page that may still arrive is closed or its
// browser has gone.
async function giveBack(lease: ResourceLease, free?: Promise<void>): Promise<void> {
  await lease.release({
    whenFree: () => undefined,
    giveBackSessions: (sessions: SessionLease) => {
      if (free === undefined) {
        sessions.release()
        return true
      }
      void free.then(() => sessions.release())
      return false
    },
    ending: false,
  })
}

// A browser's close as a promise, a throw before it returns one included.
async function closing(browser: OwnedBrowser, timeoutMs: number): Promise<void> {
  await browser.close(timeoutMs)
}

// A page's disposal as a promise, a throw before it returns one included.
async function disposing(page: OwnedPage, timeoutMs: number): Promise<void> {
  await page.dispose(timeoutMs)
}

function launchFailure(error: unknown, name: string, engine: WebEngine): Failure {
  if (error instanceof LaunchError) return error.failure
  return failure('setup_failed', `The ${engine} browser of the target ${name} could not start: ${errorMessage(error)}`)
}

function thrown(error: unknown, what: string): Failure {
  const reported = error instanceof Error && 'failure' in error ? parse(failureSchema, error.failure) : undefined
  return reported?.ok === true ? reported.value : failure('setup_failed', `${what}: ${errorMessage(error)}`)
}
