import type { BidiClient } from './bidi-client.ts'
import type { Schema } from '../../src/protocol/schema.ts'
import { setTimeout as sleep } from 'node:timers/promises'
import { s } from '../../src/protocol/schema.ts'
import { readBidi } from './bidi-client.ts'

/**
 * The name of Retest's own sandbox in every document. Firefox gives each sandbox name its own realm: scripts there
 * see the page's DOM, but not the page's globals or its changes to built-in prototypes, and the page sees none of
 * theirs.
 */
export const sandboxName = 'retest'

export type Viewport = { width: number; height: number }

/** A top-level browsing context, a tab, and the user context it belongs to. */
export type Tab = { client: BidiClient; context: string; userContext: string }

/** A node as `browsingContext.locateNodes` names it. The reference holds while its document lives. */
export type ElementReference = { sharedId: string }

/** A value passed to a page function: a string, a number, or an element found earlier. */
export type PageArgument = string | number | ElementReference

/** A cookie as `storage.getCookies` reports it, with only the fields the proof reads. */
export type BrowserCookie = { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean }

/** No element, or more than one, matched a locator. Retest's locators are strict: an action needs exactly one. */
export class LocatorError extends Error {
  override readonly name = 'LocatorError'
}

/** The element cannot take input where a person would give it, such as one another element covers. */
export class NotActionableError extends Error {
  override readonly name = 'NotActionableError'
}

/** A page function threw. The message is the exception's text as the browser reports it. */
export class PageScriptError extends Error {
  override readonly name = 'PageScriptError'
}

const emptySchema = s.object({})
const userContextSchema = s.object({ userContext: s.string() })
const contextSchema = s.object({ context: s.string() })
const navigationSchema = s.object({ navigation: s.nullable(s.string()), url: s.string() })
const nodesSchema = s.object({ nodes: s.array(s.object({ sharedId: s.string() })) })
const screenshotSchema = s.object({ data: s.string() })
const callSchema = s.object({
  type: s.enum(['success', 'exception']),
  result: s.optional(s.object({ type: s.string(), value: s.optional(s.string()) })),
  exceptionDetails: s.optional(s.object({ text: s.string() })),
})
const cookiesSchema = s.object({
  cookies: s.array(
    s.object({
      name: s.string(),
      value: s.object({ type: s.string(), value: s.string() }),
      domain: s.string(),
      path: s.string(),
      httpOnly: s.boolean(),
      secure: s.boolean(),
    }),
  ),
})
const pointSchema = s.object({ x: s.optional(s.number()), y: s.optional(s.number()), problem: s.optional(s.string()) })

// Scrolls the element to the middle of the viewport, as a person would bring it into view, then names its centre
// only if that is where the element is: present, sized, enabled and the topmost element at that point.
const targetPointFunction = `(element) => {
  if (!element.isConnected) return { problem: 'the element is no longer in the document' }
  if (element.disabled === true) return { problem: 'the element is disabled' }
  element.scrollIntoView({ block: 'center', inline: 'center' })
  const box = element.getBoundingClientRect()
  if (box.width === 0 || box.height === 0) return { problem: 'the element has no size' }
  const x = Math.round(box.left + box.width / 2)
  const y = Math.round(box.top + box.height / 2)
  const hit = document.elementFromPoint(x, y)
  if (hit === null || !(hit === element || element.contains(hit))) return { problem: 'another element covers its centre' }
  return { x, y }
}`

/**
 * Makes a user context: its own cookies, storage and cache, which nothing else in the browser shares.
 *
 * @example const userContext = await createUserContext(client, 5000)
 */
export async function createUserContext(client: BidiClient, timeoutMs: number): Promise<string> {
  return (await client.request('browser.createUserContext', {}, userContextSchema, { timeoutMs })).userContext
}

/**
 * Opens a tab in a user context, with its viewport set to `viewport` CSS pixels at a device pixel ratio of 1, so a
 * screenshot of it has exactly that many pixels.
 *
 * @example const tab = await openTab(client, userContext, { width: 1280, height: 720 }, 5000)
 */
export async function openTab(client: BidiClient, userContext: string, viewport: Viewport, timeoutMs: number): Promise<Tab> {
  const { context } = await client.request('browsingContext.create', { type: 'tab', userContext }, contextSchema, { timeoutMs })
  await client.request('browsingContext.setViewport', { context, viewport, devicePixelRatio: 1 }, emptySchema, { timeoutMs })
  return { client, context, userContext }
}

/**
 * Opens a URL in the tab and waits until its document's `load` event, as `wait: 'complete'` asks. Resolves with
 * the navigation's id, which the navigation events name, and the URL the browser reports.
 *
 * @example await navigate(tab, `${app.url}/login`, 10_000)
 */
export async function navigate(tab: Tab, url: string, timeoutMs: number): Promise<{ navigation: string | null; url: string }> {
  return tab.client.request('browsingContext.navigate', { context: tab.context, url, wait: 'complete' }, navigationSchema, { timeoutMs })
}

/**
 * Finds the one element with an accessibility role and name, as Firefox's accessibility tree computes them.
 *
 * @example const save = await locateByRole(tab, 'button', 'Save', 2000)
 */
export function locateByRole(tab: Tab, role: string, name: string, timeoutMs: number): Promise<ElementReference> {
  return locateOne(tab, { type: 'accessibility', value: { role, name } }, `the role ${role} and the name "${name}"`, timeoutMs)
}

/**
 * Finds the one element whose `data-testid` is `testId`.
 *
 * @example const title = await locateByTestId(tab, 'task-title', 2000)
 */
export function locateByTestId(tab: Tab, testId: string, timeoutMs: number): Promise<ElementReference> {
  return locateOne(tab, { type: 'css', value: `[data-testid="${cssString(testId)}"]` }, `the test id "${testId}"`, timeoutMs)
}

/**
 * Calls a function in Retest's sandbox of the tab's current document. Its answer comes back as JSON text and is
 * validated against `schema`.
 *
 * @example const text = await callInSandbox(tab, '(element) => element.innerText', [save], s.string(), 2000)
 */
export function callInSandbox<T>(tab: Tab, functionDeclaration: string, args: readonly PageArgument[], schema: Schema<T>, timeoutMs: number): Promise<T> {
  return callIn(tab, { context: tab.context, sandbox: sandboxName }, { functionDeclaration, args, schema, timeoutMs })
}

/**
 * Calls a function in the page's own realm, where the page's scripts run. The proof uses it only to stand in for
 * the page: to set a page global, or to make the page log or throw.
 *
 * @example await callInPage(tab, '() => { window.flag = 1 }', [], s.literal(null), 2000)
 */
export function callInPage<T>(tab: Tab, functionDeclaration: string, args: readonly PageArgument[], schema: Schema<T>, timeoutMs: number): Promise<T> {
  return callIn(tab, { context: tab.context }, { functionDeclaration, args, schema, timeoutMs })
}

/**
 * Reads an element's visible text, `innerText`, from Retest's sandbox.
 *
 * @example await readText(tab, save, 2000) // 'Save'
 */
export function readText(tab: Tab, element: ElementReference, timeoutMs: number): Promise<string> {
  return callInSandbox(tab, '(element) => element.innerText', [element], s.string(), timeoutMs)
}

/**
 * Clicks an element with the mouse at its centre: a move, a press and a release of the left button, which the
 * browser dispatches as real input. The element must be the topmost one at that point, or nothing is sent.
 *
 * @example await click(tab, save, 2000)
 */
export async function click(tab: Tab, element: ElementReference, timeoutMs: number): Promise<{ x: number; y: number }> {
  const point = await callInSandbox(tab, targetPointFunction, [element], pointSchema, timeoutMs)
  if (point.problem !== undefined || point.x === undefined || point.y === undefined) {
    throw new NotActionableError(`Cannot click the element: ${point.problem ?? 'no point was found'}`)
  }
  const mouse = {
    type: 'pointer',
    id: 'retest-mouse',
    parameters: { pointerType: 'mouse' },
    actions: [{ type: 'pointerMove', x: point.x, y: point.y, duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }],
  }
  await tab.client.request('input.performActions', { context: tab.context, actions: [mouse] }, emptySchema, { timeoutMs })
  return { x: point.x, y: point.y }
}

/**
 * Types text on the keyboard into whatever has the focus, one key down and up for each character.
 *
 * @example await typeText(tab, 'Release checklist', 2000)
 */
export async function typeText(tab: Tab, text: string, timeoutMs: number): Promise<void> {
  const actions = Array.from(text).flatMap((value) => [
    { type: 'keyDown', value },
    { type: 'keyUp', value },
  ])
  const keyboard = { type: 'key', id: 'retest-keyboard', actions }
  await tab.client.request('input.performActions', { context: tab.context, actions: [keyboard] }, emptySchema, { timeoutMs })
}

/**
 * Captures the tab's viewport as a PNG.
 *
 * @example const png = await screenshot(tab, 5000)
 */
export async function screenshot(tab: Tab, timeoutMs: number): Promise<Buffer> {
  const params = { context: tab.context, origin: 'viewport', format: { type: 'image/png' } }
  const { data } = await tab.client.request('browsingContext.captureScreenshot', params, screenshotSchema, { timeoutMs })
  return Buffer.from(data, 'base64')
}

/**
 * Reads every cookie of a user context, those page scripts cannot read included, such as `HttpOnly` ones.
 *
 * @example const cookies = await readCookies(client, userContext, 2000)
 */
export async function readCookies(client: BidiClient, userContext: string, timeoutMs: number): Promise<BrowserCookie[]> {
  const params = { partition: { type: 'storageKey', userContext } }
  const { cookies } = await client.request('storage.getCookies', params, cookiesSchema, { timeoutMs })
  return cookies.map((cookie) => ({ ...cookie, value: cookie.value.value }))
}

/**
 * Reads again until `expected` holds, as an assertion looks again, or fails naming the last reading. Never acts.
 *
 * @example await readUntil(() => readText(tab, saved, 1000), (text) => text === 'Release checklist', 5000)
 */
export async function readUntil<T>(read: () => Promise<T>, expected: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const end = performance.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (expected(value)) return value
    if (performance.now() > end) throw new Error(`Still read ${JSON.stringify(value)} after ${timeoutMs} ms`)
    await sleep(25)
  }
}

/** An event as the recorder kept it: when it arrived, and how many commands were still waiting for a response then. */
export type EventRecord = { method: string; params: unknown; atMs: number; commandsWaiting: number }

/**
 * Keeps every event of `methods` from the moment it is made. A wait first looks at what already arrived, because
 * Firefox can send an event before the response of the command that caused it, and a listener added after that
 * response would never hear it.
 *
 * @example const recorder = new EventRecorder(client, ['log.entryAdded']); await recorder.waitFor('log.entryAdded', isError, 3000)
 */
export class EventRecorder {
  readonly records: EventRecord[] = []
  readonly #client: BidiClient
  readonly #startedAt: number
  readonly #stops: (() => void)[]

  constructor(client: BidiClient, methods: readonly string[], startedAt: number = performance.now()) {
    this.#client = client
    this.#startedAt = startedAt
    this.#stops = methods.map((method) =>
      client.on(method, (params) => {
        this.records.push({ method, params, atMs: Math.round(performance.now() - this.#startedAt), commandsWaiting: client.waiting })
      }),
    )
  }

  /** Resolves with the first record of `method` that `matches`, already kept or still to come, or rejects after `timeoutMs`. */
  waitFor(method: string, matches: (params: unknown) => boolean, timeoutMs: number): Promise<EventRecord> {
    const kept = this.records.find((record) => record.method === method && matches(record.params))
    if (kept !== undefined) return Promise.resolve(kept)
    const { promise, resolve, reject } = Promise.withResolvers<EventRecord>()
    const timer = setTimeout(() => {
      stop()
      reject(new Error(`No ${method} event arrived within ${timeoutMs} ms`))
    }, timeoutMs)
    // Added after the recorder's own listener, so the record it resolves with is already kept.
    const stop = this.#client.on(method, (params) => {
      if (!matches(params)) return
      const record = this.records.findLast((candidate) => candidate.params === params)
      if (record === undefined) return
      clearTimeout(timer)
      stop()
      resolve(record)
    })
    return promise
  }

  /** Stops keeping events. What was kept stays. */
  stop(): void {
    for (const stop of this.#stops) stop()
  }
}

async function locateOne(tab: Tab, locator: object, description: string, timeoutMs: number): Promise<ElementReference> {
  // Two are enough to tell one match from several.
  const params = { context: tab.context, locator, maxNodeCount: 2 }
  const { nodes } = await tab.client.request('browsingContext.locateNodes', params, nodesSchema, { timeoutMs })
  const [only, another] = nodes
  if (only === undefined) throw new LocatorError(`No element has ${description}.`)
  if (another !== undefined) throw new LocatorError(`More than one element has ${description}.`)
  return only
}

type Call<T> = { functionDeclaration: string; args: readonly PageArgument[]; schema: Schema<T>; timeoutMs: number }

async function callIn<T>(tab: Tab, target: object, { functionDeclaration, args, schema, timeoutMs }: Call<T>): Promise<T> {
  // One string comes back instead of a tree of remote values, and an answer of undefined arrives as null.
  const wrapped = `async (...args) => JSON.stringify((await (${functionDeclaration})(...args)) ?? null)`
  const params = { functionDeclaration: wrapped, target, arguments: args.map(localValue), awaitPromise: true, resultOwnership: 'none' }
  const method = 'script.callFunction'
  const outcome = await tab.client.request(method, params, callSchema, { timeoutMs })
  if (outcome.type === 'exception') throw new PageScriptError(`A page function threw: ${outcome.exceptionDetails?.text ?? 'no text given'}`)
  if (outcome.result?.type !== 'string' || outcome.result.value === undefined) throw new PageScriptError('A page function answered with something other than JSON text.')
  return readBidi(schema, JSON.parse(outcome.result.value), method)
}

function localValue(argument: PageArgument): object {
  if (typeof argument === 'string') return { type: 'string', value: argument }
  if (typeof argument === 'number') return { type: 'number', value: argument }
  return { type: 'sharedReference', sharedId: argument.sharedId }
}

// A CSS string in double quotes: a backslash escapes the next character, and a line break is written as its code.
function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&').replace(/\n/g, '\\a ')
}
