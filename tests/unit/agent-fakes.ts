import type { BrowserCommand, DispatchedCommand, InputDispatch, LaunchOptions, NewPageOptions, OwnedBrowser, OwnedPage, PageNavigation, PageReading, TextQuery, WebRuntimeIdentity } from '../../src/browser/contract.ts'
import type { CaptureAvailability, CaptureStart, CaptureStats, FrameSource } from '../../src/media/capture.ts'
import type { CommandResult, Observation } from '../../src/protocol/commands.ts'
import type { Failure } from '../../src/protocol/failures.ts'
import type { RecordIdentity } from '../../src/protocol/identity.ts'
import type { LocatorRecipe } from '../../src/protocol/locator.ts'
import type { StorageState } from '../../src/protocol/storage-state.ts'
import type { ElementIdentity, KeyedReading } from '../../src/agent/identity.ts'
import type { AgentLauncher } from '../../src/agent/targets.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { failureSchema } from '../../src/protocol/failures.ts'
import { pageTextHolds } from '../../src/protocol/host-check.ts'
import { describeLocator, locatorSteps } from '../../src/protocol/locator.ts'
import { parse } from '../../src/protocol/schema.ts'
import { observationOf } from '../support/observation.ts'

// A small programmable browser for the agent session unit tests: a page whose elements a test sets, finds by test id,
// role and name, or text, keeps by place, counts its changes, opens documents, holds a command or loses its browser on
// request, and keeps the cookies and storage it was opened with. With `identity` its pages also key each element and
// act only on a pinned one, as the element identity a driver may offer; each element object is one node, so a test
// that shows the same objects in another order moves nodes, and one that shows new objects replaces them. It runs no
// app; the real engines run in the integration tests.

/** An element of the fake page. */
export type FakeElement = { testId?: string; role?: string; name?: string; text: string; visible?: boolean }

/** Faults and behaviours of the fake browser. Every switch is off by default. */
export type AgentFakeOptions = {
  /** Commands of this kind wait for `release` before they answer, unless they are stopped. */
  hold?: BrowserCommand['kind']
  /** A held command stopped by its signal answers as having sent its input. */
  holdSendsInput?: boolean
  disposeFails?: boolean
  /** Disposing a context never answers. */
  disposeHangs?: boolean
  /** The engine the browser states, when it states one. */
  states?: WebRuntimeIdentity['engine']
  /** Pages give a frame source of their own. */
  frameSource?: boolean
  /** `newPage` waits for this before it opens a page. */
  holdOpening?: Promise<void>
  launchFails?: string
  /** The launcher throws this before it returns a promise. */
  launchThrows?: string
  /** The launcher waits for this before it starts a browser; a rejection fails the launch. */
  launchAfter?: Promise<void>
  /** Closing the browser ends it, then throws this. */
  closeFails?: string
  /** The first reads of a page's text fail as reads that ran out of time, as a slow page's do. */
  lateReads?: number
  /** Pages key their elements and act only on a pinned one. */
  identity?: boolean
}

// Each element object is one node; its key names it and no other, for the test's whole life.
const elementKeys = new WeakMap<FakeElement, string>()
let keysGiven = 0

/** The key the fake's element identity gives an element. */
export function keyOf(element: FakeElement): string {
  const known = elementKeys.get(element)
  if (known !== undefined) return known
  keysGiven += 1
  const key = `node-${keysGiven}`
  elementKeys.set(element, key)
  return key
}

export class AgentFakePage implements OwnedPage {
  readonly browser: AgentFakeBrowser
  readonly options: NewPageOptions
  readonly commands: BrowserCommand[] = []
  readonly #navigation = new Set<(navigation: PageNavigation) => void>()
  readonly #held = new Set<() => void>()
  elements: FakeElement[] = []
  url: string | undefined
  cookies: StorageState['cookies']
  origins: StorageState['origins']
  changes = 0
  disposed = false
  identified: string | undefined
  /** Typed text, by the test id it went to; never shown back by the page. */
  readonly typed: { testId: string | undefined; value: string; secret?: string }[] = []

  constructor(browser: AgentFakeBrowser, options: NewPageOptions) {
    this.browser = browser
    this.options = options
    this.cookies = options.storageState?.cookies.map((cookie) => ({ ...cookie })) ?? []
    this.origins = options.storageState?.origins.map((origin) => ({ origin: origin.origin, localStorage: origin.localStorage.map((item) => ({ ...item })) })) ?? []
  }

  /** Replaces what the page shows, as an app redrawing does. */
  show(elements: FakeElement[]): void {
    this.elements = elements
    this.changes += 1
  }

  /** The page opens another document on its own. */
  open(path: string): void {
    const url = new URL(path, this.url ?? this.options.baseUrl ?? 'http://127.0.0.1:4173/')
    this.url = `${url.origin}${url.pathname}`
    this.changes += 1
    for (const listener of this.#navigation) listener({ url: this.url, title: Promise.resolve(undefined), cause: 'page', document: 'new' })
  }

  /** Lets every held command answer. */
  release(): void {
    for (const wake of [...this.#held]) wake()
  }

  identify(session: { sessionId: string }): void {
    this.identified = session.sessionId
  }

  async execute(command: BrowserCommand, timeoutMs: number, signal?: AbortSignal): Promise<CommandResult> {
    return this.run(command, timeoutMs, signal, undefined)
  }

  /** Runs a command; with `pin`, the element the command's locator finds once it is ready must be the node `pin` keys. */
  async run(command: BrowserCommand, timeoutMs: number, signal: AbortSignal | undefined, pin: string | undefined): Promise<CommandResult> {
    this.commands.push(command)
    if (!this.browser.connected) return { ok: false, failure: { class: 'session_lost', message: 'The fake page lost its browser.' } }
    if (this.browser.options.hold === command.kind) {
      const stopped = await this.#wait(timeoutMs, signal)
      if (stopped !== undefined) return { ok: false, failure: { ...stopped, details: { ...stopped.details, inputSent: this.browser.options.holdSendsInput === true } } }
    }
    if (!this.browser.connected) return { ok: false, failure: { class: 'outcome_unknown', message: 'The fake page lost its browser after the input went.' } }
    switch (command.kind) {
      case 'goto': {
        this.open(command.url)
        return { ok: true, kind: 'goto', url: this.url ?? command.url }
      }
      case 'observe':
        return { ok: true, kind: 'observe', observation: this.#observe(command.locator), changes: this.changes, ...this.facts() }
      case 'observePage':
        return { ok: true, kind: 'observePage', observation: { url: this.url ?? null, title: '' }, changes: this.changes }
      case 'reload':
      case 'goBack':
      case 'goForward':
        return { ok: false, failure: { class: 'unsupported', message: `The fake page cannot ${command.kind}.` } }
      default:
        break
    }
    if (!('locator' in command) || command.locator === undefined) return { ok: true, kind: command.kind === 'press' ? 'press' : 'scroll' }
    const found = this.find(command.locator)
    if (found.length === 0) return { ok: false, failure: { class: 'not_found', message: `${describeLocator(command.locator)} matched no element.` } }
    if (found.length > 1) return { ok: false, failure: { class: 'ambiguous', message: `${describeLocator(command.locator)} matched ${found.length} elements.` } }
    const [element] = found
    if (pin !== undefined && (element === undefined || keyOf(element) !== pin)) {
      return { ok: false, failure: { class: 'not_actionable', message: `${describeLocator(command.locator)} finds another element than the one pinned.`, details: { refused: 'moved', inputSent: false } } }
    }
    this.changes += 1
    if (command.kind === 'fill') {
      this.typed.push({ testId: element?.testId, value: command.value, ...(command.secret === undefined ? {} : { secret: command.secret }) })
      return { ok: true, kind: 'fill' }
    }
    if (command.kind === 'select' || command.kind === 'check' || command.kind === 'uncheck') return { ok: true, kind: command.kind, changed: true }
    if (element?.testId === 'sign-in') this.cookies = [{ name: 'session', value: `signed-in-${this.browser.pages.indexOf(this)}`, domain: '127.0.0.1', path: '/', expires: -1, httpOnly: true, secure: false }]
    return { ok: true, kind: command.kind }
  }

  /** How many times the page's text was read. */
  reads = 0

  async readPage(queries: readonly TextQuery[]): Promise<PageReading> {
    this.reads += 1
    if (!this.browser.connected) throw new Error('The fake page lost its browser.')
    if (this.reads <= (this.browser.options.lateReads ?? 0)) throw Object.assign(new Error('Could not read the page in time.'), { failure: { class: 'timeout', message: 'Could not read the page within 1 ms.' } })
    const text = this.elements.filter((element) => element.visible !== false).map((element) => element.text).join('\n')
    return { url: this.url, navigating: false, found: queries.map((query) => pageTextHolds(text, query)) }
  }

  onNavigation(listener: (navigation: PageNavigation) => void): () => void {
    this.#navigation.add(listener)
    return () => this.#navigation.delete(listener)
  }

  async captureState(): Promise<StorageState> {
    return { cookies: this.cookies.map((cookie) => ({ ...cookie })), origins: this.origins.map((origin) => ({ origin: origin.origin, localStorage: origin.localStorage.map((item) => ({ ...item })) })) }
  }

  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array([0x89, 0x50, 0x4e, 0x47, this.browser.pages.indexOf(this)])
  }

  async dispose(): Promise<void> {
    if (this.browser.options.disposeHangs === true) return new Promise<void>(() => undefined)
    if (this.browser.options.disposeFails === true) throw new Error('The fake context would not close.')
    this.disposed = true
  }

  // Waits until released, its time runs out or it is stopped; answers the stop's reason when it was stopped or timed out.
  async #wait(timeoutMs: number, signal: AbortSignal | undefined): Promise<Failure | undefined> {
    const { promise, resolve } = Promise.withResolvers<Failure | undefined>()
    const wake = (): void => resolve(undefined)
    this.#held.add(wake)
    const timer = setTimeout(() => resolve({ class: 'timeout', message: `The fake command took longer than ${timeoutMs} ms.` }), timeoutMs)
    const stop = (): void => {
      const parsed = parse(failureSchema, signal?.reason)
      resolve(parsed.ok ? parsed.value : { class: 'interrupted', message: 'Stopped.' })
    }
    if (signal?.aborted === true) stop()
    signal?.addEventListener('abort', stop, { once: true })
    const answer = await promise
    this.#held.delete(wake)
    clearTimeout(timer)
    signal?.removeEventListener('abort', stop)
    return answer
  }

  facts(): { page?: { url: string } } {
    return this.url === undefined ? {} : { page: { url: this.url } }
  }

  /** The elements a locator finds now, in the page's order. */
  find(locator: LocatorRecipe): FakeElement[] {
    const steps = locatorSteps(locator)
    if (steps.length !== 1) return []
    const [step] = steps
    if (step === undefined) return []
    const matched = this.elements.filter((element) => {
      if (step.by === 'testId') return element.testId === step.value
      if (step.by === 'role') return element.role === step.role && (step.name === undefined || element.name === step.name)
      if (step.by === 'text') return typeof step.text === 'string' && element.text === step.text
      return false
    })
    if (step.pick === undefined) return matched
    const index = step.pick === 'first' ? 0 : step.pick === 'last' ? matched.length - 1 : step.pick < 0 ? matched.length + step.pick : step.pick
    const kept = matched[index]
    return kept === undefined ? [] : [kept]
  }

  #observe(locator: LocatorRecipe): Observation {
    return observationOf(this.find(locator).map((element) => ({ text: element.text, visible: element.visible !== false })))
  }
}

/** A page whose driver offers element identity: keyed reads, and actions pinned to one node. */
export class AgentKeyedPage extends AgentFakePage implements ElementIdentity {
  async readElements(locators: readonly LocatorRecipe[]): Promise<KeyedReading> {
    for (const locator of locators) this.commands.push({ kind: 'observe', locator })
    if (!this.browser.connected) return { ok: false, failure: { class: 'session_lost', message: 'The fake page lost its browser.' } }
    const reads = locators.map((locator) => {
      const found = this.find(locator)
      return { observation: observationOf(found.map((element) => ({ text: element.text, visible: element.visible !== false }))), keys: found.slice(0, 100).map(keyOf) }
    })
    return { ok: true, reads, ...this.facts() }
  }

  async dispatchTo(command: BrowserCommand, key: string, timeoutMs: number, signal?: AbortSignal): Promise<DispatchedCommand> {
    const result = await this.run(command, timeoutMs, signal, key)
    return { result, input: inputOf(result) }
  }
}

// How far a fake command's input got, as the fake's answers say.
function inputOf(result: CommandResult): InputDispatch {
  if (result.ok) return 'sent'
  const sent = result.failure.details?.['inputSent']
  if (typeof sent === 'boolean') return sent ? 'sent' : 'not_sent'
  return ['not_found', 'ambiguous', 'not_actionable', 'session_lost', 'unsupported'].includes(result.failure.class) ? 'not_sent' : 'unknown'
}

/** A page whose driver gives a frame source, as Chromium's does. */
export class AgentFramedPage extends AgentFakePage {
  readonly sources: FakeFrameSource[] = []

  frameSource(identity: RecordIdentity): FrameSource {
    const source = new FakeFrameSource(identity)
    this.sources.push(source)
    return source
  }
}

export class FakeFrameSource implements FrameSource {
  readonly name = 'chromium' as const
  readonly identity: RecordIdentity
  stopped = 0

  constructor(identity: RecordIdentity) {
    this.identity = identity
  }

  availability(): CaptureAvailability {
    return { available: true, mode: 'screencast' }
  }

  async start(): Promise<CaptureStart> {
    return { ok: true, mode: 'screencast' }
  }

  async stop(): Promise<CaptureStats> {
    this.stopped += 1
    return { mode: 'screencast', requestedFps: 1, delivered: 0, superseded: 0, dropped: 0, problems: [] }
  }
}

// Above any process id an operating system hands out.
const firstFakePid = 2 ** 31 - 1

export class AgentFakeBrowser implements OwnedBrowser {
  readonly product = 'FakeBrowser'
  readonly version = '1.0'
  readonly userAgent = 'FakeBrowser/1.0'
  readonly pid: number
  readonly executablePath: string
  readonly options: AgentFakeOptions
  readonly launchOptions: LaunchOptions
  readonly pages: AgentFakePage[] = []
  readonly #listeners = new Set<(reason: string) => void>()
  #reason: string | undefined
  connected = true
  closed = false

  constructor(options: AgentFakeOptions, launchOptions: LaunchOptions, pid: number) {
    this.options = options
    this.launchOptions = launchOptions
    this.executablePath = launchOptions.executablePath
    this.pid = pid
  }

  get identity(): WebRuntimeIdentity | undefined {
    const engine = this.options.states
    return engine === undefined ? undefined : { kind: 'web', engine, product: this.product, version: this.version, executablePath: this.executablePath, processIds: [this.pid] }
  }

  async newPage(options: NewPageOptions): Promise<AgentFakePage> {
    await this.options.holdOpening
    if (!this.connected) throw new Error('The fake browser is not connected.')
    const page = this.options.identity === true ? new AgentKeyedPage(this, options) : this.options.frameSource === true ? new AgentFramedPage(this, options) : new AgentFakePage(this, options)
    this.pages.push(page)
    return page
  }

  onDisconnect(listener: (reason: string) => void): () => void {
    if (this.#reason !== undefined) {
      const reason = this.#reason
      queueMicrotask(() => listener(reason))
      return () => undefined
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async close(): Promise<void> {
    this.closed = true
    this.disconnect('The fake browser was closed.')
    if (this.options.closeFails !== undefined) throw new Error(this.options.closeFails)
  }

  disconnect(reason: string): void {
    if (!this.connected) return
    this.connected = false
    this.#reason = reason
    for (const listener of this.#listeners) listener(reason)
  }
}

/** A launcher that records every fake browser it starts. */
export function agentFakeLauncher(options: AgentFakeOptions = {}): { launch: AgentLauncher; browsers: AgentFakeBrowser[]; calls: { count: number } } {
  const browsers: AgentFakeBrowser[] = []
  const launched = async (launchOptions: LaunchOptions): Promise<AgentFakeBrowser> => {
    await options.launchAfter
    if (options.launchFails !== undefined) throw new Error(options.launchFails)
    const browser = new AgentFakeBrowser(options, launchOptions, firstFakePid - browsers.length)
    browsers.push(browser)
    return browser
  }
  const calls = { count: 0 }
  const launch: AgentLauncher = (launchOptions) => {
    calls.count += 1
    if (options.launchThrows !== undefined) throw new Error(options.launchThrows)
    return launched(launchOptions)
  }
  return { launch, browsers, calls }
}

/** Waits a tick, so promise chains of a release settle. */
export function settle(): Promise<void> {
  return sleep(5)
}
