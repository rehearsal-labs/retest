import type { KeyStroke } from './keys.ts'
import type { PageProxyEvent, TargetEvent, WkConnection } from './wk-client.ts'
import { isRecord } from '../../src/browser/cdp/message.ts'
import { Listeners } from '../../src/browser/listeners.ts'
import { Deadline } from '../../src/protocol/deadline.ts'
import { keyStrokes, SHIFT_KEY, SHIFT_MODIFIER } from './keys.ts'

export type Viewport = { readonly width: number; readonly height: number }

/** An event from the page's committed target or from the provisional target a navigation is loading into. */
export type PageEvent = { readonly targetId: string; readonly method: string; readonly params: unknown }

/** A navigation that moved the page into a new web process, as `Target.didCommitProvisionalTarget` reports it. */
export type ProcessSwap = { readonly from: string; readonly to: string }

/** An element found in the page, as a remote object of the target that found it. */
export type WkElement = { readonly objectId: string; readonly targetId: string; readonly description: string }

export type WkCookie = { readonly name: string; readonly domain: string; readonly httpOnly: boolean }

/** What lies under an element's centre: whether the element itself is hit, and the topmost element there. */
export type HitTarget = {
  readonly point: { readonly x: number; readonly y: number }
  readonly hitsElement: boolean
  readonly top: { readonly tag: string; readonly testId: string | null; readonly position: string } | null
}

type MainFrameNavigation = { targetId: string; frameId: string; loaderId: string; url: string; loaded: boolean }

const pollMs = 50

/** The browser end of the protocol: contexts, and the pages it reports as their page proxies appear. */
export type WkBrowserOptions = {
  viewport: Viewport
  /** A listener on a page that failed. It never stops the page or the other listeners. */
  onDiagnostic: (problem: string) => void
}

export class WkBrowser {
  readonly connection: WkConnection
  readonly viewport: Viewport
  readonly onDiagnostic: (problem: string) => void
  readonly #pages = new Map<string, WkPage>()

  /**
   * Turns on the `Playwright` domain, which reports page proxies and owns contexts.
   *
   * @example const browser = await WkBrowser.connect(connection, { viewport: { width: 1280, height: 720 }, onDiagnostic })
   */
  static async connect(connection: WkConnection, options: WkBrowserOptions): Promise<WkBrowser> {
    const browser = new WkBrowser(connection, options)
    await connection.send('Playwright.enable')
    return browser
  }

  constructor(connection: WkConnection, options: WkBrowserOptions) {
    this.connection = connection
    this.viewport = options.viewport
    this.onDiagnostic = options.onDiagnostic
    // A page's own listeners are added while its proxy is announced, before the browser sends anything for it.
    connection.onBrowserEvent('Playwright.pageProxyCreated', (params) => {
      const pageProxyId = readString(params, 'pageProxyId')
      const browserContextId = readString(params, 'browserContextId')
      this.#pages.set(pageProxyId, new WkPage(this, { pageProxyId, browserContextId }))
    })
    connection.onBrowserEvent('Playwright.pageProxyDestroyed', (params) => {
      const pageProxyId = readString(params, 'pageProxyId')
      this.#pages.get(pageProxyId)?.markClosed('the page was closed')
      this.#pages.delete(pageProxyId)
    })
    connection.onBrowserEvent('Playwright.provisionalLoadFailed', (params) => {
      this.#pages.get(readString(params, 'pageProxyId'))?.markLoadFailed(readString(params, 'error'))
    })
    connection.onDisconnect((reason) => {
      for (const page of this.#pages.values()) page.markClosed(`the browser connection ended: ${reason}`)
    })
  }

  /**
   * Creates an isolated context: its own cookies, storage and cache, kept in memory.
   * @example const context = await browser.createContext()
   */
  async createContext(): Promise<WkContext> {
    const result = await this.connection.send('Playwright.createContext')
    return new WkContext(this, readString(result, 'browserContextId'))
  }

  /** The page announced for a page proxy, if it is still open. */
  page(pageProxyId: string): WkPage | undefined {
    return this.#pages.get(pageProxyId)
  }

  /** Asks the browser to close every page and exit. */
  async close(timeoutMs: number): Promise<void> {
    await this.connection.send('Playwright.close', undefined, { timeoutMs })
  }
}

export class WkContext {
  readonly id: string
  readonly #browser: WkBrowser

  constructor(browser: WkBrowser, id: string) {
    this.#browser = browser
    this.id = id
  }

  /**
   * Opens a page in this context and waits until its target is set up and running.
   * @example const page = await context.newPage(5000)
   */
  async newPage(timeoutMs: number): Promise<WkPage> {
    const deadline = new Deadline(timeoutMs)
    const result = await this.#browser.connection.send('Playwright.createPage', { browserContextId: this.id }, { timeoutMs })
    const pageProxyId = readString(result, 'pageProxyId')
    const page = this.#browser.page(pageProxyId)
    if (page === undefined) throw new Error(`The browser created page proxy ${pageProxyId} without announcing it`)
    await withDeadline(page.ready, deadline, `page proxy ${pageProxyId} to start its page target`)
    return page
  }

  /** Every cookie the context holds, by name and domain. Values are not read, since they can be secrets. */
  async cookies(): Promise<WkCookie[]> {
    const result = await this.#browser.connection.send('Playwright.getAllCookies', { browserContextId: this.id })
    const cookies = isRecord(result) ? result['cookies'] : undefined
    if (!Array.isArray(cookies)) throw new Error('Playwright.getAllCookies returned no cookie list')
    return cookies.map((cookie: unknown) => ({
      name: readString(cookie, 'name'),
      domain: readString(cookie, 'domain'),
      httpOnly: isRecord(cookie) && cookie['httpOnly'] === true,
    }))
  }

  /** Closes the context's pages and throws away its data. */
  async close(): Promise<void> {
    await this.#browser.connection.send('Playwright.deleteContext', { browserContextId: this.id })
  }
}

/**
 * One page: its page proxy, which takes input and emulation, and the page target in the web process, which takes
 * everything about the document. A cross-site navigation loads into a provisional target in a new process, which
 * is set up before it runs and becomes the page's target when the browser commits it.
 */
export class WkPage {
  readonly pageProxyId: string
  readonly browserContextId: string
  /** Settles once the first page target is set up and resumed. */
  readonly ready: Promise<void>
  readonly processSwaps: ProcessSwap[] = []
  readonly #browser: WkBrowser
  readonly #events: Listeners<PageEvent>
  readonly #stopListening: (() => void)[]
  readonly #readyResolvers = Promise.withResolvers<void>()
  #targetId: string | undefined
  #provisionalTargetId: string | undefined
  #closedReason: string | undefined
  #loadFailure: string | undefined

  constructor(browser: WkBrowser, ids: { pageProxyId: string; browserContextId: string }) {
    this.#browser = browser
    this.pageProxyId = ids.pageProxyId
    this.browserContextId = ids.browserContextId
    this.ready = this.#readyResolvers.promise
    // A page nobody opened through newPage, such as a popup, has nobody waiting on it to hear that it failed.
    this.ready.catch(() => undefined)
    this.#events = new Listeners<PageEvent>((error) => browser.onDiagnostic(`a page event listener failed: ${error instanceof Error ? error.message : String(error)}`))
    this.#stopListening = [
      browser.connection.onPageProxyEvent(this.pageProxyId, (event) => this.#onPageProxyEvent(event)),
      browser.connection.onTargetEvent(this.pageProxyId, (event) => this.#onTargetEvent(event)),
    ]
  }

  /** The committed page target. */
  get targetId(): string {
    if (this.#targetId === undefined) throw new Error(`Page proxy ${this.pageProxyId} has no page target yet`)
    return this.#targetId
  }

  /** Set once the page closed, crashed or lost its browser. */
  get closedReason(): string | undefined {
    return this.#closedReason
  }

  /** Listens for every event from the page's targets and returns a function that stops listening. */
  onEvent(listener: (event: PageEvent) => void): () => void {
    return this.#events.add(listener)
  }

  /** Stops the page for good: every later command is refused with `reason`. The browser calls it. */
  markClosed(reason: string): void {
    this.#closedReason ??= reason
    this.#readyResolvers.reject(new Error(reason))
    for (const stop of this.#stopListening) stop()
  }

  /** Notes that the browser gave up loading a navigation, which ends the wait for it. The browser calls it. */
  markLoadFailed(error: string): void {
    this.#loadFailure = error
  }

  /**
   * Navigates the main frame and waits for that navigation's load event.
   * @example await page.goto('http://127.0.0.1:4173/login', 10_000)
   */
  async goto(url: string, timeoutMs: number): Promise<{ url: string; loaderId: string }> {
    const deadline = new Deadline(timeoutMs)
    const watch = new LoadWatch(this)
    try {
      this.#loadFailure = undefined
      const result = await this.#browser.connection.send('Playwright.navigate', { url, pageProxyId: this.pageProxyId }, { timeoutMs: commandTimeout(deadline) })
      const loaderId = readString(result, 'loaderId')
      return await watch.until((navigation) => navigation.loaderId === loaderId, deadline, () => this.#problem())
    } finally {
      watch.stop()
    }
  }

  /**
   * Runs `action`, then waits for a main-frame navigation whose URL `matches` to load. The watch starts before the
   * action, so a navigation the action causes at once is not missed.
   */
  async waitForNavigation(action: () => Promise<unknown>, matches: (url: string) => boolean, timeoutMs: number): Promise<{ url: string; loaderId: string }> {
    const deadline = new Deadline(timeoutMs)
    const watch = new LoadWatch(this)
    try {
      await action()
      return await watch.until((navigation) => matches(navigation.url), deadline, () => this.#problem())
    } finally {
      watch.stop()
    }
  }

  /**
   * Evaluates an expression in the main world of the main frame and returns its value as JSON gives it.
   * @example await page.evaluate('document.title')
   */
  async evaluate(expression: string): Promise<unknown> {
    const result = await this.#send('Runtime.evaluate', { expression, returnByValue: true })
    return readValue(result)
  }

  /** Evaluates an expression that yields a promise and waits for it to settle. */
  async evaluateAwaiting(expression: string, timeoutMs: number): Promise<unknown> {
    const created = await this.#send('Runtime.evaluate', { expression })
    const promise = readRemoteObject(created)
    if (isRecord(created) && created['wasThrown'] === true) throw new Error(`The page threw: ${promise.description ?? 'no description'}`)
    if (promise.objectId === undefined) throw new Error('The expression did not yield an object to wait on')
    return readValue(await this.#send('Runtime.awaitPromise', { promiseObjectId: promise.objectId, returnByValue: true }, timeoutMs))
  }

  /** Evaluates `expression` again until it is truthy or the time runs out, and returns its last value. */
  async waitForFunction(expression: string, timeoutMs: number): Promise<unknown> {
    const deadline = new Deadline(timeoutMs)
    for (;;) {
      const value = await this.evaluate(expression)
      if (value) return value
      if (deadline.expired) throw new Error(`Waited ${timeoutMs} ms for ${expression}`)
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, deadline.remainingMs)))
    }
  }

  /**
   * The one element whose `data-testid` is `testId`. None or several is an error that says how many.
   * @example const title = await page.getByTestId('task-title')
   */
  async getByTestId(testId: string): Promise<WkElement> {
    const description = `getByTestId(${JSON.stringify(testId)})`
    const root = await this.#documentNode()
    const result = await this.#send('DOM.querySelectorAll', { nodeId: root, selector: `[data-testid=${JSON.stringify(testId)}]` })
    return this.#only(readNodeIds(result), description)
  }

  /**
   * The one element whose role and accessible name, as WebKit's own accessibility code computes them through
   * `DOM.getAccessibilityPropertiesForNode`, are `role` and exactly `name`. Ignored nodes do not count.
   *
   * @example const button = await page.getByRole('button', 'Sign in')
   */
  async getByRole(role: string, name: string): Promise<WkElement> {
    const description = `getByRole(${JSON.stringify(role)}, { name: ${JSON.stringify(name)} })`
    const root = await this.#documentNode()
    const candidates = readNodeIds(await this.#send('DOM.querySelectorAll', { nodeId: root, selector: 'body *' }))
    const matches: number[] = []
    for (const nodeId of candidates) {
      const result = await this.#send('DOM.getAccessibilityPropertiesForNode', { nodeId })
      const properties = isRecord(result) ? result['properties'] : undefined
      if (!isRecord(properties) || properties['exists'] !== true || properties['ignored'] === true) continue
      if (properties['role'] === role && properties['label'] === name) matches.push(nodeId)
    }
    return this.#only(matches, description)
  }

  /** The element's `textContent`. */
  async text(element: WkElement): Promise<string> {
    const value = await this.#callOn(element, 'function () { return this.textContent }')
    if (typeof value !== 'string') throw new Error(`${element.description} has no text`)
    return value
  }

  /** The element's `value`, as a form field holds it. */
  async value(element: WkElement): Promise<string> {
    const value = await this.#callOn(element, 'function () { return this.value }')
    if (typeof value !== 'string') throw new Error(`${element.description} has no value`)
    return value
  }

  /**
   * Scrolls the element into view, reads its box from WebKit and asks the page what lies at the box's centre.
   * @example const { hitsElement, top } = await page.hitTarget(button)
   */
  async hitTarget(element: WkElement): Promise<HitTarget> {
    await this.#send('DOM.scrollIntoViewIfNeeded', { objectId: element.objectId })
    const point = centre(await this.#send('DOM.getContentQuads', { objectId: element.objectId }), element.description)
    const found = await this.#callOn(
      element,
      `function (x, y) {
        const top = document.elementFromPoint(x, y)
        if (top === null) return { hitsElement: false, top: null }
        return { hitsElement: top === this || this.contains(top), top: { tag: top.tagName, testId: top.getAttribute('data-testid'), position: getComputedStyle(top).position } }
      }`,
      [point.x, point.y],
    )
    if (!isRecord(found)) throw new Error(`The page did not say what lies under ${element.description}`)
    const top = found['top']
    return {
      point,
      hitsElement: found['hitsElement'] === true,
      top: isRecord(top) ? { tag: readString(top, 'tag'), testId: readOptionalString(top, 'testId') ?? null, position: readString(top, 'position') } : null,
    }
  }

  /**
   * Clicks the element's centre with the mouse: checks that the centre hits the element and not something over it,
   * then moves, presses and releases the left button with the given WebKit modifier bits held.
   *
   * @example await page.click(await page.getByRole('button', 'Save'))
   */
  async click(element: WkElement, options: { modifiers?: number } = {}): Promise<{ x: number; y: number }> {
    const { point, hitsElement } = await this.hitTarget(element)
    if (!hitsElement) throw new Error(`${element.description} is covered at (${point.x}, ${point.y}), so the click was not sent`)
    const modifiers = options.modifiers ?? 0
    await this.#mouse({ type: 'move', ...point, button: 'none', buttons: 0, modifiers })
    await this.#mouse({ type: 'down', ...point, button: 'left', buttons: 1, clickCount: 1, modifiers })
    await this.#mouse({ type: 'up', ...point, button: 'left', buttons: 0, clickCount: 1, modifiers })
    return point
  }

  /** Presses and releases one key with the given WebKit modifier bits held. */
  async press(stroke: KeyStroke, modifiers: number): Promise<void> {
    await this.#key('keyDown', stroke, modifiers)
    await this.#key('keyUp', stroke, modifiers)
  }

  /** Types into whatever has focus, one key press at a time: key down, then key up, with Shift for capitals. */
  async type(text: string): Promise<void> {
    for (const stroke of keyStrokes(text)) {
      if (stroke.shift) await this.#key('keyDown', SHIFT_KEY, SHIFT_MODIFIER)
      const modifiers = stroke.shift ? SHIFT_MODIFIER : 0
      await this.#key('keyDown', stroke, modifiers)
      await this.#key('keyUp', stroke, modifiers)
      if (stroke.shift) await this.#key('keyUp', SHIFT_KEY, 0)
    }
  }

  /**
   * The viewport as a PNG, from `Page.snapshotRect`.
   * @example await writeFile('page.png', await page.screenshot())
   */
  async screenshot(): Promise<Buffer> {
    const { width, height } = this.#browser.viewport
    const result = await this.#send('Page.snapshotRect', { x: 0, y: 0, width, height, coordinateSystem: 'Viewport' })
    const dataUrl = readString(result, 'dataURL')
    const prefix = 'data:image/png;base64,'
    if (!dataUrl.startsWith(prefix)) throw new Error(`Page.snapshotRect returned ${dataUrl.slice(0, 22)}…, not a PNG data URL`)
    return Buffer.from(dataUrl.slice(prefix.length), 'base64')
  }

  /** Closes the page. */
  async close(): Promise<void> {
    await this.#browser.connection.send('Playwright.closePage', { pageProxyId: this.pageProxyId })
  }

  #problem(): string | undefined {
    if (this.#closedReason !== undefined) return this.#closedReason
    return this.#loadFailure === undefined ? undefined : `the navigation failed: ${this.#loadFailure}`
  }

  #onPageProxyEvent({ method, params }: PageProxyEvent): void {
    if (method === 'Target.targetCreated') {
      const info = isRecord(params) ? params['targetInfo'] : undefined
      this.#attach(info).catch((error: unknown) => {
        const targetId = readOptionalString(info, 'targetId')
        this.#browser.onDiagnostic(`setting up target ${targetId ?? 'without an id'} failed: ${error instanceof Error ? error.message : String(error)}`)
        if (this.#targetId === undefined || this.#targetId === targetId) this.#readyResolvers.reject(error)
      })
    } else if (method === 'Target.didCommitProvisionalTarget') {
      const from = readString(params, 'oldTargetId')
      const to = readString(params, 'newTargetId')
      if (to !== this.#provisionalTargetId) {
        this.markClosed(`the browser committed target ${to}, which was not the provisional one, so the page's document is unknown`)
        return
      }
      this.#targetId = to
      this.#provisionalTargetId = undefined
      this.processSwaps.push({ from, to })
    } else if (method === 'Target.targetDestroyed') {
      const targetId = readString(params, 'targetId')
      if (targetId === this.#provisionalTargetId) this.#provisionalTargetId = undefined
      if (targetId === this.#targetId && isRecord(params) && params['crashed'] === true) this.markClosed('the page crashed')
    }
  }

  #onTargetEvent({ targetId, method, params }: TargetEvent): void {
    if (targetId !== this.#targetId && targetId !== this.#provisionalTargetId) return
    this.#events.emit({ targetId, method, params })
  }

  // A target starts paused, so every domain is on before its first script runs and nothing it does goes unheard.
  async #attach(info: unknown): Promise<void> {
    const targetId = readString(info, 'targetId')
    const paused = isRecord(info) && info['isPaused'] === true
    const provisional = isRecord(info) && info['isProvisional'] === true
    if (readString(info, 'type') !== 'page') {
      if (paused) await this.#toProxy('Target.resume', { targetId })
      return
    }
    if (provisional) this.#provisionalTargetId = targetId
    else this.#targetId = targetId
    const send = (method: string, params?: object) => this.#browser.connection.sendToTarget(this.pageProxyId, targetId, method, params)
    const setup: Promise<unknown>[] = [
      send('Page.enable'),
      send('Runtime.enable'),
      send('Console.enable'),
      send('Network.enable'),
    ]
    if (!provisional) {
      const { width, height } = this.#browser.viewport
      setup.push(this.#toProxy('Emulation.setDeviceMetricsOverride', { width, height, fixedLayout: false, deviceScaleFactor: 1 }))
      setup.push(this.#toProxy('Emulation.setActiveAndFocused', { active: true }))
    }
    await Promise.all(setup)
    if (paused) await this.#toProxy('Target.resume', { targetId })
    if (!provisional) this.#readyResolvers.resolve()
  }

  async #documentNode(): Promise<number> {
    const result = await this.#send('DOM.getDocument')
    const root = isRecord(result) ? result['root'] : undefined
    return readNumber(root, 'nodeId')
  }

  async #only(nodeIds: readonly number[], description: string): Promise<WkElement> {
    const [nodeId] = nodeIds
    if (nodeIds.length !== 1 || nodeId === undefined) throw new Error(`${description} matched ${nodeIds.length} elements, not one`)
    const targetId = this.targetId
    const resolved = await this.#send('DOM.resolveNode', { nodeId })
    const remote = isRecord(resolved) ? resolved['object'] : undefined
    const objectId = readOptionalString(remote, 'objectId')
    if (objectId === undefined) throw new Error(`${description} could not be resolved to an object`)
    return { objectId, targetId, description }
  }

  async #callOn(element: WkElement, functionDeclaration: string, values: readonly unknown[] = []): Promise<unknown> {
    if (element.targetId !== this.#targetId) throw new Error(`${element.description} belongs to a document this page has left`)
    const result = await this.#send('Runtime.callFunctionOn', {
      objectId: element.objectId,
      functionDeclaration,
      arguments: values.map((value) => ({ value })),
      returnByValue: true,
    })
    return readValue(result)
  }

  async #mouse(event: { type: string; x: number; y: number; button: string; buttons: number; clickCount?: number; modifiers: number }): Promise<void> {
    await this.#toProxy('Input.dispatchMouseEvent', event)
  }

  async #key(type: 'keyDown' | 'keyUp', stroke: KeyStroke, modifiers: number): Promise<void> {
    const text = type === 'keyDown' && stroke.text !== '' ? { text: stroke.text, unmodifiedText: stroke.text } : {}
    await this.#toProxy('Input.dispatchKeyEvent', { type, modifiers, key: stroke.key, code: stroke.code, windowsVirtualKeyCode: stroke.keyCode, ...text })
  }

  #send(method: string, params?: object, timeoutMs?: number): Promise<unknown> {
    if (this.#closedReason !== undefined) return Promise.reject(new Error(`${method} was not sent: ${this.#closedReason}`))
    const options = timeoutMs === undefined ? undefined : { timeoutMs }
    return this.#browser.connection.sendToTarget(this.pageProxyId, this.targetId, method, params, options)
  }

  #toProxy(method: string, params?: object): Promise<unknown> {
    return this.#browser.connection.sendToPageProxy(this.pageProxyId, method, params)
  }
}

/** Main-frame navigations and their load events, heard from the moment the watch starts. */
class LoadWatch {
  readonly #navigations: MainFrameNavigation[] = []
  readonly #stop: () => void
  #wake: (() => void) | undefined

  constructor(page: WkPage) {
    this.#stop = page.onEvent((event) => this.#hear(event))
  }

  async until(matches: (navigation: MainFrameNavigation) => boolean, deadline: Deadline, problem: () => string | undefined): Promise<{ url: string; loaderId: string }> {
    for (;;) {
      const loaded = this.#navigations.find((navigation) => navigation.loaded && matches(navigation))
      if (loaded !== undefined) return { url: loaded.url, loaderId: loaded.loaderId }
      const reason = problem()
      if (reason !== undefined) throw new Error(`The page did not load: ${reason}`)
      if (deadline.expired) throw new Error(`The page did not load within ${deadline.budgetMs} ms`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(pollMs, deadline.remainingMs))
        this.#wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
    }
  }

  stop(): void {
    this.#stop()
  }

  #hear({ targetId, method, params }: PageEvent): void {
    if (method === 'Page.frameNavigated') {
      const frame = isRecord(params) ? params['frame'] : undefined
      if (!isRecord(frame) || frame['parentId'] !== undefined) return
      this.#navigations.push({ targetId, frameId: readString(frame, 'id'), loaderId: readString(frame, 'loaderId'), url: readString(frame, 'url'), loaded: false })
    } else if (method === 'Page.loadEventFired') {
      const frameId = readString(params, 'frameId')
      const navigation = this.#navigations.findLast((candidate) => candidate.targetId === targetId && candidate.frameId === frameId)
      if (navigation !== undefined) navigation.loaded = true
    } else {
      return
    }
    this.#wake?.()
  }
}

function centre(result: unknown, description: string): { x: number; y: number } {
  const quads = isRecord(result) ? result['quads'] : undefined
  const quad: unknown = Array.isArray(quads) ? quads[0] : undefined
  if (!Array.isArray(quad) || quad.length !== 8 || !quad.every((value) => typeof value === 'number')) {
    throw new Error(`${description} has no box on screen`)
  }
  const numbers = quad.filter((value): value is number => typeof value === 'number')
  const xs = numbers.filter((_, index) => index % 2 === 0)
  const ys = numbers.filter((_, index) => index % 2 === 1)
  // Input.dispatchMouseEvent takes whole CSS pixels.
  return { x: Math.round(xs.reduce((sum, x) => sum + x, 0) / 4), y: Math.round(ys.reduce((sum, y) => sum + y, 0) / 4) }
}

function readValue(result: unknown): unknown {
  const remote = readRemoteObject(result)
  if (isRecord(result) && result['wasThrown'] === true) throw new Error(`The page threw: ${remote.description ?? 'no description'}`)
  return remote.value
}

function readRemoteObject(result: unknown): { value: unknown; objectId: string | undefined; description: string | undefined } {
  const remote = isRecord(result) ? result['result'] : undefined
  if (!isRecord(remote)) throw new Error('The browser returned no remote object')
  return { value: remote['value'], objectId: readOptionalString(remote, 'objectId'), description: readOptionalString(remote, 'description') }
}

function readNodeIds(result: unknown): number[] {
  const nodeIds = isRecord(result) ? result['nodeIds'] : undefined
  if (!Array.isArray(nodeIds)) throw new Error('DOM.querySelectorAll returned no node ids')
  return nodeIds.filter((nodeId): nodeId is number => typeof nodeId === 'number')
}

function readString(value: unknown, key: string): string {
  const field = isRecord(value) ? value[key] : undefined
  if (typeof field !== 'string') throw new Error(`The browser sent no ${key}`)
  return field
}

function readOptionalString(value: unknown, key: string): string | undefined {
  const field = isRecord(value) ? value[key] : undefined
  return typeof field === 'string' ? field : undefined
}

function readNumber(value: unknown, key: string): number {
  const field = isRecord(value) ? value[key] : undefined
  if (typeof field !== 'number') throw new Error(`The browser sent no ${key}`)
  return field
}

function commandTimeout(deadline: Deadline): number {
  return Math.max(1, deadline.remainingMs)
}

async function withDeadline<T>(promise: Promise<T>, deadline: Deadline, waitingFor: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Waited ${deadline.budgetMs} ms for ${waitingFor}`)), Math.max(1, deadline.remainingMs))
  })
  try {
    return await Promise.race([promise, expired])
  } finally {
    clearTimeout(timer)
  }
}
