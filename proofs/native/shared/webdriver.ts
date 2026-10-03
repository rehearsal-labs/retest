/** A JSON value as the executors send and receive it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { readonly [key: string]: JsonValue }

/** A JSON object. */
export type JsonObject = { readonly [key: string]: JsonValue }

/**
 * The lookup strategies both XCTest executors accept. `accessibility id` means different things on each:
 * WebDriverAgentMac asks XCTest for the identifier, WebDriverAgent on iOS takes the identifier and falls back to
 * the label only when the identifier is empty.
 */
export type Strategy = 'accessibility id' | 'class name' | 'predicate string' | 'class chain' | 'xpath'

/** One element lookup: a strategy and its value. */
export type Locator = {
  readonly using: Strategy
  readonly value: string
}

/** Where an element is on screen, in points. */
export type ElementRect = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * XCUIApplication.State as the executors report it. 4 is running in the foreground and 1 is not running.
 * Source: Apple's XCUIApplication.State documentation.
 */
export const APP_STATE: Readonly<Record<number, string>> = {
  0: 'unknown',
  1: 'not running',
  2: 'running in the background, suspended',
  3: 'running in the background',
  4: 'running in the foreground',
}

// The W3C element reference key. Both executors also send the legacy `ELEMENT` key with the same id.
const ELEMENT_KEY = 'element-6066-11e4-a52e-4f735466cecf'

/** A request the executor refused or never answered. `status` is 0 when no HTTP response arrived. */
export class WebDriverError extends Error {
  readonly route: string
  readonly status: number
  readonly error: string

  constructor(details: { readonly route: string; readonly status: number; readonly error: string; readonly message: string }) {
    super(`${details.route} failed: ${details.error}${details.status > 0 ? ` (HTTP ${details.status})` : ''}: ${details.message}`)
    this.name = 'WebDriverError'
    this.route = details.route
    this.status = details.status
    this.error = details.error
  }
}

/**
 * Whether a JSON value is an object rather than an array, a string, a number, a boolean or null.
 *
 * @example isJsonObject({ ready: true }) // true
 */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Describes any thrown value in one line, for a step record.
 *
 * @example describeError(new Error('gone')) // 'gone'
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message
  return String(error)
}

/**
 * Talks to one executor's HTTP server with Node's `fetch`. Every request has a deadline; a request that gets no
 * answer is reported as a transport failure, which for an action means its outcome is unknown.
 */
export class WebDriverClient {
  readonly baseUrl: string
  readonly #timeoutMs: number

  constructor(baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl
    this.#timeoutMs = timeoutMs
  }

  /**
   * Sends one command and returns the `value` of the answer. An HTTP error or a `value.error` throws a
   * WebDriverError naming the route, so a failed step says which command failed.
   *
   * @example await client.call('GET', '/status') // { ready: true, message: 'WebDriverAgent is ready to accept commands', … }
   */
  async call(method: 'GET' | 'POST' | 'DELETE', path: string, body?: JsonValue, timeoutMs?: number): Promise<JsonValue> {
    const route = `${method} ${path}`
    let response: Response
    try {
      response = await fetch(new URL(path, this.baseUrl), {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? null : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? this.#timeoutMs),
      })
    } catch (error) {
      throw new WebDriverError({ route, status: 0, error: 'no answer', message: describeError(error) })
    }
    const text = await response.text()
    let parsed: JsonValue
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new WebDriverError({ route, status: response.status, error: 'not JSON', message: `${text.length} characters` })
    }
    const value = isJsonObject(parsed) ? parsed['value'] : undefined
    if (value === undefined) {
      throw new WebDriverError({ route, status: response.status, error: 'no value', message: 'the answer has no value field' })
    }
    if (isJsonObject(value) && typeof value['error'] === 'string') {
      const message = typeof value['message'] === 'string' ? value['message'] : 'no message'
      throw new WebDriverError({ route, status: response.status, error: value['error'], message })
    }
    if (!response.ok) throw new WebDriverError({ route, status: response.status, error: 'HTTP error', message: text.slice(0, 200) })
    return value
  }

  /**
   * Sends a request to a route that answers in plain text rather than WebDriver JSON, such as the shutdown routes,
   * and returns the status and text.
   *
   * @example await client.send('DELETE', '/') // { status: 200, text: 'Shutting down' }
   */
  async send(method: 'GET' | 'DELETE', path: string): Promise<{ readonly status: number; readonly text: string }> {
    try {
      const response = await fetch(new URL(path, this.baseUrl), { method, signal: AbortSignal.timeout(this.#timeoutMs) })
      return { status: response.status, text: (await response.text()).slice(0, 200) }
    } catch (error) {
      throw new WebDriverError({ route: `${method} ${path}`, status: 0, error: 'no answer', message: describeError(error) })
    }
  }

  /**
   * Reads `/status`, which the runner serves before any session exists.
   *
   * @example (await client.status())['ready'] // true
   */
  async status(timeoutMs?: number): Promise<JsonObject> {
    const value = await this.call('GET', '/status', undefined, timeoutMs)
    if (!isJsonObject(value)) throw new WebDriverError({ route: 'GET /status', status: 200, error: 'unexpected value', message: typeof value })
    return value
  }
}

/** A session on one executor. Element ids are the executor's own and live only as long as its element cache. */
export class WebDriverSession {
  readonly id: string
  readonly capabilities: JsonObject
  readonly #client: WebDriverClient

  constructor(client: WebDriverClient, id: string, capabilities: JsonObject) {
    this.#client = client
    this.id = id
    this.capabilities = capabilities
  }

  /**
   * Creates a session with W3C `alwaysMatch` capabilities. Both executors launch the app named by `bundleId`.
   *
   * @example await WebDriverSession.create(client, { bundleId: 'com.apple.TextEdit' })
   */
  static async create(client: WebDriverClient, capabilities: JsonObject, timeoutMs?: number): Promise<WebDriverSession> {
    const value = await client.call('POST', '/session', { capabilities: { alwaysMatch: capabilities, firstMatch: [{}] } }, timeoutMs)
    const id = isJsonObject(value) ? value['sessionId'] : undefined
    if (typeof id !== 'string' || id.length === 0) {
      throw new WebDriverError({ route: 'POST /session', status: 200, error: 'no session id', message: 'the answer names no session' })
    }
    const granted = isJsonObject(value) ? value['capabilities'] : undefined
    return new WebDriverSession(client, id, isJsonObject(granted) ? granted : {})
  }

  /**
   * The one element matching the locator. No match, or more than one, throws with the count: an action or a check
   * acts on exactly one element, as Retest's own locators do, never on whichever came first.
   */
  async findOne(locator: Locator): Promise<string> {
    return exactlyOne(await this.findAll(locator), locator)
  }

  /** The one descendant of `parent` matching the locator; no match or several throws with the count. */
  async findOneWithin(parent: string, locator: Locator): Promise<string> {
    return exactlyOne(await this.findAllWithin(parent, locator), locator)
  }

  /** Every element matching the locator; an empty list when none match. */
  async findAll(locator: Locator): Promise<string[]> {
    return elementIds(await this.#call('POST', '/elements', locator), `find all ${locator.using}`)
  }

  /** Every descendant of `parent` matching the locator. */
  async findAllWithin(parent: string, locator: Locator): Promise<string[]> {
    return elementIds(await this.#call('POST', `/element/${parent}/elements`, locator), `find all ${locator.using} within`)
  }

  /** Clicks (macOS) or taps (iOS) the element's hit point once through XCTest. */
  async click(element: string): Promise<void> {
    await this.#call('POST', `/element/${element}/click`, {})
  }

  // There is deliberately no method for `/element/:id/value` or `/element/:id/clear`. WebDriverAgentMac's value
  // route clears by typing deletes, reads back and tries again with a double click; its clear route is the same
  // loop; WebDriverAgent's clear tries up to three times, the last with a triple tap, and its value route taps the
  // field first when it lacks focus. Input that may already have landed is never sent again here, so typing goes
  // through the key routes below, which send exactly what they are given.

  /**
   * WebDriverAgentMac: presses keys in the current app, in order, each once. A key is a character, an
   * `XCUIKeyboardKey…` name, or `{ key, modifierFlags }` with XCTest's modifier bits.
   */
  async pressKeys(keys: JsonValue[]): Promise<void> {
    await this.#call('POST', '/wda/keys', { keys })
  }

  /** WebDriverAgent on iOS: types `text` into the focused element as one synthesized typing event. */
  async typeIntoFocused(text: string): Promise<void> {
    await this.#call('POST', '/wda/keys', { value: [text] })
  }

  /** The element's text as the executor reads it: its value, else its label. */
  async text(element: string): Promise<string> {
    return expectString(await this.#call('GET', `/element/${element}/text`), 'element text')
  }

  /** One XCTest attribute, such as `identifier`, `label`, `value` or `elementType`. */
  async attribute(element: string, name: string): Promise<JsonValue> {
    return this.#call('GET', `/element/${element}/attribute/${name}`)
  }

  /** Where the element is, in points. */
  async rect(element: string): Promise<ElementRect> {
    return toRect(await this.#call('GET', `/element/${element}/rect`), 'GET rect')
  }

  /** WebDriverAgentMac: the main screen's frame in points (`NSScreen.mainScreen.frame`). */
  async mainScreenRect(): Promise<ElementRect> {
    return toRect(await this.#call('GET', '/window/rect'), 'GET /window/rect')
  }

  /** The current app's element tree as XML. It includes the menu bar; keep only `ownedWindowSource` of it. */
  async source(): Promise<string> {
    return expectString(await this.#call('GET', '/source'), 'source')
  }

  /** A PNG of the main screen (macOS) or the device screen (iOS). */
  async screenshot(): Promise<Buffer> {
    return Buffer.from(expectString(await this.#call('GET', '/screenshot'), 'screenshot'), 'base64')
  }

  /** A PNG of one element's frame, cropped from the screen. */
  async elementScreenshot(element: string): Promise<Buffer> {
    return Buffer.from(expectString(await this.#call('GET', `/element/${element}/screenshot`), 'element screenshot'), 'base64')
  }

  /** Brings an installed app to the foreground, launching it when it is not running. */
  async activateApp(bundleId: string): Promise<void> {
    await this.#call('POST', '/wda/apps/activate', { bundleId })
  }

  /** The app's XCUIApplication state number; see APP_STATE. */
  async appState(bundleId: string): Promise<number> {
    const value = await this.#call('POST', '/wda/apps/state', { bundleId })
    if (typeof value !== 'number') throw new WebDriverError({ route: 'POST /wda/apps/state', status: 200, error: 'unexpected value', message: typeof value })
    return value
  }

  /** Terminates the app; true when XCTest saw it stop. */
  async terminateApp(bundleId: string): Promise<boolean> {
    const value = await this.#call('POST', '/wda/apps/terminate', { bundleId })
    if (typeof value !== 'boolean') throw new WebDriverError({ route: 'POST /wda/apps/terminate', status: 200, error: 'unexpected value', message: typeof value })
    return value
  }

  /** Ends the session. The runner keeps serving until it is shut down. */
  async end(): Promise<void> {
    await this.#client.call('DELETE', `/session/${this.id}`)
  }

  async #call(method: 'GET' | 'POST' | 'DELETE', suffix: string, body?: JsonValue): Promise<JsonValue> {
    return this.#client.call(method, `/session/${this.id}${suffix}`, body)
  }
}

function elementId(value: JsonValue, route: string): string {
  const id = isJsonObject(value) ? (value[ELEMENT_KEY] ?? value['ELEMENT']) : undefined
  if (typeof id !== 'string') throw new WebDriverError({ route, status: 200, error: 'no element reference', message: 'the answer is not an element' })
  return id
}

function exactlyOne(ids: readonly string[], locator: Locator): string {
  const [only] = ids
  if (only === undefined || ids.length !== 1) throw new Error(`${locator.using} ${JSON.stringify(locator.value)} matched ${ids.length} elements; exactly one is required`)
  return only
}

function toRect(value: JsonValue, route: string): ElementRect {
  if (!isJsonObject(value)) throw new WebDriverError({ route, status: 200, error: 'unexpected value', message: typeof value })
  const read = (key: string): number => {
    const number = value[key]
    if (typeof number !== 'number') throw new WebDriverError({ route, status: 200, error: 'unexpected value', message: `${key} is not a number` })
    return number
  }
  return { x: read('x'), y: read('y'), width: read('width'), height: read('height') }
}

function elementIds(value: JsonValue, route: string): string[] {
  if (!Array.isArray(value)) throw new WebDriverError({ route, status: 200, error: 'unexpected value', message: 'the answer is not a list' })
  return value.map((item) => elementId(item, route))
}

function expectString(value: JsonValue, route: string): string {
  if (typeof value !== 'string') throw new WebDriverError({ route, status: 200, error: 'unexpected value', message: typeof value })
  return value
}
