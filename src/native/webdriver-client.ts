import type { IncomingMessage } from 'node:http'
import type { InputDispatch } from '../browser/contract.ts'
import type { ExecutorName } from './executors.ts'
import type { ScopedSource, SourceScope } from './source-scope.ts'
import { request } from 'node:http'
import { elapsedMs, monotonicClock } from '../protocol/deadline.ts'
import { errorMessage } from '../protocol/failures.ts'
import { isPlainObject } from '../protocol/schema.ts'
import { errorCode } from '../shared/error-code.ts'
import { scopeSource } from './source-scope.ts'

// Retest's own client to an XCTest executor. It exposes only routes that do exactly what they are asked once: the
// status, sessions, the app lifecycle, captures, a scoped tree, one click, keys and W3C actions. It has no method for
// an element's `/value` or `/clear`: both executors serve those by typing, reading back and typing again on their own,
// so a client timeout there can leave input landing after the last read. Retest never sends input that may already
// have landed, so those routes are never called.

/**
 * The lifecycle client's routes, as `METHOD path` with `:session` and `:element` standing for ids. With the
 * interaction layer's `ElementRoute` they are every route Retest sends an executor; nothing else reaches one.
 */
export type ExecutorRoute =
  | 'GET /status'
  | 'POST /session'
  | 'DELETE /session/:session'
  | 'POST /session/:session/wda/apps/launch'
  | 'POST /session/:session/wda/apps/activate'
  | 'POST /session/:session/wda/apps/terminate'
  | 'POST /session/:session/wda/apps/state'
  | 'GET /session/:session/screenshot'
  | 'GET /session/:session/element/:element/screenshot'
  | 'GET /session/:session/window/rect'
  | 'GET /session/:session/source'
  | 'POST /session/:session/element/:element/click'
  | 'POST /session/:session/wda/keys'
  | 'POST /session/:session/actions'
  | 'DELETE /'
  | 'GET /wda/shutdown'

/** The lifecycle client's routes, for a reader that checks what it can send; `elementRoutes` lists the rest. */
export const executorRoutes: readonly ExecutorRoute[] = [
  'GET /status',
  'POST /session',
  'DELETE /session/:session',
  'POST /session/:session/wda/apps/launch',
  'POST /session/:session/wda/apps/activate',
  'POST /session/:session/wda/apps/terminate',
  'POST /session/:session/wda/apps/state',
  'GET /session/:session/screenshot',
  'GET /session/:session/element/:element/screenshot',
  'GET /session/:session/window/rect',
  'GET /session/:session/source',
  'POST /session/:session/element/:element/click',
  'POST /session/:session/wda/keys',
  'POST /session/:session/actions',
  'DELETE /',
  'GET /wda/shutdown',
]

/** A JSON value as the executors send and receive it. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue }

/**
 * How a request ended.
 *
 * - `answered`: the executor answered with a value.
 * - `refused`: the executor answered with a WebDriver error, named in `error`.
 * - `not_sent`: the executor cannot have received the request: it was stopped before it went, its connection was
 *   refused, or the request never left this process whole.
 * - `unknown`: the request went and no readable answer came: the time ran out, it was stopped, the connection was
 *   lost, or the answer could not be read. The executor may have done it. It is not a failure of the route and it is
 *   never sent again.
 */
export type ExecutorAnswer<T> =
  | { readonly status: 'answered'; readonly value: T; readonly durationMs: number }
  | { readonly status: 'refused'; readonly error: string; readonly message: string; readonly httpStatus: number; readonly durationMs: number }
  | { readonly status: 'not_sent'; readonly reason: 'stopped' | 'timeout' | 'connection_refused' | 'incomplete' | 'session_ended' | 'wrong_executor'; readonly message: string }
  | { readonly status: 'unknown'; readonly reason: 'timeout' | 'stopped' | 'connection_lost' | 'unreadable'; readonly message: string; readonly durationMs: number }

/** One request's bounds: its deadline, and a signal that stops it. */
export type RequestBounds = { readonly timeoutMs: number; readonly signal?: AbortSignal | undefined }

/** Where an app is, as XCTest numbers it: 0 unknown, 1 not running, 2 suspended, 3 in the background, 4 in the foreground. */
export type ExecutorAppState = 0 | 1 | 2 | 3 | 4

/** Which app a lifecycle route acts on: by bundle id, or on macOS by the app bundle's path. */
export type AppTarget = { readonly bundleId: string } | { readonly path: string }

/** A launch: the app, its arguments and the environment it is given. */
export type AppLaunch = { readonly target: AppTarget; readonly arguments: readonly string[]; readonly environment: Readonly<Record<string, string>> }

/** A rectangle in points. */
export type Rect = { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

/** A key of the macOS runner's `/wda/keys`: a character or an `XCUIKeyboardKey` name, with XCTest's modifier bits. */
export type MacKey = string | { readonly key: string; readonly modifierFlags: number }

// WebDriver errors that a route raises before it does anything: the request was read and nothing was acted on.
const refusedBeforeActing = new Set(['invalid session id', 'unknown command', 'unknown method', 'invalid argument', 'session not created', 'no such element', 'stale element reference', 'no such window'])

/**
 * How far a request that acts got, as the session contract counts input: an answer is `sent`, a request that cannot
 * have arrived `not_sent`, and one with no readable answer `unknown`. A WebDriver error the route raises before acting
 * is `not_sent`; any other error is `unknown`, since the route may have acted before it failed.
 *
 * @example inputDispatch({ status: 'unknown', reason: 'timeout', message: '…', durationMs: 5000 }) // 'unknown'
 */
export function inputDispatch(answer: ExecutorAnswer<unknown>): InputDispatch {
  if (answer.status === 'answered') return 'sent'
  if (answer.status === 'not_sent') return 'not_sent'
  if (answer.status === 'refused') return refusedBeforeActing.has(answer.error) ? 'not_sent' : 'unknown'
  return 'unknown'
}

// A display capture of a large screen is a few megabytes of base64; anything past this is not an executor answer.
const answerLimit = 64 * 1024 * 1024
const elementKey = 'element-6066-11e4-a52e-4f735466cecf'

/**
 * A client to one executor's HTTP server on this Mac. Each request opens its own connection, so a request that never
 * left this process can be told from one that may have arrived, and is bounded by its own deadline.
 */
export class ExecutorClient {
  readonly executor: ExecutorName
  readonly host: string
  readonly port: number

  constructor(options: { readonly executor: ExecutorName; readonly host: string; readonly port: number }) {
    this.executor = options.executor
    this.host = options.host
    this.port = options.port
  }

  /**
   * Reads `/status`, which the executor serves before any session exists. `ready` is true once it accepts commands.
   *
   * @example (await client.status({ timeoutMs: 2000 })).status // 'answered'
   */
  async status(bounds: RequestBounds): Promise<ExecutorAnswer<{ readonly ready: boolean; readonly os?: string }>> {
    const answer = await this.#send('GET /status', {}, undefined, bounds)
    return mapAnswer(answer, (value) => {
      if (!isPlainObject(value)) return undefined
      const os = isPlainObject(value['os']) && typeof value['os']['version'] === 'string' ? value['os']['version'] : undefined
      return { ready: value['ready'] === true, ...(os === undefined ? {} : { os }) }
    })
  }

  /**
   * Creates a session that launches nothing: the app lifecycle is driven through the session's own routes, so a launch
   * is a request of its own with its own outcome.
   */
  async createSession(bounds: RequestBounds): Promise<ExecutorAnswer<ExecutorSession>> {
    const capabilities = this.executor === 'mac2' ? { skipAppKill: true } : { shouldTerminateApp: false, shouldWaitForQuiescence: false }
    const answer = await this.#send('POST /session', {}, { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, bounds)
    return mapAnswer(answer, (value) => {
      const id = isPlainObject(value) ? value['sessionId'] : undefined
      return typeof id === 'string' && id.length > 0 ? new ExecutorSession(this.executor, id, (route, ids, body, sent) => this.#send(route, ids, body, sent)) : undefined
    })
  }

  /**
   * Asks the executor to stop serving: `DELETE /` for the macOS runner and `GET /wda/shutdown` for WebDriverAgent. Both
   * answer in plain text, so an answer with any status counts.
   */
  async shutdown(bounds: RequestBounds): Promise<ExecutorAnswer<string>> {
    const answer = this.executor === 'mac2' ? await this.#send('DELETE /', {}, undefined, bounds, 'text') : await this.#send('GET /wda/shutdown', {}, undefined, bounds, 'text')
    return mapAnswer(answer, (value) => (typeof value === 'string' ? value : undefined))
  }

  #send(route: ExecutorRoute, ids: RouteIds, body: JsonValue | undefined, bounds: RequestBounds, kind: 'json' | 'text' = 'json'): Promise<ExecutorAnswer<JsonValue>> {
    const [method = 'GET', template = '/'] = route.split(' ')
    const path = template.replace(':session', encodeURIComponent(ids.session ?? '')).replace(':element', encodeURIComponent(ids.element ?? ''))
    return exchange({ host: this.host, port: this.port, method, path, body, kind, ...bounds })
  }
}

type RouteIds = { readonly session?: string; readonly element?: string }

/** Sends one request on one of the client's routes. */
export type RouteSender = (route: ExecutorRoute, ids: RouteIds, body: JsonValue | undefined, bounds: RequestBounds) => Promise<ExecutorAnswer<JsonValue>>

/**
 * One executor session, as `ExecutorClient.createSession` makes it. Its id is the executor's own. Once the session has
 * ended, or the executor has said it does not know it, nothing more is sent on it.
 */
export class ExecutorSession {
  readonly id: string
  readonly executor: ExecutorName
  readonly #sender: RouteSender
  #ended: string | undefined

  constructor(executor: ExecutorName, id: string, sender: RouteSender) {
    this.executor = executor
    this.id = id
    this.#sender = sender
  }

  /** Why nothing more is sent on this session, or undefined while it is live. */
  get ended(): string | undefined {
    return this.#ended
  }

  /**
   * Marks the session ended when another layer sending on it learned that the executor no longer knows it, so nothing
   * more goes from either. The first reason stays.
   */
  markEnded(reason: string): void {
    this.#ended ??= reason
  }

  /** Ends the session on the executor. The executor keeps serving. */
  async end(bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    const answer = await this.#send('DELETE /session/:session', {}, undefined, bounds)
    if (answer.status !== 'not_sent') this.#ended ??= 'The session was ended.'
    return answer
  }

  /**
   * Launches an app that is not running, with its arguments and environment. Both executors activate an app that is
   * already running instead, with none of the new arguments, so a caller checks the state first.
   */
  async launchApp(launch: AppLaunch, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    return this.#send('POST /session/:session/wda/apps/launch', {}, { ...launch.target, arguments: [...launch.arguments], environment: { ...launch.environment } }, bounds)
  }

  /** Brings the app to the front. XCTest launches an app that is not running, so a caller checks the state first. */
  async activateApp(target: AppTarget, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    return this.#send('POST /session/:session/wda/apps/activate', {}, { ...target }, bounds)
  }

  /** Terminates the app; the value is true when XCTest saw it running and terminated it. */
  async terminateApp(target: AppTarget, bounds: RequestBounds): Promise<ExecutorAnswer<boolean>> {
    return mapAnswer(await this.#send('POST /session/:session/wda/apps/terminate', {}, { ...target }, bounds), (value) => (typeof value === 'boolean' ? value : undefined))
  }

  /** Where the app is, as XCTest numbers it. Sends no input. */
  async appState(target: AppTarget, bounds: RequestBounds): Promise<ExecutorAnswer<ExecutorAppState>> {
    return mapAnswer(await this.#send('POST /session/:session/wda/apps/state', {}, { ...target }, bounds), (value) => (value === 0 || value === 1 || value === 2 || value === 3 || value === 4 ? value : undefined))
  }

  /** A PNG of the device screen (iOS) or the main display (macOS). Sends no input. */
  async screenshot(bounds: RequestBounds): Promise<ExecutorAnswer<Uint8Array>> {
    return mapAnswer(await this.#send('GET /session/:session/screenshot', {}, undefined, bounds), decodeBase64)
  }

  /** A PNG of one element's frame, cut from the screen. Sends no input. */
  async elementScreenshot(element: string, bounds: RequestBounds): Promise<ExecutorAnswer<Uint8Array>> {
    return mapAnswer(await this.#send('GET /session/:session/element/:element/screenshot', { element }, undefined, bounds), decodeBase64)
  }

  /** The main screen's frame in points on macOS, the app's window on iOS. Sends no input. */
  async windowRect(bounds: RequestBounds): Promise<ExecutorAnswer<Rect>> {
    return mapAnswer(await this.#send('GET /session/:session/window/rect', {}, undefined, bounds), readRect)
  }

  /**
   * The app's element tree, cut to what the scope owns before it leaves this method: on macOS the app's first window,
   * never the menu bar, and on iOS the app itself, with any menu's text hashed. A tree whose root is not the owned app
   * is refused as `unreadable`, and nothing of it is kept.
   */
  async ownedSource(scope: SourceScope, bounds: RequestBounds): Promise<ExecutorAnswer<ScopedSource>> {
    const answer = await this.#send('GET /session/:session/source', {}, undefined, bounds)
    if (answer.status !== 'answered') return answer
    if (typeof answer.value !== 'string') return { status: 'unknown', reason: 'unreadable', message: 'The tree is not text.', durationMs: answer.durationMs }
    const scoped = scopeSource(answer.value, scope)
    if (!scoped.ok) return { status: 'unknown', reason: 'unreadable', message: scoped.problem, durationMs: answer.durationMs }
    return { status: 'answered', value: scoped.source, durationMs: answer.durationMs }
  }

  /** One XCTest click (macOS) or tap (iOS) at the element's hit point. */
  async click(element: string, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    return this.#send('POST /session/:session/element/:element/click', { element }, {}, bounds)
  }

  /** The macOS runner's key presses, each sent once, in order, to the app in front. */
  async pressKeys(keys: readonly MacKey[], bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    if (this.executor !== 'mac2') return wrongExecutor('pressKeys', this.executor)
    return this.#send('POST /session/:session/wda/keys', {}, { keys: keys.map((key) => (typeof key === 'string' ? key : { ...key })) }, bounds)
  }

  /** WebDriverAgent's typing into the focused element, as one synthesized typing event. */
  async typeText(text: string, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    if (this.executor !== 'webdriveragent') return wrongExecutor('typeText', this.executor)
    return this.#send('POST /session/:session/wda/keys', {}, { value: [text] }, bounds)
  }

  /** W3C actions, sent as given. */
  async performActions(actions: readonly JsonValue[], bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    return this.#send('POST /session/:session/actions', {}, { actions: [...actions] }, bounds)
  }

  async #send(route: ExecutorRoute, ids: { readonly element?: string }, body: JsonValue | undefined, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    if (this.#ended !== undefined) return { status: 'not_sent', reason: 'session_ended', message: this.#ended }
    const answer = await this.#sender(route, { session: this.id, ...ids }, body, bounds)
    // The executor no longer knows this session: it was replaced or the executor restarted. Nothing more goes on it.
    if (answer.status === 'refused' && answer.error === 'invalid session id') this.#ended = `The executor no longer knows session ${this.id}: ${answer.message}`
    return answer
  }
}

function wrongExecutor(method: string, executor: ExecutorName): ExecutorAnswer<never> {
  return { status: 'not_sent', reason: 'wrong_executor', message: `${method} is not a route of ${executor === 'mac2' ? 'the macOS runner' : 'WebDriverAgent'}.` }
}

function mapAnswer<T>(answer: ExecutorAnswer<JsonValue>, read: (value: JsonValue) => T | undefined): ExecutorAnswer<T> {
  if (answer.status !== 'answered') return answer
  const value = read(answer.value)
  if (value === undefined) return { status: 'unknown', reason: 'unreadable', message: 'The executor answered with a value Retest cannot read.', durationMs: answer.durationMs }
  return { status: 'answered', value, durationMs: answer.durationMs }
}

function decodeBase64(value: JsonValue): Uint8Array | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return new Uint8Array(Buffer.from(value, 'base64'))
}

function readRect(value: JsonValue): Rect | undefined {
  if (!isPlainObject(value)) return undefined
  const { x, y, width, height } = value
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number') return undefined
  return { x, y, width, height }
}

/**
 * The element id in an executor's element reference, under the W3C key or the legacy `ELEMENT` key.
 *
 * @example elementId({ 'element-6066-11e4-a52e-4f735466cecf': '5A' }) // '5A'
 */
export function elementId(value: JsonValue): string | undefined {
  if (!isPlainObject(value)) return undefined
  const id = value[elementKey] ?? value['ELEMENT']
  return typeof id === 'string' ? id : undefined
}

type Exchange = {
  readonly host: string
  readonly port: number
  readonly method: string
  readonly path: string
  readonly body: JsonValue | undefined
  readonly kind: 'json' | 'text'
  readonly timeoutMs: number
  readonly signal?: AbortSignal | undefined
}

// One request on a connection of its own. What the request had reached when it ended decides its outcome: before the
// connection opened, or before every byte of it left this process, the executor cannot have read it; after that, a
// missing or unreadable answer leaves its outcome unknown.
function exchange(options: Exchange): Promise<ExecutorAnswer<JsonValue>> {
  const startedAt = monotonicClock()
  if (options.signal?.aborted === true) return Promise.resolve({ status: 'not_sent', reason: 'stopped', message: 'Stopped before it was sent.' })
  const { promise, resolve } = Promise.withResolvers<ExecutorAnswer<JsonValue>>()
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
  let written = false
  let ending: 'timeout' | 'stopped' | undefined
  const route = `${options.method} ${options.path}`
  const outgoing = request({
    host: options.host,
    port: options.port,
    method: options.method,
    path: options.path,
    agent: false,
    headers: { connection: 'close', ...(payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': payload.length }) },
  })
  const settle = (answer: ExecutorAnswer<JsonValue>): void => {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    resolve(answer)
  }
  const unanswered = (reason: 'timeout' | 'stopped' | 'connection_lost', message: string): void => {
    if (!written) {
      settle({ status: 'not_sent', reason: reason === 'connection_lost' ? 'incomplete' : reason, message: `${route}: ${message} before the request left whole.` })
      return
    }
    settle({ status: 'unknown', reason, message: `${route}: ${message}.`, durationMs: elapsedMs(startedAt) })
  }
  const timer = setTimeout(() => {
    ending ??= 'timeout'
    outgoing.destroy()
  }, Math.max(1, options.timeoutMs))
  const onAbort = (): void => {
    ending ??= 'stopped'
    outgoing.destroy()
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  outgoing.once('finish', () => {
    written = true
  })
  outgoing.once('error', (error) => {
    if (ending === 'timeout') return unanswered('timeout', `no answer within ${options.timeoutMs} ms`)
    if (ending === 'stopped') return unanswered('stopped', 'stopped')
    if (errorCode(error) === 'ECONNREFUSED') return settle({ status: 'not_sent', reason: 'connection_refused', message: `${route}: nothing listens on ${options.host}:${options.port}.` })
    unanswered('connection_lost', `the connection was lost (${errorMessage(error)})`)
  })
  outgoing.once('response', (response) => {
    readBody(response).then(
      (text) => {
        if (text === undefined) return settle({ status: 'unknown', reason: 'unreadable', message: `${route}: the answer was larger than ${answerLimit} bytes.`, durationMs: elapsedMs(startedAt) })
        settle(readAnswer(text, response.statusCode ?? 0, options.kind, route, elapsedMs(startedAt)))
      },
      (error: unknown) => {
        if (ending === 'timeout') return unanswered('timeout', `the answer did not finish within ${options.timeoutMs} ms`)
        if (ending === 'stopped') return unanswered('stopped', 'stopped while the answer came')
        unanswered('connection_lost', `the connection was lost during the answer (${errorMessage(error)})`)
      },
    )
  })
  outgoing.end(payload)
  return promise
}

function readBody(response: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    response.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > answerLimit) {
        response.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    let ended = false
    response.once('end', () => {
      ended = true
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    response.once('error', reject)
    response.once('close', () => {
      if (!ended) reject(new Error('the answer was cut off'))
    })
  })
}

function readAnswer(text: string, httpStatus: number, kind: 'json' | 'text', route: string, durationMs: number): ExecutorAnswer<JsonValue> {
  if (kind === 'text') return { status: 'answered', value: text.slice(0, 200), durationMs }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { status: 'unknown', reason: 'unreadable', message: `${route}: the answer is not JSON (HTTP ${httpStatus}, ${text.length} characters).`, durationMs }
  }
  const value = isPlainObject(parsed) ? parsed['value'] : undefined
  if (isPlainObject(value) && typeof value['error'] === 'string') {
    const message = typeof value['message'] === 'string' ? value['message'].slice(0, 500) : 'no message'
    return { status: 'refused', error: value['error'], message, httpStatus, durationMs }
  }
  if (value === undefined || !isJsonValue(value)) return { status: 'unknown', reason: 'unreadable', message: `${route}: the answer has no value (HTTP ${httpStatus}).`, durationMs }
  if (httpStatus < 200 || httpStatus >= 300) return { status: 'unknown', reason: 'unreadable', message: `${route}: HTTP ${httpStatus} without a WebDriver error.`, durationMs }
  return { status: 'answered', value, durationMs }
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return isPlainObject(value) && Object.values(value).every(isJsonValue)
}

// The interaction layer's routes. They are listed apart from `executorRoutes`, which names the lifecycle client's own,
// so each list says exactly what its layer sends. None of them types, clears or repeats input: finding elements and
// reading one element's attribute or frame send no input at all; WebDriverAgent's alert answers tap one button once;
// the macOS runner's element scroll is one XCTest scroll by the deltas given.

/**
 * The interaction layer's routes, as `METHOD path` with `:session`, `:element` and `:name` standing for ids and an
 * attribute's name. With `executorRoutes` they are every route Retest sends an executor.
 */
export type ElementRoute =
  | 'POST /session/:session/elements'
  | 'POST /session/:session/element/:element/elements'
  | 'GET /session/:session/element/:element/attribute/:name'
  | 'GET /session/:session/element/:element/rect'
  | 'GET /session/:session/alert/text'
  | 'GET /session/:session/wda/alert/buttons'
  | 'POST /session/:session/alert/accept'
  | 'POST /session/:session/alert/dismiss'
  | 'POST /session/:session/wda/element/:element/scroll'

/** The interaction layer's routes, for a reader that checks what it can send. */
export const elementRoutes: readonly ElementRoute[] = [
  'POST /session/:session/elements',
  'POST /session/:session/element/:element/elements',
  'GET /session/:session/element/:element/attribute/:name',
  'GET /session/:session/element/:element/rect',
  'GET /session/:session/alert/text',
  'GET /session/:session/wda/alert/buttons',
  'POST /session/:session/alert/accept',
  'POST /session/:session/alert/dismiss',
  'POST /session/:session/wda/element/:element/scroll',
]

type ElementRouteIds = { readonly element?: string; readonly name?: string }

function routeTarget(route: ExecutorRoute | ElementRoute, session: string, ids: ElementRouteIds): { readonly method: string; readonly path: string } {
  const [method = 'GET', template = '/'] = route.split(' ')
  const path = template
    .replace(':session', encodeURIComponent(session))
    .replace(':element', encodeURIComponent(ids.element ?? ''))
    .replace(':name', encodeURIComponent(ids.name ?? ''))
  return { method, path }
}

/**
 * The interaction layer's requests on one executor session: finding elements by an exact predicate, reading one
 * element's attribute and frame, WebDriverAgent's alert routes and the macOS runner's element scroll. Each request has
 * its own deadline and outcome, as `ExecutorSession`'s do. Both share one ended state: once either learns the session
 * has ended, nothing more goes from either.
 */
export class ExecutorElements {
  readonly executor: ExecutorName
  readonly #client: ExecutorClient
  readonly #session: ExecutorSession

  constructor(client: ExecutorClient, session: ExecutorSession) {
    this.executor = session.executor
    this.#client = client
    this.#session = session
  }

  /** Why nothing more is sent on this session, or undefined while it is live. */
  get ended(): string | undefined {
    return this.#session.ended
  }

  /**
   * The ids of every element a predicate matches, in the executor's order: in the app, or inside `within`, which the
   * executors count among the matches when it matches itself. Sends no input.
   */
  async findElements(predicate: string, within: string | undefined, bounds: RequestBounds): Promise<ExecutorAnswer<readonly string[]>> {
    const body = { using: 'predicate string', value: predicate }
    const answer = within === undefined ? await this.#send('POST /session/:session/elements', {}, body, bounds) : await this.#send('POST /session/:session/element/:element/elements', { element: within }, body, bounds)
    return mapAnswer(answer, (value) => {
      if (!isJsonList(value)) return undefined
      const ids = value.map((entry) => elementId(entry))
      return ids.every((id): id is string => id !== undefined) ? ids : undefined
    })
  }

  /** One attribute of one element as the executor writes it: WebDriverAgent's booleans as JSON, the macOS runner's as `"true"` or `"false"`. Sends no input. */
  async elementAttribute(element: string, name: string, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    return this.#send('GET /session/:session/element/:element/attribute/:name', { element, name }, undefined, bounds)
  }

  /** One element's frame in points. Sends no input. */
  async elementRect(element: string, bounds: RequestBounds): Promise<ExecutorAnswer<Rect>> {
    return mapAnswer(await this.#send('GET /session/:session/element/:element/rect', { element }, undefined, bounds), readRect)
  }

  /** The text of the alert in front, as WebDriverAgent joins its texts. Sends no input. */
  async alertText(bounds: RequestBounds): Promise<ExecutorAnswer<string>> {
    if (this.executor !== 'webdriveragent') return wrongExecutor('alertText', this.executor)
    return mapAnswer(await this.#send('GET /session/:session/alert/text', {}, undefined, bounds), (value) => (typeof value === 'string' ? value : undefined))
  }

  /** The labels of the alert's buttons, in the order WebDriverAgent reads them. Sends no input. */
  async alertButtons(bounds: RequestBounds): Promise<ExecutorAnswer<readonly string[]>> {
    if (this.executor !== 'webdriveragent') return wrongExecutor('alertButtons', this.executor)
    return mapAnswer(await this.#send('GET /session/:session/wda/alert/buttons', {}, undefined, bounds), (value) => {
      if (!isJsonList(value)) return undefined
      const labels = value.filter((label): label is string => typeof label === 'string')
      return labels.length === value.length ? labels : undefined
    })
  }

  /**
   * Taps the alert's button with this label once, through the accept route. WebDriverAgent taps the first button with
   * the label, so a caller makes sure only one has it.
   */
  async acceptAlert(button: string, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    if (this.executor !== 'webdriveragent') return wrongExecutor('acceptAlert', this.executor)
    return this.#send('POST /session/:session/alert/accept', {}, { name: button }, bounds)
  }

  /** Taps the alert's button with this label once, through the dismiss route, as `acceptAlert` does. */
  async dismissAlert(button: string, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    if (this.executor !== 'webdriveragent') return wrongExecutor('dismissAlert', this.executor)
    return this.#send('POST /session/:session/alert/dismiss', {}, { name: button }, bounds)
  }

  /** The macOS runner's one XCTest scroll over an element, by exactly these deltas in points. */
  async scrollElement(element: string, delta: { readonly x: number; readonly y: number }, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    if (this.executor !== 'mac2') return wrongExecutor('scrollElement', this.executor)
    return this.#send('POST /session/:session/wda/element/:element/scroll', { element }, { deltaX: delta.x, deltaY: delta.y }, bounds)
  }

  async #send(route: ElementRoute, ids: ElementRouteIds, body: JsonValue | undefined, bounds: RequestBounds): Promise<ExecutorAnswer<JsonValue>> {
    const ended = this.ended
    if (ended !== undefined) return { status: 'not_sent', reason: 'session_ended', message: ended }
    const target = routeTarget(route, this.#session.id, ids)
    const answer = await exchange({ host: this.#client.host, port: this.#client.port, ...target, body, kind: 'json', ...bounds })
    // The executor no longer knows this session: nothing more goes on it from this layer or the session's own.
    if (answer.status === 'refused' && answer.error === 'invalid session id') this.#session.markEnded(`The executor no longer knows session ${this.#session.id}: ${answer.message}`)
    return answer
  }
}

function isJsonList(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value)
}
